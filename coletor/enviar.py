#!/usr/bin/env python3
"""Coletor consolidado — roda DENTRO da VPN (acessa o WVSA) e envia os dados
para o Supabase, que alimenta o Dashboard Unetvale na Vercel.

Reaproveita os scripts originais SEM mudar a lógica de negócio:
  - extrator.py    -> Produtividade (mantém SQLite local p/ histórico incremental)
  - w8_client.py   -> IQI / IQM
  - fetch_wvsa.py  -> Massivas (model.json)

Cada módulo vira um upsert na tabela `dados_modulo` (modulo, payload, status).
Agende com cron às 08/10/12/14/16/18h (ver README).

Uso:
  python enviar.py                 # todos os módulos (incremental)
  python enviar.py --full          # reconstrói o histórico da Produtividade
  python enviar.py --so iqi        # roda só um módulo (produtividade|iqi|massivas)
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

DIR = Path(__file__).resolve().parent
load_dotenv(DIR / ".env")

PYTHON = sys.executable
DB_PATH = DIR / "dados.db"
MODEL_PATH = DIR / "model.json"
CONFIG_PATH = DIR / "config.json"


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# --------------------------------------------------------------------------
# Supabase
# --------------------------------------------------------------------------
def supa_upsert(modulo, payload, status="ok"):
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_KEY"]
    r = requests.post(
        f"{url}/rest/v1/dados_modulo",
        params={"on_conflict": "modulo"},
        headers={
            "apikey": key, "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json={
            "modulo": modulo, "payload": payload, "status": status,
            "atualizado_em": datetime.now(timezone.utc).isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()
    log(f"  -> Supabase: {modulo} ({status})")


def marcar_erro(modulo, erro):
    try:
        supa_upsert(modulo, {"erro": str(erro)[:500]}, status="erro")
    except Exception as e:
        log(f"  !! não consegui registrar erro de {modulo}: {e}")


# --------------------------------------------------------------------------
# Garante config.json do extrator a partir das variáveis de ambiente
# --------------------------------------------------------------------------
def garantir_config():
    cfg = {
        "base_url": os.environ.get("W8_BASE", "https://wvsa8.unetvale.com.br"),
        "username": os.environ.get("W8_USER", ""),
        "password": os.environ.get("W8_PASS", ""),
        "data_inicio_historico": os.environ.get("HISTORICO_INICIO", "01/01/2026"),
    }
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------
# Produtividade
# --------------------------------------------------------------------------
def coletar_produtividade(full=False):
    garantir_config()
    if full:
        cmd = [PYTHON, str(DIR / "extrator.py"), "--full"]
    else:
        cmd = [PYTHON, str(DIR / "extrator.py"), "--mes-atual"]
    log(f"Produtividade: {' '.join(cmd[1:])}")
    subprocess.run(cmd, cwd=DIR, check=True, timeout=1800)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT dia, empresa, tecnico, tecnico_id, finalidade, sucesso, os FROM os WHERE dia != ''"
    ).fetchall()
    registros = [{
        "d": r["dia"], "e": r["empresa"] or "—", "t": r["tecnico"] or "—",
        "ti": r["tecnico_id"], "f": r["finalidade"] or "—", "s": r["sucesso"], "os": r["os"],
    } for r in rows]
    meta = {m["chave"]: m["valor"] for m in conn.execute("SELECT chave, valor FROM meta")}
    conn.close()
    payload = {
        "registros": registros, "total": len(registros),
        "ultima_atualizacao": meta.get("ultima_atualizacao"),
        "intervalo": meta.get("intervalo"),
    }
    supa_upsert("produtividade", payload)


# --------------------------------------------------------------------------
# IQI / IQM
# --------------------------------------------------------------------------
def coletar_iqi():
    import w8_client  # usa W8_USER / W8_PASS / W8_BASE do ambiente
    for ind, modulo in (("IQI", "iqi"), ("IQM", "iqm")):
        log(f"{ind}: coletando…")
        payload = w8_client.coletar(ind)
        supa_upsert(modulo, payload)


# --------------------------------------------------------------------------
# Massivas
# --------------------------------------------------------------------------
def coletar_massivas():
    env = {**os.environ, "MODEL_OUT": str(MODEL_PATH),
           "WVSA_USER": os.environ.get("W8_USER", os.environ.get("WVSA_USER", "")),
           "WVSA_PASS": os.environ.get("W8_PASS", os.environ.get("WVSA_PASS", ""))}
    log("Massivas: fetch_wvsa.py…")
    subprocess.run([PYTHON, str(DIR / "fetch_wvsa.py")], cwd=DIR, check=True, timeout=1800, env=env)
    payload = json.loads(MODEL_PATH.read_text(encoding="utf-8"))
    supa_upsert("massivas", payload)


# --------------------------------------------------------------------------
MODULOS = {
    "produtividade": coletar_produtividade,
    "iqi": coletar_iqi,
    "massivas": coletar_massivas,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="reconstrói o histórico da Produtividade")
    ap.add_argument("--so", choices=list(MODULOS), help="roda apenas um módulo")
    args = ap.parse_args()

    alvos = [args.so] if args.so else list(MODULOS)
    falhas = 0
    for modulo in alvos:
        try:
            if modulo == "produtividade":
                coletar_produtividade(full=args.full)
            else:
                MODULOS[modulo]()
        except Exception as e:  # noqa
            falhas += 1
            log(f"FALHA em {modulo}: {e}")
            marcar_erro("iqi" if modulo == "iqi" else modulo, e)
            if modulo == "iqi":
                marcar_erro("iqm", e)
    log(f"Concluído. {len(alvos) - falhas}/{len(alvos)} módulos OK.")
    sys.exit(1 if falhas else 0)


if __name__ == "__main__":
    main()
