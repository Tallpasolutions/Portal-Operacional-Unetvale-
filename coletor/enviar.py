#!/usr/bin/env python3
"""Coletor consolidado — roda DENTRO da VPN (acessa o WVSA) e envia os dados
para o Supabase, que alimenta o Dashboard Unetvale na Vercel.

Reaproveita os scripts originais SEM mudar a lógica de negócio:
  - extrator.py    -> Produtividade (mantém SQLite local p/ histórico incremental)
  - w8_client.py   -> IQI / IQM
  - fetch_wvsa.py  -> Massivas (model.json)
  - gerencial.py   -> Dashboard (5 relatórios da visão gerencial)

Cada módulo vira um upsert na tabela `dados_modulo` (modulo, payload, status).
Agende com cron às 08/10/12/14/16/18h (ver README).

Uso:
  python enviar.py                 # todos os módulos (incremental)
  python enviar.py --full          # reconstrói o histórico da Produtividade
  python enviar.py --so iqi        # roda só um módulo (veja MODULOS)

Os módulos `ger_*` alimentam o Dashboard. Dois deles (`ger_idf`, `ger_salas`)
usam a SEGUNDA sessão do WVSA (W8_USER_GESTOR), porque o relatório é recortado
por usuário — e o IDF recorta devolvendo 200 com tudo zerado, não 403.
"""
import argparse
import json
import os
import re
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


def supa_ler(modulo):
    """Payload atual do módulo, ou None.

    Serve ao merge incremental: a rodada normal recoleta só o mês corrente e o
    anterior, mas o payload precisa continuar com os meses do backfill. Sem
    isto, cada rodada apagaria o histórico e o gráfico de 13 meses viraria de
    dois.
    """
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_KEY"]
    try:
        r = requests.get(
            f"{url}/rest/v1/dados_modulo",
            params={"modulo": f"eq.{modulo}", "select": "payload"},
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=30,
        )
        r.raise_for_status()
        linhas = r.json()
        return (linhas[0].get("payload") if linhas else None) or None
    except Exception as e:
        log(f"  !! não consegui ler o payload anterior de {modulo}: {e}")
        return None


def supa_inserir(tabela, registro):
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_KEY"]
    r = requests.post(
        f"{url}/rest/v1/{tabela}",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=registro, timeout=60,
    )
    r.raise_for_status()


def marcar_erro(modulo, erro):
    try:
        supa_upsert(modulo, {"erro": str(erro)[:500]}, status="erro")
    except Exception as e:
        log(f"  !! não consegui registrar erro de {modulo}: {e}")


def log_evento(modulo, status, mensagem):
    """Registra a execução no histórico (tabela coletor_log). Best-effort:
    nunca interrompe a coleta se a tabela não existir ou a rede falhar."""
    try:
        url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_SERVICE_KEY"]
        requests.post(
            f"{url}/rest/v1/coletor_log",
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Content-Type": "application/json", "Prefer": "return=minimal"},
            json={"modulo": modulo, "status": status, "mensagem": (mensagem or "")[:500]},
            timeout=15,
        )
    except Exception:
        pass


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
        "SELECT dia, empresa, tecnico, tecnico_id, finalidade, sucesso, rejeitada, tipo_atendimento "
        "FROM os WHERE dia != ''"
    ).fetchall()

    # Campos do cross-filter (d,e,t,ti) + análises novas em formato COMPACTO:
    #  f  = índice na lista `fin` (finalidade / tipo de OS)
    #  su = 1 sucesso ("Sim") / 0 não concluída
    #  mo = índice na lista `mot` (motivo da não-conclusão) — só quando su=0
    #  rj = 1 rejeitada / 0
    #  ta = 1 externo / 0 interno
    fin_list, fin_idx = [], {}
    mot_list, mot_idx = [], {}

    def idx_of(val, idx, lst):
        if val not in idx:
            idx[val] = len(lst)
            lst.append(val)
        return idx[val]

    def sucesso_motivo(s):
        s = (s or "").strip()
        if s.lower().startswith("sim"):
            return True, None
        m = re.sub(r"^[Nn][ãa]o\s*-\s*(\d+\s*)?", "", s).strip()
        return False, (m or "Não informado")

    registros = []
    for r in rows:
        su, mot = sucesso_motivo(r["sucesso"])
        rec = {
            "d": r["dia"], "e": r["empresa"] or "—", "t": r["tecnico"] or "—",
            "ti": r["tecnico_id"],
            "f": idx_of(r["finalidade"] or "—", fin_idx, fin_list),
            "su": 1 if su else 0,
            "rj": 1 if (r["rejeitada"] or "").strip().lower() == "sim" else 0,
            "ta": 1 if (r["tipo_atendimento"] or "").strip().lower() == "externo" else 0,
        }
        if not su:
            rec["mo"] = idx_of(mot, mot_idx, mot_list)
        registros.append(rec)

    meta = {m["chave"]: m["valor"] for m in conn.execute("SELECT chave, valor FROM meta")}
    conn.close()
    payload = {
        "registros": registros, "total": len(registros),
        "fin": fin_list, "mot": mot_list,
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
# Dashboard (visão gerencial) — 5 relatórios, 2 sessões
# --------------------------------------------------------------------------
# As sessões são criadas UMA vez por execução e reaproveitadas pelos cinco
# módulos: cada login é um round-trip e o WVSA não gosta de sequência de
# autenticações. `_SESSOES` vive só o processo.
_SESSOES = {}


def _sessao(gestor=False):
    import w8_client
    chave = "gestor" if gestor else "padrao"
    if chave not in _SESSOES:
        _SESSOES[chave] = w8_client.login_gestor() if gestor else w8_client.login()
        log(f"  sessão {chave}: {_SESSOES[chave].usuario}")
    return _SESSOES[chave]


def _meses(full):
    import gerencial as g
    return g.meses_do_backfill() if full else g.meses_da_rodada()


def coletar_ger_categorias(full=False):
    import gerencial as g
    supa_upsert("ger_categorias", g.coletar_categorias(
        _sessao(), _meses(full), anterior=supa_ler("ger_categorias")))


def coletar_ger_cancelamentos(full=False):
    import gerencial as g
    supa_upsert("ger_cancelamentos", g.coletar_cancelamentos(
        _sessao(), _meses(full), anterior=supa_ler("ger_cancelamentos")))


def coletar_ger_idf(full=False):
    import gerencial as g
    supa_upsert("ger_idf", g.coletar_idf(
        _sessao(gestor=True), _meses(full), anterior=supa_ler("ger_idf")))


def coletar_ger_salas(full=False):
    import gerencial as g
    supa_upsert("ger_salas", g.coletar_salas(_sessao(gestor=True)))


def coletar_ger_esteira(full=False):
    """Foto da fila AGORA + uma linha no histórico.

    As duas coisas são necessárias e são diferentes: `dados_modulo` responde
    "como está a fila", e o histórico responde "quantas entraram e quantas
    saíram desde a abertura" — que é diferença entre duas fotos.
    """
    import gerencial as g
    dados = g.coletar_esteira(_sessao())
    supa_upsert("ger_esteira", dados)
    gravar_snapshot_esteira(dados)
    expurgar_snapshots()


def gravar_snapshot_esteira(dados):
    """Uma linha por coleta. A primeira do dia é a `abertura`.

    A migration tem índice único parcial em (dia) where abertura, então uma
    segunda rodada às 08h (retry após queda de rede) não cria uma segunda
    abertura — o insert falha e caímos para `abertura=false`. Sem isso o
    entrou/saiu passaria a comparar contra a foto errada, sem erro na tela.
    """
    from datetime import date
    hoje = date.today().isoformat()
    linha = {
        "dia": hoje, "total": dados["total"],
        "por_finalidade": dados["por_finalidade"], "oss": dados["oss"],
    }
    try:
        supa_inserir("dashboard_esteira_snapshot", {**linha, "abertura": True})
        log("  -> snapshot da esteira gravado (abertura do dia)")
        return
    except Exception:
        pass
    try:
        supa_inserir("dashboard_esteira_snapshot", {**linha, "abertura": False})
        log("  -> snapshot da esteira gravado")
    except Exception as e:
        log(f"  !! snapshot da esteira não gravou: {e}")


def expurgar_snapshots(dias=90):
    """Best-effort. O painel olha o dia corrente; o resto é histórico curto."""
    from datetime import date, timedelta
    corte = (date.today() - timedelta(days=dias)).isoformat()
    try:
        url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_SERVICE_KEY"]
        requests.delete(
            f"{url}/rest/v1/dashboard_esteira_snapshot",
            params={"dia": f"lt.{corte}"},
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Prefer": "return=minimal"},
            timeout=30,
        )
    except Exception:
        pass


# --------------------------------------------------------------------------
MODULOS = {
    "produtividade": coletar_produtividade,
    "iqi": coletar_iqi,
    "massivas": coletar_massivas,
    "ger_categorias": coletar_ger_categorias,
    "ger_cancelamentos": coletar_ger_cancelamentos,
    "ger_esteira": coletar_ger_esteira,
    "ger_idf": coletar_ger_idf,
    "ger_salas": coletar_ger_salas,
}


def wvsa_alcancavel():
    """Pré-check: o WVSA responde? Funciona igual na VPN ou na rede Unetvale —
    o que importa é apenas se há rota até o sistema agora."""
    base = os.environ.get("W8_BASE", "https://wvsa8.unetvale.com.br").rstrip("/")
    try:
        r = requests.get(base + "/login", timeout=8)
        return r.status_code < 500
    except requests.RequestException:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true",
                    help="reconstrói o histórico: Produtividade do zero e os "
                         "13 meses dos módulos ger_* (demorado, ~125 MB)")
    ap.add_argument("--so", choices=list(MODULOS), help="roda apenas um módulo")
    args = ap.parse_args()

    # Sem rota até o WVSA (fora da VPN e fora da rede Unetvale): pula a rodada
    # SEM marcar erro e SEM sobrescrever os últimos dados bons.
    if not wvsa_alcancavel():
        log("WVSA inalcançável (sem VPN nem rede Unetvale). Rodada ignorada — dados anteriores preservados.")
        log_evento("geral", "skip", "WVSA inalcançável (sem VPN/rede Unetvale) — rodada ignorada")
        sys.exit(0)

    alvos = [args.so] if args.so else list(MODULOS)
    falhas = 0
    for modulo in alvos:
        try:
            if modulo == "produtividade" or modulo.startswith("ger_"):
                # Estes aceitam `full`: para a Produtividade é recriar o SQLite,
                # para os `ger_*` é o backfill dos 13 meses.
                MODULOS[modulo](full=args.full)
            else:
                MODULOS[modulo]()
            log_evento(modulo, "ok", "Atualizado com sucesso")
        except Exception as e:  # noqa
            falhas += 1
            log(f"FALHA em {modulo}: {e}")
            marcar_erro("iqi" if modulo == "iqi" else modulo, e)
            if modulo == "iqi":
                marcar_erro("iqm", e)
            log_evento(modulo, "erro", str(e))
    log(f"Concluído. {len(alvos) - falhas}/{len(alvos)} módulos OK.")
    log_evento("geral", "ok" if not falhas else "erro",
               f"{len(alvos) - falhas}/{len(alvos)} módulos OK")
    sys.exit(1 if falhas else 0)


if __name__ == "__main__":
    main()
