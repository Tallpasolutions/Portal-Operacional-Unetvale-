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
import struct
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


def _agora():
    return datetime.now(timezone.utc).isoformat()


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

    def resolver_bairro(self, ordem):
        """Id do bairro no WVSA, pelo autocomplete.

        ⚠️ O autocomplete RATE-LIMITA e falha em silêncio: devolve HTTP 200 com
        lista vazia. Medido pelo monorepo em 07/08/2026 — a 150 ms de intervalo,
        6 de 11 consultas voltaram vazias; a 900 ms, todas responderam. Por isso
        lista vazia é tratada como "tente de novo", NUNCA como "não existe":
        aceitar o vazio mandaria a OS com bairro em branco justamente quando o
        WVSA está ocupado.
        """
        nome = (ordem.get("bairro_nome") or "").strip()
        if not nome:
            return ""
        # Espera CRESCENTE e quatro tentativas: medido em 09/09/2026 contra as 11
        # cidades, duas só responderam na terceira, com as esperas subindo
        # (0,95s / 1,9s / 2,85s). Com intervalo fixo de 0,9s elas teriam voltado
        # vazias — e vazio aqui vira OS sem bairro.
        for tentativa in range(4):
            if tentativa:
                time.sleep(0.95 * tentativa)
            # `query`, não `term` — e os dois cabeçalhos são obrigatórios: sem
            # eles o WVSA devolve HTML da tela em vez do JSON, e a resposta
            # parece "bairro não encontrado" quando é a requisição que está
            # errada. Foi exatamente o que aconteceu na primeira tentativa.
            r = self.s.get(f"{self.base}/autocomplete/bairro", timeout=TIMEOUT,
                           params={"query": nome},
                           headers={"X-Requested-With": "XMLHttpRequest",
                                    "Accept": "application/json"})
            try:
                sug = (r.json() or {}).get("suggestions") or []
            except ValueError:
                sug = []
            for item in sug:
                if isinstance(item, dict) and item.get("data"):
                    return str(item["data"])
        return ""

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

    def contar_anexos(self, numero):
        """Quantas imagens a OS tem em "Visualizar as Fotos/Anexos".

        É a prova de que o anexo entrou: o WVSA responde 200 com página de
        erro em vários endpoints (§6), e status sozinho não diz nada. As
        imagens moram no S3 do WVSA (`unetvale-wvsa.s3...`), medido em
        13/10/2026 com um anexo feito à mão na OS #594466.
        """
        r = self.s.get(f"{self.base}/helpers/fotos/os/{numero}", timeout=TIMEOUT)
        r.raise_for_status()
        return len(re.findall(r'<img[^>]+src="https://[^"]*amazonaws\.com/', r.text))

    def anexar(self, numero, nome, conteudo, tipo="image/png"):
        """POST do arquivo na OS. Devolve (status_http, texto).

        Contrato lido do formulário do WVSA em 13/10/2026 ("Incluir
        Fotos/Anexos" da OS #594466): um Dropzone com `action=
        /operacional/oshelpers/anexos/{os}`, POST multipart, campo `file`,
        um arquivo por requisição, sem outros parâmetros. A rota segue o
        padrão `/operacional/oshelpers/{ação}/{os}` — a sondagem de 10/09
        procurava em `/os/{ação}` e não achou.

        O `_token` e o `X-CSRF-TOKEN` vão por garantia: o Dropzone da página
        não manda nenhum dos dois, mas sobra não recusa.
        """
        if not self.csrf:
            self.renovar_csrf()
        r = self.s.post(f"{self.base}/operacional/oshelpers/anexos/{numero}", timeout=TIMEOUT,
                        files={"file": (nome, conteudo, tipo)},
                        data={"_token": self.csrf or ""},
                        headers={"Accept": "application/json",
                                 "X-Requested-With": "XMLHttpRequest",
                                 "X-CSRF-TOKEN": self.csrf or ""})
        return r.status_code, r.text


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


# --------------------------------------------------------------- catálogos
# As opções dos campos da OS (executor, tipo de técnico, período e os TÉCNICOS)
# moram dentro do formulário do WVSA, num IP privado. A Vercel não alcança —
# então quem as copia para o Postgres é este processo, que já está na rede e já
# tem sessão. A tabela `troca_poste.wvsa_catalogos` existe desde a migration 09
# e nunca foi preenchida por ninguém.
#
# `agendamento` fica FORA de propósito: medido em 04/09/2026, o select tinha 23
# slots cobrindo só 3 dias e mudando ao longo do dia. Sincronizar uma lista com
# validade de horas produz tela que mente.
CATALOGO_HORAS = float(os.environ.get("OS_CATALOGO_HORAS", "12"))

# O `agendamento` tem cadência PRÓPRIA, e muito mais curta, porque não é um
# catálogo: é a agenda. Medido em 09/09/2026, o select trazia 28 slots do tipo
# `149163-M1` -> "09/09/2026 - M1 - Juvenal da Silva", cobrindo poucos dias e
# mudando ao longo do dia conforme a operação agenda. Copiado de 12 em 12 h ele
# mostraria no portal um técnico que já foi ocupado.
AGENDAMENTO_MINUTOS = float(os.environ.get("OS_AGENDAMENTO_MINUTOS", "15"))

# `tecnico_id[]` é multi-select ESTÁTICO no HTML (34 opções em 04/09/2026), não
# depende do tipo_tecnico e não vem por AJAX. O `catalogos()` do monorepo não o
# incluía — era omissão, não impedimento.
_CAMPOS_CATALOGO = {
    "executor": "executor",
    "tipo_tecnico": "tipo_tecnico",
    "periodo": "periodo",
    "tecnico_id[]": "tecnico",
    "finalidade": "finalidade",
}

# Só este, na cadência curta.
_CAMPO_AGENDAMENTO = {"agendamento": "agendamento"}


def _metadados_agendamento(rotulo):
    """"09/09/2026 - M1 - Juvenal da Silva" -> {data, turno, tecnico}.

    A tela precisa da DATA para só oferecer os slots do dia do desligamento —
    mostrar o slot de outro dia seria pior que não mostrar nenhum.

    ⚠️ Divide em no MÁXIMO três pedaços: o nome do técnico contém " - " quando
    ele tem empresa no cadastro ("INFRA SCHISTEL - Jefferson Julio da Silva"),
    e um split cego cortaria o nome ao meio.
    """
    partes = rotulo.split(" - ", 2)
    if len(partes) < 3:
        return None
    data, turno, tecnico = (p.strip() for p in partes)
    try:
        d, m, a = data.split("/")
        iso = f"{a}-{m.zfill(2)}-{d.zfill(2)}"
    except ValueError:
        return None
    return {"data": iso, "turno": turno, "tecnico": tecnico}


def _opcoes(html, nome):
    """Extrai (valor, rótulo) de um <select name="..."> do formulário."""
    m = re.search(r'<select([^>]*name="%s"[^>]*)>(.*?)</select>' % re.escape(nome),
                  html, re.S | re.I)
    if not m:
        return []
    achadas = re.findall(r'<option[^>]*value="([^"]*)"[^>]*>(.*?)</option>',
                         m.group(2), re.S)
    saida = []
    for valor, rotulo in achadas:
        if not valor.strip():
            continue  # "Selecione uma opção..."
        saida.append((valor.strip(),
                      re.sub(r"\s+", " ", re.sub("<[^>]+>", "", rotulo)).strip()))
    return saida


def sincronizar_catalogos(wvsa, campos=None):
    """Copia as opções do formulário para `troca_poste.wvsa_catalogos`.

    `campos` restringe o que é copiado — é como o `agendamento` roda de 15 em
    15 min sem arrastar junto os 33 técnicos e as 11 finalidades, que mudam
    quando alguém entra ou sai da equipe.
    """
    url, _ = _cfg()
    campos = campos or _CAMPOS_CATALOGO
    r = wvsa.s.get(f"{wvsa.base}/relatorios/infra10", timeout=TIMEOUT)
    r.raise_for_status()
    html = r.text

    linhas, por_tipo = [], {}
    for campo, tipo in campos.items():
        opcoes = _opcoes(html, campo)
        por_tipo[tipo] = len(opcoes)
        for valor, rotulo in opcoes:
            # `metadados` em TODA linha, nula fora da agenda: o PostgREST
            # recusa lote com chaves diferentes (400 `PGRST102`). Enquanto
            # agenda e catálogo iam em POSTs separados isso não aparecia; a
            # leitura combinada do pedido sob demanda (13/10/2026) quebrou na
            # primeira volta.
            linhas.append({"tipo": tipo, "valor": valor, "rotulo": rotulo,
                           "ativo": True, "sincronizado_em": _agora(),
                           "metadados": (_metadados_agendamento(rotulo)
                                         if tipo == "agendamento" else None)})

    # A trava do catálogo vazio vale para o conjunto ESTÁVEL: lista vazia ali é
    # quase sempre sessão expirada devolvendo a tela de login. Já a agenda pode
    # estar legitimamente vazia (ninguém agendou nada), e recusar isso deixaria
    # slots cancelados vivos no portal para sempre.
    if campos is _CAMPO_AGENDAMENTO:
        if not linhas:
            log("agenda_vazia", nota="nenhum slot no WVSA — inativando os antigos")
    elif not linhas or not por_tipo.get("tecnico"):
        # Lista vazia é quase sempre sessão expirada devolvendo a tela de login,
        # não "a empresa ficou sem técnico". Gravar isso apagaria o catálogo bom
        # e deixaria a tela sem opção nenhuma — o erro do `ger_idf` zerado.
        log("catalogo_vazio_recusado", campos=por_tipo)
        # None, não 0: quem pediu pela tela precisa saber que NÃO copiou —
        # `copiar_agenda` grava isso como erro em vez de "atualizado".
        return None

    if linhas:
        resp = requests.post(f"{url}/rest/v1/wvsa_catalogos", headers={
            **_headers(), "Prefer": "resolution=merge-duplicates"},
            params={"on_conflict": "tipo,valor"}, json=linhas, timeout=TIMEOUT)
        resp.raise_for_status()

    # Quem sumiu do formulário vira inativo, não some do banco: OS antiga
    # aponta para o técnico que saiu, e apagar a linha deixaria a auditoria
    # com um id sem nome.
    vivos = {(l["tipo"], l["valor"]) for l in linhas}
    atuais = requests.get(f"{url}/rest/v1/wvsa_catalogos", headers=_headers(),
                          params={"select": "tipo,valor", "ativo": "is.true",
                                  "tipo": f"in.({','.join(campos.values())})"},
                          timeout=TIMEOUT)
    atuais.raise_for_status()
    sumidos = [a for a in atuais.json() if (a["tipo"], a["valor"]) not in vivos]
    for a in sumidos:
        requests.patch(f"{url}/rest/v1/wvsa_catalogos", headers=_headers(),
                       params={"tipo": f"eq.{a['tipo']}", "valor": f"eq.{a['valor']}"},
                       json={"ativo": False}, timeout=TIMEOUT)

    log("catalogo_sincronizado", campos=por_tipo, inativados=len(sumidos))
    return por_tipo


def sincronizar_agendamento(wvsa):
    """Só a agenda. Roda de `AGENDAMENTO_MINUTOS` em `AGENDAMENTO_MINUTOS`."""
    return sincronizar_catalogos(wvsa, _CAMPO_AGENDAMENTO)


# ------------------------------------------------- agenda sob demanda (0019)
# O botão "Atualizar do WVSA" do modal da OS deixa um pedido em
# `troca_poste.agenda_sincronizacao` (uma linha só), e este laço — que já
# confere a fila de OS a cada 5 s — atende. O caso: o operador libera a agenda
# de um técnico no WVSA e volta ao portal; sem o pedido, o horário só
# apareceria na próxima cópia de 15 min.
#
# Toda cópia grava o desfecho na mesma linha, sob demanda ou não: é dela que a
# tela tira "agenda copiada às 14:32" e o erro, quando houve.

# Pedido atendido copia TUDO numa leitura só do formulário: a equipe também
# muda quando a operação mexe na agenda, e a página é a mesma.
_CAMPOS_TUDO = {**_CAMPOS_CATALOGO, **_CAMPO_AGENDAMENTO}

# Sem a migration 0019 a tabela não existe (404, `PGRST205`). O laço segue
# enviando OS como antes; só o pedido sob demanda fica desligado até o
# próximo reinício do agente.
_sem_tabela_agenda = False


def estado_agenda():
    """A linha de `agenda_sincronizacao`, ou None se não deu para ler."""
    global _sem_tabela_agenda
    if _sem_tabela_agenda:
        return None
    url, _ = _cfg()
    try:
        r = requests.get(f"{url}/rest/v1/agenda_sincronizacao", headers=_headers(),
                         params={"select": "pedido_em,atendido_pedido_em", "id": "eq.1"},
                         timeout=TIMEOUT)
        if r.status_code == 404 and "PGRST205" in r.text:
            _sem_tabela_agenda = True
            log("agenda_sob_demanda_desligada",
                nota="tabela troca_poste.agenda_sincronizacao ausente (migration 0019)")
            return None
        r.raise_for_status()
        linhas = r.json()
        return linhas[0] if linhas else None
    except requests.RequestException as e:
        log("agenda_estado_erro", erro=str(e)[:160])
        return None


def pedido_pendente(estado):
    """O `pedido_em` ainda não atendido, ou None.

    Compara os dois carimbos que o PORTAL escreveu (o `atendido_pedido_em` é
    cópia do `pedido_em`), nunca o relógio deste Mac com o da Vercel.
    """
    if not estado or not estado.get("pedido_em"):
        return None
    pedido = datetime.fromisoformat(estado["pedido_em"])
    atendido = estado.get("atendido_pedido_em")
    if atendido and datetime.fromisoformat(atendido) >= pedido:
        return None
    return estado["pedido_em"]


def _gravar_agenda(mudancas):
    if _sem_tabela_agenda:
        return
    url, _ = _cfg()
    try:
        requests.patch(f"{url}/rest/v1/agenda_sincronizacao", headers=_headers(),
                       params={"id": "eq.1"}, json=mudancas,
                       timeout=TIMEOUT).raise_for_status()
    except requests.RequestException as e:
        log("agenda_estado_erro", erro=str(e)[:160])


def copiar_agenda(completo, estado):
    """Uma cópia do formulário, com o desfecho gravado para a tela.

    `estado` é a linha lida NESTE ciclo, antes de começar: a cópia atende o
    pedido que existia até aqui. Um clique que chegue durante a cópia fica com
    `pedido_em` maior e é atendido no ciclo seguinte — a página que ela leu
    pode ser de antes da liberação que ele quer ver.
    """
    inicio = _agora()
    feito = {"sincronizado_em": inicio}
    if estado and estado.get("pedido_em"):
        feito["atendido_pedido_em"] = estado["pedido_em"]
    try:
        # Sonda antes de logar: fora da VPN o login só desiste em 45 s, e a
        # tela está esperando com o modal aberto.
        if not alcancavel():
            raise RuntimeError("o coletor está fora da rede do WVSA (VPN)")
        por_tipo = sincronizar_catalogos(Wvsa().login(),
                                         _CAMPOS_TUDO if completo else _CAMPO_AGENDAMENTO)
        if por_tipo is None:
            raise RuntimeError("o WVSA devolveu o formulário sem técnicos — sessão expirada?")
    except Exception as e:
        log("catalogo_erro", erro=str(e)[:160])
        _gravar_agenda({**feito, "ok": False, "erro": str(e)[:300]})
        return False
    _gravar_agenda({**feito, "ok": True, "erro": None,
                    "ultimo_ok_em": inicio, "contagem": por_tipo})
    return True


# ------------------------------------------------------- mapa anexado à OS
def _ponto(ewkb_hex):
    """(lat, lon) de um POINT em EWKB hex — como o PostgREST devolve geography.

    Cópia do `app/troca_poste._ponto`: o coletor não importa o app (é outro
    deploy, outra máquina). É decodificação de formato, não regra de negócio —
    não há o que divergir entre as duas.
    """
    if not ewkb_hex:
        return None
    try:
        b = bytes.fromhex(ewkb_hex)
        ordem = "<" if b[0] == 1 else ">"
        tipo, = struct.unpack_from(ordem + "I", b, 1)
        if (tipo & 0xFF) != 1:
            return None
        x, y = struct.unpack_from(ordem + "dd", b, 5 + (4 if tipo & 0x20000000 else 0))
        return round(y, 6), round(x, 6)
    except Exception:
        return None


def trechos_da_ordem(ordem):
    """Os trechos do grupo da ordem, na ordem em que o script da OS os lista.

    A ordem do texto vem do portal (o agrupamento da tela), que o coletor não
    refaz: a numeração do mapa segue a POSIÇÃO de cada rua no texto
    `SOLICITACAO` já gravado. Assim o "1" do mapa é a primeira rua que o
    técnico lê na OS.
    """
    url, _ = _cfg()
    r = requests.get(f"{url}/rest/v1/agrupamento_itens", headers=_headers(), timeout=TIMEOUT,
                     params={"select": "desligamento_id",
                             "agrupamento_id": f"eq.{ordem['agrupamento_id']}"})
    r.raise_for_status()
    ids = [i["desligamento_id"] for i in r.json()]
    if not ids:
        return []
    r = requests.get(f"{url}/rest/v1/desligamentos", headers=_headers(), timeout=TIMEOUT,
                     params={"select": "id,tipo_via_extenso,logradouro,numero_inicio,numero_fim,"
                                       "endereco_raw,desligamento_geo(geom,validacao)",
                             "id": f"in.({','.join(ids)})"})
    r.raise_for_status()
    trechos = []
    for d in r.json():
        geo = d.get("desligamento_geo") or {}
        ponto = _ponto(geo.get("geom"))
        trechos.append({"lat": ponto[0] if ponto else None, "lon": ponto[1] if ponto else None,
                        "tipo_via": d.get("tipo_via_extenso"), "logradouro": d.get("logradouro"),
                        "numero_inicio": d.get("numero_inicio"), "numero_fim": d.get("numero_fim"),
                        "endereco": d.get("endereco_raw"), "validacao": geo.get("validacao")})
    texto = (ordem.get("payload_enviado") or {}).get("SOLICITACAO") or ordem.get("solicitacao") or ""
    texto = texto.upper()

    def posicao(t):
        from mapa_os import sem_acento
        chave = sem_acento(t.get("logradouro") or t.get("endereco") or "").upper().strip()
        p = texto.find(chave) if chave else -1
        return (p if p >= 0 else len(texto) + 1, chave, t.get("numero_inicio") or 0)
    return sorted(trechos, key=posicao)


def _cabecalho(ordem, numero):
    p = ordem.get("payload_enviado") or {}
    texto = p.get("SOLICITACAO") or ""
    m = re.search(r"DATA/HORA DO DESLIGAMENTO:\s*(.+)", texto)
    local = re.search(r"LOCAL:\s*(.+)", texto)
    bairro = re.search(r"BAIRRO:\s*(.+)", texto)
    return {"os": numero,
            "cidade": local.group(1).strip() if local else "",
            "bairro": (bairro.group(1).strip() if bairro else ordem.get("bairro_nome")) or "",
            "janela": m.group(1).strip() if m else ""}


def anexar_mapa(ordem, numero, wvsa):
    """Gera o mapa do grupo e anexa à OS. Devolve o registro do desfecho.

    NUNCA levanta e nunca mexe no status da ordem: a OS já existe no WVSA, e
    falhar o mapa não desfaz isso. O desfecho vai para `resposta_bruta.mapa`
    (sem migration — é o registro do que o WVSA respondeu, e o anexo é mais
    uma resposta dele).
    """
    feito = {"em": _agora()}
    try:
        import mapa_os
        trechos = trechos_da_ordem(ordem)
        png = mapa_os.gerar_png(_cabecalho(ordem, numero), trechos)
        antes = wvsa.contar_anexos(numero)
        status, texto = wvsa.anexar(numero, f"mapa-troca-poste-os-{numero}.png", png)
        depois = wvsa.contar_anexos(numero)
        feito.update({"http": status, "resposta": (texto or "")[:300], "bytes": len(png),
                      "trechos": len(trechos), "anexos_antes": antes, "anexos_depois": depois})
        # 200 não basta (o WVSA responde 200 com página de erro): o anexo tem
        # de APARECER na lista de fotos da OS.
        feito["ok"] = status < 400 and depois > antes
        if not feito["ok"]:
            feito["erro"] = (f"WVSA respondeu HTTP {status}" if status >= 400
                             else "o WVSA respondeu, mas o anexo não apareceu na OS")
    except Exception as e:
        feito.update({"ok": False, "erro": str(e)[:300]})
    log("mapa_anexado" if feito["ok"] else "mapa_falhou", ordem=ordem.get("id"), numero=numero,
        **{k: v for k, v in feito.items() if k not in ("resposta", "em")})
    return feito


# ----------------------------------------------------------------- payload
def montar_payload(o):
    """Monta os campos do formulário a partir da ordem gravada.

    Nomes e valores vêm de docs/contratos/wvsa.md §3.1 — inclusive os dois
    contraintuitivos: `categoria_interna` é "esta OS pode ser feita com
    chuva?" e `agendar_os` é "pré agendar OS?". Nenhum dos dois é o campo de
    agendamento, que é `agendamento`.
    """
    # ⚠️ ISO, não DD/MM/AAAA. `DATA` e `DATAFIM` são `<input type="date">` no
    # formulário (conferido no HTML em 09/09/2026, com o servidor renderizando
    # `value="2026-09-09"`), e campo assim só submete ISO — o navegador não tem
    # como mandar outra coisa, e não há JS na página reformatando antes do
    # envio. Mandávamos BR, o que faria a OS nascer com data errada em vez de
    # dar erro. A versão TypeScript do monorepo sempre mandou ISO.
    def iso(d):
        return d or ""

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
        "DATA": iso(o.get("data_inicio")),
        "DATAFIM": iso(o.get("data_fim")),
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

    # `bairro_wvsa_id` é NULL em todos os desligamentos: nada no pipeline
    # preenche essa coluna. Resolver aqui, por autocomplete, é o único ponto do
    # sistema que alcança o WVSA — e sem isso o campo Bairro da OS vai vazio.
    # Falha não impede a OS: o campo é opcional (contrato §3.1) e uma OS sem
    # bairro é melhor que nenhuma OS.
    if not payload.get("bairro") and wvsa is not None:
        try:
            payload["bairro"] = wvsa.resolver_bairro(ordem) or ""
        except Exception as e:
            log("bairro_nao_resolvido", ordem=oid, erro=str(e)[:120])

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

    resposta = {"http": status, "corpo": texto[:4000]}
    atualizar(oid, {"status": "criada", "wvsa_os_numero": numero, "erro": None,
                    "enviado_em": datetime.now(timezone.utc).isoformat(),
                    "resposta_bruta": resposta})
    log("os_criada", ordem=oid, chave=chave, numero=numero, http=status)

    # O mapa vem DEPOIS de gravar `criada`: se o processo morrer aqui, a OS
    # está registrada e só o anexo falta — o contrário deixaria uma OS real
    # em `enviando`, que a tela trata como travada.
    if numero and MAPA_LIGADO:
        resposta["mapa"] = anexar_mapa({**ordem, "payload_enviado": payload}, numero, wvsa)
        atualizar(oid, {"resposta_bruta": resposta})


# Desligável sem deploy: se o anexo começar a dar problema no WVSA, a OS
# continua saindo sem ele.
MAPA_LIGADO = os.environ.get("OS_MAPA_ANEXO", "true").strip().lower() != "false"


def anexar_mapa_avulso(numero):
    """`--mapa NUMERO`: anexa (de novo) o mapa a uma OS já criada pelo portal."""
    url, _ = _cfg()
    r = requests.get(f"{url}/rest/v1/ordens_servico", headers=_headers(), timeout=TIMEOUT,
                     params={"select": "*", "wvsa_os_numero": f"eq.{numero}"})
    r.raise_for_status()
    ordens = r.json()
    if not ordens:
        raise SystemExit(f"nenhuma ordem do portal com a OS {numero}")
    ordem = ordens[0]
    feito = anexar_mapa(ordem, numero, Wvsa().login())
    resposta = ordem.get("resposta_bruta") or {}
    resposta["mapa"] = feito
    atualizar(ordem["id"], {"resposta_bruta": resposta})
    return feito


def rodada(wvsa_cache=None):
    fila = buscar_fila()
    if not fila:
        return 0, wvsa_cache
    log("fila", quantidade=len(fila))

    ensaios = [o for o in fila if o.get("dry_run")]
    reais = [o for o in fila if not o.get("dry_run")]
    feitas = 0

    # O ensaio NÃO precisa do WVSA — ele para antes da requisição, e é isso que
    # o deixa rodar fora da VPN. Mas se a rota existe, vale abrir sessão mesmo
    # para ele: o `bairro` é resolvido por autocomplete, e sem sessão o ensaio
    # nunca exercitaria justamente o campo que ninguém sabe se o WVSA exige.
    # Sem rota, o ensaio acontece igual, com o bairro em branco.
    wvsa = wvsa_cache
    if wvsa is None and alcancavel():
        try:
            wvsa = Wvsa().login()
        except Exception as e:
            log("login_falhou", erro=str(e)[:160])
            wvsa = None

    for ordem in ensaios:
        processar(ordem, wvsa)
        feitas += 1

    if not reais:
        return feitas, wvsa

    if wvsa is None:
        # Deixa as ordens em `pronta`. A próxima rodada tenta de novo, e a tela
        # continua dizendo "aguardando o coletor" — que é a verdade.
        log("aguardando_rota", ordens=len(reais))
        return feitas, None

    for ordem in reais:
        processar(ordem, wvsa)
        feitas += 1
    return feitas, wvsa


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--daemon", action="store_true",
                    help=f"fica observando a fila a cada {INTERVALO}s")
    ap.add_argument("--catalogos", action="store_true",
                    help="sincroniza as opções do formulário e sai")
    ap.add_argument("--agenda", action="store_true",
                    help="sincroniza só os slots de agendamento e sai")
    ap.add_argument("--mapa", metavar="NUMERO_OS",
                    help="anexa o mapa do local a uma OS já criada pelo portal e sai")
    ap.add_argument("--mapa-png", metavar="NUMERO_OS",
                    help="só GERA o PNG do mapa da OS (em ./mapa-os-N.png), sem tocar no WVSA")
    args = ap.parse_args()

    if args.mapa_png:
        url, _ = _cfg()
        r = requests.get(f"{url}/rest/v1/ordens_servico", headers=_headers(), timeout=TIMEOUT,
                         params={"select": "*", "wvsa_os_numero": f"eq.{args.mapa_png}"})
        r.raise_for_status()
        if not r.json():
            raise SystemExit(f"nenhuma ordem do portal com a OS {args.mapa_png}")
        import mapa_os
        ordem = r.json()[0]
        png = mapa_os.gerar_png(_cabecalho(ordem, args.mapa_png), trechos_da_ordem(ordem))
        destino = f"mapa-os-{args.mapa_png}.png"
        with open(destino, "wb") as f:
            f.write(png)
        log("mapa_gerado", arquivo=destino, bytes=len(png))
        return

    if args.mapa:
        log("fim", mapa=anexar_mapa_avulso(args.mapa))
        return

    if args.catalogos or args.agenda:
        sessao = Wvsa().login()
        n = (sincronizar_agendamento(sessao) if args.agenda
             else sincronizar_catalogos(sessao))
        log("fim", opcoes=n)  # {tipo: quantidade}, ou None se recusou
        return

    if not args.daemon:
        n, _ = rodada()
        log("fim", processadas=n)
        return

    log("observando", intervalo_s=INTERVALO, catalogo_h=CATALOGO_HORAS,
        agenda_min=AGENDAMENTO_MINUTOS)
    wvsa = None
    proximo_catalogo = 0.0
    proxima_agenda = 0.0
    while True:
        try:
            # O catálogo entra AQUI, e não num quarto LaunchAgent: este processo
            # já é residente, já está na rede do WVSA e já sabe logar. Um agente
            # só para copiar sete listas seria mais coisa para quebrar.
            agora = time.time()
            vence_catalogo = agora >= proximo_catalogo
            vence_agenda = agora >= proxima_agenda
            # Uma leitura a mais por ciclo (~17 mil por dia) é o preço de o
            # botão responder em segundos. Ler de minuto em minuto deixaria o
            # operador olhando o modal parado pelo mesmo tempo.
            estado = estado_agenda()
            pedido = pedido_pendente(estado)
            if vence_catalogo or vence_agenda or pedido:
                if pedido:
                    log("agenda_pedida", pedido_em=pedido)
                # Uma leitura do formulário serve para tudo: as listas moram na
                # mesma página, e dois logins seguidos só gastariam uma volta a
                # mais no WVSA.
                completo = vence_catalogo or bool(pedido)
                copiar_agenda(completo, estado)
                # Reagenda mesmo em erro: insistir de 5 em 5 s contra um WVSA
                # fora do ar é o que transforma indisponibilidade em enxurrada.
                # O pedido também não se repete: o erro fica gravado e a tela
                # mostra — tentar de novo é um clique novo.
                if completo:
                    proximo_catalogo = agora + CATALOGO_HORAS * 3600
                proxima_agenda = agora + AGENDAMENTO_MINUTOS * 60

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
