"""Camada de dados do módulo Esteira de Agendamento (migration 0020).

Só LÊ: quem escreve é o coletor (`coletor/esteira.py`), dentro da rede da
Unetvale, pelas funções `esteira_aplicar_*`. O app nunca fala com o WVSA (§2).

O DIA OPERACIONAL vai de 21h a 21h de Brasília, que é a DATA UTC. O banco o
calcula numa coluna gerada (`esteira_movimentos.dia_operacional`); aqui ele
só é preciso para saber qual é "hoje", e a tela recebe esse valor pronto —
o JS não recalcula.
"""
from datetime import datetime, timedelta, timezone

from . import supa

BR_TZ = timezone(timedelta(hours=-3))
PAGINA = 1000          # db-max-rows do PostgREST: acima disso corta calado (§6)
DIAS_FLUXO = 60

# Retirada não é trabalho de campo a agendar: é equipamento a recolher de quem
# já cancelou, e domina a fila (652 de 1.095 em 22/10/2026). Uma definição só:
# o bloco da esteira do Dashboard lê daqui também.
FINALIDADES_RETIRADA = ("retirada",)

# Janela do coletor (`ESTEIRA_HORA_INI`/`FIM` em coletor/esteira.py).
HORA_INI, HORA_FIM = 6, 22
FRESCOR_MIN = 30       # dentro da janela: 3 rodadas perdidas
FRESCOR_NOITE_MIN = 9 * 60   # fora dela: a última das 22h até a primeira das 6h

# Colunas da fila, na ordem em que vão para a tela (formato compacto: uma
# lista por OS, como os registros da Produtividade). Com 1.100 OS, repetir as
# chaves em cada uma dobrava o pacote. `solicitacao` fica no banco e fora
# daqui: a tela não a mostra, e eram 51 KB de 646 (medido em 22/10/2026).
CAMPOS = ("os", "cliente", "aberto_por", "finalidade", "cidade", "bairro",
          "endereco", "lat", "lng", "geo_precisao", "entrou_fila", "hrs_parada",
          "agendamento", "agendado_para", "visitas", "contatos", "tags", "sem_sucesso")


def dia_operacional(instante=None):
    """O dia operacional de um instante: a data UTC (21h de Brasília = 00h UTC)."""
    return (instante or datetime.now(timezone.utc)).astimezone(timezone.utc).date()


def eh_retirada(finalidade):
    return (finalidade or "").strip().lower().startswith(FINALIDADES_RETIRADA)


def _paginado(tabela, params):
    linhas = []
    while True:
        p = {**params, "limit": str(PAGINA), "offset": str(len(linhas))}
        lote = supa.select(tabela, p)
        linhas.extend(lote)
        if len(lote) < PAGINA:
            return linhas


def _fila():
    return _paginado("esteira_os", {
        "select": ",".join(c for c in CAMPOS if c != "sem_sucesso")
                  + ",esteira_tentativas(data_evento,tecnico,motivo)",
        "ativa": "eq.true",
        # Só a última tentativa de cada OS: o histórico inteiro são milhares
        # de linhas que a tela não mostra.
        "esteira_tentativas.order": "data_evento.desc",
        "esteira_tentativas.limit": "1",
        "order": "os.asc",
    })


def _compactar(fila):
    """Fila -> (linhas compactas, catálogo de tags).

    As tags se repetem muito ("Não foi Fechada pelo Técnico" em quase todas):
    cada OS leva índices para um catálogo único, e não o texto de novo.
    """
    catalogo, indice, linhas = [], {}, []
    for o in fila:
        # A última "fechada sem sucesso" como [data, técnico, motivo]. O texto
        # inteiro da ficha repetia os dois e pesava 215 KB dos 646 do pacote.
        t = (o.pop("esteira_tentativas", None) or [None])[0]
        o["sem_sucesso"] = [t["data_evento"], t.get("tecnico"), t.get("motivo")] if t else None
        idx = []
        for t in o.get("tags") or []:
            # "Tempo na esteira" é o `hrs_parada` em forma de tag, e o número
            # muda de OS para OS: no catálogo, seriam ~1.100 entradas únicas.
            if t.get("t") == "Tempo na esteira":
                continue
            chave = (t.get("i", ""), t.get("c", ""), t.get("t", ""), t.get("n", ""))
            if chave not in indice:
                indice[chave] = len(catalogo)
                catalogo.append(list(chave))
            idx.append(indice[chave])
        o["tags"] = idx
        linhas.append([o.get(c) for c in CAMPOS])
    return linhas, catalogo


def _oficial(linhas):
    """Backlog oficial no formato da tela: {meses, grupos: {nome: {ym: [e, s]}}, total}."""
    grupos, total = {}, {}
    for l in linhas:
        ym = str(l["mes"])[:7]
        par = [l["entradas"], l["saidas"]]
        if l["grupo"] == "TOTAL":
            total[ym] = par
        else:
            grupos.setdefault(l["grupo"], {})[ym] = par
    meses = sorted({ym for g in grupos.values() for ym in g} or set(total))
    return {"meses": meses, "grupos": grupos, "total": total}


def pacote():
    """Tudo o que a tela precisa, numa ida em paralelo."""
    hoje = dia_operacional()
    de = (hoje - timedelta(days=DIAS_FLUXO - 1)).isoformat()
    fila, fluxo, fotos, oficial, coleta = supa.paralelo(
        _fila,
        lambda: supa.rpc("esteira_fluxo", {"p_de": de, "p_ate": hoje.isoformat()}),
        lambda: supa.select("esteira_backlog_diario", {
            "select": "dia,abertas,agendadas_conf,agendadas_nconf,nao_agendadas,pendente,"
                      "abertas_fin,abertas_cid,nag_fin,nag_cid",
            "dia": f"gte.{de}", "order": "dia.asc"}),
        lambda: supa.select("esteira_backlog_oficial", {
            "select": "mes,grupo,entradas,saidas", "order": "mes.asc"}),
        lambda: supa.select_one("esteira_coleta", {"id": "eq.1", "select": "*"}),
    )
    linhas, tags = _compactar(fila)
    return {
        "hoje": hoje.isoformat(),
        "campos": list(CAMPOS),
        "os": linhas,
        "tags": tags,
        "fluxo": fluxo or {},
        "fotos": {f["dia"]: f for f in fotos},
        "oficial": _oficial(oficial),
        "coleta": coleta or {},
        "retirada": list(FINALIDADES_RETIRADA),
    }


def movimentos_do_dia(dia, tipo):
    """OS que entraram ou saíram num dia operacional — o modal do gráfico."""
    linhas = _paginado("esteira_movimentos", {
        "select": "os,em,finalidade,cidade,apos_lacuna,origem,esteira_os(cliente,ativa)",
        "dia_operacional": f"eq.{dia}", "tipo": f"eq.{tipo}", "order": "em.asc,os.asc",
    })
    out = []
    for l in linhas:
        o = l.pop("esteira_os", None) or {}
        out.append({**l, "cliente": o.get("cliente"), "ativa": o.get("ativa")})
    return out


def _idade(minutos):
    if minutos < 60:
        return f"há {minutos} min"
    if minutos < 60 * 36:
        return f"há {minutos // 60} h"
    return f"há {minutos // (60 * 24)} d"


def limite_frescor(agora=None):
    """Minutos sem coleta a partir dos quais o card acusa "desatualizado".

    Dentro da janela do coletor são 30 (três rodadas). Fora dela a fila não é
    coletada de propósito, e acusar às 23h uma coleta das 22h ensinaria a
    equipe a ignorar o selo (§6).
    """
    agora = (agora or datetime.now(timezone.utc)).astimezone(BR_TZ)
    minuto = agora.hour * 60 + agora.minute
    # A primeira rodada sai entre 06:00 e 06:10: meia hora de folga.
    return FRESCOR_MIN if HORA_INI * 60 + 30 <= minuto < HORA_FIM * 60 + 30 else FRESCOR_NOITE_MIN


def resumo_coleta():
    """Card do /monitoramento, no formato de `dados.resumo_modulos()`."""
    vazio = {"modulo": "esteira", "nome": "Esteira de agendamento",
             "atualizado": "—", "idade": "—", "status": "sem_dados",
             "desatualizado": False, "na_fila": False}
    try:
        c = supa.select_one("esteira_coleta", {"id": "eq.1", "select": "ok_em,erro,erro_em"})
    except Exception as e:
        if supa.tabela_faltando(e):
            return vazio
        raise
    if not c or not c.get("ok_em"):
        return vazio
    ok = datetime.fromisoformat(c["ok_em"])
    minutos = int((datetime.now(timezone.utc) - ok).total_seconds() // 60)
    erro_depois = c.get("erro_em") and datetime.fromisoformat(c["erro_em"]) > ok
    return {**vazio,
            "atualizado": ok.astimezone(BR_TZ).strftime("%d/%m/%Y %H:%M"),
            "idade": _idade(minutos),
            "status": "erro" if erro_depois else "ok",
            "desatualizado": minutos > limite_frescor()}


# Coleta mais velha que isso não serve ao Dashboard: o bloco volta a ler o
# `ger_esteira` (rodada do WVSA de 2 em 2 h) em vez de mostrar uma foto parada.
DASH_VALIDADE_H = 26


def resumo_dashboard(agora=None):
    """O bloco "Esteira de agendamento" do Dashboard, lido deste módulo.

    Uma coleta e uma definição de "entrou/saiu" para as duas telas (decisão
    de 22/10/2026). Antes, o Dashboard contava por dia CIVIL e pela diferença
    entre a primeira e a última foto do dia (OS que entrou e saiu no mesmo
    dia não contava); o módulo conta por dia OPERACIONAL (21h→21h) cada
    entrada e cada saída. "Entraram hoje" daria dois números.

    Devolve None enquanto o módulo não tiver coleta recente — antes da virada
    as tabelas de produção estão vazias, e o Dashboard segue no `ger_esteira`.

    As três leituras vão em SÉRIE de propósito: esta função roda dentro do
    `supa.paralelo` do Dashboard, e um paralelo aninhado no mesmo pool (8
    threads, compartilhado entre requisições) pode prender todas as threads
    esperando filhas que não têm onde rodar.
    """
    agora = agora or datetime.now(timezone.utc)
    try:
        coleta = supa.select_one("esteira_coleta", {"id": "eq.1", "select": "ok_em"})
    except Exception as e:
        if supa.tabela_faltando(e) or supa.coluna_faltando(e):
            return None
        raise
    ok_em = (coleta or {}).get("ok_em")
    if not ok_em:
        return None
    ok = datetime.fromisoformat(ok_em)
    if agora - ok > timedelta(hours=DASH_VALIDADE_H):
        return None
    # A foto mais recente: depois das 21h o dia operacional virou, e até a
    # primeira coleta do dia novo a foto vigente ainda é a de ontem.
    foto = supa.select_one("esteira_backlog_diario", {
        "select": "dia,abertas,abertas_fin,abertas_cid", "order": "dia.desc", "limit": "1"})
    if not foto:
        return None
    hoje = dia_operacional(agora)
    fluxo = (supa.rpc("esteira_fluxo", {"p_de": hoje.isoformat(), "p_ate": hoje.isoformat()}) or {}) \
        .get(hoje.isoformat()) or {}
    fins = foto.get("abertas_fin") or {}
    retiradas = sum(n for f, n in fins.items() if eh_retirada(f))
    ent = (fluxo.get("ent") or {}).get("t", 0)
    sai = (fluxo.get("sai") or {}).get("t", 0)
    cids = foto.get("abertas_cid") or {}
    return {
        "fonte": "esteira",
        "total": foto["abertas"],
        "retiradas": retiradas,
        "util": foto["abertas"] - retiradas,
        "por_finalidade": dict(sorted(fins.items(), key=lambda kv: -kv[1])),
        "cidades": dict(sorted(cids.items(), key=lambda kv: -kv[1])[:15]),
        "atualizado_em": ok_em,
        "movimento": {
            "fonte": "esteira",
            "tem_comparacao": True,
            "entraram": ent,
            "sairam": sai,
            "saldo": ent - sai,
            "apos_lacuna": ((fluxo.get("ent") or {}).get("lacuna", 0)
                            + (fluxo.get("sai") or {}).get("lacuna", 0)),
            "atual_em": ok.astimezone(BR_TZ).strftime("%H:%M"),
        },
    }
