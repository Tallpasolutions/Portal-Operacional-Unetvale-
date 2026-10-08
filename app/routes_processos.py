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
    editor = _pacote_editor(p, fluxo) if fluxo else None
    return render_template(
        "processo.html", ativo="processos", sem_sync=True, aba=aba,
        processo=p, area=area, fluxos=fluxos, fluxo=fluxo, editor=editor, instrucoes=its,
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


# --------------------------------------------------------------------------
# Fluxos
# --------------------------------------------------------------------------
def _pacote_editor(p, fluxo):
    """O que a folha precisa para abrir — vai no HTML (`window.__FLUXO__`)."""
    editavel = p["status"] == "ativo"
    return {
        "id": fluxo["id"], "titulo": fluxo["titulo"], "versao": fluxo["versao"],
        "documento": fluxo["documento"],
        "processo": {"codigo": p["codigo"], "publico": p["publico"]},
        "editavel": editavel,
        "motivoLeitura": None if editavel else "Processo arquivado: só leitura.",
        "urls": {
            "salvar": url_for("dash.fluxo_salvar", fluxo_id=fluxo["id"]),
            "presenca": url_for("dash.fluxo_presenca", fluxo_id=fluxo["id"]),
            "versao": url_for("dash.fluxo_versao", fluxo_id=fluxo["id"]),
            "versoes": url_for("dash.fluxo_versoes", fluxo_id=fluxo["id"]),
            "versaoDoc": url_for("dash.fluxo_versao_doc", fluxo_id=fluxo["id"], versao_id="__ID__"),
            "novo": url_for("dash.fluxo_novo", codigo=p["codigo"]),
        },
    }


def _fluxo_ou_404(fluxo_id, documento=False):
    """Fluxo + o processo dele. Id torto vira 404 antes do banco."""
    if not pr.eh_uuid(fluxo_id):
        abort(404)
    if documento:
        f = pr.obter_fluxo(fluxo_id)
    else:
        f = supa.select_one("processo_fluxos", {"select": "id,processo_id,titulo,versao,arquivado",
                                                "id": f"eq.{fluxo_id}"})
    if not f:
        abort(404)
    p = supa.select_one("processos", {"select": "id,codigo,status,publico,area_id,titulo",
                                      "id": f"eq.{f['processo_id']}"})
    if not p:
        abort(404)
    return f, p


def _corpo_json():
    corpo = request.get_json(silent=True)
    return corpo if isinstance(corpo, dict) else None


@bp.route("/processos/fluxos/<fluxo_id>/salvar", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def fluxo_salvar(fluxo_id):
    u = usuario_atual()
    f, p = _fluxo_ou_404(fluxo_id)
    if p["status"] != "ativo":
        return _json_erro("Processo arquivado: reative para editar o fluxo.")
    corpo = _corpo_json()
    if corpo is None:
        return _json_erro("Corpo da requisição não é JSON.")
    try:
        r = pr.salvar_fluxo(f["id"], corpo.get("doc"), corpo.get("versao"), u["id"])
    except ValueError as e:
        return _json_erro(str(e))
    if r.get("ok"):
        return jsonify({"ok": True, "versao": r["versao"], "em": r.get("em")})
    if r.get("erro") == "conflito":
        # Quem e quando, já em português: é o que a faixa do editor mostra.
        nomes = _nomes(_usuarios_para_escolha())
        return _json_erro("conflito", 409, versao=r.get("versao"),
                          por_nome=nomes.get(r.get("por")) or "Outra pessoa",
                          em_hora=pr.hora_local(r.get("em"))[1] or None)
    if r.get("erro") == "inexistente":
        return _json_erro("Fluxo não encontrado.", 404)
    return _json_erro("Fluxo arquivado: não recebe alterações.")


@bp.route("/processos/fluxos/<fluxo_id>/presenca", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def fluxo_presenca(fluxo_id):
    u = usuario_atual()
    f, p = _fluxo_ou_404(fluxo_id)
    if p["status"] != "ativo":
        return jsonify({"outro": None})
    outro = pr.marcar_presenca(f, u["id"])
    nome = _nomes(_usuarios_para_escolha()).get(outro) if outro else None
    return jsonify({"outro": nome})


@bp.route("/processos/fluxos/<fluxo_id>/versao", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def fluxo_versao(fluxo_id):
    u = usuario_atual()
    f, p = _fluxo_ou_404(fluxo_id)
    if p["status"] != "ativo":
        return _json_erro("Processo arquivado.")
    corpo = _corpo_json() or {}
    motivo = corpo.get("motivo") if corpo.get("motivo") in ("manual", "antes_de_restaurar") else "manual"
    try:
        vid = pr.fotografar_fluxo(f["id"], corpo.get("nome"), u["id"], motivo)
    except ValueError as e:
        return _json_erro(str(e))
    return jsonify({"ok": True, "id": vid})


@bp.route("/processos/fluxos/<fluxo_id>/versoes")
@login_obrigatorio
@modulo_obrigatorio("processos")
def fluxo_versoes(fluxo_id):
    f, _ = _fluxo_ou_404(fluxo_id)
    nomes = _nomes(_usuarios_para_escolha())
    return jsonify({"versoes": [{
        "id": v["id"], "nome": v.get("nome"), "versao": v["versao"], "motivo": v["motivo"],
        "quando": " ".join(pr.hora_local(v["criado_em"])), "autor": nomes.get(v.get("criado_por")),
    } for v in pr.versoes_do_fluxo(f["id"])]})


@bp.route("/processos/fluxos/<fluxo_id>/versoes/<versao_id>")
@login_obrigatorio
@modulo_obrigatorio("processos")
def fluxo_versao_doc(fluxo_id, versao_id):
    f, _ = _fluxo_ou_404(fluxo_id)
    if not pr.eh_uuid(versao_id):
        abort(404)
    v = supa.select_one("processo_fluxo_versoes", {
        "select": "documento", "id": f"eq.{versao_id}", "fluxo_id": f"eq.{f['id']}"})
    if not v:
        abort(404)
    return jsonify({"documento": v["documento"]})


@bp.route("/processos/<codigo>/fluxos/novo", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def fluxo_novo(codigo):
    """Fluxo em branco (formulário) ou a cópia de quem perdeu um conflito
    (JSON com o documento) — a cópia é o que garante que nada se perde."""
    u = usuario_atual()
    p = _processo_ou_404(codigo)
    corpo = _corpo_json()
    if p["status"] != "ativo":
        if corpo is not None:
            return _json_erro("Processo arquivado.")
        flash("Processo arquivado não recebe fluxo novo.", "erro")
        return redirect(url_for("dash.processo_detalhe", codigo=p["codigo"]))
    dados = corpo if corpo is not None else request.form
    try:
        novo = pr.criar_fluxo(p, dados.get("titulo"), u["id"],
                              documento=(corpo or {}).get("documento"))
    except ValueError as e:
        if corpo is not None:
            return _json_erro(str(e))
        flash(str(e), "erro")
        return redirect(url_for("dash.processo_detalhe", codigo=p["codigo"], aba="fluxograma"))
    destino = url_for("dash.processo_detalhe", codigo=p["codigo"], aba="fluxograma", fluxo=novo["id"])
    if corpo is not None:
        return jsonify({"ok": True, "id": novo["id"], "url": destino})
    return redirect(destino)


@bp.route("/processos/fluxos/<fluxo_id>/renomear", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def fluxo_renomear(fluxo_id):
    f, p = _fluxo_ou_404(fluxo_id)
    destino = url_for("dash.processo_detalhe", codigo=p["codigo"], aba="fluxograma", fluxo=f["id"])
    if p["status"] != "ativo":
        flash("Processo arquivado.", "erro")
        return redirect(destino)
    try:
        pr.renomear_fluxo(f, request.form.get("titulo"))
    except ValueError as e:
        flash(str(e), "erro")
    return redirect(destino)
