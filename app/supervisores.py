"""Supervisores e o vínculo com as equipes.

Um supervisor é um usuário comum (`public.usuarios`) marcado em
`public.supervisores` e ligado a uma ou mais equipes em
`public.supervisor_equipes`. O admin continua sendo quem o `ADMIN_EMAIL`
aponta — este módulo não mexe nisso.

O que o papel muda: o supervisor vê os números apenas das equipes dele, e não
enxerga o módulo Troca de Poste.

`equipe` é o nome da empresa exatamente como o WVSA entrega no rótulo
"EMPRESA - Nome" (WAVE, RM, UNETVALE...). É a chave que os painéis já usam
para agrupar, então é por ela que o vínculo é feito — nada de um id novo que
teria de ser reconciliado a cada coleta.
"""
import sys

from . import dados, supa


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

    por_usuario = {}
    for v in vinculos:
        por_usuario.setdefault(v["usuario_id"], []).append(v["equipe"])

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
