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
