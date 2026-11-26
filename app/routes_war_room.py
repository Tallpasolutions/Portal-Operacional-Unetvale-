"""Rotas da War Room de Operações — no MESMO blueprint `dash`.

Arquivo próprio pela mesma razão de `routes_processos.py` e
`routes_esteira.py` (`routes.py` passa de 1.700 linhas). A regra mora em
`app/war_room.py`.

Quem vê é a matriz de Configurações (`modulo_obrigatorio`), e todos os que
veem registram: a mesa é uma só, e o supervisor enxerga os desvios de todos,
não só do próprio time (decisão de 19/11/2026). As escritas respondem JSON e
a tela se redesenha sem recarregar — recarregar fecharia o formulário de
quem está no meio de outro registro.
"""
import re

from flask import abort, jsonify, render_template, request

from . import supa
from . import war_room as wr
from .auth import login_obrigatorio, modulo_obrigatorio, usuario_atual
from .routes import bp

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _corpo():
    corpo = request.get_json(silent=True)
    if not isinstance(corpo, dict):
        abort(400)
    return corpo


def _sem_tabela():
    return jsonify({"erro": "O registro de desvios ainda não tem as tabelas no banco "
                            "(migration 0021_war_room.sql)."}), 503


@bp.route("/war-room")
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_view():
    dia = request.args.get("dia")
    try:
        foco = wr.dia_valido(dia) if dia else wr.hoje()
    except wr.Recusa:
        foco = wr.hoje()
    return render_template("war_room.html", ativo="war-room", pacote=wr.pacote(foco))


@bp.route("/war-room/pacote")
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_pacote():
    """O mesmo pacote da página, em JSON: trocar o dia pelo clique no gráfico
    e a atualização automática redesenham a tela sem recarregar — recarregar
    fecharia o formulário de quem está registrando e perderia os filtros."""
    try:
        foco = wr.dia_valido(request.args.get("dia") or wr.hoje().isoformat())
    except wr.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    return jsonify({"pacote": wr.pacote(foco)})


@bp.route("/war-room/versao")
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_versao():
    return jsonify({"versao": wr.versao()})


@bp.route("/war-room/desvios", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_registrar():
    try:
        desvio = wr.registrar(_corpo(), usuario_atual()["id"])
    except wr.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        if supa.tabela_faltando(e):
            return _sem_tabela()
        raise
    return jsonify({"desvio": desvio})


@bp.route("/war-room/desvios/<desvio_id>", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_atualizar(desvio_id):
    if not _UUID.match(desvio_id):
        abort(404)
    try:
        desvio = wr.atualizar(desvio_id, _corpo(), usuario_atual()["id"])
    except wr.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        if supa.tabela_faltando(e):
            return _sem_tabela()
        raise
    if desvio is None:
        abort(404)
    return jsonify({"desvio": desvio})


@bp.route("/war-room/desvios/<desvio_id>/anular", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_anular(desvio_id):
    if not _UUID.match(desvio_id):
        abort(404)
    u = usuario_atual()
    try:
        desvio = wr.anular(desvio_id, _corpo().get("motivo"), u["id"], u["is_admin"])
    except wr.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    except PermissionError as e:
        return jsonify({"erro": str(e)}), 403
    except Exception as e:
        if supa.tabela_faltando(e):
            return _sem_tabela()
        raise
    if desvio is None:
        abort(404)
    return jsonify({"desvio": desvio})


@bp.route("/war-room/rodadas", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_rodada():
    # A rodada é do supervisor: é ele quem confere o próprio time. A tela só
    # mostra o cartão para ele, e a rota recusa o resto (decisão de 19/11/2026).
    u = usuario_atual()
    if not u["is_supervisor"]:
        return jsonify({"erro": "Só supervisor marca a rodada."}), 403
    try:
        rodadas = wr.marcar_rodada(_corpo(), u["id"])
    except wr.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        if supa.tabela_faltando(e):
            return _sem_tabela()
        raise
    return jsonify({"rodadas": rodadas})


@bp.route("/war-room/validacoes", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_validacao():
    """Sim/Não do supervisor para uma OS encerrada sem sucesso. Só supervisor
    responde (regra nº 1 do plano: a recusa passa pelo supervisor)."""
    u = usuario_atual()
    if not u["is_supervisor"]:
        return jsonify({"erro": "Só supervisor informa a validação."}), 403
    try:
        v = wr.marcar_validacao(_corpo(), u["id"])
    except wr.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        if supa.tabela_faltando(e):
            return jsonify({"erro": "A validação ainda não tem a tabela no banco "
                                    "(migration 0022_war_room_validacoes.sql)."}), 503
        raise
    return jsonify({"validacao": v})


def _sem_0024():
    return jsonify({"erro": "Esta gravação ainda não tem a tabela no banco "
                            "(migration 0024_responsaveis_e_presenca.sql)."}), 503


@bp.route("/war-room/presenca", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_presenca():
    """O supervisor corrige se o técnico esteve em campo (pedido de
    25/11/2026). Devolve o pacote do dia: a correção muda a capacidade em
    campo do topo, do gráfico e da linha do supervisor."""
    u = usuario_atual()
    if not u["is_supervisor"]:
        return jsonify({"erro": "Só supervisor corrige a presença."}), 403
    try:
        dia = wr.marcar_presenca(_corpo(), u["id"])
    except wr.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        if supa.tabela_faltando(e):
            return _sem_0024()
        raise
    return jsonify({"pacote": wr.pacote(dia)})


@bp.route("/war-room/responsavel", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_responsavel():
    """Resposta ao aviso de técnico sem responsável: o primeiro supervisor
    que responde decide para todos. O admin também pode responder — é quem
    reparte a UNETVALE quando nenhum supervisor está na mesa."""
    u = usuario_atual()
    if not (u["is_supervisor"] or u["is_admin"]):
        return jsonify({"erro": "Só supervisor define o responsável."}), 403
    try:
        r = wr.definir_responsavel(_corpo(), u["id"])
    except wr.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    except wr.Conflito as e:
        return jsonify({"erro": str(e), "conflito": True}), 409
    except Exception as e:
        if supa.tabela_faltando(e) or getattr(getattr(e, "response", None), "status_code", None) == 404:
            return _sem_0024()
        raise
    return jsonify(r)


@bp.route("/war-room/ofensores")
@login_obrigatorio
@modulo_obrigatorio("war-room")
def war_room_ofensores():
    """Top 5 dos técnicos ofensores por supervisor (pedido de 26/11/2026), o
    mesmo cálculo da visão do supervisor da Produtividade
    (`wr.visao_supervisores`), num período escolhido na War Room: o dia em
    foco, 7 dias ou o mês. Mesmo recorte da Produtividade: o supervisor
    recebe só o próprio time; os outros, todos."""
    from datetime import date
    u = usuario_atual()
    try:
        de = date.fromisoformat(request.args.get("de") or "")
        ate = date.fromisoformat(request.args.get("ate") or "")
    except ValueError:
        return jsonify({"erro": "Período inválido."}), 400
    permitidos = {u["id"]} if u["is_supervisor"] and not u["is_admin"] else None
    return jsonify(wr.visao_supervisores(de, ate, permitidos))
