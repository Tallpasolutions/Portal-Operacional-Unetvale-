"""Supervisores e o vínculo com as equipes.

Um supervisor é um usuário comum (`public.usuarios`) marcado em
`public.supervisores` e ligado a uma ou mais equipes em
`public.supervisor_equipes`. O admin continua sendo quem o `ADMIN_EMAIL`
aponta — este módulo não mexe nisso.

O que o papel muda: o supervisor vê os números apenas das equipes dele, e não
enxerga o módulo Troca de Poste.

O alcance de um supervisor é a UNIÃO de duas formas de vínculo:

  * por EQUIPE (`supervisor_equipes`) — a empresa inteira, que é o caso comum;
  * por TÉCNICO (`supervisor_tecnicos`) — nome a nome, para quando a empresa
    não é a unidade de supervisão. A UNETVALE tem 26 técnicos repartidos entre
    supervisores diferentes, e INFRA WAVE hoje responde a dois supervisores ao
    mesmo tempo: sem vínculo por técnico, um deles enxergaria gente que não é
    dele.

`equipe` é o nome da empresa exatamente como o WVSA entrega no rótulo
"EMPRESA - Nome" (WAVE, RM, UNETVALE...). É a chave que os painéis já usam
para agrupar, então é por ela que o vínculo é feito — nada de um id novo que
teria de ser reconciliado a cada coleta.
"""
import re
import sys
import unicodedata

from . import dados, supa

# Empresas que o WVSA entrega separadas mas que são a mesma na operação.
# Fica aqui, e não em routes.py, porque a comparação do vínculo e a exibição
# no painel PRECISAM concordar: se o IQI mostra "WAVE - Fulano" e o vínculo
# guardou "WAVE SUPERVISOR - Fulano", o filtro perde o técnico em silêncio.
APELIDOS_EMPRESA = {
    "WAVE SUPERVISOR": "WAVE",
}


# Equipes de infraestrutura NÃO participam do IQI/IQM — é regra de negócio, e
# a mesma regra vale no Dashboard. Mora aqui, ao lado de APELIDOS_EMPRESA, pelo
# mesmo motivo: duas cópias divergem na primeira empresa nova e passam a contar
# populações diferentes em telas que se citam. Supervisor de infra
# legitimamente vê zero no indicador.
_INFRA = re.compile(r"\binfra\b|fandaruff", re.I)


def eh_infra(rotulo):
    return bool(_INFRA.search(rotulo or ""))


def empresa_de(rotulo):
    """Empresa a partir de "EMPRESA - Nome", já com o apelido resolvido."""
    i = (rotulo or "").find(" - ")
    if i < 0:
        return ""
    e = rotulo[:i].strip().upper()
    return APELIDOS_EMPRESA.get(e, e)


def chave_tecnico(rotulo):
    """Chave estável de comparação para um rótulo "EMPRESA - Nome".

    Maiúsculas, sem acento e com espaços colapsados. O WVSA não é consistente:
    o mesmo técnico vem como "INFRA UNET -  Mauricio Capitanio" num painel e
    com espaço simples no outro. Comparar o texto cru transformaria uma pessoa
    em duas e o vínculo simplesmente não pegaria — sem erro nenhum na tela.
    """
    if not rotulo:
        return ""
    i = rotulo.find(" - ")
    if i >= 0:
        rotulo = f"{empresa_de(rotulo)} - {rotulo[i + 3:]}"
    sem_acento = "".join(c for c in unicodedata.normalize("NFD", rotulo)
                         if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", sem_acento).strip().upper()


def _falhou(onde, erro):
    print(f"[supervisores] falha em {onde}: {erro}", file=sys.stderr)


def listar():
    """Supervisores com nome, e-mail e as equipes de cada um."""
    try:
        marcados = supa.select("supervisores", {"select": "usuario_id,criado_em"})
        if not marcados:
            return []
        ids = [m["usuario_id"] for m in marcados]
        usuarios = supa.select("usuarios", {
            "select": "id,nome,email", "id": f"in.({','.join(ids)})",
        })
        vinculos = supa.select("supervisor_equipes", {
            "select": "usuario_id,equipe", "usuario_id": f"in.({','.join(ids)})",
            "order": "equipe.asc",
        })
    except Exception as e:
        _falhou("listar", e)
        return []

    # Num try próprio de propósito: enquanto a migration 0004 não roda, esta
    # tabela não existe. Junto com o bloco acima, a falha apagaria a lista
    # inteira de supervisores da tela — o recurso novo derrubaria o antigo.
    # Assim o vínculo por equipe continua funcionando e só o avulso some.
    try:
        avulsos = supa.select("supervisor_tecnicos", {
            "select": "usuario_id,tecnico,rotulo", "usuario_id": f"in.({','.join(ids)})",
            "order": "rotulo.asc",
        })
    except Exception as e:
        _falhou("listar/tecnicos", e)
        avulsos = []

    por_usuario = {}
    for v in vinculos:
        por_usuario.setdefault(v["usuario_id"], []).append(v["equipe"])

    tecs = {}
    for a in avulsos:
        tecs.setdefault(a["usuario_id"], []).append(
            {"chave": a["tecnico"], "rotulo": a["rotulo"]})

    mapa = {u["id"]: u for u in usuarios}
    saida = []
    for m in marcados:
        u = mapa.get(m["usuario_id"])
        if not u:
            continue  # usuário removido; a FK com cascade evita, mas não custa
        saida.append({
            "usuario_id": u["id"],
            "nome": u.get("nome") or u["email"].split("@")[0],
            "email": u["email"],
            "equipes": por_usuario.get(u["id"], []),
            "tecnicos": tecs.get(u["id"], []),
        })
    return sorted(saida, key=lambda s: s["nome"].lower())


def equipes_de(usuario_id):
    """Equipes sob um supervisor. Lista vazia = ainda não tem vínculo."""
    if not usuario_id:
        return []
    try:
        linhas = supa.select("supervisor_equipes", {
            "select": "equipe", "usuario_id": f"eq.{usuario_id}", "order": "equipe.asc",
        })
    except Exception as e:
        _falhou("equipes_de", e)
        return []
    return [l["equipe"] for l in linhas]


def eh_supervisor(usuario_id):
    if not usuario_id:
        return False
    try:
        return bool(supa.select_one("supervisores", {
            "select": "usuario_id", "usuario_id": f"eq.{usuario_id}",
        }))
    except Exception as e:
        _falhou("eh_supervisor", e)
        return False


def marcar(usuario_id):
    supa.insert("supervisores", {"usuario_id": usuario_id})


def desmarcar(usuario_id):
    """Remove o papel. Os vínculos caem junto pelo `on delete cascade`."""
    supa.delete("supervisores", {"usuario_id": usuario_id})


def vincular(usuario_id, equipe):
    supa.upsert("supervisor_equipes", {"usuario_id": usuario_id, "equipe": equipe},
                on_conflict="usuario_id,equipe")


def desvincular(usuario_id, equipe):
    supa.delete("supervisor_equipes", {"usuario_id": usuario_id, "equipe": equipe})


def tecnicos_de(usuario_id):
    """Técnicos vinculados nome a nome. Lista de chaves normalizadas."""
    if not usuario_id:
        return []
    try:
        linhas = supa.select("supervisor_tecnicos", {
            "select": "tecnico", "usuario_id": f"eq.{usuario_id}",
        })
    except Exception as e:
        _falhou("tecnicos_de", e)
        return []
    return [l["tecnico"] for l in linhas]


def vincular_tecnico(usuario_id, rotulo):
    """Liga um técnico avulso. Guarda a chave normalizada e o rótulo original.

    A chave é o que o filtro compara; o rótulo é só para a tela conseguir
    mostrar o nome com acento e a grafia que o WVSA usa.
    """
    chave = chave_tecnico(rotulo)
    if not chave:
        raise ValueError("rótulo de técnico vazio")
    supa.upsert("supervisor_tecnicos",
                {"usuario_id": usuario_id, "tecnico": chave, "rotulo": rotulo},
                on_conflict="usuario_id,tecnico")


def desvincular_tecnico(usuario_id, chave):
    supa.delete("supervisor_tecnicos", {"usuario_id": usuario_id, "tecnico": chave})


def tecnicos_disponiveis():
    """Todos os técnicos conhecidos, como "EMPRESA - Nome", para o seletor.

    Junta as duas fontes porque nenhuma sozinha tem todo mundo: a
    produtividade traz 93 técnicos e o IQI 57, com 45 em comum — quem só
    aparece num dos dois ficaria fora do seletor e não teria como ser
    vinculado. Agrupado por empresa, que é como a tela precisa exibir.
    """
    rotulos = {}

    regs = ((dados.get_modulo("produtividade") or {}).get("payload") or {}).get("registros") or []
    for r in regs:
        if r.get("e") and r.get("t"):
            rotulos.setdefault(chave_tecnico(f"{r['e']} - {r['t']}"), f"{r['e']} - {r['t']}")

    for mod in ("iqi", "iqm"):
        for t in ((dados.get_modulo(mod) or {}).get("payload") or {}).get("tecnicos") or []:
            nome = t.get("nome") or ""
            if " - " in nome:
                rotulos.setdefault(chave_tecnico(nome), nome)

    por_empresa = {}
    for chave, rotulo in rotulos.items():
        por_empresa.setdefault(empresa_de(rotulo) or "(sem empresa)", []).append(
            {"chave": chave, "rotulo": rotulo, "nome": rotulo.split(" - ", 1)[-1]})
    for lista in por_empresa.values():
        lista.sort(key=lambda t: t["nome"].lower())
    return dict(sorted(por_empresa.items()))


def equipes_disponiveis():
    """Equipes que aparecem no dado real, para o select do vínculo.

    Sai do snapshot de produtividade (é onde estão todas as empresas com OS),
    e não de uma lista fixa: empresa nova entra sozinha, empresa que saiu
    some. Se o snapshot não estiver disponível, devolve vazio em vez de uma
    lista inventada.
    """
    row = dados.get_modulo("produtividade")
    registros = ((row or {}).get("payload") or {}).get("registros") or []
    return sorted({r.get("e") for r in registros if r.get("e")})
