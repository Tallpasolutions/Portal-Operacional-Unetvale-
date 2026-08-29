"""Reuniões — gravação, transcrição, ata e resumo executivo.

Camada de dados do módulo **Ações** (CLAUDE.md §5). Não é módulo novo: não
tem rota de topo, não entra na sidebar, não aparece na navegação. A
reunião continua sendo a mesma entidade criada em `acoes.py`; o que mora
aqui é o áudio dela e o que sai do áudio.

O DESENHO EM UMA FRASE: quem orquestra é o navegador.

A Vercel é serverless — não existe processo em background, e o que não
terminar dentro da requisição não terminou. Então o navegador grava,
corta em trechos de ~2 minutos, sobe cada trecho direto para o Storage e
chama o Flask uma vez por trecho. Cada requisição faz uma coisa pequena e
fecha em segundos. Como efeito colateral bom, a transcrição acontece
DURANTE a reunião: ao encerrar, só falta o último trecho.

O que NÃO é feito por IA, de propósito:

  * contar em quantas reuniões uma ação apareceu — é consulta ao banco;
  * decidir o que é recorrente — é comparação de números;
  * formatar a ata — é `_markdown()` aqui embaixo, sempre igual.

O modelo transcreve e redige. Todo número que aparece na tela veio do
Postgres, e por isso não muda quando o modelo muda de humor.
"""
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

from . import acoes, ia, supa
from .acoes import _data

# ---------------------------------------------------------------- config
BUCKET = os.environ.get("REUNIAO_BUCKET", "reuniao-audio")
# Teto para mandar a transcrição CRUA. O que manda de verdade é o orçamento de
# tokens por minuto da conta (`ia.cabe`); este número é só um limite legível
# por cima dele.
#
# 🚨 O gargalo NÃO é o contexto do modelo (131k tokens), é a cota por minuto:
# 8000 no tier gratuito. Uma reunião de 60 min tem ~15.700 tokens de
# transcrição e nunca cabe numa chamada. Por isso o caminho pelas notas por
# trecho é o NORMAL aqui, não a exceção — e é o que justifica calculá-las
# durante a reunião, quando o trecho ainda está na mão.
ATA_MAX_CHARS = int(os.environ.get("REUNIAO_ATA_MAX_CHARS", "14000"))
AUDIO_DIAS = int(os.environ.get("REUNIAO_AUDIO_DIAS", "30"))

# Uma ação é "recorrente" quando voltou à mesa em pelo menos duas
# reuniões distintas. Uma menção só é a reunião em que ela nasceu.
MIN_REUNIOES_RECORRENTE = 2

EXTENSAO = {"audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3"}

STATUS = ("sem_gravacao", "gravando", "transcrevendo", "pronta", "erro")


def _falhou(onde, erro):
    print(f"[reuniao_ia] falha em {onde}: {erro}", file=sys.stderr)


def _agora():
    """Instante atual, COM fuso.

    🚨 `datetime.now()` devolve hora local ingênua (UTC-3 aqui). Numa coluna
    `timestamptz` o Postgres lê o valor sem fuso como se já fosse UTC, então
    todo carimbo do módulo ficava 3 horas no passado: a ata dizia ter sido
    gerada antes de a reunião acabar. As colunas com `default now()` sempre
    estiveram certas — o erro era só nos horários escritos pelo Python.
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------- gravação
def iniciar_gravacao(reuniao_id):
    """Marca o começo da captura.

    `consentimento_em` é gravado aqui e em nenhum outro lugar: é o
    registro de que a gravação começou por ato humano, com o aviso na
    tela, e não sozinha. Sem clique não existe linha.
    """
    supa.update("reunioes", {"id": reuniao_id}, {
        "gravacao_status": "gravando",
        "gravacao_iniciada_em": _agora(),
        "consentimento_em": _agora(),
        "gravacao_interrompida": False,
        "gravacao_erro": None,
    })


def parar_gravacao(reuniao_id):
    """Fecha a captura sem gerar a ata, e devolve o estado que sobrou.

    Existe porque "parar" e "gerar a ata" são coisas separadas: dá para parar
    no meio, olhar os trechos e gerar depois. Sem esta chamada a reunião ficava
    com `gravacao_status='gravando'` para sempre — a lista mostrava o selo
    vermelho de gravação em andamento em reunião que já tinha acabado.
    """
    lista = trechos(reuniao_id)
    if not lista:
        # Clicou em gravar e parou antes de qualquer trecho fechar: volta ao
        # estado inicial, em vez de deixar rastro de uma gravação que não houve.
        novo = "sem_gravacao"
    elif any(t["status"] == "ok" for t in lista):
        # Áudio transcrito, ata ainda não gerada.
        novo = "transcrevendo"
    else:
        novo = "erro"
    supa.update("reunioes", {"id": reuniao_id}, {"gravacao_status": novo})
    return novo


def autorizar_trecho(reuniao_id, indice, formato):
    """Reserva o lugar do trecho e devolve a URL de escrita para o browser.

    A linha nasce ANTES do upload, com status 'pendente'. Se o navegador
    morrer entre autorizar e enviar, fica o registro de que existiu um
    trecho que não chegou — silêncio seria pior, porque a transcrição
    sairia com um buraco que ninguém saberia explicar.
    """
    ext = EXTENSAO.get(formato, "webm")
    caminho = f"{reuniao_id}/{int(indice):04d}.{ext}"

    existente = supa.select_one("reuniao_audio", {
        "select": "id", "reuniao_id": f"eq.{reuniao_id}", "indice": f"eq.{indice}"})
    if existente:
        # Reenvio do mesmo trecho (rede oscilou). Sobrescreve o objeto e
        # zera o estado — em vez de criar um segundo registro que viraria
        # parágrafo repetido na transcrição.
        supa.update("reuniao_audio", {"id": existente["id"]}, {
            "caminho": caminho, "formato": formato,
            "status": "pendente", "erro": None})
    else:
        supa.insert("reuniao_audio", {
            "reuniao_id": reuniao_id, "indice": int(indice),
            "caminho": caminho, "formato": formato, "status": "pendente",
            "audio_expira_em": (datetime.now(timezone.utc) + timedelta(days=AUDIO_DIAS))
                               .isoformat(timespec="seconds"),
        })

    return {"caminho": caminho, "url": supa.storage_assinar_upload(BUCKET, caminho)}


def transcrever_trecho(reuniao_id, indice, bytes_=None, duracao_ms=None):
    """Baixa o trecho do Storage, manda para o Whisper, guarda o texto.

    As `notas` são calculadas no mesmo instante. Elas custam uma chamada
    barata agora e evitam ter de reprocessar a reunião inteira depois,
    quando a transcrição não couber no contexto do modelo.
    """
    trecho = supa.select_one("reuniao_audio", {
        "select": "id,caminho,formato,tentativas",
        "reuniao_id": f"eq.{reuniao_id}", "indice": f"eq.{indice}"})
    if not trecho:
        raise ValueError("Trecho não encontrado.")

    mudancas = {"tentativas": (trecho.get("tentativas") or 0) + 1}
    if bytes_ is not None:
        mudancas["bytes"] = int(bytes_)
    if duracao_ms is not None:
        mudancas["duracao_ms"] = int(duracao_ms)

    try:
        audio = supa.storage_baixar(BUCKET, trecho["caminho"])
        formato = trecho.get("formato") or "audio/webm"
        nome = trecho["caminho"].rsplit("/", 1)[-1]
        texto = ia.transcrever(audio, formato, nome)
    except Exception as e:
        # O áudio continua no Storage por 30 dias: a falha é recuperável e
        # a tela oferece "tentar de novo". Nada é descartado aqui.
        _falhou(f"transcrever_trecho({reuniao_id}, {indice})", e)
        mudancas.update({"status": "erro", "erro": str(e)[:500]})
        supa.update("reuniao_audio", {"id": trecho["id"]}, mudancas)
        raise

    mudancas.update({"status": "ok", "texto": texto, "erro": None})

    # As notas são seguro para reunião muito longa, e ficam num try próprio:
    # perder o resumo do trecho custa uma comodidade; perder a transcrição
    # custaria a reunião. Uma falha aqui não pode derrubar a outra.
    try:
        mudancas["notas"] = ia.notas_do_trecho(texto)
    except Exception as e:
        _falhou(f"notas_do_trecho({reuniao_id}, {indice})", e)

    supa.update("reuniao_audio", {"id": trecho["id"]}, mudancas)
    return texto


def trechos(reuniao_id):
    try:
        return supa.select("reuniao_audio", {
            "select": "id,indice,status,texto,notas,duracao_ms,bytes,erro,"
                      "tentativas,audio_apagado_em",
            "reuniao_id": f"eq.{reuniao_id}", "order": "indice.asc"})
    except Exception as e:
        _falhou("trechos", e)
        return []


def estado(reuniao_id, reuniao=None):
    """O que o polling da tela lê. Números, não adjetivos."""
    if reuniao is None:
        # Todos os chamadores de hoje já passam a reunião pronta. Este ramo é
        # rede de segurança, e usa `acoes.obter_reuniao` para herdar o mesmo
        # recuo de colunas de lá — em vez de repetir o `select` e voltar a
        # quebrar quando a migration 0006 ainda não tiver rodado.
        reuniao = acoes.obter_reuniao(reuniao_id) or {}
    lista = trechos(reuniao_id)
    ok = sum(1 for t in lista if t["status"] == "ok")
    erro = sum(1 for t in lista if t["status"] == "erro")
    return {
        "status": reuniao.get("gravacao_status") or "sem_gravacao",
        "total": len(lista),
        "ok": ok,
        "erro": erro,
        "pendentes": len(lista) - ok - erro,
        "pct": round(ok * 100 / len(lista)) if lista else 0,
        "interrompida": bool(reuniao.get("gravacao_interrompida")),
        "tem_ata": bool(reuniao.get("ata_markdown")),
        "erro_msg": reuniao.get("gravacao_erro"),
    }


# ------------------------------------------------------------------ ata
def _markdown(dados, reuniao, interrompida=False, parcial=False):
    """Estrutura -> Markdown. Determinístico, e é de propósito.

    O modelo devolve dados; a formatação é nossa. Assim toda ata sai com a
    mesma cara, e mudar o layout é mexer nesta função — não em prompt.
    """
    L = [f"# {reuniao.get('titulo') or 'Reunião'}",
         f"_{(reuniao.get('data') or '').replace('-', '/')}_", ""]

    if interrompida:
        L += ["> ⚠️ **Gravação interrompida.** Esta ata cobre apenas o áudio que "
              "chegou até o servidor. Pode faltar o final da reunião.", ""]

    if parcial:
        L += ["> ⚠️ **Reunião longa.** Não coube tudo no limite de tokens por "
              "minuto da conta, e parte do material ficou de fora desta ata. A "
              "transcrição completa continua guardada.", ""]

    if dados.get("resumo"):
        L += ["## Resumo", dados["resumo"], ""]

    def secao(titulo, chave, com_prazo=False):
        itens = [i for i in (dados.get(chave) or []) if (i or {}).get("texto")]
        if not itens:
            return
        L.append(f"## {titulo}")
        for i in itens:
            linha = f"- {i['texto']}"
            extras = []
            if com_prazo and i.get("responsavel"):
                extras.append(str(i["responsavel"]))
            if com_prazo and i.get("prazo"):
                extras.append(f"prazo {str(i['prazo']).replace('-', '/')}")
            if i.get("acao_codigo"):
                extras.append(str(i["acao_codigo"]))
            if extras:
                linha += f" _({' · '.join(extras)})_"
            L.append(linha)
        L.append("")

    pontos = [p for p in (dados.get("pontos") or []) if (p or {}).get("detalhe")]
    if pontos:
        L.append("## Pontos discutidos")
        for p in pontos:
            titulo = (p.get("titulo") or "").strip()
            L.append(f"- **{titulo}** — {p['detalhe']}" if titulo else f"- {p['detalhe']}")
        L.append("")

    secao("Decisões", "decisoes")
    secao("Encaminhamentos", "encaminhamentos", com_prazo=True)
    secao("Pendências", "pendencias")
    secao("Riscos", "riscos")

    L += ["---",
          "_Ata gerada automaticamente a partir da transcrição do áudio. "
          "Transcrição automática erra nome próprio e sigla — confira antes de usar._"]
    return "\n".join(L)


def _mapa_codigos():
    """codigo (AC-012) -> id da ação. Usado para ligar item de ata à ação."""
    try:
        linhas = supa.select("acoes", {"select": "id,codigo", "limit": "1000"})
        return {l["codigo"].upper(): l["id"] for l in linhas if l.get("codigo")}
    except Exception as e:
        _falhou("_mapa_codigos", e)
        return {}


def _texto_para_ata(lista):
    """Escolhe o que mandar ao modelo: transcrição crua, notas, ou notas cortadas.

    Três degraus, do melhor para o pior, e o critério é sempre "cabe na cota do
    minuto" — não a duração da reunião. Vinte minutos de discussão densa
    ocupam mais que quarenta de conversa arrastada.

    O terceiro degrau existe para reunião muito longa, e devolve `parcial=True`
    para que a ata saia CARIMBADA. Cortar em silêncio produziria uma ata que
    parece completa e ignora a segunda metade da reunião.
    """
    inteiro = "\n\n".join(t["texto"] for t in lista if t.get("texto"))
    if len(inteiro) <= ATA_MAX_CHARS and ia.cabe(inteiro, ia.MAX_TOKENS_ATA):
        return inteiro, "transcricao", False

    notas = "\n\n".join(t["notas"] for t in lista if t.get("notas"))
    if notas and ia.cabe(notas, ia.MAX_TOKENS_ATA):
        return notas, "notas", False

    base = notas or inteiro
    limite = int((ia.ORCAMENTO - ia.MAX_TOKENS_ATA) * ia.CHARS_POR_TOKEN)
    return base[:limite], ("notas" if notas else "transcricao"), len(base) > limite


def montar_ata(reuniao, usuario, interrompida=False):
    """Junta os trechos, gera a estrutura, grava ata e itens.

    Grava tudo ou não grava nada: se o modelo devolver algo que não é JSON
    válido, `ia.gerar_ata` levanta e nós não escrevemos ata nenhuma. Ata
    truncada registrada como oficial é pior do que ata que faltou.
    """
    reuniao_id = reuniao["id"]

    # As quatro leituras são independentes entre si e cada ida ao PostgREST
    # custa ~0,3s de latência. Em série somavam mais que a chamada ao modelo:
    # a ata parecia lenta por causa do banco, não da IA. `requests` solta o GIL
    # no I/O, então threads resolvem sem async no projeto inteiro.
    with ThreadPoolExecutor(max_workers=4) as pool:
        f_trechos = pool.submit(trechos, reuniao_id)
        f_pauta = pool.submit(acoes.pauta, reuniao, usuario, False)
        f_nomes = pool.submit(_nomes, reuniao.get("participantes") or [])
        f_antigos = pool.submit(_itens_soltos, reuniao_id)
        lista = [t for t in f_trechos.result() if t["status"] == "ok"]
        da_pauta = f_pauta.result()
        nomes = f_nomes.result()
        soltos = f_antigos.result()

    if not lista:
        raise ValueError(
            "Nenhum trecho foi transcrito ainda — não há texto de onde tirar a ata.")

    texto, origem, parcial = _texto_para_ata(lista)

    # A pauta serve a dois fins: os códigos que vão no prompt e o mapa
    # codigo->id que liga o item à ação. Buscar o mapa de novo com
    # `_mapa_codigos()` seria uma ida ao banco para reobter o que já está aqui.
    pauta = [(a["codigo"], a["titulo"]) for a in da_pauta]
    codigos = {a["codigo"].upper(): a["id"] for a in da_pauta if a.get("codigo")}

    # Não existe mais um update só para marcar "transcrevendo": ninguém lê esse
    # estado (o cliente fica esperando a resposta desta requisição), e ele
    # custava uma ida ao banco. Se o processo morrer aqui, a reunião fica em
    # `gravando` e o botão de resgate na tela resolve.
    try:
        dados = ia.gerar_ata(texto, pauta=pauta, participantes=nomes,
                             data_reuniao=reuniao.get("data"))
    except Exception as e:
        supa.update("reunioes", {"id": reuniao_id}, {
            "gravacao_status": "erro", "gravacao_erro": str(e)[:500]})
        raise

    markdown = _markdown(dados, reuniao, interrompida, parcial=parcial)
    transcricao = "\n\n".join(t["texto"] for t in lista if t.get("texto"))

    # Gravar a ata e gravar os itens não dependem um do outro: em série somavam
    # três idas ao banco esperando uma pela outra.
    def salvar_reuniao():
        supa.update("reunioes", {"id": reuniao_id}, {
            "transcricao": transcricao,
            "ata_markdown": markdown,
            "ata_gerada_em": _agora(),
            "ata_modelo": os.environ.get("GROQ_MODELO_TEXTO", ""),
            "gravacao_status": "pronta",
            "gravacao_interrompida": bool(interrompida),
            "gravacao_erro": None,
        })

    with ThreadPoolExecutor(max_workers=2) as pool:
        f = pool.submit(salvar_reuniao)
        _gravar_itens(reuniao_id, dados, _data(reuniao.get("data")), codigos, soltos)
        f.result()   # propaga a falha de gravar a ata, que é a que importa
    return markdown


def _itens_soltos(reuniao_id):
    """Ids dos itens que uma regeração pode apagar — os que ninguém aplicou.

    Item já aplicado virou comentário em `acao_eventos`, que é append-only:
    apagar a linha aqui deixaria o comentário órfão.
    """
    try:
        return [a["id"] for a in supa.select("reuniao_ata_itens", {
            "select": "id,aplicado_em", "reuniao_id": f"eq.{reuniao_id}"})
            if not a.get("aplicado_em")]
    except Exception as e:
        _falhou("_itens_soltos", e)
        return []


def _gravar_itens(reuniao_id, dados, data_reuniao=None, codigos=None, soltos=None):
    """Explode a estrutura em linhas — o que permite cruzar reuniões.

    Regerar a ata substitui os itens ANTES aplicados? Não: itens já
    aplicados numa ação viraram comentário em `acao_eventos`, que é
    append-only. Apagar a linha aqui deixaria o comentário órfão, então
    só os não aplicados são trocados.
    """
    # Uma requisição para limpar e uma para gravar, em vez de uma por item.
    if soltos is None:
        soltos = _itens_soltos(reuniao_id)
    if soltos:
        try:
            supa.delete("reuniao_ata_itens", {"id": soltos})
        except Exception as e:
            _falhou("_gravar_itens/limpeza", e)

    if codigos is None:
        codigos = _mapa_codigos()

    linhas, ordem = [], 0
    for chave, tipo in (("decisoes", "decisao"),
                        ("encaminhamentos", "encaminhamento"),
                        ("pendencias", "pendencia"),
                        ("riscos", "risco")):
        for item in (dados.get(chave) or []):
            if not (item or {}).get("texto"):
                continue
            codigo = (item.get("acao_codigo") or "").upper().strip()
            linhas.append({
                "reuniao_id": reuniao_id,
                "tipo": tipo,
                "texto": item["texto"],
                "prazo": _data_iso(item.get("prazo"), data_reuniao),
                # `responsavel_id` fica nulo de propósito: casar um nome vindo
                # de transcrição com um usuário do banco é chute, e chute aqui
                # atribui tarefa à pessoa errada. O nome falado continua
                # visível dentro do texto do item.
                "acao_id": codigos.get(codigo),
                "ordem": ordem,
            })
            ordem += 1

    if not linhas:
        return
    try:
        supa.insert("reuniao_ata_itens", linhas)   # lista = um POST só
    except Exception as e:
        # Um item com FK invalida derrubaria o lote inteiro. Cai para um a um
        # para nao perder os bons por causa de um ruim.
        _falhou("_gravar_itens/lote", e)
        for l in linhas:
            try:
                supa.insert("reuniao_ata_itens", l)
            except Exception as e2:
                _falhou("_gravar_itens/insert", e2)


def _data_iso(v, referencia=None):
    """Aceita só AAAA-MM-DD, e só perto da reunião. O resto vira None.

    Duas peneiras, cada uma por um motivo diferente:

    * formato — o modelo às vezes devolve "próxima terça". Gravar isso numa
      coluna `date` quebra o insert; interpretar seria adivinhar.
    * distância — mesmo com a data da reunião no prompt, ele já errou o ANO
      ("dia dez de setembro" virou 2023-09-10). Prazo combinado numa reunião
      não fica anos no passado nem décadas no futuro: fora da janela é
      alucinação, e é melhor ficar sem prazo do que com um prazo errado, que
      a tela mostraria como atraso de três anos.
    """
    if not v or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(v).strip()):
        return None
    try:
        d = date.fromisoformat(str(v).strip())
    except ValueError:
        return None

    base = referencia or date.today()
    if not (base - timedelta(days=365) <= d <= base + timedelta(days=365 * 3)):
        _falhou("_data_iso", f"prazo {d} fora da janela de {base} — descartado")
        return None
    return d.isoformat()


def itens(reuniao_id):
    try:
        # `acoes(codigo,titulo)` é embed do PostgREST pela FK: traz o código
        # da ação junto, para o botão poder dizer "Registrar na AC-012" em vez
        # de mostrar um uuid que não significa nada para quem lê.
        return supa.select("reuniao_ata_itens", {
            "select": "id,tipo,texto,prazo,acao_id,aplicado_em,aplicado_por,"
                      "ordem,acoes(codigo,titulo)",
            "reuniao_id": f"eq.{reuniao_id}", "order": "ordem.asc"})
    except Exception as e:
        _falhou("itens", e)
        return []


def aplicar_item(item_id, usuario_id):
    """Item da ata -> comentário na linha do tempo da ação.

    Só por clique humano. `acao_eventos` é append-only por trigger: nem a
    service_role apaga. Texto de IA que entrasse sozinho lá seria
    irreversível, e ninguém revisa o que já está escrito em pedra.
    """
    item = supa.select_one("reuniao_ata_itens", {
        "select": "id,texto,acao_id,reuniao_id,aplicado_em", "id": f"eq.{item_id}"})
    if not item:
        raise ValueError("Item não encontrado.")
    if item.get("aplicado_em"):
        raise ValueError("Este item já foi registrado na ação.")
    if not item.get("acao_id"):
        raise ValueError("Este item não está ligado a nenhuma ação.")

    acoes.comentar(item["acao_id"], usuario_id,
                   f"[da ata] {item['texto']}", reuniao_id=item["reuniao_id"])
    supa.update("reuniao_ata_itens", {"id": item_id}, {
        "aplicado_em": _agora(), "aplicado_por": usuario_id})


# ------------------------------------------- recorrência e resumo executivo
def _nomes(ids):
    if not ids:
        return []
    try:
        linhas = supa.select("usuarios", {
            "select": "id,nome,email", "id": f"in.({','.join(ids)})"})
        return [(l.get("nome") or l.get("email") or "") for l in linhas]
    except Exception as e:
        _falhou("_nomes", e)
        return []


def _mencoes_por_acao(excluir_reuniao=None):
    """{acao_id: set(reuniao_id)} — em quantas reuniões distintas cada ação apareceu.

    Conta as duas formas de uma ação entrar numa reunião: item extraído da
    ata e comentário que o gestor registrou na própria reunião. Contar só
    uma delas subestimaria justamente as reuniões sem gravação.
    """
    mapa = {}

    def somar(acao_id, reuniao_id):
        if not acao_id or not reuniao_id or reuniao_id == excluir_reuniao:
            return
        mapa.setdefault(acao_id, set()).add(reuniao_id)

    try:
        for i in supa.select("reuniao_ata_itens", {
                "select": "acao_id,reuniao_id", "acao_id": "not.is.null",
                "limit": "1000"}):
            somar(i.get("acao_id"), i.get("reuniao_id"))
    except Exception as e:
        _falhou("_mencoes_por_acao/itens", e)

    try:
        for e_ in supa.select("acao_eventos", {
                "select": "acao_id,reuniao_id", "tipo": "eq.comentario",
                "reuniao_id": "not.is.null", "limit": "1000"}):
            somar(e_.get("acao_id"), e_.get("reuniao_id"))
    except Exception as e:
        _falhou("_mencoes_por_acao/eventos", e)

    return mapa


def recorrentes_pendentes(acao_ids=None, excluir_reuniao=None):
    """Ações que voltaram à mesa e continuam abertas.

    Regra fechada, sem IA: apareceu em >= 2 reuniões distintas E o status
    não é Concluída nem Cancelada. Sai sempre igual e é conferível na mão.
    """
    mencoes = _mencoes_por_acao(excluir_reuniao)
    alvos = {a: r for a, r in mencoes.items()
             if len(r) >= MIN_REUNIOES_RECORRENTE
             and (acao_ids is None or a in set(acao_ids))}
    if not alvos:
        return []

    try:
        lista = supa.select("acoes", {
            "select": "id,codigo,titulo,status,progresso,prazo,responsavel_id",
            "id": f"in.({','.join(alvos)})"})
    except Exception as e:
        _falhou("recorrentes_pendentes", e)
        return []

    saida = [dict(a, reunioes=len(alvos[a["id"]]))
             for a in lista if a["status"] not in acoes.TERMINAIS]
    saida.sort(key=lambda a: (-a["reunioes"], a["codigo"]))
    return saida


def contexto_anterior(reuniao, usuario):
    """O que já foi discutido antes, recortado às ações desta pauta."""
    try:
        da_pauta = [a["id"] for a in acoes.pauta(reuniao, usuario)]
    except Exception as e:
        _falhou("contexto_anterior", e)
        return []
    return recorrentes_pendentes(acao_ids=da_pauta, excluir_reuniao=reuniao["id"])


def _fatos(lista):
    """Os fatos que o modelo pode usar — e só eles."""
    linhas = []
    for a in lista:
        p = f", prazo {a['prazo'].replace('-', '/')}" if a.get("prazo") else ", sem prazo"
        linhas.append(
            f"- {a['codigo']} — {a['titulo']}: discutida em {a['reunioes']} reuniões; "
            f"status {a['status']}; progresso {a.get('progresso', 0)}%{p}.")
    return "\n".join(linhas)


def resumo_executivo(escopo="geral", ref_id=None, lista=None):
    """Devolve o resumo salvo; regera só quando surgiu item novo.

    Regerar a cada abertura de tela gastaria cota do plano gratuito e faria
    o texto mudar de redação sem que nenhum fato tivesse mudado — o que
    passa a impressão de instabilidade.
    """
    if lista is None:
        lista = recorrentes_pendentes()
    if not lista:
        return None

    filtro = {"select": "id,markdown,gerado_em,base_ate,modelo",
              "escopo": f"eq.{escopo}"}
    filtro["ref_id"] = f"eq.{ref_id}" if ref_id else "is.null"
    try:
        return supa.select_one("resumo_executivo", filtro)
    except Exception as e:
        _falhou("resumo_executivo", e)
        return None


def gerar_resumo_executivo(escopo="geral", ref_id=None):
    lista = recorrentes_pendentes()
    if not lista:
        raise ValueError("Nenhuma ação recorrente pendente — não há o que resumir.")

    markdown = ia.texto_executivo(_fatos(lista))
    registro = {"escopo": escopo, "ref_id": ref_id, "markdown": markdown,
                "modelo": os.environ.get("GROQ_MODELO_TEXTO", ""),
                "gerado_em": _agora(), "base_ate": _agora()}

    atual = resumo_executivo(escopo, ref_id, lista=lista)
    if atual:
        supa.update("resumo_executivo", {"id": atual["id"]}, registro)
    else:
        supa.insert("resumo_executivo", registro)
    return markdown


# --------------------------------------------------------------- expurgo
def expurgar_audio(limite=20):
    """Apaga o áudio vencido. Transcrição e ata NÃO são tocadas.

    Roda de carona na abertura da aba Reuniões, em vez de num cron: a
    Vercel não tem processo residente e um agendador seria infra nova para
    apagar meia dúzia de arquivos. O limite por chamada existe para que o
    expurgo nunca segure a tela.
    """
    try:
        vencidos = supa.select("reuniao_audio", {
            "select": "id,caminho",
            "audio_expira_em": f"lt.{_agora()}",
            "audio_apagado_em": "is.null",
            "order": "audio_expira_em.asc", "limit": str(limite)})
    except Exception as e:
        _falhou("expurgar_audio/select", e)
        return 0

    apagados = 0
    for v in vencidos:
        try:
            supa.storage_apagar(BUCKET, v["caminho"])
            supa.update("reuniao_audio", {"id": v["id"]},
                        {"audio_apagado_em": _agora()})
            apagados += 1
        except Exception as e:
            _falhou(f"expurgar_audio({v['caminho']})", e)
    return apagados


# ------------------------------------------------------- Markdown -> HTML
# Não entra biblioteca de Markdown por uma razão simples: o Markdown que
# renderizamos foi escrito por `_markdown()` aqui em cima, então o dialeto é
# conhecido e minúsculo. Uma dependência a mais na função serverless para
# converter seis construções seria peso sem contrapartida.
#
# O texto passa por escape ANTES de qualquer conversão. Ele vem de
# transcrição, ou seja, de fala de terceiros: tratar como HTML confiável
# seria abrir XSS pela porta da frente.
def para_html(md):
    from html import escape

    if not md:
        return ""

    def inline(t):
        t = escape(t)
        t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
        t = re.sub(r"_(.+?)_", r"<em>\1</em>", t)
        return t

    saida, lista, paragrafo = [], False, []

    def fechar_paragrafo():
        if paragrafo:
            saida.append("<p>" + " ".join(paragrafo) + "</p>")
            paragrafo.clear()

    def fechar_lista():
        nonlocal lista
        if lista:
            saida.append("</ul>")
            lista = False

    for linha in md.splitlines():
        crua = linha.strip()
        if not crua:
            fechar_paragrafo(); fechar_lista(); continue
        if crua == "---":
            fechar_paragrafo(); fechar_lista(); saida.append("<hr>"); continue
        if crua.startswith("## "):
            fechar_paragrafo(); fechar_lista()
            saida.append(f"<h4>{inline(crua[3:])}</h4>"); continue
        if crua.startswith("# "):
            fechar_paragrafo(); fechar_lista()
            saida.append(f"<h3>{inline(crua[2:])}</h3>"); continue
        if crua.startswith("> "):
            fechar_paragrafo(); fechar_lista()
            saida.append(f"<blockquote>{inline(crua[2:])}</blockquote>"); continue
        if crua.startswith("- "):
            fechar_paragrafo()
            if not lista:
                saida.append("<ul>"); lista = True
            saida.append(f"<li>{inline(crua[2:])}</li>"); continue
        fechar_lista()
        paragrafo.append(inline(crua))

    fechar_paragrafo(); fechar_lista()
    return "\n".join(saida)


def resumo_curto(md, limite=180):
    """Primeiras linhas do resumo, para a lista de reuniões.

    Recorta o parágrafo que vem sob '## Resumo' — não o começo do arquivo,
    que seria o título e a data, coisas que a lista já mostra.
    """
    if not md:
        return ""
    linhas = md.splitlines()
    try:
        i = next(n for n, l in enumerate(linhas) if l.strip() == "## Resumo")
    except StopIteration:
        return ""
    partes = []
    for l in linhas[i + 1:]:
        # Para na próxima seção: sem isso o "resumo" da lista emendaria as
        # decisões, e a linha da tabela viraria um parágrafo sem sentido.
        if l.startswith("#"):
            break
        if l.strip():
            partes.append(l.strip())
    texto = " ".join(partes)
    return texto[:limite] + ("…" if len(texto) > limite else "")


def itens_da_acao(acao_id, limite=30):
    """Tudo que as atas já registraram sobre esta ação, do mais recente.

    É o que responde, na página da ação, "quantas vezes já falamos disso" —
    sem precisar abrir reunião por reunião.
    """
    try:
        return supa.select("reuniao_ata_itens", {
            "select": "id,tipo,texto,prazo,criado_em,aplicado_em,"
                      "reunioes(id,titulo,data)",
            "acao_id": f"eq.{acao_id}", "order": "criado_em.desc",
            "limit": str(limite)})
    except Exception as e:
        _falhou("itens_da_acao", e)
        return []
