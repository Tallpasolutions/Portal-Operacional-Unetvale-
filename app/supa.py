"""Acesso ao Supabase (Postgres) via REST/PostgREST, usando a service_role key.

Tudo roda no servidor (Flask) — a chave nunca vai para o browser. Mantemos
dependências mínimas (só `requests`) para ficar leve na função serverless.
"""
import os

import requests

TIMEOUT = 15


def _cfg():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY não configurados")
    return url, key


def _headers(extra=None, schema=None):
    """Cabeçalhos padrão. `schema` seleciona um schema fora do `public`.

    O PostgREST endereça schema por cabeçalho, não por caminho: `Accept-Profile`
    na leitura e `Content-Profile` na escrita. Sem isso, uma tabela de outro
    schema responde 404 mesmo estando exposta na Data API.
    """
    _, key = _cfg()
    h = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if schema:
        h["Accept-Profile"] = schema
        h["Content-Profile"] = schema
    if extra:
        h.update(extra)
    return h


def select(tabela, params=None, schema=None):
    """GET /rest/v1/<tabela> -> lista de dicts."""
    url, _ = _cfg()
    r = requests.get(
        f"{url}/rest/v1/{tabela}",
        headers=_headers(schema=schema),
        params=params or {},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def select_one(tabela, params=None, schema=None):
    rows = select(tabela, params, schema=schema)
    return rows[0] if rows else None


def insert(tabela, registro, schema=None):
    """POST /rest/v1/<tabela> -> registro criado."""
    url, _ = _cfg()
    r = requests.post(
        f"{url}/rest/v1/{tabela}",
        headers=_headers({"Prefer": "return=representation"}, schema=schema),
        json=registro,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    return data[0] if isinstance(data, list) and data else data


def update(tabela, match, mudancas, schema=None):
    """PATCH /rest/v1/<tabela>?<match> -> registros atualizados.

    `match` é um dict {coluna: valor} convertido em filtro de igualdade.
    """
    url, _ = _cfg()
    params = {k: f"eq.{v}" for k, v in match.items()}
    r = requests.patch(
        f"{url}/rest/v1/{tabela}",
        headers=_headers({"Prefer": "return=representation"}, schema=schema),
        params=params,
        json=mudancas,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def delete(tabela, match):
    """DELETE /rest/v1/<tabela>?<match>.

    `match` é um dict {coluna: valor} convertido em filtro de igualdade — a
    mesma forma do `update`. Sem filtro o PostgREST recusaria apagar a tabela
    inteira, mas não confiamos nisso: um match vazio levanta erro aqui.
    """
    if not match:
        raise ValueError("delete sem filtro não é permitido")
    url, _ = _cfg()
    # Valor em lista vira `in.(...)`: apagar 10 linhas em UMA requisição em vez
    # de dez. Cada ida ao PostgREST custa ~0,27s, então dez viram 2,7s de
    # espera que o usuário sente e que não tem motivo para existir.
    params = {}
    for k, v in match.items():
        if isinstance(v, (list, tuple, set)):
            if not v:
                return
            params[k] = f"in.({','.join(str(x) for x in v)})"
        else:
            params[k] = f"eq.{v}"
    r = requests.delete(
        f"{url}/rest/v1/{tabela}",
        headers=_headers(),
        params=params,
        timeout=TIMEOUT,
    )
    r.raise_for_status()


def upsert(tabela, registro, on_conflict, schema=None):
    """POST com Prefer: resolution=merge-duplicates (upsert por `on_conflict`)."""
    url, _ = _cfg()
    r = requests.post(
        f"{url}/rest/v1/{tabela}",
        headers=_headers({"Prefer": f"resolution=merge-duplicates,return=representation"},
                         schema=schema),
        params={"on_conflict": on_conflict},
        json=registro,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    return data[0] if isinstance(data, list) and data else data


def rpc(funcao, argumentos=None, schema=None):
    """POST /rest/v1/rpc/<funcao> -> o que a função devolver.

    Existe para o que precisa ser ATÔMICO. O PostgREST não tem transação
    entre requisições: três chamadas seguidas podem parar na segunda e deixar
    meio fato gravado. Quando os passos são um fato só — a revisão de endereço
    grava a posição, aprende o alias e recalcula o match —, a transação mora
    numa função no Postgres e daqui sai uma requisição.
    """
    url, _ = _cfg()
    r = requests.post(
        f"{url}/rest/v1/rpc/{funcao}",
        headers=_headers(schema=schema),
        json=argumentos or {},
        timeout=TIMEOUT,
    )
    if r.status_code >= 400:
        # `raise_for_status()` sozinho descarta o corpo, e é o corpo que traz o
        # `message` do `raise exception` da função — sem ele a rota só sabe
        # "HTTP 400" e devolve 500 para o que era erro de entrada.
        try:
            corpo = r.json()
        except ValueError:
            corpo = {}
        detalhe = corpo.get("message") or corpo.get("hint") or r.text[:300]
        raise RuntimeError(f"{funcao}: {detalhe}")
    # Função `returns void` responde 204 sem corpo; `.json()` estouraria.
    return r.json() if r.content else None


# =====================================================================
# Storage — arquivos de áudio das reuniões.
#
# Por que o navegador sobe DIRETO para o Storage, com URL assinada, em
# vez de mandar o arquivo para o Flask: a função serverless da Vercel tem
# limite de corpo de requisição (~4,5 MB) e um áudio de reunião passa
# disso com folga. A URL assinada tira o Flask do caminho do upload — ele
# só autoriza. De quebra, o áudio não trafega duas vezes.
#
# O bucket é PRIVADO. Todo acesso aqui usa a service_role, que ignora
# RLS; o browser nunca recebe a chave, só um token de escrita para UM
# caminho específico, com validade curta.
# =====================================================================

# Arquivo é mais lento que JSON: 15s derruba upload de trecho em 4G ruim.
TIMEOUT_ARQUIVO = 45


def storage_assinar_upload(bucket, caminho):
    """Autoriza o browser a gravar UM objeto. Devolve a URL completa do PUT.

    A resposta do Supabase traz um caminho relativo (`/object/upload/...`);
    devolvemos já absoluto porque quem consome é o JS, e montar URL no
    front é onde barra duplicada e host errado aparecem.
    """
    url, _ = _cfg()
    r = requests.post(
        f"{url}/storage/v1/object/upload/sign/{bucket}/{caminho}",
        # Duas exigências da API de Storage, ambas descobertas na marra:
        #
        # 1. `x-upsert: true` no CABEÇALHO. Sem ele, assinar um caminho que já
        #    tem objeto devolve 409 "resource already exists" — e é exatamente
        #    o que acontece quando a rede oscila e o navegador reenvia o mesmo
        #    trecho. Pôr `upsert` no corpo NÃO resolve; só o cabeçalho vale.
        # 2. Corpo presente, mesmo trivial. `_headers()` manda
        #    `Content-Type: application/json`, e a API responde 400 "Body
        #    cannot be empty when content-type is set to application/json".
        headers=_headers({"x-upsert": "true"}),
        json={},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    relativo = r.json().get("url") or ""
    return f"{url}/storage/v1{relativo}"


def storage_baixar(bucket, caminho):
    """Lê o objeto de volta, em bytes. É o que alimenta a transcrição."""
    url, _ = _cfg()
    r = requests.get(
        f"{url}/storage/v1/object/{bucket}/{caminho}",
        headers=_headers(),
        timeout=TIMEOUT_ARQUIVO,
    )
    r.raise_for_status()
    return r.content


def storage_apagar(bucket, caminho):
    """Apaga o objeto. Usado pelo expurgo dos 30 dias.

    404 é tratado como sucesso: o objetivo é 'não existe mais'. Levantar
    erro porque já tinha sumido faria o expurgo travar para sempre no
    mesmo registro.
    """
    url, _ = _cfg()
    # Sem `Content-Type`: a API de Storage recusa DELETE com corpo vazio quando
    # o cabeçalho diz application/json (o mesmo 400 do `storage_assinar_upload`,
    # que lá se resolve mandando um corpo — aqui não há corpo para mandar).
    cabecalhos = _headers()
    cabecalhos.pop("Content-Type", None)

    r = requests.delete(
        f"{url}/storage/v1/object/{bucket}/{caminho}",
        headers=cabecalhos,
        timeout=TIMEOUT,
    )
    # "Já não existe" é sucesso — o objetivo do expurgo é a ausência do
    # arquivo, não o ato de apagar. Mas a API não diz isso com 404: devolve
    # HTTP 400 com `"statusCode":"404","code":"NoSuchKey"` NO CORPO. Conferir
    # só o status deixaria o expurgo travado para sempre no mesmo registro,
    # tentando apagar o que já sumiu.
    if r.status_code >= 400:
        try:
            corpo = r.json()
        except ValueError:
            corpo = {}
        if str(corpo.get("statusCode")) == "404" or corpo.get("code") == "NoSuchKey":
            return
    r.raise_for_status()
