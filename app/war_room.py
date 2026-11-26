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

from . import dados, equipe, esteira, supa
from . import supervisores as sup

BR_TZ = timezone(timedelta(hours=-3))

INICIO = date(2026, 11, 19)
# A régua de comparação é a janela do "Resumo de 8 semanas" que motivou a
# War Room (22/09 a 16/11/2026): o "antes", medido pela mesma fonte.
BASE_DE, BASE_ATE = date(2026, 9, 22), date(2026, 11, 16)
DIAS_GRAFICO = 28          # o gráfico mostra o antes e o depois do início
DIAS_TECNICOS = 30         # técnico que não fechou OS em 30 dias sai da lista
DIAS_RETROATIVO = 7        # registrar desvio de até uma semana atrás
DIAS_NOVO = 14             # técnico sem responsável: OS de cliente nos últimos 14 dias

# Capacidade diária: 4 OS por dia para o técnico EXTERNO e 6 para o INTERNO
# (que faz interna e externa). Desde 24/11/2026 quem diz o perfil é o
# CADASTRO da equipe (`app/equipe.py`, a planilha "Equipe técnica"), não
# mais o palpite. São dois números:
#
# * **instalada** — toda a equipe ativa do cadastro, sem retirada, como ela
#   era em cada dia (o histórico do cadastro);
# * **em campo** — quem fechou ao menos uma OS de cliente no dia: a
#   confirmação de quem de fato trabalhou.
#
# O palpite antigo (MAIORIA das OS de cliente em 30 dias pelo "Tipo de
# atendimento" do WVSA, `ta`) sobrou só para quem fecha OS e não está no
# cadastro — e a tela conta esses à parte, para ninguém confundir o número
# do cadastro com o do palpite. A planilha e o palpite discordam muito: dos
# 10 técnicos da UNETVALE, a planilha marca 2 como internos e o palpite, 8
# (Produtividade de 25/10 a 24/11/2026).
CAP_EXTERNA, CAP_INTERNA = equipe.CAP_EXTERNA, equipe.CAP_INTERNA
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
# Tipo da OS de cliente (decisão de 24/11/2026)
# ---------------------------------------------------------------------
# Para segmentar as recusas pelo que a OS é. Quatro tipos, e Mudança de
# endereço SEPARADA de Instalação: em 30 dias (25/10 a 24/11/2026) ela teve
# 37% de recusa em 381 OS, a maior entre as grandes — dentro de Instalação
# (29,5% em 611 da PF) ela sumiria. As 15 finalidades de cliente do período:
#
#   Instalação  — Instalação - Fibra - PF/PJ, Instalação Condomínio
#   Mudança     — Mudança Endereço Fibra
#   Suporte     — Suporte Fibra, Suporte Condomínio, Suporte,
#                 Configuração de Roteador Externo
#   Serviços    — Venda Produto Externo, Cabeamento/Segundo Ponto,
#                 Cabeamento Fibra, Troca de Equipamentos (de Local),
#                 Entrega CHIP Unetvale 5G, Fiscalização - Operacional
#
# Finalidade nova cai em Serviços — a lista de finalidades mora no WVSA e
# muda sem aviso; a tela mostra a finalidade crua ao lado do tipo, e quem
# estranhar acerta aqui. Uma definição só: a tela recebe o tipo pronto.
TIPOS_OS = [
    {"id": "instalacao", "rotulo": "Instalação"},
    {"id": "mudanca", "rotulo": "Mudança de endereço"},
    {"id": "suporte", "rotulo": "Suporte"},
    {"id": "servicos", "rotulo": "Serviços"},
]


def tipo_os(finalidade):
    f = _norma(finalidade)
    if "instalacao" in f:
        return "instalacao"
    if "mudanca" in f and "endereco" in f:
        return "mudanca"
    if f.startswith("suporte") or "configuracao de roteador" in f:
        return "suporte"
    return "servicos"


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
    # Pedido de 25/11/2026: o time de Relacionamento (contato com o cliente,
    # confirmação e retenção) responde por parte das recusas e dos desvios
    # de agenda, e caía em "Agendamento" ou "Comercial" por falta de opção.
    {"id": "relacionamento", "rotulo": "Relacionamento"},
]

STATUS = ("resolvido", "pendente")


def catalogo():
    return {"momentos": MOMENTOS, "tipos": TIPOS, "causas": CAUSAS,
            "responsaveis": RESPONSAVEIS, "tipos_os": TIPOS_OS}


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
                # [d, e, t, ti, f, su, rj, ta, mo?, os?, hora?, ficha?] —
                # número e hora só na não concluída recente; `ficha` só
                # quando a ficha da OS discorda do relatório
                # (coletor/ficha_recusa.py).
                yield (dias[l[0]], emp[l[1]], tec[l[2]], fin[l[4]], l[5],
                       mot[l[8]] if len(l) > 8 else None, l[7],
                       l[9] if len(l) > 9 else None, l[10] if len(l) > 10 else None,
                       l[11] if len(l) > 11 else None)
        return row.get("atualizado_em"), iterar()
    antigo = dados.get_modulo("produtividade") or {}
    regs = (antigo.get("payload") or {}).get("registros") or []
    mot = (antigo.get("payload") or {}).get("mot") or []
    return antigo.get("atualizado_em"), (
        (r.get("d"), r.get("e"), r.get("t"), r.get("f"), r.get("su"),
         mot[r["mo"]] if isinstance(r.get("mo"), int) and r["mo"] < len(mot) else r.get("mo"),
         r.get("ta"), None, None, None)
        for r in regs)


_FICHA = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
MIN_NOTA_REL = 10


def _minutos(hhmm):
    try:
        return int(hhmm[:2]) * 60 + int(hhmm[3:5])
    except (TypeError, ValueError):
        return 0


def _pela_ficha(d, su, hora, ficha):
    """(dia, hora, hora_rel, dia_rel) da OS, com a FICHA quando ela discorda.

    A recusa vai para o dia e a hora da ficha quando ela discorda do
    relatório: a #601017 foi recusada às 22:36 de 23/11 e o relatório a
    carimbou 00:24 de 24/11 — ela sumia da lista do dia em que aconteceu. O
    relatório fica ao lado (`hora_rel`) para quem for conferir contra a
    Produtividade, que segue com ele. A nota só aparece quando a diferença
    CONTA (outro dia ou 10+ min): em 8 dias, 78 das 80 divergências eram de
    1 a 5 min. Uma função só: a War Room e a visão por supervisor da
    Produtividade põem a recusa no mesmo dia.
    """
    hora_rel = dia_rel = None
    if not su and isinstance(ficha, str) and _FICHA.fullmatch(ficha):
        if d and hora and (ficha[:10] != d or _minutos(hora) - _minutos(ficha[11:16]) >= MIN_NOTA_REL):
            hora_rel = f"{d[8:10]}/{d[5:7]} {hora}" if ficha[:10] != d else hora
        if ficha[:10] != d:
            dia_rel = d
        d, hora = ficha[:10], ficha[11:16]
    return d, hora, hora_rel, dia_rel


def _produtividade(dia_foco):
    """Contagens por dia civil, a régua por dia da semana, os técnicos e as
    encerradas sem sucesso do dia em foco — numa passada pelas OS."""
    atualizado_em, linhas = _ler_produtividade()
    corte_tec = (hoje() - timedelta(days=DIAS_TECNICOS)).isoformat()
    base_de, base_ate = BASE_DE.isoformat(), BASE_ATE.isoformat()
    foco = dia_foco.isoformat()
    por_dia = defaultdict(lambda: [0, 0])          # dia -> [sucesso, sem sucesso]
    # dia -> tipo -> [sucesso, sem sucesso]: o gráfico recorta executadas e
    # recusas pelo tipo escolhido no cross-filter, e o bloco de tipos tira a
    # taxa de recusa (recusas ÷ OS do tipo no dia).
    por_tipo = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    tecnicos = {}                                    # nome -> (dia mais recente, empresa)
    sem_sucesso = []
    desde = _desde_grafico()
    corte_perfil = (hoje() - timedelta(days=DIAS_PERFIL)).isoformat()
    em_campo = defaultdict(set)                      # dia -> técnicos com OS de cliente
    # Técnico -> [sucesso, sem sucesso, empresa] no dia em foco: é o que a
    # capacidade POR SUPERVISOR atribui a cada um (`_capacidades`).
    tec_foco = {}
    perfil = defaultdict(lambda: [0, 0, 0, 0])       # técnico -> [ext 30d, int 30d, ext, int]
    # (empresa, técnico) -> [OS de cliente, último dia] nos últimos
    # DIAS_NOVO dias: de onde sai o aviso de técnico sem responsável.
    corte_novo = (hoje() - timedelta(days=DIAS_NOVO)).isoformat()
    recentes = {}
    for d, e, t, f, su, mo, ta, os_n, hora, ficha in linhas:
        d, hora, hora_rel, dia_rel = _pela_ficha(d, su, hora, ficha)
        if not d or d < base_de or not eh_cliente(f):
            continue
        if d >= corte_novo and t and t != "—" and e and e != "—":
            r = recentes.setdefault((e, t), [0, d])
            r[0] += 1
            r[1] = max(r[1], d)
        por_dia[d][0 if su else 1] += 1
        tipo = tipo_os(f)
        por_tipo[d][tipo][0 if su else 1] += 1
        if t and t != "—":
            if d >= desde or d == foco:
                em_campo[d].add(t)
            if d == foco:
                tf = tec_foco.setdefault(t, [0, 0, e if e and e != "—" else ""])
                tf[0 if su else 1] += 1
            pf = perfil[t]
            pf[2 if ta else 3] += 1
            if d >= corte_perfil:
                pf[0 if ta else 1] += 1
        if d >= corte_tec and t and t != "—":
            if t not in tecnicos or d >= tecnicos[t][0]:
                tecnicos[t] = (d, e if e and e != "—" else "")
        if d == foco and not su:
            motivo = mo or "Não informado"
            sem_sucesso.append({"tecnico": t, "empresa": e, "finalidade": f, "tipo": tipo, "motivo": motivo,
                                "os": str(os_n) if os_n else None, "hora": hora,
                                "hora_rel": hora_rel, "dia_rel": dia_rel, "causa": causa_do_motivo(motivo)})
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
    return {
        "atualizado_em": atualizado_em,
        "por_dia": {d: v for d, v in por_dia.items() if d >= _desde_grafico() or d == foco},
        "por_tipo": {d: dict(v) for d, v in por_tipo.items() if d >= _desde_grafico() or d == foco},
        "base": base,
        "tecnicos": sorted(([nome, emp] for nome, (_, emp) in tecnicos.items()),
                           key=lambda x: _norma(x[0])),
        # Em ordem ao longo do dia, que é como a mesa lê a lista. A hora é a
        # da ficha quando o coletor a conferiu e ela discordou; senão, a do
        # relatório (52 de 63 iguais à ficha em 23/11/2026, as outras 1–5
        # min depois). Sem hora (coleta antiga) vai para o fim.
        "sem_sucesso": sorted(sem_sucesso, key=lambda x: (x["hora"] is None, x["hora"] or "",
                                                          _norma(x["tecnico"]))),
        # Consumidos por `_capacidades` (precisam do cadastro) e retirados
        # do pacote antes de ir para a tela.
        "_em_campo": em_campo,
        "_perfil": perfil,
        "_tec_foco": tec_foco,
        "_recentes": recentes,
    }


def _capacidades(prod, cadastro, dia_foco, alcance=(), nomes=None, pres=None):
    """Capacidade instalada e em campo por dia, com o cadastro de cada dia.

    `cadastro` = (técnicos atuais, histórico), ou (None, []) sem a
    migration 0023 — aí a instalada some e a em campo volta ao palpite,
    que é o comportamento de antes.

    Em campo: [capacidade, externos, internos, fora do cadastro]. "Fora" é
    quem fechou OS de cliente e não casou com o cadastro; ele entra pela
    regra antiga, e a tela diz quantos são.

    `pres` = correções do supervisor ({dia: {chave: linha}}, migration
    0024): "esteve em campo" põe o técnico na conta mesmo sem OS fechada,
    "não esteve" tira quem fechou. Valem no número do topo, no gráfico e na
    linha do supervisor — um número só para "em campo".
    """
    atuais, eventos = cadastro
    em_campo, perfil = prod.pop("_em_campo"), prod.pop("_perfil")
    tec_foco = prod.pop("_tec_foco")
    foco = dia_foco.isoformat()
    auto_foco = {equipe.chave(t): t for t in em_campo.get(foco, ())}
    nomes_cad = {t["chave"]: t.get("nome_wvsa") or t["nome"] for t in atuais or []}
    for d, mapa in (pres or {}).items():
        cur = {equipe.chave(t): t for t in em_campo.get(d, ())}
        for k, p in mapa.items():
            if p["presente"]:
                cur.setdefault(k, nomes_cad.get(k) or p["tecnico"])
            else:
                cur.pop(k, None)
        em_campo[d] = set(cur.values())
    inicio = date.fromisoformat(_desde_grafico())
    fim = max(hoje(), dia_foco)
    dias = [(inicio + timedelta(days=i)).isoformat() for i in range((fim - inicio).days + 1)]
    if foco not in dias:
        dias.append(foco)
    instalada = equipe.instalada_por_dia(dias, atuais, eventos)
    capacidade, fora_foco = {}, []
    for d, tecs in em_campo.items():
        idx = equipe.indice(equipe.equipe_em(date.fromisoformat(d), atuais, eventos)) if atuais else {}
        ext = inte = fora = 0
        for t in tecs:
            cad = idx.get(equipe.chave(t))
            if cad is not None:
                interno = bool(cad.get("interno"))
            else:
                interno = not _faz_externa(perfil[t])
                fora += 1
                if d == foco:
                    fora_foco.append(t)
            inte += interno
            ext += not interno
        capacidade[d] = [ext * CAP_EXTERNA + inte * CAP_INTERNA, ext, inte, fora]
    prod["capacidade"] = capacidade
    prod["instalada"] = instalada
    prod["por_supervisor"] = _por_supervisor(dia_foco, atuais, eventos, em_campo, auto_foco,
                                             (pres or {}).get(foco, {}), perfil, tec_foco,
                                             alcance, nomes or {})
    prod["fora_cadastro"] = sorted(fora_foco, key=_norma)
    prod["tem_cadastro"] = atuais is not None
    prod["tem_presenca"] = pres is not None


def _presencas(de, ate):
    """{dia ISO: {chave: linha}} — a correção mais NOVA de cada técnico em
    cada dia. A tabela é append-only (migration 0024): "voltar ao
    automático" é uma linha com `presente` nulo, que aqui some do mapa.
    None = a migration ainda não subiu."""
    try:
        linhas = _paginado("warroom_presenca", {
            "select": "id,dia,tecnico_chave,tecnico,presente,motivo,usuario_id,em",
            "dia": f"gte.{de}", "and": f"(dia.lte.{ate})", "order": "em.asc,id.asc"})
    except Exception as e:
        if supa.tabela_faltando(e):
            return None
        raise
    ultima = defaultdict(dict)
    for l in linhas:
        ultima[l["dia"]][l["tecnico_chave"]] = l
    return {d: {k: v for k, v in m.items() if v["presente"] is not None} for d, m in ultima.items()}


def _por_supervisor(dia_foco, atuais, eventos, em_campo, auto_foco, pres_foco, perfil, tec_foco,
                    alcance, nomes):
    """A capacidade do dia em foco quebrada por supervisor (pedido de
    24/11/2026), com a LISTA de técnicos de cada um (pedido de 25/11/2026).

    De quem é cada técnico: o VÍNCULO de Configurações
    (`supervisores.responsaveis`) — a mesma regra da Produtividade, do IQI e
    das encerradas. Até 25/11/2026 a capacidade usava o supervisor do
    cadastro da Equipe; com o supervisor mexendo no próprio time, duas
    fontes divergiriam sem a tela dizer. Pelo vínculo um técnico pode ter
    dois supervisores: conta para os dois, e a soma das linhas passa do
    total da operação — a tela diz isso.

    Linha: {id, nome, tecnicos, total: [cap, ext, int], campo: [cap, n],
    exec, rec, tecs}. Quem não tem supervisor vai na linha `id: None`.
    `tecs`: um por técnico — considerado em campo (`c`), se fechou OS
    (`auto`) e a correção do supervisor (`p`), para a tela listar e corrigir.
    """
    foco = dia_foco.isoformat()
    eq_dia = equipe.equipe_em(dia_foco, atuais, eventos) if atuais else []
    idx = equipe.indice(eq_dia)
    linhas = {a["id"]: {"id": a["id"], "nome": nomes.get(a["id"], "—"), "_tot": [], "_campo": [],
                        "_tecs": {}, "exec": 0, "rec": 0} for a in alcance}
    linhas[None] = {"id": None, "nome": "Sem supervisor", "_tot": [], "_campo": [], "_tecs": {},
                    "exec": 0, "rec": 0}

    def donos(nome, empresa):
        return [i for i in sup.responsaveis(alcance, empresa, nome) if i in linhas] or [None]

    # Por chave: o WVSA não é consistente na grafia ("GABRIEL ANDRE
    # FELICIANO" sob RETIRADA, "Gabriel André Feliciano" no cadastro).
    os_foco = {}
    for nome, (suc, rec, emp) in tec_foco.items():
        o = os_foco.setdefault(equipe.chave(nome), [0, 0, emp, nome])
        o[0] += suc
        o[1] += rec
    campo_foco = {equipe.chave(n): n for n in em_campo.get(foco, ())}

    def correcao(k):
        p = pres_foco.get(k)
        if not p:
            return None
        return {"presente": p["presente"], "por": nomes.get(p["usuario_id"], "—"),
                "hora": _hora_local(p["em"]), "motivo": p.get("motivo")}

    def ficha(k, nome, empresa, interno, cad):
        suc, rec = (os_foco.get(k) or [0, 0])[:2]
        return {"k": k, "n": nome, "e": empresa, "i": bool(interno), "cad": cad,
                "auto": k in auto_foco, "c": k in campo_foco, "x": suc, "r": rec, "p": correcao(k)}

    for t in eq_dia:
        if equipe.entra_na_war_room(t):
            k = t["chave"]
            for s_id in donos(t.get("nome_wvsa") or t["nome"], t["empresa"]):
                linhas[s_id]["_tot"].append(t)
                linhas[s_id]["_tecs"][k] = ficha(k, t["nome"], t["empresa"], t.get("interno"), True)
    for k, nome in campo_foco.items():
        emp = (os_foco.get(k) or [0, 0, ""])[2]
        cad = idx.get(k)
        interno = bool(cad.get("interno")) if cad is not None else not _faz_externa(perfil[nome])
        if cad is not None:
            emp = cad["empresa"]
        for s_id in donos(nome, emp):
            linhas[s_id]["_campo"].append(interno)
            if k not in linhas[s_id]["_tecs"]:
                linhas[s_id]["_tecs"][k] = ficha(k, cad["nome"] if cad else nome, emp, interno, cad is not None)
    # Executadas e recusas contam TODA OS de cliente do time no dia, inclusive
    # de quem o supervisor marcou como "não esteve em campo": a OS existiu.
    for k, (suc, rec, emp, nome) in os_foco.items():
        cad = idx.get(k)
        for s_id in donos((cad.get("nome_wvsa") or cad["nome"]) if cad else nome,
                            cad["empresa"] if cad else emp):
            linhas[s_id]["exec"] += suc
            linhas[s_id]["rec"] += rec
            if k not in linhas[s_id]["_tecs"]:
                interno = bool(cad.get("interno")) if cad else not _faz_externa(perfil[nome])
                linhas[s_id]["_tecs"][k] = ficha(k, cad["nome"] if cad else nome,
                                                 cad["empresa"] if cad else emp, interno, cad is not None)
    saida = []
    for l in linhas.values():
        tot, campo, tecs = l.pop("_tot"), l.pop("_campo"), l.pop("_tecs")
        if not tot and not campo:
            continue          # supervisor sem ninguém na War Room (o de infra)
        l["tecnicos"] = len(tot)
        l["total"] = equipe.somar(tot)
        l["campo"] = [sum(CAP_INTERNA if i else CAP_EXTERNA for i in campo), len(campo)]
        l["tecs"] = sorted(tecs.values(), key=lambda x: (not x["c"], _norma(x["n"])))
        saida.append(l)
    return sorted(saida, key=lambda l: (l["id"] is None, _norma(l["nome"])))


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
        lambda: supa.select_one("esteira_coleta", {"id": "eq.1", "select": "*"}),   # ver `versao`
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
        "saidas_em": (coleta or {}).get("saidas_em"),
        # Saídas de cliente por dia — o "M" da linha da triagem ("N das M OS
        # que saíram da fila…"), com a mesma régua das entradas.
        "saidas": {d: _soma_cliente(((v.get("sai") or {}).get("fin")))
                   for d, v in fluxo.items() if d >= _desde_grafico() or d == dia_foco.isoformat()},
        "entradas": {d: q for d, q in entradas.items() if d >= _desde_grafico() or d == dia_foco.isoformat()},
        "lacuna": lacuna,
        "base": {w: round(soma[w] / n[w]) for w in n},
        "backlog": {f["dia"]: [_soma_cliente(f.get("abertas_fin")), _soma_cliente(f.get("nag_fin"))]
                    for f in fotos},
    }


# ---------------------------------------------------------------------
# Triagem da esteira: OS DEVOLVIDAS ao dono antes de ir a campo (0025)
# ---------------------------------------------------------------------
# Desde 25/11/2026 o Renan abre cada OS da esteira e devolve ao dono
# ("Rejeitando OS para o dono") o que não deve ir a campo — 86 num dia. A OS
# devolvida SAI da fila, e o backlog cai sem que nada na tela diga por quê:
# "backlog −100" se lê como "o time agendou". O coletor da esteira lê a
# ficha de cada OS que sai e grava o motivo em `esteira_saidas`.
#
# ⚠️ A palavra é DEVOLVIDA, nunca "rejeitada" nem "recusa". Na War Room
# "recusa" é o técnico encerrando sem sucesso, e "Rejeitada" do WVSA é a
# validação do fechamento (Produtividade). Três coisas diferentes na mesma
# página; uma palavra só para cada.
#
# A tela é DISCRETA de propósito (decisão de 25/11/2026): uma linha sob o
# backlog e um cartão recolhido. Nenhum número novo no topo — a mesa lê
# executadas, recusas, entradas e backlog, e a triagem não é trabalho dela.
DESTINOS = ["N1", "Comercial", "Relacionamento", "Suporte", "Infra"]
SITUACOES = [
    {"id": "aguardando", "rotulo": "Aguardando o consultor"},
    {"id": "voltou_esteira", "rotulo": "Voltou para a esteira"},
    {"id": "agendada", "rotulo": "Agendada de novo"},
    {"id": "cancelada", "rotulo": "Fechada / cancelada"},
]
MOTIVOS_SAIDA = ("devolvida", "agendada", "fechada", "outro")

# Motivo da devolução pelo comentário de quem devolveu — PALPITE, e a tela
# diz isso. Mora aqui, e não no coletor, para que ajustar a regra não exija
# recoletar: o comentário inteiro está gravado. A ordem importa (o primeiro
# que casar): "cliente informou em CHAT que a conexão RETORNOU" é conexão,
# não resolvido por chat. As regras vêm do documento do Renan (passo 4) e
# dos comentários de 25/11/2026: o texto padrão dele ("OS aberta em X, Por
# gentileza, entrar em contato com o cliente para confirmar se ainda possui
# interesse…") foi 80 de 97.
MOTIVO_DEVOLUCAO = [
    ("interesse", [r"ainda (possui|tem) interesse", r"confirmar se ainda", r"tem interesse ainda",
                   r"validar (se|com) o cliente"]),
    ("conexao_ok", [r"normaliz", r"conexao (retornou|voltou)", r"sinal (voltou|retornou)",
                    r"nao (precisa|ha) mais", r"esta funcionando"]),
    ("remoto", [r"resolvid\w* (por|via|em) (ligacao|chat|telefone)", r"resolvido remot"]),
    ("tentativas", [r"(tres|3) ou mais tentativas", r"\b[23]x no local", r"tentativas sem sucesso"]),
    ("duplicada", [r"duplicad", r"foi aberto (a |uma )?os", r"consta atendimento", r"ja (possui|tem) os"]),
    ("incorreta", [r"incorret", r"abertura errada"]),
    # antes de "outro setor": o texto do fechamento do técnico costuma citar
    # a infra ("…será necessário o pessoal da infra"), e o fato é a visita
    ("apos_visita", [r"fechada sem sucesso pelo tecnico"]),
    ("outro_setor", [r"\bn2\b", r"\binfra\b", r"rocket"]),
    ("reagendar", [r"reagend", r"vai entrar em contato", r"retorno do cliente"]),
    ("sem_contato", [r"sem contato", r"nao localizad", r"nao atende", r"tentativas? de contato"]),
]
MOTIVO_DEVOLUCAO_ROTULO = {
    "interesse": "Confirmar interesse do cliente (OS antiga)",
    "conexao_ok": "Conexão restabelecida / cliente OK",
    "remoto": "Resolvido remotamente",
    "tentativas": "Várias idas sem sucesso",
    "duplicada": "OS duplicada / atendida em outra",
    "incorreta": "OS aberta incorretamente",
    "outro_setor": "Encaminhada a outro setor (N2/Infra)",
    "reagendar": "Aguardando o cliente reagendar",
    "sem_contato": "Cliente sem contato",
    "apos_visita": "Depois de visita sem sucesso",
    "outro": "Outro",
}
_MOTIVO_DEV_RE = [(m, [re.compile(p) for p in ps]) for m, ps in MOTIVO_DEVOLUCAO]


def motivo_devolucao(comentario):
    t = _norma(comentario)
    return next((m for m, rs in _MOTIVO_DEV_RE if any(r.search(t) for r in rs)), "outro")


def _triagem(dia_foco, ate):
    """Saídas da esteira por motivo, por dia, e o detalhe das devolvidas.

    Duas leituras em SÉRIE (está dentro do paralelo do `pacote` — §4,
    Esteira): as contagens, leves, desde o começo do gráfico; e as devolvidas
    do dia em foco com o comentário. Sem a migration 0025, None: a tela some
    com a linha e o cartão, sem dizer nada à mesa.
    """
    try:
        linhas = _paginado("esteira_saidas", {
            "select": "dia_operacional,finalidade,motivo,destino,situacao,apos_lacuna",
            "dia_operacional": f"gte.{_desde_grafico()}",
            "and": f"(dia_operacional.lte.{ate.isoformat()})",
            "order": "dia_operacional.asc,os.asc,saiu_em.asc"})
    except Exception as e:
        if supa.tabela_faltando(e):
            return None
        raise
    det = _paginado("esteira_saidas", {
        "select": "os,saiu_em,finalidade,destino,devolvida_em,devolvida_por,comentario,situacao,agendada_para",
        "dia_operacional": f"eq.{dia_foco.isoformat()}", "motivo": "eq.devolvida", "apos_lacuna": "eq.false",
        "order": "devolvida_em.asc.nullslast,os.asc"})

    por_dia, lacuna = {}, Counter()
    desde = {"total": 0, "destino": Counter(), "situacao": Counter()}
    for l in linhas:
        if not eh_cliente(l["finalidade"]) or l["motivo"] not in MOTIVOS_SAIDA:
            continue
        d = l["dia_operacional"]
        # A régua do fluxo (0020): saída notada depois de uma lacuna de coleta
        # não entra no dia. Contada à parte, para a conferência dizer.
        if l.get("apos_lacuna"):
            lacuna[d] += 1
            continue
        por_dia.setdefault(d, [0, 0, 0, 0])[MOTIVOS_SAIDA.index(l["motivo"])] += 1
        if l["motivo"] == "devolvida" and INICIO.isoformat() <= d <= dia_foco.isoformat():
            desde["total"] += 1
            desde["destino"][l["destino"] or "—"] += 1
            desde["situacao"][l["situacao"] or "aguardando"] += 1
    lista = []
    # A ordem é a da hora da devolução (o PostgREST já manda assim; ordenar
    # aqui de novo é barato e não depende do `order` sobreviver a mudanças).
    det.sort(key=lambda l: (l["devolvida_em"] or l["saiu_em"] or "", l["os"]))
    for l in det:
        if not eh_cliente(l["finalidade"]):
            continue
        lista.append({
            "os": l["os"],
            "hora": _hora_local(l["devolvida_em"] or l["saiu_em"]),
            "finalidade": l["finalidade"] or "",
            "tipo": tipo_os(l["finalidade"]),
            "destino": l["destino"],
            "por": l["devolvida_por"] or "",
            "comentario": (l["comentario"] or "")[:240],
            "motivo": motivo_devolucao(l["comentario"]),
            "situacao": l["situacao"] or "aguardando",
            "agendada_para": l["agendada_para"],
        })
    return {
        "por_dia": por_dia,
        "lacuna": dict(lacuna),
        "lista": lista,
        "desde": {"total": desde["total"], "destino": dict(desde["destino"]),
                  "situacao": dict(desde["situacao"])},
        "destinos": DESTINOS,
        "situacoes": SITUACOES,
        "motivos": MOTIVO_DEVOLUCAO_ROTULO,
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
        # `*` e não "ok_em,saidas_em": sem a migration 0025 a coluna nova não
        # existe, e pedi-la pelo nome daria 400 na pergunta que a tela faz de
        # 2 em 2 min. A linha é uma só e pequena.
        lambda: supa.select_one("esteira_coleta", {"id": "eq.1", "select": "*"}),
    )
    est = est or {}
    return f"{(prod or {}).get('atualizado_em') or ''}|{est.get('ok_em') or ''}|{est.get('saidas_em') or ''}"


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
        # A véspera e o dia seguinte também: a recusa que a ficha mudou de dia
        # (relatório 24/11 00:24 → ficha 23/11 22:27) pode ter sido respondida
        # no dia do relatório, antes de a ficha ser lida. Sem isto a resposta
        # ficava presa no dia antigo e a recusa reaparecia "sem resposta" —
        # a #602668, respondida por Guilherme às 09:22 de 24/11.
        try:
            return supa.select("warroom_validacoes", {
                "select": "dia,os,validado,usuario_id,em",
                "dia": f"gte.{(dia_foco - timedelta(days=1)).isoformat()}",
                "and": f"(dia.lte.{(dia_foco + timedelta(days=1)).isoformat()})"})
        except Exception as e:
            if supa.tabela_faltando(e):
                return None
            raise

    def cadastro():
        # Em SÉRIE, dentro do paralelo de cima (paralelo aninhado no mesmo
        # pool pode prender as threads — §4, Esteira). Sem a migration 0023,
        # `listar` devolve None e o histórico nem é pedido.
        atuais = equipe.listar()
        return atuais, (equipe.historico() if atuais is not None else [])

    def decididos():
        # Técnicos que o aviso de "sem responsável" já resolveu (0024). None
        # = sem a migration: o aviso não aparece, porque não haveria onde
        # gravar a resposta.
        try:
            return {l["tecnico"] for l in _paginado("tecnico_responsavel", {"select": "tecnico"})}
        except Exception as e:
            if supa.tabela_faltando(e):
                return None
            raise

    prod, est, (lista, tem_tabela), rod, nomes, alcance, vals, cad, pres, dec, tri = supa.paralelo(
        lambda: _produtividade(dia_foco), lambda: _esteira(dia_foco),
        desvios, rodadas, _nomes, _alcance_supervisores, validacoes, cadastro,
        lambda: _presencas(_desde_grafico(), max(hoje(), dia_foco).isoformat()), decididos,
        lambda: _triagem(dia_foco, max(hoje(), dia_foco)))
    _capacidades(prod, cad, dia_foco, alcance, nomes, pres)
    pendentes = _pendentes(prod.pop("_recentes"), alcance, dec, cad[0])
    # Cada encerrada sem sucesso leva os supervisores que respondem pelo
    # técnico: a tela filtra por supervisor sem conhecer a regra do vínculo.
    for o in prod["sem_sucesso"]:
        o["sups"] = [a["id"] for a in alcance if _no_alcance(a, o["empresa"], o["tecnico"])]
    # O mesmo para os desvios (filtro Supervisor da barra dos desvios), e o
    # mapa técnico -> supervisores para o desvio que a tela acaba de
    # registrar: ele volta do POST sem `sups`, e o JS não conhece o vínculo.
    # A chave é o NOME porque é por ele que o formulário escolhe a empresa
    # (`tecEmpresa`), então o desvio novo leva a empresa deste mapa.
    def sups_de(empresa, tecnico):
        return [a["id"] for a in alcance if tecnico and _no_alcance(a, empresa, tecnico)]
    tec_sups = {t: s for t, e in prod["tecnicos"] if (s := sups_de(e, t))}
    formatados = []
    for d in lista:
        if d["dia"] <= dia_foco.isoformat():
            f = _formatar(d, nomes)
            f["sups"] = sups_de(f["empresa"], f["tecnico"])
            formatados.append(f)
    return {
        # A MESMA string de `versao()`: a tela compara as duas para saber se
        # relê o pacote, e uma diferença de formato a faria reler para sempre.
        "versao": f"{prod['atualizado_em'] or ''}|{est['atualizado_em'] or ''}|{est.pop('saidas_em') or ''}",
        "dia": dia_foco.isoformat(),
        "hoje": hoje().isoformat(),
        "inicio": INICIO.isoformat(),
        "base_de": BASE_DE.isoformat(),
        "base_ate": BASE_ATE.isoformat(),
        "produtividade": {**prod, "atualizado": _data_hora_local(prod["atualizado_em"])},
        "esteira": {**est, "atualizado": _data_hora_local(est["atualizado_em"])},
        "catalogo": catalogo(),
        "tem_tabela": tem_tabela,
        "desvios": formatados,
        "tec_sups": tec_sups,
        "rodadas": [{"momento": r["momento"], "usuario_id": r["usuario_id"],
                     "nome": nomes.get(r["usuario_id"], "—"), "hora": _hora_local(r["feito_em"])}
                    for r in rod],
        "supervisores": [{"id": a["id"], "nome": nomes.get(a["id"], "—")} for a in alcance],
        # None = a migration 0022 ainda não subiu; {} = ninguém validou nada.
        "validacoes": None if vals is None else _validacoes_do_dia(vals, prod["sem_sucesso"], dia_foco, nomes),
        "wvsa_os": WVSA_OS,
        # None = sem a migration 0024 (o aviso não aparece); [] = todos têm
        # responsável.
        "sem_responsavel": pendentes,
        "cap_externa": CAP_EXTERNA,
        "cap_interna": CAP_INTERNA,
        # None = sem a migration 0025: a linha sob o backlog e o cartão somem.
        "triagem": tri,
    }


def _pendentes(recentes, alcance, decididos, atuais=None):
    """Técnicos que fecharam OS de cliente nos últimos DIAS_NOVO dias e não
    têm supervisor (pedido de 25/11/2026).

    Técnico novo de empresa terceira já cai no supervisor da empresa
    (vínculo por equipe) e não aparece aqui; o da UNETVALE, repartida nome a
    nome, aparece até alguém responder. Infra fica fora (a War Room não a
    conta), e quem já foi respondido também — inclusive como "não é técnico
    de campo". Sem a migration 0024 devolve None.
    """
    if decididos is None:
        return None
    no_cadastro = {t["chave"] for t in atuais or [] if t.get("ativo")}
    saida = []
    for (e, t), (n, ultimo) in recentes.items():
        if sup.eh_infra(e) or sup.responsaveis(alcance, e, t):
            continue
        rotulo = f"{e} - {t}"
        if sup.chave_tecnico(rotulo) in decididos:
            continue
        saida.append({"rotulo": rotulo, "empresa": e, "nome": t, "os": n, "ultimo": ultimo,
                      "cadastro": equipe.chave(t) in no_cadastro})
    return sorted(saida, key=lambda x: (-x["os"], _norma(x["nome"])))


DIAS_TIME = 60             # Configurações: técnico que não fechou OS em 60 dias sai da lista


def tecnicos_recentes(dias=DIAS_TIME):
    """{(empresa, técnico): [OS, OS de cliente, último dia]} nos últimos
    `dias`, lendo a Produtividade compacta (com cache por carimbo)."""
    corte = (hoje() - timedelta(days=dias)).isoformat()
    out = {}
    _, linhas = _ler_produtividade()
    for d, e, t, f, su, mo, ta, os_n, hora, ficha in linhas:
        d = _pela_ficha(d, su, hora, ficha)[0]
        if d and d >= corte and t and t != "—" and e and e != "—":
            o = out.setdefault((e, t), [0, 0, d])
            o[0] += 1
            o[1] += eh_cliente(f)
            o[2] = max(o[2], d)
    return out


def empresas_conhecidas():
    """Empresas que aparecem na Produtividade, pela leitura compacta (com
    cache por carimbo). `supervisores.equipes_disponiveis` dá o mesmo
    conjunto expandindo as 57 mil OS em dicionários — ~1 s a mais em toda
    abertura de Configurações de supervisor."""
    _, linhas = _ler_produtividade()
    return sorted({e for _, e, *_ in linhas if e and e != "—"})


def _decididos():
    try:
        return {l["tecnico"] for l in _paginado("tecnico_responsavel", {"select": "tecnico"})}
    except Exception as e:
        if supa.tabela_faltando(e):
            return None
        raise


def time_do_supervisor(uid, alcance=None):
    """O time de um supervisor para a tela de Configurações (pedido de
    25/11/2026: "igual o da gestão", com a lista de técnicos).

    Técnicos conhecidos = quem fechou OS nos últimos DIAS_TIME dias, mais o
    cadastro ativo da Equipe, mais os vinculados nome a nome (mesmo os que
    pararam de aparecer: o vínculo existe e precisa poder ser removido).
    Cada um sai com quem responde por ele hoje e por onde (equipe inteira ou
    nome a nome) — é o que a tela mostra para o supervisor não tirar ou
    pegar alguém às cegas.
    """
    alcance = alcance if alcance is not None else sup.alcance_serie()
    meu = next((a for a in alcance if a["id"] == uid), {"id": uid, "equipes": set(), "tecnicos": set()})
    rec, atuais, avulsos, nomes, dec = supa.paralelo(
        tecnicos_recentes, equipe.listar,
        lambda: supa.select("supervisor_tecnicos", {"select": "usuario_id,tecnico,rotulo"}),
        _nomes, _decididos)
    conhecidos = {}

    def juntar(rotulo, os_n=0, cliente=0, ultimo=None):
        k = sup.chave_tecnico(rotulo)
        c = conhecidos.setdefault(k, {"chave": k, "rotulo": rotulo, "empresa": sup.empresa_de(rotulo),
                                      "nome": rotulo.split(" - ", 1)[-1], "os": 0, "cliente": 0,
                                      "ultimo": None, "cadastro": False})
        c["os"] += os_n
        c["cliente"] += cliente
        if ultimo and (not c["ultimo"] or ultimo > c["ultimo"]):
            c["ultimo"] = ultimo
        return c

    for (e, t), (n, nc, ult) in rec.items():
        juntar(f"{e} - {t}", n, nc, ult)
    for t in atuais or []:
        if t.get("ativo"):
            juntar(f"{t['empresa']} - {t.get('nome_wvsa') or t['nome']}")["cadastro"] = True
    for a in avulsos:
        juntar(a["rotulo"])
    meus, outros = [], []
    for k, c in conhecidos.items():
        donos = sup.responsaveis(alcance, c["empresa"], c["nome"])
        c["outros"] = [nomes.get(i, "—") for i in donos if i != uid]
        c["pela_equipe"] = c["empresa"] in meu["equipes"]
        c["nome_a_nome"] = k in meu["tecnicos"]
        c["infra"] = sup.eh_infra(c["empresa"])
        (meus if uid in donos else outros).append(c)

    def agrupar(lista):
        por = {}
        for c in sorted(lista, key=lambda c: _norma(c["nome"])):
            por.setdefault(c["empresa"] or "(sem empresa)", []).append(c)
        return dict(sorted(por.items()))

    pend = None
    if dec is not None:
        # A mesma janela e a mesma conta (OS de cliente) do aviso da War Room.
        recentes_cli = {k: [v[1], v[2]] for k, v in tecnicos_recentes(DIAS_NOVO).items() if v[1]}
        pend = _pendentes(recentes_cli, alcance, dec, atuais)
    return {"meus": agrupar(meus), "n_meus": len(meus), "outros": agrupar(outros),
            "sem_responsavel": pend, "dias": DIAS_TIME}


class Conflito(Exception):
    """Outro supervisor respondeu antes; a mensagem diz quem e quando."""


def definir_responsavel(corpo, uid):
    """O primeiro supervisor que responde o aviso decide quem responde pelo
    técnico novo — para todos. A trava é do banco (`tecnico_definir_
    responsavel`, chave primária no técnico): dois cliques ao mesmo tempo
    gravam um só, e o segundo recebe quem decidiu.

    `supervisor_id` nulo = "não é técnico de campo": a pergunta não volta e
    nenhum vínculo nasce.
    """
    rotulo = re.sub(r"\s+", " ", str(corpo.get("rotulo") or "")).strip()
    if " - " not in rotulo or len(rotulo) > 160:
        raise Recusa("Técnico inválido.")
    s_id = corpo.get("supervisor_id")
    if s_id is not None:
        ids = {l["usuario_id"] for l in supa.select("supervisores", {"select": "usuario_id"})}
        if s_id not in ids:
            raise Recusa("Supervisor desconhecido.")
    # O técnico tem de existir na Produtividade: o rótulo vira vínculo, e um
    # nome digitado à mão criaria um vínculo que não casa com ninguém.
    chave = sup.chave_tecnico(rotulo)
    empresa = sup.empresa_de(rotulo)
    _, linhas = _ler_produtividade()
    if not any((e or "").strip().upper() in (empresa, rotulo.split(" - ", 1)[0].strip().upper())
               and sup.chave_tecnico(f"{e} - {t}") == chave for _, e, t, *_ in linhas):
        raise Recusa("Esse técnico não aparece na Produtividade.")
    r = supa.rpc("tecnico_definir_responsavel", {
        "p_tecnico": chave, "p_rotulo": rotulo, "p_supervisor": s_id, "p_por": uid}) or {}
    if r.get("ok"):
        return {"ok": True}
    nomes = _nomes()
    quem = nomes.get(r.get("definido_por"), "outra pessoa")
    para = nomes.get(r.get("supervisor_id")) if r.get("supervisor_id") else "não é técnico de campo"
    raise Conflito(f"{quem} já respondeu às {_hora_local(r.get('definido_em')) or '—'}: {para}.")


def marcar_presenca(corpo, uid):
    """O supervisor corrige se o técnico esteve em campo no dia.

    `presente` true/false grava a correção; null volta ao automático (ter
    fechado OS de cliente). Cada clique é uma linha nova (append-only): a
    mais nova vale, e o histórico fica.
    """
    d = dia_valido(corpo.get("dia"))
    if d < hoje() - timedelta(days=DIAS_RETROATIVO):
        raise Recusa(f"Só dá para corrigir os últimos {DIAS_RETROATIVO} dias.")
    k = str(corpo.get("tecnico") or "").strip()
    if not k or len(k) > 120:
        raise Recusa("Técnico inválido.")
    presente = corpo.get("presente")
    if presente not in (True, False, None):
        raise Recusa("Resposta inválida.")
    motivo = _texto(corpo.get("motivo"), 300, "o motivo")
    # O nome sai do servidor: do cadastro, ou de quem fechou OS de cliente
    # naquele dia. Chave que não casa com ninguém é recusada.
    nome = next(((t.get("nome_wvsa") or t["nome"]) for t in equipe.listar() or [] if t["chave"] == k), None)
    if nome is None:
        _, linhas = _ler_produtividade()
        iso = d.isoformat()
        for dd, e, t, f, su, mo, ta, os_n, hora, ficha in linhas:
            if t and _pela_ficha(dd, su, hora, ficha)[0] == iso and equipe.chave(t) == k and eh_cliente(f):
                nome = t
                break
    if nome is None:
        raise Recusa("Esse técnico não está no cadastro nem fechou OS neste dia.")
    supa.insert("warroom_presenca", {"dia": d.isoformat(), "tecnico_chave": k, "tecnico": nome[:120],
                                     "presente": presente, "motivo": motivo, "usuario_id": uid})
    return d


# Ficha da OS no WVSA — o mesmo endereço que a Esteira usa. Só abre dentro
# da rede da Unetvale, que é onde os supervisores estão.
WVSA_OS = "https://wvsa8.unetvale.com.br/os/"


def _alcance_supervisores():
    """Equipes e técnicos de cada supervisor, em SÉRIE (dentro do paralelo
    do pacote). A regra mora em `supervisores.alcance_serie`."""
    return sup.alcance_serie()


def _no_alcance(a, empresa, tecnico):
    """A mesma regra do recorte da Produtividade (`supervisores.no_alcance`)."""
    return sup.no_alcance(a, empresa, tecnico)


def _validacoes_do_dia(vals, sem_sucesso, dia_foco, nomes):
    """{os: resposta} do dia em foco. Vale a resposta gravada NESTE dia; para
    a recusa que mudou de dia pela ficha, vale também a gravada no dia do
    relatório (`dia_rel`), se não houver uma deste dia."""
    foco = dia_foco.isoformat()
    por = {(v["dia"], v["os"]): v for v in vals}
    saida = {v["os"]: _validacao(v, nomes) for v in vals if v["dia"] == foco}
    for o in sem_sucesso:
        if o.get("os") and o["os"] not in saida and o.get("dia_rel"):
            v = por.get((o["dia_rel"], o["os"]))
            if v:
                saida[o["os"]] = _validacao(v, nomes)
    return saida


def _validacao(v, nomes):
    return {"validado": v["validado"], "nome": nomes.get(v["usuario_id"], "—"),
            "usuario_id": v["usuario_id"], "hora": _hora_local(v["em"]), "dia": v.get("dia")}


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


# ---------------------------------------------------------------------
# Visão por supervisor, na Produtividade (pedido de 25/11/2026)
# ---------------------------------------------------------------------
# Capacidade total, em campo, executadas e recusas do time de cada
# supervisor num PERÍODO, e os cinco técnicos que mais pesam em três réguas:
# aproveitamento (executadas ÷ capacidade em campo), média de produtividade
# (executadas por dia em campo) e recusas — com os motivos e se a recusa
# passou pelo supervisor (`warroom_validacoes`). As MESMAS regras da War
# Room: só OS de cliente (sem retirada e sem infra), o cadastro como era em
# cada dia, a correção de presença e a recusa no dia da ficha. A diferença é
# a janela: aqui é o período, lá o dia.
#
# A capacidade só conta DIAS COM OPERAÇÃO (algum técnico fechou OS de
# cliente): domingo sem nenhuma OS não é "a equipe inteira parada", e somá-lo
# derrubaria o aproveitamento do mês sem dizer nada.
VISAO_MAX_DIAS = 93
TOP = 5
MIN_DIAS_RANKING = 2       # técnico com um dia só em campo não entra nos rankings de razão


def visao_supervisores(de, ate, permitidos=None):
    """{de, ate, dias, supervisores: [...]} — `permitidos` (ids) recorta no
    servidor: o supervisor só recebe o próprio time."""
    ate = min(ate, hoje())
    if de > ate:
        de = ate
    if (ate - de).days >= VISAO_MAX_DIAS:
        de = ate - timedelta(days=VISAO_MAX_DIAS - 1)
    de_i, ate_i = de.isoformat(), ate.isoformat()

    def validacoes():
        try:
            return _paginado("warroom_validacoes", {
                "select": "dia,os,validado",
                "dia": f"gte.{(de - timedelta(days=1)).isoformat()}",
                "and": f"(dia.lte.{(ate + timedelta(days=1)).isoformat()})"})
        except Exception as e:
            if supa.tabela_faltando(e):
                return None
            raise

    def cadastro():
        atuais = equipe.listar()
        return atuais, (equipe.historico() if atuais is not None else [])

    (_, linhas), alcance, nomes, (atuais, eventos), pres, vals = supa.paralelo(
        _ler_produtividade, sup.alcance_serie, _nomes, cadastro,
        lambda: _presencas(de_i, ate_i), validacoes)
    val_os = {}
    for v in vals or []:
        val_os[v["os"]] = v["validado"]       # o número da OS é único entre dias

    corte_perfil = (ate - timedelta(days=DIAS_PERFIL)).isoformat()
    # chave -> {nome, empresa, dias: {dia: [suc, rec]}, motivos, val: [sim, não, sem resposta, sem número]}
    tecs = {}
    perfil = defaultdict(lambda: [0, 0, 0, 0])
    dias_op = set()
    for d, e, t, f, su, mo, ta, os_n, hora, ficha in linhas:
        d = _pela_ficha(d, su, hora, ficha)[0]
        if not d or not t or t == "—" or not eh_cliente(f):
            continue
        k = equipe.chave(t)
        if d >= corte_perfil and d <= ate_i:
            perfil[k][0 if ta else 1] += 1
        if not (de_i <= d <= ate_i):
            continue
        dias_op.add(d)
        x = tecs.setdefault(k, {"nome": t, "empresa": e if e and e != "—" else "", "dias": defaultdict(lambda: [0, 0]),
                                "motivos": Counter(), "val": [0, 0, 0, 0]})
        x["dias"][d][0 if su else 1] += 1
        if not su:
            x["motivos"][mo or "Não informado"] += 1
            if not os_n:
                x["val"][3] += 1
            elif str(os_n) in val_os:
                x["val"][0 if val_os[str(os_n)] else 1] += 1
            else:
                x["val"][2] += 1

    cad_atual = {t["chave"]: t for t in atuais or []}
    por_sup = {a["id"]: {"id": a["id"], "nome": nomes.get(a["id"], "—"), "cap_total": 0, "_tecs": {}}
               for a in alcance if permitidos is None or a["id"] in permitidos}
    if not por_sup:
        return {"de": de_i, "ate": ate_i, "dias": 0, "supervisores": [],
                "tem_cadastro": atuais is not None, "tem_validacao": vals is not None}

    def donos(nome, empresa):
        return [i for i in sup.responsaveis(alcance, empresa, nome) if i in por_sup]

    def ficha_tec(s, k, nome, empresa, cad):
        return por_sup[s]["_tecs"].setdefault(k, {
            "k": k, "n": (cad or {}).get("nome") or nome, "e": empresa, "cad": cad is not None,
            "dias_campo": 0, "cap_campo": 0, "exec": 0, "rec": 0, "motivos": Counter(), "val": [0, 0, 0, 0]})

    for iso in sorted(dias_op):
        dia = date.fromisoformat(iso)
        eq_dia = equipe.equipe_em(dia, atuais, eventos) if atuais else []
        idx = equipe.indice(eq_dia)
        # A capacidade total do dia: o cadastro de então, sem retirada.
        for t in eq_dia:
            if equipe.entra_na_war_room(t):
                for s in donos(t.get("nome_wvsa") or t["nome"], t["empresa"]):
                    por_sup[s]["cap_total"] += equipe.capacidade_de(t)
                    ficha_tec(s, t["chave"], t["nome"], t["empresa"], t)
        # Em campo: quem fechou OS de cliente no dia, com a correção.
        campo = {k for k, x in tecs.items() if iso in x["dias"]}
        for k, p in (pres or {}).get(iso, {}).items():
            (campo.add if p["presente"] else campo.discard)(k)
        for k in campo:
            cad = idx.get(k) or cad_atual.get(k)
            x = tecs.get(k)
            nome = (cad.get("nome_wvsa") or cad["nome"]) if cad else (x or {}).get("nome")
            empresa = cad["empresa"] if cad else (x or {}).get("empresa", "")
            if not nome:
                continue
            cap = equipe.capacidade_de(cad) if cad else (CAP_EXTERNA if _faz_externa(perfil[k]) else CAP_INTERNA)
            for s in donos(nome, empresa):
                f = ficha_tec(s, k, nome, empresa, cad)
                f["dias_campo"] += 1
                f["cap_campo"] += cap
    # Executadas e recusas: toda OS de cliente do time, inclusive de quem a
    # correção tirou de campo — a OS existiu.
    for k, x in tecs.items():
        cad = cad_atual.get(k)
        nome = (cad.get("nome_wvsa") or cad["nome"]) if cad else x["nome"]
        empresa = cad["empresa"] if cad else x["empresa"]
        for s in donos(nome, empresa):
            f = ficha_tec(s, k, nome, empresa, cad)
            f["exec"] += sum(v[0] for v in x["dias"].values())
            f["rec"] += sum(v[1] for v in x["dias"].values())
            f["motivos"].update(x["motivos"])
            f["val"] = [a + b for a, b in zip(f["val"], x["val"])]

    # Num período de até 3 dias (o dia da War Room, por exemplo) ninguém
    # passaria do mínimo de 2 dias em campo, e os rankings de razão sairiam
    # vazios: aí basta 1 dia.
    min_dias = 1 if len(dias_op) <= 3 else MIN_DIAS_RANKING
    saida = []
    for l in por_sup.values():
        fichas = list(l.pop("_tecs").values())
        if not fichas:
            continue
        motivos, val = Counter(), [0, 0, 0, 0]
        for f in fichas:
            motivos.update(f["motivos"])
            val = [a + b for a, b in zip(val, f["val"])]
            f["ap"] = round(100 * f["exec"] / f["cap_campo"]) if f["cap_campo"] else None
            f["media"] = round(f["exec"] / f["dias_campo"], 1) if f["dias_campo"] else None
            f["motivos"] = f["motivos"].most_common(3)
        cap_campo = sum(f["cap_campo"] for f in fichas)
        exec_ = sum(f["exec"] for f in fichas)
        rec = sum(f["rec"] for f in fichas)
        com_dias = [f for f in fichas if f["dias_campo"] >= min_dias]
        l.update({
            "tecnicos": len(fichas),
            "cap_campo": cap_campo, "exec": exec_, "rec": rec,
            "aproveitamento": round(100 * exec_ / cap_campo) if cap_campo else None,
            "taxa_recusa": round(100 * rec / (exec_ + rec)) if exec_ + rec else None,
            "motivos": motivos.most_common(8),
            "validacao": val,
            "top_aproveitamento": sorted(com_dias, key=lambda f: (f["ap"], -f["dias_campo"]))[:TOP],
            "top_media": sorted(com_dias, key=lambda f: (f["media"], -f["dias_campo"]))[:TOP],
            "top_recusas": sorted((f for f in fichas if f["rec"]), key=lambda f: (-f["rec"], _norma(f["n"])))[:TOP],
            "tecs": sorted(fichas, key=lambda f: _norma(f["n"])),
        })
        saida.append(l)
    return {"de": de_i, "ate": ate_i, "dias": len(dias_op),
            "supervisores": sorted(saida, key=lambda l: _norma(l["nome"])),
            "tem_cadastro": atuais is not None, "tem_validacao": vals is not None,
            "min_dias": min_dias if por_sup else MIN_DIAS_RANKING,
            "cap_externa": CAP_EXTERNA, "cap_interna": CAP_INTERNA}
