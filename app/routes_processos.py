"""Rotas do módulo Processos — no MESMO blueprint `dash` das demais.

Arquivo próprio só por tamanho: `routes.py` passou de 1.600 linhas, e o
módulo traz ~20 rotas. Os endpoints continuam `dash.*` e as rotas continuam
finas; a regra mora em `app/processos.py`.

Toda rota passa por `modulo_obrigatorio("processos")` — inclusive os PDFs e
as JSON. Esconder no menu não é permissão (CLAUDE.md §5), e o furo que ficou
em `/acoes/<id>` (sem o decorador) não se repete aqui.
"""
from flask import abort, flash, jsonify, redirect, render_template, request, url_for

from . import processos as pr
from . import supa
from .auth import login_obrigatorio, modulo_obrigatorio, usuario_atual
from .routes import _usuarios_para_escolha, bp


@bp.app_template_filter("data_br")
def _data_br(iso):
    """'2026-10-08T23:10:00+00:00' -> '08/10/2026' no fuso de Brasília.

    Cortar o texto ISO (`[:10]`) daria a data em UTC: o que foi salvo às 21h
    apareceria como do dia seguinte (CLAUDE.md §6)."""
    return pr.hora_local(iso)[0] or "—"


@bp.app_template_filter("data_hora_br")
def _data_hora_br(iso):
    d, h = pr.hora_local(iso)
    return f"{d} {h}" if d else "—"


def _nomes(usuarios):
    return {x["id"]: (x.get("nome") or x["email"].split("@")[0]) for x in usuarios}


def _processo_ou_404(codigo):
    """404 tanto para código inexistente quanto para entrada torta: a rota
    nunca chega ao banco com lixo, e o 404 é a resposta honesta para os dois."""
    try:
        p = pr.obter_processo((codigo or "").upper())
    except Exception as e:
        if supa.tabela_faltando(e):
            abort(404)
        raise
    if not p:
        abort(404)
    return p


def _sem_migracao():
    return render_template("processos.html", ativo="processos", sem_sync=True,
                           sem_migracao=True, aba="processos", processos=[],
                           instrucoes=[], areas=[], usuarios=[], nomes={},
                           contagens={}, publicos=pr.PUBLICOS, executa=pr.EXECUTA,
                           status_revisao=pr.STATUS_REVISAO, resumo={})


# --------------------------------------------------------------------------
# Catálogo
# --------------------------------------------------------------------------
@bp.route("/processos")
@login_obrigatorio
@modulo_obrigatorio("processos")
def processos_view():
    aba = request.args.get("aba", "processos")
    if aba not in ("processos", "instrucoes"):
        aba = "processos"
    try:
        lista, its, cont, areas, usuarios = supa.paralelo(
            pr.listar_processos, pr.listar_instrucoes, pr.contagens_por_processo,
            pr.areas, _usuarios_para_escolha)
    except Exception as e:
        # Antes da 0018 subir, a tela diz o que falta em vez de devolver 500.
        if supa.tabela_faltando(e):
            return _sem_migracao()
        raise

    por_id = {p["id"]: p for p in lista}
    for it in its:
        it["processo"] = por_id.get(it["processo_id"])
    resumo = {
        "processos": len(lista),
        "fluxos": sum(c["fluxos"] for c in cont.values()),
        "vigentes": sum(1 for it in its if it.get("revisao_vigente") is not None),
        "em_aprovacao": sum(1 for it in its
                            if (it.get("aberta") or {}).get("status") == "em_aprovacao"),
    }
    return render_template(
        "processos.html", ativo="processos", sem_sync=True, aba=aba,
        processos=lista, instrucoes=[it for it in its if it["processo"]],
        contagens=cont, areas=areas, usuarios=usuarios, nomes=_nomes(usuarios),
        publicos=pr.PUBLICOS, executa=pr.EXECUTA,
        status_revisao=pr.STATUS_REVISAO, resumo=resumo)


@bp.route("/processos/novo", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def processo_novo():
    u = usuario_atual()
    try:
        novo = pr.criar_processo(request.form, u["id"])
    except ValueError as e:
        flash(str(e), "erro")
        return redirect(url_for("dash.processos_view"))
    flash(f"Processo {novo['codigo']} criado. Comece pelo fluxo.", "ok")
    return redirect(url_for("dash.processo_detalhe", codigo=novo["codigo"],
                            aba="fluxograma"))


# --------------------------------------------------------------------------
# Página do processo
# --------------------------------------------------------------------------
@bp.route("/processos/<codigo>")
@login_obrigatorio
@modulo_obrigatorio("processos")
def processo_detalhe(codigo):
    u = usuario_atual()
    p = _processo_ou_404(codigo)
    aba = request.args.get("aba", "visao")
    if aba not in ("visao", "fluxograma", "instrucoes"):
        aba = "visao"
    fluxos, its, areas, usuarios = supa.paralelo(
        lambda: pr.fluxos_do_processo(p["id"]),
        lambda: pr.listar_instrucoes(p["id"], incluir_obsoletas=True),
        pr.areas, _usuarios_para_escolha)

    # O fluxo aberto vem no HTML (uma ida a menos que buscar depois). Só na
    # aba do fluxograma: as outras não pagam o documento, que é a parte pesada.
    fluxo = None
    if aba == "fluxograma" and fluxos:
        escolhido = request.args.get("fluxo")
        meta = next((f for f in fluxos if f["id"] == escolhido), fluxos[0])
        fluxo = pr.obter_fluxo(meta["id"])

    area = next((a for a in areas if a["id"] == p["area_id"]), None)
    return render_template(
        "processo.html", ativo="processos", sem_sync=True, aba=aba,
        processo=p, area=area, fluxos=fluxos, fluxo=fluxo, instrucoes=its,
        usuarios=usuarios, nomes=_nomes(usuarios),
        publicos=pr.PUBLICOS, executa=pr.EXECUTA,
        status_revisao=pr.STATUS_REVISAO,
        pode_aprovar=pr.pode_aprovar(u, p), eu=u["id"])


@bp.route("/processos/<codigo>/editar", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def processo_editar(codigo):
    p = _processo_ou_404(codigo)
    if p["status"] != "ativo":
        flash("Processo arquivado não se edita. Reative antes.", "erro")
        return redirect(url_for("dash.processo_detalhe", codigo=p["codigo"]))
    campos = {k: request.form[k] for k in
              ("titulo", "objetivo", "escopo", "entradas", "saidas", "publico", "dono_id")
              if k in request.form}
    try:
        pr.editar_processo(p, campos)
        flash("Processo atualizado.", "ok")
    except ValueError as e:
        flash(str(e), "erro")
    return redirect(url_for("dash.processo_detalhe", codigo=p["codigo"]))


@bp.route("/processos/<codigo>/status", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def processo_status(codigo):
    """Arquivar e reativar. Gestor da área ou admin: some do catálogo de
    todo mundo, então não é decisão de quem só está desenhando."""
    u = usuario_atual()
    p = _processo_ou_404(codigo)
    if not pr.pode_aprovar(u, p):
        abort(403)
    novo = request.form.get("status")
    try:
        pr.definir_status_processo(p, novo)
    except ValueError as e:
        flash(str(e), "erro")
        return redirect(url_for("dash.processo_detalhe", codigo=p["codigo"]))
    flash("Processo arquivado." if novo == "arquivado" else "Processo reativado.", "ok")
    return redirect(url_for("dash.processos_view") if novo == "arquivado"
                    else url_for("dash.processo_detalhe", codigo=p["codigo"]))


def _json_erro(msg, status=400, **extra):
    return jsonify({"ok": False, "erro": msg, **extra}), status
