"""Rotas do módulo Processos — no MESMO blueprint `dash` das demais.

Arquivo próprio só por tamanho: `routes.py` passou de 1.600 linhas, e o
módulo traz ~20 rotas. Os endpoints continuam `dash.*` e as rotas continuam
finas; a regra mora em `app/processos.py`.

Toda rota passa por `modulo_obrigatorio("processos")` — inclusive os PDFs e
as JSON. Esconder no menu não é permissão (CLAUDE.md §5), e o furo que ficou
em `/acoes/<id>` (sem o decorador) não se repete aqui.
"""
from datetime import datetime, timezone

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


@bp.app_template_filter("dia_br")
def _dia_br(iso_data):
    """'2026-10-08' (coluna `date`) -> '08/10/2026'. Sem fuso: é dia, não instante."""
    v = str(iso_data or "")[:10]
    return f"{v[8:10]}/{v[5:7]}/{v[0:4]}" if len(v) == 10 else "—"


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
        urls_fluxo_pdf=_url_fluxo_pdf(fluxo),
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


def _url_fluxo_pdf(fluxo):
    return url_for("dash.fluxo_pdf", fluxo_id=fluxo["id"]) if fluxo else None


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


# --------------------------------------------------------------------------
# Instruções de trabalho
# --------------------------------------------------------------------------
def _instrucao_ou_404(codigo):
    try:
        it = pr.obter_instrucao((codigo or "").upper())
    except Exception as e:
        if supa.tabela_faltando(e):
            abort(404)
        raise
    if not it:
        abort(404)
    p = supa.select_one("processos", {"select": "id,codigo,titulo,status,publico,area_id,objetivo,escopo",
                                      "id": f"eq.{it['processo_id']}"})
    if not p:
        abort(404)
    return it, p


def _rev_pedida():
    v = request.args.get("rev")
    if v is None or v == "":
        return None
    try:
        n = int(v)
    except ValueError:
        abort(404)
    if n < 0 or n > 999:
        abort(404)
    return n


def _pode_editar_it(it, p, rev):
    return (p["status"] == "ativo" and it["status"] == "ativa" and rev is not None
            and rev["status"] in ("rascunho", "devolvida"))


@bp.route("/processos/<codigo>/instrucoes/nova", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_nova(codigo):
    """Cria a IT. Os passos NÃO são gerados aqui: o gerador é um só, em
    fluxo_gerar_it.js, e a tela abre com a prévia da geração (`?gerar=1`)."""
    u = usuario_atual()
    p = _processo_ou_404(codigo)
    if p["status"] != "ativo":
        flash("Processo arquivado não recebe instrução nova.", "erro")
        return redirect(url_for("dash.processo_detalhe", codigo=p["codigo"], aba="instrucoes"))
    fluxo_id = request.form.get("fluxo_id") or None
    doc = None
    if fluxo_id:
        f = pr.obter_fluxo(fluxo_id)
        if not f or f["processo_id"] != p["id"]:
            flash("Esse fluxo não é deste processo.", "erro")
            return redirect(url_for("dash.processo_detalhe", codigo=p["codigo"], aba="instrucoes"))
        doc = f["documento"]
    try:
        novo = pr.criar_instrucao(p, request.form, u["id"], conteudo=pr.conteudo_inicial(p, doc))
    except ValueError as e:
        flash(str(e), "erro")
        return redirect(url_for("dash.processo_detalhe", codigo=p["codigo"], aba="instrucoes"))
    flash(f"Instrução {novo['codigo']} criada.", "ok")
    return redirect(url_for("dash.instrucao_detalhe", codigo=novo["codigo"],
                            gerar=1 if (fluxo_id and request.form.get("gerar")) else None))


@bp.route("/instrucoes/<codigo>")
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_detalhe(codigo):
    u = usuario_atual()
    it, p = _instrucao_ou_404(codigo)
    numero = _rev_pedida()
    revs, evs, usuarios, fluxos = supa.paralelo(
        lambda: pr.revisoes(it["id"]), lambda: pr.eventos_instrucao(it["id"]),
        _usuarios_para_escolha, lambda: pr.fluxos_do_processo(p["id"]))
    meta = pr.revisao_atual(revs, numero)
    if numero is not None and not meta:
        abort(404)
    rev = pr.obter_revisao(it["id"], meta["numero"], com_snapshot=True) if meta else None
    editavel = _pode_editar_it(it, p, rev)

    # O anexo: a foto congelada na aprovação; antes disso, o fluxo de hoje
    # (a tela avisa que é ele que será congelado).
    fluxo_doc, fluxo_titulo, congelado = None, None, False
    if rev and rev.get("fluxo_snapshot"):
        fluxo_doc, congelado = rev["fluxo_snapshot"], True
        fluxo_titulo = next((f["titulo"] for f in fluxos if f["id"] == it.get("fluxo_id")), "Fluxo")
    elif it.get("fluxo_id"):
        f = pr.obter_fluxo(it["fluxo_id"])
        if f:
            fluxo_doc, fluxo_titulo = f["documento"], f["titulo"]

    nomes = _nomes(usuarios)
    pacote = None
    if rev:
        pacote = {
            "codigo": it["codigo"], "rev": rev["numero"], "versao": rev["versao"],
            "status": rev["status"], "conteudo": rev.get("conteudo") or {},
            "editavel": editavel,
            "raias": [r.get("titulo") for r in (fluxo_doc or {}).get("raias", []) if r.get("titulo")],
            "fluxo": {"titulo": fluxo_titulo, "documento": fluxo_doc, "congelado": congelado} if fluxo_doc else None,
            "sugestoes": pr.SUGESTOES, "alertas": pr.ALERTAS_PRONTOS,
            "gerarAoAbrir": bool(request.args.get("gerar")) and editavel,
            "urls": {"salvar": url_for("dash.instrucao_rascunho", codigo=it["codigo"])},
        }
    eu_elaborei = bool(rev) and u["id"] in (rev.get("elaborado_por"), rev.get("enviado_por"))
    return render_template(
        "instrucao.html", ativo="processos", sem_sync=True,
        it=it, processo=p, rev=rev, revisoes=revs, eventos=evs, nomes=nomes,
        fluxos=fluxos, pacote=pacote, editavel=editavel, conteudo=(rev or {}).get("conteudo") or {},
        executa=pr.EXECUTA, publicos=pr.PUBLICOS, status_revisao=pr.STATUS_REVISAO,
        pode_aprovar=pr.pode_aprovar(u, p), eu_elaborei=eu_elaborei,
        tem_aberta=any(r["status"] in pr.ABERTAS for r in revs),
        fluxo_doc=fluxo_doc, fluxo_titulo=fluxo_titulo, fluxo_congelado=congelado)


@bp.route("/instrucoes/<codigo>/rascunho", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_rascunho(codigo):
    u = usuario_atual()
    it, p = _instrucao_ou_404(codigo)
    corpo = _corpo_json()
    if corpo is None:
        return _json_erro("Corpo da requisição não é JSON.")
    if p["status"] != "ativo" or it["status"] != "ativa":
        return _json_erro("Instrução ou processo fora de uso: só leitura.")
    numero = corpo.get("rev")
    if not isinstance(numero, int) or isinstance(numero, bool):
        return _json_erro("Revisão não informada.")
    rev = pr.obter_revisao(it["id"], numero)
    if not rev:
        return _json_erro("Revisão não encontrada.", 404)
    try:
        conteudo = pr.normalizar_conteudo(corpo.get("conteudo"))
        r = pr.salvar_rascunho(rev["id"], conteudo, corpo.get("versao"), u["id"])
    except ValueError as e:
        return _json_erro(str(e))
    if r.get("ok"):
        return jsonify({"ok": True, "versao": r["versao"]})
    if r.get("erro") == "conflito":
        nomes = _nomes(_usuarios_para_escolha())
        return _json_erro("conflito", 409, por_nome=nomes.get(r.get("por")) or "Outra pessoa",
                          em_hora=pr.hora_local(r.get("em"))[1] or None)
    if r.get("erro") == "bloqueada":
        return _json_erro("Esta revisão saiu do rascunho (" +
                          pr.STATUS_REVISAO.get(r.get("status"), r.get("status") or "") +
                          "): recarregue a página.", 409)
    return _json_erro("Revisão não encontrada.", 404)


def _acao_it(codigo, fn, ok_msg, exige_gestor=False):
    """Envio, aprovação, devolução… — forms com o mesmo esqueleto: confere,
    chama a função do banco (que tem as travas) e volta para a IT."""
    u = usuario_atual()
    it, p = _instrucao_ou_404(codigo)
    if exige_gestor and not pr.pode_aprovar(u, p):
        abort(403)
    if p["status"] != "ativo":
        flash("Processo arquivado: só leitura.", "erro")
        return redirect(url_for("dash.instrucao_detalhe", codigo=it["codigo"]))
    try:
        fn(u, it, p)
        flash(ok_msg, "ok")
    except ValueError as e:
        flash(str(e)[:1].upper() + str(e)[1:] + ".", "erro")
    return redirect(url_for("dash.instrucao_detalhe", codigo=it["codigo"]))


def _rev_aberta(it):
    revs = pr.revisoes(it["id"])
    aberta = next((r for r in revs if r["status"] in pr.ABERTAS), None)
    if not aberta:
        raise ValueError("não há revisão em andamento")
    return aberta


@bp.route("/instrucoes/<codigo>/enviar", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_enviar(codigo):
    def fn(u, it, p):
        if it["status"] != "ativa":
            raise ValueError("instrução obsoleta")
        pr.enviar(_rev_aberta(it)["id"], u["id"])
    return _acao_it(codigo, fn, "Enviada para aprovação.")


@bp.route("/instrucoes/<codigo>/aprovar", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_aprovar(codigo):
    def fn(u, it, p):
        pr.aprovar(_rev_aberta(it)["id"], u["id"])
    return _acao_it(codigo, fn, "Revisão aprovada: agora é a vigente.", exige_gestor=True)


@bp.route("/instrucoes/<codigo>/devolver", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_devolver(codigo):
    def fn(u, it, p):
        pr.devolver(_rev_aberta(it)["id"], u["id"], request.form.get("motivo"))
    return _acao_it(codigo, fn, "Revisão devolvida com o motivo.", exige_gestor=True)


@bp.route("/instrucoes/<codigo>/nova-revisao", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_nova_revisao(codigo):
    def fn(u, it, p):
        if it["status"] != "ativa":
            raise ValueError("instrução obsoleta: reative antes")
        pr.nova_revisao(it["id"], u["id"], request.form.get("motivo"))
    return _acao_it(codigo, fn, "Nova revisão aberta a partir da vigente.")


@bp.route("/instrucoes/<codigo>/status", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_status(codigo):
    novo = request.form.get("status")

    def fn(u, it, p):
        pr.definir_status_instrucao(it["id"], novo, u["id"], request.form.get("motivo"))
    return _acao_it(codigo, fn, "Instrução obsoleta: saiu das listas." if novo == "obsoleta"
                    else "Instrução reativada.", exige_gestor=True)


@bp.route("/instrucoes/<codigo>/fluxo", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_fluxo(codigo):
    """Troca o fluxo de origem — só enquanto há rascunho: a revisão aprovada
    já tem o dela congelado."""
    def fn(u, it, p):
        rev = _rev_aberta(it)
        if rev["status"] not in ("rascunho", "devolvida"):
            raise ValueError("só no rascunho")
        fid = request.form.get("fluxo_id") or None
        if fid and not any(f["id"] == fid for f in pr.fluxos_do_processo(p["id"])):
            raise ValueError("esse fluxo não é deste processo")
        supa.update("instrucoes", {"id": it["id"]}, {"fluxo_id": fid, "atualizado_em": pr._agora()})
    return _acao_it(codigo, fn, "Fluxo de origem trocado.")


# --------------------------------------------------------------------------
# PDF — página solta que imprime sozinha (o mesmo desenho do PDF das
# reuniões): quem gera o arquivo é o navegador, sem biblioteca de PDF na
# função serverless.
# --------------------------------------------------------------------------
def _agora_br():
    return " ".join(pr.hora_local(datetime.now(timezone.utc).isoformat()))


@bp.route("/instrucoes/<codigo>/pdf")
@login_obrigatorio
@modulo_obrigatorio("processos")
def instrucao_pdf(codigo):
    it, p = _instrucao_ou_404(codigo)
    numero = _rev_pedida()
    revs, usuarios, fluxos = supa.paralelo(
        lambda: pr.revisoes(it["id"]), _usuarios_para_escolha,
        lambda: pr.fluxos_do_processo(p["id"]))
    meta = pr.revisao_atual(revs, numero)
    if not meta:
        abort(404)
    rev = pr.obter_revisao(it["id"], meta["numero"], com_snapshot=True)
    fluxo_doc, congelado = None, False
    fluxo_titulo = next((f["titulo"] for f in fluxos if f["id"] == it.get("fluxo_id")), None)
    if rev.get("fluxo_snapshot"):
        fluxo_doc, congelado = rev["fluxo_snapshot"], True
    elif it.get("fluxo_id"):
        f = pr.obter_fluxo(it["fluxo_id"])
        fluxo_doc = f["documento"] if f else None
    u = usuario_atual()
    return render_template(
        "instrucao_pdf.html", it=it, processo=p, rev=rev, revisoes=revs,
        conteudo=rev.get("conteudo") or {}, nomes=_nomes(usuarios),
        executa=pr.EXECUTA, status_revisao=pr.STATUS_REVISAO,
        fluxo_doc=fluxo_doc, fluxo_titulo=fluxo_titulo, fluxo_congelado=congelado,
        impresso_em=_agora_br(), impresso_por=u.get("nome") or "—",
        imprimir=request.args.get("imprimir") != "0")


@bp.route("/processos/fluxos/<fluxo_id>/pdf")
@login_obrigatorio
@modulo_obrigatorio("processos")
def fluxo_pdf(fluxo_id):
    f, p = _fluxo_ou_404(fluxo_id, documento=True)
    u = usuario_atual()
    return render_template(
        "fluxo_pdf.html", fluxo=f, processo=p, nomes=_nomes(_usuarios_para_escolha()),
        impresso_em=_agora_br(), impresso_por=u.get("nome") or "—",
        imprimir=request.args.get("imprimir") != "0")
