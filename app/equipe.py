"""Equipe técnica: o cadastro de quem está em campo (migration 0023).

Nasceu em 24/11/2026 da planilha "Equipe técnica" (19/11/2026), que só
existia em papel. É a fonte da CAPACIDADE da War Room:

* **interno** = equipe que faz atividade interna E externa → 6 OS por dia;
* **externo** = só atividade externa → 4 OS por dia.

Antes, o perfil era adivinhado pela maioria das OS do técnico em 30 dias
(`war_room._faz_externa`) e a conta só incluía quem fechou OS no dia. A
planilha passou a mandar (decisão de 24/11/2026); o palpite ficou só para
quem fecha OS de cliente e não está no cadastro, e a tela o mostra à parte.

**Três níveis**, com o mesmo nome em todas as telas:

* **instalada** — toda a equipe ativa × 4/6 (este módulo);
* **escalada** — quem tem OS agendada no dia × 4/6 (depende da agenda do
  WVSA; ainda não coletada);
* **em campo** — quem fechou ao menos uma OS de cliente no dia, que é a
  confirmação no fim do dia (`war_room`).

É dado que NASCE AQUI (§2): técnico se desativa, não se apaga, e toda
mudança vai para `equipe_tecnicos_historico` (append-only por trigger). É
o histórico que dá a equipe COMO ELA ERA num dia passado (`equipe_em`):
editar um técnico hoje não pode mudar a capacidade de ontem.
"""
import re
import unicodedata
from datetime import date, datetime, time, timedelta, timezone

from . import supa

BR_TZ = timezone(timedelta(hours=-3))

CAP_EXTERNA, CAP_INTERNA = 4, 6
DIAS_OBSERVADOS = 30       # janela do "o que a Produtividade mostra" na tela

_COLS = ("id,nome,nome_wvsa,chave,empresa,interno,agenda_automatica,retencao,retirada,"
         "supervisor_id,cidades,ativo,criado_em,atualizado_em,atualizado_por")

# O que a tela edita e o tipo de cada campo. `chave` não está aqui: ela é
# DERIVADA de nome/nome_wvsa e recalculada a cada gravação.
_BOOL = ("interno", "agenda_automatica", "retencao", "retirada", "ativo")
_TEXTO = {"nome": 120, "nome_wvsa": 120, "empresa": 80, "cidades": 200}
CAMPOS = (*_TEXTO, *_BOOL, "supervisor_id")

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class Recusa(ValueError):
    """Entrada que a tela deve mostrar como erro (400), não como falha."""


def chave(nome):
    """Chave de casamento entre o cadastro e a Produtividade.

    Sem acento, minúsculas, espaço simples. O WVSA não é consistente
    ("GABRIEL ANDRE FELICIANO" sob RETIRADA, "Gabriel André Feliciano" na
    planilha): comparar o texto cru transformaria uma pessoa em duas, e a
    capacidade cairia no palpite sem erro nenhum na tela. A carga da
    migration 0023 grava exatamente o que esta função produz.
    """
    t = unicodedata.normalize("NFKD", (nome or "").strip().lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", t).strip()


def capacidade_de(t):
    return CAP_INTERNA if t.get("interno") else CAP_EXTERNA


def entra_na_war_room(t):
    """A War Room é do agendamento de cliente: técnico de retirada fica fora
    da capacidade dela (mas continua na equipe)."""
    return t.get("ativo", True) and not t.get("retirada")


def somar(tecnicos):
    """[capacidade, externos, internos] de uma lista de técnicos."""
    internos = sum(1 for t in tecnicos if t.get("interno"))
    externos = len(tecnicos) - internos
    return [internos * CAP_INTERNA + externos * CAP_EXTERNA, externos, internos]


# ---------------------------------------------------------------------
# Leitura
# ---------------------------------------------------------------------
def listar():
    """Todos os técnicos, ativos e inativos, em ordem de empresa e nome.

    Recua para `None` quando a migration 0023 ainda não subiu: a War Room
    segue com o palpite antigo e a tela diz o que falta.
    """
    try:
        linhas = supa.select("equipe_tecnicos", {"select": _COLS, "limit": "1000"})
    except Exception as e:
        if supa.tabela_faltando(e):
            return None
        raise
    return sorted(linhas, key=lambda t: (chave(t["empresa"]), chave(t["nome"])))


def historico():
    """O histórico inteiro, do mais novo para o mais antigo. São dezenas de
    linhas por mês (a equipe muda pouco); paginado mesmo assim, porque o
    PostgREST corta em 1000 em silêncio (§6)."""
    linhas = []
    try:
        while True:
            lote = supa.select("equipe_tecnicos_historico", {
                "select": "id,tecnico_id,em,por,acao,antes,depois",
                "order": "em.desc,id.desc", "limit": "1000", "offset": str(len(linhas))})
            linhas.extend(lote)
            if len(lote) < 1000:
                return linhas
    except Exception as e:
        if supa.tabela_faltando(e):
            return []
        raise


def _fim_do_dia(dia):
    """Instante (UTC) em que o dia civil de Brasília termina."""
    return datetime.combine(dia + timedelta(days=1), time(0), tzinfo=BR_TZ).astimezone(timezone.utc)


def equipe_em(dia, atuais, eventos):
    """A equipe como era no FIM do dia `dia`.

    Parte de hoje e desfaz, do mais novo para o mais antigo, cada mudança
    feita depois daquele dia: `alterado` volta ao `antes`, `criado` some
    (não existia). `importado` é a carga da planilha e vale desde sempre —
    sem isso, todo dia anterior a 24/11/2026 ficaria com equipe vazia.
    `eventos` vem de `historico()` (mais novo primeiro).
    """
    limite = _fim_do_dia(dia)
    estado = {t["id"]: t for t in atuais}
    for ev in eventos:
        if datetime.fromisoformat(ev["em"]) < limite:
            break
        if ev["acao"] == "criado":
            estado.pop(ev["tecnico_id"], None)
        elif ev["acao"] == "alterado" and ev.get("antes"):
            estado[ev["tecnico_id"]] = ev["antes"]
    return list(estado.values())


def instalada_por_dia(dias, atuais, eventos):
    """{dia ISO: [capacidade, externos, internos]} da War Room (só ativos e
    sem retirada), com a equipe de cada dia. Os eventos são poucos e a
    equipe tem ~40 linhas: refazer o estado dia a dia custa nada."""
    if atuais is None:
        return {}
    saida = {}
    for iso in dias:
        eq = equipe_em(date.fromisoformat(iso), atuais, eventos)
        saida[iso] = somar([t for t in eq if entra_na_war_room(t)])
    return saida


def indice(tecnicos):
    """chave -> técnico, para casar com a Produtividade."""
    return {t["chave"]: t for t in tecnicos or []}


# ---------------------------------------------------------------------
# A tela de Equipe
# ---------------------------------------------------------------------
def observado(hoje):
    """O que a Produtividade mostra de cada técnico nos últimos 30 dias:
    OS de cliente, quantas externas e internas, e o último dia com OS.

    Lê pela MESMA leitura da War Room (`_ler_produtividade`, com cache por
    carimbo), sem expandir as 57 mil OS. Serve para a tela mostrar quem
    está no cadastro e não aparece no WVSA (nome que não casou) e quem
    fecha OS e não está no cadastro.
    """
    from . import war_room   # importa aqui: war_room também importa este módulo
    corte = (hoje - timedelta(days=DIAS_OBSERVADOS)).isoformat()
    por_chave = {}
    _, linhas = war_room._ler_produtividade()
    for d, e, t, f, su, mo, ta, *_ in linhas:
        if not d or d < corte or not t or t == "—":
            continue
        cliente = war_room.eh_cliente(f)
        k = chave(t)
        o = por_chave.setdefault(k, {"nome": t, "empresa": e if e and e != "—" else "",
                                     "cliente": 0, "externas": 0, "internas": 0,
                                     "outras": 0, "ultimo": d})
        if cliente:
            o["cliente"] += 1
            o["externas" if ta else "internas"] += 1
        else:
            o["outras"] += 1
        if d >= o["ultimo"]:
            # A empresa é a da OS mais recente: o técnico que trocou de
            # empresa aparece com a de agora.
            o["ultimo"] = d
            if e and e != "—":
                o["empresa"] = e
    return por_chave


def resumo(tecnicos):
    """Os números do topo da tela (só ativos), na ordem da planilha."""
    ativos = [t for t in tecnicos if t.get("ativo")]
    wr = [t for t in ativos if entra_na_war_room(t)]
    return {
        "tecnicos": len(ativos),
        "empresas": len({t["empresa"] for t in ativos}),
        "agenda_automatica": sum(1 for t in ativos if t.get("agenda_automatica")),
        "internos": sum(1 for t in ativos if t.get("interno")),
        "retencao": sum(1 for t in ativos if t.get("retencao")),
        "retirada": sum(1 for t in ativos if t.get("retirada")),
        "instalada": somar(ativos),
        "instalada_war_room": somar(wr),
    }


def aplicar_responsaveis(tecnicos, alcance):
    """Troca o `supervisor_id` do cadastro pelo do VÍNCULO de Configurações.

    Desde 25/11/2026 quem responde por um técnico é o vínculo
    (`supervisores.responsaveis`), em todas as telas — a coluna do cadastro
    ficou no banco, com o histórico, mas não manda mais. `supervisores`
    traz todos (pelo vínculo um técnico pode ter dois); `supervisor_id` é o
    primeiro, que é o que a tabela e o PDF desenham.
    """
    from . import supervisores as sup
    for t in tecnicos or []:
        ids = sup.responsaveis(alcance, t["empresa"], t.get("nome_wvsa") or t["nome"])
        t["supervisor_cadastro"] = t.get("supervisor_id")
        t["supervisores"] = ids
        t["supervisor_id"] = ids[0] if ids else None
    return tecnicos


def pacote(hoje, supervisores):
    """Tudo o que a tela de Equipe precisa. `supervisores` = [{id, nome}]."""
    from . import supervisores as sup
    tecnicos, obs, alcance = supa.paralelo(listar, lambda: observado(hoje), sup.alcance_serie)
    if tecnicos is None:
        return {"tem_tabela": False}
    aplicar_responsaveis(tecnicos, alcance)
    no_cadastro = set()
    for t in tecnicos:
        no_cadastro.add(t["chave"])
        t["obs"] = obs.get(t["chave"])
    # Quem fecha OS de CLIENTE e não está no cadastro: é quem a War Room
    # conta pelo palpite antigo. Supervisor que fechou uma OS ou outra entra
    # também — a tela mostra a quantidade e quem decide é o admin.
    fora = sorted((o for k, o in obs.items() if k not in no_cadastro and o["cliente"]),
                  key=lambda o: -o["cliente"])
    return {
        "tem_tabela": True,
        "tecnicos": tecnicos,
        "resumo": resumo(tecnicos),
        "fora": fora,
        "supervisores": supervisores,
        "cap_externa": CAP_EXTERNA,
        "cap_interna": CAP_INTERNA,
        "dias_observados": DIAS_OBSERVADOS,
    }


# ---------------------------------------------------------------------
# Escrita (só admin; a rota confere)
# ---------------------------------------------------------------------
def _limpar(campo, valor, supervisores_ids):
    if campo in _BOOL:
        if not isinstance(valor, bool):
            raise Recusa(f"“{campo}” precisa ser sim ou não.")
        return valor
    if campo == "supervisor_id":
        if valor in (None, ""):
            return None
        if not isinstance(valor, str) or not _UUID.match(valor) or valor not in supervisores_ids:
            raise Recusa("Supervisor desconhecido.")
        return valor
    if campo in _TEXTO:
        if valor is None:
            valor = ""
        if not isinstance(valor, str):
            raise Recusa(f"“{campo}” precisa ser texto.")
        valor = re.sub(r"\s+", " ", valor).strip()
        if len(valor) > _TEXTO[campo]:
            raise Recusa(f"“{campo}” passa de {_TEXTO[campo]} caracteres.")
        if campo in ("nome", "empresa") and not valor:
            raise Recusa("Nome e empresa são obrigatórios.")
        if campo == "empresa":
            valor = valor.upper()
        if campo == "nome_wvsa":
            return valor or None
        return valor
    raise Recusa("Campo desconhecido.")


def _chave_livre(k, menos_id=None):
    achado = supa.select("equipe_tecnicos", {"select": "id,nome", "chave": f"eq.{k}"})
    for a in achado:
        if a["id"] != menos_id:
            raise Recusa(f"Já existe um técnico com esse nome no cadastro ({a['nome']}).")


def _agora():
    return datetime.now(timezone.utc).isoformat()


def criar(corpo, uid, supervisores_ids):
    if not isinstance(corpo, dict):
        raise Recusa("Pedido inválido.")
    dados = {c: _limpar(c, corpo.get(c, False if c in _BOOL else None), supervisores_ids)
             for c in CAMPOS if c in corpo or c in ("nome", "empresa")}
    dados.setdefault("ativo", True)
    k = chave(dados.get("nome_wvsa") or dados["nome"])
    _chave_livre(k)
    dados.update({"chave": k, "atualizado_por": uid, "atualizado_em": _agora()})
    return supa.insert("equipe_tecnicos", dados)


def atualizar(tecnico_id, campo, valor, uid, supervisores_ids):
    if not _UUID.match(tecnico_id or ""):
        return None
    if campo not in CAMPOS:
        raise Recusa("Campo desconhecido.")
    atual = supa.select_one("equipe_tecnicos", {"select": _COLS, "id": f"eq.{tecnico_id}"})
    if not atual:
        return None
    valor = _limpar(campo, valor, supervisores_ids)
    mud = {campo: valor, "atualizado_por": uid, "atualizado_em": _agora()}
    if campo in ("nome", "nome_wvsa"):
        novo = {**atual, campo: valor}
        k = chave(novo.get("nome_wvsa") or novo["nome"])
        if k != atual["chave"]:
            _chave_livre(k, tecnico_id)
            mud["chave"] = k
    linhas = supa.update("equipe_tecnicos", {"id": tecnico_id}, mud)
    return (linhas[0] if isinstance(linhas, list) and linhas else linhas) or {**atual, **mud}


def ultimas_mudancas(eventos, nomes, limite=15):
    """O histórico em frases curtas, para o rodapé da tela. Só o que mudou
    de verdade (o trigger já não grava salvamento sem mudança)."""
    rot = {"interno": "interno", "agenda_automatica": "agenda automática", "retencao": "retenção",
           "retirada": "retirada", "ativo": "ativo", "nome": "nome", "nome_wvsa": "nome no WVSA",
           "empresa": "empresa", "cidades": "cidades", "supervisor_id": "supervisor"}
    saida = []
    for ev in eventos:
        if ev["acao"] == "importado":
            continue
        dep, ant = ev.get("depois") or {}, ev.get("antes") or {}
        if ev["acao"] == "criado":
            txt = "incluído no cadastro"
        else:
            campos = [rot[c] for c in rot if ant.get(c) != dep.get(c)]
            if not campos:
                continue
            txt = "mudou " + ", ".join(campos)
        saida.append({"em": datetime.fromisoformat(ev["em"]).astimezone(BR_TZ).strftime("%d/%m %H:%M"),
                      "tecnico": dep.get("nome") or "—", "texto": txt,
                      "por": nomes.get(ev.get("por"), "—")})
        if len(saida) >= limite:
            break
    return saida



def supervisores_lista():
    """[{id, nome}] de quem é supervisor, por nome. Em SÉRIE: a rota da
    tela já chama `pacote`, que tem o seu próprio paralelo."""
    ids = [l["usuario_id"] for l in supa.select("supervisores", {"select": "usuario_id"})]
    if not ids:
        return []
    us = supa.select("usuarios", {"select": "id,nome", "id": f"in.({','.join(ids)})"})
    return sorted(({"id": u["id"], "nome": u.get("nome") or "—"} for u in us),
                  key=lambda u: chave(u["nome"]))
