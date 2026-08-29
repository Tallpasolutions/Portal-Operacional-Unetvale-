"""Camada de dados do módulo Dashboard (visão gerencial).

Lê os cinco payloads que o coletor grava em `dados_modulo` e as duas tabelas
próprias do módulo, e devolve um pacote pronto para o template. Nenhum cálculo
de negócio acontece no browser: o que a tela mostra veio daqui.

O app NUNCA fala com o WVSA — quem coleta é `coletor/gerencial.py`, dentro da
rede Unetvale.
"""
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from . import dados, supa, supervisores

BR_TZ = timezone(timedelta(hours=-3))

MODULOS = ("ger_categorias", "ger_cancelamentos", "ger_esteira",
           "ger_idf", "ger_salas")

# O CMT é este grupo de motivo de cancelamento. Mesma constante do coletor —
# aqui ela serve só para encurtar o rótulo na tela.
GRUPO_TECNICO = "PROBLEMA TECNICO"

# Ordem dos campos dentro do registro compacto de `ger_categorias`. Espelha
# `CAMPOS` do coletor; o payload também carrega a lista, e é ela que vale.
CAMPOS_PADRAO = ("tecnico", "cat1", "cat2", "cat3", "cat4", "cat5", "cidade")
LISTAS = {"tecnico": "tec", "cat1": "c1", "cat2": "c2", "cat3": "c3",
          "cat4": "c4", "cat5": "c5", "cidade": "cid"}

# Quantos meses o par "fechado × corrente" mostra, quando não há preferência.
MESES_VISIVEIS_PADRAO = 2


def _agora():
    """UTC com fuso explícito — ver a armadilha do `datetime.now()` no CLAUDE.md."""
    return datetime.now(timezone.utc)


# ==========================================================================
# Leitura
# ==========================================================================
def _payloads():
    """Os cinco módulos numa requisição só.

    Cinco `get_modulo()` seriam cinco idas ao PostgREST na mesma requisição, e
    numa função serverless isso aparece no tempo de resposta.
    """
    try:
        linhas = supa.select("dados_modulo", {
            "select": "modulo,payload,atualizado_em,status",
            "modulo": f"in.({','.join(MODULOS)})",
        })
    except Exception:
        return {}
    return {l["modulo"]: l for l in linhas}


def metas():
    """{chave: {valor, direcao, rotulo}}.

    Tolera a tabela ainda não existir: deploy e migration não acontecem no
    mesmo segundo, e sem isto a tela inteira quebraria por causa da linha que
    só decora um número. Sem meta, o card mostra o valor e omite o "vs meta".
    """
    try:
        linhas = supa.select("dashboard_metas",
                             {"select": "chave,valor,direcao,rotulo"})
    except Exception:
        return {}
    return {l["chave"]: l for l in linhas}


def config():
    """Preferências de exibição. Tolera a tabela ainda não existir."""
    try:
        linhas = supa.select("dashboard_config", {"select": "chave,valor"})
    except Exception:
        return {}
    return {l["chave"]: l["valor"] for l in linhas}


def salvar_config(chave, valor):
    return supa.upsert("dashboard_config",
                       {"chave": chave, "valor": str(valor),
                        "atualizado_em": _agora().isoformat()},
                       on_conflict="chave")


def meses_visiveis(cfg=None):
    """Quantos meses os cards comparam. Nunca menos de 1.

    O coletor guarda de janeiro até hoje; isto é só o recorte da TELA. Valor
    inválido no banco cai no padrão em vez de derrubar a página — é
    preferência de exibição, não deve poder quebrar o Dashboard.
    """
    bruto = (cfg if cfg is not None else config()).get("meses_visiveis")
    try:
        return max(1, int(bruto))
    except (TypeError, ValueError):
        return MESES_VISIVEIS_PADRAO


def salvar_meta(chave, valor, direcao="menor", rotulo=None):
    """Grava/atualiza uma meta. Valor vazio volta a ser 'não definida'."""
    registro = {
        "chave": chave,
        "valor": None if valor in ("", None) else float(valor),
        "direcao": direcao if direcao in ("menor", "maior") else "menor",
        "atualizado_em": _agora().isoformat(),
    }
    if rotulo:
        registro["rotulo"] = rotulo
    return supa.upsert("dashboard_metas", registro, on_conflict="chave")


def _vs_meta(valor, chave, mapa):
    """Compara com a meta, se houver. Devolve None quando não há.

    None é resposta legítima e a tela precisa distinguir: "não há meta" não é
    "está na meta".
    """
    m = mapa.get(chave) or {}
    alvo = m.get("valor")
    if alvo is None or valor is None:
        return None
    alvo = float(alvo)
    dentro = valor <= alvo if m.get("direcao", "menor") == "menor" else valor >= alvo
    return {"alvo": alvo, "dentro": dentro,
            "diferenca": round(valor - alvo, 2), "direcao": m.get("direcao", "menor")}


# ==========================================================================
# Qualidade: IQI/IQM consolidado, mês a mês
# ==========================================================================
def _consolidado_mensal(payload):
    """% consolidado por mês: reincidências ÷ OSs, e não média dos percentuais.

    A diferença importa e é a mesma já adotada na visão "Por empresa" do
    /iqi: média de percentual daria o mesmo peso a quem fez 11 OSs e a quem
    fez 60.

    Infraestrutura fica de fora — regra de negócio do indicador, centralizada
    em `supervisores.eh_infra`.
    """
    if not payload or not payload.get("meses"):
        return []
    meses = payload["meses"]
    os_mes = [0] * len(meses)
    ch_mes = [0] * len(meses)
    for t in payload.get("tecnicos", []):
        if supervisores.eh_infra(t.get("nome", "")):
            continue
        for i, linha in enumerate(t.get("m", [])):
            if i >= len(meses):
                break
            os_mes[i] += linha[0] or 0
            ch_mes[i] += linha[1] or 0
    saida = []
    for i, mes in enumerate(meses):
        pct = round(ch_mes[i] / os_mes[i] * 100, 2) if os_mes[i] else None
        saida.append({"mes": mes, "os": os_mes[i], "chamados": ch_mes[i], "pct": pct})
    return saida


def qualidade(mapa_metas, quantos=MESES_VISIVEIS_PADRAO):
    """IQI e IQM: série mensal completa + os N meses que a tela compara."""
    saida = {}
    for modulo, rotulo, chave in (("iqi", "IQI", "iqi"), ("iqm", "IQM", "iqm")):
        row = dados.get_modulo(modulo)
        serie = _consolidado_mensal((row or {}).get("payload"))
        visiveis = _ultimos(serie, quantos)
        for i, d in enumerate(visiveis):
            # Só o ÚLTIMO mês é parcial; os anteriores estão fechados. É a
            # mesma leitura que a tabela mensal do /iqi já faz, e o motivo é a
            # janela de reincidência ainda aberta: o mês corrente só piora até
            # fechar. Chamar o corrente de fechado faria a tela comemorar um
            # número que ainda vai subir.
            d["parcial"] = (i == len(visiveis) - 1)
            d["vs_meta"] = _vs_meta(d.get("pct"), chave, mapa_metas)
        saida[rotulo] = {
            "serie": serie,
            "visiveis": visiveis,
            "meta": (mapa_metas.get(chave) or {}).get("valor"),
        }
    return saida


def _ultimos(serie, quantos):
    """Os N últimos itens, como cópias (a tela anota `parcial` e `vs_meta`)."""
    return [dict(d) for d in (serie or [])[-max(1, quantos):]]


# ==========================================================================
# Esteira: quanto entrou e quanto saiu desde a abertura do dia
# ==========================================================================
def movimento_esteira(hoje=None):
    """Diferença entre a primeira foto do dia e a mais recente.

    Compara CONJUNTOS de OS, não contagens: "5 entraram e 5 saíram" e "nada
    aconteceu" deixam o total igual, e é o primeiro caso que a operação quer
    ver. Por isso o snapshot guarda os números das OS.
    """
    hoje = hoje or datetime.now(BR_TZ).date()
    try:
        linhas = supa.select("dashboard_esteira_snapshot", {
            "select": "capturado_em,abertura,total,oss",
            "dia": f"eq.{hoje.isoformat()}",
            "order": "capturado_em.asc",
        })
    except Exception:
        return None
    if not linhas:
        return None

    abertura = next((l for l in linhas if l.get("abertura")), linhas[0])
    atual = linhas[-1]
    if atual["capturado_em"] == abertura["capturado_em"]:
        return {"tem_comparacao": False, "capturas": len(linhas),
                "abertura_total": abertura["total"], "total": abertura["total"],
                "entraram": 0, "sairam": 0, "saldo": 0,
                "abertura_em": _hora(abertura["capturado_em"]),
                "atual_em": _hora(abertura["capturado_em"])}

    ini = set(abertura.get("oss") or [])
    fim = set(atual.get("oss") or [])
    return {
        "tem_comparacao": True,
        "capturas": len(linhas),
        "abertura_total": abertura["total"],
        "total": atual["total"],
        "entraram": len(fim - ini),
        "sairam": len(ini - fim),
        "saldo": atual["total"] - abertura["total"],
        "abertura_em": _hora(abertura["capturado_em"]),
        "atual_em": _hora(atual["capturado_em"]),
    }


def _hora(iso):
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00")).astimezone(BR_TZ).strftime("%H:%M")
    except Exception:
        return "—"


# ==========================================================================
# Categorias: registros compactos -> contagens
# ==========================================================================
def agregar_categorias(cat, indicador, meses):
    """Conta cada categoria nos meses pedidos, a partir dos registros.

    O coletor guarda linha a linha (com o técnico) porque a tela do /iqi
    filtra por empresa e por supervisor. Aqui, para os cards do Dashboard,
    a contagem é feita na hora — são poucos milhares de registros.
    """
    campos = cat.get("campos") or list(CAMPOS_PADRAO)
    pos = {c: i for i, c in enumerate(campos)}
    listas = {c: (cat.get(LISTAS.get(c, "")) or []) for c in campos}
    blocos = cat.get(indicador) or {}

    contas = {c: Counter() for c in campos}
    total = 0
    for mes in meses:
        for reg in blocos.get(mes) or []:
            total += 1
            for campo, i in pos.items():
                if i < len(reg) and reg[i] >= 0 and reg[i] < len(listas[campo]):
                    contas[campo][listas[campo][reg[i]]] += 1
    saida = {"total": total}
    for campo, cont in contas.items():
        saida[campo] = dict(cont.most_common())
    return saida


# ==========================================================================
# Cancelamentos
# ==========================================================================
def cancelamentos(payload, mapa_metas, quantos=MESES_VISIVEIS_PADRAO):
    """CMT = cancelamentos do grupo PROBLEMA TECNICO ÷ cancelamentos válidos."""
    blocos = (payload or {}).get("meses_dados") or {}
    meses = sorted(blocos)
    if not meses:
        return {"meses": [], "visiveis": [], "serie": []}

    def resumo(mes, parcial):
        d = blocos[mes]
        total = d.get("total") or 0
        tec = d.get("tecnico") or 0
        pct = round(tec / total * 100, 2) if total else None
        return {
            "mes": mes, "parcial": parcial, "total": total, "tecnico": tec, "pct": pct,
            "valor": d.get("valor") or 0, "valor_tecnico": d.get("valor_tecnico") or 0,
            "vs_meta": _vs_meta(pct, "cmt", mapa_metas),
            # Só os motivos do grupo técnico — o detalhe do CMT, e o que a
            # operação consegue atacar. O recorte vem do próprio relatório
            # (ver `_motivos_do_grupo_tecnico` no coletor): filtrar por texto
            # aqui traria motivos de fora do grupo e a soma deixaria de bater
            # com o percentual mostrado logo acima.
            "motivos_tecnicos": _sem_prefixo_do_grupo(d.get("motivos_tecnicos") or {}),
            "grupos": d.get("grupos") or {},
            "cidades": d.get("cidades") or {},
            "tempo_casa": d.get("tempo_casa") or {},
            "tempo_contrato": d.get("tempo_contrato") or {},
            "faixa_ticket": d.get("faixa_ticket") or {},
            "motivos": d.get("motivos") or {},
        }

    escolhidos = meses[-max(1, quantos):]
    return {
        "meses": meses,
        "visiveis": [resumo(m, m == meses[-1]) for m in escolhidos],
        "serie": [{"mes": m, "total": blocos[m].get("total") or 0,
                   "tecnico": blocos[m].get("tecnico") or 0,
                   "pct": round((blocos[m].get("tecnico") or 0) /
                                (blocos[m].get("total") or 1) * 100, 2)}
                  for m in meses],
    }


def _sem_prefixo_do_grupo(motivos):
    """Tira o "PROBLEMA TECNICO" repetido do início de cada motivo.

    Os quatro motivos do grupo começam com o nome do grupo, e o que distingue
    um do outro vem no FIM ("…/HISTORICO DE OS", "… / SEM HISTORICO"). Numa
    lista estreita todos truncavam no mesmo ponto e o card virava quatro
    linhas idênticas com números diferentes. O card já diz que são motivos
    técnicos; repetir isso em cada linha custava justamente a informação.

    O texto restante fica como o WVSA escreve, sem recapitalizar: "IPTV" e
    "TV" viram lixo em qualquer title-case automático.
    """
    corte = len(GRUPO_TECNICO)
    saida = {}
    for rotulo, v in motivos.items():
        curto = rotulo
        if rotulo.upper().startswith(GRUPO_TECNICO):
            curto = rotulo[corte:].lstrip(" /-").strip() or rotulo
        saida[curto if curto not in saida else rotulo] = v
    return saida


# ==========================================================================
# Pacote da tela
# ==========================================================================
def pacote():
    p = _payloads()
    mapa = metas()
    cfg = config()
    quantos = meses_visiveis(cfg)

    def payload(m):
        return (p.get(m) or {}).get("payload") or {}

    cat = payload("ger_categorias")
    esteira = payload("ger_esteira")
    salas = payload("ger_salas")
    idf = payload("ger_idf")

    meses_cat = cat.get("meses") or []
    visiveis_cat = meses_cat[-max(1, quantos):]

    idf_blocos = idf.get("meses_dados") or {}
    idf_meses = sorted(idf_blocos)
    idf_visiveis = idf_meses[-max(1, quantos):]

    return {
        "meses_visiveis": quantos,
        "qualidade": qualidade(mapa, quantos),
        "causa_raiz": {
            "meses": meses_cat,
            "visiveis": visiveis_cat,
            # Agregado aqui e não no browser: o Dashboard mostra o consolidado,
            # sem filtro por equipe. Quem precisa cruzar com empresa e
            # supervisor usa a visualização "Causa raiz" do /iqi, que recebe
            # os registros e filtra no cliente.
            "IQI": {m: agregar_categorias(cat, "IQI", [m]) for m in visiveis_cat},
            "IQM": {m: agregar_categorias(cat, "IQM", [m]) for m in visiveis_cat},
        },
        "cancelamentos": cancelamentos(payload("ger_cancelamentos"), mapa, quantos),
        "esteira": {
            **esteira,
            "movimento": movimento_esteira(),
            "vs_meta_util": _vs_meta(esteira.get("util"), "esteira_util", mapa),
            "vs_meta_retiradas": _vs_meta(esteira.get("retiradas"), "retiradas", mapa),
        },
        "idf": {
            "meses": idf_meses,
            "visiveis": [{"mes": m, "parcial": m == idf_meses[-1], **idf_blocos[m]}
                         for m in idf_visiveis],
            "serie": [{"mes": m, **idf_blocos[m]} for m in idf_meses],
            "metas": {c: (mapa.get(f"idf_{c}") or {}).get("valor")
                      for c in ("ligacoes", "chats", "os")},
        },
        "salas": {**salas, "vs_meta": _vs_meta(salas.get("abertas"), "disk", mapa)},
        "metas": mapa,
        "estado": {m: {"status": (p.get(m) or {}).get("status") or "sem_dados",
                       "atualizado_em": (p.get(m) or {}).get("atualizado_em")}
                   for m in MODULOS},
    }


def causa_raiz():
    """Registros compactos de Cat 1..5, para a visualização dentro do /iqi.

    Vai CRU para o cliente — com o técnico em cada registro — porque aquela
    tela cruza empresa, supervisor e mês ao mesmo tempo. Agregar aqui exigiria
    uma contagem por combinação de filtro, ou tirar o filtro da tela.
    """
    cat = ((_payloads().get("ger_categorias") or {}).get("payload")) or {}
    if not cat:
        return {"meses": [], "campos": list(CAMPOS_PADRAO)}
    return {k: cat.get(k) for k in
            ("meses", "campos", "IQI", "IQM", *LISTAS.values()) if cat.get(k) is not None}
