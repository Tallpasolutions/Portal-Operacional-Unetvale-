#!/usr/bin/env python3
"""Daemon do coletor (rodar via launchd com KeepAlive).

A cada ciclo (~45s):
  - Atende PEDIDO MANUAL de atualização (botão "Atualizar" no app, gravado na
    tabela `controle.pedido_em`).
  - Cobre os HORÁRIOS 08/10/12/14/16/18h mesmo que o Mac tenha dormido — ao
    acordar, detecta o horário que ainda não rodou e roda.

Só coleta quando o WVSA está acessível (VPN/rede Unetvale). Usa a própria
`dados_modulo` (timestamp mais recente) como "última coleta", sem estado local.

IMPORTANTE: deve rodar de uma pasta FORA de ~/Desktop, ~/Documents, ~/Downloads
(protegidas por TCC no macOS, que bloqueiam execução pelo launchd).
"""
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

import requests
from dotenv import load_dotenv

DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(DIR, ".env"))

BR_TZ = timezone(timedelta(hours=-3))
HORARIOS = [8, 10, 12, 14, 16, 18]
PY = sys.executable
INTERVALO = 45  # segundos entre verificações


def log(m):
    print(f"[{datetime.now(BR_TZ):%d/%m %H:%M:%S}] {m}", flush=True)


def _sb():
    return os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_KEY"]


def _parse(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def wvsa_ok():
    base = os.environ.get("W8_BASE", "https://wvsa8.unetvale.com.br").rstrip("/")
    try:
        return requests.get(base + "/login", timeout=8).status_code < 500
    except requests.RequestException:
        return False


def _get(path):
    url, key = _sb()
    r = requests.get(f"{url}/rest/v1/{path}",
                     headers={"apikey": key, "Authorization": f"Bearer {key}"}, timeout=15)
    r.raise_for_status()
    return r.json()


def ultima_coleta():
    try:
        rows = _get("dados_modulo?select=atualizado_em&order=atualizado_em.desc&limit=1")
        return _parse(rows[0]["atualizado_em"]) if rows else None
    except Exception:
        return None


def pedido_manual():
    # Pedido manual mais recente (botão "Atualizar") gravado em coletor_log.
    try:
        rows = _get("coletor_log?status=eq.pedido&select=executado_em&order=executado_em.desc&limit=1")
        return _parse(rows[0]["executado_em"]) if rows else None
    except Exception:
        return None


def slot_atual():
    agora = datetime.now(BR_TZ)
    passados = [agora.replace(hour=h, minute=0, second=0, microsecond=0)
                for h in HORARIOS
                if agora.replace(hour=h, minute=0, second=0, microsecond=0) <= agora]
    return max(passados) if passados else None


def motivo_para_rodar():
    ult = ultima_coleta()
    ped = pedido_manual()
    if ped and (ult is None or ped > ult):
        return "manual"
    slot = slot_atual()
    if slot and (ult is None or ult.astimezone(BR_TZ) < slot):
        return "agendado"
    return None


def rodar(motivo):
    log(f"Disparando coleta ({motivo})…")
    try:
        subprocess.run([PY, os.path.join(DIR, "enviar.py")], cwd=DIR, timeout=1800)
        log("coleta concluída")
    except Exception as e:  # noqa
        log(f"erro ao executar enviar.py: {e}")


def main():
    log(f"watcher iniciado (intervalo {INTERVALO}s, horários {HORARIOS})")
    while True:
        try:
            if wvsa_ok():
                m = motivo_para_rodar()
                if m:
                    rodar(m)
            # offline: aguarda silenciosamente o próximo ciclo
        except Exception as e:  # noqa
            log(f"erro no loop: {e}")
        time.sleep(INTERVALO)


if __name__ == "__main__":
    main()
