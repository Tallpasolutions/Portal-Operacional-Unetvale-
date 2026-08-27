"""Texto do campo SOLICITACAO da OS — o que o técnico lê no celular, em campo.

Módulo puro, sem I/O, para o texto ser testável: ele vai para um sistema de
produção e "quase certo" não serve.

Ordem das informações, e o porquê de cada bloco:
  1. QUANDO  — a janela do desligamento da Celesc
  2. ONDE    — cidade, bairro, trecho com faixa numérica, coordenada e link
  3. O QUE TEMOS LÁ — cabos, postes e caixas com as siglas do Geogrid, porque
     é assim que o técnico identifica o ativo no poste
  4. QUANTA CONFIANÇA — se a posição veio de revisão humana ou automática.
     Omitir isso faria o técnico tratar palpite como certeza.

⚠️ SEM ACENTOS. A Celesc entrega ASCII puro e o WVSA é um sistema antigo;
texto acentuado corre risco de virar "MANUTENC?O" na tela do técnico. Perder a
acentuação é preferível a entregar texto corrompido.
"""
import unicodedata

ROTULO_CLASSIFICACAO = {
    "critico": "CRITICO - rede muito proxima",
    "alto": "ALTO - rede proxima",
    "medio": "MEDIO",
    "baixo": "BAIXO",
    "sem_rede": "SEM REDE MAPEADA NO LOCAL",
    "indeterminado": "NAO CONFIRMADO",
}


def sem_acento(txt):
    """Remove acentos preservando a letra base."""
    if not txt:
        return ""
    return "".join(c for c in unicodedata.normalize("NFD", str(txt))
                   if unicodedata.category(c) != "Mn")


def _data_br(iso):
    if not iso:
        return ""
    partes = iso.split("-")
    return f"{partes[2]}/{partes[1]}/{partes[0]}" if len(partes) == 3 else iso


def _descrever_trecho(linha):
    via = " ".join(x for x in [linha.get("tipo_via"), linha.get("logradouro")] if x)
    if not via:
        via = linha.get("endereco") or ""
    ini, fim = linha.get("numero_inicio"), linha.get("numero_fim")
    if ini is None and fim is None:
        return via
    # "numero 0" da Celesc já virou None no parser; aqui "?" é "não informado".
    return f"{via} (n. {ini if ini is not None else '?'} ao {fim if fim is not None else '?'})"


def montar(l):
    """Monta o texto a partir de uma linha de desligamento já achatada."""
    linhas = ["TROCA DE POSTE - DESLIGAMENTO PROGRAMADO CELESC", ""]

    # --- Quando -------------------------------------------------------------
    if l.get("hora_inicio") and l.get("hora_fim"):
        janela = f"{_data_br(l.get('data'))} das {l['hora_inicio']} as {l['hora_fim']}"
    else:
        janela = _data_br(l.get("data"))
    linhas.append(f"DATA/HORA DO DESLIGAMENTO: {janela}")
    if l.get("causa"):
        linhas.append(f"CAUSA INFORMADA PELA CELESC: {sem_acento(l['causa'])}")
    linhas.append("")

    # --- Onde ---------------------------------------------------------------
    linhas.append(f"LOCAL: {sem_acento(l.get('cidade'))}")
    if l.get("bairro"):
        linhas.append(f"BAIRRO: {sem_acento(l['bairro'])}")
    linhas.append("")
    linhas.append("TRECHO AFETADO:")
    linhas.append(f"- {sem_acento(_descrever_trecho(l))}")

    if l.get("lat") is not None and l.get("lon") is not None:
        lat, lon = float(l["lat"]), float(l["lon"])
        linhas.append("")
        linhas.append(f"COORDENADA: {lat:.6f}, {lon:.6f}")
        # Link que abre direto no app de mapas do celular do técnico.
        linhas.append(f"MAPA: https://www.google.com/maps?q={lat:.6f},{lon:.6f}")

    # --- O que temos lá -----------------------------------------------------
    linhas.append("")
    classificacao = l.get("classificacao")
    if classificacao and classificacao != "indeterminado":
        linhas.append(f"NOSSA REDE NO LOCAL: "
                      f"{ROTULO_CLASSIFICACAO.get(classificacao, classificacao)}")
        if l.get("dist_cabo") is not None:
            linhas.append(f"- Cabo optico a {round(float(l['dist_cabo']))} m do ponto")
        if l.get("dist_poste") is not None:
            linhas.append(f"- Poste de terceiro mais proximo a {round(float(l['dist_poste']))} m")
        if l.get("qtd_postes"):
            linhas.append(f"- {l['qtd_postes']} poste(s) com nossa rede na area")
        cabos = l.get("cabos") or []
        if cabos:
            linhas.append(f"- Cabos: {', '.join(sem_acento(c) for c in cabos[:6])}")
    else:
        linhas.append("NOSSA REDE NO LOCAL: nao avaliada")

    # --- Confiança ----------------------------------------------------------
    linhas.append("")
    linhas.append("POSICAO CONFERIDA MANUALMENTE."
                  if l.get("geo_validacao") == "manual"
                  else "POSICAO OBTIDA AUTOMATICAMENTE - CONFIRMAR NO LOCAL.")

    linhas.append("")
    linhas.append("Levar equipe para acompanhar a troca e preservar a rede.")

    return "\n".join(linhas)
