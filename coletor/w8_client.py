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


def _cfg_env(sufixo=""):
    """Credenciais do ambiente. `sufixo` escolhe qual par usar.

    Existem dois porque o WVSA recorta relatorio POR USUARIO, e nem sempre com
    403: o IDF (indicadores9) devolve HTTP 200 com tudo zerado para quem nao
    tem o recorte. Ver `login_gestor`.
    """
    base = os.environ.get("W8_BASE", "https://wvsa8.unetvale.com.br")
    user = os.environ.get(f"W8_USER{sufixo}")
    pwd = os.environ.get(f"W8_PASS{sufixo}")
    if not user or not pwd:
        raise RuntimeError(f"W8_USER{sufixo} / W8_PASS{sufixo} nao configurados (.env)")
    return base, user, pwd


def login(sufixo=""):
    """Retorna uma requests.Session autenticada."""
    base, user, pwd = _cfg_env(sufixo)
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
        raise RuntimeError(f"Falha no login de {user} (usuario/senha incorretos?)")
    s.base = base
    # Guardado para a mensagem de erro do coletor dizer QUAL das duas sessoes
    # falhou. Com duas credenciais em jogo, "falha no login" sozinho manda
    # conferir a senha errada.
    s.usuario = user
    return s


def login_gestor():
    """Sessao do usuario gestor (W8_USER_GESTOR / W8_PASS_GESTOR).

    Necessaria para dois relatorios, e as duas recusas tem cara diferente:

      * `/relatorios/operacional15` (salas do Rocketchat) devolve HTTP 403
        limpo para quem nao tem acesso;
      * `/relatorios/indicadores9` (IDF) devolve HTTP **200 com tudo zerado**.

    Medido em 29/08/2026, mesmo endpoint e mesmo periodo (01-29/08): o usuario
    comum recebeu "Sem dados" nos tres canais; o gestor, Ligacoes 211 (nota
    4.58), Chats 1087 (4.48) e OS 297 (4.51). O segundo caso e o perigoso —
    sem esta sessao o coletor gravaria zeros e reportaria sucesso.
    """
    return login("_GESTOR")


def listar_tecnicos(s, cfg):
    """Lista [(id, nome)] do select da pagina do relatorio do indicador."""
    html = s.get(s.base + cfg["index_url"], timeout=30).text
    m = re.search(r'<select[^>]*id="select-tecnico"[^>]*>(.*?)</select>', html, re.S | re.I)
    if not m:
        raise RuntimeError("Select de tecnicos nao encontrado")
    opts = re.findall(r'<option value="([^"]*)"[^>]*>([^<]*)</option>', m.group(1))
    return [(v, t.strip()) for v, t in opts if v]


def _serie(s, url):
    """(cats, total_os, reincidencias, pct) de um grafico do indicador.

    A ordem das series no JSON do WVSA nao e a da legenda: series[0] e a
    contagem de contratos reincidentes, series[1] o total de OSs e series[2] o
    percentual. Trocar as duas primeiras inverte o indicador sem erro nenhum.
    """
    j = s.get(url, headers={"X-Requested-With": "XMLHttpRequest"}, timeout=90).json()
    cats = j["xAxis"]["categories"]
    return cats, j["series"][1]["data"], j["series"][0]["data"], j["series"][2]["data"]


def _serie_tecnico(s, cfg, tid):
    return _serie(s, s.base +
                  f"/graficos/indicadores/iqi/{cfg['tipos']}/{cfg['dias']}/{tid}/0/S?highchart=S")


def _serie_geral(s, cfg):
    """O consolidado do indicador, exatamente como o WVSA o publica.

    🚨 Somar os tecnicos NAO reconstroi este numero. Nao troque por uma conta
    feita aqui.

    A URL e a mesma que a pagina do `indicadores4` carrega sozinha ao abrir —
    sem os segmentos de tecnico/empresa/massivas. Medido em 01/09/2026: ela
    devolve o mesmo que `/0/0/S`, entao o padrao do servidor para
    `ignorarMassivas` E `S`, e o coletor sempre esteve certo nesse ponto.

    Por que a soma dos tecnicos diverge, medido no mesmo dia:

      * TECNICO QUE SAI DESAPARECE DO SELECT, e leva a historia dele junto.
        Em 01/2026, 51 das 146 reincidencias do IQI eram de 11 tecnicos que
        ja nao estao na lista — a "RW Telecom" inteira sumiu. O total de OSs
        do mes caia de 757 (WVSA) para 493 (soma). Como o payload e regravado
        inteiro a cada rodada, isso PIORA sozinho: cada saida reescreve o
        passado.
      * OS COM DOIS TECNICOS CONTA DUAS VEZES na soma. No IQM de 07/2026, 19
        dos 134 contratos reincidentes tinham 2+ tecnicos distintos — a soma
        dava 155 reincidencias onde o WVSA dava 133.

    Os dois efeitos andam em sentidos opostos e nao se cancelam: o Dashboard
    mostrava 8,78% de IQM em 07/2026 contra 7,49% do WVSA.
    """
    return _serie(s, s.base +
                  f"/graficos/indicadores/iqi/{cfg['tipos']}/{cfg['dias']}?highchart=S")


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

    # Os meses saem da serie GERAL, e nao do primeiro tecnico que respondeu:
    # ela e a unica que cobre o periodo inteiro independentemente de quem
    # estava na equipe. Cada tecnico e encaixado nesses meses PELO ROTULO —
    # posicao so seria segura enquanto os dois endpoints devolvessem a mesma
    # janela, e nada no WVSA promete isso.
    cats_geral, tos_g, cham_g, pct_g = _serie_geral(s, cfg)
    idxs = [i for i, c in enumerate(cats_geral) if int(c.split("/")[1]) >= ANO_INICIO]
    meses = [cats_geral[i] for i in idxs]
    geral = [[tos_g[i] or 0, cham_g[i] or 0, pct_g[i]] for i in idxs]

    tecnicos = []
    for nome, v in raw.items():
        if not v:
            continue
        cats_t, tos, cham, iqi = v
        pos = {c: i for i, c in enumerate(cats_t)}
        monthly = []
        for m in meses:
            i = pos.get(m)
            monthly.append([tos[i] or 0, cham[i] or 0, iqi[i] or 0]
                           if i is not None else [0, 0, 0])
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
        # O numero do indicador. `tecnicos` e o recorte de execucao — util
        # para ranking, mas a soma dele nao e o indicador (ver _serie_geral).
        "geral": geral,
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
    for m, g in zip(data["meses"], data["geral"]):
        print(f"  {m}: {g[1]}/{g[0]} = {g[2]}%   (consolidado do WVSA)")
