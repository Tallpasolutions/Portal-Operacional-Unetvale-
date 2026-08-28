"""Autenticação. Apenas o ADMIN (e-mail em ADMIN_EMAIL) pode criar usuários e
acessar Usuários/Configurações. Os demais só visualizam os dashboards e podem
pedir recuperação de senha por e-mail. Sem cadastro público.

Senhas com hash (werkzeug) na tabela `usuarios` do Supabase. Sessão via cookie
assinado do Flask (stateless — funciona no serverless).
"""
import functools
import os

from flask import (
    Blueprint, g, redirect, render_template, request, session, url_for, flash, abort
)
from werkzeug.security import check_password_hash, generate_password_hash

from . import supa

bp = Blueprint("auth", __name__)


def _admin_email():
    return (os.environ.get("ADMIN_EMAIL", "") or "").strip().lower()


def _eh_supervisor_cache(uid):
    """`eh_supervisor` uma vez por requisição.

    `usuario_atual()` é chamada pelo context processor e por várias rotas; sem
    cache seriam várias idas ao PostgREST na mesma requisição, e numa função
    serverless isso aparece no tempo de resposta. `g` vive só o request, então
    a informação nunca fica velha entre páginas.
    """
    if not uid:
        return False
    if not hasattr(g, "_eh_supervisor"):
        from . import supervisores
        g._eh_supervisor = supervisores.eh_supervisor(uid)
    return g._eh_supervisor


def _areas_gestor_cache(uid):
    """Áreas que a pessoa gerencia no módulo Ações.

    Mesmo cache por requisição do supervisor, e pelo mesmo motivo: sem ele
    seriam várias idas ao PostgREST na mesma requisição.
    """
    if not uid:
        return []
    if not hasattr(g, "_areas_gestor"):
        from . import acoes
        g._areas_gestor = acoes.areas_do_gestor(uid)
    return g._areas_gestor


def usuario_atual():
    email = session.get("email")
    uid = session.get("uid")
    eh_sup = _eh_supervisor_cache(uid)
    eh_admin = bool(email) and email == _admin_email()
    areas_gestor = _areas_gestor_cache(uid)
    return {
        "id": session.get("uid"),
        "nome": session.get("nome"),
        "email": email,
        "is_admin": eh_admin,
        "is_supervisor": eh_sup,
        # Supervisor não enxerga Troca de Poste: o módulo é de infraestrutura
        # e não tem recorte por equipe operacional.
        "ve_troca_poste": not eh_sup or eh_admin,
        # Ações: gestor é papel próprio do módulo, por área. Não se confunde
        # com supervisor, que é de equipe de campo — a pessoa pode ser um,
        # outro, os dois ou nenhum.
        "areas_gestor": areas_gestor,
        "is_gestor_acoes": eh_admin or bool(areas_gestor),
    }


def login_obrigatorio(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("uid"):
            return redirect(url_for("auth.login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def admin_obrigatorio(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("uid"):
            return redirect(url_for("auth.login", next=request.path))
        if (session.get("email") or "").lower() != _admin_email():
            abort(403)
        return view(*args, **kwargs)
    return wrapped


@bp.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        senha = request.form.get("senha") or ""
        try:
            u = supa.select_one("usuarios", {"email": f"eq.{email}", "select": "*"})
        except Exception as e:
            flash(f"Erro ao acessar o banco: {e}", "erro")
            return render_template("login.html")
        if not u or not check_password_hash(u["senha_hash"], senha):
            flash("E-mail ou senha incorretos.", "erro")
            return render_template("login.html")
        session.clear()
        session["uid"] = u["id"]
        session["nome"] = u.get("nome") or email.split("@")[0]
        session["email"] = u["email"]
        destino = request.args.get("next") or url_for("dash.produtividade")
        return redirect(destino)
    return render_template("login.html")


@bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))


@bp.route("/usuarios/criar", methods=["POST"])
@admin_obrigatorio
def criar_usuario():
    """Cria um novo usuário (somente admin). Formulário fica na tela Usuários."""
    nome = (request.form.get("nome") or "").strip()
    email = (request.form.get("email") or "").strip().lower()
    senha = request.form.get("senha") or ""
    if not email or not senha:
        flash("Preencha e-mail e senha.", "erro")
        return redirect(url_for("dash.usuarios"))
    if len(senha) < 6:
        flash("A senha deve ter ao menos 6 caracteres.", "erro")
        return redirect(url_for("dash.usuarios"))
    try:
        existe = supa.select_one("usuarios", {"email": f"eq.{email}", "select": "id"})
        if existe:
            flash("Já existe um usuário com este e-mail.", "erro")
            return redirect(url_for("dash.usuarios"))
        supa.insert("usuarios", {
            "email": email,
            "nome": nome or email.split("@")[0],
            "senha_hash": generate_password_hash(senha),
        })
    except Exception as e:
        flash(f"Erro ao criar usuário: {e}", "erro")
        return redirect(url_for("dash.usuarios"))
    flash(f"Usuário {email} criado.", "ok")
    return redirect(url_for("dash.usuarios"))


@bp.route("/senha", methods=["GET", "POST"])
@login_obrigatorio
def trocar_senha():
    if request.method == "POST":
        atual = request.form.get("atual") or ""
        nova = request.form.get("nova") or ""
        nova2 = request.form.get("nova2") or ""
        try:
            u = supa.select_one("usuarios", {"id": f"eq.{session['uid']}", "select": "*"})
            if not u or not check_password_hash(u["senha_hash"], atual):
                flash("Senha atual incorreta.", "erro")
                return render_template("configuracoes.html", usuario=usuario_atual())
            if nova != nova2:
                flash("A confirmação não confere.", "erro")
                return render_template("configuracoes.html", usuario=usuario_atual())
            if len(nova) < 6:
                flash("A nova senha deve ter ao menos 6 caracteres.", "erro")
                return render_template("configuracoes.html", usuario=usuario_atual())
            supa.update("usuarios", {"id": session["uid"]},
                        {"senha_hash": generate_password_hash(nova)})
        except Exception as e:
            flash(f"Erro ao trocar a senha: {e}", "erro")
            return render_template("configuracoes.html", usuario=usuario_atual())
        flash("Senha alterada com sucesso.", "ok")
        return redirect(url_for("dash.configuracoes"))
    return render_template("configuracoes.html", usuario=usuario_atual())


@bp.route("/usuarios/senha", methods=["POST"])
@admin_obrigatorio
def redefinir_senha_usuario():
    """Admin redefine a senha de qualquer usuário (não há recuperação por e-mail)."""
    email = (request.form.get("email") or "").strip().lower()
    nova = request.form.get("senha") or ""
    if not email or len(nova) < 6:
        flash("Informe o usuário e uma senha de ao menos 6 caracteres.", "erro")
        return redirect(url_for("dash.usuarios"))
    try:
        alvo = supa.select_one("usuarios", {"email": f"eq.{email}", "select": "id"})
        if not alvo:
            flash("Usuário não encontrado.", "erro")
            return redirect(url_for("dash.usuarios"))
        supa.update("usuarios", {"email": email}, {"senha_hash": generate_password_hash(nova)})
    except Exception as e:
        flash(f"Erro ao redefinir senha: {e}", "erro")
        return redirect(url_for("dash.usuarios"))
    flash(f"Senha de {email} redefinida.", "ok")
    return redirect(url_for("dash.usuarios"))
