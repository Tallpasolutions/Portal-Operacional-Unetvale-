"""Hora da recusa pela FICHA da OS, não pelo relatório da Produtividade.

A coluna "Data" do `operacional8` nem sempre é a hora em que o técnico
fechou a OS sem sucesso. Conferido em 23 e 24/11/2026 contra a ficha
(`/os/{n}`, linha "OS fechada sem sucesso pelo técnico…"):

* das 63 recusas de 23/11, 52 iguais ao minuto e 10 de 1 a 5 min DEPOIS;
* a #601017 (Caua, 22:36) e a #602668 (Marcelo, 22:27) vieram no relatório
  como **24/11 00:24** — as duas no mesmo minuto, sem evento nenhum às 00:24
  na ficha. Algum processamento do WVSA depois da meia-noite regravou a data.

A hora é o de menos: a recusa muda de DIA. A War Room listava as duas em
24/11, e quem olhava 23/11 não as via. Por isso a War Room usa a hora da
ficha; a Produtividade continua com a do relatório, para os totais fecharem
com o que o WVSA mostra.

Custo: uma leitura de ficha por recusa NOVA (~60 por dia). O resultado fica
no SQLite (`ficha_recusa`) com a chave (os, data_hora do relatório, técnico):
se o relatório regravar a data, a chave muda e a ficha é lida de novo. Ficha
que falhou (rede, 5xx) não é gravada — tenta na próxima coleta. Ficha lida
sem linha que case grava NULL: lida, sem correção, não relê.

Nada aqui escreve no WVSA: é GET na ficha.
"""
import os
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta

from bs4 import BeautifulSoup

# Quantos dias para trás têm a recusa conferida. A War Room mostra o dia e
# deixa voltar uma semana; mais que isso, na primeira rodada, seriam
# milhares de fichas para dias que ninguém abre.
DIAS = int(os.environ.get("FICHA_RECUSA_DIAS", "8"))
WORKERS = int(os.environ.get("FICHA_RECUSA_WORKERS", "4"))
# Teto de tempo da etapa. A rodada rápida roda de 10 em 10 min: a etapa não
# pode segurá-la. O que não for lido no prazo fica para a próxima.
PRAZO_S = int(os.environ.get("FICHA_RECUSA_PRAZO", "90"))
# Distância máxima entre a recusa na ficha e a data do relatório. O relatório
# vem sempre IGUAL ou DEPOIS (0–5 min no dia comum, 1h48 no lote das 00:24);
# uma linha da ficha muito anterior é outra recusa da mesma OS, de outra
# visita, e não pode emprestar a hora dela.
JANELA = timedelta(hours=12)

_DATA = re.compile(r"(\d{2})/(\d{2})/(\d{4})\s+(\d{2}):(\d{2})")


def _norma(t):
    t = unicodedata.normalize("NFKD", t or "")
    return re.sub(r"\s+", " ", "".join(c for c in t if not unicodedata.combining(c))).strip().lower()


def eventos(html):
    """Ficha -> [(datetime local ingênuo, texto)] das recusas DO TÉCNICO.

    Só "fechada sem sucesso pelo técnico": a "OS Fechada sem sucesso" sem
    "pelo técnico" é o supervisor fechando de novo depois (a #603151: o
    técnico às 12:29, o supervisor às 15:39), e não é a hora da recusa.
    """
    soup = BeautifulSoup(html, "lxml")
    aba = soup.find("div", id="tab-all")
    if aba is None:
        return []
    out = []
    for li in aba.select("ul.timeline li"):
        txt = li.find("span", class_="quebra-linha")
        quando = li.find("span", class_="timeline-date")
        if not txt or not quando:
            continue
        texto = re.sub(r"\s+", " ", txt.get_text(" ", strip=True))
        # COMEÇA com a frase: "Rejeitando OS para o dono: OS fechada sem
        # sucesso pelo técnico…" é quem rejeitou citando a recusa, na hora
        # da rejeição (a #592878: recusa 08/10 08:44, rejeição 13/10 11:46).
        if not texto.lower().startswith("os fechada sem sucesso pelo t"):
            continue
        m = _DATA.search(quando.get_text(" ", strip=True))
        if not m:
            continue
        d, mo, y, hh, mi = map(int, m.groups())
        try:
            out.append((datetime(y, mo, d, hh, mi), texto))
        except ValueError:
            continue
    return out


def escolher(evs, data_hora_rel, tecnico):
    """A recusa da ficha que corresponde à linha do relatório, ou None.

    Candidatas: não depois do relatório e dentro da JANELA antes dele. Entre
    elas, as do MESMO técnico ganham (OS com dois técnicos na mesma noite);
    e, entre as que sobram, a mais próxima do relatório.
    """
    try:
        rel = datetime.fromisoformat(data_hora_rel)
    except (TypeError, ValueError):
        return None
    cand = [(dt, tx) for dt, tx in evs if rel - JANELA <= dt <= rel]
    nome = _norma(tecnico)
    do_tec = [c for c in cand if nome and nome in _norma(c[1])]
    cand = do_tec or cand
    if not cand:
        return None
    return max(cand)[0].isoformat(timespec="minutes")


def init(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ficha_recusa (
            os TEXT NOT NULL,
            data_hora TEXT NOT NULL,     -- a do relatório (chave: se mudar, relê)
            tecnico TEXT NOT NULL,
            tecnico_em TEXT,             -- a da ficha; NULL = lida, nada casou
            lida_em TEXT NOT NULL,
            PRIMARY KEY (os, data_hora, tecnico)
        )""")


def pendentes(conn, hoje=None):
    """Recusas recentes ainda sem ficha conferida."""
    corte = ((hoje or date.today()) - timedelta(days=DIAS)).isoformat()
    return conn.execute("""
        SELECT o.os, o.data_hora, COALESCE(o.tecnico, '') AS tecnico
          FROM os o
          LEFT JOIN ficha_recusa f
            ON f.os = o.os AND f.data_hora = o.data_hora AND f.tecnico = COALESCE(o.tecnico, '')
         WHERE o.dia >= ? AND o.sucesso NOT LIKE 'Sim%'
           AND o.os GLOB '[0-9]*' AND o.os NOT GLOB '*[^0-9]*'
           AND f.os IS NULL
    """, (corte,)).fetchall()


def conferir(conn, abrir_sessao, log=print, hoje=None):
    """Lê a ficha das recusas pendentes e grava em `ficha_recusa`.

    `abrir_sessao` só é chamada se houver o que ler — a rodada rápida passa
    aqui a cada 10 min, quase sempre sem recusa nova. Nunca levanta: falha
    aqui deixa a War Room com a hora do relatório, que é o que havia antes.
    """
    init(conn)
    pend = pendentes(conn, hoje)
    if not pend:
        return 0
    try:
        s = abrir_sessao()
    except Exception as e:
        log(f"  fichas das recusas: sem sessão no WVSA ({e}) — fica a hora do relatório")
        return 0
    por_os = {}
    for os_n, dh, tec in pend:
        por_os.setdefault(os_n, []).append((dh, tec))

    def uma(os_n):
        r = s.get(f"{s.base}/os/{os_n}", timeout=30)
        r.raise_for_status()
        return eventos(r.text)

    prazo = time.monotonic() + PRAZO_S
    agora = datetime.now().isoformat(timespec="seconds")
    lidas = falhas = corrigidas = 0
    ex = ThreadPoolExecutor(max_workers=WORKERS)
    try:
        futuros = {ex.submit(uma, n): n for n in por_os}
        for f in as_completed(futuros):
            n = futuros[f]
            try:
                evs = f.result()
            except Exception:
                falhas += 1
                continue
            lidas += 1
            for dh, tec in por_os[n]:
                em = escolher(evs, dh, tec)
                if em and em != dh:
                    corrigidas += 1
                conn.execute("INSERT OR REPLACE INTO ficha_recusa VALUES (?,?,?,?,?)",
                             (n, dh, tec, em, agora))
            if time.monotonic() > prazo:
                for outro in futuros:
                    outro.cancel()
                break
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
        conn.commit()
    resto = len(por_os) - lidas - falhas
    log(f"  fichas das recusas: {lidas} lidas, {corrigidas} com hora diferente do relatório"
        + (f", {falhas} falharam" if falhas else "") + (f", {resto} para a próxima" if resto > 0 else ""))
    return lidas


def mapa(conn):
    """{(os, data_hora, tecnico): tecnico_em} — só as que a ficha corrigiu."""
    try:
        rows = conn.execute("SELECT os, data_hora, tecnico, tecnico_em FROM ficha_recusa "
                            "WHERE tecnico_em IS NOT NULL AND tecnico_em <> data_hora").fetchall()
    except Exception:
        return {}
    return {(r[0], r[1], r[2]): r[3] for r in rows}
