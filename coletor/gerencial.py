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
import time
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


class _Textos:
    """Listas de texto que SO CRESCEM, compartilhadas pelos registros compactos.

    Mesma regra de `coletar_categorias`: os meses que nao forem recoletados
    guardam indices para estas listas, e reordena-las trocaria em silencio o
    texto de cada registro antigo. Aqui vale para cancelamentos e IDF.
    """

    def __init__(self, anterior):
        self.listas = {k: list(v) for k, v in (anterior or {}).items()}
        self._idx = {k: {t: i for i, t in enumerate(v)} for k, v in self.listas.items()}

    def pos(self, lista, texto):
        """Indice do texto. -1 = vazio."""
        texto = _limpa(str(texto)) if texto not in (None, "") else ""
        if not texto:
            return -1
        idx = self._idx.setdefault(lista, {})
        if texto not in idx:
            vals = self.listas.setdefault(lista, [])
            idx[texto] = len(vals)
            vals.append(texto)
        return idx[texto]


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


def _cats_do_select(td, n):
    """Cat 6 e MULTIPLA: `<select multiple>`, e um protocolo pode ter varias.

    Medido em 08/2026, IQI: 25 de 144 linhas tinham Cat 6, uma delas com seis
    valores ao mesmo tempo. Sao os ajustes feitos no Wi-Fi (BAND STEERING,
    Atualizado Firmware, IPV6...). `_cat_do_select` pegaria so o primeiro
    `option[selected]` e jogaria o resto fora em silencio.

    Devolve lista (vazia quando nao ha), sem repetir valor — o cadastro tem
    rotulos que o `_normalizar` junta, e dois deles no mesmo protocolo
    contariam a mesma causa duas vezes.
    """
    sel = td.find("select", attrs={"name": re.compile(rf"^cat{n}-")})
    if not sel:
        v = _normalizar(td.get_text(" ", strip=True))
        return [v] if v else []
    saida = []
    for op in sel.find_all("option", selected=True):
        v = _normalizar(op.get_text(strip=True))
        if v and v not in saida:
            saida.append(v)
    return saida


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
        i = idx.get("Categoria 6")
        reg["cat6"] = _cats_do_select(tds[i], 6) if i is not None and i < len(tds) else []
        linhas.append(reg)
    return linhas


# Ordem dos campos dentro de cada registro compacto. O front depende dela.
#
# `cat6` entrou em 29/09/2026 e fica no FIM de proposito: os meses que nao
# forem recoletados continuam com registros de 7 posicoes, e um campo novo no
# meio deslocaria `cidade` em todos eles. Registro sem a posicao 7 quer dizer
# "Cat 6 nao coletada", que e diferente de `[]` ("coletada, nenhuma").
#
# `cat6` e o unico campo MULTIPLO: no registro ele e uma LISTA de indices.
CAMPOS = ("tecnico", "cat1", "cat2", "cat3", "cat4", "cat5", "cidade", "cat6")
MULTIPLOS = ("cat6",)
# Nome da lista de textos de cada campo, dentro do payload.
LISTAS = {"tecnico": "tec", "cat1": "c1", "cat2": "c2", "cat3": "c3",
          "cat4": "c4", "cat5": "c5", "cidade": "cid", "cat6": "c6"}


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
            bloco[mes] = [[[pos(c, v) for v in reg.get(c) or []] if c in MULTIPLOS
                           else pos(c, reg.get(c)) for c in CAMPOS]
                          for reg in linhas]
            log(f"    -> {len(linhas)} reincidencias")
        payload[rotulo] = bloco

    for campo, nome in LISTAS.items():
        payload[nome] = listas[campo]
    payload["campos"] = list(CAMPOS)
    payload["multiplos"] = list(MULTIPLOS)
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
    csrf19, _ = _csrf(sessao, "/relatorios/operacional19")
    payload = dict(anterior or {})
    blocos = dict(payload.get("meses_dados") or {})
    textos = _Textos(payload.get("textos"))
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
        html = _html_de_envelope(r.text)
        blocos[mes] = parse_cancelamentos(html)
        blocos[mes]["motivos_tecnicos"] = _motivos_do_grupo_tecnico(
            sessao, csrf, ini, fim)
        blocos[mes]["contratos"] = contratos_do_pivot(html, textos)
        blocos[mes]["ultimo_atendimento"] = ultimo_atendimento(
            sessao, csrf19, ini, fim, textos)
        log(f"    -> {blocos[mes]['total']} cancelamentos validos, "
            f"{blocos[mes]['tecnico']} tecnicos, "
            f"{len(blocos[mes]['contratos'])} contratos no detalhe, "
            f"{len(blocos[mes]['ultimo_atendimento'])} com ultima OS")
    payload["meses_dados"] = blocos
    payload["textos"] = textos.listas
    payload["campos_contrato"] = list(CAMPOS_CONTRATO)
    payload["campos_ultimo"] = list(CAMPOS_ULTIMO)
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


# Cabecalho do pivot -> (campo, lista de texto). Casa-se pelo NOME: a ordem
# das colunas da tabela dinamica nao e contrato, e o relatorio ja mostrou
# largura variavel nas abas agregadas (ver `parse_cancelamentos`).
#
# Servicos e Faixa de ticket ficam de fora de proposito: servicos e uma lista
# por contrato (o pacote de SVA inteiro) e a faixa de ticket saiu da tela.
_PIVOT_CANCELAMENTO = {
    "Cidades": ("cidade", "cidade"), "Bairros": ("bairro", "bairro"),
    "Motivos": ("motivo", "motivo"), "Motivos (Grupo)": ("grupo", "grupo"),
    "Usuarios": ("usuario", "usuario"),
    "Tempo de casa": ("casa", "casa"), "Tempo de contrato": ("tempo_contrato", "tempo_contrato"),
}
CAMPOS_CONTRATO = ("contrato", "cidade", "bairro", "motivo", "grupo", "usuario",
                   "dia", "casa", "tempo_contrato")


def contratos_do_pivot(html, textos):
    """Um registro por contrato cancelado, lido da TABELA DINAMICA do IGC.

    O relatorio publica as abas ja agregadas (cidade, motivo, tempo de casa...)
    e, no mesmo HTML, o `pivotUI([...])` da aba "Tabela dinamica" com o
    contrato a contrato. As abas bastavam enquanto a tela so mostrava o total;
    para filtrar por motivo E recontar cidade, ou cruzar com o tecnico da
    ultima OS (que vem de outro relatorio, pelo numero do contrato), e preciso
    o registro. Medido em 08/2026: 64 contratos no grupo tecnico, os mesmos 64
    da aba "Motivo (Grupo)".

    Registro: [contrato, cidade, bairro, motivo, grupo, usuario, dia, casa,
    tempo_contrato] — texto como indice em `textos`, `dia` como inteiro.
    Sem o pivot (layout mudou), devolve [] e a tela cai no agregado.
    """
    i = html.find("pivotUI(")
    j = html.find("[", i) if i >= 0 else -1
    if j < 0:
        return []
    try:
        linhas, _ = json.JSONDecoder().raw_decode(html[j:])
    except json.JSONDecodeError:
        return []
    if not linhas or not isinstance(linhas[0], list):
        return []
    cab = {nome: k for k, nome in enumerate(linhas[0])}
    if "Contrato" not in cab:
        return []
    saida = []
    for lin in linhas[1:]:
        reg = {"contrato": lin[cab["Contrato"]]}
        for nome, (campo, lista) in _PIVOT_CANCELAMENTO.items():
            reg[campo] = textos.pos(lista, lin[cab[nome]]) if nome in cab else -1
        dia = str(lin[cab["Dia"]]) if "Dia" in cab else ""
        m = re.match(r"(\d{2})/", dia)
        reg["dia"] = int(m.group(1)) if m else 0
        saida.append([reg[c] for c in CAMPOS_CONTRATO])
    return saida


CAMPOS_ULTIMO = ("contrato", "os", "tecnico", "dia", "qtd_os", "cat1", "cat2", "cat3")


def ultimo_atendimento(sessao, csrf, ini, fim, textos):
    """Tecnico da ULTIMA OS antes do cancelamento — operacional19 (CMT).

    O relatorio lista, por contrato cancelado por motivo tecnico, todas as OS
    que ele teve e o tecnico de cada uma. O ultimo atendimento e a OS de MAIOR
    NUMERO: o WVSA numera na ordem de abertura (conferido em 29/09/2026, a
    `#579421` foi aberta em 11/08 e o contrato cancelou em 20/08).

    ⚠️ Cobre SO o grupo PROBLEMA TECNICO, e so quem teve OS. Os "SEM
    HISTORICO" nao aparecem — por definicao nao ha tecnico a apontar. Em
    08/2026: 45 dos 64 contratos tecnicos.

    A coluna "Usuario" do relatorio e o ATENDENTE que registrou o
    cancelamento, nao o cliente. A chave do cruzamento com o IGC e o contrato
    do link `/atendimento/<n>` (45 de 45 casaram em 08/2026).

    As datas deste relatorio sao DD/MM/AAAA; as do indicadores13, ISO.
    """
    di, df = (date.fromisoformat(x).strftime("%d/%m/%Y") for x in (ini, fim))
    r = sessao.post(
        sessao.base + "/relatorios/operacional19/dados",
        data={"_token": csrf, "inicio": di, "fim": df},
        headers=_cabecalhos(csrf, sessao.base + "/relatorios/operacional19"),
        timeout=300,
    )
    r.raise_for_status()
    return parse_ultimo_atendimento(_html_de_envelope(r.text), textos)


def parse_ultimo_atendimento(html, textos):
    soup = BeautifulSoup(html, "lxml")
    tabela = soup.find("table", id="lista-cancelamentos")
    if not tabela:
        return []
    cabec = _cabecalho(tabela)
    idx = {n: i for i, n in enumerate(cabec)}
    i_tec = idx.get("Técnicos", idx.get("Tecnicos"))
    i_dia = idx.get("Data de Cancelamento")
    por_contrato = {}
    for tr in tabela.select("tbody tr"):
        tds = tr.find_all("td")
        m_c = re.search(r"/atendimento/(\d+)", str(tds[0])) if tds else None
        m_o = re.search(r"/os/(\d+)", str(tds[idx.get("OSs", 3)])) if len(tds) > 3 else None
        if not m_c or not m_o:
            continue
        contrato, os_n = int(m_c.group(1)), int(m_o.group(1))
        cel = lambda i: _limpa(tds[i].get_text(" ", strip=True)) if i is not None and i < len(tds) else ""
        atual = por_contrato.get(contrato)
        qtd = (atual[4] if atual else 0) + 1
        if atual and atual[1] > os_n:
            atual[4] = qtd
            continue
        dia = re.match(r"(\d{2})/", cel(i_dia))
        por_contrato[contrato] = [
            contrato, os_n, textos.pos("tecnico", cel(i_tec)),
            int(dia.group(1)) if dia else 0, qtd,
            *(textos.pos(f"os_c{n}", cel(idx.get(f"CAT{n}"))) for n in (1, 2, 3)),
        ]
    return sorted(por_contrato.values())


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


def coletar_idf(sessao, meses, anterior=None, detalhar=True):
    """Painel + feedbacks de cada mes; drill por setor/cidade so em `detalhar`.

    `detalhar` e True (todos os meses), False (nenhum) ou a colecao de meses
    que ganham drill nesta rodada — ver `coletar_ger_idf` no enviar.py.
    """
    if detalhar is True or detalhar is False:
        detalhar = set(meses) if detalhar else set()
    csrf, _ = _csrf(sessao, "/relatorios/indicadores9")
    payload = dict(anterior or {})
    blocos = dict(payload.get("meses_dados") or {})
    textos = _Textos(payload.get("textos"))
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
        antigo = blocos.get(mes) or {}
        blocos[mes] = parse_idf(_html_de_actions(r.text))
        blocos[mes].update(idf_detalhado(sessao, csrf, ini, fim, textos, mes in detalhar))
        if mes not in detalhar:
            # O drill por setor/cidade e o que pesa (~45 chamadas de ~5 s por
            # mes, medido em 29/09/2026: 4 min para 08/2026). Fora da rodada
            # diaria, fica o da ultima vez — setor de atendente e cidade do
            # mes mudam devagar; a lista de feedbacks, nao.
            for k in ("setor_de", "cidade", "detalhado_em"):
                if k in antigo:
                    blocos[mes][k] = antigo[k]
        log(f"    -> ligacoes {blocos[mes]['ligacoes']['n']}, "
            f"chats {blocos[mes]['chats']['n']}, OS {blocos[mes]['os']['n']} "
            f"| feedbacks lidos: " + ", ".join(
                f"{c} {len(v)}" for c, v in blocos[mes]["feedbacks"].items()))
    conferir_idf_vazio(blocos, meses, anterior)
    payload["meses_dados"] = blocos
    payload["textos"] = textos.listas
    payload["campos_feedback"] = list(CAMPOS_FEEDBACK)
    payload["campos_alerta"] = list(CAMPOS_ALERTA)
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


# Nome do canal na URL da lista e no TIPO do detalhe. Nao ha padrao no WVSA.
_IDF_CANAIS = {"ligacoes": "LIGACOES", "chats": "CHATS", "os": "OS"}

# Em que canal cada recorte EXISTE. Medido em 29/09/2026, 08/2026:
#   * ligacao por cidade devolve um grupo so, "Indefinido" (224 de 224) — o
#     telefone nao sabe de onde o cliente e;
#   * o "setor" das OS e a EMPRESA do tecnico (razao social), nao um setor do
#     atendimento — e a empresa ja vem no rotulo "EMPRESA - Nome".
# Pedir o que nao existe gastaria chamadas para gravar um recorte que mente.
_IDF_SETOR_EM = ("ligacoes", "chats")
_IDF_CIDADE_EM = ("chats", "os")

# Observacao so e guardada ate esta nota. Ela e texto livre do CLIENTE e so
# interessa a lista de alerta; guardar a de todo feedback levaria para o
# banco centenas de comentarios que ninguem vai ler. Fica em 3 (e nao "< 3")
# para o limiar do alerta, que e configuravel na tela, poder subir para 4.
IDF_OBS_ATE = 3

CAMPOS_FEEDBACK = ("dia", "pessoa", "nota", "resolvido")
CAMPOS_ALERTA = ("canal", "dia", "pessoa", "nota", "obs", "os")


def idf_detalhado(sessao, csrf, ini, fim, textos, detalhar=True):
    """O que o painel do IDF nao mostra agregado: quem, onde e com qual nota.

    Tres pecas, porque nenhum endpoint entrega as tres juntas:

      * `lista/{canal}` — um registro por feedback (data, atendente ou
        tecnico, nota, resolvido). NAO traz setor nem cidade;
      * `detalhes` com `AGRUPAR_POR=setor` — setor -> atendentes. E o
        "subsetor" da tela ("SUPORTE TECNICO (N1)" e cia.);
      * `detalhes` com `AGRUPAR_POR=cidade` — cidade -> atendentes, com
        quantidade e media. Vira um cubo (cidade, pessoa, qtd, media),
        porque a lista nao diz a cidade de cada feedback e nao ha como
        atribuir um a um sem inventar.

    Nada de nome ou telefone de cliente: a coluna "Atendimento" da lista e
    ignorada. O numero da OS fica (so no alerta), porque e por ele que se
    abre a OS no WVSA.
    """
    saida = {"feedbacks": {}, "alertas": []}
    if detalhar:
        saida.update({"setor_de": {}, "cidade": {}, "detalhado_em": _agora().isoformat()})
    base = {"INICIO": f"{ini} 00:00:00", "FIM": f"{fim} 23:59:59"}
    for canal, tipo in _IDF_CANAIS.items():
        html = _post_idf(sessao, csrf, f"/relatorios/indicadores9/lista/{canal}",
                         {**base, "AGRUPAR_POR": "setor"})
        regs, alertas = parse_idf_lista(html, canal, textos)
        saida["feedbacks"][canal] = regs
        saida["alertas"] += alertas
        if not detalhar:
            continue
        if canal in _IDF_SETOR_EM:
            saida["setor_de"][canal] = [
                [textos.pos("pessoa", p), textos.pos("setor", g)]
                for g, p, _q, _m in _idf_por_grupo(sessao, csrf, base, tipo, "setor")]
        if canal in _IDF_CIDADE_EM:
            saida["cidade"][canal] = [
                [textos.pos("cidade", g), textos.pos("pessoa", p), q, m]
                for g, p, q, m in _idf_por_grupo(sessao, csrf, base, tipo, "cidade")]
    return saida


def _post_idf(sessao, csrf, caminho, dados):
    r = sessao.post(sessao.base + caminho, data={"_token": csrf, **dados},
                    headers=_cabecalhos(csrf, sessao.base + "/relatorios/indicadores9"),
                    timeout=300)
    r.raise_for_status()
    return _html_de_actions(r.text)


def _idf_por_grupo(sessao, csrf, base, tipo, agrupar):
    """[(grupo, pessoa, qtd, media)] — o drill de dois niveis do painel.

    Primeiro nivel: os grupos (`data-u-setor`, que carrega a cidade quando o
    agrupamento e por cidade — o atributo nao muda de nome). Segundo: a tabela
    Usuario / Quantidade / Media de cada grupo. Uma chamada por grupo, com
    pausa entre elas: o WVSA falha calado quando apertado (ver o autocomplete
    de bairro no CLAUDE.md), e aqui a falha seria um grupo a menos.
    """
    html = _post_idf(sessao, csrf, "/relatorios/indicadores9/detalhes",
                     {**base, "AGRUPAR_POR": agrupar, "TIPO": f"{tipo}_NOTAS_POR_SETOR"})
    grupos = [d.get("data-u-setor") for d in
              BeautifulSoup(html, "lxml").select("[data-u-setor]") if d.get("data-u-setor")]
    saida = []
    for g in grupos:
        time.sleep(0.4)
        h = _post_idf(sessao, csrf, "/relatorios/indicadores9/detalhes",
                      {**base, "AGRUPAR_POR": agrupar, "SETOR": g,
                       "TIPO": f"{tipo}_NOTAS_POR_USUARIO"})
        tabela = BeautifulSoup(h, "lxml").find("table")
        if not tabela:
            continue
        for tr in tabela.select("tbody tr"):
            c = _celulas(tr)
            if len(c) >= 3 and c[0]:
                saida.append((g, c[0], _int(c[1]), _nota(c[2])))
    return saida


def _nota(txt):
    """Media do WVSA vem com PONTO decimal ("4.33"), ao contrario de `_num`."""
    try:
        return round(float((txt or "").strip().replace(",", ".")), 2)
    except ValueError:
        return None


def parse_idf_lista(html, canal, textos):
    """Registros [dia, pessoa, nota, resolvido] e os alertas do canal.

    As tres listas tem colunas diferentes (ligacao traz gravacao, chat traz
    observacao, OS traz o tecnico e "Internet funcionando?"), entao tudo e
    casado pelo cabecalho. `resolvido`: 1 sim, 0 nao, -1 sem resposta.
    """
    tabela = BeautifulSoup(html, "lxml").find("table")
    if not tabela:
        return [], []
    cab = _cabecalho(tabela)
    idx = {n: i for i, n in enumerate(cab)}
    i_pes = idx.get("Técnico", idx.get("Usuário"))
    i_res = idx.get("Internet funcionando?", idx.get("Solicitação Atendida?"))
    i_nota, i_obs, i_os = idx.get("Nota"), idx.get("Observações"), idx.get("OS")
    regs, alertas = [], []
    for tr in tabela.select("tbody tr"):
        c = _celulas(tr)
        if len(c) < len(cab) - 2:
            continue
        m = re.match(r"(\d{2})/", c[1] if len(c) > 1 else "")
        dia = int(m.group(1)) if m else 0
        pessoa = textos.pos("pessoa", c[i_pes]) if i_pes is not None else -1
        nota = _int(c[i_nota]) if i_nota is not None and c[i_nota].strip() else None
        res = (c[i_res] if i_res is not None else "").strip().lower()
        regs.append([dia, pessoa, nota, 1 if res == "sim" else 0 if res.startswith("n") else -1])
        if nota is not None and nota <= IDF_OBS_ATE:
            m_os = re.search(r"OS\s*(\d+)", c[i_os]) if i_os is not None else None
            alertas.append([canal, dia, pessoa, nota,
                            c[i_obs][:400] if i_obs is not None else "",
                            int(m_os.group(1)) if m_os else None])
    return regs, alertas


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
# 6. Atendimento por chat (TMA / TMF) — indicadores14, RRO (sessao GESTOR)
# ==========================================================================
# O WVSA nao publica TMA nem TMF com esses nomes em relatorio nenhum (conferido
# em 29/09/2026: ITA, ligacoes6, Ranking N1 e MRP nao tem). O RRO traz uma
# linha por conversa do Rocketchat, e as duas medidas saem dela:
#
#   TMA = "Ultima mensagem" - "Iniciado em", so conversa FECHADA com atendente
#         humano (aberta ainda nao tem fim; a do bot nao e atendimento);
#   TMF = a PRIMEIRA entrada de "Tempos de resposta" cujo autor nao e o bot —
#         quanto o cliente esperou ate uma pessoa responder.
#
# Pesa ~1,8 MB por DIA (900 conversas), entao o coletor agrega aqui e so as
# somas sobem. Nenhum nome de cliente sai daqui.
#
# ⚠️ O relatorio devolve SEMPRE as conversas em aberto, qualquer que seja o
# periodo pedido: consultando so 01/09, vieram 872 de 01/09 e mais 69 abertas
# de 28-29/09. O corte e refeito por "Iniciado em", e a sala (id do link)
# deduplica entre janelas.
_BOTS = ("assistente-virtual", "botpress")
_UNIDADES = {"dia": 86400, "hora": 3600, "minuto": 60, "segundo": 1}


def _eh_bot(nome):
    n = (nome or "").strip().lower()
    return not n or any(n.startswith(b) for b in _BOTS)


def _segundos(txt):
    """"1 hora 3 minutos 5 segundos" -> 3785. Nada reconhecivel -> None.

    Le o TEXTO, nao o `data-order` da celula: em 29/09/2026 uma conversa com
    "30 minutos 19 segundos" (1819 s) trazia data-order=654394, que nao e
    segundos, nem milissegundos da mesma resposta.
    """
    total, achou = 0, False
    for n, u in re.findall(r"(\d+)\s*(dia|hora|minuto|segundo)s?", txt or ""):
        total += int(n) * _UNIDADES[u]
        achou = True
    return total if achou else None


def _primeira_resposta_humana(td):
    """Segundos ate a 1a resposta de uma pessoa, lidos da celula.

    A celula empilha uma entrada por resposta, separadas por <br>, cada uma
    "<tempo> (<autor>)". A ordem e a das mensagens, nao a do tempo — por isso
    e a PRIMEIRA humana, e nao a menor.
    """
    for trecho in td.get_text("\n").split("\n"):
        m = re.match(r"\s*(.+?)\s*\(([^)]*)\)\s*$", trecho)
        if m and not _eh_bot(m.group(2)):
            return _segundos(m.group(1))
    return None


def _dt(txt):
    try:
        return datetime.strptime(_limpa(txt)[:19], "%d/%m/%Y %H:%M:%S")
    except ValueError:
        return None


def parse_rro(html, mes):
    """{sala: (departamento, atendente, tma_s|None, tmf_s|None)} do mes pedido."""
    soup = BeautifulSoup(html, "lxml")
    tabela = soup.find("table")
    if not tabela:
        return {}
    idx = {n: i for i, n in enumerate(_cabecalho(tabela))}
    i_dep, i_at = idx.get("Departamento"), idx.get("Atendido por")
    i_ini, i_fim = idx.get("Iniciado em"), idx.get("Última mensagem")
    i_sit, i_tr = idx.get("Situação"), idx.get("Tempos de resposta")
    if None in (i_dep, i_at, i_ini, i_fim, i_sit, i_tr):
        return {}
    ano, mm = (int(x) for x in mes.split("-"))
    saida = {}
    for tr in tabela.select("tbody tr"):
        tds = tr.find_all("td")
        if len(tds) <= max(i_dep, i_at, i_ini, i_fim, i_sit, i_tr):
            continue
        ini = _dt(tds[i_ini].get_text(" ", strip=True))
        if not ini or (ini.year, ini.month) != (ano, mm):
            continue
        link = tr.find("a", href=re.compile(r"/live/"))
        m = re.search(r"/live/([A-Za-z0-9]+)", link["href"]) if link else None
        sala = m.group(1) if m else f"{ini:%Y%m%d%H%M%S}-{len(saida)}"
        atendente = _limpa(tds[i_at].get_text(" ", strip=True))
        humano = not _eh_bot(atendente)
        tma = None
        if humano and _limpa(tds[i_sit].get_text()).lower().startswith("fechad"):
            fim = _dt(tds[i_fim].get_text(" ", strip=True))
            if fim and fim >= ini:
                tma = int((fim - ini).total_seconds())
        saida[sala] = (_limpa(tds[i_dep].get_text(" ", strip=True)),
                       atendente if humano else "",
                       tma, _primeira_resposta_humana(tds[i_tr]) if humano else None)
    return saida


CAMPOS_ATENDIMENTO = ("departamento", "atendente", "conversas", "n_tma", "soma_tma",
                      "n_tmf", "soma_tmf", "faixas_tma", "faixas_tmf")

# Limites (em MINUTOS) das faixas de distribuicao. Existem porque a MEDIA do
# TMA mente: medido na semana de 22 a 28/09/2026, media de 167 min contra
# mediana de 64 min — conversa que o cliente deixa aberta ate o dia seguinte
# puxa a media para cima sozinha. Mediana nao se soma entre atendentes nem
# entre semanas; contagem por faixa, sim, e dela sai a mediana aproximada de
# qualquer recorte. Ultima faixa = acima do ultimo limite.
FAIXAS_MIN = (1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 1440)


def _faixa(seg):
    m = seg / 60
    for i, lim in enumerate(FAIXAS_MIN):
        if m <= lim:
            return i
    return len(FAIXAS_MIN)


def coletar_atendimento(sessao, meses, anterior=None):
    """Somas de TMA/TMF por (mes, departamento, atendente).

    Janelas de 7 dias: um mes inteiro de uma vez seriam ~50 MB numa resposta
    so. Registro: [departamento, atendente, conversas, n_tma, soma_tma_s,
    n_tmf, soma_tmf_s] — a media e soma / n, feita na tela, para que filtrar
    por departamento ou atendente some as partes em vez de fazer media de
    media.
    """
    csrf, _ = _csrf(sessao, "/relatorios/indicadores14")
    payload = dict(anterior or {})
    blocos = dict(payload.get("meses_dados") or {})
    for mes in meses:
        ini, fim = (date.fromisoformat(x) for x in _limites_do_mes(mes))
        salas, cur = {}, ini
        while cur <= fim:
            ate = min(cur + timedelta(days=6), fim)
            log(f"  atendimento (RRO) {cur:%d/%m} a {ate:%d/%m}…")
            r = sessao.post(
                sessao.base + "/relatorios/indicadores14/dados",
                data={"_token": csrf, "inicio": f"{cur:%d/%m/%Y}", "fim": f"{ate:%d/%m/%Y}",
                      "nome": "", "atendido_por": "", "departament_id": "", "open": "",
                      "resolvidoBot": "", "encaminhado_de": "", "encaminhado_para": ""},
                headers=_cabecalhos(csrf, sessao.base + "/relatorios/indicadores14"),
                timeout=600,
            )
            r.raise_for_status()
            salas.update(parse_rro(_html_de_envelope(r.text), mes))
            cur = ate + timedelta(days=1)
        agg = {}
        for dep, at, tma, tmf in salas.values():
            n_f = len(FAIXAS_MIN) + 1
            a = agg.setdefault((dep, at), [dep, at, 0, 0, 0, 0, 0, [0] * n_f, [0] * n_f])
            a[2] += 1
            if tma is not None:
                a[3] += 1
                a[4] += tma
                a[7][_faixa(tma)] += 1
            if tmf is not None:
                a[5] += 1
                a[6] += tmf
                a[8][_faixa(tmf)] += 1
        blocos[mes] = {"linhas": sorted(agg.values(), key=lambda x: (x[0], x[1])),
                       "conversas": len(salas)}
        log(f"    -> {len(salas)} conversas, {len(agg)} pares departamento/atendente")
    payload["meses_dados"] = blocos
    payload["meses"] = sorted(blocos)
    payload["campos"] = list(CAMPOS_ATENDIMENTO)
    payload["faixas_min"] = list(FAIXAS_MIN)
    payload["atualizado_em"] = _agora().isoformat()
    return payload


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
