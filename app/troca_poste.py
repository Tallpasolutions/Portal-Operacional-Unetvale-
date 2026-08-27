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
import struct
import sys
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

_CAMPOS = (
    "id,bairro,endereco_raw,tipo_via_extenso,logradouro,numero_inicio,numero_fim,"
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
        "bairro": row.get("bairro"),
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


def _aplicar_filtros(linhas, cidade=None, bairro=None, risco=None):
    out = linhas
    if cidade:
        out = [l for l in out if l["cidade"] == cidade]
    if bairro:
        out = [l for l in out if l["bairro"] == bairro]
    if risco:
        out = [l for l in out if l["classificacao"] == risco]
    return out


def visao(de=None, ate=None, cidade=None, bairro=None, risco=None, incluir_passados=False):
    """Payload da tela: KPIs, tabela, e as opções de filtro DO PERÍODO.

    As opções de cidade/bairro são calculadas antes do filtro correspondente —
    a lista de cidades não pode ser restringida pela cidade já escolhida, senão
    o usuário fica preso na primeira seleção.
    """
    todas = listar(de, ate, incluir_passados)

    # Cidades disponíveis: ignora o filtro de cidade, respeita os demais.
    base_cidades = _aplicar_filtros(todas, bairro=None, risco=risco)
    cidades = {}
    for l in base_cidades:
        c = cidades.setdefault(l["cidade"], {"cidade": l["cidade"], "total": 0, "critico": 0})
        c["total"] += 1
        if l["classificacao"] == "critico":
            c["critico"] += 1
    lista_cidades = sorted(cidades.values(), key=lambda c: (-c["critico"], -c["total"]))

    # Cidade escolhida que não existe no período: a tela avisa em vez de mostrar
    # tabela vazia sem explicação.
    cidade_valida = (not cidade) or any(c["cidade"] == cidade for c in lista_cidades)
    if not cidade_valida:
        cidade = None

    bairros = []
    if cidade:
        base_bairros = _aplicar_filtros(todas, cidade=cidade, risco=risco)
        cont = {}
        for l in base_bairros:
            if l["bairro"]:
                cont[l["bairro"]] = cont.get(l["bairro"], 0) + 1
        bairros = [{"bairro": b, "total": n}
                   for b, n in sorted(cont.items(), key=lambda kv: (-kv[1], kv[0]))]

    linhas = _aplicar_filtros(todas, cidade, bairro, risco)

    kpis = {"total": len(linhas)}
    for r in ORDEM_RISCO:
        kpis[r] = sum(1 for l in linhas if l["classificacao"] == r)
    kpis["cidades"] = len({l["cidade"] for l in linhas})
    futuros = [l["data"] for l in linhas if l["data"] and l["data"] >= hoje().isoformat()]
    if futuros:
        ano, mes, dia = min(futuros).split("-")
        kpis["proximo"] = f"{dia}/{mes}"
    else:
        kpis["proximo"] = None

    return {
        "kpis": kpis,
        "linhas": linhas,
        "cidades": lista_cidades,
        "bairros": bairros,
        "cidade_valida": cidade_valida,
        "rotulos_risco": ROTULO_RISCO,
    }


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
        "select": "desligamento_id,score,validacao,metodo,dispersao_m,providers_ok,"
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
        out.append({
            "id": r["desligamento_id"],
            "cidade": (d.get("cidades") or {}).get("nome") or "—",
            "bairro": d.get("bairro"),
            "endereco": d.get("endereco_raw") or "",
            "data_br": "/".join(reversed((d.get("data_evento") or "").split("-"))),
            "score": r.get("score"),
            "metodo": r.get("metodo"),
            "dispersao": r.get("dispersao_m"),
            "providers_ok": r.get("providers_ok"),
            "providers_consultados": r.get("providers_consultados"),
            "evidencias": r.get("evidencias") or {},
        })
    return out


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
    return rows


def ordens(limite=50):
    """Ordens de serviço geradas a partir dos desligamentos.

    Enquanto o envio real não for liberado, `status` fica em `rascunho` e
    `dry_run` em `true` — nenhuma OS chega ao WVSA.
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
