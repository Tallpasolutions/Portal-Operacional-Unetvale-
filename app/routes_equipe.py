"""Rotas da Equipe técnica — no MESMO blueprint `dash`.

A regra mora em `app/equipe.py`. Quem vê é a matriz de Configurações
(`modulo_obrigatorio("equipe")`); quem EDITA é só o admin (decisão de
24/11/2026): o cadastro é a régua da capacidade de todas as telas, e o
vínculo supervisor × equipe da Produtividade também é do admin.
As escritas respondem JSON e a tela se redesenha no lugar.
"""
from datetime import datetime, timedelta, timezone

from flask import abort, jsonify, render_template, request

from . import equipe as eq
from . import supa
from .auth import login_obrigatorio, modulo_obrigatorio, usuario_atual
from .routes import bp

_BR = timezone(timedelta(hours=-3))


def _hoje():
    return datetime.now(timezone.utc).astimezone(_BR).date()


def _corpo():
    corpo = request.get_json(silent=True)
    if not isinstance(corpo, dict):
        abort(400)
    return corpo


def _so_admin():
    if not usuario_atual()["is_admin"]:
        return jsonify({"erro": "Só o administrador edita o cadastro da equipe."}), 403
    return None


def _sem_tabela():
    return jsonify({"erro": "O cadastro da equipe ainda não está no banco "
                            "(migration 0023_equipe_tecnica.sql)."}), 503


def _pacote():
    sups = eq.supervisores_lista()
    p = eq.pacote(_hoje(), sups)
    if p.get("tem_tabela"):
        nomes = {u["id"]: u.get("nome") or "—" for u in supa.select("usuarios", {"select": "id,nome"})}
        p["mudancas"] = eq.ultimas_mudancas(eq.historico(), nomes)
    p["hoje"] = _hoje().isoformat()
    return p


@bp.route("/equipe")
@login_obrigatorio
@modulo_obrigatorio("equipe")
def equipe_view():
    return render_template("equipe.html", ativo="equipe", pacote=_pacote())


@bp.route("/equipe/pdf")
@login_obrigatorio
@modulo_obrigatorio("equipe")
def equipe_pdf():
    """A planilha em papel, como a de 19/11/2026: página solta que imprime
    sozinha (o padrão do `reuniao_pdf.html`), sem sidebar nem topbar."""
    p = _pacote()
    if not p.get("tem_tabela"):
        abort(404)
    p["tecnicos"] = [t for t in p["tecnicos"] if t.get("ativo")]
    return render_template("equipe_pdf.html", pacote=p,
                           sup_nome={u["id"]: u["nome"] for u in p["supervisores"]})


@bp.route("/equipe/tecnicos", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("equipe")
def equipe_criar():
    negado = _so_admin()
    if negado:
        return negado
    corpo = _corpo()
    try:
        ids = {u["id"] for u in eq.supervisores_lista()}
        t = eq.criar(corpo, usuario_atual()["id"], ids)
    except eq.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        if supa.tabela_faltando(e):
            return _sem_tabela()
        raise
    return jsonify({"tecnico": t})


@bp.route("/equipe/tecnicos/<tecnico_id>", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("equipe")
def equipe_atualizar(tecnico_id):
    negado = _so_admin()
    if negado:
        return negado
    corpo = _corpo()
    campo = corpo.get("campo")
    if not isinstance(campo, str) or "valor" not in corpo:
        return jsonify({"erro": "Pedido inválido."}), 400
    try:
        ids = {u["id"] for u in eq.supervisores_lista()}
        t = eq.atualizar(tecnico_id, campo, corpo["valor"], usuario_atual()["id"], ids)
    except eq.Recusa as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        if supa.tabela_faltando(e):
            return _sem_tabela()
        raise
    if t is None:
        abort(404)
    return jsonify({"tecnico": t})
