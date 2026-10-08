"""Rotas das páginas: dashboard inicial + os 3 módulos + usuários + config.

Cada página de módulo injeta o payload (JSON vindo do Supabase) no template;
o cross-filter e os gráficos rodam no cliente (sem round-trip por clique).
"""
import os
import re
import sys
from datetime import datetime, timezone

from flask import (
    Blueprint, abort, flash, jsonify, redirect, render_template, request,
    session, url_for
)

from . import (acoes, auth, supa, dados, gerencial, reuniao_ia, solicitacao,
               supervisores, troca_poste as tp)
from .auth import (login_obrigatorio, admin_obrigatorio, modulo_obrigatorio,
                   usuario_atual)

bp = Blueprint("dash", __name__)


def _status_coleta():
    """Status da coleta para a topbar, uma vez por requisição.

    As rotas que mostram a topbar o pedem junto com as próprias leituras
    (`supa.paralelo`); quem não pede paga a ida só se o template ler.
    """
    from flask import g
    if not hasattr(g, "_status_coleta"):
        try:
            g._status_coleta = dados.status_geral()
        except Exception:
            g._status_coleta = {"tem_dados": False, "ultima": "—", "status": "sem_dados",
                                "proxima": "—", "horarios": dados.HORARIOS}
    return g._status_coleta


class _StatusPreguicoso:
    """O status da coleta, consultado só quando o template LÊ um campo dele.

    Antes a consulta saía em toda página, inclusive nas que nem mostram o
    status (Ações e Reuniões têm `sem_sync=True`). Assim, quem não lê não paga
    a ida ao banco, e quem lê paga uma vez só.
    """

    def _carregar(self):
        return _status_coleta()

    def __getattr__(self, nome):
        if nome.startswith("_"):
            raise AttributeError(nome)
        try:
            return self._carregar()[nome]
        except KeyError:
            raise AttributeError(nome)

    def __getitem__(self, nome):
        return self._carregar()[nome]


@bp.app_context_processor
def injeta_status():
    """Disponibiliza o status de atualização e o usuário em todos os templates."""
    # O fragmento do painel lateral de Ações não tem topbar nem lê o usuário
    # do contexto: recebe da rota o que precisa.
    if request.endpoint == "dash.acao_painel":
        return {}
    return {"status_upd": _StatusPreguicoso(), "usuario": usuario_atual()}


# Endpoint de cada módulo, na ordem da sidebar. Serve para a raiz saber para
# onde mandar quem não tem o Dashboard liberado.
_ENDPOINT_MODULO = {
    "dashboard": "dash.dashboard", "produtividade": "dash.produtividade",
    "iqi": "dash.iqi", "massivas": "dash.massivas",
    "troca-poste": "dash.troca_poste", "acoes": "dash.acoes_view",
    "processos": "dash.processos_view",
}


def _primeira_tela(u):
    """Para onde mandar esta pessoa ao entrar.

    O Dashboard é a abertura do dia, mas ele passou a ser um módulo que o admin
    pode esconder. Sem isto, quem não o tivesse liberado cairia num 404 logo
    depois de digitar a senha — e sem nenhum módulo, Configurações é a única
    tela que sempre existe (é onde se troca a própria senha).
    """
    for modulo in _ENDPOINT_MODULO:
        if modulo in u["modulos_visiveis"]:
            return url_for(_ENDPOINT_MODULO[modulo])
    return url_for("dash.configuracoes")


@bp.route("/")
@login_obrigatorio
def home():
    # Sem tela inicial própria: a raiz cai no Dashboard, que é a primeira
    # entrada da sidebar e a leitura de abertura do dia — ou no primeiro módulo
    # que a pessoa de fato enxerga.
    return redirect(_primeira_tela(usuario_atual()))


@bp.route("/dashboard")
@login_obrigatorio
@modulo_obrigatorio("dashboard")
def dashboard():
    """Visão gerencial: qualidade, causa raiz, churn, esteira e atendimento.

    Página única, sem sub-abas: a leitura gerencial é a soma dos blocos, e
    separá-los obrigaria a trocar de tela para relacionar reincidência com
    cancelamento — que é justamente a relação que interessa.
    """
    u = usuario_atual()
    pac, sups, _ = supa.paralelo(gerencial.pacote,
                                 lambda: _supervisores_para_filtro(u), _status_coleta)
    return render_template("dashboard.html", ativo="dashboard",
                           pacote=pac, supervisores=sups,
                           apelidos_empresa=supervisores.APELIDOS_EMPRESA)


@bp.route("/produtividade")
@login_obrigatorio
@modulo_obrigatorio("produtividade")
def produtividade():
    u = usuario_atual()
    row, sups, _ = supa.paralelo(lambda: dados.get_modulo("produtividade"),
                                 lambda: _supervisores_para_filtro(u), _status_coleta)
    payload = (row or {}).get("payload") or {"registros": [], "total": 0}
    # Supervisor só enxerga as próprias equipes: o recorte é aplicado no
    # servidor, não escondendo no cliente — dado que não deve ser visto não
    # chega ao browser.
    if u["is_supervisor"] and not u["is_admin"]:
        # Equipes inteiras MAIS técnicos avulsos: as duas formas de vínculo se
        # somam. Olhar só as equipes esconderia do supervisor justamente quem
        # foi vinculado nome a nome porque a empresa não é dele inteira.
        minhas = set(supervisores.equipes_de(u["id"]))
        meus = set(supervisores.tecnicos_de(u["id"]))

        def _dele(r):
            return (r.get("e") in minhas
                    or supervisores.chave_tecnico(f"{r.get('e')} - {r.get('t')}") in meus)

        p2 = dict(payload)
        p2["registros"] = [r for r in payload.get("registros", []) if _dele(r)]
        p2["total"] = len(p2["registros"])
        payload = p2
    return render_template("produtividade.html", ativo="produtividade", payload=payload,
                           meta=_meta(row), supervisores=sups,
                           apelidos_empresa=supervisores.APELIDOS_EMPRESA)


@bp.route("/iqi")
@login_obrigatorio
@modulo_obrigatorio("iqi")
def iqi():
    u = usuario_atual()
    iqi_row, iqm_row, causa, sups, _ = supa.paralelo(
        lambda: dados.get_modulo("iqi"), lambda: dados.get_modulo("iqm"),
        gerencial.causa_raiz, lambda: _supervisores_para_filtro(u), _status_coleta)
    pacote = {}
    if iqi_row and iqi_row.get("payload"):
        pacote["IQI"] = supervisores.so_operacional(iqi_row["payload"])
    if iqm_row and iqm_row.get("payload"):
        pacote["IQM"] = supervisores.so_operacional(iqm_row["payload"])
    return render_template("iqi.html", ativo="iqi", pacote=pacote,
                           causa_raiz=causa,
                           meta=_meta(iqi_row or iqm_row),
                           supervisores=sups,
                           apelidos_empresa=supervisores.APELIDOS_EMPRESA)


@bp.route("/massivas")
@login_obrigatorio
@modulo_obrigatorio("massivas")
def massivas():
    row, _ = supa.paralelo(lambda: dados.get_modulo("massivas"), _status_coleta)
    payload = (row or {}).get("payload") or {"meses": [], "metricas": [], "diario": [], "cidades": [], "totais_mes": []}
    return render_template("massivas.html", ativo="massivas", payload=payload,
                           meta=_meta(row))


@bp.route("/troca-poste")
@login_obrigatorio
@modulo_obrigatorio("troca-poste")
def troca_poste():
    """Desligamentos da Celesc cruzados com a rede óptica.

    Segue o padrão das outras telas: injeta o pacote e o cliente cuida de
    filtro, gráficos e abas — sem round-trip por clique. O período padrão é
    hoje..+7 dias, porque a pergunta do módulo é sobre o que ainda VAI
    acontecer; o filtro permite abrir a janela.

    Para trás, a janela é do SERVIDOR (`?de=&ate=`): o pacote padrão só tem
    de hoje em diante, e o De/Até filtrando no cliente mostrava tabela vazia
    para qualquer data passada — o histórico estava no banco e nunca chegava
    à página. A tela recarrega com o período quando ele sai do que veio.
    """
    de, ate = tp.periodo_padrao()
    pedido_de, pedido_ate = tp.periodo_pedido(request.args.get("de"),
                                              request.args.get("ate"))
    linhas = tp.listar(de=pedido_de, ate=pedido_ate) if pedido_de else tp.listar()
    hoje = tp.hoje().isoformat()
    # Antes do pacote: `agrupar` carimba `grupo_chave` em cada linha, e é dela
    # que a tabela de Desligamentos monta os grupos.
    grupos = tp.agrupar(linhas)
    # Cada grupo passa a saber se JÁ tem OS. A tela usa isso para tirá-lo dos
    # candidatos — o botão não pode continuar convidando ao clique.
    ja_aberta = tp.ordens_por_desligamento()
    for g in grupos:
        g["ordem"] = next((ja_aberta[i] for i in g["ids"] if i in ja_aberta), None)
    pacote = {
        "linhas": linhas,
        # A OS é do bairro/dia, então o script também é: o operador lê o texto
        # do GRUPO antes de clicar, não um texto por rua que ninguém enviaria.
        # `itens` NÃO vai no pacote: ele repetia `linhas` inteiro dentro dos
        # grupos — 209 kB de 719 kB, 29% da página, para um dado que o cliente
        # já tem. O grupo carrega os `ids`, e a tela monta a lista por eles.
        # Grupo do passado não vira OS, então não leva script: num mês de
        # histórico são ~200 textos que ninguém vai enviar.
        "grupos": [{**{k: v for k, v in g.items() if k != "itens"},
                    "script_os": (solicitacao.montar(g["itens"])
                                  if (g["data"] or "") >= hoje else None)}
                   for g in grupos],
        "revisao": tp.fila_revisao(),
        "ordens": tp.ordens(),
        "rotulos_risco": tp.ROTULO_RISCO,
        "rotulos_causa": tp.ROTULO_CAUSA,
        "ordem_risco": tp.ORDEM_RISCO,
        "ultima_coleta": tp.ultima_coleta(),
        "hoje": hoje,
        "padrao": {"de": de, "ate": ate},
        # O que o servidor MANDOU. Sem pedido é "de hoje, sem fim"; o cliente
        # compara o De/Até com isto para saber se precisa recarregar.
        "carregado": {"de": pedido_de or hoje, "ate": pedido_ate},
        "pedido": {"de": pedido_de, "ate": pedido_ate} if pedido_de else None,
        "envio_os_habilitado": _envio_os_habilitado(),
        "envio_os_ensaio": tp.dry_run(),
        "catalogos": tp.catalogos(),
    }
    return render_template("troca-poste.html", ativo="troca-poste", pacote=pacote)


@bp.route("/troca-poste/os", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("troca-poste")
def troca_poste_criar_os():
    """Cria o RASCUNHO da OS de um bairro/dia. Não envia nada.

    Recebe a lista de desligamentos do grupo. Quem prova que eles são mesmo do
    mesmo bairro, cidade e dia é o banco (`criar_os_bairro_dia`) — o cliente
    manda ids, e id vindo do browser não é evidência de nada.
    """
    corpo = request.get_json(silent=True) or {}
    ids = corpo.get("desligamento_ids")
    # Um id solto continua valendo: é o grupo de um trecho.
    if not ids and corpo.get("desligamento_id"):
        ids = [corpo["desligamento_id"]]
    ids = [str(i).strip() for i in (ids or []) if str(i or "").strip()]
    executor = (corpo.get("executor") or "infra").strip()
    if not ids:
        return jsonify({"erro": "nenhum desligamento informado"}), 400

    # Busca SÓ os ids pedidos. Listar a tabela inteira e procurar neles
    # esbarrava no corte de 1000 linhas do PostgREST, que caía sobre os
    # desligamentos mais novos — exatamente os que se abre OS.
    conhecidas = {l["id"]: l for l in tp.listar(incluir_passados=True, ids=ids)}
    faltando = [i for i in ids if i not in conhecidas]
    if faltando:
        return jsonify({"erro": "desligamento não encontrado"}), 404
    # O histórico agora chega à tela; a OS continua sendo de obra que ainda
    # vai acontecer. A recusa é aqui, e não só no botão.
    if any((conhecidas[i]["data"] or "") < tp.hoje().isoformat() for i in ids):
        return jsonify({"erro": "o desligamento já aconteceu"}), 400

    try:
        ordem = tp.criar_rascunho_grupo(
            desligamento_ids=ids,
            usuario_id=session.get("uid"),
            solicitacao=corpo.get("solicitacao")
                        or solicitacao.montar([conhecidas[i] for i in ids]),
            executor=executor,
            periodo=corpo.get("periodo"),
            tipo_tecnico=corpo.get("tipo_tecnico"),
            agendamento=corpo.get("agendamento"),
            tecnico_ids=corpo.get("tecnico_ids"),
        )
    except ValueError as e:
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        # "não são do mesmo bairro, cidade e dia" é a função recusando um grupo
        # misturado — entrada ruim, não falha do servidor.
        if "mesmo bairro" in str(e):
            return jsonify({"erro": "os desligamentos não são do mesmo bairro, cidade e dia"}), 400
        return jsonify({"erro": str(e)}), 500
    return jsonify(ordem)


def _envio_os_habilitado():
    """O envio de OS ao WVSA está liberado?

    Desligado por padrão. O fluxo existe e a tela mostra tudo, mas o envio em
    si não foi testado de ponta a ponta contra o WVSA — e um clique cria OS
    real e desloca equipe. Ligar é decisão explícita, feita no ambiente
    (`OS_ENVIO_HABILITADO=true`), não uma mudança de código.

    A recusa fica AQUI, no servidor, e não só no botão: desabilitar no cliente
    impede o clique acidental, não uma requisição forjada.
    """
    return os.environ.get("OS_ENVIO_HABILITADO", "").strip().lower() == "true"


@bp.route("/troca-poste/os/<ordem_id>/enviar", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("troca-poste")
def troca_poste_enviar_os(ordem_id):
    """Autoriza o envio: marca o clique humano e devolve na hora.

    O POST no WVSA NÃO acontece aqui — a Vercel não alcança a rede interna
    onde o WVSA responde. Quem envia é o processo `enviar_os.py`, rodando
    dentro da VPN, que observa esta fila. A tela acompanha por poll.
    """
    if not _envio_os_habilitado():
        return jsonify({
            "erro": "O envio de OS ao WVSA está desligado.",
            "detalhe": "O fluxo ainda não foi validado ponta a ponta. "
                       "Para liberar, defina OS_ENVIO_HABILITADO=true no ambiente.",
        }), 503
    try:
        tp.marcar_para_envio(ordem_id, session.get("uid"))
    except ValueError as e:
        return jsonify({"erro": str(e)}), 409
    except Exception as e:
        return jsonify({"erro": str(e)}), 500
    return jsonify({"ok": True, "status": "pronta"})


@bp.route("/troca-poste/os/<ordem_id>")
@login_obrigatorio
@modulo_obrigatorio("troca-poste")
def troca_poste_status_os(ordem_id):
    """Estado da ordem — a tela faz poll aqui enquanto o envio acontece."""
    o = tp.ordem(ordem_id)
    if not o:
        return jsonify({"erro": "ordem não encontrada"}), 404
    return jsonify(o)


# Retângulo de sanidade: Santa Catarina, com folga. As 11 cidades monitoradas
# ficam todas no litoral/vale do Itajaí. Não é precisão cartográfica — é para
# um dedo escorregando no mapa, ou um corpo forjado, não gravar um ponto no
# meio do Atlântico como se fosse revisão humana com score 100.
_SC_LAT = (-30.0, -25.0)
_SC_LON = (-54.5, -48.0)


@bp.route("/troca-poste/revisao/<deslig_id>", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("troca-poste")
def troca_poste_revisar(deslig_id):
    """Registra a decisão do revisor sobre a posição de um desligamento.

    Três desfechos, todos por clique humano: confirmar o ponto sugerido,
    corrigi-lo arrastando o pino, ou reprovar ("não dá para posicionar").
    Confirmar e corrigir gravam o alias — é o que faz o mesmo endereço nascer
    resolvido na próxima coleta, em vez de voltar para a fila.
    """
    corpo = request.get_json(silent=True) or {}
    reprovar = bool(corpo.get("reprovar"))

    lat = lon = None
    if not reprovar:
        try:
            lat = float(corpo.get("lat"))
            lon = float(corpo.get("lon"))
        except (TypeError, ValueError):
            return jsonify({"erro": "coordenada ausente ou inválida"}), 400
        if not (_SC_LAT[0] <= lat <= _SC_LAT[1] and _SC_LON[0] <= lon <= _SC_LON[1]):
            return jsonify({"erro": "coordenada fora de Santa Catarina"}), 400

    # Existência conferida ANTES da chamada: id inexistente é erro de entrada,
    # e depender de reconhecer a mensagem de exceção do Postgres para devolver
    # 404 faria qualquer mudança de texto virar um 500.
    if not any(i["id"] == deslig_id for i in tp.fila_revisao(limite=1000)):
        return jsonify({"erro": "desligamento não está na fila de revisão"}), 404

    try:
        resultado = tp.aplicar_revisao(deslig_id, session.get("uid"), lat, lon, reprovar)
    except Exception as e:
        return jsonify({"erro": str(e)}), 500
    return jsonify(resultado or {"ok": True})


@bp.route("/troca-poste/rede.json")
@login_obrigatorio
@modulo_obrigatorio("troca-poste")
def troca_poste_rede():
    """Malha óptica das cidades pedidas — carregada sob demanda pelo mapa.

    Fica fora do pacote da página de propósito: a malha inteira passa de 1 MB, e
    quem abre a tela para ver a lista de desligamentos não precisa baixar cabo
    nenhum. O mapa pede só as cidades do recorte quando a aba é aberta.
    """
    bruto = (request.args.get("cidades") or "").strip()
    cidades = [c for c in (x.strip() for x in bruto.split(",")) if c] or None
    resp = jsonify(tp.rede(cidades))
    # A malha vem do espelho do Geogrid, sincronizado semanalmente: relê-la a
    # cada troca de aba é desperdício. `private` porque a resposta depende da
    # sessão (a rota exige login).
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


@bp.route("/configuracoes/modulos", methods=["POST"])
@admin_obrigatorio
def configuracoes_modulos():
    """Grava quais módulos um usuário NÃO vê.

    Só admin: liberar módulo é poder sobre o que os outros enxergam, e é o
    mesmo recorte de todos os blocos de gestão desta tela. O formulário manda o
    que a pessoa PODE ver (as caixas marcadas); aqui se grava o complemento,
    porque a tabela guarda o que foi tirado — ver a migration 0014.
    """
    uid = (request.form.get("usuario_id") or "").strip()
    if not uid:
        flash("Usuário não informado.", "erro")
        return redirect(url_for("dash.configuracoes") + "#modulos-por-usuario")

    permitidos = set(request.form.getlist("modulo"))
    bloqueados = [m for m in auth.MODULOS if m not in permitidos]

    try:
        # Reescreve do zero: apagar e inserir mantém a linha do banco igual ao
        # que a tela mostrou, sem precisar comparar estado anterior.
        supa.delete("usuario_modulos_bloqueados", {"usuario_id": uid})
        if bloqueados:
            supa.insert("usuario_modulos_bloqueados",
                        [{"usuario_id": uid, "modulo": m,
                          "bloqueado_por": session.get("uid")} for m in bloqueados])
    except Exception as e:
        flash(f"Não foi possível salvar: {e}", "erro")
        return redirect(url_for("dash.configuracoes") + "#modulos-por-usuario")

    flash("Acesso aos módulos atualizado." if bloqueados
          else "Acesso liberado a todos os módulos.", "ok")
    return redirect(url_for("dash.configuracoes") + "#modulos-por-usuario")


@bp.route("/usuarios")
@admin_obrigatorio
def usuarios():
    try:
        lista = supa.select("usuarios",
                            {"select": "id,nome,email,criado_em", "order": "criado_em.asc"})
    except Exception:
        lista = []
    return render_template("usuarios.html", ativo="usuarios", usuarios=lista)


@bp.route("/usuarios/renomear", methods=["POST"])
@admin_obrigatorio
def usuario_renomear():
    """Corrige o nome de exibição de uma conta.

    O nome é atributo da CONTA, então a correção mora aqui e não na tela de
    supervisores: arrumar num lugar arruma em todos — lista de usuários,
    cadastro de supervisor e o filtro do IQI/IQM. O e-mail não muda, porque é
    a identidade de login; trocá-lo é criar outra conta, não renomear esta.
    """
    uid = (request.form.get("usuario_id") or "").strip()
    nome = " ".join((request.form.get("nome") or "").split())
    if not uid or not nome:
        flash("Informe o usuário e o novo nome.", "erro")
        return redirect(url_for("dash.usuarios"))
    try:
        supa.update("usuarios", {"id": uid}, {"nome": nome})
        flash(f"Nome atualizado para {nome}.", "ok")
    except Exception as e:
        flash(f"Erro ao renomear: {e}", "erro")
    return redirect(url_for("dash.usuarios"))


@bp.route("/configuracoes")
@login_obrigatorio
def configuracoes():
    """Conta do próprio usuário e, para o admin, a gestão de supervisores.

    Deixou de ser exclusiva do admin: trocar a própria senha é algo que todo
    usuário precisa fazer, e antes só o admin conseguia.
    """
    u = usuario_atual()
    contexto = {"ativo": "configuracoes", "usuario": u}
    if u["is_admin"]:
        contexto["supervisores"] = supervisores.listar()
        contexto["equipes"] = supervisores.equipes_disponiveis()
        contexto["tecnicos_por_empresa"] = supervisores.tecnicos_disponiveis()
        # Áreas e gestores do módulo Ações moram aqui, e não numa aba dentro
        # dele: configuração espalhada em dois lugares é onde as pessoas
        # param de achar.
        contexto["areas"] = acoes.areas()
        contexto["areas_todas"] = acoes.areas(incluir_inativas=True)
        contexto["gestores"] = acoes.gestores()
        # Metas do Dashboard: mesma tela por decisão de projeto — configuração
        # espalhada é onde as pessoas param de achar.
        contexto["metas_dashboard"] = gerencial.metas()
        contexto["metas_conhecidas"] = METAS_DASHBOARD
        contexto["meses_visiveis"] = gerencial.meses_visiveis()
        try:
            contexto["usuarios"] = supa.select(
                "usuarios", {"select": "id,nome,email", "order": "nome.asc"})
        except Exception:
            contexto["usuarios"] = []
    if u["is_admin"]:
        # Um mapa {usuario_id: [módulos escondidos]} para a tela marcar as
        # caixas. Uma consulta só para todos: com 12 usuários, uma por linha
        # seriam 12 idas ao PostgREST a ~0,27s cada.
        try:
            bloqueios = supa.select("usuario_modulos_bloqueados",
                                    {"select": "usuario_id,modulo"})
        except Exception:
            bloqueios = []
        mapa = {}
        for b in bloqueios:
            mapa.setdefault(b["usuario_id"], []).append(b["modulo"])
        # O módulo em construção continua na grade (a marcação vale quando
        # ele for liberado), mas diz que, por ora, só o admin o vê — senão a
        # caixa marcada prometeria um acesso que a pessoa ainda não tem.
        construcao = auth.em_construcao()
        contexto["modulos"] = [{"chave": m, "rotulo": auth.ROTULO_MODULO[m]
                                + (" (só admin, em construção)" if m in construcao else "")}
                               for m in auth.MODULOS]
        contexto["modulos_bloqueados"] = mapa
    return render_template("configuracoes.html", **contexto)


# As metas que a tela oferece, com a direção de cada uma. Ficam aqui e não no
# banco porque a LISTA é do código (é ela que diz quais cards existem); o VALOR
# é que é do usuário, e mora em `dashboard_metas`. Meta sem valor é estado
# legítimo: o card mostra o número e omite a comparação, em vez de inventar
# um alvo que ninguém combinou.
METAS_DASHBOARD = [
    {"chave": "iqi", "rotulo": "IQI — instalação (%)", "direcao": "menor"},
    {"chave": "iqm", "rotulo": "IQM — manutenção (%)", "direcao": "menor"},
    {"chave": "cmt", "rotulo": "CMT — cancelamento por motivo técnico (%)", "direcao": "menor"},
    {"chave": "esteira_util", "rotulo": "Esteira útil (OSs na fila)", "direcao": "menor"},
    {"chave": "retiradas", "rotulo": "Fila de retirada (OSs)", "direcao": "menor"},
    {"chave": "disk", "rotulo": "Salas Disk abertas", "direcao": "menor"},
    # "GPON apagado" aqui é a CAUSA de reincidência (Categoria 2 do AII: o N1
    # encerrou o protocolo assim) — quanto menos, melhor. Não confundir com a
    # razão "GPON realizadas ÷ abertas", que seria quanto maior melhor: essa
    # não existe em nenhum dos cinco relatórios que o coletor lê.
    {"chave": "gpon", "rotulo": "GPON apagado como causa (reincidências)", "direcao": "menor"},
    {"chave": "idf_ligacoes", "rotulo": "IDF — ligações (nota)", "direcao": "maior"},
    {"chave": "idf_chats", "rotulo": "IDF — chats (nota)", "direcao": "maior"},
    {"chave": "idf_os", "rotulo": "IDF — OS (nota)", "direcao": "maior"},
    # Limiar do ALERTA do IDF, não meta de cobrança: média ou feedback com
    # nota abaixo dele acende o alerta. Vazio = 3, a regra combinada em
    # 29/09/2026 ("acima de 3 nada; abaixo, alerta"). Ver gerencial.limiar_idf.
    {"chave": "idf_alerta", "rotulo": "IDF — alerta abaixo da nota (vazio = 3)", "direcao": "maior"},
    {"chave": "tma_chat", "rotulo": "TMA do chat (minutos)", "direcao": "menor"},
    {"chave": "tmf_chat", "rotulo": "TMF do chat — espera até a 1ª resposta (minutos)", "direcao": "menor"},
]


@bp.route("/dashboard/metas", methods=["POST"])
@admin_obrigatorio
def dashboard_metas():
    """Grava as metas enviadas. Campo em branco volta a "não definida"."""
    direcoes = {m["chave"]: m["direcao"] for m in METAS_DASHBOARD}
    rotulos = {m["chave"]: m["rotulo"] for m in METAS_DASHBOARD}
    salvas, erro = 0, None
    for chave in direcoes:
        if f"meta-{chave}" not in request.form:
            continue
        bruto = (request.form.get(f"meta-{chave}") or "").strip().replace(",", ".")
        try:
            gerencial.salvar_meta(chave, bruto or None,
                                  direcoes[chave], rotulos[chave])
            salvas += 1
        except ValueError:
            erro = f"«{bruto}» não é um número (meta {rotulos[chave]})."
        except Exception as e:
            erro = f"Erro ao gravar a meta {rotulos[chave]}: {e}"
    if erro:
        flash(erro, "erro")
    elif salvas:
        flash(f"{salvas} meta(s) do Dashboard atualizada(s).", "ok")
    return redirect(url_for("dash.configuracoes") + "#metas-dashboard")


@bp.route("/dashboard/config", methods=["POST"])
@admin_obrigatorio
def dashboard_config():
    """Preferências de exibição do Dashboard (hoje: quantos meses comparar)."""
    bruto = (request.form.get("meses_visiveis") or "").strip()
    try:
        n = int(bruto)
        if n < 1 or n > 24:
            raise ValueError
    except ValueError:
        flash("Informe um número de meses entre 1 e 24.", "erro")
        return redirect(url_for("dash.configuracoes") + "#metas-dashboard")
    try:
        gerencial.salvar_config("meses_visiveis", n)
        flash(f"O Dashboard passa a comparar {n} mês(es).", "ok")
    except Exception as e:
        flash(f"Erro ao salvar: {e}", "erro")
    return redirect(url_for("dash.configuracoes") + "#metas-dashboard")


@bp.route("/supervisores/marcar", methods=["POST"])
@admin_obrigatorio
def supervisor_marcar():
    """Promove um usuário existente a supervisor.

    Reaproveita a conta que já existe em vez de criar outra: senha, login e
    recuperação continuam num lugar só. Criar o usuário segue sendo feito na
    tela Usuários, pelo admin.
    """
    uid = (request.form.get("usuario_id") or "").strip()
    if not uid:
        flash("Escolha um usuário.", "erro")
        return redirect(url_for("dash.configuracoes"))
    try:
        if supervisores.eh_supervisor(uid):
            flash("Esse usuário já é supervisor.", "erro")
        else:
            supervisores.marcar(uid)
            flash("Supervisor cadastrado.", "ok")
    except Exception as e:
        flash(f"Erro ao cadastrar supervisor: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/supervisores/remover", methods=["POST"])
@admin_obrigatorio
def supervisor_remover():
    """Tira o papel de supervisor. A CONTA permanece — só o papel sai.

    Os vínculos com equipes caem junto (on delete cascade na migration 0003).
    """
    uid = (request.form.get("usuario_id") or "").strip()
    try:
        supervisores.desmarcar(uid)
        flash("Supervisor removido. A conta de acesso continua ativa.", "ok")
    except Exception as e:
        flash(f"Erro ao remover: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/supervisores/equipe", methods=["POST"])
@admin_obrigatorio
def supervisor_equipe():
    """Liga ou desliga equipes de um supervisor.

    Aceita várias equipes numa submissão: supervisor com uma equipe só é a
    exceção, não a regra — o Hygor tem três. Uma ida ao servidor por equipe
    fazia o cadastro virar repetição.
    """
    uid = (request.form.get("usuario_id") or "").strip()
    equipes = [e.strip() for e in request.form.getlist("equipe") if e.strip()]
    acao = request.form.get("acao") or "vincular"
    if not uid or not equipes:
        flash("Informe o supervisor e ao menos uma equipe.", "erro")
        return redirect(url_for("dash.configuracoes"))
    try:
        for equipe in equipes:
            if acao == "desvincular":
                supervisores.desvincular(uid, equipe)
            else:
                supervisores.vincular(uid, equipe)
        verbo = "desvinculada" if acao == "desvincular" else "vinculada"
        flash(f"{len(equipes)} equipe(s) {verbo}(s): {', '.join(equipes)}.", "ok")
    except Exception as e:
        flash(f"Erro ao alterar o vínculo: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/supervisores/tecnico", methods=["POST"])
@admin_obrigatorio
def supervisor_tecnico():
    """Liga ou desliga técnicos avulsos de um supervisor.

    Existe porque a empresa nem sempre é a unidade de supervisão: os 26
    técnicos da UNETVALE se dividem entre supervisores, e vincular a empresa
    inteira mostraria a cada um o time do outro.
    """
    uid = (request.form.get("usuario_id") or "").strip()
    rotulos = [r.strip() for r in request.form.getlist("tecnico") if r.strip()]
    acao = request.form.get("acao") or "vincular"
    if not uid or not rotulos:
        flash("Informe o supervisor e ao menos um técnico.", "erro")
        return redirect(url_for("dash.configuracoes"))
    try:
        for rotulo in rotulos:
            if acao == "desvincular":
                # Aqui vem a chave normalizada, que é o que a tabela guarda.
                supervisores.desvincular_tecnico(uid, rotulo)
            else:
                supervisores.vincular_tecnico(uid, rotulo)
        verbo = "desvinculado" if acao == "desvincular" else "vinculado"
        flash(f"{len(rotulos)} técnico(s) {verbo}(s).", "ok")
    except Exception as e:
        flash(f"Erro ao alterar o vínculo: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/monitoramento")
@admin_obrigatorio
def monitoramento():
    # As coletas da Celesc (módulo Troca de Poste) ficam aqui junto das do
    # WVSA: é a mesma pergunta — "a ingestão está rodando?" — e ter duas telas
    # separadas para ela só fazia procurar em dois lugares.
    #
    # A rodada é lida ANTES do resumo e passada a ele: durante a coleta (~8 min,
    # sequencial) os módulos ainda não gravados exibem o carimbo da rodada
    # anterior, e sem esse aviso isso passa por defeito.
    rodada = dados.rodada_em_andamento()
    resumo = dados.resumo_modulos(rodada)
    # A Troca de Poste entra na mesma grade por fora, com limiar próprio: ela
    # não mora em `dados_modulo` (ver `tp.resumo_coleta`).
    resumo.append(tp.resumo_coleta())
    return render_template("monitoramento.html", ativo="monitoramento",
                           resumo=resumo, rodada=rodada, pulso=dados.heartbeat(),
                           logs=dados.get_log(150), coletas=tp.coletas(30))


def _supervisores_para_filtro(u):
    """Lista para o filtro por supervisor.

    Só o admin escolhe entre supervisores; para o próprio supervisor o recorte
    já veio aplicado do servidor, então oferecer o filtro seria redundante.
    """
    if not u["is_admin"]:
        return []
    return [{"id": s["usuario_id"], "nome": s["nome"], "equipes": s["equipes"],
             "tecnicos": [t["chave"] for t in s["tecnicos"]]}
            for s in supervisores.listar() if s["equipes"] or s["tecnicos"]]


def _meta(row):
    if not row:
        return {"atualizado_em": None, "status": "sem_dados"}
    return {"atualizado_em": row.get("atualizado_em"), "status": row.get("status")}


# --------------------------------------------------------------------------
# Atualização sob demanda: o botão grava um "pedido" no Supabase; o watcher do
# coletor (dentro da VPN) detecta e roda. O app só lê/escreve o Supabase.
# --------------------------------------------------------------------------
def _ultima_data():
    ult = None
    for r in dados.get_todos().values():
        dt = dados._parse_dt(r.get("atualizado_em"))
        if dt and (ult is None or dt > ult):
            ult = dt
    return ult


@bp.route("/api/atualizar", methods=["POST"])
@login_obrigatorio
def api_atualizar():
    # Registra o pedido na tabela existente coletor_log (status='pedido'); o
    # watcher do coletor (dentro da VPN) detecta e roda. Sem tabela extra.
    try:
        supa.insert("coletor_log", {
            "modulo": "geral", "status": "pedido",
            "mensagem": "Atualização manual solicitada",
        })
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 500
    return jsonify({"ok": True})


@bp.route("/api/atualizar/status")
@login_obrigatorio
def api_atualizar_status():
    # Mesma fonte que a tela usa (`coletor_log`, linha `geral` mais recente).
    # Antes daqui saía outra definição de "rodando" — pedido mais novo que o
    # último carimbo —, que só enxergava coleta pedida pelo botão: rodada
    # agendada não aparecia, e o botão recarregava a página no meio dela.
    rodada = dados.rodada_em_andamento()
    ult = _ultima_data()
    return jsonify({
        "rodando": rodada["rodando"],
        "concluidos": rodada["concluidos"],
        "total": rodada["total"],
        "ultima": ult.astimezone(dados.BR_TZ).strftime("%d/%m/%Y %H:%M") if ult else "—",
    })


# --------------------------------------------------------------------------
# Endpoint opcional de ingestão: o coletor pode usar isto em vez de gravar
# direto no Supabase. Protegido por token compartilhado (INGEST_TOKEN).
# --------------------------------------------------------------------------
@bp.route("/api/ingest", methods=["POST"])
def ingest():
    token = request.headers.get("X-Ingest-Token", "")
    esperado = os.environ.get("INGEST_TOKEN", "")
    if not esperado or token != esperado:
        abort(401)
    body = request.get_json(silent=True) or {}
    modulo = body.get("modulo")
    payload = body.get("payload")
    status = body.get("status", "ok")
    if modulo not in dados.MODULOS or payload is None:
        return jsonify({"erro": "modulo/payload inválidos"}), 400
    supa.upsert("dados_modulo", {
        "modulo": modulo,
        "payload": payload,
        "status": status,
        "atualizado_em": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="modulo")
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Módulo Ações
#
# Primeiro módulo do portal em que o dado NASCE aqui. Produtividade, IQI e
# Massivas são espelho do WVSA e podem ser recoletados; aqui não há de onde
# recoletar, então o recorte de quem vê o quê é feito no servidor e o
# histórico é append-only.
# --------------------------------------------------------------------------
def _usuarios_para_escolha():
    """Contas ativas, para os seletores de responsável e apoio."""
    try:
        return supa.select("usuarios", {"select": "id,nome,email", "order": "nome.asc"})
    except Exception:
        return []


def _acao_ou_404(acao_id, u, exigir=None):
    """Carrega a ação e confere a permissão numa tacada só.

    Devolver 404 em vez de 403 quando a pessoa não pode ver é deliberado: um
    403 confirmaria que a ação existe, e o código dela é sequencial e fácil de
    adivinhar.
    """
    a = acoes.obter(acao_id)
    if not a or not acoes.pode_ver(u, a):
        abort(404)
    if exigir and not exigir(u, a):
        abort(403)
    return a


# Campos de cada ação que vão para o browser no quadro. Lista explícita, e não
# a linha inteira: `observacoes` e `entrega_esperada` são texto longo que o
# cartão não mostra, e o painel lateral busca a ação inteira quando abre.
_CAMPOS_QUADRO = ("id", "codigo", "titulo", "area_id", "responsavel_id",
                  "apoio_ids", "prazo", "data_abertura", "data_conclusao",
                  "prioridade", "status", "progresso", "situacao", "dias",
                  "atrasada", "proximo_passo", "etiquetas", "evidencia",
                  "atualizado_em")


def _item_quadro(a, u, cont, reun):
    """Uma ação no formato do quadro: os campos + os contadores dos ícones +
    o que ESTA pessoa pode fazer com ela. A permissão vai calculada do
    servidor; o JS só decide se mostra a alça de arrastar."""
    d = {k: a.get(k) for k in _CAMPOS_QUADRO}
    c = cont.get(a["id"]) or {}
    d.update(eventos=c.get("eventos", 0), chk_total=c.get("chk_total", 0),
             chk_feitos=c.get("chk_feitos", 0), reunioes=reun.get(a["id"], 0),
             pode_atualizar=acoes.pode_atualizar(u, a),
             pode_gerir=acoes.pode_gerir(u, a))
    return d


def _reunioes_por_acao(acao_id=None):
    # Contador de enfeite: falhar aqui não pode derrubar o quadro.
    try:
        return reuniao_ia.reunioes_por_acao(acao_id)
    except Exception:
        return {}


def _item_de(acao_id, u, a=None):
    """A ação recém-alterada, no formato do quadro — é o que as rotas JSON
    devolvem para o cartão se redesenhar sem recarregar a página.

    `a` é a ação como a gravação a deixou (`acoes.atualizar` a devolve): com
    ela, não se relê a linha que acabou de ser escrita. Os contadores dos
    ícones e o ↻ de reuniões vão juntos ao banco, e só desta ação.
    """
    if a is None:
        a = acoes.obter(acao_id)
    if not a:
        return None
    cont, reun = supa.paralelo(lambda: acoes.contagens([acao_id]),
                               lambda: _reunioes_por_acao(acao_id))
    return _item_quadro(a, u, cont, reun)


def _nome(uid, usuarios):
    for x in usuarios:
        if x["id"] == uid:
            return x.get("nome") or x["email"].split("@")[0]
    return None


@bp.route("/acoes")
@login_obrigatorio
@modulo_obrigatorio("acoes")
def acoes_view():
    u = usuario_atual()
    aba = request.args.get("aba", "painel")
    # Sem filtro no servidor: o recorte de PERMISSÃO continua aqui (`listar`
    # só devolve o que a pessoa pode ver), mas pessoa, área, prioridade,
    # etiqueta e busca são aplicados no browser. As três visões (quadro,
    # lista, cronograma) usam o mesmo dado, e recarregar a página a cada
    # chip fecharia o painel lateral aberto.
    #
    # Tudo que não depende da lista vai junto ao banco, e o que depende dela
    # vai junto logo depois (07/10/2026): eram ~15 idas em série, e cada uma
    # é uma viagem até o Supabase.
    lista, usuarios, reunioes, areas, _ = supa.paralelo(
        lambda: acoes.listar(u), _usuarios_para_escolha,
        lambda: acoes.listar_reunioes(u), acoes.areas, acoes.tem_checklist)
    ids = [a["id"] for a in lista]
    cont, reun, ultimos = supa.paralelo(
        lambda: acoes.contagens(ids), _reunioes_por_acao,
        lambda: acoes.ultimos_eventos(ids))

    # Só a aba Reuniões paga o custo do que é dela. As outras duas não podem
    # ficar mais lentas por causa de um card que elas nem mostram.
    for r in reunioes:
        # Trecho do resumo na lista: reconhecer a reunião sem precisar abrir.
        r["resumo"] = reuniao_ia.resumo_curto(r.get("ata_markdown"))

    recorrentes, resumo_exec = [], None
    if aba == "reunioes":
        # O expurgo dos áudios vencidos pega carona aqui: a Vercel não tem
        # processo residente, e um agendador seria infra nova para apagar meia
        # dúzia de arquivos. Falhar em silêncio é deliberado — limpeza de
        # arquivo velho não pode derrubar a tela de quem só quer ver a lista.
        try:
            reuniao_ia.expurgar_audio()
        except Exception:
            pass
        recorrentes = reuniao_ia.recorrentes_pendentes()
        resumo_exec = reuniao_ia.resumo_executivo(lista=recorrentes)

    pacote = {
        "acoes": [_item_quadro(a, u, cont, reun) for a in lista],
        "usuarios": [{"id": x["id"], "nome": x.get("nome") or x["email"].split("@")[0]}
                     for x in usuarios],
        "areas": [{"id": x["id"], "nome": x["nome"]} for x in areas],
        "status": acoes.STATUS, "prioridades": acoes.PRIORIDADES,
        "eu": u["id"], "pode_criar": acoes.pode_gerir(u),
        "tem_etiquetas": acoes.tem_etiquetas(),
        "hoje": datetime.now(timezone.utc).astimezone().date().isoformat(),
    }

    # O Painel recebe a MESMA lista que o quadro, e não uma consulta
    # própria: painel que refaz a consulta é painel que discorda da tabela.
    resumo = acoes.resumo(lista)
    for linha in resumo["carga_por_pessoa"]:
        linha["nome"] = _nome(linha["responsavel_id"], usuarios) or "—"
    return render_template(
        "acoes.html", ativo="acoes", sem_sync=True, aba=aba,
        acoes=lista, resumo=resumo, pacote=pacote,
        areas=areas, usuarios=usuarios,
        status_opcoes=acoes.STATUS, prioridades=acoes.PRIORIDADES,
        pode_criar=acoes.pode_gerir(u), ultimos=ultimos,
        tem_etiquetas=acoes.tem_etiquetas(), tem_checklist=acoes.tem_checklist(),
        reunioes=reunioes,
        recorrentes=recorrentes, resumo_exec=resumo_exec,
        resumo_exec_html=reuniao_ia.para_html(
            (resumo_exec or {}).get("markdown")))


def _contexto_acao(a, u):
    """O que o parcial `_acao_painel.html` precisa — o MESMO para o painel
    lateral e para a página cheia, que são duas molduras do mesmo conteúdo.

    As cinco leituras são independentes e vão juntas ao banco; os eventos são
    lidos uma vez e servem também à linha do tempo (eram lidos duas vezes).
    """
    itens_chk, evs, areas, itens_reuniao, usuarios = supa.paralelo(
        lambda: acoes.checklist(a["id"]), lambda: acoes.eventos(a["id"]),
        acoes.areas, lambda: reuniao_ia.itens_da_acao(a["id"]),
        _usuarios_para_escolha)
    return dict(
        acao=a, eventos=evs,
        atividade=acoes.atividade(a["id"], itens_chk, lista_eventos=evs),
        checklist=itens_chk, areas=areas,
        itens_reuniao=itens_reuniao,
        usuarios=usuarios,
        status_opcoes=acoes.STATUS, prioridades=acoes.PRIORIDADES,
        tem_etiquetas=acoes.tem_etiquetas(),
        pode_gerir=acoes.pode_gerir(u, a), pode_atualizar=acoes.pode_atualizar(u, a))


@bp.route("/acoes/<acao_id>")
@login_obrigatorio
def acao_detalhe(acao_id):
    u = usuario_atual()
    a = _acao_ou_404(acao_id, u)
    return render_template("acao_detalhe.html", ativo="acoes", sem_sync=True,
                           modo="pagina", **_contexto_acao(a, u))


@bp.route("/acoes/<acao_id>/painel")
@login_obrigatorio
@modulo_obrigatorio("acoes")
def acao_painel(acao_id):
    """Fragmento HTML do painel lateral. Renderizado pelo servidor, e não
    montado no JS a partir de JSON, para existir UMA definição da tela da
    ação: a página cheia inclui o mesmo parcial."""
    u = usuario_atual()
    a = _acao_ou_404(acao_id, u)
    # A página cheia também recarrega por aqui depois de cada gravação, e ela
    # não tem painel para fechar nem "abrir em página cheia".
    modo = "pagina" if request.args.get("modo") == "pagina" else "gaveta"
    return render_template("_acao_painel.html", modo=modo, **_contexto_acao(a, u))


def _resposta_json(acao_id, u, **extra):
    return jsonify(dict({"ok": True, "acao": _item_de(acao_id, u)}, **extra))


def _erro_json(e):
    # ValueError é a regra de negócio recusando (evidência faltando, status
    # inventado): é 400 e a mensagem vai para a tela. O resto é defeito.
    if isinstance(e, ValueError):
        return jsonify({"erro": str(e)}), 400
    print(f"[acoes] erro inesperado: {e}", file=sys.stderr)
    return jsonify({"erro": "Não foi possível salvar. Tente de novo."}), 500


# Filtros do quadro que sobrevivem ao redirect da criação. Lista fechada, e só
# a query string viaja — nunca um caminho —, para o campo não virar um
# redirect para qualquer lugar.
_ESTADO_QUADRO = ("q", "responsavel", "area", "prioridade", "etiqueta",
                  "agrupar", "atalhos", "visao")


def _estado_do_quadro(query):
    from urllib.parse import parse_qs
    try:
        pares = parse_qs((query or "").lstrip("?"), max_num_fields=20)
    except ValueError:
        return {}
    return {k: v[0][:100] for k, v in pares.items() if k in _ESTADO_QUADRO and v and v[0]}


@bp.route("/acoes/nova", methods=["POST"])
@login_obrigatorio
def acao_nova():
    u = usuario_atual()
    if not acoes.pode_gerir(u):
        abort(403)
    f = request.form
    try:
        dados = f.to_dict()
        dados["etiquetas"] = f.getlist("etiqueta") or f.get("etiquetas")
        a = acoes.criar(dados, u["id"], apoio_ids=f.getlist("apoio"),
                        checklist_inicial=f.getlist("checklist"))
        flash(f"Ação {a['codigo']} criada.", "ok")
        # Volta para o QUADRO com a ação aberta no painel: quem cria quase
        # sempre quer conferir o que criou, mas no contexto das outras — e no
        # MESMO recorte (quem criou dentro da raia da Ana volta às raias).
        return redirect(url_for("dash.acoes_view", aba="acoes", acao=a["codigo"],
                                **_estado_do_quadro(f.get("voltar"))))
    except Exception as e:
        flash(f"Erro ao criar a ação: {e}", "erro")
        return redirect(url_for("dash.acoes_view", aba="acoes",
                                **_estado_do_quadro(f.get("voltar"))))


@bp.route("/acoes/<acao_id>/editar", methods=["POST"])
@login_obrigatorio
def acao_editar(acao_id):
    u = usuario_atual()
    _acao_ou_404(acao_id, u, exigir=acoes.pode_gerir)
    try:
        acoes.editar(acao_id, request.form.to_dict(),
                     apoio_ids=request.form.getlist("apoio"))
        flash("Ação atualizada.", "ok")
    except Exception as e:
        flash(f"Erro ao editar: {e}", "erro")
    return redirect(url_for("dash.acao_detalhe", acao_id=acao_id))


# O que o painel lateral edita campo a campo. `apoio_ids` e `etiquetas` são
# listas; o resto, texto.
_CAMPOS_EDITAVEIS = {"titulo", "entrega_esperada", "area_id", "responsavel_id",
                     "prazo", "prioridade", "observacoes", "etiquetas", "apoio_ids"}


@bp.route("/acoes/<acao_id>/campo", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("acoes")
def acao_campo(acao_id):
    u = usuario_atual()
    _acao_ou_404(acao_id, u, exigir=acoes.pode_gerir)
    c = request.get_json(silent=True) or {}
    campo, valor = c.get("campo"), c.get("valor")
    if campo not in _CAMPOS_EDITAVEIS:
        return jsonify({"erro": "campo não editável"}), 400
    if campo in ("apoio_ids", "etiquetas") and not isinstance(valor, list):
        return jsonify({"erro": "esperava uma lista"}), 400
    if campo not in ("apoio_ids", "etiquetas") and not (valor is None or isinstance(valor, str)):
        return jsonify({"erro": "valor inválido"}), 400
    try:
        if campo == "apoio_ids":
            acoes.editar(acao_id, {}, apoio_ids=valor)
        else:
            acoes.editar(acao_id, {campo: valor})
    except Exception as e:
        return _erro_json(e)
    return _resposta_json(acao_id, u)


@bp.route("/acoes/<acao_id>/mover", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("acoes")
def acao_mover(acao_id):
    """Troca de status pelo quadro (arrastar) ou pelo seletor do painel.

    É a MESMA `acoes.atualizar` do formulário: as travas de evidência e de
    próximo passo valem igual, e o evento é gravado junto.
    """
    u = usuario_atual()
    atual = _acao_ou_404(acao_id, u, exigir=acoes.pode_atualizar)
    c = request.get_json(silent=True) or {}
    if c.get("status") not in acoes.STATUS:
        return jsonify({"erro": "status inválido"}), 400
    textos = ("texto", "proximo_passo", "evidencia", "data_conclusao")
    if any(not (c.get(k) is None or isinstance(c.get(k), str)) for k in textos):
        return jsonify({"erro": "valor inválido"}), 400
    try:
        nova = acoes.atualizar(
            acao_id, u["id"], c.get("texto"), status=c["status"],
            proximo_passo=c.get("proximo_passo"),
            evidencia=(c.get("evidencia") or "").strip() or None,
            data_conclusao=c.get("data_conclusao") or None, atual=atual)
    except Exception as e:
        return _erro_json(e)
    return jsonify({"ok": True, "acao": _item_de(acao_id, u, nova)})


@bp.route("/acoes/<acao_id>/atualizar", methods=["POST"])
@login_obrigatorio
def acao_atualizar(acao_id):
    u = usuario_atual()
    atual = _acao_ou_404(acao_id, u, exigir=acoes.pode_atualizar)
    # O painel lateral manda JSON e quer JSON de volta (o cartão se redesenha
    # sem recarregar); a página cheia e o celular antigo mandam formulário.
    f = request.get_json(silent=True) if request.is_json else request.form
    f = f or {}
    try:
        nova = acoes.atualizar(
            acao_id, u["id"], f.get("texto"),
            status=f.get("status") or None,
            progresso=f.get("progresso") if f.get("progresso") not in (None, "") else None,
            proximo_passo=f.get("proximo_passo"),
            evidencia=f.get("evidencia") or None,
            data_conclusao=f.get("data_conclusao") or None, atual=atual)
        if request.is_json:
            return jsonify({"ok": True, "acao": _item_de(acao_id, u, nova)})
        flash("Atualização registrada.", "ok")
    except Exception as e:
        if request.is_json:
            return _erro_json(e)
        flash(str(e), "erro")
    return redirect(url_for("dash.acao_detalhe", acao_id=acao_id))


@bp.route("/acoes/<acao_id>/comentar", methods=["POST"])
@login_obrigatorio
def acao_comentar(acao_id):
    u = usuario_atual()
    _acao_ou_404(acao_id, u, exigir=acoes.pode_gerir)
    if request.is_json:
        c = request.get_json(silent=True) or {}
        try:
            acoes.comentar(acao_id, u["id"], c.get("texto") if isinstance(c.get("texto"), str) else None)
        except Exception as e:
            return _erro_json(e)
        return _resposta_json(acao_id, u)
    try:
        acoes.comentar(acao_id, u["id"], request.form.get("texto"),
                       reuniao_id=request.form.get("reuniao_id") or None)
        flash("Comentário registrado.", "ok")
    except Exception as e:
        flash(str(e), "erro")
    destino = request.form.get("voltar_para")
    if destino == "reuniao" and request.form.get("reuniao_id"):
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=request.form["reuniao_id"]))
    return redirect(url_for("dash.acao_detalhe", acao_id=acao_id))


@bp.route("/acoes/<acao_id>/checklist", methods=["POST"])
@login_obrigatorio
@modulo_obrigatorio("acoes")
def acao_checklist(acao_id):
    """Quem pode atualizar a ação mexe no checklist — é o plano de trabalho
    dela, e o % que sai dali é o mesmo que o responsável reportaria."""
    u = usuario_atual()
    _acao_ou_404(acao_id, u, exigir=acoes.pode_atualizar)
    c = request.get_json(silent=True) or {}
    if not all(c.get(k) is None or isinstance(c.get(k), str) for k in ("op", "item_id", "texto")):
        return jsonify({"erro": "valor inválido"}), 400
    try:
        r = acoes.checklist_aplicar(acao_id, c.get("op"), u["id"],
                                    item_id=c.get("item_id"), texto=c.get("texto"))
    except Exception as e:
        return _erro_json(e)
    return _resposta_json(acao_id, u, checklist=r)


@bp.route("/reunioes/nova", methods=["POST"])
@login_obrigatorio
def reuniao_nova():
    u = usuario_atual()
    if not acoes.pode_gerir(u):
        abort(403)
    f = request.form
    try:
        r = acoes.criar_reuniao(f.get("titulo"), f.get("tipo"), f.get("data"),
                                f.getlist("participantes"), u["id"],
                                convidados=f.get("convidados"))
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=r["id"]))
    except Exception as e:
        flash(str(e), "erro")
        return redirect(url_for("dash.acoes_view", aba="reunioes"))


def _reuniao_ou_404(reuniao_id, u, exigir_conduz=False, exigir_aberta=False):
    """Mesma lógica de `_acao_ou_404`: 404 para quem não pode ver.

    404 e não 403 porque 403 confirmaria que a reunião existe — e reunião
    tem participante, assunto e data que ninguém precisa poder sondar.
    """
    r = acoes.obter_reuniao(reuniao_id)
    if not r:
        abort(404)
    if not (u["is_admin"] or r.get("criada_por") == u["id"]
            or u["id"] in r["participantes"]):
        abort(404)
    if exigir_conduz and not acoes.pode_gerir(u):
        abort(403)
    if exigir_aberta and r.get("encerrada_em"):
        abort(409)
    return r


@bp.route("/reunioes/<reuniao_id>")
@login_obrigatorio
def reuniao_detalhe(reuniao_id):
    u = usuario_atual()
    r = acoes.obter_reuniao(reuniao_id)
    if not r:
        abort(404)
    # Participante enxerga a própria reunião; conduzir é só de gestor.
    if not (u["is_admin"] or r.get("criada_por") == u["id"]
            or u["id"] in r["participantes"]):
        abort(404)
    conduz = acoes.pode_gerir(u)
    return render_template(
        "reuniao.html", ativo="acoes", sem_sync=True, reuniao=r,
        pauta=acoes.pauta(r, u), usuarios=_usuarios_para_escolha(),
        conduz=conduz,
        estado=reuniao_ia.estado(reuniao_id, r),
        itens_ata=reuniao_ia.itens(reuniao_id),
        ata_html=reuniao_ia.para_html(r.get("ata_markdown")),
        contexto=reuniao_ia.contexto_anterior(r, u),
        areas=acoes.areas(),
        acoes_abertas=reuniao_ia.acoes_para_vincular(u),
        prioridades=acoes.PRIORIDADES,
        trecho_segundos=int(os.environ.get("REUNIAO_TRECHO_SEGUNDOS", "120")))


@bp.route("/reunioes/<reuniao_id>/pauta", methods=["POST"])
@login_obrigatorio
def reuniao_pauta(reuniao_id):
    """Liga/desliga a pauta automática desta reunião.

    Form comum e redirect, não JSON: o resto da tela da reunião muda junto
    (o card da pauta, o contexto anterior) e recarregar é mais simples e mais
    honesto do que remontar dois blocos no JS.
    """
    u = usuario_atual()
    r = _reuniao_ou_404(reuniao_id, u, exigir_conduz=True, exigir_aberta=True)
    try:
        acoes.definir_puxar_pauta(reuniao_id, request.form.get("ligado") == "1")
    except Exception as e:
        flash(str(e), "erro")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))


@bp.route("/reunioes/<reuniao_id>/ata/itens", methods=["POST"])
@login_obrigatorio
def reuniao_ata_itens(reuniao_id):
    """Liga/desliga as listas de itens DENTRO do texto da ata.

    Não exige reunião aberta, pelo mesmo motivo que regerar a ata não exige:
    o que "ata congelada" protege são os comentários do dia. O texto derivado
    da transcrição pode ser reformatado — e aqui nem se chama a IA, é
    `_markdown` remontando a estrutura já guardada.
    """
    u = usuario_atual()
    r = _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    ligado = request.form.get("ligado") == "1"
    try:
        remontou = reuniao_ia.definir_itens_na_ata(r, ligado)
    except Exception as e:
        flash(f"Não foi possível aplicar: {e}", "erro")
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))

    if remontou:
        flash("Ata remontada com as decisões e encaminhamentos."
              if ligado else
              "Ata remontada: só o relato. As sugestões seguem no card abaixo.",
              "ok")
    else:
        # Ata gerada antes da 0016 não tem a estrutura guardada. Dizer isso é
        # melhor que deixar a pessoa clicando num botão que não muda a tela.
        flash("Escolha registrada, mas esta ata foi gerada antes de o portal "
              "guardar a estrutura — para o texto mudar é preciso gerar a ata "
              "de novo.", "ok")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))


@bp.route("/reunioes/<reuniao_id>/itens/<item_id>/descartar", methods=["POST"])
@login_obrigatorio
def reuniao_item_descartar(reuniao_id, item_id):
    """Recusa uma sugestão da IA. Ela some da tela e não volta na regeração."""
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    try:
        reuniao_ia.descartar_item(item_id, u["id"])
        flash("Sugestão removida.", "ok")
    except ValueError as e:
        flash(str(e), "erro")
    except Exception as e:
        flash(f"Não foi possível remover: {e}", "erro")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))


@bp.route("/reunioes/<reuniao_id>/encerrar", methods=["POST"])
@login_obrigatorio
def reuniao_encerrar(reuniao_id):
    u = usuario_atual()
    if not acoes.pode_gerir(u):
        abort(403)
    try:
        # `notas` não vem mais da tela (o campo saiu). Passar None apagaria a
        # nota de reuniões antigas que tinham uma.
        acoes.encerrar_reuniao(reuniao_id, request.form.get("notas"))
        flash("Reunião encerrada. A ata está congelada.", "ok")
    except Exception as e:
        flash(str(e), "erro")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))



# ---- Gravação e ata da reunião -------------------------------------------
# Todas devolvem JSON: quem chama é o `reuniao.js`, não um <form>. O fluxo
# inteiro está desenhado em app/reuniao_ia.py — em resumo, quem orquestra é o
# navegador, porque a Vercel não tem processo em background.

@bp.route("/reunioes/<reuniao_id>/gravacao/iniciar", methods=["POST"])
@login_obrigatorio
def reuniao_gravacao_iniciar(reuniao_id):
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True, exigir_aberta=True)
    try:
        reuniao_ia.iniciar_gravacao(reuniao_id)
    except Exception as e:
        return jsonify({"erro": str(e)}), 502
    return jsonify({"ok": True})


@bp.route("/reunioes/<reuniao_id>/gravacao/parar", methods=["POST"])
@login_obrigatorio
def reuniao_gravacao_parar(reuniao_id):
    """Chamada pelo JS quando a captura parou e a fila esvaziou."""
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    try:
        return jsonify({"status": reuniao_ia.parar_gravacao(reuniao_id)})
    except Exception as e:
        return jsonify({"erro": str(e)}), 502


@bp.route("/reunioes/<reuniao_id>/audio/url", methods=["POST"])
@login_obrigatorio
def reuniao_audio_url(reuniao_id):
    """Autoriza o browser a gravar UM trecho direto no Storage.

    O arquivo não passa pelo Flask de propósito: a função serverless tem
    limite de corpo de requisição e o áudio estoura esse limite.
    """
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True, exigir_aberta=True)
    corpo = request.get_json(silent=True) or {}
    try:
        indice = int(corpo.get("indice"))
    except (TypeError, ValueError):
        return jsonify({"erro": "indice ausente ou inválido"}), 400
    try:
        return jsonify(reuniao_ia.autorizar_trecho(
            reuniao_id, indice, corpo.get("formato") or "audio/webm"))
    except Exception as e:
        return jsonify({"erro": str(e)}), 502


@bp.route("/reunioes/<reuniao_id>/audio/<int:indice>/transcrever", methods=["POST"])
@login_obrigatorio
def reuniao_audio_transcrever(reuniao_id, indice):
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    corpo = request.get_json(silent=True) or {}
    try:
        texto = reuniao_ia.transcrever_trecho(
            reuniao_id, indice, corpo.get("bytes"), corpo.get("duracao_ms"))
    except Exception as e:
        # 502 e não 500: a falha é do serviço externo, e a tela oferece
        # "tentar de novo". O áudio continua no Storage por 30 dias.
        return jsonify({"erro": str(e)}), 502
    return jsonify({"ok": True, "indice": indice, "caracteres": len(texto)})


@bp.route("/reunioes/<reuniao_id>/ata", methods=["POST"])
@login_obrigatorio
def reuniao_ata(reuniao_id):
    """Junta os trechos e gera a ata. Também é o caminho de regerar.

    Regerar continua permitido depois de encerrada: o que a regra de
    'ata congelada' protege são os COMENTÁRIOS do dia, que não mudam. A
    ata da transcrição é derivada do áudio e pode ser refeita enquanto o
    áudio existir.
    """
    u = usuario_atual()
    r = _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    corpo = request.get_json(silent=True) or {}
    # Dois clientes para a mesma rota: o `reuniao.js` (fetch, quer JSON) e o
    # botão "Gerar de novo" (<form>, quer voltar para a página). Devolver JSON
    # para o form deixaria o gestor olhando um {"ok": true} numa tela branca.
    via_form = not request.is_json

    try:
        reuniao_ia.montar_ata(r, u, interrompida=bool(corpo.get("interrompida")))
    except ValueError as e:
        if via_form:
            flash(str(e), "erro")
            return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))
        return jsonify({"erro": str(e)}), 400
    except Exception as e:
        if via_form:
            flash(f"Não foi possível gerar a ata: {e}", "erro")
            return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))
        return jsonify({"erro": str(e)}), 502

    if via_form:
        flash("Ata gerada.", "ok")
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))
    return jsonify({"ok": True})


@bp.route("/reunioes/<reuniao_id>/ata/status")
@login_obrigatorio
def reuniao_ata_status(reuniao_id):
    u = usuario_atual()
    r = _reuniao_ou_404(reuniao_id, u)
    return jsonify(reuniao_ia.estado(reuniao_id, r))


@bp.route("/reunioes/<reuniao_id>/pdf")
@login_obrigatorio
def reuniao_pdf(reuniao_id):
    """A reunião inteira num documento — ata, itens, registros e notas.

    Sai pelo diálogo de impressão do navegador, que é quem gera o PDF. Assim
    não entra biblioteca de PDF na função serverless, e o resultado é um PDF
    de verdade e não um HTML renomeado.
    """
    u = usuario_atual()
    r = _reuniao_ou_404(reuniao_id, u)
    lista = reuniao_ia.trechos(reuniao_id)
    ms = sum(t.get("duracao_ms") or 0 for t in lista if t["status"] == "ok")

    return render_template(
        "reuniao_pdf.html", reuniao=r,
        usuarios=_usuarios_para_escolha(),
        ata_html=reuniao_ia.para_html(r.get("ata_markdown"), so_corpo=True),
        itens=reuniao_ia.itens(reuniao_id),
        comentarios=reuniao_ia.comentarios_da_reuniao(reuniao_id),
        duracao=f"{ms // 60000} min" if ms else None,
        gerado_em=datetime.now(timezone.utc).astimezone().strftime("%d/%m/%Y %H:%M"))


@bp.route("/reunioes/<reuniao_id>/ata/editar", methods=["POST"])
@login_obrigatorio
def reuniao_ata_editar(reuniao_id):
    """Corrige a ata à mão. A IA erra nome próprio e sigla."""
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    # Quem chama é o autosave da tela (fetch, quer JSON). O `form` fica como
    # caminho de reserva para navegador sem JS.
    corpo = request.get_json(silent=True) or {}
    texto = corpo.get("ata_markdown", request.form.get("ata_markdown"))
    try:
        reuniao_ia.salvar_ata(reuniao_id, texto, u["id"])
    except ValueError as e:
        if request.is_json:
            return jsonify({"erro": str(e)}), 400
        flash(str(e), "erro")
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))
    except Exception as e:
        if request.is_json:
            return jsonify({"erro": str(e)}), 502
        flash(f"Não foi possível salvar: {e}", "erro")
        return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))

    if request.is_json:
        return jsonify({"ok": True})
    flash("Ata salva.", "ok")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))


@bp.route("/reunioes/<reuniao_id>/ata/itens/<item_id>/acao", methods=["POST"])
@login_obrigatorio
def reuniao_item_acao(reuniao_id, item_id):
    """Item da ata vira ação nova, ou entra numa que já existe.

    Era o beco sem saída do módulo: o vínculo só acontecia quando a IA
    reconhecia um código `AC-000` na fala, e assunto que ainda não é ação —
    a maioria — não tinha para onde ir.
    """
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    f = request.form
    try:
        if f.get("modo") == "vincular":
            if not f.get("acao_id"):
                raise ValueError("Escolha a ação.")
            reuniao_ia.vincular_item(item_id, f["acao_id"], u["id"])
            flash("Item registrado na ação.", "ok")
        else:
            a = reuniao_ia.criar_acao_do_item(
                item_id, f.to_dict(), u["id"], apoio_ids=f.getlist("apoio"))
            flash(f"Ação {a['codigo']} criada a partir da ata.", "ok")
    except ValueError as e:
        flash(str(e), "erro")
    except Exception as e:
        flash(f"Não foi possível: {e}", "erro")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))


@bp.route("/reunioes/<reuniao_id>/ata/itens/<item_id>/aplicar", methods=["POST"])
@login_obrigatorio
def reuniao_item_aplicar(reuniao_id, item_id):
    """Item da ata vira comentário na ação — só por clique humano.

    `acao_eventos` é append-only por trigger: o que entra lá não sai nem
    com a service_role. Por isso texto de IA precisa de alguém assinando.
    """
    u = usuario_atual()
    _reuniao_ou_404(reuniao_id, u, exigir_conduz=True)
    try:
        reuniao_ia.aplicar_item(item_id, u["id"])
        flash("Item registrado na linha do tempo da ação.", "ok")
    except ValueError as e:
        flash(str(e), "erro")
    except Exception as e:
        flash(f"Não foi possível registrar: {e}", "erro")
    return redirect(url_for("dash.reuniao_detalhe", reuniao_id=reuniao_id))


@bp.route("/acoes/resumo-executivo/gerar", methods=["POST"])
@login_obrigatorio
def acoes_resumo_executivo():
    u = usuario_atual()
    if not acoes.pode_gerir(u):
        abort(403)
    try:
        reuniao_ia.gerar_resumo_executivo()
        flash("Resumo executivo atualizado.", "ok")
    except ValueError as e:
        flash(str(e), "erro")
    except Exception as e:
        flash(f"Não foi possível gerar o resumo: {e}", "erro")
    return redirect(url_for("dash.acoes_view", aba="reunioes"))

# ---- Configurações do módulo (só admin) ----------------------------------
@bp.route("/acoes/areas", methods=["POST"])
@admin_obrigatorio
def acoes_area():
    f = request.form
    acao = f.get("acao") or "criar"
    try:
        if acao == "criar":
            acoes.criar_area(f.get("nome") or "")
            flash("Área criada.", "ok")
        elif acao == "renomear":
            acoes.renomear_area(f.get("area_id"), f.get("nome") or "")
            flash("Área renomeada.", "ok")
        else:
            # Desativar em vez de apagar: ação antiga precisa continuar
            # dizendo de que área ela era.
            acoes.definir_area_ativa(f.get("area_id"), acao == "ativar")
            flash("Área " + ("reativada." if acao == "ativar" else "desativada."), "ok")
    except Exception as e:
        flash(f"Erro: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/acoes/gestores", methods=["POST"])
@admin_obrigatorio
def acoes_gestor():
    f = request.form
    uid = (f.get("usuario_id") or "").strip()
    ids = [a for a in f.getlist("area_id") if a]
    if not uid or not ids:
        flash("Escolha o usuário e ao menos uma área.", "erro")
        return redirect(url_for("dash.configuracoes"))
    try:
        for area_id in ids:
            if f.get("acao") == "desvincular":
                acoes.desvincular_gestor(uid, area_id)
            else:
                acoes.vincular_gestor(uid, area_id)
        flash("Vínculo de gestor atualizado.", "ok")
    except Exception as e:
        flash(f"Erro: {e}", "erro")
    return redirect(url_for("dash.configuracoes"))


@bp.route("/acoes/<acao_id>/excluir", methods=["POST"])
@login_obrigatorio
def acao_excluir(acao_id):
    """Só apaga ação sem histórico — engano de digitação, não reescrita do
    passado. Ver `acoes.excluir`."""
    u = usuario_atual()
    _acao_ou_404(acao_id, u, exigir=acoes.pode_gerir)
    try:
        acoes.excluir(acao_id)
        flash("Ação apagada.", "ok")
        return redirect(url_for("dash.acoes_view", aba="acoes"))
    except Exception as e:
        flash(str(e), "erro")
        return redirect(url_for("dash.acao_detalhe", acao_id=acao_id))
