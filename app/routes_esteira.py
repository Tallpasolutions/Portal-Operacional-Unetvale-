"""Rotas do módulo Esteira de Agendamento — no MESMO blueprint `dash`.

Arquivo próprio pela mesma razão de `routes_processos.py` (`routes.py` passa
de 1.600 linhas). A regra mora em `app/esteira.py`; daqui só sai leitura.

Sem botão "Atualizar": forçar coleta é ação de operação e mora no
/monitoramento (§6). E o app não alcança o WVSA de qualquer jeito.
"""
import re
from datetime import date

from flask import abort, jsonify, render_template, request

from . import esteira as es
from . import supa
from .auth import login_obrigatorio, modulo_obrigatorio
from .routes import bp

_DIA = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@bp.route("/esteira")
@login_obrigatorio
@modulo_obrigatorio("esteira")
def esteira_view():
    try:
        pacote = es.pacote()
    except Exception as e:
        # Deploy antes da migration: a tela diz o que falta, sem 500.
        if supa.tabela_faltando(e):
            return render_template("esteira.html", ativo="esteira", pacote=None,
                                   sem_migration=True)
        raise
    return render_template("esteira.html", ativo="esteira", pacote=pacote, sem_migration=False)


@bp.route("/esteira/movimentos")
@login_obrigatorio
@modulo_obrigatorio("esteira")
def esteira_movimentos():
    """OS que entraram (`tipo=ent`) ou saíram (`sai`) da fila num dia operacional."""
    dia = request.args.get("dia", "")
    tipo = request.args.get("tipo", "")
    if tipo not in ("ent", "sai") or not _DIA.match(dia):
        abort(400)
    try:
        date.fromisoformat(dia)          # 2026-02-30 passa na regex
    except ValueError:
        abort(400)
    return jsonify({"dia": dia, "tipo": tipo, "os": es.movimentos_do_dia(dia, tipo)})
