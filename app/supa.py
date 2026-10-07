"""Acesso ao Supabase (Postgres) via REST/PostgREST, usando a service_role key.

Tudo roda no servidor (Flask) — a chave nunca vai para o browser. Mantemos
dependências mínimas (só `requests`) para ficar leve na função serverless.
"""
import contextvars
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from requests.adapters import HTTPAdapter

TIMEOUT = 15

# Uma sessão por processo, e não `requests.get` solto. Medido em 07/10/2026:
# cada chamada solta abria TCP + TLS do zero até o Supabase — ~3 viagens a
# mais por consulta, e uma tela de Ações faz ~17 consultas. Com a sessão, a
# conexão fica aberta entre consultas e entre requisições do mesmo container.
# O pool comporta as consultas que `paralelo` dispara de uma vez.
_sessao = requests.Session()
_sessao.mount("https://", HTTPAdapter(pool_connections=4, pool_maxsize=16))
_sessao.mount("http://", HTTPAdapter(pool_connections=4, pool_maxsize=16))

# Consultas independentes em paralelo (`paralelo`). Poucos trabalhadores de
# propósito: o gargalo é a viagem até o Supabase, não CPU, e mais threads só
# disputariam o mesmo pool de conexões.
_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="supa")
_trava_contagem = threading.Lock()


def paralelo(*funcoes):
    """Roda funções sem argumento em paralelo e devolve os resultados na ordem.

    Cada uma roda numa CÓPIA do contexto atual (`contextvars`), e é isso que
    deixa o `flask.g` da requisição visível dentro da thread — os caches por
    requisição de `auth.py` continuam valendo, e a contagem do `Server-Timing`
    soma tudo. Exceção de qualquer uma sobe aqui, como se fosse em série.
    """
    futuros = [_pool.submit(contextvars.copy_context().run, f) for f in funcoes]
    return [f.result() for f in futuros]


def _contar(inicio):
    """Soma a ida ao `Server-Timing` da requisição (ver `app/__init__.py`).

    Fora de requisição (scripts, coletor) não há onde somar e não faz nada.
    """
    try:
        from flask import g, has_app_context
        if not has_app_context():
            return
        ms = (time.perf_counter() - inicio) * 1000
        with _trava_contagem:
            g._supa_n = getattr(g, "_supa_n", 0) + 1
            g._supa_ms = getattr(g, "_supa_ms", 0.0) + ms
    except Exception:
        pass


def _pedir(metodo, url, **kwargs):
    """Toda ida ao Supabase passa por aqui: sessão persistente + contagem."""
    inicio = time.perf_counter()
    try:
        return _sessao.request(metodo, url, **kwargs)
    finally:
        _contar(inicio)


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


# Códigos do Postgres que o PostgREST devolve no corpo do 400. Só o primeiro
# significa "a migration ainda não subiu"; os outros são requisição errada.
_COLUNA_FALTANDO = "42703"


def coluna_faltando(erro):
    """O 400 foi por coluna inexistente — e não por uuid torto, filtro ruim etc.

    🚨 ARMADILHA PAGA (09/09/2026): os recuos de "migration ainda não aplicada"
    tratavam QUALQUER exceção como coluna faltando. Bastava alguém abrir
    `/reunioes/xx` — id que não é uuid, code `22P02` — para o recuo achar que a
    coluna não existia e desligar o conjunto estendido inteiro. A partir dali,
    e até o próximo cold start, o processo servia TODAS as reuniões sem ata,
    sem gravação e sem itens, para todo mundo. Uma URL adivinhada degradava o
    container.

    Medido: coluna inexistente devolve `42703`; uuid inválido, `22P02`.
    """
    r = getattr(erro, "response", None)
    if r is None:
        return False
    try:
        return (r.json() or {}).get("code") == _COLUNA_FALTANDO
    except Exception:
        # Corpo que não é JSON não prova nada — e recuar "na dúvida" é
        # exatamente o que causou o problema acima.
        return False


# Tabela que a migration ainda não criou: o PostgREST responde 404 com este
# código (medido em 29/09/2026 com `acao_checklist` antes da 0017). É irmão de
# `coluna_faltando`, e pelo mesmo motivo só este código conta.
_TABELA_FALTANDO = "PGRST205"


def tabela_faltando(erro):
    """O erro foi por tabela inexistente no cache do PostgREST."""
    r = getattr(erro, "response", None)
    if r is None:
        return False
    try:
        return (r.json() or {}).get("code") == _TABELA_FALTANDO
    except Exception:
        return False


def select(tabela, params=None, schema=None):
    """GET /rest/v1/<tabela> -> lista de dicts."""
    url, _ = _cfg()
    r = _pedir(
        "GET",
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
    r = _pedir(
        "POST",
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
    r = _pedir(
        "PATCH",
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
    r = _pedir(
        "DELETE",
        f"{url}/rest/v1/{tabela}",
        headers=_headers(),
        params=params,
        timeout=TIMEOUT,
    )
    r.raise_for_status()


def upsert(tabela, registro, on_conflict, schema=None):
    """POST com Prefer: resolution=merge-duplicates (upsert por `on_conflict`)."""
    url, _ = _cfg()
    r = _pedir(
        "POST",
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
    r = _pedir(
        "POST",
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
    r = _pedir(
        "POST",
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
    r = _pedir(
        "GET",
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

    r = _pedir(
        "DELETE",
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
