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


def _headers(extra=None):
    _, key = _cfg()
    h = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def select(tabela, params=None):
    """GET /rest/v1/<tabela> -> lista de dicts."""
    url, _ = _cfg()
    r = requests.get(
        f"{url}/rest/v1/{tabela}",
        headers=_headers(),
        params=params or {},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def select_one(tabela, params=None):
    rows = select(tabela, params)
    return rows[0] if rows else None


def insert(tabela, registro):
    """POST /rest/v1/<tabela> -> registro criado."""
    url, _ = _cfg()
    r = requests.post(
        f"{url}/rest/v1/{tabela}",
        headers=_headers({"Prefer": "return=representation"}),
        json=registro,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    return data[0] if isinstance(data, list) and data else data


def update(tabela, match, mudancas):
    """PATCH /rest/v1/<tabela>?<match> -> registros atualizados.

    `match` é um dict {coluna: valor} convertido em filtro de igualdade.
    """
    url, _ = _cfg()
    params = {k: f"eq.{v}" for k, v in match.items()}
    r = requests.patch(
        f"{url}/rest/v1/{tabela}",
        headers=_headers({"Prefer": "return=representation"}),
        params=params,
        json=mudancas,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def upsert(tabela, registro, on_conflict):
    """POST com Prefer: resolution=merge-duplicates (upsert por `on_conflict`)."""
    url, _ = _cfg()
    r = requests.post(
        f"{url}/rest/v1/{tabela}",
        headers=_headers({"Prefer": f"resolution=merge-duplicates,return=representation"}),
        params={"on_conflict": on_conflict},
        json=registro,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    return data[0] if isinstance(data, list) and data else data
