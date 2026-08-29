"""Cliente da API da Groq — transcrição (Whisper) e texto (Llama).

Só `requests`, como todo o resto do projeto. Nenhum SDK: o SDK oficial
arrasta dependências que pesam na função serverless, e o que usamos aqui
são dois endpoints HTTP.

DUAS COISAS QUE NÃO PODEM SER ESQUECIDAS:

1. **Os ids de modelo vivem no ambiente, não aqui.** A Groq aposenta id
   de modelo periodicamente. Cravado no código, o dia da aposentadoria
   vira um 400 incompreensível em produção; em variável de ambiente, vira
   uma linha trocada na Vercel.

2. **O plano gratuito recusa com 429 e diz quando voltar.** Respeitar o
   `Retry-After` é a diferença entre esperar 8 segundos e ser bloqueado
   por insistência. Quando o teto do dia estourou de vez, esta camada
   levanta erro e quem chama mostra estado honesto na tela — nunca uma
   ata pela metade fingindo estar pronta.
"""
import json
import os
import time

import requests

BASE = "https://api.groq.com/openai/v1"

# Transcrever 2 min de áudio leva ~2s; gerar ata, ~10s. 45s é folga para
# o dia ruim, e ainda cabe no tempo de uma função serverless.
TIMEOUT = int(os.environ.get("GROQ_TIMEOUT", "45"))

MAX_TENTATIVAS = 3
ESPERA_PADRAO = 4  # segundos, quando o 429 não diz Retry-After

# Teto de tokens por minuto da conta. MEDIDO, não lido em tabela: o header
# `x-ratelimit-limit-tokens` da própria API diz 8000 no tier gratuito
# (`on_demand`); a tabela do site mostra 250000, que é do Developer Plan.
#
# 🚨 O `max_tokens` que reservamos para a RESPOSTA conta neste teto. Reservar
# 8000 estourava a cota do minuto sozinho, antes de mandar uma linha de texto:
# HTTP 413 "Request too large ... Requested 8537".
#
# Subiu de plano? Troque só este número — nada mais no código depende do tier.
TPM = int(os.environ.get("GROQ_TPM", "8000"))

# Margem: o teto é por MINUTO e por conta, então as transcrições e a chamada
# anterior ainda estão consumindo. 85% deixa espaço para elas.
ORCAMENTO = int(TPM * 0.85)

# Português rende ~3,5 caracteres por token. Serve para recusar cedo, com
# mensagem que explica, em vez de tomar 413 no meio da geração da ata.
CHARS_POR_TOKEN = 3.5

# Reserva para a resposta da ata. Exportada para que `reuniao_ia` decida o que
# mandar usando o MESMO número — dois orçamentos separados divergem calados.
MAX_TOKENS_ATA = 2800


def tokens_aprox(texto):
    return int(len(texto or "") / CHARS_POR_TOKEN)


def cabe(texto, max_tokens):
    """O par entrada+resposta cabe no orçamento de um minuto?"""
    return tokens_aprox(texto) + max_tokens <= ORCAMENTO


class IAIndisponivel(RuntimeError):
    """Falta configuração ou a Groq recusou.

    Tipo próprio para que a rota saiba distinguir 'o modelo não respondeu'
    de um bug nosso — e possa devolver uma mensagem que a pessoa entende,
    com botão de tentar de novo.
    """


def _chave():
    k = os.environ.get("GROQ_API_KEY", "").strip()
    if not k:
        raise IAIndisponivel(
            "GROQ_API_KEY não configurada. A transcrição fica indisponível "
            "até a chave entrar no .env (local) e nas variáveis da Vercel."
        )
    return k


def _modelo(variavel):
    m = os.environ.get(variavel, "").strip()
    if not m:
        raise IAIndisponivel(
            f"{variavel} não configurada. O id do modelo vem do ambiente "
            "porque a Groq aposenta ids — confira o atual em "
            "console.groq.com → Docs → Models."
        )
    return m


def _espera(resposta, tentativa):
    """Quanto dormir antes de tentar de novo.

    O `Retry-After` da Groq é a fonte da verdade; o backoff só existe para
    quando ele não vem.
    """
    cabecalho = resposta.headers.get("Retry-After") if resposta is not None else None
    if cabecalho:
        try:
            return min(float(cabecalho), 30)
        except ValueError:
            pass
    return min(ESPERA_PADRAO * tentativa, 30)


def _post(caminho, **kwargs):
    """POST com repetição em 429 e 5xx. Erro de 4xx não se repete.

    Repetir um 400 é queimar cota para receber o mesmo 'requisição
    inválida' três vezes.
    """
    url = f"{BASE}{caminho}"
    cabecalhos = {"Authorization": f"Bearer {_chave()}"}
    cabecalhos.update(kwargs.pop("headers", {}))

    ultimo = None
    for tentativa in range(1, MAX_TENTATIVAS + 1):
        try:
            r = requests.post(url, headers=cabecalhos, timeout=TIMEOUT, **kwargs)
        except requests.Timeout as e:
            ultimo = f"tempo esgotado após {TIMEOUT}s"
            if tentativa == MAX_TENTATIVAS:
                raise IAIndisponivel(f"Groq: {ultimo}") from e
            time.sleep(_espera(None, tentativa))
            continue

        if r.status_code < 300:
            return r

        if r.status_code == 429 or r.status_code >= 500:
            ultimo = f"HTTP {r.status_code}: {r.text[:200]}"
            if tentativa == MAX_TENTATIVAS:
                break
            time.sleep(_espera(r, tentativa))
            continue

        raise IAIndisponivel(f"Groq recusou (HTTP {r.status_code}): {r.text[:300]}")

    raise IAIndisponivel(
        f"Groq indisponível após {MAX_TENTATIVAS} tentativas — {ultimo}. "
        "O áudio está guardado; dá para tentar de novo em alguns minutos."
    )


# ---------------------------------------------------------------- áudio
def transcrever(audio, formato="audio/webm", nome="trecho.webm"):
    """Áudio em bytes -> texto. Um trecho por chamada.

    `language=pt` não é detalhe: sem isso o Whisper às vezes decide que
    reunião em português com sigla técnica é espanhol, e devolve tradução.
    `temperature=0` porque transcrição não é lugar para criatividade.
    """
    r = _post(
        "/audio/transcriptions",
        files={"file": (nome, audio, formato)},
        data={
            "model": _modelo("GROQ_MODELO_TRANSCRICAO"),
            "language": os.environ.get("REUNIAO_IDIOMA", "pt"),
            "response_format": "json",
            "temperature": "0",
        },
    )
    return (r.json().get("text") or "").strip()


# ----------------------------------------------------------------- texto
def _conversar(sistema, usuario, json_estrito=False, max_tokens=1500):
    """Uma pergunta, uma resposta em texto. Levanta se vier vazia.

    🚨 ARMADILHA PAGA (28/08/2026): o gpt-oss é modelo de RACIOCÍNIO, e os
    tokens de raciocínio saem do MESMO `max_tokens` da resposta. Com
    `max_tokens=400` ele gastou 398 pensando e devolveu `content` vazio com
    `finish_reason="length"` — sem erro nenhum. Duas defesas aqui:

      1. `reasoning_effort` baixo (env). Derruba o raciocínio de ~400 tokens
         para ~14 em tarefa de resumir, que não precisa de deliberação.
      2. Resposta vazia LEVANTA. Devolver "" em silêncio produziria ata com
         seção em branco e ninguém saberia que faltou algo.
    """
    corpo = {
        "model": _modelo("GROQ_MODELO_TEXTO"),
        "messages": [
            {"role": "system", "content": sistema},
            {"role": "user", "content": usuario},
        ],
        "temperature": 0.2,
        "max_tokens": max_tokens,
    }

    # Vazio no env = não enviar o parâmetro. Modelo sem raciocínio recusaria
    # com 400, e o id do modelo é trocável por variável de ambiente.
    esforco = os.environ.get("GROQ_REASONING_EFFORT", "low").strip()
    if esforco:
        corpo["reasoning_effort"] = esforco

    if json_estrito:
        corpo["response_format"] = {"type": "json_object"}

    # Recusa cedo e explicando, em vez de deixar a Groq devolver 413 com uma
    # mensagem sobre TPM que não diz o que fazer.
    entrada = f"{sistema}\n{usuario}"
    if not cabe(entrada, max_tokens):
        raise IAIndisponivel(
            f"O texto ({tokens_aprox(entrada)} tokens) mais a resposta "
            f"({max_tokens}) passam do teto de {TPM} tokens por minuto da conta. "
            "Reduza o trecho enviado ou aumente GROQ_TPM depois de subir de plano."
        )

    r = _post("/chat/completions", json=corpo,
              headers={"Content-Type": "application/json"})
    dados = r.json()
    escolhas = dados.get("choices") or []
    if not escolhas:
        raise IAIndisponivel("Groq devolveu resposta sem escolhas.")

    escolha = escolhas[0]
    conteudo = (escolha.get("message", {}).get("content") or "").strip()
    if conteudo:
        return conteudo

    if escolha.get("finish_reason") == "length":
        gastos = dados.get("usage", {}).get("completion_tokens_details", {})
        raise IAIndisponivel(
            f"O modelo esgotou o limite de {max_tokens} tokens antes de escrever "
            f"a resposta ({gastos.get('reasoning_tokens', '?')} foram de raciocínio). "
            "Aumente GROQ_REASONING_EFFORT para 'low' ou o limite de tokens."
        )
    raise IAIndisponivel(
        f"O modelo respondeu vazio (finish_reason={escolha.get('finish_reason')})."
    )


REGRA_COMUM = (
    "Você redige atas de reunião operacional de uma empresa de telecom. "
    "Escreva em português do Brasil, direto e sem adjetivo de elogio. "
    "NUNCA invente fato, nome, número ou prazo que não esteja no texto "
    "recebido: se algo não foi dito, simplesmente não entra. "
    "Transcrição automática erra nome próprio e sigla — na dúvida, "
    "reproduza como veio em vez de 'corrigir' para algo parecido."
)


def notas_do_trecho(texto):
    """Resumo curto de um trecho, feito logo depois de transcrevê-lo.

    Existe para reunião longa: quando a transcrição inteira não couber no
    contexto do modelo, a ata é montada a partir destas notas. Como o
    trecho já está na mão neste momento, sai praticamente de graça.
    """
    if not (texto or "").strip():
        return ""
    return _conversar(
        REGRA_COMUM +
        " Registre o que foi dito neste trecho em até 8 marcadores. Preserve "
        "números, datas, valores, nomes de pessoas e lugares exatamente como "
        "aparecem, e o argumento de quem falou — estes marcadores podem ser a "
        "única fonte da ata de uma reunião longa, e o áudio some em 30 dias.",
        texto,
        # 8 marcadores cabem em 900; as notas de 30 trechos ainda somam
        # ~4.000 tokens, dentro do que a ata final precisa consumir.
        max_tokens=900,
    )


ESQUEMA_ATA = """Responda SOMENTE com um objeto JSON com esta forma exata:
{
  "resumo": "3 a 6 frases sobre o que a reunião tratou",
  "pontos":          [{"titulo": "", "detalhe": ""}],
  "decisoes":        [{"texto": "", "acao_codigo": null}],
  "encaminhamentos": [{"texto": "", "responsavel": null, "prazo": null, "acao_codigo": null}],
  "pendencias":      [{"texto": "", "acao_codigo": null}],
  "riscos":          [{"texto": "", "acao_codigo": null}]
}

"pontos" é a parte mais importante e vem primeiro no seu raciocínio: percorra
a reunião NA ORDEM em que os assuntos apareceram e registre, em cada um, o que
foi efetivamente dito — números, datas, valores, nomes de pessoas, cidades,
equipamentos e o argumento de quem falou. Duas a quatro frases por ponto.
Prefira pecar por detalhe a resumir até a informação sumir: quem lê a ata não
ouviu o áudio, e o áudio some em 30 dias.

Um assunto vira um ponto mesmo que ninguém tenha decidido nada — a maior parte
de uma reunião é discussão, não decisão. Conversa fora do trabalho pode virar um
ponto de uma linha, sem detalhar.

As outras listas registram o que teve desfecho, e ficam vazias quando não houve.

Um "encaminhamento" é algo que alguém VAI FAZER — vale mesmo sem responsável
nomeado e mesmo dito de passagem: "na segunda a gente vê o projeto X",
"preciso cobrar o fornecedor", "vamos levantar isso". Se uma data foi dita
junto, ela é o prazo. Um assunto que combinou ação entra nos dois lugares: como
ponto, com o que se discutiu, e como encaminhamento, com o que ficou de ser
feito — não é repetição, é a diferença entre o que se falou e o que se combinou.

Nunca invente decisão que ninguém tomou só para a lista não ficar vazia.

Regras dos campos:
- "titulo": 2 a 6 palavras nomeando o assunto.
- "prazo": "AAAA-MM-DD" quando uma data for dita; caso contrário null.
- "responsavel": o nome como foi falado; null se ninguém foi nomeado.
- "acao_codigo": o código no formato AC-000 quando o trecho tratar de uma
  ação da pauta; null quando não der para afirmar. Não adivinhe.
- Lista sem conteúdo é lista vazia [], nunca item inventado para preencher."""


def gerar_ata(texto, pauta=None, participantes=None, data_reuniao=None):
    """Transcrição -> estrutura da ata (dict). A prosa é montada no Python.

    O modelo devolve dados, não Markdown: a formatação da ata é nossa e
    determinística. Assim duas reuniões saem com a mesma cara, e mudar o
    layout não depende de reescrever prompt.
    """
    contexto = []
    if data_reuniao:
        # Sem isto o modelo chuta o ano: numa transcrição que diz "dia dez de
        # setembro" ele devolveu 2023-09-10 — prazo três anos no passado, que
        # entraria na coluna `date` sem nada reclamar. A âncora é a data da
        # REUNIÃO, e não hoje, para que regerar a ata meses depois não mude
        # os prazos que foram combinados no dia.
        contexto.append(
            f"A reunião aconteceu em {data_reuniao}. Resolva qualquer data "
            "relativa ou sem ano ('dia 10', 'próxima terça', 'semana que vem') "
            "a partir DESSA data. Nunca invente um ano.")
    if participantes:
        contexto.append("Participantes: " + ", ".join(participantes) + ".")
    if pauta:
        contexto.append(
            "Ações que estavam na pauta (use estes códigos, não invente outros):\n"
            + "\n".join(f"- {c}: {t}" for c, t in pauta)
        )
    contexto.append("Transcrição:\n" + texto)

    bruto = _conversar(REGRA_COMUM + "\n" + ESQUEMA_ATA,
                       "\n\n".join(contexto), json_estrito=True, max_tokens=MAX_TOKENS_ATA)
    try:
        dados = json.loads(bruto)
    except json.JSONDecodeError as e:
        # Não gravamos ata pela metade: melhor a tela dizer "não deu, tente
        # de novo" do que registrar um documento truncado como oficial.
        raise IAIndisponivel(
            "O modelo devolveu uma resposta que não é JSON válido. "
            "Nada foi gravado; tente gerar a ata de novo."
        ) from e
    if not isinstance(dados, dict):
        raise IAIndisponivel("O modelo devolveu JSON que não é um objeto.")
    return dados


def texto_executivo(fatos):
    """Fatos já apurados em Python -> parágrafos de resumo executivo.

    O modelo NÃO conta reuniões nem decide o que é recorrente: isso é
    consulta ao banco, feita em `reuniao_ia.py`. Aqui ele só redige, e é
    por isso que o número na tela é sempre o mesmo número do banco.
    """
    return _conversar(
        REGRA_COMUM + " Escreva um resumo executivo em Markdown, no máximo "
        "um parágrafo curto por ação. Use SOMENTE os fatos listados: eles já "
        "foram apurados e estão corretos. Não some, não conte e não estime "
        "nada por conta própria.",
        fatos,
        max_tokens=1200,
    )
