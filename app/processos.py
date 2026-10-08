"""Módulo Processos — mapa de processos, fluxogramas e instruções de trabalho.

Nasceu para a Infraestrutura, que tem dois times: o INTERNO (projeto, abertura
de OS, atendimento ao técnico) e o de CAMPO (o técnico que executa). Cada
processo tem um ou mais fluxos desenhados na folha do portal e gera
instruções de trabalho (IT) com revisão aprovada, que vão para o técnico em
PDF.

Como em Ações, o dado nasce aqui (CLAUDE.md §2): nada se apaga — processo se
arquiva, IT se obsoleta —, revisão aprovada é imutável por trigger e o que
precisa ser atômico mora em funções do Postgres (migration 0018).

Papéis (decisão de 08/10/2026):
  * todos com o módulo — criam processos, desenham e redigem rascunhos;
  * gestor da área (`acao_gestores`) ou admin — aprova, devolve, obsoleta e
    arquiva. Quem elaborou ou enviou não aprova a própria revisão (trava no
    banco, em `instrucao_aprovar`).
"""
import json
import math
from pathlib import Path
import re
import sys
import zlib
from datetime import datetime, timedelta, timezone

from . import acoes, supa

PUBLICOS = {"interno": "Time interno", "campo": "Técnico de campo",
            "ambos": "Interno e campo"}
EXECUTA = {"interno": "Time interno", "campo": "Técnico de campo"}

STATUS_REVISAO = {
    "rascunho": "Rascunho", "em_aprovacao": "Em aprovação", "devolvida": "Devolvida",
    "aprovada": "Vigente", "substituida": "Substituída",
}
ABERTAS = ("rascunho", "em_aprovacao", "devolvida")

# Presença: o editor pulsa a cada 60 s; passados 2 min sem pulso, a pessoa
# saiu (fechou a aba sem avisar, a máquina dormiu).
PRESENCA_VALE = timedelta(minutes=2)

# Limites do documento do fluxo. O banco recusa acima de 1 MB
# (`processo_fluxos_tamanho`); aqui a recusa vem antes, com mensagem, e os
# tetos de quantidade pegam o documento malformado que caberia no tamanho.
DOC_MAX_BYTES = 1_000_000
DOC_MAX = {"nos": 2000, "ligacoes": 4000, "livres": 2000, "raias": 40}
_SLUG = re.compile(r"^[a-z0-9_]{1,32}$")
# "PR-INF-003", "IT-GER-012". Conferido ANTES de ir ao banco: lixo na URL
# (byte nulo, aspas, 50 letras) vira 404 aqui, e não um 400 do PostgREST que
# a rota não sabe tratar e devolve como 500.
_CODIGO = re.compile(r"^(PR|IT)-[A-Z]{2,4}-[0-9]{3,6}$")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")

_COLS_PROCESSO = ("id,codigo,titulo,area_id,publico,dono_id,objetivo,escopo,"
                  "entradas,saidas,status,criado_por,criado_em,atualizado_em")
_COLS_FLUXO_META = ("id,processo_id,titulo,versao,arquivado,atualizado_por,"
                    "atualizado_em,editando_por,editando_desde,criado_em")


def _agora():
    """Instante atual COM fuso — `datetime.now()` ingênuo grava 3 h no
    passado numa coluna `timestamptz` (CLAUDE.md §6)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _falhou(onde, erro):
    print(f"[processos] falha em {onde}: {erro}", file=sys.stderr)


def _erro_rpc(e):
    """O `raise exception` da função vira mensagem para a tela, e a rota
    responde 400 — é erro de entrada, não do servidor."""
    return ValueError(str(e).split(": ", 1)[-1])


def eh_uuid(v):
    return acoes._eh_uuid(v)


hora_local = acoes._hora_local


def migracao_ok():
    """A 0018 subiu? Sem ela, a tela explica em vez de quebrar.

    Só `tabela_faltando` conta (PGRST205): qualquer outro erro é outro
    problema e precisa aparecer — recuar "na dúvida" foi o que degradou as
    Reuniões em 09/09/2026 (§6).
    """
    try:
        supa.select("processos", {"select": "id", "limit": "1"})
        return True
    except Exception as e:
        if supa.tabela_faltando(e):
            return False
        raise


# --------------------------------------------------------------------------
# Áreas
# --------------------------------------------------------------------------
def areas():
    """Áreas ativas com a sigla (que entra no código do processo).

    A sigla é coluna da 0018: sem ela, a lista sai sem sigla em vez de sumir.
    """
    try:
        return supa.select("acao_areas", {"select": "id,nome,sigla,ativo",
                                          "ativo": "is.true", "order": "nome.asc"})
    except Exception as e:
        if supa.coluna_faltando(e):
            return acoes.areas()
        _falhou("areas", e)
        return []


# --------------------------------------------------------------------------
# Permissões
# --------------------------------------------------------------------------
def pode_aprovar(usuario, processo):
    """Gestor da área do processo, ou admin. Vale para aprovar e devolver IT,
    obsoletar e arquivar. Editar é de todos com o módulo."""
    if not usuario or not processo:
        return False
    return bool(usuario.get("is_admin")) or \
        processo.get("area_id") in (usuario.get("areas_gestor") or [])


# --------------------------------------------------------------------------
# Documento do fluxo
# --------------------------------------------------------------------------
def documento_inicial(publico):
    """Folha nova já com as raias do público e o Início na primeira.

    As raias saem prontas porque são elas que viram o "Quem" da IT: um fluxo
    sem raia gera passo sem responsável.
    """
    titulos = {"interno": ["Time interno"], "campo": ["Técnico de campo"],
               "ambos": ["Time interno", "Técnico de campo"]}.get(publico, ["Time interno"])
    cores = {"Time interno": "brand", "Técnico de campo": "warning"}
    raias, y = [], 0
    for i, t in enumerate(titulos):
        raias.append({"id": f"r{i + 1}", "titulo": t, "x": 0, "y": y, "w": 1400,
                      "h": 280, "cor": cores.get(t, "brand")})
        y += 280
    nos = [{"id": "n1", "tipo": "terminal", "x": 70, "y": 110, "w": 120, "h": 48,
            "texto": "Início", "raia": "r1"}]
    return {"v": 1, "raias": raias, "nos": nos, "ligacoes": [], "livres": []}


# Modelos prontos: fluxos de partida desenhados a partir do processo REAL do
# portal (a Troca de Poste do §4 do CLAUDE.md). Arquivo em `app/modelos/`, e
# não em `static/`: só o servidor lê, e `app/` é a pasta que vai junto com a
# função na Vercel (como os templates).
MODELOS = {
    "abertura_os_troca_poste": {"titulo": "Abertura de OS de troca de poste", "publico": "interno"},
    "transferencia_cabo": {"titulo": "Transferência de cabo em troca de poste", "publico": "campo"},
}
_PASTA_MODELOS = Path(__file__).resolve().parent / "modelos"


def documento_modelo(chave):
    """O documento do modelo, já conferido. None para chave desconhecida —
    nunca monta caminho de arquivo com o que veio do formulário."""
    if chave not in MODELOS:
        return None
    with open(_PASTA_MODELOS / f"{chave}.json", encoding="utf-8") as f:
        return validar_documento(json.load(f))


def _numero(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) \
        and -1e6 < v < 1e6


def validar_documento(doc):
    """Confere a ESTRUTURA do documento antes de ele chegar ao banco.

    O tipo da forma é conferido só como slug, de propósito: a lista de formas
    mora em `fluxo_formas.js` e uma segunda cópia aqui divergiria dela — a
    armadilha dos dois normalizadores (§6). Tipo desconhecido o renderizador
    desenha como caixa genérica; o que não pode passar é id repetido,
    ligação para forma que não existe e número que não é número, porque isso
    quebra o desenho de todo mundo que abrir o fluxo depois.

    Devolve o JSON compacto (o que vai para o banco). Levanta ValueError.
    """
    if not isinstance(doc, dict) or doc.get("v") != 1:
        raise ValueError("Documento inválido (versão do formato).")
    for chave, teto in DOC_MAX.items():
        lista = doc.get(chave, [])
        if not isinstance(lista, list):
            raise ValueError(f"Documento inválido: '{chave}' não é lista.")
        if len(lista) > teto:
            raise ValueError(f"Fluxo grande demais: mais de {teto} em '{chave}'.")

    ids = set()

    def _id(item, onde):
        i = item.get("id") if isinstance(item, dict) else None
        if not isinstance(i, str) or not _ID.match(i):
            raise ValueError(f"Documento inválido: id ruim em '{onde}'.")
        if i in ids:
            raise ValueError(f"Documento inválido: id repetido ({i}).")
        ids.add(i)
        return i

    def _caixa(item, onde):
        for k in ("x", "y", "w", "h"):
            if not _numero(item.get(k)):
                raise ValueError(f"Documento inválido: '{k}' não é número em '{onde}'.")
        if item["w"] <= 0 or item["h"] <= 0:
            raise ValueError(f"Documento inválido: tamanho zero em '{onde}'.")

    def _texto(item, campo, teto, onde):
        t = item.get(campo)
        if t is not None and (not isinstance(t, str) or len(t) > teto):
            raise ValueError(f"Documento inválido: '{campo}' em '{onde}'.")

    raias = set()
    for r in doc.get("raias", []):
        raias.add(_id(r, "raias"))
        _caixa(r, "raias")
        _texto(r, "titulo", 120, "raias")

    nos = set()
    for n in doc.get("nos", []):
        nos.add(_id(n, "nos"))
        if not isinstance(n.get("tipo"), str) or not _SLUG.match(n["tipo"]):
            raise ValueError("Documento inválido: tipo de forma.")
        _caixa(n, "nos")
        _texto(n, "texto", 1000, "nos")
        if n.get("raia") is not None and n["raia"] not in raias:
            # Raia apagada: a forma fica sem raia em vez de recusar o
            # salvamento inteiro por um vínculo que o editor já devia ter solto.
            n["raia"] = None

    for l in doc.get("ligacoes", []):
        _id(l, "ligacoes")
        for ponta in ("de", "para"):
            p = l.get(ponta)
            if not isinstance(p, dict) or p.get("no") not in nos:
                raise ValueError("Documento inválido: ligação para forma inexistente.")
        _texto(l, "texto", 200, "ligacoes")

    for f in doc.get("livres", []):
        _id(f, "livres")
        if not isinstance(f.get("tipo"), str) or not _SLUG.match(f["tipo"]):
            raise ValueError("Documento inválido: tipo de traço.")
        pts = f.get("pontos")
        if pts is not None:
            if not isinstance(pts, list) or len(pts) > 5000 or not all(
                    isinstance(p, list) and len(p) == 2 and all(_numero(c) for c in p)
                    for p in pts):
                raise ValueError("Documento inválido: pontos do traço.")
        _texto(f, "texto", 1000, "livres")

    compacto = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    if len(compacto.encode("utf-8")) > DOC_MAX_BYTES:
        raise ValueError("Fluxo grande demais para salvar (mais de 1 MB). "
                         "Divida em dois fluxos ou remova traços livres longos.")
    return doc


# --------------------------------------------------------------------------
# Processos
# --------------------------------------------------------------------------
def listar_processos(incluir_arquivados=False):
    params = {"select": _COLS_PROCESSO, "order": "codigo.asc"}
    if not incluir_arquivados:
        params["status"] = "eq.ativo"
    return supa.select("processos", params)


def obter_processo(codigo):
    """Pelo código ("PR-INF-003"), que é o que vai na URL."""
    if not codigo or not _CODIGO.match(codigo) or not codigo.startswith("PR-"):
        return None
    return supa.select_one("processos", {"select": _COLS_PROCESSO,
                                         "codigo": f"eq.{codigo}"}) or None


def _limpo(v, teto):
    v = (v or "").strip()
    return v[:teto] or None


def criar_processo(dados, autor_id):
    """Cria processo + primeiro fluxo (com as raias do público) numa
    transação só — `processo_criar`. Devolve {id, codigo, fluxo_id}."""
    titulo = (dados.get("titulo") or "").strip()
    if len(titulo) < 3:
        raise ValueError("Dê um nome ao processo (pelo menos 3 letras).")
    publico = dados.get("publico") or "interno"
    if publico not in PUBLICOS:
        raise ValueError("Escolha quem executa o processo.")
    area_id = dados.get("area_id")
    if not eh_uuid(area_id):
        raise ValueError("Escolha a área.")
    dono = dados.get("dono_id") or None
    if dono and not eh_uuid(dono):
        raise ValueError("Dono inválido.")
    doc = documento_modelo(dados.get("modelo")) or documento_inicial(publico)
    try:
        return supa.rpc("processo_criar", {
            "p_titulo": titulo[:160], "p_area": area_id, "p_publico": publico,
            "p_dono": dono, "p_objetivo": _limpo(dados.get("objetivo"), 2000),
            "p_documento": doc, "p_autor": autor_id})
    except RuntimeError as e:
        raise _erro_rpc(e)


CAMPOS_FICHA = {"titulo": 160, "objetivo": 2000, "escopo": 2000,
                "entradas": 2000, "saidas": 2000}


def editar_processo(processo, dados):
    """Ficha do processo. A área NÃO muda depois de criado: o código leva a
    sigla dela, e um PR-INF que passasse a ser de Projetos mentiria."""
    mud = {}
    for campo, teto in CAMPOS_FICHA.items():
        if campo in dados:
            mud[campo] = _limpo(dados.get(campo), teto)
    if "titulo" in mud and (not mud["titulo"] or len(mud["titulo"]) < 3):
        raise ValueError("Dê um nome ao processo (pelo menos 3 letras).")
    if "publico" in dados:
        if dados["publico"] not in PUBLICOS:
            raise ValueError("Escolha quem executa o processo.")
        mud["publico"] = dados["publico"]
    if "dono_id" in dados:
        dono = dados.get("dono_id") or None
        if dono and not eh_uuid(dono):
            raise ValueError("Dono inválido.")
        mud["dono_id"] = dono
    if not mud:
        return processo
    mud["atualizado_em"] = _agora()
    supa.update("processos", {"id": processo["id"]}, mud)
    processo.update(mud)
    return processo


def definir_status_processo(processo, status):
    if status not in ("ativo", "arquivado"):
        raise ValueError("Status inválido.")
    supa.update("processos", {"id": processo["id"]},
                {"status": status, "atualizado_em": _agora()})


# --------------------------------------------------------------------------
# Fluxos
# --------------------------------------------------------------------------
def fluxos_do_processo(processo_id):
    """Só metadados — o documento é pesado e só o editor o lê."""
    return supa.select("processo_fluxos", {
        "select": _COLS_FLUXO_META, "processo_id": f"eq.{processo_id}",
        "arquivado": "is.false", "order": "criado_em.asc"})


def contagens_por_processo():
    """{processo_id: {"fluxos": n, "instrucoes": n, "vigentes": n}} para o
    catálogo, em duas leituras leves e sem o documento de ninguém."""
    fl, it = supa.paralelo(
        lambda: supa.select("processo_fluxos", {"select": "processo_id",
                                                "arquivado": "is.false"}),
        lambda: supa.select("instrucoes", {"select": "processo_id,revisao_vigente",
                                           "status": "eq.ativa"}))
    out = {}
    for f in fl:
        out.setdefault(f["processo_id"], {"fluxos": 0, "instrucoes": 0, "vigentes": 0})["fluxos"] += 1
    for i in it:
        c = out.setdefault(i["processo_id"], {"fluxos": 0, "instrucoes": 0, "vigentes": 0})
        c["instrucoes"] += 1
        if i.get("revisao_vigente") is not None:
            c["vigentes"] += 1
    return out


def obter_fluxo(fluxo_id):
    if not eh_uuid(fluxo_id):
        return None
    return supa.select_one("processo_fluxos", {
        "select": _COLS_FLUXO_META + ",documento", "id": f"eq.{fluxo_id}"}) or None


def criar_fluxo(processo, titulo, autor_id, documento=None, modelo=None):
    titulo = (titulo or "").strip()[:120] or "Novo fluxo"
    if documento:
        doc = validar_documento(documento)
    else:
        doc = documento_modelo(modelo) or documento_inicial(processo["publico"])
    linha = supa.insert("processo_fluxos", {
        "processo_id": processo["id"], "titulo": titulo, "documento": doc,
        "criado_por": autor_id, "atualizado_por": autor_id})
    return linha[0] if isinstance(linha, list) else linha


def renomear_fluxo(fluxo, titulo):
    titulo = (titulo or "").strip()[:120]
    if not titulo:
        raise ValueError("Dê um nome ao fluxo.")
    supa.update("processo_fluxos", {"id": fluxo["id"]}, {"titulo": titulo})


def salvar_fluxo(fluxo_id, doc, versao, autor_id):
    """Grava se ninguém gravou depois da leitura. Devolve o dict da função:
    {ok, versao, em} ou {ok: False, erro: conflito|inexistente|arquivado, ...}.
    """
    if not isinstance(versao, int) or isinstance(versao, bool) or versao < 1:
        raise ValueError("Versão do fluxo ausente.")
    validar_documento(doc)
    return supa.rpc("processo_fluxo_salvar", {
        "p_fluxo": fluxo_id, "p_doc": doc, "p_versao": versao, "p_autor": autor_id})


def fotografar_fluxo(fluxo_id, nome, autor_id, motivo="manual"):
    try:
        return supa.rpc("processo_fluxo_fotografar", {
            "p_fluxo": fluxo_id, "p_nome": (nome or "").strip()[:120] or None,
            "p_motivo": motivo, "p_autor": autor_id})
    except RuntimeError as e:
        raise _erro_rpc(e)


def versoes_do_fluxo(fluxo_id, limite=30):
    return supa.select("processo_fluxo_versoes", {
        "select": "id,versao,nome,motivo,criado_por,criado_em",
        "fluxo_id": f"eq.{fluxo_id}", "order": "criado_em.desc", "limit": str(limite)})


def marcar_presenca(fluxo, uid):
    """Pulso do editor. Devolve quem MAIS estava editando (ou None).

    Lê antes de escrever: com duas pessoas pulsando de minuto em minuto, a
    coluna alterna entre elas, e cada leitura enxerga o pulso do outro — é o
    que basta para os dois verem o aviso sem uma tabela de presença.
    """
    atual = supa.select_one("processo_fluxos", {
        "select": "editando_por,editando_desde", "id": f"eq.{fluxo['id']}"}) or {}
    outro = None
    quem, desde = atual.get("editando_por"), atual.get("editando_desde")
    if quem and quem != uid and desde:
        try:
            d = datetime.fromisoformat(str(desde).replace("Z", "+00:00"))
            if datetime.now(timezone.utc) - d < PRESENCA_VALE:
                outro = quem
        except ValueError:
            pass
    supa.update("processo_fluxos", {"id": fluxo["id"]},
                {"editando_por": uid, "editando_desde": _agora()})
    return outro


# --------------------------------------------------------------------------
# Instruções de trabalho
# --------------------------------------------------------------------------
_COLS_IT = ("id,codigo,processo_id,fluxo_id,titulo,executa,revisao_vigente,status,"
            "criado_por,criado_em,atualizado_em")
_COLS_REV = ("id,instrucao_id,numero,motivo_revisao,status,versao,elaborado_por,"
             "elaborado_em,enviado_por,enviado_em,aprovado_por,aprovado_em,"
             "vigente_desde,devolvido_motivo,atualizado_por,atualizado_em")


def listar_instrucoes(processo_id=None, incluir_obsoletas=False):
    """ITs com a revisão ABERTA embutida (se houver) — a lista mostra "Rev. 02
    vigente · Rev. 03 em aprovação" sem uma ida por linha."""
    params = {"select": _COLS_IT + ",instrucao_revisoes(numero,status)",
              "order": "codigo.asc"}
    if processo_id:
        params["processo_id"] = f"eq.{processo_id}"
    if not incluir_obsoletas:
        params["status"] = "eq.ativa"
    linhas = supa.select("instrucoes", params)
    for it in linhas:
        revs = it.pop("instrucao_revisoes", None) or []
        aberta = [r for r in revs if r.get("status") in ABERTAS]
        it["aberta"] = aberta[0] if aberta else None
    return linhas


def obter_instrucao(codigo):
    if not codigo or not _CODIGO.match(codigo) or not codigo.startswith("IT-"):
        return None
    return supa.select_one("instrucoes", {"select": _COLS_IT,
                                          "codigo": f"eq.{codigo}"}) or None


def revisoes(instrucao_id):
    return supa.select("instrucao_revisoes", {
        "select": _COLS_REV, "instrucao_id": f"eq.{instrucao_id}",
        "order": "numero.asc"})


def obter_revisao(instrucao_id, numero, com_snapshot=False):
    cols = _COLS_REV + ",conteudo" + (",fluxo_snapshot" if com_snapshot else "")
    return supa.select_one("instrucao_revisoes", {
        "select": cols, "instrucao_id": f"eq.{instrucao_id}",
        "numero": f"eq.{int(numero)}"}) or None


def eventos_instrucao(instrucao_id):
    return supa.select("instrucao_eventos", {
        "select": "id,revisao_numero,tipo,texto,autor_id,criado_em",
        "instrucao_id": f"eq.{instrucao_id}", "order": "criado_em.asc"})


def criar_instrucao(processo, dados, autor_id, conteudo=None):
    titulo = (dados.get("titulo") or "").strip()
    if len(titulo) < 3:
        raise ValueError("Dê um nome à instrução (pelo menos 3 letras).")
    executa = dados.get("executa") or "campo"
    if executa not in EXECUTA:
        raise ValueError("Escolha quem executa a instrução.")
    fluxo_id = dados.get("fluxo_id") or None
    if fluxo_id and not eh_uuid(fluxo_id):
        raise ValueError("Fluxo inválido.")
    try:
        return supa.rpc("instrucao_criar", {
            "p_processo": processo["id"], "p_fluxo": fluxo_id, "p_titulo": titulo[:160],
            "p_executa": executa, "p_conteudo": conteudo or {}, "p_autor": autor_id})
    except RuntimeError as e:
        raise _erro_rpc(e)


def salvar_rascunho(rev_id, conteudo, versao, autor_id):
    if not isinstance(versao, int) or isinstance(versao, bool) or versao < 1:
        raise ValueError("Versão do rascunho ausente.")
    return supa.rpc("instrucao_salvar", {"p_rev": rev_id, "p_conteudo": conteudo,
                                         "p_versao": versao, "p_autor": autor_id})


# Erros de constraint que chegam crus do Postgres e viram frase da tela.
_TRADUCOES = {
    "instrucao_revisoes_aberta_uk": "já existe uma revisão em andamento — termine ou aprove aquela antes",
}


def _rpc_simples(funcao, args):
    try:
        return supa.rpc(funcao, args)
    except RuntimeError as e:
        for chave, frase in _TRADUCOES.items():
            if chave in str(e):
                raise ValueError(frase)
        raise _erro_rpc(e)


def enviar(rev_id, autor_id):
    _rpc_simples("instrucao_enviar", {"p_rev": rev_id, "p_autor": autor_id})


def aprovar(rev_id, aprovador_id):
    _rpc_simples("instrucao_aprovar", {"p_rev": rev_id, "p_aprovador": aprovador_id})


def devolver(rev_id, autor_id, motivo):
    _rpc_simples("instrucao_devolver", {"p_rev": rev_id, "p_autor": autor_id,
                                        "p_motivo": (motivo or "").strip()})


def nova_revisao(instrucao_id, autor_id, motivo):
    return _rpc_simples("instrucao_nova_revisao", {
        "p_instrucao": instrucao_id, "p_autor": autor_id,
        "p_motivo": (motivo or "").strip()})


def definir_status_instrucao(instrucao_id, status, autor_id, motivo=None):
    _rpc_simples("instrucao_definir_status", {
        "p_instrucao": instrucao_id, "p_status": status, "p_autor": autor_id,
        "p_motivo": (motivo or "").strip() or None})


# --------------------------------------------------------------------------
# Conteúdo da instrução
# --------------------------------------------------------------------------
# Sugestões dos campos de lista. São SUGESTÕES (datalist): a pessoa escreve o
# que quiser; a lista só poupa digitação no que se repete em toda IT de campo.
SUGESTOES = {
    "epis": ["Capacete com jugular", "Cinto paraquedista", "Talabarte duplo", "Trava-quedas",
             "Luva isolante", "Luva de vaqueta", "Óculos de proteção", "Botina de segurança",
             "Colete refletivo", "Cones e fita de sinalização"],
    "materiais": ["Escada extensível", "Máquina de fusão", "Clivador", "Power meter", "OTDR",
                  "Alicate decapador", "Abraçadeiras", "Fita isolante", "Celular com o app de OS"],
}

# Alertas prontos de segurança — texto genérico e editável, não citação de
# norma: quem conhece o procedimento da casa ajusta na própria IT.
ALERTAS_PRONTOS = [
    {"nivel": "perigo", "texto": "NR-35 — trabalho em altura: acima de 2 m, só com APR, "
                                 "cinto paraquedista e ancoragem conferida."},
    {"nivel": "perigo", "texto": "NR-10 — proximidade da rede elétrica: mantenha a distância "
                                 "segura; rede energizada só com o procedimento da concessionária."},
    {"nivel": "atencao", "texto": "Sinalize a via antes de subir na escada."},
]

SECOES_TEXTO = {"objetivo": 5000, "aplicacao": 5000, "criterios": 5000, "registros": 5000}


def _txt(v, teto):
    return v.strip()[:teto] if isinstance(v, str) else ""


def _id_curto(v):
    return v if isinstance(v, str) and _ID.match(v) else None


def normalizar_conteudo(c):
    """Só o que a instrução conhece, nos tamanhos que ela aceita.

    O conteúdo vem do navegador e vai para o PDF de um documento controlado:
    chave desconhecida é descartada, texto é cortado no teto e lista no
    tamanho máximo. Levanta ValueError só quando nem é um dicionário — o resto
    se conserta, para o autosave não travar por um detalhe.
    """
    if not isinstance(c, dict):
        raise ValueError("Conteúdo inválido.")
    out = {k: _txt(c.get(k), t) for k, t in SECOES_TEXTO.items()}

    def lista(chave, teto, fn):
        v = c.get(chave)
        return [x for x in (fn(i) for i in (v if isinstance(v, list) else [])[:teto]) if x]

    out["responsabilidades"] = lista("responsabilidades", 30, lambda r: isinstance(r, dict) and (
        _txt(r.get("papel"), 120) or _txt(r.get("descricao"), 1000)) and {
        "papel": _txt(r.get("papel"), 120), "descricao": _txt(r.get("descricao"), 1000)})
    out["definicoes"] = lista("definicoes", 50, lambda r: isinstance(r, dict) and (
        _txt(r.get("termo"), 80) or _txt(r.get("significado"), 500)) and {
        "termo": _txt(r.get("termo"), 80), "significado": _txt(r.get("significado"), 500)})
    for k in ("epis", "materiais", "referencias"):
        out[k] = lista(k, 60, lambda s: _txt(s, 200) or None)
    out["seguranca"] = lista("seguranca", 30, lambda r: isinstance(r, dict) and _txt(r.get("texto"), 1000) and {
        "nivel": "perigo" if r.get("nivel") == "perigo" else "atencao",
        "texto": _txt(r.get("texto"), 1000)})

    def passo(p):
        if not isinstance(p, dict):
            return None
        atividade = _txt(p.get("atividade"), 1000)
        detalhe = _txt(p.get("detalhe"), 4000)
        if not (atividade or detalhe):
            return None
        desvios = []
        for d in (p.get("desvios") if isinstance(p.get("desvios"), list) else [])[:10]:
            if not isinstance(d, dict):
                continue
            item = {"rotulo": _txt(d.get("rotulo"), 80)}
            if _id_curto(d.get("no")):
                item["no"] = d["no"]
            elif d.get("fim") is True:
                item["fim"] = True
            elif _txt(d.get("fora"), 120):
                item["fora"] = _txt(d.get("fora"), 120)
            else:
                continue
            desvios.append(item)
        g = p.get("gerado") if isinstance(p.get("gerado"), dict) else None
        return {
            "id": _id_curto(p.get("id")) or "p_" + str(zlib.crc32((atividade + detalhe).encode("utf-8"))),
            "no_id": _id_curto(p.get("no_id")),
            "tipo": "decisao" if p.get("tipo") == "decisao" else "acao",
            "quem": _txt(p.get("quem"), 120), "atividade": atividade, "detalhe": detalhe,
            "atencao": _txt(p.get("atencao"), 2000), "desvios": desvios,
            "desvio_texto": _txt(p.get("desvio_texto"), 500),
            "gerado": {"atividade": _txt(g.get("atividade"), 1000), "quem": _txt(g.get("quem"), 120)} if g else None,
        }
    out["passos"] = lista("passos", 200, passo)
    # id repetido (passo duplicado à mão) quebraria o casamento da próxima
    # geração: o segundo ganha id novo.
    vistos = set()
    for i, p in enumerate(out["passos"]):
        if p["id"] in vistos:
            p["id"] = f"{p['id'][:30]}_{i}"
        vistos.add(p["id"])
    return out


def conteudo_inicial(processo, documento=None):
    """A IT nasce com o que o processo já sabe: objetivo e as raias do fluxo
    como responsabilidades. Os passos vêm do gerador, no navegador."""
    raias = [r.get("titulo") for r in (documento or {}).get("raias", []) if r.get("titulo")]
    return normalizar_conteudo({
        "objetivo": processo.get("objetivo") or "",
        "aplicacao": processo.get("escopo") or "",
        "responsabilidades": [{"papel": t, "descricao": ""} for t in raias],
    })


def revisao_atual(revs, numero=None):
    """Qual revisão a tela abre: a pedida; senão a aberta; senão a vigente;
    senão a última."""
    if numero is not None:
        return next((r for r in revs if r["numero"] == numero), None)
    aberta = next((r for r in revs if r["status"] in ABERTAS), None)
    if aberta:
        return aberta
    vig = next((r for r in revs if r["status"] == "aprovada"), None)
    return vig or (revs[-1] if revs else None)


def passos_por_forma(fluxo_id):
    """{no_id: [{"it": "IT-INF-002", "passo": 6, "rev": 1}]} — de qual passo de
    qual instrução cada forma virou. É o que o painel da folha mostra ("Na
    instrução: IT-INF-002 · passo 6"): quem mexe na forma vê o que vai mudar
    no papel. Vale a revisão aberta; sem ela, a vigente."""
    its = supa.select("instrucoes", {"select": "id,codigo", "fluxo_id": f"eq.{fluxo_id}",
                                     "status": "eq.ativa"})
    if not its:
        return {}
    revs = supa.select("instrucao_revisoes", {
        "select": "instrucao_id,numero,status,conteudo",
        "instrucao_id": f"in.({','.join(i['id'] for i in its)})",
        "status": "in.(rascunho,em_aprovacao,devolvida,aprovada)"})
    out = {}
    for it in its:
        da_it = [r for r in revs if r["instrucao_id"] == it["id"]]
        rev = next((r for r in da_it if r["status"] in ABERTAS), None) or \
            next((r for r in da_it if r["status"] == "aprovada"), None)
        if not rev:
            continue
        for i, p in enumerate((rev.get("conteudo") or {}).get("passos") or []):
            if isinstance(p, dict) and p.get("no_id"):
                out.setdefault(p["no_id"], []).append(
                    {"it": it["codigo"], "passo": i + 1, "rev": rev["numero"]})
    return out
