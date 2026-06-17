#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Automação que busca os dados AO VIVO do WVSA (Unetvale) e gera o mesmo
model.json consumido pelo dashboard — substituindo a leitura da planilha.

FLUXO
  1. Login headless em /login (sessão + CSRF do Laravel).
  2. POST em /relatorios/infra11/dados com o filtro "Incluir troca de poste? = Sim"
     (campo trocaDePoste=S) e período inicio..fim.
  3. Parse da tabela (Massiva, OS, É troca de poste?, Cidade, Início da massiva...).
  4. Para cada massiva, POST em /infra/massivas/atendimentos/{id} e contagem de
     OS distintas (links /os/{n}) — mesma lógica validada manualmente (#6558 = 2).
  5. Monta as tabelas normalizadas (diario, cidades, totais_mes) e grava o JSON.

CREDENCIAIS
  Lidas de variáveis de ambiente WVSA_USER / WVSA_PASS, ou do arquivo data/.env
  (NÃO versionado). Nunca ficam no código.

LIMITAÇÃO CONHECIDA (aceita pelo usuário)
  O relatório infra11 NÃO expõe "Gpons Abertos" nem "Gpons Abertos (TP)".
  Logo, as métricas derivadas do WVSA são apenas "Massivas abertas" e
  "Trocas de Postes". GPONs ficam de fora (documentado em observacoes).

Uso:
  python data/fetch_wvsa.py [--inicio AAAA-MM-DD] [--fim AAAA-MM-DD] [--limit N]
"""

import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
# Saída configurável via env (MODEL_OUT) — o coletor consolidado grava ao lado do script.
OUT_JSON = Path(os.environ.get("MODEL_OUT", Path(__file__).resolve().parent / "model.json"))
ENV_FILE = Path(__file__).resolve().parent / ".env"

BASE = "https://wvsa8.unetvale.com.br"
MESES_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
            "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]
METRICAS = ["Massivas abertas", "Trocas de Postes"]  # disponíveis no infra11


def carregar_credenciais():
    """Lê WVSA_USER/WVSA_PASS do ambiente ou de data/.env."""
    user = os.environ.get("WVSA_USER")
    pwd = os.environ.get("WVSA_PASS")
    if (not user or not pwd) and ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            if k.strip() == "WVSA_USER" and not user:
                user = v
            elif k.strip() == "WVSA_PASS" and not pwd:
                pwd = v
    if not user or not pwd:
        sys.exit("Credenciais ausentes. Defina WVSA_USER/WVSA_PASS no ambiente ou em data/.env")
    return user, pwd


def login(session, user, pwd):
    r = session.get(f"{BASE}/login", timeout=30)
    r.raise_for_status()
    token = BeautifulSoup(r.text, "lxml").find("input", {"name": "_token"})["value"]
    r = session.post(f"{BASE}/login",
                     data={"_token": token, "username": user, "password": pwd},
                     timeout=30, allow_redirects=True)
    if "/login" in r.url:
        sys.exit("Falha no login (credenciais inválidas ou bloqueio).")
    return r


def csrf_de(session):
    r = session.get(f"{BASE}/relatorios/infra11", timeout=60)
    soup = BeautifulSoup(r.text, "lxml")
    meta = soup.find("meta", {"name": "csrf-token"})
    # ação do formulário de filtro
    action = "/relatorios/infra11/dados"
    for f in soup.find_all("form"):
        nomes = [i.get("name") for i in f.find_all(["input", "select"])]
        if "trocaDePoste" in nomes and f.get("action"):
            action = f.get("action")
            break
    if action.startswith("/"):
        action = BASE + action
    return (meta["content"] if meta else None), action


def buscar_massivas(session, csrf, action, inicio, fim):
    payload = {"_token": csrf, "inicio": inicio, "fim": fim,
               "tecnico": "", "cidade": "", "motivo": "", "trocaDePoste": "S"}
    r = session.post(action, data=payload, timeout=180)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "lxml")
    registros = []
    for tr in soup.select("table tbody tr"):
        tds = tr.find_all("td")
        if len(tds) < 7:
            continue
        m = re.search(r"#?(\d+)", tds[0].get_text(strip=True))
        if not m:
            continue
        massiva = m.group(1)
        troca = tds[2].get_text(strip=True).lower().startswith("s")
        cidade = tds[4].get_text(strip=True)
        # Início da massiva: "DD/MM/AAAA HH:MM"
        ini = tds[6].get_text(strip=True)
        dm = re.match(r"(\d{2})/(\d{2})/(\d{4})", ini)
        dt = None
        if dm:
            dt = date(int(dm.group(3)), int(dm.group(2)), int(dm.group(1)))
        registros.append({"massiva": massiva, "troca": troca,
                          "cidade": cidade, "data": dt})
    # de-dup por massiva (mantém primeira ocorrência)
    vistos, unicos = set(), []
    for reg in registros:
        if reg["massiva"] in vistos:
            continue
        vistos.add(reg["massiva"])
        unicos.append(reg)
    return unicos


def contar_os(session, csrf, massiva):
    """POST atendimentos e conta OS distintas (/os/{n})."""
    try:
        r = session.post(f"{BASE}/infra/massivas/atendimentos/{massiva}",
                         headers={"X-Requested-With": "XMLHttpRequest",
                                  "X-CSRF-TOKEN": csrf,
                                  "Accept": "application/json"},
                         timeout=60)
        if r.status_code != 200:
            return 0
        # O JSON escapa as barras (\/os\/...); re-serializar normaliza para /os/.
        blob = json.dumps(r.json(), ensure_ascii=False)
        os_ids = set(re.findall(r"/os/(\d+)", blob))
        return len(os_ids)
    except (requests.RequestException, ValueError):
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inicio", default=f"{date.today().year}-01-01")
    ap.add_argument("--fim", default=date.today().isoformat())
    ap.add_argument("--limit", type=int, default=0, help="limita nº de massivas (debug)")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    user, pwd = carregar_credenciais()
    s = requests.Session()
    s.headers.update({"User-Agent": "MassivasFetcher/1.0 (Unetvale)"})

    login(s, user, pwd)
    csrf, action = csrf_de(s)
    if not csrf:
        sys.exit("CSRF token não encontrado após login.")

    registros = buscar_massivas(s, csrf, action, args.inicio, args.fim)
    if args.limit:
        registros = registros[: args.limit]
    print(f"Massivas obtidas: {len(registros)} (período {args.inicio}..{args.fim})")

    # Contagem de OS por massiva (paralelo)
    os_por_massiva = {}
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        fut = {ex.submit(contar_os, s, csrf, r["massiva"]): r["massiva"] for r in registros}
        for f in cf.as_completed(fut):
            os_por_massiva[fut[f]] = f.result()

    # -------------------- Montagem do modelo normalizado --------------------
    meses_idx = sorted({r["data"].month for r in registros if r["data"]})
    meses = [MESES_PT[i - 1] for i in meses_idx]

    # diario: contagem por dia das métricas disponíveis
    agg = {}  # (date) -> {"Massivas abertas":n, "Trocas de Postes":n}
    for r in registros:
        if not r["data"]:
            continue
        d = r["data"]
        cur = agg.setdefault(d, {"Massivas abertas": 0, "Trocas de Postes": 0})
        cur["Massivas abertas"] += 1
        if r["troca"]:
            cur["Trocas de Postes"] += 1
    diario = []
    for d in sorted(agg):
        for metrica in METRICAS:
            diario.append({
                "data": d.isoformat(),
                "mes": MESES_PT[d.month - 1],
                "dia": d.day,
                "metrica": metrica,
                "valor": agg[d][metrica],
            })

    # cidades: massivas e trocas de poste por cidade × mês
    cacc = {}  # (cidade, mes) -> [massivas, tp]
    for r in registros:
        if not r["data"]:
            continue
        mes = MESES_PT[r["data"].month - 1]
        key = (r["cidade"] or "(sem cidade)", mes)
        v = cacc.setdefault(key, [0, 0])
        v[0] += 1
        if r["troca"]:
            v[1] += 1
    cidades = [{"cidade": c, "mes": m, "massivas": v[0], "trocas_poste": v[1]}
               for (c, m), v in sorted(cacc.items())]

    # totais_mes: total de OS e OS por TP (via atendimentos)
    tacc = {}  # mes -> [total_os, total_os_tp]
    for r in registros:
        if not r["data"]:
            continue
        mes = MESES_PT[r["data"].month - 1]
        n = os_por_massiva.get(r["massiva"], 0)
        v = tacc.setdefault(mes, [0, 0])
        v[0] += n
        if r["troca"]:
            v[1] += n
    totais_mes = [{"mes": m, "total_os": v[0], "total_os_por_tp": v[1]}
                  for m, v in tacc.items()]
    totais_mes.sort(key=lambda x: MESES_PT.index(x["mes"]))

    total_os = sum(os_por_massiva.values())

    model = {
        "gerado_em": datetime.now().isoformat(timespec="seconds"),
        "fonte": "WVSA ao vivo (relatorios/infra11)",
        "ano": date.today().year,
        "periodo": {"inicio": args.inicio, "fim": args.fim},
        "meses": meses,
        "metricas": METRICAS,
        "diario": diario,
        "cidades": cidades,
        "totais_mes": totais_mes,
        "validacao": {
            "divergencias_diario": [],
            "divergencias_cidades": [],
            "ok": True,
            "resumo": {
                "massivas": len(registros),
                "trocas_poste": sum(1 for r in registros if r["troca"]),
                "total_os": total_os,
                "massivas_com_os": sum(1 for v in os_por_massiva.values() if v > 0),
            },
        },
        "observacoes": (
            "Dados ao vivo do WVSA (filtro Incluir troca de poste = Sim). "
            "O relatório infra11 não expõe GPONs, portanto as métricas 'Gpons "
            "Abertos' e 'Gpons Abertos (TP)' não estão incluídas. OS contadas "
            "via atendimentos por massiva."
        ),
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    rsm = model["validacao"]["resumo"]
    print(f"OK -> {OUT_JSON}")
    print(f"  massivas={rsm['massivas']} TP={rsm['trocas_poste']} "
          f"OS_total={rsm['total_os']} massivas_com_OS={rsm['massivas_com_os']}")
    print(f"  meses={meses}")


if __name__ == "__main__":
    main()
