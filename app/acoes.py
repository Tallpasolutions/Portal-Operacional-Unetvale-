"""Módulo Ações — acompanhamento, reuniões e histórico.

Porta para o portal o método que vivia na planilha `Acompanhamento_de_Acoes.xlsx`.
A planilha acertou o método; o que ela não fazia é dar a cada pessoa a visão das
ações DELA, ser atualizada do celular e guardar o que o gestor decidiu na reunião.

Diferença importante para os outros módulos: Produtividade, IQI e Massivas são
espelho do WVSA e podem ser recoletados. Aqui o dado nasce e morre no portal —
por isso `acao_eventos` é append-only, no código e por trigger.

Papéis:
  * admin    — vê e faz tudo;
  * gestor   — cria ações e conduz reuniões nas áreas vinculadas a ele;
  * usuário  — vê e atualiza as ações onde é responsável ou apoio.
"""
import sys
from datetime import date, datetime, timezone

from . import supa

# Fixos no código, e não configuráveis pela tela, de propósito: "Concluída" e
# "Cancelada" decidem o cálculo da situação do prazo. Deixar alguém renomear
# "Concluída" em Configurações quebraria o Painel em silêncio. A lista que a
# operação realmente precisa mexer — Áreas — essa sim é tabela.
STATUS = ["Não iniciada", "Em andamento", "Aguardando", "Concluída", "Cancelada"]
PRIORIDADES = ["Crítica", "Alta", "Média", "Baixa"]

# Ordem de urgência para a pauta da reunião e para o padrão da lista.
ORDEM_PRIORIDADE = {p: i for i, p in enumerate(PRIORIDADES)}
ORDEM_SITUACAO = {"Atrasada": 0, "Vence em breve": 1, "No prazo": 2,
                  "Sem prazo": 3, "Concluída": 4, "Cancelada": 5}

# A planilha chama de "vence em breve" o que cai nos próximos 7 dias.
JANELA_VENCE_EM_BREVE = 7

TERMINAIS = ("Concluída", "Cancelada")


def _agora():
    """Instante atual, COM fuso.

    `datetime.now()` devolve hora local ingênua (UTC-3 aqui) e, numa coluna
    `timestamptz`, o Postgres lê o valor sem fuso como se já fosse UTC — o
    carimbo nascia 3 horas no passado. As colunas com `default now()` sempre
    estiveram certas; o erro era só nos horários escritos pelo Python.
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _falhou(onde, erro):
    print(f"[acoes] falha em {onde}: {erro}", file=sys.stderr)


def _data(v):
    """'2026-08-28' -> date. Aceita None e datetime já pronto."""
    if not v:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


# --------------------------------------------------------------------------
# Regras derivadas — as duas fórmulas da planilha, portadas literalmente.
#
#   Situação:  =IF(J="Concluída","Concluída",IF(J="Cancelada","Cancelada",
#                IF(H="","Sem prazo",IF(H<TODAY(),"Atrasada",
#                IF(H-TODAY()<=7,"Vence em breve","No prazo")))))
#   Dias:      =IF(OR(J="Concluída",J="Cancelada"),"",IF(H="","",H-TODAY()))
#
# São CALCULADAS, nunca colunas: dependem de hoje e estariam erradas amanhã.
# --------------------------------------------------------------------------
def situacao_prazo(status, prazo, hoje=None):
    if status in TERMINAIS:
        return status
    prazo = _data(prazo)
    if not prazo:
        return "Sem prazo"
    hoje = hoje or date.today()
    if prazo < hoje:
        return "Atrasada"
    if (prazo - hoje).days <= JANELA_VENCE_EM_BREVE:
        return "Vence em breve"
    return "No prazo"


def dias_para_prazo(status, prazo, hoje=None):
    """Dias até o prazo. `None` quando não se aplica — não zero.

    Zero é um valor legítimo aqui (vence hoje), então "não se aplica" precisa
    ser outra coisa, senão a tela mostraria "vence hoje" para ação concluída.
    """
    if status in TERMINAIS:
        return None
    prazo = _data(prazo)
    if not prazo:
        return None
    return (prazo - (hoje or date.today())).days


def _decorar(a, hoje=None):
    """Acrescenta os campos derivados a uma ação vinda do banco."""
    a["situacao"] = situacao_prazo(a.get("status"), a.get("prazo"), hoje)
    a["dias"] = dias_para_prazo(a.get("status"), a.get("prazo"), hoje)
    a["atrasada"] = a["situacao"] == "Atrasada"
    return a


# --------------------------------------------------------------------------
# Áreas e gestores
# --------------------------------------------------------------------------
def areas(incluir_inativas=False):
    params = {"select": "id,nome,ativo", "order": "nome.asc"}
    if not incluir_inativas:
        params["ativo"] = "is.true"
    try:
        return supa.select("acao_areas", params)
    except Exception as e:
        _falhou("areas", e)
        return []


def criar_area(nome):
    supa.insert("acao_areas", {"nome": nome.strip()})


def renomear_area(area_id, nome):
    supa.update("acao_areas", {"id": area_id}, {"nome": nome.strip()})


def definir_area_ativa(area_id, ativo):
    """Área não se apaga, se desativa: ação antiga precisa continuar dizendo
    de que área ela era."""
    supa.update("acao_areas", {"id": area_id}, {"ativo": bool(ativo)})


def gestores():
    """Gestores com nome, e-mail e as áreas de cada um."""
    try:
        vinculos = supa.select("acao_gestores", {"select": "usuario_id,area_id"})
        if not vinculos:
            return []
        ids = list({v["usuario_id"] for v in vinculos})
        usuarios = supa.select("usuarios", {
            "select": "id,nome,email", "id": f"in.({','.join(ids)})"})
        nomes_area = {a["id"]: a["nome"] for a in areas(incluir_inativas=True)}
    except Exception as e:
        _falhou("gestores", e)
        return []

    por_usuario = {}
    for v in vinculos:
        por_usuario.setdefault(v["usuario_id"], []).append(
            {"id": v["area_id"], "nome": nomes_area.get(v["area_id"], "—")})

    saida = []
    for u in usuarios:
        saida.append({
            "usuario_id": u["id"],
            "nome": u.get("nome") or u["email"].split("@")[0],
            "email": u["email"],
            "areas": sorted(por_usuario.get(u["id"], []), key=lambda a: a["nome"]),
        })
    return sorted(saida, key=lambda g: g["nome"].lower())


def areas_do_gestor(usuario_id):
    """Ids das áreas que a pessoa gerencia. Vazio = não é gestor."""
    if not usuario_id:
        return []
    try:
        linhas = supa.select("acao_gestores", {
            "select": "area_id", "usuario_id": f"eq.{usuario_id}"})
    except Exception as e:
        _falhou("areas_do_gestor", e)
        return []
    return [l["area_id"] for l in linhas]


def vincular_gestor(usuario_id, area_id):
    supa.upsert("acao_gestores", {"usuario_id": usuario_id, "area_id": area_id},
                on_conflict="usuario_id,area_id")


def desvincular_gestor(usuario_id, area_id):
    supa.delete("acao_gestores", {"usuario_id": usuario_id, "area_id": area_id})


# --------------------------------------------------------------------------
# Ações
# --------------------------------------------------------------------------
_CAMPOS = ("id,codigo,titulo,entrega_esperada,area_id,responsavel_id,data_abertura,"
           "prazo,prioridade,status,progresso,proximo_passo,data_conclusao,"
           "evidencia,observacoes,criado_por,criado_em,atualizado_em")


def _apoio_por_acao(ids):
    if not ids:
        return {}
    try:
        linhas = supa.select("acao_apoio", {
            "select": "acao_id,usuario_id", "acao_id": f"in.({','.join(ids)})"})
    except Exception as e:
        _falhou("apoio", e)
        return {}
    out = {}
    for l in linhas:
        out.setdefault(l["acao_id"], []).append(l["usuario_id"])
    return out


def listar(usuario, filtros=None):
    """Ações que `usuario` pode ver, já com os campos derivados.

    O recorte é feito AQUI, no servidor, e não escondendo na tela: ação que a
    pessoa não deve ver não chega ao browser. Mesmo princípio do recorte de
    supervisor na Produtividade.
    """
    filtros = filtros or {}
    try:
        linhas = supa.select("acoes", {"select": _CAMPOS, "order": "criado_em.desc"})
    except Exception as e:
        _falhou("listar", e)
        return []

    apoio = _apoio_por_acao([l["id"] for l in linhas])
    for l in linhas:
        l["apoio_ids"] = apoio.get(l["id"], [])

    linhas = [l for l in linhas if pode_ver(usuario, l)]

    hoje = date.today()
    linhas = [_decorar(l, hoje) for l in linhas]

    if filtros.get("responsavel"):
        alvo = filtros["responsavel"]
        linhas = [l for l in linhas
                  if l["responsavel_id"] == alvo or alvo in l["apoio_ids"]]
    if filtros.get("area"):
        linhas = [l for l in linhas if l["area_id"] == filtros["area"]]
    if filtros.get("status"):
        linhas = [l for l in linhas if l["status"] == filtros["status"]]
    if filtros.get("prioridade"):
        linhas = [l for l in linhas if l["prioridade"] == filtros["prioridade"]]
    if filtros.get("situacao"):
        linhas = [l for l in linhas if l["situacao"] == filtros["situacao"]]

    # Padrão: o que aperta primeiro. Atrasada antes de "vence em breve", e
    # dentro do mesmo grupo a prioridade decide — é a ordem em que a pauta da
    # reunião precisa ser lida.
    linhas.sort(key=lambda l: (ORDEM_SITUACAO.get(l["situacao"], 9),
                               ORDEM_PRIORIDADE.get(l["prioridade"], 9),
                               l.get("prazo") or "9999-12-31"))
    return linhas


def obter(acao_id):
    try:
        a = supa.select_one("acoes", {"select": _CAMPOS, "id": f"eq.{acao_id}"})
    except Exception as e:
        _falhou("obter", e)
        return None
    if not a:
        return None
    a["apoio_ids"] = _apoio_por_acao([a["id"]]).get(a["id"], [])
    return _decorar(a)


def criar(dados, autor_id, apoio_ids=()):
    """Cria a ação. `responsavel_id`, `titulo` e `area_id` são obrigatórios.

    Regra da planilha: "ação sem responsável não entra na pauta". Recusar aqui
    é melhor do que aceitar e deixar a ação órfã esperando alguém reparar.
    """
    if not (dados.get("titulo") or "").strip():
        raise ValueError("A ação precisa de um título.")
    if not dados.get("responsavel_id"):
        raise ValueError("Toda ação precisa de um responsável.")

    registro = {k: dados.get(k) for k in (
        "titulo", "entrega_esperada", "area_id", "responsavel_id", "prazo",
        "prioridade", "status", "proximo_passo", "observacoes") if dados.get(k)}
    registro["criado_por"] = autor_id
    criada = supa.insert("acoes", registro)
    acao = criada[0] if isinstance(criada, list) else criada

    for uid in apoio_ids:
        if uid and uid != dados.get("responsavel_id"):
            supa.upsert("acao_apoio", {"acao_id": acao["id"], "usuario_id": uid},
                        on_conflict="acao_id,usuario_id")
    return acao


def editar(acao_id, dados, apoio_ids=None):
    """Edição de gestor: os campos de definição (dono, prazo, prioridade, área)."""
    mudancas = {k: dados.get(k) for k in (
        "titulo", "entrega_esperada", "area_id", "responsavel_id", "prazo",
        "prioridade", "observacoes") if k in dados}
    mudancas["atualizado_em"] = _agora()
    supa.update("acoes", {"id": acao_id}, mudancas)

    if apoio_ids is not None:
        supa.delete("acao_apoio", {"acao_id": acao_id})
        for uid in apoio_ids:
            if uid and uid != mudancas.get("responsavel_id"):
                supa.upsert("acao_apoio", {"acao_id": acao_id, "usuario_id": uid},
                            on_conflict="acao_id,usuario_id")


def atualizar(acao_id, autor_id, texto, status=None, progresso=None,
              proximo_passo=None, evidencia=None, data_conclusao=None):
    """Atualização do responsável: move a ação E grava o evento, junto.

    As duas coisas andam juntas de propósito. Na planilha dava para mexer no
    status sem escrever uma linha no registro, e três semanas depois ninguém
    lembrava por que a ação tinha mudado. Aqui, mudar exige dizer o que houve.
    """
    atual = obter(acao_id)
    if not atual:
        raise ValueError("Ação não encontrada.")
    if not (texto or "").strip():
        raise ValueError("Escreva o que mudou — a atualização é o registro do fato.")

    novo_status = status or atual["status"]

    # Regra da planilha: "ação atrasada exige novo próximo passo e
    # escalonamento". Sem isso a atrasada seria empurrada de semana em semana
    # sem ninguém decidir nada, que é exatamente o que a regra combate.
    passo = proximo_passo if proximo_passo is not None else atual.get("proximo_passo")
    if atual["atrasada"] and novo_status not in TERMINAIS and not (passo or "").strip():
        raise ValueError("Ação atrasada exige um próximo passo definido.")

    # "Concluída precisa de data e evidência verificável." O banco também
    # recusa; falhar aqui dá mensagem melhor que violação de constraint.
    if novo_status == "Concluída":
        data_conclusao = data_conclusao or atual.get("data_conclusao") or date.today().isoformat()
        evidencia_final = evidencia or atual.get("evidencia")
        if not (evidencia_final or "").strip():
            raise ValueError("Para concluir, informe a evidência (link, documento ou referência).")
    else:
        evidencia_final = evidencia if evidencia is not None else atual.get("evidencia")
        data_conclusao = None if novo_status == "Cancelada" else atual.get("data_conclusao")

    mudancas = {
        "status": novo_status,
        "proximo_passo": passo,
        "evidencia": evidencia_final,
        "data_conclusao": data_conclusao,
        "atualizado_em": _agora(),
    }
    if progresso is not None:
        mudancas["progresso"] = max(0, min(100, int(progresso)))
    # Concluir sem alguém ter arrastado a barra é engano de digitação, não
    # intenção: 100% é a leitura correta de "concluída".
    if novo_status == "Concluída":
        mudancas["progresso"] = 100

    supa.update("acoes", {"id": acao_id}, mudancas)
    supa.insert("acao_eventos", {
        "acao_id": acao_id, "tipo": "atualizacao", "autor_id": autor_id,
        "texto": texto.strip(), "status_novo": novo_status,
        "progresso_novo": mudancas.get("progresso", atual.get("progresso")),
        "evidencia": evidencia,
    })


def comentar(acao_id, autor_id, texto, reuniao_id=None):
    """Consideração do gestor. Vai para a mesma linha do tempo da atualização."""
    if not (texto or "").strip():
        raise ValueError("Escreva o comentário.")
    supa.insert("acao_eventos", {
        "acao_id": acao_id, "tipo": "comentario", "autor_id": autor_id,
        "texto": texto.strip(), "reuniao_id": reuniao_id})


def eventos(acao_id):
    """Linha do tempo da ação — atualizações e comentários juntos, recentes
    primeiro. Estarem na mesma lista é o ponto: o comentário do gestor quase
    sempre responde a uma atualização específica."""
    try:
        return supa.select("acao_eventos", {
            "select": "id,tipo,autor_id,texto,status_novo,progresso_novo,evidencia,"
                      "reuniao_id,criado_em",
            "acao_id": f"eq.{acao_id}", "order": "criado_em.desc"})
    except Exception as e:
        _falhou("eventos", e)
        return []


def ultimos_eventos(limite=12):
    """Feed do Painel: o que andou nos últimos dias, de todas as ações."""
    try:
        return supa.select("acao_eventos", {
            "select": "id,acao_id,tipo,autor_id,texto,status_novo,progresso_novo,criado_em",
            "order": "criado_em.desc", "limit": str(limite)})
    except Exception as e:
        _falhou("ultimos_eventos", e)
        return []


# --------------------------------------------------------------------------
# Permissões
# --------------------------------------------------------------------------
def pode_ver(usuario, acao):
    """Admin vê tudo; gestor vê a área dele; os demais, o que é deles."""
    if usuario.get("is_admin"):
        return True
    uid = usuario.get("id")
    if acao.get("responsavel_id") == uid or uid in (acao.get("apoio_ids") or []):
        return True
    return acao.get("area_id") in (usuario.get("areas_gestor") or [])


def pode_gerir(usuario, acao=None):
    """Criar, editar definição e comentar. Sem `acao`, pergunta se é gestor
    de alguma coisa — é o que decide mostrar o botão "Nova ação"."""
    if usuario.get("is_admin"):
        return True
    areas_g = usuario.get("areas_gestor") or []
    if acao is None:
        return bool(areas_g)
    return acao.get("area_id") in areas_g


def pode_atualizar(usuario, acao):
    """Responsável e apoio atualizam; gestor da área também."""
    uid = usuario.get("id")
    return (acao.get("responsavel_id") == uid
            or uid in (acao.get("apoio_ids") or [])
            or pode_gerir(usuario, acao))


# --------------------------------------------------------------------------
# Painel
# --------------------------------------------------------------------------
def resumo(acoes_visiveis):
    """Os indicadores da planilha, calculados sobre o que a pessoa enxerga.

    Recebe a lista já filtrada em vez de consultar de novo: assim o Painel não
    tem como discordar da aba Ações, que é o defeito clássico de painel que
    refaz a própria consulta.
    """
    total = len(acoes_visiveis)
    por = lambda f: sum(1 for a in acoes_visiveis if f(a))
    concluidas = por(lambda a: a["status"] == "Concluída")
    return {
        "total": total,
        "concluidas": concluidas,
        "em_andamento": por(lambda a: a["status"] == "Em andamento"),
        "atrasadas": por(lambda a: a["situacao"] == "Atrasada"),
        "vence_em_breve": por(lambda a: a["situacao"] == "Vence em breve"),
        "pct_conclusao": round(concluidas / total * 100) if total else 0,
        "por_status": [{"rotulo": s, "n": por(lambda a, s=s: a["status"] == s)}
                       for s in STATUS],
        "por_prioridade": [
            {"rotulo": p,
             "n": por(lambda a, p=p: a["prioridade"] == p),
             "atrasadas": por(lambda a, p=p: a["prioridade"] == p and a["situacao"] == "Atrasada")}
            for p in PRIORIDADES],
        "por_situacao": [{"rotulo": s, "n": por(lambda a, s=s: a["situacao"] == s)}
                         for s in ORDEM_SITUACAO],
    }


# --------------------------------------------------------------------------
# Reuniões
#
# A reunião é entidade, e não só um rótulo no comentário, porque o que o gestor
# precisa recuperar depois é "o que combinamos na terça" — e isso exige saber
# quem estava, quais ações foram olhadas e o que se decidiu em cada uma.
# --------------------------------------------------------------------------
# Colunas que a migration 0006 acrescentou. O código sobe para a Vercel por
# deploy e a migration é aplicada à mão no SQL Editor — as duas coisas não
# acontecem no mesmo segundo. Se o código chegar primeiro, o PostgREST devolve
# 400 para o `select` com as colunas novas, e a lista de reuniões viraria
# "nenhuma reunião ainda": vazio apresentado como resultado, que é exatamente
# o que este projeto não faz. Então cai para o conjunto antigo e segue
# mostrando as reuniões — só sem o selo de ata, até a migration rodar.
_COLS_REUNIAO = "id,titulo,tipo,data,notas,criada_por,encerrada_em,criado_em"
_COLS_GRAVACAO = ("gravacao_status,gravacao_iniciada_em,consentimento_em,"
                  "transcricao,ata_markdown,ata_gerada_em,ata_modelo,"
                  "gravacao_interrompida,gravacao_erro")

# None = ainda não sabemos. Fica em memória do processo; na Vercel cada cold
# start reavalia, então depois da migration o selo volta sozinho.
_tem_colunas_gravacao = None


def _select_reunioes(filtro, extras):
    global _tem_colunas_gravacao
    if _tem_colunas_gravacao is not False:
        try:
            linhas = supa.select("reunioes", dict(
                filtro, select=f"{_COLS_REUNIAO},{extras}"))
            _tem_colunas_gravacao = True
            return linhas
        except Exception as e:
            _falhou("_select_reunioes (migration 0006 ainda não aplicada?)", e)
            _tem_colunas_gravacao = False
    return supa.select("reunioes", dict(filtro, select=_COLS_REUNIAO))


def listar_reunioes(usuario, limite=30):
    """Reuniões que a pessoa pode ver: gestor vê as que conduz, participante
    vê aquelas de que participou."""
    try:
        # `gravacao_status` e `ata_markdown` entram para a lista poder mostrar
        # o selo e as primeiras linhas do resumo sem abrir a reunião.
        linhas = _select_reunioes(
            {"order": "data.desc", "limit": str(limite)},
            "gravacao_status,ata_markdown,ata_gerada_em")
        if not linhas:
            return []
        ids = [l["id"] for l in linhas]
        parts = supa.select("reuniao_participantes", {
            "select": "reuniao_id,usuario_id", "reuniao_id": f"in.({','.join(ids)})"})
    except Exception as e:
        _falhou("listar_reunioes", e)
        return []

    por_reuniao = {}
    for p in parts:
        por_reuniao.setdefault(p["reuniao_id"], []).append(p["usuario_id"])

    saida = []
    for l in linhas:
        l["participantes"] = por_reuniao.get(l["id"], [])
        if (usuario.get("is_admin") or l.get("criada_por") == usuario.get("id")
                or usuario.get("id") in l["participantes"]):
            saida.append(l)
    return saida


def obter_reuniao(reuniao_id):
    try:
        achadas = _select_reunioes({"id": f"eq.{reuniao_id}"}, _COLS_GRAVACAO)
        if not achadas:
            return None
        r = achadas[0]
        r["participantes"] = [p["usuario_id"] for p in supa.select(
            "reuniao_participantes", {"select": "usuario_id",
                                      "reuniao_id": f"eq.{reuniao_id}"})]
        return r
    except Exception as e:
        _falhou("obter_reuniao", e)
        return None


def criar_reuniao(titulo, tipo, data_reuniao, participantes, criada_por):
    if not (titulo or "").strip():
        raise ValueError("Dê um título à reunião.")
    if tipo not in ("individual", "grupo"):
        raise ValueError("Tipo de reunião inválido.")
    participantes = [p for p in (participantes or []) if p]
    if not participantes:
        raise ValueError("Escolha ao menos um participante.")
    if tipo == "individual" and len(participantes) > 1:
        raise ValueError("Reunião individual tem um participante só.")

    criada = supa.insert("reunioes", {
        "titulo": titulo.strip(), "tipo": tipo,
        "data": data_reuniao or date.today().isoformat(),
        "criada_por": criada_por})
    r = criada[0] if isinstance(criada, list) else criada
    for uid in participantes:
        supa.upsert("reuniao_participantes",
                    {"reuniao_id": r["id"], "usuario_id": uid},
                    on_conflict="reuniao_id,usuario_id")
    return r


def pauta(reuniao, usuario, marcar_comentadas=True):
    """Ações dos participantes, na ordem em que precisam ser discutidas.

    A ordem não é cosmética: a regra da planilha é que ação crítica é revisada
    em toda reunião e atrasada exige escalonamento. Reunião que começa pela
    primeira da lista alfabética acaba antes de chegar no que importa.

    Concluídas e canceladas ficam de fora — a reunião é sobre o que está em
    aberto; o histórico está na ação.
    """
    alvo = set(reuniao.get("participantes") or [])
    itens = [a for a in listar(usuario)
             if (a["responsavel_id"] in alvo or alvo & set(a.get("apoio_ids") or []))
             and a["status"] not in TERMINAIS]

    # Já comentadas nesta reunião, para a tela marcar o que foi visto. Quem só
    # quer os códigos da pauta (a geração da ata) passa `marcar_comentadas=False`
    # e economiza uma ida ao banco que não muda nada no resultado dele.
    if not marcar_comentadas:
        return itens
    try:
        vistos = {e["acao_id"] for e in supa.select("acao_eventos", {
            "select": "acao_id", "reuniao_id": f"eq.{reuniao['id']}"})}
    except Exception:
        vistos = set()
    for a in itens:
        a["comentada"] = a["id"] in vistos
    return itens


def encerrar_reuniao(reuniao_id, notas=None):
    """Congela a ata. Depois disso não se comenta mais nela — o que ficou
    registrado é o que foi dito no dia, e não uma edição posterior."""
    mudancas = {"encerrada_em": _agora()}
    # Só grava `notas` se veio alguma: o campo saiu da tela, e escrever None
    # aqui apagaria a nota de reuniões antigas que tinham uma.
    if notas is not None:
        mudancas["notas"] = notas
    supa.update("reunioes", {"id": reuniao_id}, mudancas)


def excluir(acao_id):
    """Apaga uma ação que nunca teve registro nenhum.

    O histórico é append-only e ação não deve sumir da pauta — retirar de
    circulação é o status 'Cancelada'. Mas isso deixava sem saída o caso
    banal: criar por engano, duplicar, errar o título no primeiro clique.
    Cancelar um engano deixa lixo permanente na lista de todo mundo.

    A linha divisória é o primeiro evento. Sem evento, ninguém reportou nada e
    não há história para preservar — é rascunho. Com evento, houve trabalho
    registrado e aí só cabe cancelar.
    """
    if eventos(acao_id):
        raise ValueError(
            "Esta ação já tem histórico e não pode ser apagada. "
            "Para tirá-la de circulação, mude o status para Cancelada.")
    supa.delete("acao_apoio", {"acao_id": acao_id})
    supa.delete("acoes", {"id": acao_id})
