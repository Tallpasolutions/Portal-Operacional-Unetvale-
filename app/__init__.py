"""Dashboard Unetvale — app Flask único (Vercel + Supabase).

Consolida os módulos Produtividade, IQI/IQM e Massivas numa interface só,
com login simples. Os dados são lidos da tabela `dados_modulo` no Supabase
(preenchida pelo coletor que roda dentro da VPN). O app nunca fala com o WVSA.
"""
import os
import sys
import time
from pathlib import Path

from flask import Flask, g, request
from dotenv import load_dotenv

load_dotenv()  # carrega .env em desenvolvimento local (na Vercel usa env vars)


def _versao_estatico(pasta):
    """Carimbo que vai em `?v=` de todo arquivo estático.

    Na Vercel o estático é servido pela CDN com cache de um ano (`immutable`,
    ver `vercel.json`): o navegador não pergunta de novo. Sem um carimbo que
    muda a cada deploy, um JS novo ficaria preso atrás do velho no cache de
    quem já abriu o portal. O commit do deploy é esse carimbo; localmente, o
    arquivo mais recente da pasta.
    """
    sha = os.environ.get("VERCEL_GIT_COMMIT_SHA", "")
    if sha:
        return sha[:8]
    try:
        return str(int(max(p.stat().st_mtime for p in Path(pasta).rglob("*") if p.is_file())))
    except ValueError:
        return "0"


def create_app():
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-inseguro-troque-em-producao")
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

    versao = _versao_estatico(app.static_folder)

    @app.url_defaults
    def _carimbar_estatico(endpoint, valores):
        # Todo `url_for('static', ...)` dos templates ganha o carimbo sem que
        # nenhum template precise saber disso.
        if endpoint == "static" and "v" not in valores:
            valores["v"] = versao

    @app.before_request
    def _cronometro():
        g._inicio = time.perf_counter()

    @app.after_request
    def _server_timing(resp):
        # Quanto da requisição foi espera pelo Supabase, e em quantas idas.
        # Aparece na aba Network do navegador (Timing) e no log da Vercel —
        # é a régua de antes/depois de qualquer otimização (07/10/2026).
        # `supa` é a SOMA das idas: com consultas em paralelo ela passa do
        # total, e é assim que se vê que o paralelo está funcionando.
        inicio = getattr(g, "_inicio", None)
        if inicio is None or request.endpoint == "static":
            return resp
        total = (time.perf_counter() - inicio) * 1000
        n = getattr(g, "_supa_n", 0)
        ms = getattr(g, "_supa_ms", 0.0)
        resp.headers["Server-Timing"] = (
            f'supa;desc="{n} idas";dur={ms:.0f}, total;dur={total:.0f}')
        print(f"[tempo] {request.method} {request.path} {resp.status_code} "
              f"total={total:.0f}ms supa={n}x/{ms:.0f}ms", file=sys.stderr)
        return resp

    from .auth import bp as auth_bp
    from .routes import bp as routes_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(routes_bp)

    return app
