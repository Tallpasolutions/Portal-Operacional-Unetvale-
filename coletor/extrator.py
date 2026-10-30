#!/usr/bin/env python3
"""
Extrator de Produtividade Operacional - WVSA 8 (unetvale)
---------------------------------------------------------
Faz login no sistema (Laravel), busca o relatório "Lista de OS's por técnico"
mês a mês (contornando o limite de ~1 mês por consulta) e grava as OS em SQLite.

Uso:
    python extrator.py                 # atualização incremental (do início do histórico até hoje)
    python extrator.py --full          # recria o banco do zero
    python extrator.py --inicio 01/05/2026 --fim 31/05/2026   # intervalo específico
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from datetime import date, datetime, timedelta

import requests
from bs4 import BeautifulSoup

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
DB_PATH = os.path.join(BASE_DIR, "dados.db")
RAW_DIR = os.path.join(BASE_DIR, "raw")

# Colunas da tabela de OS: texto do <th> (normalizado por `_chave_th`) -> campo.
#
# A tabela se lê pelo CABEÇALHO, nunca por posição. Até 30/10/2026 o extrator
# lia por índice, e o WVSA passou a mandar "Pagamento Manual" entre "Validada"
# e "OS": em set e out/2026, `os` recebeu o "Sim"/"Não" do pagamento manual e
# `valor` o número da OS (soma de R$ 3,4 bi num mês de ~R$ 500 mil), sem erro
# nenhum. E o WVSA devolve a coluna nova também para datas antigas — um
# `--full` com o extrator velho entortaria o histórico inteiro.
#
# No template do WVSA, "Finalidade" e "Pagamento Manual" vêm de blocos
# condicionais (a indentação do HTML denuncia): a lista de colunas pode mudar
# de novo sem aviso.
COLUNAS_TH = {
    "data": "data",
    "finalidade": "finalidade",
    "condominio": "condominio",
    "sucesso": "sucesso",
    "massiva": "massiva",
    "tipo de atendimento": "tipo_atendimento",
    "trocado drop": "trocado_drop",
    "sub/aereo": "sub_aereo",
    "agregada": "agregada",
    "rejeitada": "rejeitada",
    "tecnicos": "qtd_tecnicos",
    "validada": "validada",
    "pagamento manual": "pagamento_manual",
    "os": "os",
    "valor": "valor",
}

# Sem estas, gravar é pior que falhar. Data/Finalidade/Sucesso/Rejeitada/Tipo
# de atendimento são o que o payload da Produtividade leva para a tela
# (`enviar.coletar_produtividade`); OS e Valor são o que se cruza depois no
# `dados.db` — e foram exatamente os dois que o deslocamento estragou calado.
# As demais faltando viram NULL e um aviso no log.
COLUNAS_OBRIGATORIAS = ("data", "finalidade", "sucesso", "rejeitada",
                        "tipo_atendimento", "os", "valor")


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


# ----------------------------------------------------------------------------
# Login / sessão
# ----------------------------------------------------------------------------
def fazer_login(cfg):
    s = requests.Session()
    s.headers.update({"User-Agent": "Mozilla/5.0 (Macintosh) ProdutividadeBot/1.0"})
    base = cfg["base_url"].rstrip("/")

    # 1) GET /login -> pega _token
    r = s.get(f"{base}/login", timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    token_el = soup.find("input", attrs={"name": "_token"})
    if not token_el:
        raise RuntimeError("Não encontrei o campo _token na página de login.")
    token = token_el.get("value")

    # 2) POST /login
    r = s.post(
        f"{base}/login",
        data={"_token": token, "username": cfg["username"], "password": cfg["password"]},
        allow_redirects=True,
        timeout=30,
    )
    r.raise_for_status()
    if "/login" in r.url:
        raise RuntimeError("Falha no login — verifique usuário/senha em config.json.")
    log(f"Login OK (redirecionado para {r.url})")
    return s, base


def get_csrf_meta(s, base):
    """Pega o token CSRF (meta) da página do relatório para usar no header AJAX."""
    r = s.get(f"{base}/relatorios/operacional8", timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    meta = soup.find("meta", attrs={"name": "csrf-token"})
    return meta.get("content") if meta else None


# ----------------------------------------------------------------------------
# Busca de dados (POST /dados, um intervalo por vez)
# ----------------------------------------------------------------------------
def buscar_intervalo(s, base, csrf, data_inicio, data_fim):
    """data_inicio/data_fim no formato DD/MM/AAAA. Retorna o HTML cru.

    🚨 `empresa="todas"` NÃO é opcional. Não mexa.

    O formulário do relatório tem um campo `empresa` (todas | unetvale | id).
    Enquanto ele não era enviado, o WVSA aplicava o padrão dele — e esse padrão
    passou a ser "só Unetvale" por volta de 01/07/2026. O coletor continuou
    reportando sucesso e apagando-e-regravando o mês corrente com o resultado
    reduzido; foram dois meses até alguém reparar que os terceiros sumiram.

    Medido em 28/08/2026 no relatório de 23/06/2026:

        sem o parâmetro ......  61 OS,  2 empresas
        empresa="todas" ...... 249 OS, 17 empresas  <- igual ao que já estava
                                                       gravado daquele dia

    `infra="S"` é armadilha: parece "incluir infra", mas RESTRINGE o relatório
    às equipes de infra (5 empresas em vez de 17). `empresa="todas"` sozinho já
    traz as de infra junto. Não envie.
    """
    headers = {
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-TOKEN": csrf or "",
        "Referer": f"{base}/relatorios/operacional8",
    }
    payload = {"dataInicio": data_inicio, "dataFim": data_fim,
               "visao": "T", "empresa": "todas"}
    r = s.post(
        f"{base}/relatorios/operacional8/dados",
        data=payload,
        headers=headers,
        timeout=120,
    )
    r.raise_for_status()
    return r.text


# ----------------------------------------------------------------------------
# Parsing do HTML -> lista de OS
# ----------------------------------------------------------------------------
def _limpa(txt):
    return re.sub(r"\s+", " ", (txt or "").strip())


def extrair_html(resposta_texto):
    """O endpoint /dados responde com um envelope JSON do tipo
    {"HTML": [["#div-dados", "<html...>"], ...], ...}. Esta função devolve
    o HTML concatenado. Se a resposta já for HTML puro, devolve como está.
    """
    txt = resposta_texto.lstrip()
    if txt[:1] in "{[":
        try:
            obj = json.loads(resposta_texto)
        except json.JSONDecodeError:
            return resposta_texto
        fragmentos = []
        for item in obj.get("HTML", []):
            # item costuma ser ["#seletor", "<html>"]
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                fragmentos.append(item[1])
            elif isinstance(item, str):
                fragmentos.append(item)
        return "\n".join(fragmentos) if fragmentos else resposta_texto
    return resposta_texto


class LayoutInesperado(RuntimeError):
    pass


def _chave_th(txt):
    """'Condomínio' -> 'condominio'. Sem acento e sem caixa: um acento a menos
    no cabeçalho não pode virar "coluna obrigatória faltando"."""
    txt = unicodedata.normalize("NFKD", _limpa(txt))
    return "".join(c for c in txt if not unicodedata.combining(c)).casefold()


def mapear_colunas(tabela):
    """Devolve {posição: campo} a partir do <thead> da tabela.

    Coluna que o extrator não conhece é ignorada (devolvida à parte para o
    log); obrigatória faltando levanta `LayoutInesperado`, ANTES de qualquer
    `limpar_intervalo` — nada é apagado.
    """
    linha_th = tabela.find("thead")
    ths = linha_th.find_all("th") if linha_th else []
    if not ths:
        raise LayoutInesperado("tabela de OS sem <thead>: não há como saber qual coluna é qual")
    mapa, desconhecidas = {}, []
    for i, th in enumerate(ths):
        texto = _limpa(th.get_text(" ", strip=True))
        campo = COLUNAS_TH.get(_chave_th(texto))
        if campo:
            mapa[i] = campo
        else:
            desconhecidas.append(texto)
    faltando = [c for c in COLUNAS_OBRIGATORIAS if c not in mapa.values()]
    if faltando:
        cab = [_limpa(th.get_text(" ", strip=True)) for th in ths]
        raise LayoutInesperado(
            f"cabeçalho da tabela de OS sem {', '.join(faltando)}. Cabeçalho recebido: {cab}")
    return mapa, len(ths), desconhecidas


def parse_html(resposta_texto):
    """Retorna lista de dicts, uma OS por linha, com técnico/empresa associados."""
    html = extrair_html(resposta_texto)
    soup = BeautifulSoup(html, "lxml")
    avisos = set()

    # Mapa tecnico_id -> "EMPRESA - Nome" a partir das abas (nav-tabs)
    rotulos = {}
    for a in soup.select("a[href^='#tecnico-']"):
        tid = a.get("href", "").replace("#tecnico-", "")
        rotulos[tid] = _limpa(a.get_text(" ", strip=True))

    registros = []
    panes = soup.find_all("div", id=re.compile(r"^tecnico-\d+"))
    for pane in panes:
        tecnico_id = pane.get("id", "").replace("tecnico-", "")
        rotulo = rotulos.get(tecnico_id, "")
        if rotulo:
            empresa, tecnico = parse_label(rotulo)
        else:
            heading = pane.find(class_="panel-heading")
            empresa, tecnico = parse_label(heading.get_text(" ", strip=True) if heading else "")
        tabela = pane.find("table")
        if not tabela:
            continue
        # Cada técnico tem a própria tabela, com o próprio <thead>: o mapa é
        # por tabela, não um só para a página.
        mapa, n_colunas, desconhecidas = mapear_colunas(tabela)
        avisos.update(desconhecidas)
        tbody = tabela.find("tbody") or tabela
        for tr in tbody.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) < n_colunas:
                continue  # "nenhum registro" com colspan e afins
            reg = {campo: None for campo in COLUNAS_TH.values()}
            for i, campo in mapa.items():
                reg[campo] = _limpa(tds[i].get_text(" ", strip=True))
            reg["tecnico_id"] = tecnico_id
            reg["empresa"] = empresa
            reg["tecnico"] = tecnico
            registros.append(reg)
    if avisos:
        log(f"  colunas desconhecidas ignoradas: {', '.join(sorted(avisos))}")
    return registros


def parse_label(texto):
    """Extrai 'EMPRESA - Nome' de um texto ruidoso do panel-heading.
    Ex.: "16 OS's Gerar Planilha Relatório CLEITON TELECOM - Alex Silva Martins ..."
    """
    texto = _limpa(texto)
    # remove ruídos comuns
    for ruido in ["Gerar Planilha", "Relatório Total", "Relatório", "Total"]:
        texto = texto.replace(ruido, " ")
    texto = re.sub(r"\d+\s*OS's", " ", texto)
    texto = _limpa(texto)
    if " - " in texto:
        empresa, _, tecnico = texto.partition(" - ")
        return _limpa(empresa), _limpa(tecnico)
    return "", texto


# ----------------------------------------------------------------------------
# Persistência (SQLite)
# ----------------------------------------------------------------------------
def init_db(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS os (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            os TEXT,
            data_hora TEXT,         -- ISO datetime
            dia TEXT,               -- YYYY-MM-DD
            tecnico_id TEXT,
            empresa TEXT,
            tecnico TEXT,
            finalidade TEXT,
            condominio TEXT,
            sucesso TEXT,
            massiva TEXT,
            tipo_atendimento TEXT,
            trocado_drop TEXT,
            sub_aereo TEXT,
            agregada TEXT,
            rejeitada TEXT,
            qtd_tecnicos TEXT,
            validada TEXT,
            valor REAL
        )
        """
    )
    # Coluna nascida em 30/10/2026 (o WVSA passou a publicá-la). ALTER porque o
    # `dados.db` em produção já existe e o CREATE acima não o alcança. Fica só
    # no SQLite: o payload da Produtividade não a leva, então o app não precisa
    # mudar e não há ordem de deploy a seguir. Linhas gravadas antes ficam NULL
    # ("não coletada") até o mês ser recoletado.
    colunas = {c[1] for c in conn.execute("PRAGMA table_info(os)")}
    if "pagamento_manual" not in colunas:
        conn.execute("ALTER TABLE os ADD COLUMN pagamento_manual TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_os_dia ON os(dia)")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS meta (chave TEXT PRIMARY KEY, valor TEXT)"
    )
    conn.commit()


def limpar_intervalo(conn, ini_iso, fim_iso):
    """Remove as linhas de um intervalo (idempotência: reextrair um mês não duplica)."""
    conn.execute("DELETE FROM os WHERE dia >= ? AND dia <= ?", (ini_iso, fim_iso))
    conn.commit()


# Abaixo disto o resultado novo é considerado degradado, não uma variação real.
# Meia empresa a menos num mês fechado não acontece por acaso: ou o relatório
# mudou de escopo, ou a sessão caiu no meio. Nos dois casos é melhor parar.
LIMIAR_ENCOLHIMENTO = 0.5


class ColetaDegradada(RuntimeError):
    pass


def conferir_encolhimento(conn, ini_iso, fim_iso, regs, permitir=False):
    """Barra o apagar-e-regravar quando a coleta volta bem menor que o guardado.

    Existe por causa de um incidente real: o relatório passou a devolver só a
    Unetvale, e como cada rodada apaga o intervalo antes de gravar, o banco foi
    sendo reescrito com o resultado reduzido por dois meses — sempre reportando
    sucesso, porque "gravou" mesmo. Perder dado calado é pior do que falhar.

    Compara empresas distintas, e não linhas: contagem de OS oscila sozinha
    (dia parcial, reagendamento), mas um mês não perde metade das empresas por
    variação normal.

    Só vale quando já existe dado no intervalo — a primeira coleta de um mês
    novo compara contra zero e passa direto, que é o certo.
    """
    antes = {e for (e,) in conn.execute(
        "SELECT DISTINCT empresa FROM os WHERE dia >= ? AND dia <= ? AND empresa IS NOT NULL",
        (ini_iso, fim_iso))}
    if not antes:
        return
    depois = {r.get("empresa") for r in regs if r.get("empresa")}
    if len(depois) >= len(antes) * LIMIAR_ENCOLHIMENTO:
        return

    sumiram = sorted(antes - depois)
    aviso = (f"coleta degradada em {ini_iso}..{fim_iso}: "
             f"{len(antes)} empresas no banco, {len(depois)} na resposta. "
             f"Sumiram: {', '.join(sumiram[:8])}"
             f"{'…' if len(sumiram) > 8 else ''}")
    if permitir:
        log(f"AVISO (--aceitar-encolhimento): {aviso}")
        return
    raise ColetaDegradada(
        f"{aviso}\n"
        "Nada foi apagado. Verifique se o relatório mudou de escopo antes de insistir "
        "(o payload precisa de empresa='todas'). Para gravar assim mesmo, quando a queda "
        "for real: --aceitar-encolhimento")


def parse_data_hora(s):
    """'12/06/26 11:18' -> ('2026-06-12T11:18', '2026-06-12')"""
    s = _limpa(s)
    for fmt in ("%d/%m/%y %H:%M", "%d/%m/%Y %H:%M", "%d/%m/%y", "%d/%m/%Y"):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.isoformat(timespec="minutes"), dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return s, ""


def parse_valor(s):
    s = _limpa(s).replace("R$", "").strip()
    # formato brasileiro: 1.234,56  (mas no relatório aparece "64,457" estilo milhar?)
    s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return 0.0


def salvar(conn, registros):
    n = 0
    for r in registros:
        dh, dia = parse_data_hora(r.get("data"))
        conn.execute(
            """
            INSERT INTO os
            (os, data_hora, dia, tecnico_id, empresa, tecnico, finalidade, condominio,
             sucesso, massiva, tipo_atendimento, trocado_drop, sub_aereo, agregada,
             rejeitada, qtd_tecnicos, validada, pagamento_manual, valor)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                r.get("os"), dh, dia, r.get("tecnico_id"), r.get("empresa"), r.get("tecnico"),
                r.get("finalidade"), r.get("condominio"), r.get("sucesso"), r.get("massiva"),
                r.get("tipo_atendimento"), r.get("trocado_drop"), r.get("sub_aereo"),
                r.get("agregada"), r.get("rejeitada"), r.get("qtd_tecnicos"), r.get("validada"),
                r.get("pagamento_manual"), parse_valor(r.get("valor")),
            ),
        )
        n += 1
    conn.commit()
    return n


# ----------------------------------------------------------------------------
# Geração de meses
# ----------------------------------------------------------------------------
def meses_entre(inicio: date, fim: date):
    """Gera (primeiro_dia, ultimo_dia) de cada mês entre inicio e fim (clampado)."""
    cur = date(inicio.year, inicio.month, 1)
    while cur <= fim:
        if cur.month == 12:
            prox = date(cur.year + 1, 1, 1)
        else:
            prox = date(cur.year, cur.month + 1, 1)
        ini = max(cur, inicio)
        ult = min(prox - timedelta(days=1), fim)
        yield ini, ult
        cur = prox


def br(d: date):
    return d.strftime("%d/%m/%Y")


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="recria o banco do zero")
    ap.add_argument("--mes-atual", action="store_true",
                    help="atualiza do 1º dia do mês corrente até hoje (usado pelo agendamento)")
    ap.add_argument("--inicio", help="DD/MM/AAAA")
    ap.add_argument("--fim", help="DD/MM/AAAA")
    ap.add_argument("--salvar-raw", action="store_true", help="salva o HTML cru de cada mês em raw/")
    ap.add_argument("--aceitar-encolhimento", action="store_true",
                    help="grava mesmo se a coleta vier com muito menos empresas que o banco "
                         "(só quando a queda for real, não para contornar relatório quebrado)")
    args = ap.parse_args()

    cfg = load_config()
    hoje = date.today()

    if args.mes_atual:
        inicio = date(hoje.year, hoje.month, 1)
    elif args.inicio:
        inicio = datetime.strptime(args.inicio, "%d/%m/%Y").date()
    else:
        inicio = datetime.strptime(cfg.get("data_inicio_historico", "01/01/2026"), "%d/%m/%Y").date()
    fim = datetime.strptime(args.fim, "%d/%m/%Y").date() if args.fim else hoje

    if args.full and os.path.exists(DB_PATH):
        os.remove(DB_PATH)
        log("Banco anterior removido (--full).")

    if args.salvar_raw:
        os.makedirs(RAW_DIR, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    s, base = fazer_login(cfg)
    csrf = get_csrf_meta(s, base)
    log(f"CSRF meta: {'ok' if csrf else 'ausente'}")

    total = 0
    for ini, ult in meses_entre(inicio, fim):
        log(f"Buscando {br(ini)} a {br(ult)} ...")
        html = buscar_intervalo(s, base, csrf, br(ini), br(ult))
        if args.salvar_raw:
            with open(os.path.join(RAW_DIR, f"{ini:%Y-%m}.html"), "w", encoding="utf-8") as f:
                f.write(html)
        regs = parse_html(html)
        ini_iso, ult_iso = ini.strftime("%Y-%m-%d"), ult.strftime("%Y-%m-%d")
        conferir_encolhimento(conn, ini_iso, ult_iso, regs, permitir=args.aceitar_encolhimento)
        # idempotência: limpa o intervalo consultado antes de reinserir
        limpar_intervalo(conn, ini_iso, ult_iso)
        n = salvar(conn, regs)
        total += n
        log(f"  -> {n} OS gravadas")
        time.sleep(1)  # gentileza com o servidor

    conn.execute(
        "INSERT OR REPLACE INTO meta (chave, valor) VALUES ('ultima_atualizacao', ?)",
        (datetime.now().isoformat(timespec="seconds"),),
    )
    conn.execute(
        "INSERT OR REPLACE INTO meta (chave, valor) VALUES ('intervalo', ?)",
        (f"{br(inicio)} a {br(fim)}",),
    )
    conn.commit()

    cur = conn.execute("SELECT COUNT(*) FROM os")
    log(f"Concluído. Total de OS no banco: {cur.fetchone()[0]} (gravadas nesta execução: {total})")
    conn.close()


if __name__ == "__main__":
    try:
        main()
    except (ColetaDegradada, LayoutInesperado) as e:
        # Mensagem legível em vez de traceback: quem lê isso é o coletor.log às
        # 8 da manhã. Código 2 distingue "recusei de propósito" de erro geral.
        log(f"ABORTADO: {e}")
        sys.exit(2)
