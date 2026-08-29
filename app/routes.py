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

from . import (acoes, supa, dados, reuniao_ia, solicitacao, supervisores,
               troca_poste as tp)
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
        # Equipes inteiras MAIS técnicos avulsos: as duas formas de vínculo se
        # somam. Olhar só as equipes esconderia do supervisor justamente quem
        # foi vinculado nome a nome porque a empresa não é dele inteira.
        minhas = set(supervisores.equipes_de(u["id"]))
        meus = set(supervisores.tecnicos_de(u["id"]))

        def _dele(r):
            return (r.get("e") in minhas
                    or supervisores.chave_tecnico(f"{r.get('e')} - {r.get('t')}") in meus)

        p2 = dict(payload)
        p2["registros"] = [r for r in payload.get("registros", []) if _dele(r)]
        p2["total"] = len(p2["registros"])
        payload = p2
    return render_template("produtividade.html", ativo="produtividade", payload=payload,
                           meta=_meta(row), supervisores=_supervisores_para_filtro(u),
                           apelidos_empresa=supervisores.APELIDOS_EMPRESA)


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
        # Áreas e gestores do módulo Ações moram aqui, e não numa aba dentro
        # dele: configuração espalhada em dois lugares é onde as pessoas
        # param de achar.
        contexto["areas"] = acoes.areas()
        contexto["areas_todas"] = acoes.areas(incluir_inativas=True)
        contexto["gestores"] = acoes.gestores()
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


# --------------------------------------------------------------------------
# Módulo Ações
#
# Primeiro módulo do portal em que o dado NASCE aqui. Produtividade, IQI e
# Massivas são espelho do WVSA e podem ser recoletados; aqui não há de onde
# recoletar, então o recorte de quem vê o quê é feito no servidor e o
# histórico é append-only.
# --------------------------------------------------------------------------
def _usuarios_para_escolha():
    """Contas ativas, para os seletores de responsável e apoio."""
    try:
        return supa.select("usuarios", {"select": "id,nome,email", "order": "nome.asc"})
    except Exception:
        return []


def _acao_ou_404(acao_id, u, exigir=None):
    """Carrega a ação e confere a permissão numa tacada só.

    Devolver 404 em vez de 403 quando a pessoa não pode ver é deliberado: um
    403 confirmaria que a ação existe, e o código dela é sequencial e fácil de
    adivinhar.
    """
    a = acoes.obter(acao_id)
    if not a or not acoes.pode_ver(u, a):
        abort(404)
    if exigir and not exigir(u, a):
        abort(403)
    return a


@bp.route("/acoes")
@login_obrigatorio
def acoes_view():
    u = usuario_atual()
    filtros = {k: (request.args.get(k) or "").strip() or None
               for k in ("responsavel", "area", "status", "prioridade", "situacao")}
    lista = acoes.listar(u, filtros)
    aba = request.args.get("aba", "painel")

    # Só a aba Reuniões paga o custo do que é dela. As outras duas não podem
    # ficar mais lentas por causa de um card que elas nem mostram.
    reunioes = acoes.listar_reunioes(u)
    for r in reunioes:
        # Trecho do resumo na lista: reconhecer a reunião sem precisar abrir.
        r["resumo"] = reuniao_ia.resumo_curto(r.get("ata_markdown"))

    recorrentes, resumo_exec = [], None
    if aba == "reunioes":
        # O expurgo dos áudios vencidos pega carona aqui: a Vercel não tem
        # processo residente, e um agendador seria infra nova para apagar meia
        # dúzia de arquivos. Falhar em silêncio é deliberado — limpeza de
        # arquivo velho não pode derrubar a tela de quem só quer ver a lista.
        try:
            reuniao_ia.expurgar_audio()
        except Exception:
            pass
        recorrentes = reuniao_ia.recorrentes_pendentes()
        resumo_exec = reuniao_ia.resumo_executivo(lista=recorrentes)

    # O Painel recebe a MESMA lista que a aba Ações, e não uma consulta
    # própria: painel que refaz a consulta é painel que discorda da tabela.
    return render_template(
        "acoes.html", ativo="acoes", sem_sync=True, aba=aba,
        acoes=lista, resumo=acoes.resumo(lista), filtros=filtros,
        areas=acoes.areas(), usuarios=_usuarios_para_escolha(),
        status_opcoes=acoes.STATUS, prioridades=acoes.PRIORIDADES,
        pode_criar=acoes.pode_gerir(u), ultimos=acoes.ultimos_eventos(),
        reunioes=reunioes,
        recorrentes=recorrentes, resumo_exec=resumo_exec,
        resumo_exec_html=reuniao_ia.para_html(
            (resumo_exec or {}).get("markdown")))


@bp.route("/acoes/<acao_id>")
@login_obrigatorio
def acao_detalhe(acao_id):
    u = usuario_atual()
    a = _acao_ou_404(acao_id, u)
    return render_template(
        "acao_detalhe.html", ativo="acoes", sem_sync=True, acao=a,
        eventos=acoes.eventos(acao_id), areas=acoes.areas(),
        itens_reuniao=reuniao_ia.itens_da_acao(acao_id),
        usuarios=_usuarios_para_escolha(),
        status_opcoes=acoes.STATUS, prioridades=acoes.PRIORIDADES,
        pode_gerir=acoes.pode_gerir(u, a), pode_atualizar=acoes.pode_atualizar(u, a))


@bp.route("/acoes/nova", methods=["POST"])
@login_obrigatorio
def acao_nova():
    u = usuario_atual()
    if not acoes.pode_gerir(u):
        abort(403)
    try:
        a = acoes.criar(request.form.to_dict(), u["id"],
                        apoio_ids=request.form.getlist("apoio"))
        flash(f"Ação {a['codigo']} criada.", "ok")
        return redirect(url_for("dash.acao_detalhe", acao_id=a["id"]))
    except Exception as e:
        flash(f"Erro ao criar a ação: {e}", "erro")
        return redirect(url_for("dash.acoes_view", aba="acoes"))


@bp.route("/acoes/<acao_id>/editar", methods=["POST"])
@login_obrigatorio
def acao_editar(acao_id):
    u = usuario_atual()
    _acao_ou_404(acao_id, u, exigir=acoes.pode_gerir)
    try:
        acoes.editar(acao_id, request.form.to_dict(),
                     apoio_ids=request.form.getlist("apoio"))
        flash("Ação atualizada.", "ok")
    except Exception as e:
        flash(f"Erro ao editar: {e}", "erro")
    return redirect(url_for("dash.acao_detalhe", acao_id=acao_id))


@bp.route("/acoes/<acao_id>/atualizar", methods=["POST"])
@login_obrigatorio
def acao_atualizar(acao_id):
    u = usuario_atual()
    _acao_ou_404(acao_id, u, exigir=acoes.pode_atualizar)
    f = request.form
    try:
        acoes.atualizar(
            acao_id, u["id"], f.get("texto"),
            status=f.get("status") or None,
            progresso=f.get("progresso") if f.get("progresso") not in (None, "") else None,
            proximo_passo=f.get("proximo_passo"),
            evidencia=f.get("evidencia") or None,
            data_conclusao=f.get("data_conclusao") or None)
        flash("Atualização registrada.", "ok")
    except Exception as e:
        flash(str(e), "erro")
    return redirect(url_for("dash.acao_detalhe", acao_id=acao_id))


@bp.route("/acoes/<acao_id>/comentar", methods=["POST"])
@login_obrigatorio
def acao_comentar(acao_id):
    u = usuario_atual()
    _acao_ou_404(acao_id, u, exigir=acoes.pode_gerir)
    try:
        acoes.comentar(acao_id, u["id"], request.form.get("texto"),
                       reuniao_id=request.form.get("reuniao_id") or None)
        flash("Comentário registrado.", "ok")
    except Exception as e:
        flash(str(e), "erro")
    destino = request.form.get("voltar_para")
    if destino == "reuniao" and request.form.get("reuniao_id"):
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=request.form["reuniao_id"]))
    return redirect(url_for("dash.acao_detalhe", acao_id=acao_id))


@bp.route("/reunioes/nova", methods=["POST"])
@login_obrigatorio
def reuniao_nova():
    u = usuario_atual()
    if not acoes.pode_gerir(u):
        abort(403)
    f = request.form
    try:
        r = acoes.criar_reuniao(f.get("titulo"), f.get("tipo"), f.get("data"),
                                f.getlist("participantes"), u["id"])
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=r["id"]))
    except Exception as e:
        flash(str(e), "erro")
        return redirect(url_for("dash.acoes_view", aba="reunioes"))


@bp.route("/reunioes/<reuniao_id>")
@login_obrigatorio
def reuniao_detalhe(reuniao_id):
    u = usuario_atual()
    r = acoes.obter_reuniao(reuniao_id)
    if not r:
        abort(404)
    # Participante enxerga a própria reunião; conduzir é só de gestor.
    if not (u["is_admin"] or r.get("criada_por") == u["id"]
            or u["id"] in r["participantes"]):
        abort(404)
    conduz = acoes.pode_gerir(u)
    return render_template(
        "reuniao.html", ativo="acoes", sem_sync=True, reuniao=r,
        pauta=acoes.pauta(r, u), usuarios=_usuarios_para_escolha(),
        conduz=conduz,
        estado=reuniao_ia.estado(reuniao_id, r),
        itens_ata=reuniao_ia.itens(reuniao_id),
        ata_html=reuniao_ia.para_html(r.get("ata_markdown")),
        contexto=reuniao_ia.contexto_anterior(r, u),
        areas=acoes.areas(),
        acoes_abertas=reuniao_ia.acoes_para_vincular(u),
        prioridades=acoes.PRIORIDADES,
        trecho_segundos=int(os.environ.get("REUNIAO_TRECHO_SEGUNDOS", "120")))


@bp.route("/reunioes/<reuniao_id>/encerrar", methods=["POST"])
@login_obrigatorio
def reuniao_encerrar(reuniao_id):
    u = usuario_atual()
    if not acoes.pode_gerir(u):
        abort(403)
    try:
        # `notas` não vem mais da tela (o campo saiu). Passar None apagaria a
        # nota de reuniões antigas que tinham uma.
        acoes.encerrar_reuniao(reuniao_id, request.form.get("notas"))
        flash("Reunião encerrada. A ata está congelada.", "ok")
    except Exception as e:
        flash(str(e), "erro")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))



# ---- Gravação e ata da reunião -------------------------------------------
# Todas devolvem JSON: quem chama é o `reuniao.js`, não um <form>. O fluxo
# inteiro está desenhado em app/reuniao_ia.py — em resumo, quem orquestra é o
# navegador, porque a Vercel não tem processo em background.

def _reuniao_ou_404(reuniao_id, u, exigir_conduz=False, exigir_aberta=False):
    """Mesma lógica de `_acao_ou_404`: 404 para quem não pode ver.

    404 e não 403 porque 403 confirmaria que a reunião existe — e reunião
    tem participante, assunto e data que ninguém precisa poder sondar.
    """
    r = acoes.obter_reuniao(reuniao_id)
    if not r:
        abort(404)
    if not (u["is_admin"] or r.get("criada_por") == u["id"]
            or u["id"] in r["participantes"]):
        abort(404)
    if exigir_conduz and not acoes.pode_gerir(u):
        abort(403)
    if exigir_aberta and r.get("encerrada_em"):
        abort(409)
    return r


@bp.route("/reunioes/<reuniao_id>/gravacao/iniciar", methods=["POST"])
@login_obrigatorio
def reuniao_gravacao_iniciar(reuniao_id):
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True, exigir_aberta=True)
    try:
        reuniao_ia.iniciar_gravacao(reuniao_id)
    except Exception as e:
        return jsonify({"erro": str(e)}), 502
    return jsonify({"ok": True})


@bp.route("/reunioes/<reuniao_id>/gravacao/parar", methods=["POST"])
@login_obrigatorio
def reuniao_gravacao_parar(reuniao_id):
    """Chamada pelo JS quando a captura parou e a fila esvaziou."""
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    try:
        return jsonify({"status": reuniao_ia.parar_gravacao(reuniao_id)})
    except Exception as e:
        return jsonify({"erro": str(e)}), 502


@bp.route("/reunioes/<reuniao_id>/audio/url", methods=["POST"])
@login_obrigatorio
def reuniao_audio_url(reuniao_id):
    """Autoriza o browser a gravar UM trecho direto no Storage.

    O arquivo não passa pelo Flask de propósito: a função serverless tem
    limite de corpo de requisição e o áudio estoura esse limite.
    """
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True, exigir_aberta=True)
    corpo = request.get_json(silent=True) or {}
    try:
        indice = int(corpo.get("indice"))
    except (TypeError, ValueError):
        return jsonify({"erro": "indice ausente ou inválido"}), 400
    try:
        return jsonify(reuniao_ia.autorizar_trecho(
            reuniao_id, indice, corpo.get("formato") or "audio/webm"))
    except Exception as e:
        return jsonify({"erro": str(e)}), 502


@bp.route("/reunioes/<reuniao_id>/audio/<int:indice>/transcrever", methods=["POST"])
@login_obrigatorio
def reuniao_audio_transcrever(reuniao_id, indice):
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    corpo = request.get_json(silent=True) or {}
    try:
        texto = reuniao_ia.transcrever_trecho(
            reuniao_id, indice, corpo.get("bytes"), corpo.get("duracao_ms"))
    except Exception as e:
        # 502 e não 500: a falha é do serviço externo, e a tela oferece
        # "tentar de novo". O áudio continua no Storage por 30 dias.
        return jsonify({"erro": str(e)}), 502
    return jsonify({"ok": True, "indice": indice, "caracteres": len(texto)})


@bp.route("/reunioes/<reuniao_id>/ata", methods=["POST"])
@login_obrigatorio
def reuniao_ata(reuniao_id):
    """Junta os trechos e gera a ata. Também é o caminho de regerar.

    Regerar continua permitido depois de encerrada: o que a regra de
    'ata congelada' protege são os COMENTÁRIOS do dia, que não mudam. A
    ata da transcrição é derivada do áudio e pode ser refeita enquanto o
    áudio existir.
    """
    u = usuario_atual()
    r = _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    corpo = request.get_json(silent=True) or {}
    # Dois clientes para a mesma rota: o `reuniao.js` (fetch, quer JSON) e o
    # botão "Gerar de novo" (<form>, quer voltar para a página). Devolver JSON
    # para o form deixaria o gestor olhando um {"ok": true} numa tela branca.
    via_form = not request.is_json

    try:
        reuniao_ia.montar_ata(r, u, interrompida=bool(corpo.get("interrompida")))
    except ValueError as e:
        if via_form:
            flash(str(e), "erro")
            return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        if via_form:
            flash(f"Não foi possível gerar a ata: {e}", "erro")
            return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))
        return jsonify({"erro": str(e)}), 502

    if via_form:
        flash("Ata gerada.", "ok")
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))
    return jsonify({"ok": True})


@bp.route("/reunioes/<reuniao_id>/ata/status")
@login_obrigatorio
def reuniao_ata_status(reuniao_id):
    u = usuario_atual()
    r = _reuniao_ou_404(reuniao_id, u)
    return jsonify(reuniao_ia.estado(reuniao_id, r))


@bp.route("/reunioes/<reuniao_id>/ata/editar", methods=["POST"])
@login_obrigatorio
def reuniao_ata_editar(reuniao_id):
    """Corrige a ata à mão. A IA erra nome próprio e sigla."""
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    # Quem chama é o autosave da tela (fetch, quer JSON). O `form` fica como
    # caminho de reserva para navegador sem JS.
    corpo = request.get_json(silent=True) or {}
    texto = corpo.get("ata_markdown", request.form.get("ata_markdown"))
    try:
        reuniao_ia.salvar_ata(reuniao_id, texto, u["id"])
    except ValueError as e:
        if request.is_json:
            return jsonify({"erro": str(e)}), 400
        flash(str(e), "erro")
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))
    except Exception as e:
        if request.is_json:
            return jsonify({"erro": str(e)}), 502
        flash(f"Não foi possível salvar: {e}", "erro")
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))

    if request.is_json:
        return jsonify({"ok": True})
    flash("Ata salva.", "ok")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))


@bp.route("/reunioes/<reuniao_id>/ata/itens/<item_id>/acao", methods=["POST"])
@login_obrigatorio
def reuniao_item_acao(reuniao_id, item_id):
    """Item da ata vira ação nova, ou entra numa que já existe.

    Era o beco sem saída do módulo: o vínculo só acontecia quando a IA
    reconhecia um código `AC-000` na fala, e assunto que ainda não é ação —
    a maioria — não tinha para onde ir.
    """
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    f = request.form
    try:
        if f.get("modo") == "vincular":
            if not f.get("acao_id"):
                raise ValueError("Escolha a ação.")
            reuniao_ia.vincular_item(item_id, f["acao_id"], u["id"])
            flash("Item registrado na ação.", "ok")
        else:
            a = reuniao_ia.criar_acao_do_item(
                item_id, f.to_dict(), u["id"], apoio_ids=f.getlist("apoio"))
            flash(f"Ação {a['codigo']} criada a partir da ata.", "ok")
    except ValueError as e:
        flash(str(e), "erro")
    except Exception as e:
        flash(f"Não foi possível: {e}", "erro")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))


@bp.route("/reunioes/<reuniao_id>/ata/itens/<item_id>/aplicar", methods=["POST"])
@login_obrigatorio
def reuniao_item_aplicar(reuniao_id, item_id):
    """Item da ata vira comentário na ação — só por clique humano.

    `acao_eventos` é append-only por trigger: o que entra lá não sai nem
    com a service_role. Por isso texto de IA precisa de alguém assinando.
    """
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    try:
        reuniao_ia.aplicar_item(item_id, u["id"])
        flash("Item registrado na linha do tempo da ação.", "ok")
    except ValueError as e:
        flash(str(e), "erro")
    except Exception as e:
        flash(f"Não foi possível registrar: {e}", "erro")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))


@bp.route("/acoes/resumo-executivo/gerar", methods=["POST"])
@login_obrigatorio
def acoes_resumo_executivo():
    u = usuario_atual()
    if not acoes.pode_gerir(u):
        abort(403)
    try:
        reuniao_ia.gerar_resumo_executivo()
        flash("Resumo executivo atualizado.", "ok")
    except ValueError as e:
        flash(str(e), "erro")
    except Exception as e:
        flash(f"Não foi possível gerar o resumo: {e}", "erro")
    return redirect(url_for("dash.acoes_view", aba="reunioes"))

# ---- Configurações do módulo (só admin) ----------------------------------
@bp.route("/acoes/areas", methods=["POST"])
@admin_obrigatorio
def acoes_area():
    f = request.form
    acao = f.get("acao") or "criar"
    try:
        if acao == "criar":
            acoes.criar_area(f.get("nome") or "")
            flash("Área criada.", "ok")
        elif acao == "renomear":
            acoes.renomear_area(f.get("area_id"), f.get("nome") or "")
            flash("Área renomeada.", "ok")
        else:
            # Desativar em vez de apagar: ação antiga precisa continuar
            # dizendo de que área ela era.
            acoes.definir_area_ativa(f.get("area_id"), acao == "ativar")
            flash("Área " + ("reativada." if acao == "ativar" else "desativada."), "ok")
    except Exception as e:
        flash(f"Erro: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/acoes/gestores", methods=["POST"])
@admin_obrigatorio
def acoes_gestor():
    f = request.form
    uid = (f.get("usuario_id") or "").strip()
    ids = [a for a in f.getlist("area_id") if a]
    if not uid or not ids:
        flash("Escolha o usuário e ao menos uma área.", "erro")
        return redirect(url_for("dash.configuracoes"))
    try:
        for area_id in ids:
            if f.get("acao") == "desvincular":
                acoes.desvincular_gestor(uid, area_id)
            else:
                acoes.vincular_gestor(uid, area_id)
        flash("Vínculo de gestor atualizado.", "ok")
    except Exception as e:
        flash(f"Erro: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/acoes/<acao_id>/excluir", methods=["POST"])
@login_obrigatorio
def acao_excluir(acao_id):
    """Só apaga ação sem histórico — engano de digitação, não reescrita do
    passado. Ver `acoes.excluir`."""
    u = usuario_atual()
    _acao_ou_404(acao_id, u, exigir=acoes.pode_gerir)
    try:
        acoes.excluir(acao_id)
        flash("Ação apagada.", "ok")
        return redirect(url_for("dash.acoes_view", aba="acoes"))
    except Exception as e:
        flash(str(e), "erro")
        return redirect(url_for("dash.acao_detalhe", acao_id=acao_id))
