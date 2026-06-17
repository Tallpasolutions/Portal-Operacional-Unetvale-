# -*- coding: utf-8 -*-
"""Cliente do W8: faz login e coleta os dados de IQI/IQM por tecnico ao vivo.
Reutilizavel tanto no app Flask local quanto numa serverless function (Vercel).
O endpoint de grafico e generico (/graficos/indicadores/iqi/...); o indicador e
definido pelos tipos de OS e pela janela de dias (ver INDICADORES)."""
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

import requests

BR_TZ = timezone(timedelta(hours=-3))
ANO_INICIO = 2026  # mostrar meses a partir de Jan deste ano

# Configuracao de cada indicador
INDICADORES = {
    "IQI": {
        "label": "IQI",
        "titulo": "Indicador de Qualidade de Instalação",
        "evento": "instalação",
        "tipos": "INS-INS2-INS3-MIGE-MIGF-MUD-MUDF",
        "dias": 30,
        "meta": 17.0,
        "minOS": 10,
        "index_url": "/relatorios/indicadores4/index/INS-INS2-INS3-MIGE-MIGF-MUD-MUDF",
    },
    "IQM": {
        "label": "IQM",
        "titulo": "Indicador de Qualidade de Manutenção",
        "evento": "manutenção",
        "tipos": "MAN-MANF-MANR-MANRF",
        "dias": 15,
        "meta": 7.0,
        "minOS": 10,
        "index_url": "/relatorios/indicadores4/index/MAN-MANF-MANR-MANRF/15/IQM",
    },
}


def _cfg_env():
    base = os.environ.get("W8_BASE", "https://wvsa8.unetvale.com.br")
    user = os.environ.get("W8_USER")
    pwd = os.environ.get("W8_PASS")
    if not user or not pwd:
        raise RuntimeError("W8_USER / W8_PASS nao configurados (.env)")
    return base, user, pwd


def login():
    """Retorna uma requests.Session autenticada."""
    base, user, pwd = _cfg_env()
    s = requests.Session()
    s.headers.update({"User-Agent": "Mozilla/5.0 (IQI-bot)"})
    r = s.get(base + "/login", timeout=30)
    m = re.search(r'name="_token"\s+value="([^"]+)"', r.text)
    if not m:
        raise RuntimeError("Token CSRF nao encontrado na pagina de login")
    r2 = s.post(base + "/login",
                data={"_token": m.group(1), "username": user, "password": pwd},
                allow_redirects=True, timeout=30)
    if "/login" in r2.url:
        raise RuntimeError("Falha no login (usuario/senha incorretos?)")
    s.base = base
    return s


def listar_tecnicos(s, cfg):
    """Lista [(id, nome)] do select da pagina do relatorio do indicador."""
    html = s.get(s.base + cfg["index_url"], timeout=30).text
    m = re.search(r'<select[^>]*id="select-tecnico"[^>]*>(.*?)</select>', html, re.S | re.I)
    if not m:
        raise RuntimeError("Select de tecnicos nao encontrado")
    opts = re.findall(r'<option value="([^"]*)"[^>]*>([^<]*)</option>', m.group(1))
    return [(v, t.strip()) for v, t in opts if v]


def _serie_tecnico(s, cfg, tid):
    url = (s.base + f"/graficos/indicadores/iqi/{cfg['tipos']}/{cfg['dias']}/{tid}/0/S?highchart=S")
    j = s.get(url, headers={"X-Requested-With": "XMLHttpRequest"}, timeout=60).json()
    cats = j["xAxis"]["categories"]
    return cats, j["series"][1]["data"], j["series"][0]["data"], j["series"][2]["data"]


def coletar(ind="IQI", progress=None):
    """Coleta tudo de um indicador e devolve o payload no formato do front-end."""
    if ind not in INDICADORES:
        raise ValueError(f"Indicador invalido: {ind}")
    cfg = INDICADORES[ind]
    s = login()
    techs = listar_tecnicos(s, cfg)
    total = len(techs)
    raw = {}
    done = {"n": 0}

    def task(item):
        tid, nome = item
        try:
            cats, tos, cham, iqi = _serie_tecnico(s, cfg, tid)
            raw[nome] = (cats, tos, cham, iqi)
        except Exception:
            raw[nome] = None
        done["n"] += 1
        if progress:
            progress(done["n"], total)

    with ThreadPoolExecutor(max_workers=12) as ex:
        list(ex.map(task, techs))

    cats_ref = next((v[0] for v in raw.values() if v), [])
    idxs = [i for i, c in enumerate(cats_ref) if int(c.split("/")[1]) >= ANO_INICIO]
    meses = [cats_ref[i] for i in idxs]

    tecnicos = []
    for nome, v in raw.items():
        if not v:
            continue
        _, tos, cham, iqi = v
        monthly = [[tos[i] or 0, cham[i] or 0, iqi[i] or 0] for i in idxs]
        if any(rr[0] > 0 for rr in monthly):
            tecnicos.append({"nome": nome, "m": monthly})

    tecnicos.sort(key=lambda t: t["nome"])
    return {
        "indicador": cfg["label"],
        "titulo": cfg["titulo"],
        "evento": cfg["evento"],
        "dias": cfg["dias"],
        "meses": meses,
        "meta": cfg["meta"],
        "minOS": cfg["minOS"],
        "tecnicos": tecnicos,
        "atualizado_em": datetime.now(BR_TZ).strftime("%d/%m/%Y %H:%M"),
    }


if __name__ == "__main__":
    import sys
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
    ind = sys.argv[1] if len(sys.argv) > 1 else "IQI"
    t0 = time.time()
    data = coletar(ind, progress=lambda d, t: print(f"\r{d}/{t}", end="", flush=True))
    print(f"\n{ind} OK em {time.time()-t0:.1f}s | meses={data['meses']} | tecnicos={len(data['tecnicos'])}")
