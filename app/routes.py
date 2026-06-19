"""Rotas das páginas: dashboard inicial + os 3 módulos + usuários + config.

Cada página de módulo injeta o payload (JSON vindo do Supabase) no template;
o cross-filter e os gráficos rodam no cliente (sem round-trip por clique).
"""
import os
import re

from flask import Blueprint, render_template, jsonify, request, abort

from . import supa, dados
from .auth import login_obrigatorio, admin_obrigatorio, usuario_atual

bp = Blueprint("dash", __name__)


@bp.app_context_processor
def injeta_status():
    """Disponibiliza o status de atualização e o usuário em todos os templates."""
    try:
        st = dados.status_geral()
    except Exception:
        st = {"tem_dados": False, "ultima": "—", "status": "sem_dados", "proxima": "—", "horarios": dados.HORARIOS}
    return {"status_upd": st, "usuario": usuario_atual()}


@bp.route("/")
@login_obrigatorio
def home():
    # Sem tela inicial: cai direto na Produtividade.
    from flask import redirect, url_for
    return redirect(url_for("dash.produtividade"))


@bp.route("/produtividade")
@login_obrigatorio
def produtividade():
    row = dados.get_modulo("produtividade")
    payload = (row or {}).get("payload") or {"registros": [], "total": 0}
    return render_template("produtividade.html", ativo="produtividade", payload=payload,
                           meta=_meta(row))


# Equipes de infraestrutura NÃO participam do IQI/IQM (só time operacional).
_INFRA = re.compile(r"\binfra\b|fandaruff", re.I)


def _so_operacional(payload):
    if not payload or "tecnicos" not in payload:
        return payload
    p = dict(payload)
    p["tecnicos"] = [t for t in payload["tecnicos"] if not _INFRA.search(t.get("nome", ""))]
    return p


@bp.route("/iqi")
@login_obrigatorio
def iqi():
    iqi_row = dados.get_modulo("iqi")
    iqm_row = dados.get_modulo("iqm")
    pacote = {}
    if iqi_row and iqi_row.get("payload"):
        pacote["IQI"] = _so_operacional(iqi_row["payload"])
    if iqm_row and iqm_row.get("payload"):
        pacote["IQM"] = _so_operacional(iqm_row["payload"])
    return render_template("iqi.html", ativo="iqi", pacote=pacote,
                           meta=_meta(iqi_row or iqm_row))


@bp.route("/massivas")
@login_obrigatorio
def massivas():
    row = dados.get_modulo("massivas")
    payload = (row or {}).get("payload") or {"meses": [], "metricas": [], "diario": [], "cidades": [], "totais_mes": []}
    return render_template("massivas.html", ativo="massivas", payload=payload,
                           meta=_meta(row))


@bp.route("/usuarios")
@admin_obrigatorio
def usuarios():
    try:
        lista = supa.select("usuarios", {"select": "nome,email,criado_em", "order": "criado_em.asc"})
    except Exception:
        lista = []
    return render_template("usuarios.html", ativo="usuarios", usuarios=lista)


@bp.route("/configuracoes")
@admin_obrigatorio
def configuracoes():
    return render_template("configuracoes.html", ativo="configuracoes", usuario=usuario_atual())


@bp.route("/monitoramento")
@admin_obrigatorio
def monitoramento():
    return render_template("monitoramento.html", ativo="monitoramento",
                           resumo=dados.resumo_modulos(), logs=dados.get_log(150))


def _meta(row):
    if not row:
        return {"atualizado_em": None, "status": "sem_dados"}
    return {"atualizado_em": row.get("atualizado_em"), "status": row.get("status")}


# --------------------------------------------------------------------------
# Atualização sob demanda: o botão grava um "pedido" no Supabase; o watcher do
# coletor (dentro da VPN) detecta e roda. O app só lê/escreve o Supabase.
# --------------------------------------------------------------------------
def _ultima_data():
    ult = None
    for r in dados.get_todos().values():
        dt = dados._parse_dt(r.get("atualizado_em"))
        if dt and (ult is None or dt > ult):
            ult = dt
    return ult


@bp.route("/api/atualizar", methods=["POST"])
@login_obrigatorio
def api_atualizar():
    from datetime import datetime, timezone
    agora = datetime.now(timezone.utc).isoformat()
    try:
        supa.upsert("controle", {"id": 1, "pedido_em": agora}, on_conflict="id")
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 500
    return jsonify({"ok": True})


@bp.route("/api/atualizar/status")
@login_obrigatorio
def api_atualizar_status():
    ped = None
    try:
        c = supa.select_one("controle", {"id": "eq.1", "select": "pedido_em"})
        ped = dados._parse_dt((c or {}).get("pedido_em"))
    except Exception:
        pass
    ult = _ultima_data()
    rodando = bool(ped and (ult is None or ped > ult))
    return jsonify({
        "rodando": rodando,
        "ultima": ult.astimezone(dados.BR_TZ).strftime("%d/%m/%Y %H:%M") if ult else "—",
    })


# --------------------------------------------------------------------------
# Endpoint opcional de ingestão: o coletor pode usar isto em vez de gravar
# direto no Supabase. Protegido por token compartilhado (INGEST_TOKEN).
# --------------------------------------------------------------------------
@bp.route("/api/ingest", methods=["POST"])
def ingest():
    token = request.headers.get("X-Ingest-Token", "")
    esperado = os.environ.get("INGEST_TOKEN", "")
    if not esperado or token != esperado:
        abort(401)
    body = request.get_json(silent=True) or {}
    modulo = body.get("modulo")
    payload = body.get("payload")
    status = body.get("status", "ok")
    if modulo not in dados.MODULOS or payload is None:
        return jsonify({"erro": "modulo/payload inválidos"}), 400
    from datetime import datetime, timezone
    supa.upsert("dados_modulo", {
        "modulo": modulo,
        "payload": payload,
        "status": status,
        "atualizado_em": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="modulo")
    return jsonify({"ok": True})
