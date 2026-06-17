"""Autenticação simples: login, cadastro e troca de senha.

Todos os usuários têm exatamente a mesma permissão (sem RBAC, sem perfis).
Senhas guardadas com hash (werkzeug) na tabela `usuarios` do Supabase.
Sessão via cookie assinado do Flask (stateless — funciona no serverless).
"""
import functools

from flask import (
    Blueprint, redirect, render_template, request, session, url_for, flash
)
from werkzeug.security import check_password_hash, generate_password_hash

from . import supa

bp = Blueprint("auth", __name__)


def login_obrigatorio(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("uid"):
            return redirect(url_for("auth.login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def usuario_atual():
    return {"id": session.get("uid"), "nome": session.get("nome"), "email": session.get("email")}


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
        destino = request.args.get("next") or url_for("dash.dashboard")
        return redirect(destino)
    return render_template("login.html")


@bp.route("/cadastro", methods=["GET", "POST"])
def cadastro():
    if request.method == "POST":
        nome = (request.form.get("nome") or "").strip()
        email = (request.form.get("email") or "").strip().lower()
        senha = request.form.get("senha") or ""
        senha2 = request.form.get("senha2") or ""
        if not email or not senha:
            flash("Preencha e-mail e senha.", "erro")
            return render_template("cadastro.html")
        if senha != senha2:
            flash("As senhas não conferem.", "erro")
            return render_template("cadastro.html")
        if len(senha) < 6:
            flash("A senha deve ter ao menos 6 caracteres.", "erro")
            return render_template("cadastro.html")
        try:
            existe = supa.select_one("usuarios", {"email": f"eq.{email}", "select": "id"})
            if existe:
                flash("Já existe um usuário com este e-mail.", "erro")
                return render_template("cadastro.html")
            supa.insert("usuarios", {
                "email": email,
                "nome": nome or email.split("@")[0],
                "senha_hash": generate_password_hash(senha),
            })
        except Exception as e:
            flash(f"Erro ao cadastrar: {e}", "erro")
            return render_template("cadastro.html")
        flash("Conta criada! Faça login.", "ok")
        return redirect(url_for("auth.login"))
    return render_template("cadastro.html")


@bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))


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
