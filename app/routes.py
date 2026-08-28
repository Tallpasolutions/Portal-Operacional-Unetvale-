"""Rotas das páginas: dashboard inicial + os 3 módulos + usuários + config.

Cada página de módulo injeta o payload (JSON vindo do Supabase) no template;
o cross-filter e os gráficos rodam no cliente (sem round-trip por clique).
"""
import os
import re

from flask import (
    Blueprint, abort, flash, jsonify, redirect, render_template, request,
    session, url_for
)

from . import supa, dados, solicitacao, supervisores, troca_poste as tp
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
    u = usuario_atual()
    # Supervisor só enxerga as próprias equipes: o recorte é aplicado no
    # servidor, não escondendo no cliente — dado que não deve ser visto não
    # chega ao browser.
    if u["is_supervisor"] and not u["is_admin"]:
        minhas = set(supervisores.equipes_de(u["id"]))
        p2 = dict(payload)
        p2["registros"] = [r for r in payload.get("registros", []) if r.get("e") in minhas]
        p2["total"] = len(p2["registros"])
        payload = p2
    return render_template("produtividade.html", ativo="produtividade", payload=payload,
                           meta=_meta(row), supervisores=_supervisores_para_filtro(u))


# Equipes de infraestrutura NÃO participam do IQI/IQM (só time operacional).
_INFRA = re.compile(r"\binfra\b|fandaruff", re.I)

def _agrupar_empresa(rotulo):
    """Reescreve só a empresa do rótulo "EMPRESA - Nome"; o nome é preservado.

    O mapa de apelidos mora em `supervisores` porque o vínculo do supervisor
    compara por ele. Duas cópias divergindo fariam o filtro perder técnicos
    sem erro nenhum na tela.
    """
    i = rotulo.find(" - ")
    if i < 0:
        return rotulo
    empresa, nome = rotulo[:i].strip(), rotulo[i + 3:]
    return f"{supervisores.APELIDOS_EMPRESA.get(empresa.upper(), empresa)} - {nome}"


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
                           meta=_meta(iqi_row or iqm_row),
                           supervisores=_supervisores_para_filtro(usuario_atual()),
                           apelidos_empresa=supervisores.APELIDOS_EMPRESA)


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
        "linhas": [
            # O script da OS vai pronto para a tela: o operador lê ANTES de
            # clicar, não depois de a OS existir.
            {**l, "script_os": solicitacao.montar(l)} for l in tp.listar()
        ],
        "revisao": tp.fila_revisao(),
        "ordens": tp.ordens(),
        "rotulos_risco": tp.ROTULO_RISCO,
        "ordem_risco": tp.ORDEM_RISCO,
        "ultima_coleta": tp.ultima_coleta(),
        "hoje": tp.hoje().isoformat(),
        "padrao": {"de": de, "ate": ate},
        "envio_os_habilitado": _envio_os_habilitado(),
    }
    return render_template("troca-poste.html", ativo="troca-poste", pacote=pacote)


@bp.route("/troca-poste/os", methods=["POST"])
@login_obrigatorio
def troca_poste_criar_os():
    """Cria o RASCUNHO da OS a partir de um desligamento. Não envia nada."""
    if not usuario_atual()["ve_troca_poste"]:
        abort(403)
    corpo = request.get_json(silent=True) or {}
    deslig_id = (corpo.get("desligamento_id") or "").strip()
    executor = (corpo.get("executor") or "infra").strip()
    if not deslig_id:
        return jsonify({"erro": "desligamento_id ausente"}), 400

    linha = next((l for l in tp.listar(incluir_passados=True) if l["id"] == deslig_id), None)
    if not linha:
        return jsonify({"erro": "desligamento não encontrado"}), 404

    try:
        ordem = tp.criar_rascunho(
            desligamento_id=deslig_id,
            usuario_id=session.get("uid"),
            solicitacao=corpo.get("solicitacao") or solicitacao.montar(linha),
            executor=executor,
            periodo=corpo.get("periodo"),
            tipo_tecnico=corpo.get("tipo_tecnico"),
            agendamento=corpo.get("agendamento"),
        )
    except Exception as e:
        return jsonify({"erro": str(e)}), 500
    return jsonify({"ordem_id": ordem["id"], "status": ordem["status"],
                    "chave": ordem["chave_idempotencia"]})


def _envio_os_habilitado():
    """O envio de OS ao WVSA está liberado?

    Desligado por padrão. O fluxo existe e a tela mostra tudo, mas o envio em
    si não foi testado de ponta a ponta contra o WVSA — e um clique cria OS
    real e desloca equipe. Ligar é decisão explícita, feita no ambiente
    (`OS_ENVIO_HABILITADO=true`), não uma mudança de código.

    A recusa fica AQUI, no servidor, e não só no botão: desabilitar no cliente
    impede o clique acidental, não uma requisição forjada.
    """
    return os.environ.get("OS_ENVIO_HABILITADO", "").strip().lower() == "true"


@bp.route("/troca-poste/os/<ordem_id>/enviar", methods=["POST"])
@login_obrigatorio
def troca_poste_enviar_os(ordem_id):
    """Autoriza o envio: marca o clique humano e devolve na hora.

    O POST no WVSA NÃO acontece aqui — a Vercel não alcança a rede interna
    onde o WVSA responde. Quem envia é o processo `enviar_os.py`, rodando
    dentro da VPN, que observa esta fila. A tela acompanha por poll.
    """
    if not usuario_atual()["ve_troca_poste"]:
        abort(403)
    if not _envio_os_habilitado():
        return jsonify({
            "erro": "O envio de OS ao WVSA está desligado.",
            "detalhe": "O fluxo ainda não foi validado ponta a ponta. "
                       "Para liberar, defina OS_ENVIO_HABILITADO=true no ambiente.",
        }), 503
    try:
        tp.marcar_para_envio(ordem_id, session.get("uid"))
    except ValueError as e:
        return jsonify({"erro": str(e)}), 409
    except Exception as e:
        return jsonify({"erro": str(e)}), 500
    return jsonify({"ok": True, "status": "pronta"})


@bp.route("/troca-poste/os/<ordem_id>")
@login_obrigatorio
def troca_poste_status_os(ordem_id):
    """Estado da ordem — a tela faz poll aqui enquanto o envio acontece."""
    if not usuario_atual()["ve_troca_poste"]:
        abort(403)
    o = tp.ordem(ordem_id)
    if not o:
        return jsonify({"erro": "ordem não encontrada"}), 404
    return jsonify(o)


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
        lista = supa.select("usuarios",
                            {"select": "id,nome,email,criado_em", "order": "criado_em.asc"})
    except Exception:
        lista = []
    return render_template("usuarios.html", ativo="usuarios", usuarios=lista)


@bp.route("/usuarios/renomear", methods=["POST"])
@admin_obrigatorio
def usuario_renomear():
    """Corrige o nome de exibição de uma conta.

    O nome é atributo da CONTA, então a correção mora aqui e não na tela de
    supervisores: arrumar num lugar arruma em todos — lista de usuários,
    cadastro de supervisor e o filtro do IQI/IQM. O e-mail não muda, porque é
    a identidade de login; trocá-lo é criar outra conta, não renomear esta.
    """
    uid = (request.form.get("usuario_id") or "").strip()
    nome = " ".join((request.form.get("nome") or "").split())
    if not uid or not nome:
        flash("Informe o usuário e o novo nome.", "erro")
        return redirect(url_for("dash.usuarios"))
    try:
        supa.update("usuarios", {"id": uid}, {"nome": nome})
        flash(f"Nome atualizado para {nome}.", "ok")
    except Exception as e:
        flash(f"Erro ao renomear: {e}", "erro")
    return redirect(url_for("dash.usuarios"))


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
        contexto["tecnicos_por_empresa"] = supervisores.tecnicos_disponiveis()
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
    """Liga ou desliga equipes de um supervisor.

    Aceita várias equipes numa submissão: supervisor com uma equipe só é a
    exceção, não a regra — o Hygor tem três. Uma ida ao servidor por equipe
    fazia o cadastro virar repetição.
    """
    uid = (request.form.get("usuario_id") or "").strip()
    equipes = [e.strip() for e in request.form.getlist("equipe") if e.strip()]
    acao = request.form.get("acao") or "vincular"
    if not uid or not equipes:
        flash("Informe o supervisor e ao menos uma equipe.", "erro")
        return redirect(url_for("dash.configuracoes"))
    try:
        for equipe in equipes:
            if acao == "desvincular":
                supervisores.desvincular(uid, equipe)
            else:
                supervisores.vincular(uid, equipe)
        verbo = "desvinculada" if acao == "desvincular" else "vinculada"
        flash(f"{len(equipes)} equipe(s) {verbo}(s): {', '.join(equipes)}.", "ok")
    except Exception as e:
        flash(f"Erro ao alterar o vínculo: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/supervisores/tecnico", methods=["POST"])
@admin_obrigatorio
def supervisor_tecnico():
    """Liga ou desliga técnicos avulsos de um supervisor.

    Existe porque a empresa nem sempre é a unidade de supervisão: os 26
    técnicos da UNETVALE se dividem entre supervisores, e vincular a empresa
    inteira mostraria a cada um o time do outro.
    """
    uid = (request.form.get("usuario_id") or "").strip()
    rotulos = [r.strip() for r in request.form.getlist("tecnico") if r.strip()]
    acao = request.form.get("acao") or "vincular"
    if not uid or not rotulos:
        flash("Informe o supervisor e ao menos um técnico.", "erro")
        return redirect(url_for("dash.configuracoes"))
    try:
        for rotulo in rotulos:
            if acao == "desvincular":
                # Aqui vem a chave normalizada, que é o que a tabela guarda.
                supervisores.desvincular_tecnico(uid, rotulo)
            else:
                supervisores.vincular_tecnico(uid, rotulo)
        verbo = "desvinculado" if acao == "desvincular" else "vinculado"
        flash(f"{len(rotulos)} técnico(s) {verbo}(s).", "ok")
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


def _supervisores_para_filtro(u):
    """Lista para o filtro por supervisor.

    Só o admin escolhe entre supervisores; para o próprio supervisor o recorte
    já veio aplicado do servidor, então oferecer o filtro seria redundante.
    """
    if not u["is_admin"]:
        return []
    return [{"id": s["usuario_id"], "nome": s["nome"], "equipes": s["equipes"],
             "tecnicos": [t["chave"] for t in s["tecnicos"]]}
            for s in supervisores.listar() if s["equipes"] or s["tecnicos"]]


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
