"""Texto do campo SOLICITACAO da OS — o que o técnico lê no celular, em campo.

Módulo puro, sem I/O, para o texto ser testável: ele vai para um sistema de
produção e "quase certo" não serve.

O texto é de um GRUPO de trechos, não de um desligamento. A Celesc publica o
mesmo bairro fatiado em várias ruas no mesmo dia, e é um deslocamento só — uma
OS por rua faria a equipe abrir quatro chamados para ir uma vez ao mesmo lugar.
Grupo de um trecho é uma lista de um.

Ordem das informações, e o porquê de cada bloco:
  1. QUANDO  — a janela do desligamento da Celesc
  2. ONDE    — cidade, bairro, os trechos com faixa numérica, coordenada e link
  3. QUANTA CONFIANÇA — se a posição veio de revisão humana ou automática.
     Omitir isso faria o técnico tratar palpite como certeza.

⚠️ O que NÃO entra aqui: a nossa rede no local (classificação, distância do
cabo, poste de terceiro mais próximo, contagem de postes e siglas `CB_*`). Saiu
a pedido do Jhoni em 04/09/2026. Aquilo é vocabulário do Geogrid: quem está no
poste não identifica ativo por sigla, e o bloco ocupava um terço do texto sem
mudar o que a equipe faz ao chegar. A classificação continua valendo — é ela
que escolhe quais desligamentos viram candidatos a OS —, ela só não é impressa.

⚠️ SEM ACENTOS. A Celesc entrega ASCII puro e o WVSA é um sistema antigo;
texto acentuado corre risco de virar "MANUTENC?O" na tela do técnico. Perder a
acentuação é preferível a entregar texto corrompido.
"""
import unicodedata


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


def _distintos(valores):
    """Valores não vazios, sem repetir, na ordem em que apareceram."""
    saida = []
    for v in valores:
        if v and v not in saida:
            saida.append(v)
    return saida


def _janela(grupo):
    """A janela do grupo: do primeiro início ao último fim.

    Trechos do mesmo bairro no mesmo dia costumam ter horários diferentes, e a
    equipe vai uma vez. Imprimir a janela de um trecho só faria a OS dizer
    "das 08:00 as 12:00" para um desligamento que se estende até as 17h.
    """
    data = _data_br(next((l.get("data") for l in grupo if l.get("data")), None))
    inicios = [l.get("hora_inicio") for l in grupo if l.get("hora_inicio")]
    fins = [l.get("hora_fim") for l in grupo if l.get("hora_fim")]
    if inicios and fins:
        return f"{data} das {min(inicios)} as {max(fins)}"
    return data


def montar(grupo):
    """Monta o texto a partir de um grupo de desligamentos já achatados."""
    # Um dict solto vira grupo de um: iterar as chaves de um dict aqui daria
    # um texto silenciosamente vazio, que é o pior desfecho possível.
    if isinstance(grupo, dict):
        grupo = [grupo]
    grupo = list(grupo)
    if not grupo:
        return ""

    linhas = ["TROCA DE POSTE - DESLIGAMENTO PROGRAMADO CELESC", ""]

    # --- Quando -------------------------------------------------------------
    linhas.append(f"DATA/HORA DO DESLIGAMENTO: {_janela(grupo)}")
    causas = _distintos(l.get("causa") for l in grupo)
    if causas:
        linhas.append("CAUSA INFORMADA PELA CELESC: "
                      + " / ".join(sem_acento(c) for c in causas))
    linhas.append("")

    # --- Onde ---------------------------------------------------------------
    linhas.append(f"LOCAL: {sem_acento(grupo[0].get('cidade'))}")
    bairros = _distintos(l.get("bairro") for l in grupo)
    if bairros:
        linhas.append("BAIRRO: " + " / ".join(sem_acento(b) for b in bairros))
    linhas.append("")
    linhas.append("TRECHOS AFETADOS:" if len(grupo) > 1 else "TRECHO AFETADO:")
    for l in grupo:
        linhas.append(f"- {sem_acento(_descrever_trecho(l))}")

    # A coordenada é a do primeiro trecho posicionado, não o centróide do
    # grupo: o centro de um bairro cai onde não há poste nenhum, e o link do
    # mapa serve para a equipe chegar a um ponto real da obra.
    referencia = next((l for l in grupo
                       if l.get("lat") is not None and l.get("lon") is not None), None)
    if referencia:
        lat, lon = float(referencia["lat"]), float(referencia["lon"])
        linhas.append("")
        linhas.append(f"COORDENADA: {lat:.6f}, {lon:.6f}")
        # Link que abre direto no app de mapas do celular do técnico.
        linhas.append(f"MAPA: https://www.google.com/maps?q={lat:.6f},{lon:.6f}")

    # --- Confiança ----------------------------------------------------------
    # Fala da coordenada IMPRESSA acima, por isso olha o trecho de referência e
    # não o grupo: dizer "conferida manualmente" por causa de outro trecho
    # descreveria um ponto que não está no texto.
    linhas.append("")
    linhas.append("POSICAO CONFERIDA MANUALMENTE."
                  if referencia and referencia.get("geo_validacao") == "manual"
                  else "POSICAO OBTIDA AUTOMATICAMENTE - CONFIRMAR NO LOCAL.")

    linhas.append("")
    linhas.append("Levar equipe para acompanhar a troca e preservar a rede.")

    return "\n".join(linhas)
