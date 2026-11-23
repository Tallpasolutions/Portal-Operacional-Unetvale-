#!/usr/bin/env python3
"""Daemon do coletor (rodar via launchd com KeepAlive).

A cada ciclo (~45s):
  - Atende PEDIDO MANUAL de atualização (botão "Atualizar" no app, gravado na
    tabela `controle.pedido_em`).
  - Cobre os HORÁRIOS 08/10/12/14/16/18h mesmo que o Mac tenha dormido — ao
    acordar, detecta o horário que ainda não rodou e roda.
  - Entre as rodadas, a COLETA RÁPIDA da Produtividade de hoje (de 10 em 10
    min no horário de trabalho, até `PROD_RAPIDA_ATE`) para a War Room.
  - Bate ponto em `coletor_heartbeat` (de 2 em 2 min), para que a tela de
    Monitoramento consiga dizer POR QUE o dado está velho: máquina desligada,
    máquina de pé sem rota até o WVSA, ou coleta em andamento. Sem isso, os
    três casos produzem a mesma idade nos cards.

Só coleta quando o WVSA está acessível (VPN/rede Unetvale). A "última rodada"
é o `geral`/`inicio` mais recente do `coletor_log`, sem estado local.

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
# O pulso não precisa da resolução do ciclo: a tela arredonda em minutos, e
# escrever de 45 em 45 s daria ~1900 gravações por dia para nenhum ganho.
HEARTBEAT_INTERVALO = 120  # segundos entre gravações do sinal de vida

# Coleta rápida da Produtividade de hoje (`enviar.py --rapida`), pedida em
# 23/11/2026 para os supervisores acompanharem as recusas na War Room "ao
# menos essa semana". Tem DATA DE FIM de propósito: são ~80 coletas por dia
# no WVSA e no Supabase, e uma cadência provisória sem fim vira permanente
# sem ninguém decidir. Para estender, `PROD_RAPIDA_ATE` no `.env`; para
# desligar, uma data passada. A janela é das 7h às 20h — fora dela ninguém
# está na mesa, e as OS da noite entram na rodada das 08h.
PROD_RAPIDA_ATE = os.environ.get("PROD_RAPIDA_ATE", "2026-11-29")
PROD_RAPIDA_MIN = int(os.environ.get("PROD_RAPIDA_MIN", "10"))
PROD_RAPIDA_HORAS = os.environ.get("PROD_RAPIDA_HORAS", "7-20")


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


def bater_ponto(ok):
    """Grava o sinal de vida (tabela `coletor_heartbeat`, uma linha só).

    Best-effort de propósito: se o Supabase estiver fora, o coletor continua
    tentando coletar. Perder o pulso é menos grave que parar a coleta — e a
    própria ausência de pulso já é a informação que a tela mostra.
    """
    url, key = _sb()
    try:
        requests.patch(
            f"{url}/rest/v1/coletor_heartbeat",
            params={"id": "eq.1"},
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Content-Type": "application/json", "Prefer": "return=minimal"},
            json={"visto_em": datetime.now(timezone.utc).isoformat(), "wvsa_ok": bool(ok)},
            timeout=10,
        )
    except Exception:
        pass


def _get(path):
    url, key = _sb()
    r = requests.get(f"{url}/rest/v1/{path}",
                     headers={"apikey": key, "Authorization": f"Bearer {key}"}, timeout=15)
    r.raise_for_status()
    return r.json()


def ultima_coleta():
    """Início da última RODADA (`geral`/`inicio` no `coletor_log`).

    Até 23/11/2026 era o carimbo mais novo de `dados_modulo`. Com a coleta
    rápida, a Produtividade ganha carimbo de 10 em 10 min, e esse "mais novo"
    nunca ficaria mais velho que o horário da grade: as rodadas das 10h, 12h…
    deixariam de sair, caladas, levando IQI, Massivas e Dashboard junto. O
    `inicio` só o `enviar.py` de rodada grava (a rápida não), e é ele que a
    tela de Monitoramento já usa para dizer que a rodada começou.
    """
    try:
        rows = _get("coletor_log?modulo=eq.geral&status=eq.inicio"
                    "&select=executado_em&order=executado_em.desc&limit=1")
        return _parse(rows[0]["executado_em"]) if rows else None
    except Exception:
        return None


def idade_produtividade():
    """Minutos desde o último carimbo bom da Produtividade (None = não sei)."""
    try:
        rows = _get("dados_modulo?modulo=eq.produtividade&select=atualizado_em")
        dt = _parse(rows[0]["atualizado_em"]) if rows else None
    except Exception:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds() / 60 if dt else None


def rapida_no_horario(agora=None):
    agora = agora or datetime.now(BR_TZ)
    try:
        ate = datetime.fromisoformat(PROD_RAPIDA_ATE).date()
        h_ini, h_fim = (int(x) for x in PROD_RAPIDA_HORAS.split("-"))
    except ValueError:
        return False          # configuração torta desliga, não coleta sem parar
    return agora.date() <= ate and h_ini <= agora.hour < h_fim


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
    # Sob `caffeinate -ims`, como o `coletar_celesc.sh`: em 22/10/2026 a rodada
    # disparada às 21:47 dormiu junto com o Mac no meio das Massivas e só
    # "terminou" às 04:18, com seis módulos em `connect timeout` gravados como
    # erro — de madrugada, numa rede que já não existia. `-i` segura o idle
    # sleep na bateria, `-s` o system sleep na tomada. Tampa fechada na bateria
    # ainda dorme; isso nenhuma asserção vence. O `caffeinate` morre com o
    # filho, então não sobra asserção depois da rodada.
    cmd = [PY, os.path.join(DIR, "enviar.py")]
    if os.path.exists("/usr/bin/caffeinate"):
        cmd = ["/usr/bin/caffeinate", "-ims", *cmd]
    try:
        subprocess.run(cmd, cwd=DIR, timeout=1800)
        log("coleta concluída")
    except Exception as e:  # noqa
        log(f"erro ao executar enviar.py: {e}")


def rodar_rapida():
    cmd = [PY, os.path.join(DIR, "enviar.py"), "--rapida"]
    if os.path.exists("/usr/bin/caffeinate"):
        cmd = ["/usr/bin/caffeinate", "-ims", *cmd]
    try:
        # 10 min de teto: um dia de Produtividade leva segundos; mais que
        # isso é o WVSA travado, e a rodada da grade não pode esperar por ele.
        subprocess.run(cmd, cwd=DIR, timeout=600)
    except Exception as e:  # noqa
        log(f"erro na coleta rápida: {e}")


def main():
    log(f"watcher iniciado (intervalo {INTERVALO}s, horários {HORARIOS}, "
        f"rápida de {PROD_RAPIDA_MIN} em {PROD_RAPIDA_MIN} min das {PROD_RAPIDA_HORAS}h até {PROD_RAPIDA_ATE})")
    ultimo_pulso = 0.0
    ultima_rapida = 0.0
    while True:
        try:
            ok = wvsa_ok()
            # O pulso vem ANTES do `if ok`: é justamente quando o WVSA está
            # inalcançável que a tela precisa saber que a máquina está viva —
            # senão "coletor desligado" e "coletor fora da rede" continuam com
            # a mesma cara, que foi o problema que motivou o heartbeat.
            if time.monotonic() - ultimo_pulso >= HEARTBEAT_INTERVALO:
                bater_ponto(ok)
                ultimo_pulso = time.monotonic()
            if ok:
                m = motivo_para_rodar()
                if m:
                    rodar(m)
                elif rapida_no_horario() and time.monotonic() - ultima_rapida >= PROD_RAPIDA_MIN * 60:
                    # Carimbo com menos de (intervalo − 1) min: a rodada acabou
                    # de gravar a Produtividade, e a rápida esperaria à toa.
                    # O relógio próprio (`ultima_rapida`) impede que uma
                    # rápida que FALHA — e não renova o carimbo — se repita
                    # a cada ciclo de 45 s.
                    idade = idade_produtividade()
                    if idade is None or idade >= PROD_RAPIDA_MIN - 1:
                        ultima_rapida = time.monotonic()
                        rodar_rapida()
            # offline: aguarda silenciosamente o próximo ciclo
        except Exception as e:  # noqa
            log(f"erro no loop: {e}")
        time.sleep(INTERVALO)


if __name__ == "__main__":
    main()
