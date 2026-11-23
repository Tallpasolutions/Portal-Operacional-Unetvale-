"""Camada de dados da War Room de Operações (migration 0021).

A sala de guerra "Zerando a esteira" começou em 19/11/2026: os supervisores
passam o dia na mesa, junto do agendamento, e respondem por uma rotina fixa
(saída do almoxarifado até 08:15, daily, validação de rotas, conferência da
agenda às 10h/12h/15h/18h, validação das OS de suporte) — registrando todo
desvio com causa, responsável e solução.

A tela junta duas coisas que moram em lugares diferentes:

* **os números do dia**, que só são LIDOS: OS executadas com sucesso
  (Produtividade, `dados_modulo`), OS que entraram na esteira e o backlog
  (módulo Esteira, tabelas `esteira_*`). Todos SEM retirada e SEM infra
  (decisão de 19/11/2026: a War Room é do agendamento de cliente);
* **os desvios e as rodadas**, que nascem aqui (`warroom_*`) — dado sem ter
  de onde recoletar, então nada se apaga: desvio errado se anula (§2).

O catálogo (momentos, tipos, causas, responsáveis) mora AQUI e não em
`check` do banco: ele vai ser acertado com os supervisores nos primeiros
dias, e cada ajuste seria uma migration. A chave gravada é um slug estável;
o rótulo pode mudar à vontade. Tirar uma chave do catálogo não quebra o que
já foi gravado: a tela mostra a chave crua no lugar do rótulo.
"""
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

from . import dados, esteira, supa
from . import supervisores as sup

BR_TZ = timezone(timedelta(hours=-3))

INICIO = date(2026, 11, 19)
# A régua de comparação é a janela do "Resumo de 8 semanas" que motivou a
# War Room (22/09 a 16/11/2026): o "antes", medido pela mesma fonte.
BASE_DE, BASE_ATE = date(2026, 9, 22), date(2026, 11, 16)
DIAS_GRAFICO = 28          # o gráfico mostra o antes e o depois do início
DIAS_TECNICOS = 30         # técnico que não fechou OS em 30 dias sai da lista
DIAS_RETROATIVO = 7        # registrar desvio de até uma semana atrás

# Capacidade diária (decisão de 19/11/2026): 4 OS por dia para o técnico que
# faz atendimento EXTERNO e 6 para o que faz INTERNO (o "Tipo de atendimento"
# do WVSA, `ta` na Produtividade). O perfil é a MAIORIA das OS de cliente dele
# nos últimos 30 dias — muitos fazem os dois (3 ELLO: 140 externas e 70
# internas de 20/10 a 19/11), e decidir dia a dia faria a capacidade de quem
# fechou uma OS só oscilar de 4 para 6. Conta quem fechou ao menos uma OS de
# cliente no dia: é a equipe que de fato foi a campo, não a escalada.
CAP_EXTERNA, CAP_INTERNA = 4, 6
DIAS_PERFIL = 30

# ---------------------------------------------------------------------
# Escopo dos números: sem retirada e sem infra
# ---------------------------------------------------------------------
# Retirada é a mesma definição da Esteira (`esteira.eh_retirada`), para que
# "sem retirada" signifique a mesma coisa nas duas telas. Infra é por
# FINALIDADE, não por empresa: a INFRASEG faz suporte de cliente (645 OS de
# 22/09 a 19/11) e entrou no ranking de ofensores do resumo de 8 semanas,
# que também tirava "retirada e infra".
_INFRA_TEM = ("infra",)
_INFRA_EXATAS = {"troca de poste", "massiva", "notificacao celesc",
                 "manutencao programada", "adequacao de rede"}


def _norma(texto):
    t = unicodedata.normalize("NFKD", (texto or "").strip().lower())
    return "".join(c for c in t if not unicodedata.combining(c))


def eh_infra(finalidade):
    f = _norma(finalidade)
    return any(p in f for p in _INFRA_TEM) or f in _INFRA_EXATAS


def eh_cliente(finalidade):
    return not esteira.eh_retirada(finalidade) and not eh_infra(finalidade)


# ---------------------------------------------------------------------
# Catálogo do registro
# ---------------------------------------------------------------------
# `rodada`: entra na grade "a rotina de hoje". Encerramento sem sucesso e
# "Outro" acontecem a qualquer hora; não são uma conferência com horário.
MOMENTOS = [
    {"id": "almoxarifado", "rotulo": "Saída do almoxarifado", "quando": "até 08:15", "rodada": True},
    {"id": "daily", "rotulo": "Daily", "quando": "15 min", "rodada": True},
    {"id": "rotas", "rotulo": "Validação de rotas", "quando": "manhã", "rodada": True},
    {"id": "check_10", "rotulo": "Agenda 10h", "quando": "10:00", "rodada": True},
    {"id": "check_12", "rotulo": "Agenda 12h", "quando": "12:00", "rodada": True},
    {"id": "check_15", "rotulo": "Agenda 15h", "quando": "15:00", "rodada": True},
    {"id": "check_18", "rotulo": "Agenda 18h", "quando": "18:00", "rodada": True},
    {"id": "suporte", "rotulo": "Validação das OS de suporte", "quando": "ao longo do dia", "rodada": True},
    {"id": "encerramento", "rotulo": "Encerramento sem sucesso", "quando": "a qualquer hora", "rodada": False},
    {"id": "outro", "rotulo": "Outro momento", "quando": "", "rodada": False},
]
_CHECKS = ["check_10", "check_12", "check_15", "check_18"]

# O QUE aconteceu. `momentos` diz em quais momentos o tipo é oferecido
# primeiro; a lista inteira continua disponível ("Outros tipos"), porque o
# supervisor descobre um desvio de rota no check das 12h e o tipo não pode
# depender de onde ele estava na rotina.
TIPOS = [
    {"id": "saida_tardia", "rotulo": "Saiu do almoxarifado depois das 08:15",
     "momentos": ["almoxarifado"], "pede_horario": True},
    {"id": "nao_saiu", "rotulo": "Não saiu para campo", "momentos": ["almoxarifado", "daily"]},
    {"id": "ausencia", "rotulo": "Técnico ausente ou sem escala", "momentos": ["almoxarifado", "daily"]},
    {"id": "falta_material", "rotulo": "Falta de material ou equipamento",
     "momentos": ["almoxarifado"] + _CHECKS},
    {"id": "rota_fora", "rotulo": "OS fora da rota ou da região do técnico", "momentos": ["rotas", "daily"]},
    {"id": "agenda_cheia", "rotulo": "Agenda acima da capacidade", "momentos": ["rotas", "daily"]},
    {"id": "agenda_vazia", "rotulo": "Agenda abaixo da capacidade / técnico ocioso",
     "momentos": ["rotas", "daily"] + _CHECKS},
    {"id": "os_atrasada", "rotulo": "OS atrasada em relação à agenda", "momentos": _CHECKS},
    {"id": "os_nao_executada", "rotulo": "OS não executada no horário", "momentos": _CHECKS},
    # Pedido de 23/11/2026: OS na agenda sem a confirmação com o cliente. É
    # achada ao montar e validar a rota e nas conferências da agenda.
    {"id": "os_sem_confirmacao", "rotulo": "OS sem confirmação", "momentos": ["rotas", "daily"] + _CHECKS},
    {"id": "sem_retorno", "rotulo": "Técnico sem retorno / sem contato", "momentos": _CHECKS},
    {"id": "suporte_desnecessario", "rotulo": "Suporte não precisava de visita (repassado ao agendamento)",
     "momentos": ["suporte"]},
    {"id": "os_incorreta", "rotulo": "OS aberta incorreta ou duplicada", "momentos": ["suporte", "rotas"]},
    {"id": "encerr_validado", "rotulo": "Encerramento sem sucesso validado pelo supervisor",
     "momentos": ["encerramento"]},
    {"id": "encerr_sem_validacao", "rotulo": "Encerrou sem sucesso sem validar com o supervisor",
     "momentos": ["encerramento"]},
    {"id": "outro", "rotulo": "Outro desvio", "momentos": [m["id"] for m in MOMENTOS]},
]

# POR QUE aconteceu. As primeiras são as categorias do resumo de 8 semanas
# (página 3), para que o "antes" e o "depois" se comparem pela mesma régua.
# Lista fechada de propósito: 52% dos encerramentos sem sucesso daquele
# levantamento ficaram "sem motivo claro" porque o motivo era texto livre.
CAUSAS = [
    {"id": "cliente_ausente", "rotulo": "Cliente ausente ou sem contato"},
    {"id": "cliente_recusou", "rotulo": "Cliente cancelou ou recusou"},
    {"id": "servico_desnecessario", "rotulo": "Serviço desnecessário"},
    {"id": "normalizou", "rotulo": "Conexão normalizou antes da visita"},
    {"id": "os_incorreta", "rotulo": "OS aberta incorreta ou duplicada"},
    {"id": "falta_material", "rotulo": "Falta de material ou equipamento"},
    {"id": "falta_viabilidade", "rotulo": "Falta de viabilidade ou infraestrutura"},
    {"id": "outra_equipe", "rotulo": "Precisa de outra equipe (externa ou infra)"},
    {"id": "sem_tempo", "rotulo": "Sem tempo / agenda estourada"},
    {"id": "rota_mal_montada", "rotulo": "Rota mal montada / deslocamento"},
    {"id": "atraso_tecnico", "rotulo": "Atraso ou ausência do técnico"},
    {"id": "erro_agendamento", "rotulo": "Erro de agendamento"},
    {"id": "app_sistema", "rotulo": "App ou sistema"},
    {"id": "clima", "rotulo": "Clima ou condição externa"},
    {"id": "outro", "rotulo": "Outra causa (descrever no detalhe)", "pede_detalhe": True},
]

# Palpite da causa a partir do motivo que o técnico escreveu no fechamento,
# só para PREENCHER o formulário que nasce da lista de encerradas sem
# sucesso — o supervisor confere e troca. Trechos sem acento e sem caixa;
# o primeiro que casar vale. Motivo que não casa deixa a causa em branco, em
# vez de chutar.
MOTIVO_CAUSA = [
    ("nao estava em casa", "cliente_ausente"), ("sem contato", "cliente_ausente"),
    ("ausente", "cliente_ausente"),
    ("sem tempo", "sem_tempo"),
    ("incorret", "os_incorreta"), ("duplicad", "os_incorreta"),
    ("conexao esta ok", "normalizou"), ("normalizou", "normalizou"),
    ("desistiu", "cliente_recusou"), ("nao quis", "cliente_recusou"),
    ("quer reagendar", "cliente_recusou"), ("recusou", "cliente_recusou"),
    ("equipe externa", "outra_equipe"), ("outra equipe", "outra_equipe"),
    ("chovendo", "clima"), ("chuva", "clima"), ("apr impedida", "clima"),
    ("material", "falta_material"), ("viabilidade", "falta_viabilidade"),
]


def causa_do_motivo(motivo):
    m = _norma(motivo)
    return next((c for trecho, c in MOTIVO_CAUSA if trecho in m), None)


# QUEM responde pela causa — o papel, e o nome quando fizer sentido.
RESPONSAVEIS = [
    {"id": "tecnico", "rotulo": "Técnico"},
    {"id": "terceira", "rotulo": "Empresa terceira (líder)"},
    {"id": "agendamento", "rotulo": "Agendamento"},
    {"id": "supervisor", "rotulo": "Supervisor"},
    {"id": "almoxarifado", "rotulo": "Almoxarifado"},
    {"id": "suporte_n1", "rotulo": "Suporte / N1"},
    {"id": "comercial", "rotulo": "Comercial / vendas"},
    {"id": "infra", "rotulo": "Infraestrutura"},
    {"id": "cliente", "rotulo": "Cliente"},
    {"id": "sistema", "rotulo": "App / sistema"},
]

STATUS = ("resolvido", "pendente")


def catalogo():
    return {"momentos": MOMENTOS, "tipos": TIPOS, "causas": CAUSAS,
            "responsaveis": RESPONSAVEIS}


def _ids(lista):
    return {x["id"]: x for x in lista}


_MOMENTO, _TIPO, _CAUSA, _RESP = _ids(MOMENTOS), _ids(TIPOS), _ids(CAUSAS), _ids(RESPONSAVEIS)
_RODADAS = [m["id"] for m in MOMENTOS if m["rodada"]]


# ---------------------------------------------------------------------
# Dia e hora
# ---------------------------------------------------------------------
def _agora():
    # `datetime.now()` ingênuo grava 3 h no passado numa timestamptz (§6).
    return datetime.now(timezone.utc)


def hoje(agora=None):
    """Dia civil de Brasília — o dia da rotina dos supervisores."""
    return (agora or _agora()).astimezone(BR_TZ).date()


def _hora_local(iso):
    if not iso:
        return None
    return datetime.fromisoformat(iso).astimezone(BR_TZ).strftime("%H:%M")


def _data_hora_local(iso):
    if not iso:
        return None
    return datetime.fromisoformat(iso).astimezone(BR_TZ).strftime("%d/%m %H:%M")


def _desde_grafico():
    """O gráfico mostra as semanas antes do início, para o "depois" ter com
    o que ser comparado a olho."""
    return (INICIO - timedelta(days=DIAS_GRAFICO)).isoformat()


# ---------------------------------------------------------------------
# Números: Produtividade
# ---------------------------------------------------------------------
# Última Produtividade lida, por carimbo: (atualizado_em, linha do banco).
# Com a tela se atualizando sozinha (pedido de 23/11/2026), cada aba aberta
# relê o pacote a cada coleta — e a Produtividade são 1,35 MB do Supabase.
# Numa instância quente da Vercel, quem chega depois com o MESMO carimbo
# reaproveita a leitura e paga só a consulta do carimbo. Trocar a tupla
# inteira numa atribuição é atômico; o pior caso entre threads é ler duas
# vezes.
_CACHE_PROD = (None, None)


def _ler_produtividade():
    """Lê a Produtividade SEM expandir para dicionários.

    A tela da Produtividade expande as 57 mil OS em dicionários
    (`dados.expandir_produtividade`); aqui só se conta, e as linhas compactas
    (`v: 2`) bastam. A seleção pelo caminho do JSON traz só as listas que a
    contagem usa. Payload antigo (`v: 1`) cai no caminho de sempre.
    """
    global _CACHE_PROD
    carimbo = (supa.select_one("dados_modulo", {"modulo": "eq.produtividade",
                                                "select": "atualizado_em"}) or {}).get("atualizado_em")
    if carimbo and _CACHE_PROD[0] == carimbo:
        row = _CACHE_PROD[1]
    else:
        row = supa.select_one("dados_modulo", {
            "modulo": "eq.produtividade",
            "select": "atualizado_em,v:payload->v,linhas:payload->linhas,dias:payload->dias,"
                      "emp:payload->emp,tec:payload->tec,fin:payload->fin,mot:payload->mot"})
        if row and row.get("v") == 2:
            _CACHE_PROD = (row.get("atualizado_em"), row)
    if not row:
        return None, []
    if row.get("v") == 2:
        dias, emp, tec = row.get("dias") or [], row.get("emp") or [], row.get("tec") or []
        fin, mot = row.get("fin") or [], row.get("mot") or []

        def iterar():
            for l in row.get("linhas") or []:
                # [d, e, t, ti, f, su, rj, ta, mo?, os?, hora?] — número e
                # hora só na não concluída recente (coletor/enviar.py).
                yield (dias[l[0]], emp[l[1]], tec[l[2]], fin[l[4]], l[5],
                       mot[l[8]] if len(l) > 8 else None, l[7],
                       l[9] if len(l) > 9 else None, l[10] if len(l) > 10 else None)
        return row.get("atualizado_em"), iterar()
    antigo = dados.get_modulo("produtividade") or {}
    regs = (antigo.get("payload") or {}).get("registros") or []
    mot = (antigo.get("payload") or {}).get("mot") or []
    return antigo.get("atualizado_em"), (
        (r.get("d"), r.get("e"), r.get("t"), r.get("f"), r.get("su"),
         mot[r["mo"]] if isinstance(r.get("mo"), int) and r["mo"] < len(mot) else r.get("mo"),
         r.get("ta"), None, None)
        for r in regs)


def _produtividade(dia_foco):
    """Contagens por dia civil, a régua por dia da semana, os técnicos e as
    encerradas sem sucesso do dia em foco — numa passada pelas OS."""
    atualizado_em, linhas = _ler_produtividade()
    corte_tec = (hoje() - timedelta(days=DIAS_TECNICOS)).isoformat()
    base_de, base_ate = BASE_DE.isoformat(), BASE_ATE.isoformat()
    foco = dia_foco.isoformat()
    por_dia = defaultdict(lambda: [0, 0])          # dia -> [sucesso, sem sucesso]
    tecnicos = {}                                    # nome -> (dia mais recente, empresa)
    sem_sucesso = []
    desde = _desde_grafico()
    corte_perfil = (hoje() - timedelta(days=DIAS_PERFIL)).isoformat()
    em_campo = defaultdict(set)                      # dia -> técnicos com OS de cliente
    perfil = defaultdict(lambda: [0, 0, 0, 0])       # técnico -> [ext 30d, int 30d, ext, int]
    for d, e, t, f, su, mo, ta, os_n, hora in linhas:
        if not d or d < base_de or not eh_cliente(f):
            continue
        por_dia[d][0 if su else 1] += 1
        if t and t != "—":
            if d >= desde or d == foco:
                em_campo[d].add(t)
            pf = perfil[t]
            pf[2 if ta else 3] += 1
            if d >= corte_perfil:
                pf[0 if ta else 1] += 1
        if d >= corte_tec and t and t != "—":
            if t not in tecnicos or d >= tecnicos[t][0]:
                tecnicos[t] = (d, e if e and e != "—" else "")
        if d == foco and not su:
            motivo = mo or "Não informado"
            sem_sucesso.append({"tecnico": t, "empresa": e, "finalidade": f, "motivo": motivo,
                                "os": str(os_n) if os_n else None, "hora": hora,
                                "causa": causa_do_motivo(motivo)})
    # Régua: média por dia da semana nas 8 semanas, só dias com OS (feriado
    # sem coleta não puxa a média para baixo como se fosse um dia fraco).
    soma, n = defaultdict(lambda: [0, 0]), Counter()
    for d, (s, ns) in por_dia.items():
        if base_de <= d <= base_ate:
            w = date.fromisoformat(d).weekday()
            soma[w][0] += s
            soma[w][1] += ns
            n[w] += 1
    base = {w: [round(soma[w][0] / n[w]), round(soma[w][1] / n[w])] for w in n}
    capacidade = {}
    for d, tecs in em_campo.items():
        ext = sum(1 for t in tecs if _faz_externa(perfil[t]))
        capacidade[d] = [ext * CAP_EXTERNA + (len(tecs) - ext) * CAP_INTERNA, ext, len(tecs) - ext]
    return {
        "atualizado_em": atualizado_em,
        "por_dia": {d: v for d, v in por_dia.items() if d >= _desde_grafico() or d == foco},
        "base": base,
        "tecnicos": sorted(([nome, emp] for nome, (_, emp) in tecnicos.items()),
                           key=lambda x: _norma(x[0])),
        "sem_sucesso": sorted(sem_sucesso, key=lambda x: (_norma(x["tecnico"]), x["hora"] or "")),
        "capacidade": capacidade,
    }


def _faz_externa(pf):
    """Perfil do técnico pela maioria das OS de cliente: as dos últimos 30
    dias, ou a janela inteira para quem não trabalhou nesse período."""
    ext, interno = (pf[0], pf[1]) if pf[0] + pf[1] else (pf[2], pf[3])
    return ext > interno


# ---------------------------------------------------------------------
# Números: Esteira
# ---------------------------------------------------------------------
def _soma_cliente(por_fin):
    return sum(n for f, n in (por_fin or {}).items() if eh_cliente(f))


def _esteira(dia_foco):
    """Entradas por dia operacional e a fila (backlog) por dia, sem retirada
    e sem infra. A régua das entradas é a mesma das OS executadas: média por
    dia da semana nas 8 semanas, só dias com coleta."""
    de = min(BASE_DE, dia_foco - timedelta(days=DIAS_GRAFICO))
    ate = max(hoje(), dia_foco)
    fluxo, fotos, coleta = supa.paralelo(
        lambda: supa.rpc("esteira_fluxo", {"p_de": de.isoformat(), "p_ate": ate.isoformat()}) or {},
        lambda: supa.select("esteira_backlog_diario", {
            "select": "dia,abertas_fin,nag_fin",
            "dia": f"gte.{_desde_grafico()}",
            "order": "dia.asc"}),
        lambda: supa.select_one("esteira_coleta", {"id": "eq.1", "select": "ok_em"}),
    )
    entradas, lacuna = {}, {}
    for d, v in fluxo.items():
        ent = v.get("ent") or {}
        entradas[d] = _soma_cliente(ent.get("fin"))
        if ent.get("lacuna"):
            lacuna[d] = ent["lacuna"]
    soma, n = Counter(), Counter()
    for d, q in entradas.items():
        if BASE_DE.isoformat() <= d <= BASE_ATE.isoformat() and q and d not in lacuna:
            w = date.fromisoformat(d).weekday()
            soma[w] += q
            n[w] += 1
    return {
        "atualizado_em": (coleta or {}).get("ok_em"),
        "entradas": {d: q for d, q in entradas.items() if d >= _desde_grafico() or d == dia_foco.isoformat()},
        "lacuna": lacuna,
        "base": {w: round(soma[w] / n[w]) for w in n},
        "backlog": {f["dia"]: [_soma_cliente(f.get("abertas_fin")), _soma_cliente(f.get("nag_fin"))]
                    for f in fotos},
    }


# ---------------------------------------------------------------------
# Desvios e rodadas
# ---------------------------------------------------------------------
_COLS = ("id,dia,registrado_em,registrado_por,momento,tipo,causa,detalhe,responsavel,"
         "responsavel_nome,tecnico,empresa,os,horario,solucao,status,resolvido_em,"
         "resolvido_por,atualizado_em,atualizado_por,anulado_em,anulado_por,anulado_motivo")


def _paginado(tabela, params):
    linhas = []
    while True:
        lote = supa.select(tabela, {**params, "limit": "1000", "offset": str(len(linhas))})
        linhas.extend(lote)
        if len(lote) < 1000:
            return linhas


def _formatar(d, nomes):
    """Linha do banco -> o que a tela usa (hora local, nomes no lugar dos ids)."""
    return {
        **{k: d.get(k) for k in ("id", "dia", "momento", "tipo", "causa", "detalhe", "responsavel",
                                 "responsavel_nome", "tecnico", "empresa", "solucao", "status",
                                 "anulado_motivo")},
        "os": d.get("os") or [],
        "horario": (d.get("horario") or "")[:5] or None,
        "hora": _hora_local(d.get("registrado_em")),
        "registrado_por": d.get("registrado_por"),
        "por": nomes.get(d.get("registrado_por"), "—"),
        "resolvido": _data_hora_local(d.get("resolvido_em")),
        "resolvido_por": nomes.get(d.get("resolvido_por")),
        "anulado": _data_hora_local(d.get("anulado_em")),
        "anulado_por": nomes.get(d.get("anulado_por")),
    }


def _nomes():
    return {u["id"]: u.get("nome") or "—" for u in supa.select("usuarios", {"select": "id,nome"})}


def versao():
    """Carimbos das duas fontes, numa string. A tela pergunta isto de 2 em 2
    min (duas linhas pequenas) e só pede o pacote quando muda — o pacote lê
    a Produtividade inteira."""
    prod, est = supa.paralelo(
        lambda: supa.select_one("dados_modulo", {"modulo": "eq.produtividade", "select": "atualizado_em"}),
        lambda: supa.select_one("esteira_coleta", {"id": "eq.1", "select": "ok_em"}),
    )
    return f"{(prod or {}).get('atualizado_em') or ''}|{(est or {}).get('ok_em') or ''}"


def pacote(dia_foco):
    """Tudo o que a tela precisa, numa ida em paralelo.

    Os desvios vêm do início da War Room até o dia em foco: a tela alterna
    entre "o dia" e "desde o início" sem ir ao servidor. Sem a migration, a
    tela mostra os números e diz o que falta para registrar.
    """
    def desvios():
        try:
            return _paginado("warroom_desvios", {
                "select": _COLS, "dia": f"gte.{INICIO.isoformat()}",
                "order": "registrado_em.desc"}), True
        except Exception as e:
            if supa.tabela_faltando(e):
                return [], False
            raise

    def rodadas():
        try:
            return supa.select("warroom_rodadas", {
                "select": "dia,momento,usuario_id,feito_em",
                "dia": f"eq.{dia_foco.isoformat()}", "order": "feito_em.asc"})
        except Exception as e:
            if supa.tabela_faltando(e):
                return []
            raise

    def validacoes():
        try:
            return supa.select("warroom_validacoes", {
                "select": "os,validado,usuario_id,em", "dia": f"eq.{dia_foco.isoformat()}"})
        except Exception as e:
            if supa.tabela_faltando(e):
                return None
            raise

    prod, est, (lista, tem_tabela), rod, nomes, alcance, vals = supa.paralelo(
        lambda: _produtividade(dia_foco), lambda: _esteira(dia_foco),
        desvios, rodadas, _nomes, _alcance_supervisores, validacoes)
    # Cada encerrada sem sucesso leva os supervisores que respondem pelo
    # técnico: a tela filtra por supervisor sem conhecer a regra do vínculo.
    for o in prod["sem_sucesso"]:
        o["sups"] = [a["id"] for a in alcance if _no_alcance(a, o["empresa"], o["tecnico"])]
    return {
        "versao": f"{prod['atualizado_em'] or ''}|{est['atualizado_em'] or ''}",
        "dia": dia_foco.isoformat(),
        "hoje": hoje().isoformat(),
        "inicio": INICIO.isoformat(),
        "base_de": BASE_DE.isoformat(),
        "base_ate": BASE_ATE.isoformat(),
        "produtividade": {**prod, "atualizado": _data_hora_local(prod["atualizado_em"])},
        "esteira": {**est, "atualizado": _data_hora_local(est["atualizado_em"])},
        "catalogo": catalogo(),
        "tem_tabela": tem_tabela,
        "desvios": [_formatar(d, nomes) for d in lista if d["dia"] <= dia_foco.isoformat()],
        "rodadas": [{"momento": r["momento"], "usuario_id": r["usuario_id"],
                     "nome": nomes.get(r["usuario_id"], "—"), "hora": _hora_local(r["feito_em"])}
                    for r in rod],
        "supervisores": [{"id": a["id"], "nome": nomes.get(a["id"], "—")} for a in alcance],
        # None = a migration 0022 ainda não subiu; {} = ninguém validou nada.
        "validacoes": None if vals is None else {v["os"]: _validacao(v, nomes) for v in vals},
        "wvsa_os": WVSA_OS,
        "cap_externa": CAP_EXTERNA,
        "cap_interna": CAP_INTERNA,
    }


# Ficha da OS no WVSA — o mesmo endereço que a Esteira usa. Só abre dentro
# da rede da Unetvale, que é onde os supervisores estão.
WVSA_OS = "https://wvsa8.unetvale.com.br/os/"


def _alcance_supervisores():
    """Equipes e técnicos de cada supervisor, em SÉRIE.

    `supervisores.listar()` faz as leituras em `supa.paralelo`, e isto roda
    dentro do paralelo de `pacote`: paralelo aninhado no mesmo pool pode
    prender as threads esperando filhas sem onde rodar (§4, Esteira).
    """
    ids = [l["usuario_id"] for l in supa.select("supervisores", {"select": "usuario_id"})]
    if not ids:
        return []
    filtro = f"in.({','.join(ids)})"
    equipes = supa.select("supervisor_equipes", {"select": "usuario_id,equipe", "usuario_id": filtro})
    try:
        tecs = supa.select("supervisor_tecnicos", {"select": "usuario_id,tecnico", "usuario_id": filtro})
    except Exception:
        tecs = []          # migration 0004 ausente: vale só o vínculo por equipe
    out = {i: {"id": i, "equipes": set(), "tecnicos": set()} for i in ids}
    for e in equipes:
        out[e["usuario_id"]]["equipes"].add(sup.APELIDOS_EMPRESA.get(e["equipe"].upper(), e["equipe"].upper()))
    for t in tecs:
        out[t["usuario_id"]]["tecnicos"].add(t["tecnico"])
    return list(out.values())


def _no_alcance(a, empresa, tecnico):
    """A mesma regra do recorte da Produtividade: equipe inteira OU o técnico
    vinculado nome a nome (`supervisores`, apelidos resolvidos)."""
    e = (empresa or "").strip().upper()
    return (sup.APELIDOS_EMPRESA.get(e, e) in a["equipes"]
            or sup.chave_tecnico(f"{empresa} - {tecnico}") in a["tecnicos"])


def _validacao(v, nomes):
    return {"validado": v["validado"], "nome": nomes.get(v["usuario_id"], "—"),
            "usuario_id": v["usuario_id"], "hora": _hora_local(v["em"])}


def marcar_validacao(corpo, uid):
    """O supervisor diz se a recusa (OS encerrada sem sucesso) passou por ele.

    `validado` true/false grava; null apaga (volta a "sem resposta"). Uma
    linha por (dia, OS): a última resposta vale, com quem e quando.
    """
    d = dia_valido(corpo.get("dia"))
    if d < hoje() - timedelta(days=DIAS_RETROATIVO):
        raise Recusa(f"Só dá para validar OS dos últimos {DIAS_RETROATIVO} dias.")
    os_n = str(corpo.get("os") or "").strip()
    if not os_n.isdigit() or len(os_n) > 9:
        raise Recusa("Número de OS inválido.")
    validado = corpo.get("validado")
    if validado not in (True, False, None):
        raise Recusa("Resposta inválida.")
    if validado is None:
        supa.delete("warroom_validacoes", {"dia": d.isoformat(), "os": os_n})
        return None
    linha = supa.upsert("warroom_validacoes", {
        "dia": d.isoformat(), "os": os_n, "validado": validado, "usuario_id": uid,
        "em": _agora().isoformat()}, on_conflict="dia,os")
    return _validacao(linha, _nomes())


class Recusa(ValueError):
    """Entrada recusada; a mensagem vai para a tela."""


def _texto(v, teto, campo, obrigatorio=False):
    t = re.sub(r"\s+", " ", str(v or "")).strip()
    if obrigatorio and not t:
        raise Recusa(f"Preencha {campo}.")
    if len(t) > teto:
        raise Recusa(f"{campo[0].upper() + campo[1:]} passa de {teto} caracteres.")
    return t or None


def _lista_os(v):
    """"586420, 586421 586422" -> ["586420", "586421", "586422"], sem repetir."""
    if isinstance(v, list):
        v = " ".join(str(x) for x in v)
    partes = [p for p in re.split(r"[\s,;/#]+", str(v or "")) if p]
    vistos = []
    for p in partes:
        if not p.isdigit() or len(p) > 9:
            raise Recusa(f"“{p[:20]}” não é número de OS.")
        if p not in vistos:
            vistos.append(p)
    if len(vistos) > 20:
        raise Recusa("No máximo 20 OS por desvio.")
    return vistos


def dia_valido(texto, permitir_futuro=False):
    try:
        d = date.fromisoformat(str(texto or ""))
    except ValueError:
        raise Recusa("Dia inválido.")
    if not permitir_futuro and d > hoje():
        raise Recusa("O dia não pode estar no futuro.")
    return d


def validar_desvio(corpo):
    """Corpo do formulário -> registro pronto para o banco (sem dia e autor)."""
    momento = corpo.get("momento")
    tipo = corpo.get("tipo")
    causa = corpo.get("causa")
    resp = corpo.get("responsavel")
    if momento not in _MOMENTO:
        raise Recusa("Escolha o momento da rotina.")
    if tipo not in _TIPO:
        raise Recusa("Escolha o tipo de desvio.")
    if causa not in _CAUSA:
        raise Recusa("Escolha a causa.")
    if resp not in _RESP:
        raise Recusa("Escolha o responsável.")
    detalhe = _texto(corpo.get("detalhe"), 500, "o detalhe")
    if _CAUSA[causa].get("pede_detalhe") and not detalhe:
        raise Recusa("Com “Outra causa”, descreva a causa no detalhe.")
    horario = None
    if _TIPO[tipo].get("pede_horario"):
        horario = str(corpo.get("horario") or "").strip()
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", horario):
            raise Recusa("Informe o horário em que o técnico saiu.")
    tecnico = _texto(corpo.get("tecnico"), 120, "o técnico")
    # A empresa vem da lista de técnicos da Produtividade (o cadastro do
    # WVSA), escolhida junto com o nome na tela — não é digitada. Conferir
    # de novo aqui custaria reler as 57 mil OS a cada registro.
    empresa = _texto(corpo.get("empresa"), 80, "a empresa") if tecnico else None
    status = corpo.get("status") or "resolvido"
    if status not in STATUS:
        raise Recusa("Status inválido.")
    return {
        "momento": momento, "tipo": tipo, "causa": causa, "detalhe": detalhe,
        "responsavel": resp,
        "responsavel_nome": _texto(corpo.get("responsavel_nome"), 120, "o nome do responsável"),
        "tecnico": tecnico, "empresa": empresa,
        "os": _lista_os(corpo.get("os")),
        "horario": horario,
        "solucao": _texto(corpo.get("solucao"), 1000, "a solução", obrigatorio=True),
        "status": status,
    }


def registrar(corpo, uid):
    d = dia_valido(corpo.get("dia"))
    if d < hoje() - timedelta(days=DIAS_RETROATIVO):
        raise Recusa(f"Só dá para registrar desvio dos últimos {DIAS_RETROATIVO} dias.")
    reg = validar_desvio(corpo)
    agora = _agora().isoformat()
    reg.update({"dia": d.isoformat(), "registrado_por": uid})
    if reg["status"] == "resolvido":
        reg.update({"resolvido_em": agora, "resolvido_por": uid})
    linha = supa.insert("warroom_desvios", reg)
    return _formatar(linha, _nomes())


def _ler(desvio_id):
    try:
        return supa.select_one("warroom_desvios", {"select": _COLS, "id": f"eq.{desvio_id}"})
    except Exception as e:
        # id que não é uuid: 400 do PostgREST (22P02). É "não existe".
        if getattr(getattr(e, "response", None), "status_code", None) == 400:
            return None
        raise


def atualizar(desvio_id, corpo, uid):
    """Status e solução — o que muda depois do registro. Qualquer pessoa com
    o módulo: a mesa é uma só, e quem resolve não é sempre quem registrou."""
    atual = _ler(desvio_id)
    if not atual:
        return None
    if atual.get("anulado_em"):
        raise Recusa("Este desvio foi anulado.")
    mud = {}
    if "solucao" in corpo:
        mud["solucao"] = _texto(corpo.get("solucao"), 1000, "a solução", obrigatorio=True)
    if "status" in corpo:
        if corpo["status"] not in STATUS:
            raise Recusa("Status inválido.")
        mud["status"] = corpo["status"]
    mud = {k: v for k, v in mud.items() if v != atual.get(k)}
    if not mud:
        raise Recusa("Nada mudou.")
    agora = _agora().isoformat()
    mud.update({"atualizado_em": agora, "atualizado_por": uid})
    if mud.get("status") == "resolvido":
        mud.update({"resolvido_em": agora, "resolvido_por": uid})
    elif mud.get("status") == "pendente":
        mud.update({"resolvido_em": None, "resolvido_por": None})
    # Condicional ao status lido: dois cliques simultâneos não se atropelam.
    linhas = supa.update("warroom_desvios", {"id": desvio_id, "status": atual["status"]}, mud)
    if not linhas:
        raise Recusa("Outra pessoa alterou este desvio agora. Recarregue a página.")
    return _formatar(linhas[0], _nomes())


def anular(desvio_id, motivo, uid, eh_admin):
    """Só quem registrou (ou o admin) anula — e o desvio fica na tabela."""
    atual = _ler(desvio_id)
    if not atual:
        return None
    if atual["registrado_por"] != uid and not eh_admin:
        raise PermissionError("Só quem registrou o desvio pode anulá-lo.")
    if atual.get("anulado_em"):
        raise Recusa("Este desvio já foi anulado.")
    motivo = _texto(motivo, 300, "o motivo", obrigatorio=True)
    agora = _agora().isoformat()
    linhas = supa.update("warroom_desvios", {"id": desvio_id}, {
        "anulado_em": agora, "anulado_por": uid, "anulado_motivo": motivo,
        "atualizado_em": agora, "atualizado_por": uid})
    return _formatar(linhas[0], _nomes())


def marcar_rodada(corpo, uid):
    """Marca (ou desmarca) a rodada desta pessoa. Devolve as rodadas do dia."""
    d = dia_valido(corpo.get("dia"))
    if d < hoje() - timedelta(days=DIAS_RETROATIVO):
        raise Recusa(f"Só dá para marcar rodada dos últimos {DIAS_RETROATIVO} dias.")
    momento = corpo.get("momento")
    if momento not in _RODADAS:
        raise Recusa("Momento inválido.")
    if corpo.get("feito") is False:
        supa.delete("warroom_rodadas", {"dia": d.isoformat(), "momento": momento, "usuario_id": uid})
    else:
        supa.upsert("warroom_rodadas", {"dia": d.isoformat(), "momento": momento, "usuario_id": uid},
                    on_conflict="dia,momento,usuario_id")
    nomes = _nomes()
    rod = supa.select("warroom_rodadas", {"select": "momento,usuario_id,feito_em",
                                          "dia": f"eq.{d.isoformat()}", "order": "feito_em.asc"})
    return [{"momento": r["momento"], "usuario_id": r["usuario_id"],
             "nome": nomes.get(r["usuario_id"], "—"), "hora": _hora_local(r["feito_em"])} for r in rod]
