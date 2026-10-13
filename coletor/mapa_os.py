"""Imagem do local da troca de poste, para anexar à OS no WVSA.

Por que uma imagem, se a OS já leva o link do Google Maps: o link abre UM
ponto, e o grupo bairro/dia tem vários trechos — em 09/09/2026 a dispersão
mediana dos grupos era 916 m. O técnico precisa ver os trechos juntos, com o
nome das ruas, sem abrir nada. O anexo fica na ficha da OS, onde ele já olha.

Quem monta é o coletor (e não o portal) porque é ele quem anexa: o WVSA está
numa rede que a Vercel não alcança, e mandar a imagem do portal ao coletor
seria um caminho a mais para quebrar.

Módulo sem Supabase e sem WVSA: recebe os trechos já lidos e devolve PNG.
Só os ladrilhos do mapa vêm da rede.

⚠️ Ladrilhos do OpenStreetMap: a política de uso pede User-Agent que
identifique a aplicação, cache local e a atribuição visível na imagem. O
volume aqui é de algumas OS por dia, ~12 ladrilhos cada — dentro do uso leve
que a política aceita. Trocar por um servidor comercial é trocar `URL_TILE`.
"""
import io
import math
import os
import time
import unicodedata
from datetime import datetime, timedelta, timezone

import requests
from PIL import Image, ImageDraw, ImageFont

URL_TILE = os.environ.get("MAPA_TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
USER_AGENT = "PortalOperacionalUnetvale/1.0 (+https://unetvale.tallpa.com.br)"
CACHE = os.path.expanduser(os.environ.get("MAPA_CACHE", "~/unetvale-coletor/tiles"))
TILE = 256

LARGURA, ALTURA_MAPA = 1280, 760
MARGEM = 90            # px entre o ponto mais externo e a borda do mapa
ZOOM_MAX, ZOOM_UM_PONTO, ZOOM_MIN = 18, 17, 12

COR_PINO = (230, 55, 87)        # o "crítico" do portal: é obra em cima da rede
COR_FORA = (229, 160, 0)        # o âmbar do "fora do lugar" do mapa do portal
COR_TEXTO = (17, 30, 52)
COR_SUAVE = (98, 112, 133)
BR_TZ = timezone(timedelta(hours=-3))


def _fonte(tam, negrito=False):
    # Fonte do sistema quando existe (o coletor roda num Mac); senão a
    # embutida do Pillow, que também escala.
    for caminho in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if negrito
                    else "/System/Library/Fonts/Supplemental/Arial.ttf",
                    "/Library/Fonts/Arial.ttf"):
        if os.path.exists(caminho):
            return ImageFont.truetype(caminho, tam)
    return ImageFont.load_default(size=tam)


def sem_acento(txt):
    return "".join(c for c in unicodedata.normalize("NFD", str(txt or ""))
                   if unicodedata.category(c) != "Mn")


# ---------------------------------------------------------------- projeção
def _px(lat, lon, z):
    """Lat/lon -> pixel absoluto no zoom z (Web Mercator, o dos ladrilhos)."""
    n = TILE * (2 ** z)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


# --------------------------------------------------- fora do lugar (núcleo)
# A MESMA regra do mapa do portal (`agrupar` em app/static/js/troca_poste_mapa.js,
# que é a definição — mudar lá é mudar aqui). Medido em 09/09/2026: nos grupos
# com mais de 2 km de dispersão, o ponto afastado era sempre geocodificação
# errada. Na OS #586440 (PEREQUE, 14 trechos) um trecho caiu no centro de
# Porto Belo, a ~3 km dos outros 13 — enquadrá-lo afastava o mapa até os 13
# virarem um amontoado ilegível. O quadro é do NÚCLEO; o afastado vira um pino
# âmbar na borda, apontando para onde está, e a legenda diz a distância.
DIST_SUSPEITA_M = 1500


def metros(a, b):
    R = 111320
    d_lat = (b[0] - a[0]) * R
    d_lon = (b[1] - a[1]) * R * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(d_lat, d_lon)


def _mediana(v):
    o = sorted(v)
    n = len(o)
    return o[n // 2] if n % 2 else (o[n // 2 - 1] + o[n // 2]) / 2


def fora_do_lugar(trechos):
    """Índices (na lista dada) dos trechos com posição fora do lugar."""
    com = [(i, (t["lat"], t["lon"]), t.get("validacao")) for i, t in enumerate(trechos)
           if t.get("lat") is not None and t.get("lon") is not None]
    if len(com) >= 3:
        centro = (_mediana([p[0] for _, p, _ in com]), _mediana([p[1] for _, p, _ in com]))
        return {i for i, p, _ in com if metros(centro, p) > DIST_SUSPEITA_M}
    if len(com) == 2 and metros(com[0][1], com[1][1]) > DIST_SUSPEITA_M:
        # Dois afastados: não dá para saber qual é o errado. Só se acusa o que
        # a geocodificação já não avaliza; se forem os dois ou nenhum, ninguém.
        duvidosos = [i for i, _, v in com if v != "ok" and v != "manual"]
        return set(duvidosos) if len(duvidosos) == 1 else set()
    return set()


def escolher_zoom(pontos):
    """O MAIOR zoom em que todos os pontos cabem no quadro, com margem.

    Um ponto só fica em 17: no 18 a rua ocupa a imagem inteira e some a
    referência do entorno. O piso é 12 — um grupo com um trecho
    mal geocodificado a 7 km (Navegantes, 09/09/2026) ainda sai, só mais
    de longe, e a legenda diz qual ponto é qual.
    """
    if len(pontos) == 1:
        return ZOOM_UM_PONTO
    for z in range(ZOOM_MAX, ZOOM_MIN - 1, -1):
        xs, ys = zip(*(_px(la, lo, z) for la, lo in pontos))
        if (max(xs) - min(xs) <= LARGURA - 2 * MARGEM
                and max(ys) - min(ys) <= ALTURA_MAPA - 2 * MARGEM):
            return z
    return ZOOM_MIN


# --------------------------------------------------------------- ladrilhos
_sessao = requests.Session()
_sessao.headers["User-Agent"] = USER_AGENT


def _ladrilho(z, x, y):
    """Um ladrilho, do cache se já veio. None se não deu para baixar."""
    n = 2 ** z
    x %= n
    if not 0 <= y < n:
        return None
    caminho = os.path.join(CACHE, str(z), str(x), f"{y}.png")
    if os.path.exists(caminho):
        try:
            return Image.open(caminho).convert("RGB")
        except OSError:
            pass  # cache corrompido: baixa de novo
    try:
        r = _sessao.get(URL_TILE.format(z=z, x=x, y=y), timeout=15)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception:
        return None
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    img.save(caminho)
    time.sleep(0.05)  # gentileza com o servidor público
    return img


def _fundo(centro_x, centro_y, z):
    """O mapa de LARGURA x ALTURA_MAPA centrado no pixel absoluto dado."""
    x0, y0 = centro_x - LARGURA / 2, centro_y - ALTURA_MAPA / 2
    img = Image.new("RGB", (LARGURA, ALTURA_MAPA), (229, 227, 223))
    baixados = faltaram = 0
    for tx in range(int(x0 // TILE), int((x0 + LARGURA) // TILE) + 1):
        for ty in range(int(y0 // TILE), int((y0 + ALTURA_MAPA) // TILE) + 1):
            t = _ladrilho(z, tx, ty)
            if t is None:
                faltaram += 1
                continue
            baixados += 1
            img.paste(t, (int(tx * TILE - x0), int(ty * TILE - y0)))
    if not baixados:
        # Imagem só de fundo cinza com pinos soltos não ajuda ninguém em campo
        # — é melhor não anexar e deixar o erro registrado.
        raise RuntimeError("nenhum ladrilho do mapa pôde ser baixado")
    return img, x0, y0


# ------------------------------------------------------------------ desenho
def _texto_trecho(t):
    via = " ".join(x for x in (t.get("tipo_via"), t.get("logradouro")) if x) or t.get("endereco") or "?"
    ini, fim = t.get("numero_inicio"), t.get("numero_fim")
    if ini is not None or fim is not None:
        via += f", n. {ini if ini is not None else '?'} a {fim if fim is not None else '?'}"
    return sem_acento(via)


def gerar_png(cab, trechos, agora=None):
    """PNG (bytes) com o mapa dos trechos e a legenda.

    `cab`: {os, cidade, bairro, data_br, janela}. `trechos`: lista na ordem
    em que o script da OS os lista, cada um com lat/lon (ou None),
    tipo_via, logradouro, numero_inicio, numero_fim, endereco, validacao.
    Levanta se nenhum trecho tem posição — sem ponto não há o que mostrar.
    """
    agora = agora or datetime.now(BR_TZ)
    com_pos = [(i, t) for i, t in enumerate(trechos, 1)
               if t.get("lat") is not None and t.get("lon") is not None]
    if not com_pos:
        raise ValueError("nenhum trecho do grupo tem posição no mapa")

    fora = {i + 1 for i in fora_do_lugar(trechos)}
    # Todos "fora" = não há núcleo: os pontos estão espalhados e nenhum é
    # referência para acusar o outro (OS #594276, 13/10/2026: três trechos
    # `revisar` a quilômetros entre si — o núcleo vazio derrubava o desenho).
    # Enquadra todos e não acusa ninguém; a legenda já marca os duvidosos.
    if len(fora) == len(com_pos):
        fora = set()
    nucleo = [(i, t) for i, t in com_pos if i not in fora]
    pontos = [(t["lat"], t["lon"]) for _, t in nucleo]
    z = escolher_zoom(pontos)
    xs, ys = zip(*(_px(la, lo, z) for la, lo in pontos))
    cx0, cy0 = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    mapa, x0, y0 = _fundo(cx0, cy0, z)
    centro_nucleo = (_mediana([p[0] for p in pontos]), _mediana([p[1] for p in pontos]))
    distancia = {i: metros(centro_nucleo, (t["lat"], t["lon"])) for i, t in com_pos if i in fora}

    d = ImageDraw.Draw(mapa)
    f_num = _fonte(17, True)

    def pino(cx, cy, i, cor):
        r = 15
        d.ellipse((cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3), fill=(255, 255, 255))
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=cor)
        d.text((cx, cy), str(i), font=f_num, fill=(255, 255, 255), anchor="mm")

    # Do mais ao norte para o mais ao sul: o de baixo desenha por cima, como
    # num mapa de papel — e o número do de cima não some atrás do vizinho.
    for (i, t), x, y in sorted(zip(nucleo, xs, ys), key=lambda p: p[2]):
        pino(x - x0, y - y0, i, COR_PINO)

    # Fora do lugar: dentro do quadro, desenha onde está (em âmbar); fora,
    # na borda, na direção dele, com uma seta — some do mapa, não da OS.
    for i, t in com_pos:
        if i not in fora:
            continue
        px, py = _px(t["lat"], t["lon"], z)
        cx, cy = px - x0, py - y0
        if 0 <= cx <= LARGURA and 0 <= cy <= ALTURA_MAPA:
            pino(cx, cy, i, COR_FORA)
            continue
        dx, dy = px - cx0, py - cy0
        borda = 30
        k = min((LARGURA / 2 - borda) / abs(dx) if dx else 1e9,
                (ALTURA_MAPA / 2 - borda) / abs(dy) if dy else 1e9)
        bx, by = LARGURA / 2 + dx * k, ALTURA_MAPA / 2 + dy * k
        ang = math.atan2(dy, dx)
        ponta = (bx + math.cos(ang) * 26, by + math.sin(ang) * 26)
        lado = [(bx + math.cos(ang + s) * 14, by + math.sin(ang + s) * 14) for s in (2.4, -2.4)]
        d.polygon([ponta, *lado], fill=COR_FORA)
        pino(bx, by, i, COR_FORA)

    # --- cabeçalho, legenda e rodapé ---------------------------------------
    f_tit, f_sub = _fonte(26, True), _fonte(18)
    f_leg, f_peq = _fonte(17), _fonte(14)
    alt_cab, alt_linha = 84, 28
    alt_leg = 22 + alt_linha * len(trechos) + 12
    alt_rod = 34
    img = Image.new("RGB", (LARGURA, alt_cab + ALTURA_MAPA + alt_leg + alt_rod), (255, 255, 255))
    img.paste(mapa, (0, alt_cab))
    d = ImageDraw.Draw(img)

    d.text((24, 14), sem_acento(f"OS #{cab.get('os') or '?'} - Troca de poste"), font=f_tit, fill=COR_TEXTO)
    n = len(trechos)
    sub = (f"{cab.get('cidade') or ''} - {cab.get('bairro') or 'sem bairro'}  |  "
           f"{cab.get('janela') or cab.get('data_br') or ''}  |  {n} {'trecho' if n == 1 else 'trechos'}")
    d.text((24, 50), sem_acento(sub), font=f_sub, fill=COR_SUAVE)

    y = alt_cab + ALTURA_MAPA + 16
    for i, t in enumerate(trechos, 1):
        tem = t.get("lat") is not None and t.get("lon") is not None
        cx, cy = 38, y + alt_linha // 2 - 2
        if tem:
            d.ellipse((cx - 11, cy - 11, cx + 11, cy + 11), fill=COR_FORA if i in fora else COR_PINO)
            d.text((cx, cy), str(i), font=_fonte(13, True), fill=(255, 255, 255), anchor="mm")
        else:
            d.ellipse((cx - 11, cy - 11, cx + 11, cy + 11), outline=COR_SUAVE, width=2)
            d.text((cx, cy), str(i), font=_fonte(13, True), fill=COR_SUAVE, anchor="mm")
        linha = _texto_trecho(t)
        nota = ""
        if tem:
            linha += f"   ({t['lat']:.6f}, {t['lon']:.6f})"
            # Só o que pede atenção ganha nota. "Automática" vale para quase
            # todos (a linha de rodapé diz isso uma vez); repetida em cada
            # linha, viraria ruído que ninguém lê.
            if i in fora:
                nota = f"FORA DO LUGAR: a {distancia[i] / 1000:.1f} km dos outros - conferir".replace(".", ",")
            elif t.get("validacao") == "revisar":
                nota = "posicao duvidosa - conferir"
            elif t.get("validacao") == "manual":
                nota = "posicao conferida"
        else:
            nota = "sem posicao no mapa"
        d.text((62, cy), linha, font=f_leg, fill=COR_TEXTO if tem else COR_SUAVE, anchor="lm")
        if nota:
            x_nota = 62 + d.textlength(linha, font=f_leg) + 14
            d.text((x_nota, cy), nota, font=_fonte(16, True),
                   fill=COR_FORA if i in fora else COR_SUAVE, anchor="lm")
        y += alt_linha

    d.text((24, img.height - alt_rod / 2),
           "Posicoes obtidas automaticamente a partir do aviso da Celesc - confirmar no local.  |  "
           "Mapa: (c) colaboradores do OpenStreetMap  |  Portal Operacional Unetvale, "
           + agora.strftime("%d/%m/%Y %H:%M"),
           font=f_peq, fill=COR_SUAVE, anchor="lm")

    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()
