#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Coletas do modulo Dashboard (visao gerencial) — rodam DENTRO da rede Unetvale.

Cinco relatorios do WVSA que hoje eram lidos a mao. Cada um vira um payload em
`dados_modulo`, lido depois pelo Flask na Vercel (que nunca fala com o WVSA).

    ger_categorias     causa raiz da reincidencia (Cat 1..5), separada IQI/IQM
    ger_cancelamentos  churn valido, com motivo, cidade, tempo de casa e ticket
    ger_esteira        fila de agendamento agora + historico para entrou/saiu
    ger_idf            nota dos feedbacks (ligacoes, chats, OS)   [sessao gestor]
    ger_salas          solicitacoes do Rocketchat                 [sessao gestor]

DOIS ENVELOPES DE RESPOSTA, e o WVSA usa os dois:

    {"HTML": [["#seletor", "<html>"]]}          indicadores13, operacional/os
    {"actions": [{"action": "html", "value": [...]}]}   operacional31, indicadores9

O primeiro ja tinha desempacotador (`extrator.extrair_html`); o segundo nasce
aqui em `_html_de_actions`.
"""
import json
import os
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup

from extrator import _limpa, extrair_html, meses_entre

BR_TZ = timezone(timedelta(hours=-3))

# O backfill vai de janeiro do ano corrente ate hoje (ver `meses_do_backfill`).
# O detalhe do operacional31 custa ~4,8 MB por (tipo x mes), entao e coleta de
# uma vez so, nao de rodada.


def log(msg):
    print(f"[{datetime.now(BR_TZ):%H:%M:%S}] {msg}", flush=True)


def _agora():
    """UTC com fuso explicito.

    `datetime.now()` devolve hora local ingenua, e numa coluna `timestamptz` o
    Postgres le o valor sem fuso como se ja fosse UTC — gravando 3 horas no
    passado. Mesmo `_agora()` de `acoes.py` e `reuniao_ia.py`.
    """
    return datetime.now(timezone.utc)


# ==========================================================================
# Envelopes
# ==========================================================================
def _html_de_actions(resposta_texto):
    """Desempacota `{"actions": [{"action":"html","value":[...]}]}`.

    `value` vem como [html, "#seletor"]: o ultimo item e o alvo no DOM, nao
    conteudo. Filtramos por "<" em vez de cortar pelo indice porque a lista
    tem tamanho variavel — e ja apareceu com inteiro no meio.
    """
    try:
        obj = json.loads(resposta_texto)
    except json.JSONDecodeError:
        return resposta_texto
    fragmentos = []
    for acao in obj.get("actions", []):
        valor = acao.get("value")
        if isinstance(valor, str):
            valor = [valor]
        for item in valor or []:
            if isinstance(item, str) and "<" in item:
                fragmentos.append(item)
    return "\n".join(fragmentos)


def _html_de_envelope(resposta_texto):
    """Idem para `{"HTML": [["#seletor", "<html>"]]}`.

    `extrator.extrair_html` ja faz isso, mas assume que todo item da lista e
    string — e o /operacional/os/query mistura inteiros ali dentro, o que
    quebra o join. Este passa por ele e limpa o que sobrou.
    """
    try:
        obj = json.loads(resposta_texto)
    except json.JSONDecodeError:
        return extrair_html(resposta_texto)
    fragmentos = []
    for item in obj.get("HTML", []):
        if isinstance(item, str):
            fragmentos.append(item)
        elif isinstance(item, (list, tuple)):
            fragmentos += [x for x in item if isinstance(x, str) and "<" in x]
    return "\n".join(fragmentos) if fragmentos else extrair_html(resposta_texto)


def _csrf(sessao, caminho):
    """Token CSRF da meta tag da pagina do relatorio."""
    html = sessao.get(sessao.base + caminho, timeout=120).text
    m = re.search(r'name="csrf-token"\s+content="([^"]+)"', html)
    if not m:
        m = re.search(r'content="([^"]+)"\s+name="csrf-token"', html)
    return (m.group(1) if m else ""), html


def _cabecalhos(csrf, referer):
    return {"X-CSRF-TOKEN": csrf, "X-Requested-With": "XMLHttpRequest", "Referer": referer}


# ==========================================================================
# Tabelas
# ==========================================================================
def _celulas(tr):
    return [_limpa(td.get_text(" ", strip=True)) for td in tr.find_all("td")]


def _cabecalho(tabela):
    return [_limpa(th.get_text(" ", strip=True)) for th in tabela.select("thead th")]


def _num(txt):
    """"1.234" / "12,5%" / "R$ 1.234,56" -> float. Vazio -> 0.0."""
    t = re.sub(r"[^\d,.\-]", "", txt or "")
    if not t:
        return 0.0
    # Formato brasileiro: ponto e milhar, virgula e decimal.
    t = t.replace(".", "").replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return 0.0


def _int(txt):
    return int(_num(txt))


# ==========================================================================
# 1. Categorias (AII) — operacional31
# ==========================================================================
# O WVSA tem rotulos DUPLICADOS em Cat 4: "OS de Suporte em aberto" e
# "OS de suporte em aberto" convivem como ids diferentes, e "Cancelou visita"
# aparece duas vezes. Sem juntar, a mesma causa vira duas barras e nenhuma
# delas alcanca o topo do ranking.
#
# O mapa e EXPLICITO de proposito. Um `.lower()` cego juntaria tudo que difere
# so na caixa, mas tambem esconderia que o cadastro do WVSA tem duplicata —
# que e informacao util para quem administra o sistema la.
_CAT4_SINONIMOS = {
    "os de suporte em aberto": "OS de Suporte em aberto",
    "cancelou visita": "Cancelou visita",
    "cancelada a vista": "Cancelou visita",
}

_VAZIOS = {"", "selecione uma opcao...", "selecione uma opção...", "(vazio)", "indefinido"}


def _normalizar(rotulo):
    r = _limpa(rotulo)
    chave = r.lower()
    if chave in _VAZIOS:
        return None
    return _CAT4_SINONIMOS.get(chave, r)


def _cat_do_select(td, n):
    """Cat 4, 5 e 6 vem como <select> editavel, nao como texto.

    `td.get_text()` devolveria a LISTA INTEIRA de opcoes concatenada — o valor
    escolhido e o `option[selected]`. Cat 1, 2 e 3 sao texto normal.
    """
    sel = td.find("select", attrs={"name": re.compile(rf"^cat{n}-")})
    if not sel:
        return _normalizar(td.get_text(" ", strip=True))
    op = sel.find("option", selected=True)
    return _normalizar(op.get_text(strip=True)) if op else None


def buscar_categorias(sessao, tipo, mes_iso, csrf):
    """POST /relatorios/operacional31/dados. `mes_iso` = 'AAAA-MM'.

    🚨 `ignorarMassivas="N"` NAO e opcional. Nao mexa.

    O padrao DA TELA e "S", e ele descarta as reincidencias cuja causa foi
    falha massiva — que e a SEGUNDA maior causa do periodo. Medido em
    29/08/2026, IQI de 07/2026:

        ignorarMassivas="S" (padrao) ... 156 linhas,   2 de Falha Massiva
        ignorarMassivas="N" ............ 212 linhas,  58 de Falha Massiva

    Os 56 da diferenca sao exatamente os de Falha Massiva. Com "S" o ranking de
    causa raiz sai com a segunda causa zerada e o total continua parecendo
    plausivel — ninguem repara. Mesma familia do `empresa=todas` do
    operacional8.

    `apenas_pendentes` tambem e armadilha: vem MARCADO por padrao no formulario
    e reduz a resposta as OS ainda nao classificadas (13 linhas no lugar de
    212). Nao envie o campo.
    """
    r = sessao.post(
        sessao.base + "/relatorios/operacional31/dados",
        data={"tipo": tipo, "data": mes_iso, "tecnico": "todos",
              "empresa": "todos", "ignorarMassivas": "N"},
        headers=_cabecalhos(csrf, sessao.base + "/relatorios/operacional31"),
        timeout=300,
    )
    r.raise_for_status()
    return _html_de_actions(r.text)


def parse_categorias(html):
    """Le a aba "Tabela" (uma linha por protocolo) e devolve as linhas cruas.

    Devolve LINHA A LINHA, e nao contagens ja agregadas, porque a tela do
    /iqi filtra por empresa, por supervisor e por mes ao mesmo tempo. Agregar
    aqui obrigaria a coletar uma contagem por combinacao de filtro — ou a
    tirar o filtro da tela. E o mesmo formato compacto que a Produtividade
    usa: registro pequeno, texto num dicionario a parte.

    NAO usa a aba "Indicadores", embora ela ja venha agregada por mes: aquela
    aba IGNORA o filtro `tipo`. Medido em 29/08/2026, `tipo=iqi` e `tipo=iqm`
    devolvem Cat 4 byte a byte identicos (Total 3548 nos dois). O detalhe,
    sim, respeita — e e dai que sai o split IQI/IQM.
    """
    soup = BeautifulSoup(html, "lxml")
    pane = soup.find(attrs={"data-u-title": "Tabela"}) or soup
    tabela = pane.find("table", id="tabela-31")
    if not tabela:
        return []

    cabec = _cabecalho(tabela)
    idx = {nome: i for i, nome in enumerate(cabec)}
    i_tec, i_cid = idx.get("Tecnico da OS", idx.get("Técnico da OS")), idx.get("Cidade")
    linhas = []
    for tr in tabela.select("tbody tr"):
        tds = tr.find_all("td")
        if len(tds) < len(cabec) - 2:
            continue
        reg = {
            "tecnico": _limpa(tds[i_tec].get_text(" ", strip=True))
                       if i_tec is not None and i_tec < len(tds) else "",
            "cidade": _limpa(tds[i_cid].get_text(" ", strip=True))
                      if i_cid is not None and i_cid < len(tds) else "",
        }
        for n in (1, 2, 3):
            i = idx.get(f"Categoria {n}")
            reg[f"cat{n}"] = (_normalizar(tds[i].get_text(" ", strip=True))
                              if i is not None and i < len(tds) else None)
        for n in (4, 5):
            i = idx.get(f"Categoria {n}")
            reg[f"cat{n}"] = (_cat_do_select(tds[i], n)
                              if i is not None and i < len(tds) else None)
        linhas.append(reg)
    return linhas


# Ordem dos campos dentro de cada registro compacto. O front depende dela.
CAMPOS = ("tecnico", "cat1", "cat2", "cat3", "cat4", "cat5", "cidade")
# Nome da lista de textos de cada campo, dentro do payload.
LISTAS = {"tecnico": "tec", "cat1": "c1", "cat2": "c2", "cat3": "c3",
          "cat4": "c4", "cat5": "c5", "cidade": "cid"}


def coletar_categorias(sessao, meses, anterior=None):
    """Registros compactos por (indicador, mes), com dicionarios compartilhados.

    As listas de texto sao CARREGADAS do payload anterior e so crescem, nunca
    sao reordenadas: os meses que nao foram recoletados nesta rodada guardam
    indices que apontam para elas. Reconstruir as listas do zero a cada rodada
    deslocaria todo indice antigo e trocaria silenciosamente a categoria de
    cada registro do historico.
    """
    csrf, _ = _csrf(sessao, "/relatorios/operacional31")
    payload = dict(anterior or {})
    listas = {campo: list(payload.get(nome) or []) for campo, nome in LISTAS.items()}
    indices = {campo: {v: i for i, v in enumerate(vals)} for campo, vals in listas.items()}

    def pos(campo, valor):
        """Indice do texto na lista do campo. -1 = ausente (nao classificado)."""
        if not valor:
            return -1
        if valor not in indices[campo]:
            indices[campo][valor] = len(listas[campo])
            listas[campo].append(valor)
        return indices[campo][valor]

    for tipo, rotulo in (("iqi", "IQI"), ("iqm", "IQM")):
        bloco = dict(payload.get(rotulo) or {})
        for mes in meses:
            log(f"  categorias {rotulo} {mes}…")
            linhas = parse_categorias(buscar_categorias(sessao, tipo, mes, csrf))
            bloco[mes] = [[pos(c, reg.get(c)) for c in CAMPOS] for reg in linhas]
            log(f"    -> {len(linhas)} reincidencias")
        payload[rotulo] = bloco

    for campo, nome in LISTAS.items():
        payload[nome] = listas[campo]
    payload["campos"] = list(CAMPOS)
    payload["meses"] = sorted(set(payload.get("IQI", {})) | set(payload.get("IQM", {})))
    payload["atualizado_em"] = _agora().isoformat()
    return payload


# ==========================================================================
# 2. Cancelamentos — indicadores13
# ==========================================================================
# A pagina filtra por uma sintaxe de texto: "tipo : valor ; valor , outro : v".
# Tipos aceitos: cidades, bairros, motivos, motivos_grupos, servicos, usuarios,
# data, dia, churn, tempo_casa, tempo_contrato, faixa_ticket.
FILTRO_CHURN = "churn : valido"

# Cada aba da resposta e uma tabela, e a ORDEM nao e contrato — casamos pelo
# primeiro cabecalho. "Data" aparece duas vezes (mensal e diaria); a primeira
# e a mensal.
_ABAS_CANCELAMENTO = {
    "Cidade": "cidades", "Bairro": "bairros", "Motivo": "motivos",
    "Motivo (Grupo)": "grupos", "Serviço": "servicos", "Usuario": "usuarios",
    "Churn": "churn", "Meses de casa": "tempo_casa",
    "Meses de contrato": "tempo_contrato", "Faixa de Ticket": "faixa_ticket",
}

# O CMT (cancelamento por motivo tecnico) e este grupo. Conferido em 07/2026:
# 52 de 475 validos = 10,95%.
GRUPO_TECNICO = "PROBLEMA TECNICO"


def coletar_cancelamentos(sessao, meses, anterior=None):
    csrf, _ = _csrf(sessao, "/relatorios/indicadores13")
    payload = dict(anterior or {})
    blocos = dict(payload.get("meses_dados") or {})
    for mes in meses:
        ini, fim = _limites_do_mes(mes)
        log(f"  cancelamentos {mes} ({ini} a {fim})…")
        r = sessao.post(
            f"{sessao.base}/relatorios/indicadores13/dados/{ini}/{fim}",
            # Mandado explicito de proposito: o WVSA guarda um "perfil" por
            # usuario e a pagina ja abre com `churn : valido` para o Matheus.
            # Depender disso deixaria a coleta refem de uma preferencia que
            # qualquer um pode limpar clicando em "Remover padrao".
            data={"pesquisas": FILTRO_CHURN},
            headers=_cabecalhos(csrf, sessao.base + "/relatorios/indicadores13"),
            timeout=300,
        )
        r.raise_for_status()
        blocos[mes] = parse_cancelamentos(_html_de_envelope(r.text))
        blocos[mes]["motivos_tecnicos"] = _motivos_do_grupo_tecnico(
            sessao, csrf, ini, fim)
        log(f"    -> {blocos[mes]['total']} cancelamentos validos, "
            f"{blocos[mes]['tecnico']} tecnicos")
    payload["meses_dados"] = blocos
    payload["meses"] = sorted(blocos)
    payload["grupo_tecnico"] = GRUPO_TECNICO
    payload["atualizado_em"] = _agora().isoformat()
    return payload


def _motivos_do_grupo_tecnico(sessao, csrf, ini, fim):
    """Os motivos que compoem o CMT, pedindo o recorte AO RELATORIO.

    A alternativa — filtrar por prefixo os motivos que ja vieram — parece
    equivalente e nao e. Medido em 08/2026, "PROBLEMA TECNICO" casa com seis
    motivos, mas o grupo tem quatro:

        18  PROBLEMA TECNICO / SEM HISTORICO            <- do grupo
        35  PROBLEMA TECNICO/HISTORICO DE OS            <- do grupo
         8  PROBLEMA TECNICO / ATEND SUPORTE REMOTO     <- do grupo
         5  PROBLEMA TECNICO/ PROBLEMA CLIENTE (...)    <- do grupo
         2  PROBLEMA TECNICO/MASSIVA                    <- NAO
         2  INADIMPLENTE SEM USO / PROBLEMA TECNICO/... <- NAO

    Os quatro somam 66, que e exatamente o total do grupo; os seis somam 70 e
    a soma dos motivos deixaria de bater com o percentual do CMT logo acima,
    na mesma tela. Quem decide o que e do grupo e o cadastro do WVSA, nao o
    texto do rotulo.
    """
    r = sessao.post(
        f"{sessao.base}/relatorios/indicadores13/dados/{ini}/{fim}",
        data={"pesquisas": f"{FILTRO_CHURN} , motivos_grupos : {GRUPO_TECNICO.lower()}"},
        headers=_cabecalhos(csrf, sessao.base + "/relatorios/indicadores13"),
        timeout=300,
    )
    r.raise_for_status()
    return parse_cancelamentos(_html_de_envelope(r.text)).get("motivos") or {}


def parse_cancelamentos(html):
    soup = BeautifulSoup(html, "lxml")
    saida = {"dias": {}}
    vistos = set()
    for tabela in soup.find_all("table"):
        cabec = _cabecalho(tabela)
        if not cabec:
            continue
        chave = _ABAS_CANCELAMENTO.get(cabec[0])
        if cabec[0] == "Data":
            # Primeira "Data" = mensal (uma linha); segunda = dia a dia.
            chave = "mensal" if "mensal" not in vistos else "dias"
        if not chave or (chave in vistos and chave != "dias"):
            continue
        vistos.add(chave)
        # As tabelas NAO tem a mesma largura: Motivos e Servicos vem com
        # (rotulo, Quantidade, Valor, %), mas Cidades e Bairros trazem duas
        # colunas a mais no meio — "Quantidade Base" e "% Base". Ler `Valor`
        # pela posicao 2 pegava a base da cidade e somava R$ 34.207 onde o
        # relatorio dizia R$ 63.170,82. Casa-se pelo cabecalho.
        i_qtd = cabec.index("Quantidade") if "Quantidade" in cabec else 1
        i_val = cabec.index("Valor") if "Valor" in cabec else None
        linhas = {}
        for tr in tabela.select("tbody tr"):
            c = _celulas(tr)
            if len(c) <= i_qtd:
                continue
            linhas[c[0]] = {
                "qtd": _int(c[i_qtd]),
                "valor": _num(c[i_val]) if i_val is not None and i_val < len(c) else 0.0,
            }
        saida[chave] = linhas

    grupos = saida.get("grupos") or {}
    # O total sai da aba "Data" (uma linha, o mes inteiro), que e o numero que
    # o relatorio publica. Somar as cidades daria o mesmo, mas so enquanto toda
    # cidade estiver classificada — e uma cidade em branco viraria diferenca
    # silenciosa entre o painel e a tela do WVSA.
    mensal = list((saida.get("mensal") or {}).values())
    if mensal:
        saida["total"] = sum(v["qtd"] for v in mensal)
        saida["valor"] = round(sum(v["valor"] for v in mensal), 2)
    else:
        saida["total"] = sum(v["qtd"] for v in (saida.get("cidades") or {}).values())
        saida["valor"] = round(sum(v["valor"] for v in (saida.get("cidades") or {}).values()), 2)
    saida["tecnico"] = (grupos.get(GRUPO_TECNICO) or {}).get("qtd", 0)
    saida["valor_tecnico"] = (grupos.get(GRUPO_TECNICO) or {}).get("valor", 0.0)
    return saida


def _limites_do_mes(mes_iso):
    ano, mes = (int(x) for x in mes_iso.split("-"))
    ini = date(ano, mes, 1)
    fim = (date(ano + (mes == 12), (mes % 12) + 1, 1) - timedelta(days=1))
    hoje = date.today()
    return ini.isoformat(), min(fim, hoje).isoformat()


# ==========================================================================
# 3. Esteira de agendamento — /operacional/os/query
# ==========================================================================
# O filtro "Esteira Agendamento" da tela e a constante OS_TIPO abaixo. Os
# demais valores existem (MINHA_ESTEIRA, RETIRADAS, ESTEIRA_N1…), mas o modulo
# so olha este.
OS_TIPO_ESTEIRA = "ESTEIRA_AGENDAMENTO"

# Retirada nao e trabalho de campo a agendar: e equipamento a recolher de quem
# ja cancelou. Somada ao resto, ela domina a fila (406 de 519 em 29/08/2026) e
# esconde a esteira que a operacao consegue atacar.
_FINALIDADES_RETIRADA = ("retirada",)


def coletar_esteira(sessao):
    csrf, _ = _csrf(sessao, "/operacional/os")
    r = sessao.post(
        sessao.base + "/operacional/os/query",
        json={"OS_TIPO": OS_TIPO_ESTEIRA},
        headers=_cabecalhos(csrf, sessao.base + "/operacional/os"),
        timeout=300,
    )
    r.raise_for_status()
    dados = parse_esteira(_html_de_envelope(r.text))
    dados["atualizado_em"] = _agora().isoformat()
    log(f"  esteira -> {dados['total']} na fila "
        f"({dados['retiradas']} retiradas, {dados['util']} uteis)")
    return dados


def parse_esteira(html):
    soup = BeautifulSoup(html, "lxml")
    tabela = soup.find("table")
    if not tabela:
        return {"total": 0, "util": 0, "retiradas": 0, "por_finalidade": {}, "oss": []}
    cabec = _cabecalho(tabela)
    idx = {n: i for i, n in enumerate(cabec)}
    i_os, i_fin = idx.get("OS"), idx.get("Finalidade")
    i_cid, i_fila = idx.get("Cidade"), idx.get("Entrou na fila")

    finalidades, cidades, oss, retiradas = Counter(), Counter(), [], 0
    for tr in tabela.select("tbody tr"):
        tds = tr.find_all("td")
        if i_os is None or i_os >= len(tds):
            continue
        # A celula traz "533677 Cristhian Gazziero" — numero da OS e quem abriu.
        m = re.match(r"\s*(\d+)", tds[i_os].get_text(" ", strip=True))
        if m:
            oss.append(int(m.group(1)))
        fin = _limpa(tds[i_fin].get_text(" ", strip=True)) if i_fin is not None and i_fin < len(tds) else ""
        if fin:
            finalidades[fin] += 1
            if fin.lower().startswith(_FINALIDADES_RETIRADA):
                retiradas += 1
        if i_cid is not None and i_cid < len(tds):
            # A celula traz DOIS spans: cidade e, embaixo, bairro
            # ("Balneario Picarras" / "N SENHORA DA CONCEICAO"). O texto
            # concatenado nao da para separar por espaco — "Porto Belo" virava
            # "Porto". O primeiro span e a cidade.
            span = tds[i_cid].find("span")
            c = _limpa(span.get_text(" ", strip=True)) if span else ""
            if c:
                cidades[c] += 1

    total = len(oss)
    return {
        "total": total,
        "retiradas": retiradas,
        "util": total - retiradas,
        "por_finalidade": dict(finalidades.most_common()),
        "cidades": dict(cidades.most_common(15)),
        "oss": oss,
        "tem_entrada_na_fila": i_fila is not None,
    }


# ==========================================================================
# 4. IDF — indicadores9 (sessao GESTOR)
# ==========================================================================
# Os blocos vem marcados com data-u-tipo; o texto de cada um e "<rotulo>
# <numero>". As contagens (211 ligacoes, 1087 chats, 297 OS) vem dos badges.
_BLOCOS_IDF = {
    "LIGACOES_NOTAS_POR_SETOR": ("ligacoes", "nota"),
    "LIGACOES_SOLICITACOES_POR_SETOR": ("ligacoes", "pct_resolvido"),
    "CHATS_NOTAS_POR_SETOR": ("chats", "nota"),
    "CHATS_SOLICITACOES_POR_SETOR": ("chats", "pct_resolvido"),
    "OS_NOTAS_POR_SETOR": ("os", "nota"),
    "OS_SOLICITACOES_POR_SETOR": ("os", "pct_resolvido"),
}
_CANAIS_BADGE = {"Ligações": "ligacoes", "Chats": "chats", "OS": "os"}


class IdfVazio(RuntimeError):
    """O IDF voltou zerado — quase sempre e a sessao errada, nao o mes fraco."""


def coletar_idf(sessao, meses, anterior=None):
    csrf, _ = _csrf(sessao, "/relatorios/indicadores9")
    payload = dict(anterior or {})
    blocos = dict(payload.get("meses_dados") or {})
    for mes in meses:
        ini, fim = _limites_do_mes(mes)
        log(f"  IDF {mes} ({ini} a {fim})…")
        r = sessao.post(
            sessao.base + "/relatorios/indicadores9/dados",
            data={"_token": csrf, "data_inicio": ini, "data_fim": fim,
                  "AGRUPAR_POR": "setor"},
            headers=_cabecalhos(csrf, sessao.base + "/relatorios/indicadores9"),
            timeout=300,
        )
        r.raise_for_status()
        blocos[mes] = parse_idf(_html_de_actions(r.text))
        log(f"    -> ligacoes {blocos[mes]['ligacoes']['n']}, "
            f"chats {blocos[mes]['chats']['n']}, OS {blocos[mes]['os']['n']}")
    conferir_idf_vazio(blocos, meses, anterior)
    payload["meses_dados"] = blocos
    payload["meses"] = sorted(blocos)
    payload["atualizado_em"] = _agora().isoformat()
    return payload


def parse_idf(html):
    soup = BeautifulSoup(html, "lxml")
    saida = {c: {"n": 0, "nota": 0.0, "pct_resolvido": 0.0}
             for c in ("ligacoes", "chats", "os")}
    for bloco in soup.select("[data-u-tipo]"):
        alvo = _BLOCOS_IDF.get(bloco.get("data-u-tipo"))
        if not alvo:
            continue
        canal, campo = alvo
        txt = _limpa(bloco.get_text(" ", strip=True))
        # "Média das Notas 4.58" / "% Sol. Atendida 88.15%" / "… Sem dados"
        m = re.search(r"(\d+[.,]?\d*)\s*%?\s*$", txt)
        saida[canal][campo] = float(m.group(1).replace(",", ".")) if m else 0.0
    for badge in soup.select(".badge"):
        pai = _limpa(badge.parent.get_text(" ", strip=True)) if badge.parent else ""
        for rotulo, canal in _CANAIS_BADGE.items():
            if pai.startswith(rotulo):
                saida[canal]["n"] = _int(badge.get_text(strip=True))
    return saida


def conferir_idf_vazio(blocos, meses, anterior):
    """Barra a gravacao quando o IDF volta zerado.

    Existe porque o modo de falha aqui NAO e um erro: `/relatorios/indicadores9`
    responde HTTP 200 com "Sem dados" nos tres canais quando a sessao nao tem o
    recorte. Medido em 29/08/2026, mesmo endpoint e mesmo periodo — o usuario
    comum recebeu zero em tudo; o gestor, 211 ligacoes, 1087 chats e 297 OS.

    Sem esta trava, trocar (ou deixar vencer) a credencial do gestor faria o
    painel exibir nota zero e o coletor reportar sucesso. Perder dado calado e
    pior do que falhar.

    Mes de verdade com zero atendimento nao existe na operacao; ainda assim so
    levantamos quando JA HAVIA numero antes, para a primeira coleta de um
    ambiente novo nao travar sozinha.
    """
    zerado = all(
        blocos[m][c]["n"] == 0
        for m in meses if m in blocos
        for c in ("ligacoes", "chats", "os")
    )
    if not zerado:
        return
    tinha = any(
        (((anterior or {}).get("meses_dados") or {}).get(m, {}).get(c, {}) or {}).get("n", 0) > 0
        for m in ((anterior or {}).get("meses_dados") or {})
        for c in ("ligacoes", "chats", "os")
    )
    if not tinha:
        return
    raise IdfVazio(
        "IDF voltou zerado em " + ", ".join(meses) + ", mas ja havia numero gravado. "
        "Quase sempre e a sessao: confira W8_USER_GESTOR / W8_PASS_GESTOR. "
        "Nada foi sobrescrito."
    )


# ==========================================================================
# 5. Salas do Rocketchat — operacional15 (sessao GESTOR)
# ==========================================================================
def coletar_salas(sessao, dias=30):
    csrf, _ = _csrf(sessao, "/relatorios/operacional15")
    hoje = date.today()
    ini = hoje - timedelta(days=dias)
    r = sessao.post(
        sessao.base + "/relatorios/operacional15/dados",
        # Aqui as datas sao DD/MM/AAAA, ao contrario do indicadores13 e do
        # indicadores9, que querem AAAA-MM-DD. Nao ha padrao no WVSA.
        data={"inicio": ini.strftime("%d/%m/%Y"), "fim": hoje.strftime("%d/%m/%Y"),
              "tipo": ""},
        headers=_cabecalhos(csrf, sessao.base + "/relatorios/operacional15"),
        timeout=300,
    )
    r.raise_for_status()
    texto = r.text
    html = _html_de_actions(texto) or _html_de_envelope(texto)
    dados = parse_salas(html)
    dados["periodo"] = {"inicio": ini.isoformat(), "fim": hoje.isoformat()}
    dados["atualizado_em"] = _agora().isoformat()
    log(f"  salas -> {dados['total']} solicitacoes, {dados['abertas']} em aberto")
    return dados


def parse_salas(html):
    """Solicitacoes do Rocketchat.

    A tela nao expoe formato tao previsivel quanto os outros relatorios, entao
    o parser trabalha com o que a tabela oferecer: conta linhas, e se houver
    colunas de tipo/status, agrupa por elas. Colunas ausentes viram dicionario
    vazio em vez de excecao — o card degrada para "so o total".
    """
    soup = BeautifulSoup(html, "lxml")
    saida = {"total": 0, "abertas": 0, "por_tipo": {}, "por_status": {}, "linhas": []}
    tabela = soup.find("table")
    if not tabela:
        return saida
    cabec = _cabecalho(tabela)
    idx = {n.lower(): i for i, n in enumerate(cabec)}

    def coluna(*nomes):
        for n in nomes:
            for rotulo, i in idx.items():
                if n in rotulo:
                    return i
        return None

    i_tipo = coluna("tipo", "motivo")
    i_status = coluna("status", "situa")
    i_data = coluna("abert", "criad", "data")
    tipos, status = Counter(), Counter()
    for tr in tabela.select("tbody tr"):
        c = _celulas(tr)
        if not c:
            continue
        saida["total"] += 1
        t = c[i_tipo] if i_tipo is not None and i_tipo < len(c) else ""
        s = c[i_status] if i_status is not None and i_status < len(c) else ""
        if t:
            tipos[t] += 1
        if s:
            status[s] += 1
            if "abert" in s.lower() or "pendente" in s.lower():
                saida["abertas"] += 1
        if len(saida["linhas"]) < 50:
            saida["linhas"].append({
                "tipo": t, "status": s,
                "data": c[i_data] if i_data is not None and i_data < len(c) else "",
            })
    saida["por_tipo"] = dict(tipos.most_common())
    saida["por_status"] = dict(status.most_common())
    saida["cabecalho"] = cabec
    return saida


# ==========================================================================
# Meses a coletar
# ==========================================================================
def meses_da_rodada(hoje=None):
    """Mes corrente e o anterior.

    O anterior entra porque a janela de reincidencia de 30 dias so fecha depois
    da virada: julho ainda muda em agosto. Meses mais antigos sao imutaveis e
    ficam com o backfill.
    """
    hoje = hoje or date.today()
    primeiro = date(hoje.year, hoje.month, 1)
    anterior = primeiro - timedelta(days=1)
    return [f"{anterior:%Y-%m}", f"{primeiro:%Y-%m}"]


def meses_do_backfill(hoje=None, desde=None):
    """Janeiro do ano corrente ate o mes atual.

    O recorte e o ANO, e nao "os ultimos N meses", porque e assim que a meta
    e lida: IQI do ano, churn do ano. Uma janela deslizante faria a serie
    perder janeiro em fevereiro do ano seguinte, no meio do fechamento.

    `DASH_BACKFILL_DESDE` (AAAA-MM) puxa mais para tras quando alguem quiser
    comparar com o ano passado.
    """
    hoje = hoje or date.today()
    desde = desde or os.environ.get("DASH_BACKFILL_DESDE") or f"{hoje.year}-01"
    ano, mes = (int(x) for x in desde.split("-"))
    saida, cur = [], date(ano, mes, 1)
    limite = date(hoje.year, hoje.month, 1)
    while cur <= limite:
        saida.append(f"{cur:%Y-%m}")
        cur = date(cur.year + (cur.month == 12), (cur.month % 12) + 1, 1)
    return saida
