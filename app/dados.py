"""Leitura dos snapshots dos módulos (tabela `dados_modulo`) e cálculo do
status de atualização (última / próxima / status) exibido no cabeçalho.
"""
from datetime import datetime, timedelta, timezone

from . import supa

BR_TZ = timezone(timedelta(hours=-3))
HORARIOS = [8, 10, 12, 14, 16, 18]  # grade fixa de atualização (horário de Brasília)

MODULOS = ("produtividade", "iqi", "iqm", "massivas")


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
