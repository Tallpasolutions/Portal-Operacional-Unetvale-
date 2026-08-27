"""Rotas das páginas: dashboard inicial + os 3 módulos + usuários + config.

Cada página de módulo injeta o payload (JSON vindo do Supabase) no template;
o cross-filter e os gráficos rodam no cliente (sem round-trip por clique).
"""
import os
import re

from flask import (
    Blueprint, abort, flash, jsonify, redirect, render_template, request, url_for
)

from . import supa, dados, supervisores, troca_poste as tp
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

# Empresas que aparecem separadas no WVSA mas são a mesma na operação. O
# rótulo do técnico vem como "EMPRESA - Nome"; aqui só a parte da empresa é
# reescrita, o nome é preservado.
_APELIDOS_EMPRESA = {
    "WAVE SUPERVISOR": "WAVE",
}


def _agrupar_empresa(rotulo):
    i = rotulo.find(" - ")
    if i < 0:
        return rotulo
    empresa, nome = rotulo[:i].strip(), rotulo[i + 3:]
    return f"{_APELIDOS_EMPRESA.get(empresa.upper(), empresa)} - {nome}"


def _so_operacional(payload):
    if not payload or "tecnicos" not in payload:
        return payload
    p = dict(payload)
    p["tecnicos"] = [
        {**t, "nome": _agrupar_empresa(t.get("nome", ""))}
        for t in payload["tecnicos"]
        if not _INFRA.search(t.get("nome", ""))
    ]
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


@bp.route("/troca-poste")
@login_obrigatorio
def troca_poste():
    """Desligamentos da Celesc cruzados com a rede óptica.

    Segue o padrão das outras telas: injeta o pacote e o cliente cuida de
    filtro, gráficos e abas — sem round-trip por clique. O período padrão é
    hoje..+7 dias, porque a pergunta do módulo é sobre o que ainda VAI
    acontecer; o filtro permite abrir a janela.
    """
    if not usuario_atual()["ve_troca_poste"]:
        abort(403)
    de, ate = tp.periodo_padrao()
    pacote = {
        "linhas": tp.listar(),
        "revisao": tp.fila_revisao(),
        "ordens": tp.ordens(),
        "rotulos_risco": tp.ROTULO_RISCO,
        "ordem_risco": tp.ORDEM_RISCO,
        "ultima_coleta": tp.ultima_coleta(),
        "hoje": tp.hoje().isoformat(),
        "padrao": {"de": de, "ate": ate},
    }
    return render_template("troca-poste.html", ativo="troca-poste", pacote=pacote)


@bp.route("/troca-poste/rede.json")
@login_obrigatorio
def troca_poste_rede():
    """Malha óptica das cidades pedidas — carregada sob demanda pelo mapa.

    Fica fora do pacote da página de propósito: a malha inteira passa de 1 MB, e
    quem abre a tela para ver a lista de desligamentos não precisa baixar cabo
    nenhum. O mapa pede só as cidades do recorte quando a aba é aberta.
    """
    bruto = (request.args.get("cidades") or "").strip()
    cidades = [c for c in (x.strip() for x in bruto.split(",")) if c] or None
    resp = jsonify(tp.rede(cidades))
    # A malha vem do espelho do Geogrid, sincronizado semanalmente: relê-la a
    # cada troca de aba é desperdício. `private` porque a resposta depende da
    # sessão (a rota exige login).
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


@bp.route("/usuarios")
@admin_obrigatorio
def usuarios():
    try:
        lista = supa.select("usuarios", {"select": "nome,email,criado_em", "order": "criado_em.asc"})
    except Exception:
        lista = []
    return render_template("usuarios.html", ativo="usuarios", usuarios=lista)


@bp.route("/configuracoes")
@login_obrigatorio
def configuracoes():
    """Conta do próprio usuário e, para o admin, a gestão de supervisores.

    Deixou de ser exclusiva do admin: trocar a própria senha é algo que todo
    usuário precisa fazer, e antes só o admin conseguia.
    """
    u = usuario_atual()
    contexto = {"ativo": "configuracoes", "usuario": u}
    if u["is_admin"]:
        contexto["supervisores"] = supervisores.listar()
        contexto["equipes"] = supervisores.equipes_disponiveis()
        try:
            contexto["usuarios"] = supa.select(
                "usuarios", {"select": "id,nome,email", "order": "nome.asc"})
        except Exception:
            contexto["usuarios"] = []
    return render_template("configuracoes.html", **contexto)


@bp.route("/supervisores/marcar", methods=["POST"])
@admin_obrigatorio
def supervisor_marcar():
    """Promove um usuário existente a supervisor.

    Reaproveita a conta que já existe em vez de criar outra: senha, login e
    recuperação continuam num lugar só. Criar o usuário segue sendo feito na
    tela Usuários, pelo admin.
    """
    uid = (request.form.get("usuario_id") or "").strip()
    if not uid:
        flash("Escolha um usuário.", "erro")
        return redirect(url_for("dash.configuracoes"))
    try:
        if supervisores.eh_supervisor(uid):
            flash("Esse usuário já é supervisor.", "erro")
        else:
            supervisores.marcar(uid)
            flash("Supervisor cadastrado.", "ok")
    except Exception as e:
        flash(f"Erro ao cadastrar supervisor: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/supervisores/remover", methods=["POST"])
@admin_obrigatorio
def supervisor_remover():
    """Tira o papel de supervisor. A CONTA permanece — só o papel sai.

    Os vínculos com equipes caem junto (on delete cascade na migration 0003).
    """
    uid = (request.form.get("usuario_id") or "").strip()
    try:
        supervisores.desmarcar(uid)
        flash("Supervisor removido. A conta de acesso continua ativa.", "ok")
    except Exception as e:
        flash(f"Erro ao remover: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/supervisores/equipe", methods=["POST"])
@admin_obrigatorio
def supervisor_equipe():
    """Liga ou desliga uma equipe de um supervisor."""
    uid = (request.form.get("usuario_id") or "").strip()
    equipe = (request.form.get("equipe") or "").strip()
    acao = request.form.get("acao") or "vincular"
    if not uid or not equipe:
        flash("Informe o supervisor e a equipe.", "erro")
        return redirect(url_for("dash.configuracoes"))
    try:
        if acao == "desvincular":
            supervisores.desvincular(uid, equipe)
            flash(f"Equipe {equipe} desvinculada.", "ok")
        else:
            supervisores.vincular(uid, equipe)
            flash(f"Equipe {equipe} vinculada.", "ok")
    except Exception as e:
        flash(f"Erro ao alterar o vínculo: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/monitoramento")
@admin_obrigatorio
def monitoramento():
    # As coletas da Celesc (módulo Troca de Poste) ficam aqui junto das do
    # WVSA: é a mesma pergunta — "a ingestão está rodando?" — e ter duas telas
    # separadas para ela só fazia procurar em dois lugares.
    return render_template("monitoramento.html", ativo="monitoramento",
                           resumo=dados.resumo_modulos(), logs=dados.get_log(150),
                           coletas=tp.coletas(30))


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


def _ultimo_pedido():
    """Timestamp do pedido manual mais recente (registrado em coletor_log)."""
    try:
        rows = supa.select("coletor_log", {
            "status": "eq.pedido", "select": "executado_em",
            "order": "executado_em.desc", "limit": "1",
        })
        return dados._parse_dt(rows[0]["executado_em"]) if rows else None
    except Exception:
        return None


@bp.route("/api/atualizar", methods=["POST"])
@login_obrigatorio
def api_atualizar():
    # Registra o pedido na tabela existente coletor_log (status='pedido'); o
    # watcher do coletor (dentro da VPN) detecta e roda. Sem tabela extra.
    try:
        supa.insert("coletor_log", {
            "modulo": "geral", "status": "pedido",
            "mensagem": "Atualização manual solicitada",
        })
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 500
    return jsonify({"ok": True})


@bp.route("/api/atualizar/status")
@login_obrigatorio
def api_atualizar_status():
    ped = _ultimo_pedido()
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
