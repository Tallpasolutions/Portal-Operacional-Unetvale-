#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Importa o histórico do Esteira-OS (Supabase do Renan) para o portal. UMA vez.

Entrada: a pasta `dados_csv` do backup exportado do projeto antigo
(`supabase_AAAAMMDD_HHMM.zip`, com `manifesto.json` ao lado). Os dados não
moram no repositório nem em migration: são nomes, endereços e observações de
técnico.

Rodar DEPOIS da migration 0020 e ANTES da primeira coleta do coletor novo
(`esteira.py`). A primeira coleta compara contra a fila importada; sem ela,
vira linha de base e o histórico fica sem continuidade.

Uso:
  python importar_esteira_legado.py ~/unetvale-coletor/legado/supabase_X/dados_csv
  python importar_esteira_legado.py <pasta> --conferir   # só lê e mostra o plano
  python importar_esteira_legado.py <pasta> --dsn postgresql://…   # banco de ensaio

Idempotente: tudo é `on conflict do nothing` (ver `esteira_importar_legado`),
então rodar de novo não duplica nem sobrescreve.

Correções aplicadas na passagem — cada uma medida no backup de 22/10/2026:

  * `entrou_fila` e `data_evento` das tentativas estão 3 h NO PASSADO (1.091
    e 602 de 602 comparadas com a leitura nova do WVSA). O Esteira-OS gravava
    hora local sem fuso e o Postgres a lia como UTC — a armadilha do
    `datetime.now()` (§6). O relógio está certo; o fuso não. Lê-se o relógio
    como hora de Brasília. Sem isso, além da hora errada na tela, cada
    tentativa já conhecida voltaria como NOVA na primeira coleta (o unique é
    `(os, data_evento)`).
  * 9 linhas das listas foram gravadas depois das 21h com o dia anterior. O
    dia operacional aqui sai de `em`; para elas, `em` vira o último instante
    daquele dia, e o dia do histórico se mantém.
  * 138 OS aparecem nas listas e não em `ordens_servico` (a FK recusaria):
    entram como OS inativa, só com finalidade e cidade.
  * `agendado_para` vem DD/MM/AAAA; 25 bairros são o rótulo "Endereço".

O que NÃO entra: `fluxo_diario` (contagens). A lista OS a OS é a verdade — o
total contava cada transição e fica 3–10% acima — e serve só de conferência
no relatório do fim.
"""
import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

DIR = Path(__file__).resolve().parent
load_dotenv(DIR / ".env")

BR_TZ = timezone(timedelta(hours=-3))
LOTE = 500
ROTULOS = {"endereço", "endereco", "cidade", "bairro", "status", "produto", "finalidade",
           "solicitante", "categorias", "alternativo"}
TABELAS = ("ordens_servico", "cidades", "finalidades", "fluxo_os_dia", "fluxo_diario",
           "tentativas_sem_sucesso", "backlog_diario", "backlog_oficial", "coleta_meta")


def ler(pasta, nome):
    with open(pasta / f"{nome}.csv", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def relogio_br(txt):
    """'2026-02-05T11:10:00+00:00' gravado errado -> '2026-02-05T11:10:00-03:00'."""
    if not txt:
        return None
    return datetime.fromisoformat(txt).replace(tzinfo=BR_TZ).isoformat()


def data_br(txt):
    """'03/09/2026' -> '2026-09-03'."""
    try:
        d, m, a = (int(x) for x in (txt or "").split("/"))
        return date(a, m, d).isoformat()
    except ValueError:
        return None


def limpo(txt):
    t = (txt or "").strip()
    return None if not t or t.lower() in ROTULOS else t


def num(txt, tipo=float):
    try:
        return tipo(txt) if txt not in (None, "") else None
    except ValueError:
        return None


def montar(pasta):
    manifesto = json.loads((pasta.parent / "manifesto.json").read_text(encoding="utf-8"))
    dados = {t: ler(pasta, t) for t in TABELAS}
    for t in TABELAS:
        esperado = manifesto["tabelas"][t]["linhas"]
        if len(dados[t]) != esperado:
            sys.exit(f"ABORTADO: {t} tem {len(dados[t])} linhas, o manifesto diz {esperado}")

    fin = {r["id"]: r["nome"] for r in dados["finalidades"]}
    cid = {r["id"]: r["nome"] for r in dados["cidades"]}

    oss = [{
        "os": int(r["os"]), "cliente": r["cliente"], "aberto_por": r["aberto_por"],
        "finalidade": fin.get(r["finalidade_id"]), "cidade": cid.get(r["cidade_id"]),
        "bairro": limpo(r["bairro"]), "endereco": limpo(r["endereco"]),
        "lat": num(r["lat"]), "lng": num(r["lng"]), "geo_precisao": r["geo_precision"] or None,
        "entrou_fila": relogio_br(r["entrou_fila"]), "hrs_parada": num(r["hrs_parada"]),
        "tags": json.loads(r["tags"] or "[]"), "agendamento": r["agendamento"] or None,
        "agendado_para": data_br(r["agendado_para"]),
        "visitas": num(r["visitas"], int) or 0, "contatos": num(r["contatos"], int) or 0,
        "ativa": r["ativa"] == "True", "criado_em": r["criado_em"], "atualizado_em": r["atualizado_em"],
    } for r in dados["ordens_servico"]]

    conhecidas = {o["os"] for o in oss}
    orfas = {}
    movimentos = []
    deslocados = 0
    for r in dados["fluxo_os_dia"]:
        n = int(r["os"])
        if n not in conhecidas and n not in orfas:
            orfas[n] = {"os": n, "finalidade": r["finalidade"] or None, "cidade": r["cidade"] or None,
                        "ativa": False, "criado_em": r["criado_em"], "atualizado_em": r["criado_em"]}
        em = r["criado_em"]
        if em[:10] != r["dia"]:
            # 20:59:59 de Brasília = último instante do dia operacional `dia`.
            em = f"{r['dia']}T23:59:59+00:00"
            deslocados += 1
        movimentos.append({"os": n, "tipo": r["tipo"], "em": em,
                           "finalidade": r["finalidade"], "cidade": r["cidade"]})

    tentativas = [{
        "os": int(r["os"]), "data_evento": relogio_br(r["data_evento"]), "tecnico": r["tecnico"],
        "motivo": r["motivo"], "observacoes": r["observacoes"], "texto": r["texto"],
        "criado_em": r["criado_em"],
    } for r in dados["tentativas_sem_sucesso"] if r["data_evento"]]

    backlog_diario = [{
        **{k: r[k] for k in ("dia", "abertas", "agendadas_conf", "agendadas_nconf",
                             "nao_agendadas", "pendente", "atualizado_em")},
        **{k: json.loads(r[k] or "{}") for k in ("abertas_fin", "abertas_cid", "nag_fin", "nag_cid")},
    } for r in dados["backlog_diario"]]

    backlog_oficial = [{"mes": r["mes"], "grupo": r["finalidade_grupo"],
                        "entradas": int(r["entradas"]), "saidas": int(r["saidas"])}
                       for r in dados["backlog_oficial"]]

    ok_em = dados["coleta_meta"][0]["ultima_atualizacao"] if dados["coleta_meta"] else None

    total_dia = defaultdict(lambda: {"ent": 0, "sai": 0})
    for r in dados["fluxo_diario"]:
        if r["dimensao"] == "total":
            total_dia[r["dia"]][r["direcao"]] = int(r["quantidade"])

    plano = [("os", oss), ("os", list(orfas.values())), ("movimentos", movimentos),
             ("tentativas", tentativas), ("backlog_diario", backlog_diario),
             ("backlog_oficial", backlog_oficial)]
    info = {"orfas": len(orfas), "deslocados": deslocados, "ok_em": ok_em,
            "total_dia": total_dia, "manifesto": manifesto.get("exportado_em")}
    return plano, info


class PostgREST:
    def __init__(self):
        self.url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_SERVICE_KEY"]
        self.h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def importar(self, tabela, linhas):
        r = requests.post(f"{self.url}/rest/v1/rpc/esteira_importar_legado", headers=self.h,
                          json={"p_tabela": tabela, "p_linhas": linhas}, timeout=180)
        if r.status_code >= 400:
            raise RuntimeError(f"{tabela}: {r.text[:300]}")
        return r.json()

    def fluxo(self, de, ate):
        r = requests.post(f"{self.url}/rest/v1/rpc/esteira_fluxo", headers=self.h,
                          json={"p_de": de, "p_ate": ate}, timeout=120)
        r.raise_for_status()
        return r.json()

    def contar(self, tabela):
        r = requests.get(f"{self.url}/rest/v1/{tabela}", params={"select": "*", "limit": "1"},
                         headers={**self.h, "Prefer": "count=exact"}, timeout=60)
        r.raise_for_status()
        return int(r.headers["Content-Range"].split("/")[1])


class Direto:
    """Banco de ensaio (PGlite) — as mesmas funções, por psycopg."""
    def __init__(self, dsn):
        import psycopg
        from psycopg import ClientCursor
        self.c = psycopg.connect(dsn, autocommit=True, prepare_threshold=None,
                                 cursor_factory=ClientCursor)

    def importar(self, tabela, linhas):
        return self.c.execute("select esteira_importar_legado(%s, %s::jsonb)",
                              (tabela, json.dumps(linhas))).fetchone()[0]

    def fluxo(self, de, ate):
        return self.c.execute("select esteira_fluxo(%s, %s)", (de, ate)).fetchone()[0]

    def contar(self, tabela):
        return self.c.execute(f"select count(*) from {tabela}").fetchone()[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pasta", help="pasta dados_csv do backup")
    ap.add_argument("--conferir", action="store_true", help="só lê o backup e mostra o plano")
    ap.add_argument("--dsn", help="grava direto neste Postgres (banco de ensaio)")
    args = ap.parse_args()

    plano, info = montar(Path(args.pasta).expanduser())
    print(f"backup exportado em {info['manifesto']}; última coleta do Esteira-OS: {info['ok_em']}")
    for tabela, linhas in plano:
        print(f"  {tabela:16} {len(linhas):6} linhas")
    print(f"  ({info['orfas']} OS só nas listas entram inativas; "
          f"{info['deslocados']} movimentos levados para o último instante do dia deles)")
    if args.conferir:
        return 0

    banco = Direto(args.dsn) if args.dsn else PostgREST()
    for tabela, linhas in plano:
        gravadas = 0
        for i in range(0, len(linhas), LOTE):
            gravadas += banco.importar(tabela, linhas[i:i + LOTE])
        print(f"  -> {tabela:16} {gravadas:6} novas (de {len(linhas)})")
    if info["ok_em"]:
        banco.importar("coleta", [{"ok_em": info["ok_em"]}])

    # Conferência dia a dia: importado x lista do backup x total do fluxo_diario.
    listas = defaultdict(Counter)
    for t, linhas in plano:
        if t == "movimentos":
            for m in linhas:
                listas[datetime.fromisoformat(m["em"]).astimezone(timezone.utc).date().isoformat()][m["tipo"]] += 1
    dias = sorted(set(listas) | set(info["total_dia"]))
    fluxo = banco.fluxo(dias[0], dias[-1]) if dias else {}
    diverge = 0
    print("\n  dia         importado(ent/sai)  lista(ent/sai)  total antigo(ent/sai)")
    for d in dias:
        f = fluxo.get(d, {})
        imp = (f.get("ent", {}).get("t", 0), f.get("sai", {}).get("t", 0))
        lis = (listas[d]["ent"], listas[d]["sai"])
        tot = (info["total_dia"][d]["ent"], info["total_dia"][d]["sai"]) if d in info["total_dia"] else ("—", "—")
        marca = "" if imp == lis else "   <- DIVERGE"
        diverge += imp != lis
        if marca or lis == (0, 0):
            print(f"  {d}  {imp[0]:6}/{imp[1]:<6}       {lis[0]:5}/{lis[1]:<5}     {tot[0]}/{tot[1]}"
                  + (marca or "   (sem lista: fica sem registro)"))
    print(f"\n  {len(dias)} dias; {diverge} com importado diferente da lista")
    print(f"  esteira_os {banco.contar('esteira_os')}, movimentos {banco.contar('esteira_movimentos')}, "
          f"tentativas {banco.contar('esteira_tentativas')}")
    return 1 if diverge else 0


if __name__ == "__main__":
    sys.exit(main())
