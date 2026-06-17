"""Dashboard Unetvale — app Flask único (Vercel + Supabase).

Consolida os módulos Produtividade, IQI/IQM e Massivas numa interface só,
com login simples. Os dados são lidos da tabela `dados_modulo` no Supabase
(preenchida pelo coletor que roda dentro da VPN). O app nunca fala com o WVSA.
"""
import os

from flask import Flask
from dotenv import load_dotenv

load_dotenv()  # carrega .env em desenvolvimento local (na Vercel usa env vars)


def create_app():
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-inseguro-troque-em-producao")
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

    from .auth import bp as auth_bp
    from .routes import bp as routes_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(routes_bp)

    return app
