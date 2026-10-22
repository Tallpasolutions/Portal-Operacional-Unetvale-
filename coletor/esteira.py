#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Coletor do módulo Esteira de Agendamento — roda DENTRO da rede Unetvale.

Porta do Esteira-OS do Renan (`roteirizador/scraper.py` + `supabase_sync.py`),
que rodava no PC dele e gravava num Supabase próprio. Aqui ele grava no banco
do portal, pelas funções da migration 0020, e roda pelo LaunchAgent
`net.unetvale.esteira` de 10 em 10 min.

Uma rodada:

  1. LISTA   POST /operacional/os/query (OS_TIPO=ESTEIRA_AGENDAMENTO)
             -> `esteira_aplicar_coleta`: entrou/saiu, fila e foto do dia,
                numa transação só;
  2. FICHAS  GET /os/{n} de cada OS da fila, em paralelo: agendamento,
             reincidência ("fechada sem sucesso" e contatos) e — só para quem
             ainda não tem — endereço;
  3. GEO     Nominatim para quem tem endereço e não tem coordenada;
             -> `esteira_aplicar_status`;
  4. BACKLOG indicadores2 + agendamento1, no máximo 1x/hora
             -> `esteira_aplicar_backlog`.

A lista é o que importa: se as fichas não terminarem no prazo, o que foi lido
é gravado e o resto fica para a próxima rodada.

Uso:
  python esteira.py                     # rodada normal (respeita o horário)
  python esteira.py --arquivo saida.json # coleta e grava em ARQUIVO, nada no banco
  python esteira.py --forcar            # aceita fila que encolheu mais da metade
  python esteira.py --backlog           # força o backlog oficial nesta rodada
  python esteira.py --agora             # ignora a janela de horário
"""
import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

DIR = Path(__file__).resolve().parent
load_dotenv(DIR / ".env")
sys.path.insert(0, str(DIR))

import gerencial as g  # noqa: E402  (parser da lista: um só, ver parse_esteira_linhas)
import w8_client  # noqa: E402

BR_TZ = timezone(timedelta(hours=-3))
OS_TIPO = g.OS_TIPO_ESTEIRA

# Janela de coleta. O dia operacional fecha às 21h; a última rodada das 22h
# ainda pega o que saiu no fim do expediente. Fora dela a fila quase não se
# mexe (medido no histórico do Esteira-OS: 3,6% das entradas entre 22h e 6h,
# e a maior parte disso é o PC dele ligando de manhã).
HORA_INI = int(os.environ.get("ESTEIRA_HORA_INI", "6"))
HORA_FIM = int(os.environ.get("ESTEIRA_HORA_FIM", "22"))

# ~0,9 s por ficha. Com a fila de 1.096 OS (22/10/2026) e 6 em paralelo, são
# ~3 min. O Esteira-OS usava 8; aqui o WVSA também atende a rodada do
# watcher, o enviar_os e as pessoas.
FICHAS_WORKERS = int(os.environ.get("ESTEIRA_FICHAS_WORKERS", "6"))

# Prazo da rodada inteira, por RELÓGIO DE PAREDE (§6: um `sleep` dorme junto
# com o Mac). O LaunchAgent dispara de 10 em 10 min e não sobrepõe rodadas;
# passar disso só atrasaria a próxima lista, que é o que mede entrou/saiu.
PRAZO_SEGUNDOS = int(os.environ.get("ESTEIRA_PRAZO_SEGUNDOS", "480"))

BACKLOG_INTERVALO = timedelta(hours=1)
GEO_MAX_POR_RODADA = int(os.environ.get("ESTEIRA_GEO_MAX", "40"))

_NOMINATIM = "https://nominatim.openstreetmap.org/search"
# A política do Nominatim exige identificação. Sem ela, o bloqueio vem como
# 403 e todo endereço sai "sem coordenada".
_GEO_HEADERS = {"User-Agent": "Portal-Operacional-Unetvale/1.0 (coletor esteira; unetvale.tallpa.com.br)"}


def log(msg):
    print(f"[{datetime.now(BR_TZ):%d/%m %H:%M:%S}] {msg}", flush=True)


def _agora():
    return datetime.now(timezone.utc)


# ==========================================================================
# Supabase (PostgREST)
# ==========================================================================
def _supa():
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return url, {"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"}


def rpc(funcao, args, timeout=120):
    url, h = _supa()
    r = requests.post(f"{url}/rest/v1/rpc/{funcao}", headers=h, json=args, timeout=timeout)
    if r.status_code >= 400:
        # O `message` do `raise exception` é a frase útil ("encolhimento: 300
        # OS na coleta contra 1100 ativas…"); `raise_for_status` a descarta.
        try:
            corpo = r.json()
        except ValueError:
            corpo = {}
        raise RuntimeError(f"{funcao}: {corpo.get('message') or r.text[:300]}")
    return r.json() if r.text else None


def marcar_coleta(**campos):
    """PATCH na linha única de `esteira_coleta`. Best-effort: o estado da
    coleta é o que o /monitoramento lê, mas não vale derrubar a rodada."""
    url, h = _supa()
    try:
        requests.patch(f"{url}/rest/v1/esteira_coleta", params={"id": "eq.1"},
                       headers={**h, "Prefer": "return=minimal"}, json=campos, timeout=30)
    except requests.RequestException as e:
        log(f"  !! não consegui gravar o estado da coleta: {e}")


def ler_coleta():
    url, h = _supa()
    r = requests.get(f"{url}/rest/v1/esteira_coleta", params={"id": "eq.1", "select": "*"},
                     headers=h, timeout=30)
    r.raise_for_status()
    linhas = r.json()
    return linhas[0] if linhas else {}


def ler_ativas():
    """{os: {endereco, lat, cidade, bairro}} das OS ativas, paginado.

    A fila passa de 1.000 OS, e o PostgREST corta em 1.000 em silêncio (§6).
    """
    url, h = _supa()
    out, inicio, passo = {}, 0, 1000
    while True:
        r = requests.get(f"{url}/rest/v1/esteira_os",
                         params={"select": "os,endereco,lat,cidade,bairro", "ativa": "eq.true",
                                 "order": "os.asc"},
                         headers={**h, "Range": f"{inicio}-{inicio + passo - 1}"}, timeout=60)
        r.raise_for_status()
        lote = r.json()
        for l in lote:
            out[l["os"]] = l
        if len(lote) < passo:
            return out
        inicio += passo


# ==========================================================================
# Lista
# ==========================================================================
def _hrs_das_tags(texto):
    # Tags tipo "3 5398h interno interna chuva" — o MAIOR número seguido de
    # "h" é o tempo parado na fila.
    nums = re.findall(r"(\d+)\s*h\b", texto or "")
    return max(int(n) for n in nums) if nums else None


def _tags(td):
    """Fileira de badges da coluna Tags, como no WVSA: [{i, c, t, n}]
    (ícone Font Awesome, cor, título, número quando não há ícone)."""
    out = []
    if td is None:
        return out
    for span in td.find_all("span", class_="label"):
        cls = span.get("class", [])
        cor = "nfeito" if "nfeito" in cls else next(
            (c[6:] for c in cls if c.startswith("label-")), "default")
        icone = ""
        i_el = span.find("i")
        if i_el:
            icone = next((c[3:] for c in i_el.get("class", []) if c.startswith("fa-")), "")
        out.append({"i": icone, "c": cor, "t": span.get("title", ""),
                    "n": "" if icone else span.get_text(" ", strip=True)})
    return out


def _entrou_fila(ddmm, hrs, agora=None):
    """'DD/MM HH:MM' (a tela não mostra o ano) -> ISO com fuso.

    O ano sai do tempo parado: escolhe-se o ano que deixa a data mais perto
    de `agora - hrs`. Sem isso, uma OS de 15/11 lida em janeiro nasceria no
    novembro seguinte.
    """
    m = re.match(r"\s*(\d{2})/(\d{2})\s+(\d{2}):(\d{2})", ddmm or "")
    if not m:
        return None
    d, mo, hh, mi = map(int, m.groups())
    agora = agora or datetime.now(BR_TZ)
    alvo = agora - timedelta(hours=hrs or 0)
    melhor = None
    for y in (alvo.year - 1, alvo.year, alvo.year + 1):
        try:
            cand = datetime(y, mo, d, hh, mi, tzinfo=BR_TZ)
        except ValueError:
            continue
        dif = abs((alvo - cand).total_seconds())
        if melhor is None or dif < melhor[0]:
            melhor = (dif, cand)
    return melhor[1].isoformat() if melhor else None


def coletar_lista(sessao):
    csrf, _ = g._csrf(sessao, "/operacional/os")
    r = sessao.post(sessao.base + "/operacional/os/query", json={"OS_TIPO": OS_TIPO},
                    headers=g._cabecalhos(csrf, sessao.base + "/operacional/os"), timeout=300)
    r.raise_for_status()
    linhas, _ = g.parse_esteira_linhas(g._html_de_envelope(r.text))
    oss = []
    for l in linhas:
        if l["os"] is None:
            continue
        tags_td = l.pop("tags_td")
        hrs = _hrs_das_tags(tags_td.get_text(" ", strip=True) if tags_td is not None else "")
        oss.append({
            "os": l["os"], "aberto_por": l["aberto_por"], "cliente": l["cliente"],
            "solicitacao": l["solicitacao"], "finalidade": l["finalidade"],
            "cidade": l["cidade"], "bairro": l["bairro"], "tipo_pessoa": l["tipo_pessoa"],
            "categorias": l["categorias"], "hrs_parada": hrs,
            "entrou_fila": _entrou_fila(l["entrou_fila_txt"], hrs),
            "tags": _tags(tags_td),
        })
    return oss


# ==========================================================================
# Ficha da OS (/os/{n})
# ==========================================================================
_DATA = re.compile(r"(\d{2})/(\d{2})/(\d{4})(?:\s+(\d{2}):(\d{2}))?")
_ADDR_SKIP = {"alternativo", "endereço", "endereco", "categorias", "bairro", "cidade",
              "status", "produto", "finalidade", "solicitante"}
_ADDR_PALAVRAS = re.compile(
    r"(RUA|AV\.|AVENIDA|ESTRADA|ALAMEDA|TRAVESSA|ROD\.|RODOVIA|LINHA|SERVIDÃO|SERVIDAO|"
    r"LOTE|SÍTIO|SITIO|QUADRA|\bQD\b|\bLT\b)", re.I)
# A ficha tem outros blocos com rótulo "Endereço" (OS relacionada, agenda):
# "RUA TIJUCAS - 596608 - Previsão: 18:00 (Alysson…)". Raro — 1 em 10.378 no
# backup do Esteira-OS —, mas vira endereço errado e consulta ao Nominatim.
_ADDR_OUTRO_BLOCO = re.compile(r"Previs[ãa]o|\s-\s\d{6}\s-\s", re.I)


def _data_iso(txt):
    """'DD/MM/AAAA[ HH:MM]' -> (date ISO, timestamptz ISO com fuso BR)."""
    m = _DATA.search(txt or "")
    if not m:
        return None, None
    d, mo, y, hh, mi = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(hh or 0), int(mi or 0), tzinfo=BR_TZ)
    except ValueError:
        return None, None
    return dt.date().isoformat(), dt.isoformat()


def _agendamento(valor):
    """Linha "Agendamento" da ficha -> (status, data ISO)."""
    v = (valor or "").strip()
    baixo = v.lower()
    if not v or "foi agendada" in baixo:          # "OS não foi agendada!"
        return "nao_agendada", None
    data, _ = _data_iso(v)
    if re.search(r"n[ãa]o\s+confirmad", v, re.I):
        return "agendada_nao_confirmada", data
    if re.search(r"confirmad", v, re.I):
        return "agendada_confirmada", data
    return "agendada_nao_confirmada", data


def _dividir_sem_sucesso(texto):
    """'OS fechada sem sucesso pelo técnico UNETVALE - Fulano. Motivo: X.
    Observações: Y.' -> (técnico, motivo, observações)."""
    tecnico = motivo = obs = ""
    if texto and " - " in texto:
        seg = texto.split(" - ", 1)[1]
        tecnico = seg.split(". ", 1)[0].split(".", 1)[0].strip()[:80]
    if texto and "Motivo:" in texto:
        resto = texto.split("Motivo:", 1)[1]
        if "Observa" in resto:
            motivo, obs = resto.split("Observa", 1)
            obs = obs.split(":", 1)[-1].strip().rstrip(".").strip()
        else:
            motivo = resto
        motivo = motivo.strip().rstrip(".").strip()
    return tecnico, motivo[:200], obs[:300]


def parse_ficha(html, com_endereco=False):
    soup = BeautifulSoup(html, "lxml")
    out = {}

    status, data = "nao_agendada", None
    for tr in soup.find_all("tr"):
        cel = tr.find_all(["td", "th"])
        if len(cel) >= 2 and cel[0].get_text(strip=True) == "Agendamento":
            status, data = _agendamento(cel[1].get_text(" ", strip=True))
            break
    out["agendamento"], out["agendado_para"] = status, data

    # Reincidência, pela aba "todos" do histórico.
    visitas = contatos = 0
    aba = soup.find("div", id="tab-all")
    if aba is not None:
        for li in aba.select("ul.timeline li"):
            t = li.get_text(" ", strip=True).lower()
            if "fechada sem sucesso pelo t" in t:
                visitas += 1
            elif "tentativa de contato" in t or "sem contato" in t:
                contatos += 1
    out["visitas"], out["contatos"] = visitas, contatos

    linhas = [l.strip() for l in soup.get_text(separator="\n").split("\n") if l.strip()]

    # Última "fechada sem sucesso": o histórico vem do mais recente para o
    # mais antigo, então a primeira ocorrência é a última tentativa.
    for i, l in enumerate(linhas):
        if re.search(r"fechada sem sucesso", l, re.I):
            quando = None
            for j in range(i + 1, min(i + 4, len(linhas))):
                if _DATA.match(linhas[j]):
                    _, quando = _data_iso(linhas[j][:16])
                    break
            if quando:
                texto = re.sub(r"\s+", " ", l).strip()[:280]
                tec, mot, obs = _dividir_sem_sucesso(texto)
                out["sem_sucesso"] = {"data_evento": quando, "texto": texto,
                                      "tecnico": tec, "motivo": mot, "observacoes": obs}
            break

    if com_endereco:
        out.update(_endereco(linhas))
    return out


def _endereco(linhas):
    end = cidade = bairro = None
    for i, l in enumerate(linhas):
        bruto = None
        if re.match(r"^Endere[çc]o$", l, re.I) and i + 1 < len(linhas):
            bruto = linhas[i + 1]
        else:
            m = re.match(r"^Endere[çc]o\s+(.+)", l, re.I)
            if m:
                bruto = m.group(1)
        if bruto:
            limpo = re.sub(r"\s*Detalhar.*$", "", bruto, flags=re.I).strip()
            if (limpo and limpo.lower() not in _ADDR_SKIP and not _ADDR_OUTRO_BLOCO.search(limpo)
                    and (_ADDR_PALAVRAS.search(limpo) or re.search(r"\d", limpo))):
                end = limpo
        if re.match(r"^Cidade$", l, re.I) and i + 1 < len(linhas):
            cidade = linhas[i + 1]
        if re.match(r"^Bairro$", l, re.I) and i + 1 < len(linhas):
            bairro = linhas[i + 1]
    if not end:
        m = re.search(r"(RUA|AV\.|AVENIDA|ESTRADA|ALAMEDA|TRAVESSA|ROD\.)[^\n,]{3,60}",
                      "\n".join(linhas), re.I)
        if m:
            end = re.sub(r"\s+", " ", m.group(0)).strip()
    out = {}
    if end:
        out["endereco"] = end
    # A linha seguinte ao rótulo às vezes é OUTRO rótulo: no backup do
    # Esteira-OS, 2 OS da fila de 22/10/2026 tinham bairro "Endereço".
    if cidade and cidade.lower() not in _ADDR_SKIP:
        out["cidade"] = cidade
    if bairro and bairro.lower() not in _ADDR_SKIP:
        out["bairro"] = bairro
    return out


def ler_fichas(sessao, alvos, prazo):
    """alvos: {os: precisa_endereco}. Devolve {os: dados}. Para no prazo."""
    def uma(os_num, com_end):
        r = sessao.get(f"{sessao.base}/os/{os_num}", timeout=30)
        r.raise_for_status()
        return parse_ficha(r.text, com_endereco=com_end)

    lidas, falhas = {}, 0
    with ThreadPoolExecutor(max_workers=FICHAS_WORKERS) as ex:
        futuros = {ex.submit(uma, n, e): n for n, e in alvos.items()}
        for f in as_completed(futuros):
            n = futuros[f]
            try:
                lidas[n] = f.result()
            except Exception:
                falhas += 1
            if time.monotonic() > prazo:
                # Os já enviados terminam; o resto fica para a próxima rodada.
                for outro in futuros:
                    outro.cancel()
                log(f"  fichas: prazo da rodada — {len(lidas)} de {len(alvos)} lidas")
                break
    if falhas:
        log(f"  fichas: {falhas} falharam (ficam para a próxima rodada)")
    return lidas


# ==========================================================================
# Geocodificação (Nominatim)
# ==========================================================================
_RUIDO = re.compile(
    r"\b(CASA|APARTAMENTO|APTO?|APT|POUSADA|SOBRADO|FUNDOS|FRENTE|BLOCO|BL|LOJA|"
    r"SALA|GALPAO|GALPÃO|CHACARA|CHÁCARA|SITIO|SÍTIO|KITNET|EDIFICIO|EDIFÍCIO|"
    r"CONDOMINIO|CONDOMÍNIO|RESIDENCIAL|ANDAR|TERREO|TÉRREO)\b.*$", re.I)


def _rua_numero(endereco):
    """'RUA JOEL GONCALVES, 99, CASA' -> ('RUA JOEL GONCALVES', '99')."""
    partes = [p.strip() for p in (endereco or "").split(",") if p.strip()]
    if not partes:
        return None, None
    rua = _RUIDO.sub("", partes[0]).strip() or None
    num = next((m.group(1) for p in partes[1:] for m in [re.match(r"^(\d+)\b", p)] if m), None)
    return rua, num


def geocodificar(endereco, cidade, bairro=None, estado="SC"):
    """(lat, lng, precisão) com precisão 'street' | 'bairro' | 'city', ou None.

    Tenta a rua primeiro e só então recua para o bairro e o centro da cidade
    — a mesma escada do Esteira-OS, que gerou as 10.383 posições importadas.
    """
    if not cidade:
        return None
    rua, num = _rua_numero(endereco)
    tentativas = []
    if rua:
        tentativas.append(({"street": f"{num} {rua}" if num else rua, "city": cidade,
                            "state": estado, "country": "Brasil"}, "street"))
        b = f", {bairro}" if bairro else ""
        tentativas.append(({"q": f"{rua}{(', ' + num) if num else ''}{b}, {cidade}, {estado}, Brasil"},
                           "street"))
    if bairro:
        tentativas.append(({"q": f"{bairro}, {cidade}, {estado}, Brasil"}, "bairro"))
    tentativas.append(({"q": f"{cidade}, {estado}, Brasil"}, "city"))
    for params, precisao in tentativas:
        try:
            r = requests.get(_NOMINATIM, params={**params, "format": "json", "limit": 1,
                                                 "countrycodes": "br"},
                             headers=_GEO_HEADERS, timeout=15)
            res = r.json() if r.status_code == 200 else []
        except (requests.RequestException, ValueError):
            res = []
        time.sleep(1.1)  # política do Nominatim: no máximo 1 requisição por segundo
        if res:
            return float(res[0]["lat"]), float(res[0]["lon"]), precisao
    return None


# ==========================================================================
# Backlog oficial
# ==========================================================================
# Grupos do indicadores2. Janelas maiores que ~180 dias dão HTTP 500 nos
# grupos pesados (MANF): por isso a janela encolhe até responder.
BACKLOG_GRUPOS = [
    ("Retiradas Fibra", "RETF"),
    ("Roteador/Cabeamento", "ROT-ROTS-ROT2-CAB"),
    ("Instalações/Mud./Migr.", "INS2-INS3-MIGF-MUDF"),
    ("Suportes de Fibra", "MANF"),
]


def _soma_meses(serie, ano_inicio):
    """Soma por mês reconstruindo o ano (a série diz só 'DD/MM')."""
    out, antes, ano = {}, None, ano_inicio
    for pt in serie or []:
        try:
            mm = int(str(pt["name"]).split("/")[1])
        except (KeyError, IndexError, ValueError):
            continue
        if antes is not None and mm < antes:
            ano += 1
        antes = mm
        ym = f"{ano}-{mm:02d}"
        out[ym] = out.get(ym, 0) + (pt.get("y") or 0)
    return out


def coletar_backlog(sessao):
    csrf, _ = g._csrf(sessao, "/relatorios/indicadores2")
    hoje = datetime.now(BR_TZ)
    fim = hoje.strftime("%d/%m/%Y")
    corrente = hoje.strftime("%Y-%m")
    h = g._cabecalhos(csrf, sessao.base + "/relatorios/indicadores2")
    linhas = []
    for nome, codigo in BACKLOG_GRUPOS:
        meses = {}
        for dias in (180, 120, 90):
            ini = hoje - timedelta(days=dias)
            try:
                r = sessao.post(sessao.base + "/relatorios/indicadores2/backlog-os",
                                data={"inicio": ini.strftime("%d/%m/%Y"), "fim": fim,
                                      "ignorarDomingos": 0, "finalidades": codigo, "visao": 1},
                                headers=h, timeout=90)
                if r.status_code != 200 or not r.text.strip():
                    continue
                series = {x.get("name"): x.get("data", []) for x in r.json().get("series", [])}
            except (requests.RequestException, ValueError):
                continue
            ent = _soma_meses(series.get("OS's Abertas"), ini.year)
            sai = _soma_meses(series.get("OS's Fechadas"), ini.year)
            # O primeiro mês da janela vem pela metade: fica de fora.
            primeiro = ini.strftime("%Y-%m")
            meses = {ym: (ent.get(ym, 0), sai.get(ym, 0)) for ym in set(ent) | set(sai)
                     if primeiro < ym <= corrente}
            break
        if not meses:
            log(f"  backlog: grupo {nome} não respondeu")
        linhas += [{"mes": f"{ym}-01", "grupo": nome, "entradas": e, "saidas": s}
                   for ym, (e, s) in meses.items()]

    # Total da esteira (agendamento1).
    csrf1, _ = g._csrf(sessao, "/relatorios/agendamento1")
    r = sessao.post(sessao.base + "/relatorios/agendamento1/grafico-backlog",
                    data={"inicio": (hoje - timedelta(days=400)).strftime("%d/%m/%Y"),
                          "fim": fim, "agrupamento": "m"},
                    headers=g._cabecalhos(csrf1, sessao.base + "/relatorios/agendamento1"),
                    timeout=90)
    r.raise_for_status()
    d = r.json()
    ent = sai = []
    for x in d.get("series", []):
        nome = (x.get("name") or "").lower()
        if nome.startswith("entrada"):
            ent = x.get("data", [])
        elif nome.startswith("sa") and not nome.startswith("saldo"):
            sai = x.get("data", [])
    for i, cat in enumerate(d.get("xAxis", {}).get("categories", [])):
        mm, yy = cat.split("/")
        ym = f"20{yy}-{int(mm):02d}"
        if ym <= corrente:
            linhas.append({"mes": f"{ym}-01", "grupo": "TOTAL",
                           "entradas": ent[i] if i < len(ent) else 0,
                           "saidas": sai[i] if i < len(sai) else 0})
    return linhas


# ==========================================================================
# Rodada
# ==========================================================================
def _wvsa_alcancavel():
    base = os.environ.get("W8_BASE", "https://wvsa8.unetvale.com.br").rstrip("/")
    try:
        return requests.get(base + "/login", timeout=8).status_code < 500
    except requests.RequestException:
        return False


def _cafeinar():
    """Re-executa sob `caffeinate -ims`: o launchd dispara num dark wake e o
    Mac volta a dormir 2 s depois (§6, a Celesc morreu assim). Não vence
    tampa fechada na bateria."""
    if os.environ.get("ESTEIRA_CAFEINADO") or not Path("/usr/bin/caffeinate").exists():
        return
    os.environ["ESTEIRA_CAFEINADO"] = "1"
    os.execv("/usr/bin/caffeinate", ["caffeinate", "-ims", sys.executable, *sys.argv])


def rodada(args):
    inicio = time.monotonic()
    prazo = inicio + PRAZO_SEGUNDOS
    em = _agora()
    arquivo = args.arquivo
    if not arquivo:
        marcar_coleta(iniciado_em=em.isoformat())

    sessao = w8_client.login()
    log(f"sessão: {sessao.usuario}")

    # 1. Lista
    oss = coletar_lista(sessao)
    log(f"lista: {len(oss)} OS na esteira")
    saida = {"em": em.isoformat(), "lista": oss}
    if arquivo:
        conhecidas = {}
    else:
        r = rpc("esteira_aplicar_coleta", {"p_oss": oss, "p_em": em.isoformat(),
                                           "p_forcar": bool(args.forcar)})
        log(f"  -> +{r['entraram']} entraram, -{r['sairam']} saíram"
            + (" (APÓS LACUNA)" if r.get("apos_lacuna") else "")
            + (" (linha de base)" if r.get("linha_de_base") else ""))
        conhecidas = ler_ativas()

    # 2. Fichas — endereço só para quem ainda não tem
    alvos = {o["os"]: not (conhecidas.get(o["os"]) or {}).get("endereco") for o in oss}
    t0 = time.monotonic()
    fichas = ler_fichas(sessao, alvos, prazo)
    log(f"fichas: {len(fichas)} lidas em {time.monotonic() - t0:.0f}s "
        f"({sum(alvos.values())} pediam endereço)")

    # 3. Geocodificação — só quem tem endereço e não tem coordenada
    por_os = {o["os"]: o for o in oss}
    geo = 0
    for n, f in fichas.items():
        if geo >= GEO_MAX_POR_RODADA or time.monotonic() > prazo:
            break
        k = conhecidas.get(n) or {}
        if k.get("lat") is not None:
            continue
        endereco = f.get("endereco") or k.get("endereco")
        cidade = k.get("cidade") or por_os[n]["cidade"] or f.get("cidade")
        bairro = k.get("bairro") or por_os[n]["bairro"] or f.get("bairro")
        if not endereco and not cidade:
            continue
        pos = geocodificar(endereco, cidade, bairro)
        geo += 1
        if pos:
            f["lat"], f["lng"], f["geo_precisao"] = pos
    if geo:
        log(f"geo: {geo} endereços consultados no Nominatim")

    status = [{"os": n, **f} for n, f in fichas.items()]
    saida["fichas"] = status
    if not arquivo and status:
        for i in range(0, len(status), 300):
            rpc("esteira_aplicar_status", {"p_status": status[i:i + 300], "p_em": _agora().isoformat()})
        log(f"  -> status gravado ({len(status)} fichas)")

    # 4. Backlog oficial, no máximo 1x/hora
    precisa = args.backlog
    if not precisa and not arquivo:
        ultimo = ler_coleta().get("backlog_em")
        precisa = not ultimo or em - datetime.fromisoformat(ultimo) > BACKLOG_INTERVALO
    if precisa and time.monotonic() < prazo:
        try:
            bk = coletar_backlog(sessao)
            saida["backlog"] = bk
            if not arquivo and bk:
                rpc("esteira_aplicar_backlog", {"p_linhas": bk, "p_em": em.isoformat()})
            log(f"backlog oficial: {len(bk)} linhas")
        except Exception as e:  # noqa: BLE001 — backlog é acessório; a lista já foi gravada
            log(f"  !! backlog oficial falhou: {e}")

    if arquivo:
        Path(arquivo).write_text(json.dumps(saida, ensure_ascii=False, indent=1), encoding="utf-8")
        log(f"gravado em {arquivo} (nada foi para o banco)")
    log(f"rodada concluída em {time.monotonic() - inicio:.0f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arquivo", help="grava a coleta neste JSON em vez do banco")
    ap.add_argument("--forcar", action="store_true",
                    help="aceita uma fila que encolheu mais da metade (queda real)")
    ap.add_argument("--backlog", action="store_true", help="força o backlog oficial")
    ap.add_argument("--agora", action="store_true", help="ignora a janela de horário")
    args = ap.parse_args()

    hora = datetime.now(BR_TZ).hour
    if not args.agora and not args.arquivo and not (HORA_INI <= hora < HORA_FIM):
        return 0   # fora da janela: sai calado, nem log

    _cafeinar()

    if not _wvsa_alcancavel():
        log("WVSA inalcançável (sem VPN nem rede Unetvale) — rodada ignorada")
        if not args.arquivo:
            marcar_coleta(erro_em=_agora().isoformat(), erro="WVSA inalcançável (sem VPN/rede Unetvale)")
        return 0

    try:
        rodada(args)
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"FALHA: {e}")
        if not args.arquivo:
            marcar_coleta(erro_em=_agora().isoformat(), erro=str(e)[:500])
        return 1


if __name__ == "__main__":
    sys.exit(main())
