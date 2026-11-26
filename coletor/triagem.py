# -*- coding: utf-8 -*-
"""Por que a OS saiu da esteira — lido da ficha (/os/{n}). Funções puras.

Nasceu em 25/11/2026 da triagem do Renan: ele abre cada OS da esteira e
devolve ao dono ("Rejeitando OS para o dono") o que não deve ir a campo — 86
devoluções num dia. A OS devolvida SAI da fila, e o backlog da War Room cai
sem que nada diga por quê. O painel dele (coleta pelo navegador logado,
`coleta_os_rejeitadas_w8.md`) virou isto, dentro da rodada da esteira.

Quem faz a ida ao WVSA e a gravação é `esteira.py` (passo 5 da rodada); aqui
só se lê o HTML e se decide. É isto que o teste por script exercita com
fichas reais salvas.

A regra que mais importa: a saída se classifica pelo EVENTO do histórico, e
não pelo estado atual da ficha. O estado muda depressa — a #601025 foi
devolvida e respondida pelo consultor no MESMO minuto (16:55 de 25/11) e às
17:38 já estava agendada de novo; lida às 17:46, a ficha dizia "Agendada",
sem localizador nenhum.
"""
import re
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup

BR_TZ = timezone(timedelta(hours=-3))
_DATA = re.compile(r"(\d{2})/(\d{2})/(\d{4})\s+(\d{2}):(\d{2})")
_DIA = re.compile(r"(\d{2})/(\d{2})/(\d{4})")

DEVOLUCAO = "rejeitando os para o dono"
# Eventos que DEVOLVEM a OS à fila. Se o mais recente antes da saída é um
# destes, a saída não foi causada por uma devolução antiga: a OS voltou,
# esperou e saiu por outra coisa.
_VOLTA_A_FILA = ("respondendo os", "os fechada sem sucesso", "fechada sem sucesso pelo",
                 "os removida da agenda", "recusando fechamento")
_AGENDOU = "os agendada para dia"

# Folga depois da hora da coleta: `saiu_em` é o INÍCIO da rodada que notou a
# saída, e a lista é lida segundos depois — o evento pode ser posterior a ele.
FOLGA = timedelta(minutes=10)
# O evento tem de ser recente: a fila é lida de 10 em 10 min, e a lacuna mais
# longa normal é a noite (22h → 06h). Devolução de 3 dias atrás não explica
# a saída de hoje.
JANELA = timedelta(hours=36)

LOCALIZADOR_DESTINO = [            # ordem do documento do Renan: o 1º que casar
    ("N1 Rejeitadas", "N1"),
    ("Comercial", "Comercial"),
    ("Relacionamento", "Relacionamento"),
]


def _quando(txt):
    m = _DATA.search(txt or "")
    if not m:
        return None
    d, mo, y, hh, mi = map(int, m.groups())
    try:
        return datetime(y, mo, d, hh, mi, tzinfo=BR_TZ)
    except ValueError:
        return None


def _campo(soup, rotulo, sep=" "):
    for tr in soup.find_all("tr"):
        c = tr.find_all(["td", "th"])
        if len(c) >= 2 and c[0].get_text(" ", strip=True) == rotulo:
            return c[1].get_text(sep, strip=True)
    return None


def parse(html):
    """Ficha -> {disponibilidade, status, localizadores, historico}.

    `historico`: [{em, autor, texto}], do mais recente para o mais antigo,
    como a aba "todos" do WVSA. Cada <li> tem o autor num `span.label`, o
    texto em `span.quebra-linha` (+ `p.desc`) e a hora em
    `span.timeline-date` — campos separados, o que dispensa adivinhar onde
    termina um evento (o documento do Renan lia o texto corrido e filtrava
    CSS e JS que apareciam no meio).
    """
    soup = BeautifulSoup(html, "lxml")
    disp = _campo(soup, "Disponibilidade") or ""
    # "Pronta para ser agendada - Entrou 25/11/2026 09:12 (8hrs)" -> só o rótulo
    disp = re.sub(r"\s+", " ", disp).split(" - ")[0].strip()
    loc = _campo(soup, "Localizadores", sep="|") or ""
    hist = []
    # A aba "todos" (`tab-all`) junta movimentação e eventos do app — mas só
    # existe quando a OS TEM evento do app. Sem ela, o histórico mora só em
    # `tab-os-movimentacao`: medido em 25/11/2026, 6 das 96 devolvidas (a
    # #582478, a #604217…) não tinham `tab-all`, e a devolução sumia.
    aba = soup.find("div", id="tab-all") or soup.find("div", id="tab-os-movimentacao")
    for li in (aba.select("ul.timeline li") if aba is not None else []):
        data = li.find("span", class_="timeline-date")
        em = _quando(data.get_text(" ", strip=True) if data else "")
        if em is None:
            continue
        autor = li.find("span", class_="label")
        partes = [e.get_text(" ", strip=True) for e in li.find_all(class_="quebra-linha")]
        hist.append({"em": em, "autor": autor.get_text(" ", strip=True) if autor else "",
                     "texto": re.sub(r"\s+", " ", " ".join(p for p in partes if p)).strip()})
    hist.sort(key=lambda e: e["em"], reverse=True)   # estável: empate mantém a ordem do WVSA
    status = re.sub(r"\s+", " ", _campo(soup, "Status") or "").strip()
    return {
        # Página sem Status nem histórico não é ficha (login de sessão
        # vencida, página de erro com HTTP 200): não se classifica por ela.
        "valida": bool(status or hist),
        "disponibilidade": disp,
        "status": status,
        "localizadores": [p.strip() for p in loc.split("|") if p.strip()],
        "historico": hist,
    }


def _baixo(t):
    return (t or "").lower()


def _comentario(texto):
    """O que vem depois de "Rejeitando OS para o dono:" — o pedido ao dono."""
    i = _baixo(texto).find(DEVOLUCAO)
    resto = texto[i + len(DEVOLUCAO):] if i >= 0 else texto
    return resto.lstrip(" :").strip()[:500]


def destino(ficha, texto_devolucao=""):
    """Para quem a OS foi devolvida. None quando a ficha já não diz (a
    resposta do consultor limpa os localizadores)."""
    if _baixo(texto_devolucao).startswith("enviando os para a infra"):
        return "Infra"
    locs = ficha["localizadores"]
    for rotulo, dest in LOCALIZADOR_DESTINO:
        if rotulo in locs:
            return dest
    if "Infra" in locs:
        return "Infra"
    if "Suporte" in locs or ficha["disponibilidade"].startswith("Rejeitada"):
        return "Suporte"
    return None


def _evento_da_saida(ficha, saiu_em):
    """O evento mais recente que muda o lugar da OS, até a saída (+ folga):
    ("devolucao" | "agendou" | "volta", evento) ou (None, None)."""
    limite = saiu_em + FOLGA
    for e in ficha["historico"]:
        if e["em"] > limite:
            continue
        t = _baixo(e["texto"])
        if DEVOLUCAO in t:
            tipo = "devolucao"
        elif t.startswith(_AGENDOU):
            tipo = "agendou"
        elif any(t.startswith(v) or v in t[:60] for v in _VOLTA_A_FILA):
            tipo = "volta"
        else:
            continue
        if e["em"] < saiu_em - JANELA:
            return None, None
        return tipo, e
    return None, None


def situacao(ficha, devolvida_em, na_fila):
    """Depois da devolução: {situacao, respondida_em, agendada_para}.

    Só os eventos POSTERIORES à devolução contam (o documento do Renan, passo
    5). Agendada vence cancelada: "Finalizada com sucesso" depois de agendar
    é a OS atendida, não cancelada.
    """
    depois = [e for e in ficha["historico"] if devolvida_em is None or e["em"] >= devolvida_em]
    # A própria devolução (e as do mesmo minuto) não é "depois"
    depois = [e for e in depois if DEVOLUCAO not in _baixo(e["texto"])]
    resp = [e["em"] for e in depois if _baixo(e["texto"]).startswith("respondendo os")]
    agend = [e for e in depois if _baixo(e["texto"]).startswith(_AGENDOU)]
    para = None
    if agend:
        m = _DIA.search(agend[0]["texto"])
        if m:
            d, mo, y = map(int, m.groups())
            try:
                para = datetime(y, mo, d).date().isoformat()
            except ValueError:
                para = None
    if agend:
        sit = "agendada"
    elif ficha["status"].startswith("Fechada"):
        sit = "cancelada"
    elif na_fila or resp:
        sit = "voltou_esteira"
    else:
        sit = "aguardando"
    return {"situacao": sit, "respondida_em": min(resp).isoformat() if resp else None,
            "agendada_para": para}


def classificar(ficha, saiu_em, na_fila=False):
    """Uma saída -> linha de `esteira_saidas` (sem os/saiu_em/finalidade).

    Pelo evento; sem evento recente, pelo estado — a ordem do documento:
    devolvida, agendada, fechada, outro.
    """
    tipo, ev = _evento_da_saida(ficha, saiu_em)
    disp, status = ficha["disponibilidade"], ficha["status"]
    if tipo == "devolucao" or (tipo is None and disp.startswith("Rejeitada")):
        linha = {"motivo": "devolvida", "destino": destino(ficha, ev["texto"] if ev else ""),
                 "devolvida_em": ev["em"].isoformat() if ev else None,
                 "devolvida_por": (ev["autor"] if ev else "")[:120] or None,
                 "comentario": _comentario(ev["texto"]) if ev else None}
        linha.update(situacao(ficha, ev["em"] if ev else None, na_fila))
        return linha
    if tipo == "agendou":
        return {"motivo": "agendada"}
    if status.startswith("Fechada"):
        return {"motivo": "fechada"}
    if disp.startswith("Agendada"):
        return {"motivo": "agendada"}
    return {"motivo": "outro"}
