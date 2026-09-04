#!/usr/bin/env python3
"""Envio de Ordens de Serviço ao WVSA — roda DENTRO da VPN.

Por que existe um processo separado para isto: o WVSA responde em um IP
privado (10.x). O portal roda na Vercel e não alcança essa rede. Então o clique
no botão grava a ordem no Supabase e este processo, que roda na mesma rede do
WVSA, faz o POST.

🚨 UM POST EM /relatorios/infra10/save CRIA OS DE VERDADE e desloca equipe.

Travas:

  1. Só envia ordem com `origem='clique_usuario'` e `enviado_por` preenchido.
     O próprio Postgres recusa gravar 'criada' sem isso (constraint
     os_envio_exige_clique_humano), então nenhum job consegue criar OS.
  2. `chave_idempotencia` é gravada ANTES do POST. Se o envio falhar no meio e
     for repetido, a mesma chave impede OS duplicada no WVSA.
  3. A ordem vira 'enviando' antes do POST. Se o processo morrer no meio, ela
     fica visível como travada em vez de ser reenviada e duplicar.
  4. A coluna `dry_run` da ordem faz a rodada parar em 'ensaio': monta e
     registra o payload sem tocar no WVSA. É como este caminho se prova sem
     deslocar equipe. Quem grava essa coluna é o portal, a partir do
     `OS_DRY_RUN` do ambiente DELE — aqui não se lê variável nenhuma.

Uso:
  python enviar_os.py            # processa a fila uma vez e sai
  python enviar_os.py --daemon   # fica observando (é o modo do watcher)
"""
import argparse
import json
import os
import re
import time
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

load_dotenv()

SCHEMA = "troca_poste"
# 5s, não 2s: como agente RESIDENTE isto roda o dia inteiro, e a 2s eram ~43 mil
# consultas por dia ao PostgREST para uma fila que enche algumas vezes por
# semana. O teto é a tela, que espera o desfecho por 90s — 5s de latência ainda
# são imperceptíveis no clique, com 18x de folga. O 2s vinha de quando o script
# rodava sob demanda e saía em seguida.
INTERVALO = float(os.environ.get("OS_POLL_SEGUNDOS", "5"))
TIMEOUT = 45


def log(msg, **ctx):
    print(json.dumps({"ts": datetime.now(timezone.utc).isoformat(),
                      "origem": "enviar_os", "msg": msg, **ctx}), flush=True)


# ---------------------------------------------------------------- Supabase
def _cfg():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY não configurados")
    return url, key


def _headers():
    _, key = _cfg()
    return {"apikey": key, "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept-Profile": SCHEMA, "Content-Profile": SCHEMA}


def buscar_fila():
    """Ordens aguardando envio: prontas e com clique humano registrado."""
    url, _ = _cfg()
    r = requests.get(f"{url}/rest/v1/ordens_servico", headers=_headers(), timeout=TIMEOUT,
                     params={"select": "*", "status": "eq.pronta",
                             "origem": "eq.clique_usuario", "order": "criado_em.asc",
                             "limit": "10"})
    r.raise_for_status()
    return r.json()


def atualizar(ordem_id, mudancas):
    url, _ = _cfg()
    r = requests.patch(f"{url}/rest/v1/ordens_servico", headers=_headers(),
                       params={"id": f"eq.{ordem_id}"}, json=mudancas, timeout=TIMEOUT)
    r.raise_for_status()


# -------------------------------------------------------------------- WVSA
class Wvsa:
    """Sessão autenticada. Uma instância cobre vários envios seguidos."""

    def __init__(self):
        self.base = os.environ.get("W8_BASE", "").rstrip("/")
        self.usuario = os.environ.get("W8_USER", "")
        self.senha = os.environ.get("W8_PASS", "")
        if not self.base or not self.usuario:
            raise RuntimeError("W8_BASE / W8_USER não configurados no .env do coletor")
        self.s = requests.Session()
        self.csrf = None

    @staticmethod
    def _token(html):
        for padrao in (r'<meta\s+name="csrf-token"\s+content="([^"]+)"',
                       r'<input[^>]+name="_token"[^>]+value="([^"]+)"',
                       r'<input[^>]+value="([^"]+)"[^>]+name="_token"'):
            m = re.search(padrao, html, re.I)
            if m:
                return m.group(1)
        return None

    def login(self):
        r = self.s.get(f"{self.base}/login", timeout=TIMEOUT)
        r.raise_for_status()
        token = self._token(r.text)
        if not token:
            raise RuntimeError("não achei o _token na página de login do WVSA")
        r = self.s.post(f"{self.base}/login", timeout=TIMEOUT,
                        data={"_token": token, "username": self.usuario,
                              "password": self.senha},
                        headers={"Content-Type": "application/x-www-form-urlencoded"})
        r.raise_for_status()
        # O WVSA devolve 200 com o formulário de novo quando a credencial está
        # errada — checar só o status não basta.
        if "/login" in r.url and self._token(r.text):
            raise RuntimeError("login no WVSA recusado (usuário ou senha)")
        self.csrf = token
        return self

    def renovar_csrf(self):
        r = self.s.get(f"{self.base}/relatorios/infra10", timeout=TIMEOUT)
        r.raise_for_status()
        token = self._token(r.text)
        if token:
            self.csrf = token
        return self.csrf

    def enviar(self, payload):
        """POST no /save. Devolve (status_http, texto, numero_os)."""
        if not self.csrf:
            self.renovar_csrf()
        corpo = dict(payload)
        corpo["_token"] = self.csrf
        r = self.s.post(f"{self.base}/relatorios/infra10/save", timeout=TIMEOUT,
                        json=corpo,
                        headers={"Accept": "application/json",
                                 "X-Requested-With": "XMLHttpRequest",
                                 "X-CSRF-TOKEN": self.csrf or ""})
        m = re.search(r"\b(?:OS|os)[^\d]{0,4}(\d{3,})", r.text)
        return r.status_code, r.text, (m.group(1) if m else None)


def alcancavel():
    """O WVSA responde daqui?

    Serve para separar "a máquina não está na rede" de "o WVSA recusou". Sem
    isso, rodar fora da VPN marcava a ordem como `erro` — o operador via
    "falhou" para uma OS que ninguém chegou a tentar enviar, e reenviar exigia
    um clique novo. Inalcançável, a ordem fica em `pronta`: é exatamente o que a
    mensagem "Aguardando o coletor" da tela já pressupõe.
    """
    base = os.environ.get("W8_BASE", "").rstrip("/")
    if not base:
        return False
    try:
        requests.get(base, timeout=5, allow_redirects=True)
        return True
    except requests.RequestException as e:
        log("wvsa_inalcancavel", erro=str(e))
        return False


# ----------------------------------------------------------------- payload
def montar_payload(o):
    """Monta os campos do formulário a partir da ordem gravada.

    Nomes e valores vêm de docs/contratos/wvsa.md §3.1 — inclusive os dois
    contraintuitivos: `categoria_interna` é "esta OS pode ser feita com
    chuva?" e `agendar_os` é "pré agendar OS?". Nenhum dos dois é o campo de
    agendamento, que é `agendamento`.
    """
    def br(iso):
        return "/".join(reversed(iso.split("-"))) if iso else ""

    return {
        "FINALIDADE": o.get("finalidade") or "POST",
        "CID_CODIGO": o.get("cid_codigo") or "",
        "bairro": o.get("bairro_id") or "",
        "CONTRATO": "",
        "MASSIVA": "",
        "MASSIVA_LOCALIZACAO": o.get("massiva_localizacao") or "",
        "demanda_id": "",
        "pop_id": "",
        "acao_id": "",
        "tipo_tecnico": o.get("tipo_tecnico") or "",
        "os": "",
        "tecnico_id[]": o.get("tecnico_ids") or [],
        "agendamento": o.get("agendamento") or "",
        "categoria_interna": o.get("categoria_interna") or "N",
        "agendar_os": o.get("agendar_os") or "N",
        "DATA": br(o.get("data_inicio")),
        "DATAFIM": br(o.get("data_fim")),
        "periodo": o.get("periodo") or "",
        "executor": o.get("executor") or "",
        "SOLICITACAO": o.get("solicitacao") or "",
    }


# -------------------------------------------------------------------- fluxo
def processar(ordem, wvsa):
    oid = ordem["id"]
    chave = ordem.get("chave_idempotencia")

    # Trava 1. O banco também recusa, mas falhar aqui dá mensagem melhor do que
    # uma violação de constraint.
    if ordem.get("origem") != "clique_usuario" or not ordem.get("enviado_por"):
        atualizar(oid, {"status": "erro",
                        "erro": "sem clique humano identificado — envio recusado"})
        log("recusada_sem_clique", ordem=oid)
        return

    payload = montar_payload(ordem)

    # Trava 4: o ENSAIO. Percorre tudo — fila, clique conferido, payload
    # montado — e para aqui. Antes esta coluna era lida por ninguém: o
    # `dry_run` existia no banco e o POST saía do mesmo jeito, o que tornava
    # impossível conferir o payload sem criar OS de verdade num sistema de
    # produção. `ensaio` é estado terminal: a tela mostra o que seria enviado, e
    # o operador clica de novo depois de `OS_DRY_RUN=false`.
    if ordem.get("dry_run"):
        atualizar(oid, {"status": "ensaio", "payload_enviado": payload,
                        "erro": None,
                        "resposta_bruta": {"ensaio": True,
                                           "nota": "dry_run ligado — nada foi enviado ao WVSA"}})
        log("ensaio", ordem=oid, chave=chave)
        return

    atualizar(oid, {"status": "enviando", "payload_enviado": payload,
                    "tentativas": (ordem.get("tentativas") or 0) + 1})

    try:
        status, texto, numero = wvsa.enviar(payload)
    except Exception as e:
        atualizar(oid, {"status": "erro", "erro": f"falha na requisição: {e}"})
        log("erro_requisicao", ordem=oid, chave=chave, erro=str(e))
        return

    if status >= 400:
        atualizar(oid, {"status": "erro", "erro": f"WVSA respondeu HTTP {status}",
                        "resposta_bruta": {"http": status, "corpo": texto[:4000]}})
        log("erro_http", ordem=oid, chave=chave, http=status)
        return

    atualizar(oid, {"status": "criada", "wvsa_os_numero": numero, "erro": None,
                    "enviado_em": datetime.now(timezone.utc).isoformat(),
                    "resposta_bruta": {"http": status, "corpo": texto[:4000]}})
    log("os_criada", ordem=oid, chave=chave, numero=numero, http=status)


def rodada(wvsa_cache=None):
    fila = buscar_fila()
    if not fila:
        return 0, wvsa_cache
    log("fila", quantidade=len(fila))

    # Ensaio não precisa de sessão nem de rota até o WVSA: ele para antes da
    # requisição. Separar os dois grupos permite conferir payload de qualquer
    # lugar, inclusive fora da VPN.
    feitas = 0
    reais = []
    for ordem in fila:
        if ordem.get("dry_run"):
            processar(ordem, None)
            feitas += 1
        else:
            reais.append(ordem)
    if not reais:
        return feitas, wvsa_cache

    wvsa = wvsa_cache
    if wvsa is None:
        if not alcancavel():
            # Deixa as ordens em `pronta`. A próxima rodada tenta de novo, e a
            # tela continua dizendo "aguardando o coletor" — que é a verdade.
            log("aguardando_rota", ordens=len(reais))
            return feitas, None
        wvsa = Wvsa().login()

    for ordem in reais:
        processar(ordem, wvsa)
        feitas += 1
    return feitas, wvsa


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--daemon", action="store_true",
                    help=f"fica observando a fila a cada {INTERVALO}s")
    args = ap.parse_args()

    if not args.daemon:
        n, _ = rodada()
        log("fim", processadas=n)
        return

    log("observando", intervalo_s=INTERVALO)
    wvsa = None
    while True:
        try:
            n, wvsa = rodada(wvsa)
            if n == 0:
                # Sem fila: descarta a sessão para não guardar cookie velho por
                # horas. O login custa uma requisição e só acontece quando há OS.
                wvsa = None
        except Exception as e:
            log("erro_ciclo", erro=str(e))
            wvsa = None
        time.sleep(INTERVALO)


if __name__ == "__main__":
    main()
