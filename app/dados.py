"""Leitura dos snapshots dos módulos (tabela `dados_modulo`) e cálculo do
status de atualização (última / próxima / status) exibido no cabeçalho.
"""
from datetime import datetime, timedelta, timezone

from . import supa

BR_TZ = timezone(timedelta(hours=-3))
HORARIOS = [8, 10, 12, 14, 16, 18]  # grade fixa de atualização (horário de Brasília)

# Teto para considerar uma rodada "em andamento". Não é palpite: é o mesmo
# `timeout=1800` com que o watcher mata o `enviar.py`. Sem teto, um coletor
# morto no meio da rodada deixaria a tela dizendo "coletando" para sempre.
RODADA_TIMEOUT_MIN = 30

# Sem sinal há mais que isto, o coletor é dado como mudo. Folga generosa sobre
# o pulso de 2 min do watcher para que uma falha de rede passageira não vire
# alarme.
HEARTBEAT_MUDO_MIN = 10

# Carimbo impossível, para carimbo ilegível contar como "ainda não coletado".
# Usar o início da rodada como padrão faria o contrário: uma data corrompida
# seria contada como módulo já concluído.
MIN_DT = datetime.min.replace(tzinfo=timezone.utc)

# Os `ger_*` são as cinco coletas do Dashboard. Entram aqui, e não numa lista
# própria, para que o ponto verde/vermelho do cabeçalho e a tela de
# Monitoramento cubram o módulo novo pelo mesmo caminho dos antigos — uma
# coleta do Dashboard que falhe precisa aparecer no mesmo lugar.
MODULOS = ("produtividade", "iqi", "iqm", "massivas",
           "ger_categorias", "ger_cancelamentos", "ger_esteira",
           "ger_idf", "ger_salas")
NOMES = {
    "produtividade": "Produtividade", "iqi": "IQI", "iqm": "IQM",
    "massivas": "Massivas",
    "ger_categorias": "Dashboard · Causa raiz",
    "ger_cancelamentos": "Dashboard · Cancelamentos",
    "ger_esteira": "Dashboard · Esteira",
    "ger_idf": "Dashboard · IDF",
    "ger_salas": "Dashboard · Salas",
}


def _idade_texto(minutos):
    if minutos is None:
        return "—"
    if minutos < 60:
        return f"há {minutos} min"
    if minutos < 60 * 36:
        return f"há {minutos // 60} h"
    return f"há {minutos // (60 * 24)} d"


def get_modulo(modulo):
    """Retorna {payload, atualizado_em, status} do módulo, ou None se ainda não houver."""
    try:
        return supa.select_one(
            "dados_modulo",
            {"modulo": f"eq.{modulo}", "select": "modulo,payload,atualizado_em,status"},
        )
    except Exception:
        return None


def get_todos():
    """Lê todos os módulos numa única requisição -> {modulo: row}. Só metadados
    (sem o payload pesado) para o cabeçalho/home; use get_modulo p/ o payload."""
    try:
        rows = supa.select(
            "dados_modulo",
            {"select": "modulo,atualizado_em,status", "modulo": f"in.({','.join(MODULOS)})"},
        )
        return {r["modulo"]: r for r in rows}
    except Exception:
        return {}


def _parse_dt(valor):
    if not valor:
        return None
    try:
        return datetime.fromisoformat(valor.replace("Z", "+00:00"))
    except Exception:
        return None


def proxima_atualizacao(agora=None):
    """Próximo horário da grade (08–18h) em horário de Brasília."""
    agora = agora or datetime.now(BR_TZ)
    agora = agora.astimezone(BR_TZ)
    for h in HORARIOS:
        candidato = agora.replace(hour=h, minute=0, second=0, microsecond=0)
        if candidato > agora:
            return candidato
    # passou das 18h: primeiro horário do dia seguinte
    amanha = (agora + timedelta(days=1)).replace(hour=HORARIOS[0], minute=0, second=0, microsecond=0)
    return amanha


def status_geral():
    """Resumo consolidado para o cabeçalho: última atualização (mais recente entre
    os módulos), status agregado e próxima atualização prevista."""
    ultima = None
    status = "ok"
    algum = False
    todos = get_todos()
    for m in MODULOS:
        row = todos.get(m)
        if not row:
            continue
        algum = True
        dt = _parse_dt(row.get("atualizado_em"))
        if dt and (ultima is None or dt > ultima):
            ultima = dt
        if row.get("status") and row["status"] != "ok":
            status = "erro"
    prox = proxima_atualizacao()
    return {
        "tem_dados": algum,
        "ultima": ultima.astimezone(BR_TZ).strftime("%d/%m/%Y %H:%M") if ultima else "—",
        "status": status if algum else "sem_dados",
        "proxima": prox.strftime("%H:%M"),
        "horarios": HORARIOS,
    }


def resumo_modulos(rodada=None):
    """Status atual de cada módulo (para a tela de monitoramento): última
    atualização, idade e se está desatualizado (sem dado novo há > 3h).

    `rodada` é o retorno de `rodada_em_andamento()`. Ele importa porque a coleta
    é SEQUENCIAL e leva ~8 minutos: durante a rodada, quem ainda não foi
    coletado exibe o carimbo da rodada anterior. Sem essa informação, "ainda não
    chegou a vez" e "parou de atualizar" ficam idênticos na tela — foi
    exatamente assim que uma rodada normal, aberta às 09:15 de 31/08/2026,
    pareceu meia dúzia de módulos quebrados.
    """
    inicio = (rodada or {}).get("inicio")
    todos = get_todos()
    agora = datetime.now(timezone.utc)
    out = []
    for m in MODULOS:
        row = todos.get(m)
        dt = _parse_dt(row.get("atualizado_em")) if row else None
        idade = int((agora - dt).total_seconds() // 60) if dt else None
        status = (row or {}).get("status") or "sem_dados"
        desatualizado = idade is not None and idade > 180  # esperado a cada 2h (08–18h)
        # Na fila: a rodada começou e este módulo ainda não foi gravado. Não
        # está atrasado, está esperando — e por isso não leva selo de alerta.
        na_fila = bool(inicio and (dt is None or dt < inicio))
        if na_fila:
            desatualizado = False
        out.append({
            "modulo": m, "nome": NOMES.get(m, m),
            "atualizado": dt.astimezone(BR_TZ).strftime("%d/%m/%Y %H:%M") if dt else "—",
            "idade": _idade_texto(idade), "status": status,
            "desatualizado": desatualizado, "na_fila": na_fila,
        })
    return out


def rodada_em_andamento():
    """Há uma coleta acontecendo agora? E quanto dela já saiu?

    A verdade mora em `coletor_log`, na linha `geral` mais recente:
      · `pedido`  — o botão foi clicado, o watcher ainda não pegou (até 45 s);
      · `inicio`  — o `enviar.py` está rodando;
      · `ok`/`erro`/`skip` — a rodada fechou.

    Só a linha mais recente decide, por isso `limit=1`: um `inicio` de ontem
    seguido de um `ok` não pode ressuscitar como "rodando".
    """
    vazio = {"rodando": False, "inicio": None, "inicio_br": "—", "concluidos": 0,
             "total": len(MODULOS), "aguardando": False}
    try:
        row = supa.select_one("coletor_log", {
            "modulo": "eq.geral", "select": "executado_em,status",
            "order": "executado_em.desc", "limit": "1",
        })
    except Exception:
        return vazio
    if not row:
        return vazio

    dt = _parse_dt(row.get("executado_em"))
    if not dt:
        return vazio
    if datetime.now(timezone.utc) - dt > timedelta(minutes=RODADA_TIMEOUT_MIN):
        return vazio  # rodada abandonada: o watcher já teria matado o processo

    estado = row.get("status")
    if estado == "pedido":
        # Ainda não começou, mas o botão precisa continuar em "Atualizando…" —
        # senão a tela recarrega antes de a coleta sair do lugar.
        return {**vazio, "rodando": True, "aguardando": True}
    if estado != "inicio":
        return vazio

    # Conta pelos CARIMBOS, não pelas linhas de log: `coletor_log` recebe uma
    # linha por módulo do coletor, e o `iqm` não tem a sua (nasce dentro da
    # coleta do `iqi`). Contando log, o progresso pararia em 8/9 e nunca
    # fecharia. Contando carimbo, bate exatamente com os cards da tela — e sai
    # de graça, porque `get_todos()` é a mesma leitura que o resumo já faz.
    concluidos = sum(1 for r in get_todos().values()
                     if (_parse_dt(r.get("atualizado_em")) or MIN_DT) >= dt)
    return {"rodando": True, "inicio": dt,
            "inicio_br": dt.astimezone(BR_TZ).strftime("%H:%M"),
            "concluidos": concluidos, "total": len(MODULOS), "aguardando": False}


def heartbeat():
    """Sinal de vida do coletor (tabela `coletor_heartbeat`, ver migration 0011).

    Sem isto a tela só sabe dizer "Desatualizado", sem causa. Com isto ela
    separa os três casos que produzem a mesma idade: máquina desligada, máquina
    de pé mas sem rota até o WVSA, e coleta em andamento.
    """
    fora = {"vivo": False, "visto": "—", "idade": "—", "wvsa_ok": False}
    try:
        row = supa.select_one("coletor_heartbeat",
                              {"select": "visto_em,wvsa_ok", "id": "eq.1"})
    except Exception:
        return fora  # migration ainda não aplicada: some da tela em vez de quebrá-la
    if not row:
        return fora
    dt = _parse_dt(row.get("visto_em"))
    if not dt:
        return fora
    minutos = int((datetime.now(timezone.utc) - dt).total_seconds() // 60)
    return {
        "vivo": minutos <= HEARTBEAT_MUDO_MIN,
        "visto": dt.astimezone(BR_TZ).strftime("%d/%m/%Y %H:%M"),
        "idade": _idade_texto(minutos),
        "wvsa_ok": bool(row.get("wvsa_ok")),
    }


def get_log(limite=150):
    """Histórico de execuções do coletor (tabela coletor_log)."""
    try:
        rows = supa.select("coletor_log", {
            "select": "executado_em,modulo,status,mensagem",
            "order": "executado_em.desc", "limit": str(limite),
        })
    except Exception:
        return []
    for r in rows:
        dt = _parse_dt(r.get("executado_em"))
        r["quando"] = dt.astimezone(BR_TZ).strftime("%d/%m %H:%M") if dt else "—"
        r["nome"] = NOMES.get(r.get("modulo"), r.get("modulo") or "geral")
    return rows
