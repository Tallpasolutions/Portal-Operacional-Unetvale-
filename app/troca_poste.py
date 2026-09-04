"""Módulo Troca de Poste: desligamentos programados da Celesc cruzados com a
rede óptica da Unetvale.

De onde vem o dado: schema `troca_poste` no mesmo Supabase, alimentado por um
pipeline próprio (coleta na Celesc -> geocodificação por consenso -> espelho da
rede via Geogrid -> match em PostGIS). Aqui só se LÊ — nenhuma rota deste
arquivo escreve, calcula distância ou decide classificação.

Por que agregar em Python e não no banco: são poucas centenas de linhas por
recorte (o universo inteiro hoje são 356). Uma requisição ao PostgREST com os
relacionamentos embutidos sai mais barata que criar views e mantê-las em
sincronia, e não exige DDL novo em produção.
"""
import os
import struct
import sys
import unicodedata
from datetime import datetime, timedelta, timezone

from . import supa


def _falhou(onde, erro):
    """Registra a falha antes de devolver vazio.

    A tela não pode derrubar o portal inteiro por causa de um módulo, mas
    devolver lista vazia calada faz "erro de código" parecer "não há dado" —
    foi assim que uma coluna inexistente passou despercebida aqui. O print vai
    para o log da função na Vercel.
    """
    print(f"[troca_poste] falha em {onde}: {erro}", file=sys.stderr)

SCHEMA = "troca_poste"
BR_TZ = timezone(timedelta(hours=-3))

# Ordem de gravidade. `indeterminado` fica no meio de propósito: não é "sem
# risco", é "não sabemos" — a posição não foi confirmada e o sistema se recusa
# a classificar em cima de palpite.
ORDEM_RISCO = ["critico", "alto", "medio", "indeterminado", "baixo", "sem_rede"]

ROTULO_RISCO = {
    "critico": "Crítico",
    "alto": "Alto",
    "medio": "Médio",
    "baixo": "Baixo",
    "sem_rede": "Sem rede",
    "indeterminado": "Indeterminado",
}

# Desligamento que a Celesc parou de listar vira `desapareceu` e some das telas,
# mas continua no banco para auditoria.
STATUS_OCULTOS = ("desapareceu", "expirado")

# O tipo de serviço que a Celesc informa. A coluna `causa` vem com o texto cru
# ("- PROG. - ALTERAÇÃO PARA AMPLIAÇÃO"); o pipeline já a classifica em
# `causa_categoria`, e é por ela que se filtra — o texto cru muda de pontuação
# entre avisos e faria o filtro perder linha sem erro na tela.
ROTULO_CAUSA = {
    "alteracao_ampliacao": "Alteração para ampliação",
    "alteracao_melhoria": "Alteração para melhoria",
    "manutencao_preventiva": "Manutenção preventiva",
    "manutencao_corretiva": "Manutenção corretiva",
    "servico_comercial": "Serviço comercial / outros",
}

_CAMPOS = (
    "id,cidade_id,bairro,bairro_wvsa_id,endereco_raw,tipo_via_extenso,"
    "logradouro,numero_inicio,numero_fim,"
    "data_evento,hora_inicio,hora_fim,causa,causa_categoria,status,"
    "cidades(nome),"
    "analise_rede(classificacao,dist_cabo_m,dist_poste_m,qtd_postes,qtd_caixas,"
    "cabos_siglas,postes_siglas,clientes_estimados),"
    "desligamento_geo(score,validacao,metodo,geom)"
)


def hoje():
    return datetime.now(BR_TZ).date()


def periodo_padrao():
    """Hoje até +7 dias.

    O módulo existe para decidir se manda equipe junto num desligamento que
    ainda VAI acontecer; sem recorte a tela mistura passado e futuro e fica
    ilegível.
    """
    h = hoje()
    return h.isoformat(), (h + timedelta(days=7)).isoformat()


def _ponto(ewkb_hex):
    """Extrai (lat, lon) de um POINT em EWKB hexadecimal.

    O PostgREST devolve `geography` como EWKB hex, não como GeoJSON. Decodificar
    aqui evita criar view só para expor duas colunas — e são 10 linhas: byte de
    ordem, tipo (com o bit de SRID), SRID opcional e dois doubles.

    Devolve None para qualquer coisa que não seja um ponto: o mapa então
    simplesmente não plota, em vez de plotar no lugar errado.
    """
    if not ewkb_hex:
        return None
    try:
        b = bytes.fromhex(ewkb_hex)
        ordem = "<" if b[0] == 1 else ">"
        tipo, = struct.unpack_from(ordem + "I", b, 1)
        deslocamento = 5 + (4 if tipo & 0x20000000 else 0)
        if (tipo & 0xFF) != 1:
            return None
        x, y = struct.unpack_from(ordem + "dd", b, deslocamento)
        return round(y, 6), round(x, 6)
    except Exception:
        return None


# O PostgREST tem teto próprio de linhas por resposta (1000 no padrão do
# Supabase) e o ignora silenciosamente se `limit` pedir mais. Para a malha isso
# é grave: um mapa com metade dos cabos faz alguém concluir "não tem fibra
# aqui". Buscamos por páginas até a resposta vir menor que a página.
PAGINA = 1000


def _select_paginado(tabela, params, teto):
    linhas = []
    while len(linhas) < teto:
        p = dict(params)
        p["limit"] = str(min(PAGINA, teto - len(linhas)))
        p["offset"] = str(len(linhas))
        lote = supa.select(tabela, p, schema=SCHEMA)
        linhas.extend(lote)
        if len(lote) < int(p["limit"]):
            break
    return linhas


def _linha_geom(ewkb_hex, maximo=400):
    """Extrai [(lat, lon), ...] de um LINESTRING em EWKB hexadecimal.

    Mesma razão do `_ponto`: o PostgREST devolve `geography` como EWKB hex, e
    decodificar aqui evita criar view só para expor a geometria.

    Formato: ordem de byte, tipo (com bit de SRID), SRID, nº de pontos, e então
    os pares de doubles. `maximo` é uma trava de sanidade — cabo com mais
    pontos que isso é dado corrompido, não cabo.
    """
    if not ewkb_hex:
        return None
    try:
        b = bytes.fromhex(ewkb_hex)
        ordem = "<" if b[0] == 1 else ">"
        tipo, = struct.unpack_from(ordem + "I", b, 1)
        deslocamento = 5 + (4 if tipo & 0x20000000 else 0)
        if (tipo & 0xFF) != 2:
            return None
        n, = struct.unpack_from(ordem + "I", b, deslocamento)
        if not 1 < n <= maximo:
            return None
        deslocamento += 4
        coords = struct.unpack_from(ordem + f"{n * 2}d", b, deslocamento)
        return [(round(coords[i + 1], 6), round(coords[i], 6)) for i in range(0, len(coords), 2)]
    except Exception:
        return None


def _hhmm(valor):
    return valor[:5] if valor else None


def _linha(row):
    """Achata o registro do PostgREST no formato que o template consome."""
    analise = row.get("analise_rede") or {}
    geo = row.get("desligamento_geo") or {}
    cidade = (row.get("cidades") or {}).get("nome") or "—"
    classificacao = analise.get("classificacao") or "indeterminado"
    coord = _ponto(geo.get("geom"))
    return {
        "lat": coord[0] if coord else None,
        "lon": coord[1] if coord else None,
        "id": row["id"],
        "cidade": cidade,
        # `cidade_id` e `bairro_wvsa_id` não aparecem na tela: servem ao
        # agrupamento e ao campo `bairro` do formulário do WVSA, que ia vazio.
        "cidade_id": row.get("cidade_id"),
        "bairro": row.get("bairro"),
        "bairro_wvsa_id": row.get("bairro_wvsa_id"),
        "endereco": row.get("endereco_raw") or "",
        "tipo_via": row.get("tipo_via_extenso") or "",
        "logradouro": row.get("logradouro") or "",
        "numero_inicio": row.get("numero_inicio"),
        "numero_fim": row.get("numero_fim"),
        "data": row.get("data_evento"),
        "data_br": "/".join(reversed((row.get("data_evento") or "").split("-"))),
        "hora_inicio": _hhmm(row.get("hora_inicio")),
        "hora_fim": _hhmm(row.get("hora_fim")),
        "causa": row.get("causa"),
        "causa_categoria": row.get("causa_categoria"),
        "classificacao": classificacao,
        "risco_rotulo": ROTULO_RISCO.get(classificacao, classificacao),
        "dist_cabo": analise.get("dist_cabo_m"),
        "dist_poste": analise.get("dist_poste_m"),
        "qtd_postes": analise.get("qtd_postes"),
        "cabos": analise.get("cabos_siglas") or [],
        "clientes": analise.get("clientes_estimados"),
        "geo_score": geo.get("score"),
        "geo_validacao": geo.get("validacao"),
    }


def listar(de=None, ate=None, incluir_passados=False, limite=2000):
    """Desligamentos ativos no intervalo, já achatados e ordenados por risco."""
    params = {
        "select": _CAMPOS,
        "status": f"not.in.({','.join(STATUS_OCULTOS)})",
        "order": "data_evento.asc",
        "limit": str(limite),
    }
    if de:
        params["data_evento"] = f"gte.{de}"
    elif not incluir_passados:
        params["data_evento"] = f"gte.{hoje().isoformat()}"
    if ate:
        # PostgREST aceita o mesmo parâmetro duas vezes só via `and=`; com um
        # intervalo é mais simples e legível usar a forma explícita.
        params["and"] = f"(data_evento.gte.{de or hoje().isoformat()},data_evento.lte.{ate})"
        params.pop("data_evento", None)

    try:
        rows = supa.select("desligamentos", params, schema=SCHEMA)
    except Exception as e:
        _falhou("listar", e)
        return []

    linhas = [_linha(r) for r in rows]
    linhas.sort(key=lambda l: (ORDEM_RISCO.index(l["classificacao"])
                               if l["classificacao"] in ORDEM_RISCO else 99, l["data"] or ""))
    return linhas


def _norm(txt):
    """MAIÚSCULO, sem acento, espaços colapsados.

    Espelha `troca_poste.normalizar_texto` do banco, e serve **só** para montar
    os grupos da tela. A chave de verdade — a que vira `chave_idempotencia` — é
    calculada em SQL, dentro de `criar_os_bairro_dia`, com a definição do
    próprio Postgres.

    Duas definições da mesma regra normalmente é armadilha (§6 do CLAUDE.md),
    mas aqui a divergência é contida: se as duas discordarem, a tela mostra dois
    grupos que o banco reconhece como um, e o segundo clique recebe
    `ja_existia` em vez de criar OS duplicada. Não normalizar seria pior — "Centro"
    e "CENTRO" no mesmo dia virariam dois deslocamentos.
    """
    if not txt:
        return ""
    base = unicodedata.normalize("NFD", str(txt)).upper()
    return " ".join("".join(c for c in base
                            if unicodedata.category(c) != "Mn").split())


def agrupar(linhas):
    """Junta os desligamentos em grupos de (cidade, bairro, dia).

    É como a Celesc publica e como a equipe se desloca: o mesmo bairro sai
    fatiado em várias ruas no mesmo dia, e ir lá é uma viagem só. Uma OS por
    rua faria a operação abrir quatro chamados para o mesmo deslocamento.

    O grupo herda o PIOR risco dos seus trechos: um grupo com um trecho crítico
    é um grupo crítico, ainda que os outros três sejam "sem rede".
    """
    grupos = {}
    for l in linhas:
        chave = f"{l.get('cidade_id') or l['cidade']}|{_norm(l.get('bairro'))}|{l.get('data') or ''}"
        # A chave fica CARIMBADA na linha. A tabela de Desligamentos agrupa por
        # ela em vez de recalcular no JS: um terceiro normalizador de bairro
        # (Python, SQL e JS) divergiria, e o grupo perderia trecho sem erro na
        # tela — a armadilha do `APELIDOS_EMPRESA` (CLAUDE.md §6).
        l["grupo_chave"] = chave
        g = grupos.get(chave)
        if not g:
            g = grupos[chave] = {
                "chave": chave,
                "cidade": l["cidade"],
                "cidade_id": l.get("cidade_id"),
                "bairro": l.get("bairro"),
                "data": l.get("data"),
                "data_br": l.get("data_br"),
                "itens": [],
            }
        g["itens"].append(l)

    saida = []
    for g in grupos.values():
        itens = g["itens"]
        pior = min((i["classificacao"] for i in itens),
                   key=lambda c: ORDEM_RISCO.index(c) if c in ORDEM_RISCO else 99)
        inicios = [i["hora_inicio"] for i in itens if i.get("hora_inicio")]
        fins = [i["hora_fim"] for i in itens if i.get("hora_fim")]
        saida.append({**g,
                      "ids": [i["id"] for i in itens],
                      # O grupo carrega TODAS as categorias dos seus trechos: o
                      # filtro mostra o grupo se qualquer trecho casar, senão
                      # filtrar por "serviço comercial" esconderia o bairro em
                      # que ele acontece junto de uma manutenção.
                      "causas": sorted({i["causa_categoria"] for i in itens
                                        if i.get("causa_categoria")}),
                      "qtd": len(itens),
                      "classificacao": pior,
                      "risco_rotulo": ROTULO_RISCO.get(pior, pior),
                      "hora_inicio": min(inicios) if inicios else None,
                      "hora_fim": max(fins) if fins else None})

    saida.sort(key=lambda g: (ORDEM_RISCO.index(g["classificacao"])
                              if g["classificacao"] in ORDEM_RISCO else 99,
                              g["data"] or "", g["cidade"], g["bairro"] or ""))
    return saida


# Acima de tantas cidades os postes não vêm: são ~7,3 mil no total e
# respondem pela maior parte do payload, e só ficam visíveis no zoom 15+ —
# onde já se está olhando uma cidade só. Puxar todos para uma visão de 11
# cidades custa segundos numa função serverless sem nada em troca.
MAX_CIDADES_COM_POSTES = 3


def rede(cidades=None, limite_cabos=5000, limite_postes=9000):
    """Malha óptica das cidades pedidas: cabos (LineString) e postes alugados.

    Carregada sob demanda pelo mapa, e só para as cidades do recorte — a malha
    inteira são ~665 kB, e não faz sentido baixar Navegantes para olhar um
    desligamento em Tijucas.

    Só postes com `status='alugado'`: são os que a Unetvale de fato usa, e
    portanto os que importam quando a Celesc vai trocar um poste.

    Devolve também quantos cabos ficaram DE FORA por não terem geometria no
    Geogrid. Isso vai para a legenda: um mapa que omite parte da malha em
    silêncio faz alguém concluir "não temos fibra aqui" — que é justamente o
    erro caro deste domínio.
    """
    filtro_cidade = {}
    if cidades:
        try:
            linhas = supa.select("cidades", {"select": "id,nome"}, schema=SCHEMA)
        except Exception as e:
            _falhou("rede/cidades", e)
            return {"cabos": [], "postes": [], "cabos_sem_geometria": 0,
                    "postes_omitidos": False, "max_cidades_com_postes": MAX_CIDADES_COM_POSTES}
        ids = [c["id"] for c in linhas if c["nome"] in cidades]
        if not ids:
            return {"cabos": [], "postes": [], "cabos_sem_geometria": 0,
                    "postes_omitidos": False, "max_cidades_com_postes": MAX_CIDADES_COM_POSTES}
        filtro_cidade = {"cidade_id": f"in.({','.join(ids)})"}

    cabos = []
    cabos_sem_geometria = 0
    try:
        params = {
            "select": "sigla,tipo_nome,fibras,eh_cabo_externo,geom",
            "order": "id_geogrid.asc",  # ordem estável: sem ela o offset repete/pula linhas
        }
        params.update(filtro_cidade)
        for r in _select_paginado("rede_cabos", params, limite_cabos):
            coords = _linha_geom(r.get("geom"))
            if not coords:
                cabos_sem_geometria += 1
                continue
            cabos.append({
                "sigla": r.get("sigla"),
                "tipo": r.get("tipo_nome"),
                "fibras": r.get("fibras"),
                "externo": r.get("eh_cabo_externo"),
                "coords": coords,
            })
    except Exception as e:
        _falhou("rede/cabos", e)

    postes = []
    postes_omitidos = not cidades or len(cidades) > MAX_CIDADES_COM_POSTES
    try:
        if postes_omitidos:
            raise StopIteration
        params = {
            "select": "sigla,status,geom",
            "item": "eq.poste",
            "status": "eq.alugado",
            "geom": "not.is.null",
            "order": "id_geogrid.asc",
        }
        params.update(filtro_cidade)
        for r in _select_paginado("rede_itens", params, limite_postes):
            ponto = _ponto(r.get("geom"))
            if not ponto:
                continue
            postes.append({"sigla": r.get("sigla"), "lat": ponto[0], "lon": ponto[1]})
    except StopIteration:
        pass
    except Exception as e:
        _falhou("rede/postes", e)

    return {
        "cabos": cabos,
        "postes": postes,
        "cabos_sem_geometria": cabos_sem_geometria,
        # A tela precisa saber a diferença entre "não há poste alugado aqui" e
        # "não busquei os postes" — senão o mapa mente por omissão.
        "postes_omitidos": postes_omitidos,
        "max_cidades_com_postes": MAX_CIDADES_COM_POSTES,
    }


def fila_revisao(limite=200):
    """Desligamentos cuja posição não atingiu o score mínimo.

    São os que o sistema se recusa a classificar sozinho: sem posição confiável,
    decidir sobre rede seria palpite. Ficam aqui para uma pessoa confirmar.
    """
    params = {
        "select": "desligamento_id,geom,score,validacao,metodo,dispersao_m,providers_ok,"
                  "providers_consultados,evidencias,"
                  "desligamentos(id,endereco_raw,bairro,data_evento,logradouro,"
                  "tipo_via_extenso,numero_inicio,numero_fim,status,cidades(nome))",
        "validacao": "eq.revisar",
        "order": "score.desc",
        "limit": str(limite),
    }
    try:
        rows = supa.select("desligamento_geo", params, schema=SCHEMA)
    except Exception as e:
        _falhou("fila_revisao", e)
        return []

    out = []
    for r in rows:
        d = r.get("desligamentos") or {}
        if d.get("status") in STATUS_OCULTOS:
            continue
        # A coordenada SUGERIDA vai junto: é dela que o revisor parte no mapa.
        # Sem ela ele teria que procurar o endereço do zero, e o trabalho de
        # confirmar um ponto que o sistema já achou viraria o de achá-lo.
        coord = _ponto(r.get("geom"))
        ev = r.get("evidencias") or {}
        out.append({
            "id": r["desligamento_id"],
            "cidade": (d.get("cidades") or {}).get("nome") or "—",
            "bairro": d.get("bairro"),
            "endereco": d.get("endereco_raw") or "",
            "logradouro": " ".join(x for x in [d.get("tipo_via_extenso"),
                                               d.get("logradouro")] if x),
            "data_br": "/".join(reversed((d.get("data_evento") or "").split("-"))),
            "lat": coord[0] if coord else None,
            "lon": coord[1] if coord else None,
            "score": r.get("score"),
            "metodo": r.get("metodo"),
            "dispersao": r.get("dispersao_m"),
            "providers_ok": r.get("providers_ok"),
            "providers_consultados": r.get("providers_consultados"),
            # Por que ESTA linha caiu na fila. "Score baixo" e "coordenada
            # igual à de outra rua" pedem julgamentos diferentes do revisor.
            "colapso": bool(ev.get("colapso_detectado")),
            "motivo": ev.get("motivo_revisao"),
            "evidencias": ev,
        })
    return out


def aplicar_revisao(desligamento_id, usuario_id, lat=None, lon=None, reprovar=False):
    """Grava a decisão do revisor. Uma requisição, três efeitos.

    Quem faz o trabalho é `troca_poste.aplicar_revisao` no banco (migration
    0012): posição, alias e recálculo do match acontecem na mesma transação.
    Ver o comentário da função para o porquê de não serem três chamadas daqui.

    Devolve a classificação recalculada — a tela precisa dizer o que mudou, e
    o payload da página é anterior ao match.
    """
    return supa.rpc("aplicar_revisao", {
        "p_desligamento_id": desligamento_id,
        "p_lat": lat,
        "p_lng": lon,
        "p_usuario": usuario_id,
        "p_reprovar": bool(reprovar),
    }, schema=SCHEMA)


# Os campos que o operador escolhe ao abrir a OS. `agendamento` fica de fora:
# a lista do WVSA cobre poucos dias e muda ao longo do dia (23 slots em 3 dias,
# medido em 04/09/2026), enquanto a OS é aberta para a data do desligamento,
# semanas à frente — o slot ainda não existe. É campo opcional lá.
TIPOS_CATALOGO = ("executor", "tipo_tecnico", "periodo", "tecnico")


def catalogos():
    """Opções dos campos da OS, copiadas do formulário do WVSA.

    Quem preenche `wvsa_catalogos` é o `coletor/enviar_os.py`, que roda dentro
    da rede: as listas vivem no formulário, num IP privado que a Vercel não
    alcança. Aqui só se lê.

    Os técnicos vêm agrupados por empresa porque o rótulo do WVSA já traz o
    prefixo ("INFRA UNET - Fulano") e são 34 numa lista só. O rótulo vai
    INTEIRO para a tela: há nome repetido em empresas diferentes (Ueliton
    Patriqui Nicoletti é 522 na INFRA WAVE e 661 na WAVE), e cortar o prefixo
    transformaria a escolha em adivinhação.
    """
    vazio = {t: [] for t in TIPOS_CATALOGO}
    vazio["tecnicos_por_empresa"] = []
    try:
        linhas = supa.select("wvsa_catalogos", {
            "select": "tipo,valor,rotulo",
            "tipo": f"in.({','.join(TIPOS_CATALOGO)})",
            "ativo": "is.true",
            "order": "tipo.asc,rotulo.asc",
        }, schema=SCHEMA)
    except Exception as e:
        _falhou("catalogos", e)
        return vazio

    saida = {t: [] for t in TIPOS_CATALOGO}
    for l in linhas:
        saida.setdefault(l["tipo"], []).append({"valor": l["valor"], "rotulo": l["rotulo"]})

    empresas = {}
    for t in saida.get("tecnico", []):
        rotulo = t["rotulo"]
        # "INFRA UNET - Fulano" -> empresa "INFRA UNET". Sem hífen, o técnico
        # não tem empresa no cadastro do WVSA; agrupá-lo como "Sem empresa" é
        # mais honesto que inventar uma.
        empresa = rotulo.rsplit(" - ", 1)[0].strip() if " - " in rotulo else "Sem empresa"
        empresas.setdefault(empresa, []).append(t)
    saida["tecnicos_por_empresa"] = [
        {"empresa": e, "tecnicos": ts}
        for e, ts in sorted(empresas.items(), key=lambda kv: (kv[0] == "Sem empresa", kv[0]))
    ]
    return saida


def dry_run():
    """O envio é ensaio? Ligado por padrão.

    O ensaio percorre o clique inteiro — fila, payload, tudo — e para antes da
    requisição ao WVSA. Existe porque um POST em `/relatorios/infra10/save`
    cria OS de verdade e desloca equipe, e esse caminho nunca rodou ponta a
    ponta. São dois interruptores separados de propósito:
    `OS_ENVIO_HABILITADO` faz o botão aparecer, `OS_DRY_RUN=false` faz a OS
    sair. Um interruptor só faria a liberação do botão liberar o envio junto.
    """
    return os.environ.get("OS_DRY_RUN", "true").strip().lower() != "false"


def criar_rascunho_grupo(desligamento_ids, usuario_id, solicitacao, executor,
                         periodo=None, tipo_tecnico=None, agendamento=None,
                         tecnico_ids=None):
    """Grava o rascunho da OS de um bairro/dia — **sem enviar nada**.

    Toda a operação (validar o grupo, encontrar ou criar o agrupamento
    `bairro_dia`, gravar os itens e a ordem) acontece dentro de
    `troca_poste.criar_os_bairro_dia`, numa transação só. O porquê está no
    comentário daquela função — em resumo: a chave do grupo tem que sair do
    `normalizar_texto` do banco, e três requisições sem transação deixam
    agrupamento órfão quando a última falha.

    A ordem nasce `status='rascunho'`, `origem='sistema'`. A constraint
    `os_envio_exige_clique_humano` impede que esse registro chegue a 'criada'
    sem passar pelo clique de envio.
    """
    ids = [i for i in (desligamento_ids or []) if i]
    if not ids:
        raise ValueError("nenhum desligamento informado")

    return supa.rpc("criar_os_bairro_dia", {
        "p_desligamento_ids": ids,
        "p_usuario": usuario_id,
        "p_solicitacao": solicitacao,
        "p_executor": executor,
        "p_periodo": periodo or None,
        "p_tipo_tecnico": tipo_tecnico or None,
        "p_agendamento": agendamento or None,
        # Lista vazia vira NULL na função: gravar `{}` diria que houve escolha
        # de equipe quando não houve.
        "p_tecnico_ids": [str(t) for t in (tecnico_ids or []) if str(t).strip()] or None,
        "p_dry_run": dry_run(),
    }, schema=SCHEMA)


def marcar_para_envio(ordem_id, usuario_id):
    """Passa a ordem para 'pronta' com o clique humano registrado.

    É este registro — `origem='clique_usuario'` mais `enviado_por` — que
    autoriza o envio. O processo dentro da VPN só pega ordem nesse estado, e o
    Postgres recusaria 'criada' sem ele.

    Só promove rascunho, ensaio ou ordem que falhou: reenviar algo já 'criada'
    ou 'enviando' duplicaria OS no WVSA. `ensaio` entra na lista porque é
    exatamente o caminho previsto — conferir o payload sem enviar e, depois de
    `OS_DRY_RUN=false`, clicar de novo para valer.
    """
    atual = supa.select_one("ordens_servico", {
        "select": "id,status", "id": f"eq.{ordem_id}",
    }, schema=SCHEMA)
    if not atual:
        raise ValueError("ordem não encontrada")
    if atual["status"] not in ("rascunho", "ensaio", "erro"):
        raise ValueError(f"ordem está em '{atual['status']}' — não pode ser reenviada")

    supa.update("ordens_servico", {"id": ordem_id}, {
        "status": "pronta", "origem": "clique_usuario",
        "enviado_por": usuario_id, "erro": None,
    }, schema=SCHEMA)


def ordem(ordem_id):
    """Estado de uma ordem — a tela faz poll aqui depois de mandar enviar."""
    return supa.select_one("ordens_servico", {
        "select": "id,status,wvsa_os_numero,erro,tentativas,enviado_em,solicitacao,dry_run",
        "id": f"eq.{ordem_id}",
    }, schema=SCHEMA)


# Por quanto tempo uma linha `executando` ainda é plausível, em minutos.
#
# A linha em `troca_poste.coletas` cobre só a PRIMEIRA etapa (`tp:coletar`);
# quem a fecha é o `gravarColeta`, no fim dela. O cão de guarda do
# `coletor/coletar_celesc.sh` derruba a etapa em `LIMITE_ETAPA` (20 min), então
# 30 min é o teto com folga — passou disso, o processo morreu sem conseguir
# fechar a linha.
COLETA_EXECUTANDO_MAX_MIN = 30


def _status_exibicao(status, iniciado_em):
    """Traduz o status cru da coleta para o que a tela deve dizer.

    Existe por causa de 02/09/2026: o Mac dormiu logo depois do dark wake que
    disparou o job das 07h, a rodada morreu com `read EADDRNOTAVAIL` e a linha
    ficou **`executando` para sempre** — a tela anunciava uma coleta em curso
    que não tinha processo nenhum atrás. `abrirColeta` insere `executando` e só
    `gravarColeta` troca para `ok`/`parcial`/`erro`; morrendo no meio, ninguém
    toca na linha.

    O coletor agora marca `erro` ao morrer (ver `cli.ts` no monorepo), mas isso
    **não** cobre o caso que gerou o problema: quando a rede é justamente o que
    falhou, o UPDATE de socorro falha junto. Só o leitor pode desconfiar de uma
    coleta que começou há horas e nunca terminou — e é o leitor que está aqui.
    """
    if status != "executando" or not iniciado_em:
        return status
    try:
        dt = datetime.fromisoformat(iniciado_em.replace("Z", "+00:00"))
    except Exception:
        return status
    minutos = (datetime.now(timezone.utc) - dt).total_seconds() / 60
    return "interrompida" if minutos > COLETA_EXECUTANDO_MAX_MIN else status


def coletas(limite=30):
    """Histórico das coletas na Celesc."""
    try:
        rows = supa.select("coletas", {
            "select": "id,fonte,iniciado_em,finalizado_em,status,cidades_alvo,cidades_ok,"
                      "cidades_erro,total_eventos,novos,alterados,desapareceram,"
                      "duracao_ms,erro",
            "order": "iniciado_em.desc", "limit": str(limite),
        }, schema=SCHEMA)
    except Exception as e:
        _falhou("coletas", e)
        return []

    for r in rows:
        for campo, destino in (("iniciado_em", "inicio_br"), ("finalizado_em", "fim_br")):
            valor = r.get(campo)
            if valor:
                try:
                    dt = datetime.fromisoformat(valor.replace("Z", "+00:00"))
                    r[destino] = dt.astimezone(BR_TZ).strftime("%d/%m/%Y %H:%M")
                except Exception:
                    r[destino] = "—"
            else:
                r[destino] = "—"
        # `status` segue cru (é o que está no banco); a tela lê `status_exibicao`.
        r["status_exibicao"] = _status_exibicao(r.get("status"), r.get("iniciado_em"))
    return rows


def ordens(limite=50):
    """Ordens de serviço geradas a partir dos desligamentos.

    Uma por bairro/dia. Com `OS_DRY_RUN=true` a ordem para em `ensaio`: o
    payload foi montado e conferido, e nenhuma OS chegou ao WVSA.
    """
    try:
        return supa.select("ordens_servico", {
            "select": "id,status,origem,dry_run,wvsa_os_numero,agendamento,executor,"
                      "periodo,data_inicio,data_fim,solicitacao,criado_em,erro",
            "order": "criado_em.desc", "limit": str(limite),
        }, schema=SCHEMA)
    except Exception as e:
        _falhou("ordens", e)
        return []


# Limiar de frescor da coleta da Celesc, em minutos. É próprio, e não os 180
# min dos módulos do WVSA: a Celesc roda DUAS vezes ao dia (07h e 13h, ver
# `coletor/net.unetvale.troca-poste.plist`), não de 2 em 2 horas. Aplicar o
# limiar do WVSA aqui deixaria o card vermelho todas as noites por construção —
# e selo que acende sem motivo é selo que a equipe aprende a ignorar.
FRESCOR_MIN = 26 * 60


def resumo_coleta():
    """Card de frescor da coleta da Celesc, no mesmo formato de
    `dados.resumo_modulos()`, para entrar na mesma grade do /monitoramento.

    Mora aqui, e não em `dados.py`, porque a Troca de Poste não vive em
    `dados_modulo` — e `dados.MODULOS` não pode crescer: aquela tupla é também
    o whitelist do `/api/ingest` e a chave primária daquela tabela.

    Sem este card, uma coleta parada aparecia só como linha antiga no histórico,
    com badge verde `ok`. Foi assim que a Celesc ficou 5 dias sem coletar sem
    ninguém notar.
    """
    vazio = {"modulo": "troca_poste", "nome": "Troca de Poste · Celesc",
             "atualizado": "—", "idade": "—", "status": "sem_dados",
             "desatualizado": False, "na_fila": False}
    try:
        row = supa.select_one("coletas", {
            "select": "finalizado_em,status",
            "status": "in.(ok,parcial)",
            "order": "finalizado_em.desc", "limit": "1",
        }, schema=SCHEMA)
    except Exception as e:
        _falhou("resumo_coleta", e)
        return vazio
    if not row or not row.get("finalizado_em"):
        return vazio
    try:
        dt = datetime.fromisoformat(row["finalizado_em"].replace("Z", "+00:00"))
    except Exception:
        return vazio
    minutos = int((datetime.now(timezone.utc) - dt).total_seconds() // 60)
    if minutos < 60:
        idade = f"há {minutos} min"
    elif minutos < 60 * 36:
        idade = f"há {minutos // 60} h"
    else:
        idade = f"há {minutos // (60 * 24)} d"
    return {**vazio,
            "atualizado": dt.astimezone(BR_TZ).strftime("%d/%m/%Y %H:%M"),
            "idade": idade,
            "status": "ok" if row.get("status") == "ok" else "parcial",
            "desatualizado": minutos > FRESCOR_MIN}


def ultima_coleta():
    """Data/hora da coleta mais recente concluída, para o subtítulo da tela."""
    try:
        row = supa.select_one("coletas", {
            "select": "finalizado_em",
            "status": "in.(ok,parcial)",
            "order": "finalizado_em.desc", "limit": "1",
        }, schema=SCHEMA)
    except Exception as e:
        _falhou("ultima_coleta", e)
        return None
    if not row or not row.get("finalizado_em"):
        return None
    try:
        dt = datetime.fromisoformat(row["finalizado_em"].replace("Z", "+00:00"))
        return dt.astimezone(BR_TZ).strftime("%d/%m/%Y %H:%M")
    except Exception:
        return None
