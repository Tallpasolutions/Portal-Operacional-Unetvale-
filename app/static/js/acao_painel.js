// Ação — painel lateral do quadro e página cheia.
//
// Um arquivo para as duas molduras porque o conteúdo é o mesmo parcial
// (`_acao_painel.html`). Três peças:
//   * `AcaoMover`  — o diálogo de troca de status (arrasto no quadro e
//                    seletor do painel usam o mesmo);
//   * `ligar()`    — o comportamento de um contêiner com a ação dentro;
//   * `AcaoGaveta` — abrir/fechar o painel lateral, com o estado na URL.
//
// O contêiner é SUBSTITUÍDO inteiro depois de cada gravação (o servidor
// devolve o parcial de novo). Por isso todo ouvinte é delegado no
// contêiner: preso a um nó de dentro, morreria na primeira gravação.
(function () {
  "use strict";

  const TERMINAIS = ["Concluída", "Cancelada"];

  function hojeISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  // Fetch com JSON nos dois sentidos. Erro vira Error com a mensagem que o
  // servidor mandou (a regra de negócio explica o que falta); sem mensagem,
  // diz o que se sabe pelo status.
  async function postJSON(url, corpo) {
    let r;
    try {
      r = await fetch(url, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(corpo || {}),
      });
    } catch (e) {
      throw new Error("Sem conexão. Nada foi salvo.");
    }
    let dados = null;
    try { dados = await r.json(); } catch (e) { /* login expirado devolve HTML */ }
    if (!r.ok || !dados || dados.erro) {
      const msg = (dados && dados.erro)
        || (r.status === 404 ? "Ação não encontrada."
          : r.status === 403 ? "Você não pode alterar esta ação."
          : !dados ? "Sua sessão expirou. Recarregue a página."
          : "Não foi possível salvar. Tente de novo.");
      throw new Error(msg);
    }
    return dados;
  }

  // ---------------------------------------------------------------------
  // Diálogo de troca de status
  // ---------------------------------------------------------------------
  const AcaoMover = (function () {
    const dlg = document.getElementById("dlg-mover");
    if (!dlg) return { abrir: () => Promise.resolve(null) };
    const form = dlg.querySelector("[data-form-mover]");
    const q = (s) => dlg.querySelector(s);
    const campo = (n) => form.elements[n];
    let atual = null;   // { acao, status, resolve }

    function fechar(resultado) {
      const a = atual;
      atual = null;
      if (dlg.open) dlg.close();
      if (a) a.resolve(resultado);
    }

    function exigePasso() {
      return atual && atual.acao.atrasada && !TERMINAIS.includes(atual.status);
    }

    // `acao` precisa de: id, codigo, titulo, status (o de ANTES), atrasada,
    // evidencia, proximo_passo, chk_total, chk_feitos.
    function abrir(acao, novoStatus) {
      if (atual) fechar(null);
      return new Promise((resolve) => {
        atual = { acao, status: novoStatus, resolve };
        form.reset();
        q("[data-m-codigo]").textContent = acao.codigo;
        q("[data-m-titulo]").textContent = acao.titulo || "";
        q("[data-m-de]").textContent = acao.status;
        q("[data-m-para]").textContent = novoStatus;
        q("[data-m-erro]").textContent = "";

        const concluindo = novoStatus === "Concluída";
        q("[data-m-conclusao]").hidden = !concluindo;
        campo("evidencia").value = acao.evidencia || "";
        campo("data_conclusao").value = hojeISO();

        // Aviso, não trava: concluir com item aberto é decisão de quem
        // conclui (o item pode ter perdido o sentido). Mas não pode ser
        // descuido — por isso aparece aqui, na hora de decidir.
        const abertos = (acao.chk_total || 0) - (acao.chk_feitos || 0);
        const aviso = q("[data-m-chk]");
        aviso.hidden = !(concluindo && abertos > 0);
        aviso.textContent = abertos === 1
          ? "1 item do checklist está em aberto. A ação fica com 100% mesmo assim."
          : abertos + " itens do checklist estão em aberto. A ação fica com 100% mesmo assim.";

        q("[data-m-passo]").hidden = !exigePasso();
        campo("proximo_passo").value = acao.proximo_passo || "";

        q("[data-m-ok]").disabled = false;
        q("[data-m-ok]").textContent = novoStatus === "Cancelada" ? "Cancelar a ação" : "Mover";
        dlg.showModal();
        (concluindo ? campo("evidencia") : exigePasso() ? campo("proximo_passo") : campo("texto")).focus();
      });
    }

    q("[data-m-cancelar]").addEventListener("click", () => fechar(null));
    // Esc: o <dialog> fecharia sozinho, sem resolver a promessa — e o cartão
    // ficaria na coluna nova sem o servidor saber.
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); fechar(null); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) fechar(null); });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!atual) return;
      const erro = q("[data-m-erro]");
      const concluindo = atual.status === "Concluída";
      const evidencia = campo("evidencia").value.trim();
      const passo = campo("proximo_passo").value.trim();
      if (concluindo && !evidencia) {
        erro.textContent = "Para concluir, informe a evidência (link, documento ou referência).";
        campo("evidencia").focus();
        return;
      }
      if (exigePasso() && !passo) {
        erro.textContent = "Ação atrasada exige um próximo passo definido.";
        campo("proximo_passo").focus();
        return;
      }
      const corpo = { status: atual.status, texto: campo("texto").value.trim() };
      if (concluindo) {
        corpo.evidencia = evidencia;
        corpo.data_conclusao = campo("data_conclusao").value || null;
      }
      if (exigePasso()) corpo.proximo_passo = passo;

      const btn = q("[data-m-ok]");
      btn.disabled = true;
      btn.textContent = "Salvando…";
      try {
        const r = await postJSON("/acoes/" + atual.acao.id + "/mover", corpo);
        fechar(r.acao);
      } catch (err) {
        // O diálogo fica aberto com a mensagem: quase sempre é algo que dá
        // para corrigir ali mesmo (evidência, próximo passo).
        erro.textContent = err.message;
        btn.disabled = false;
        btn.textContent = "Mover";
      }
    });

    return { abrir };
  })();
  window.AcaoMover = AcaoMover;

  // ---------------------------------------------------------------------
  // Comportamento de um contêiner com a ação dentro
  // ---------------------------------------------------------------------
  function dadosDaAcao(cont) {
    const el = cont.querySelector("[data-acao-painel]");
    if (!el) return null;
    const d = el.dataset;
    return {
      id: d.id, codigo: d.codigo, titulo: d.titulo, status: d.status,
      atrasada: d.atrasada === "1", evidencia: d.evidencia,
      proximo_passo: d.proximoPasso, chk_total: +d.chkTotal || 0,
      chk_feitos: +d.chkFeitos || 0, url: d.url, urlPainel: d.urlPainel,
    };
  }

  function ajustarAltura(t) {
    t.style.height = "auto";
    t.style.height = t.scrollHeight + "px";
  }

  function preparar(cont) {
    cont.querySelectorAll("textarea.editavel, textarea.acao-p-titulo").forEach((t) => {
      t.dataset.orig = t.value;
      ajustarAltura(t);
    });
  }

  // opcoes: { modo: 'gaveta'|'pagina', aoMudar(item), aoFechar() }
  function ligar(cont, opcoes) {
    let avisoTimer = null;

    function aviso(texto, erro) {
      const el = cont.querySelector("[data-salvo]");
      if (!el) return;
      el.textContent = texto;
      el.classList.toggle("erro", !!erro);
      clearTimeout(avisoTimer);
      if (!erro) avisoTimer = setTimeout(() => { el.textContent = ""; }, 2200);
    }

    function notificar(item) {
      if (item && opcoes.aoMudar) opcoes.aoMudar(item);
    }

    // Recarrega o parcial preservando a rolagem — quem marcou o 4º item do
    // checklist não quer voltar para o topo — e o que estiver sendo DIGITADO
    // no novo item ou na caixa de atividade: trocar o HTML no meio da frase
    // jogaria fora o que a pessoa escreveu enquanto a gravação anterior ia.
    async function recarregar(item, focar) {
      const a = dadosDaAcao(cont);
      if (!a) return;
      const rolador = cont.closest(".gaveta") || document.scrollingElement;
      const topo = rolador.scrollTop;
      const PRESERVAR = ["[data-chk-novo] input", "[data-compositor] textarea"];
      const manter = PRESERVAR.map((sel) => {
        const el = cont.querySelector(sel);
        return el && el.value ? { sel, valor: el.value } : null;
      }).filter(Boolean);
      const ativo = document.activeElement;
      const selAtivo = ativo && cont.contains(ativo) ? PRESERVAR.find((sel) => ativo.matches(sel)) : null;
      const url = a.urlPainel + (opcoes.modo === "pagina" ? "?modo=pagina" : "");
      try {
        const r = await fetch(url, { credentials: "same-origin" });
        if (!r.ok) throw new Error();
        cont.innerHTML = await r.text();
      } catch (e) {
        aviso("Salvo, mas não consegui recarregar. Atualize a página.", true);
        return;
      }
      preparar(cont);
      for (const m of manter) {
        const el = cont.querySelector(m.sel);
        if (el) el.value = m.valor;
      }
      rolador.scrollTop = topo;
      notificar(item);
      const sel = selAtivo || focar;
      const alvo = sel ? cont.querySelector(sel) : null;
      if (alvo) alvo.focus({ preventScroll: true });
    }

    async function salvarCampo(campo, valor, el, recarregarDepois) {
      const a = dadosDaAcao(cont);
      if (el) el.classList.add("salvando");
      try {
        const r = await postJSON(a.url + "/campo", { campo, valor });
        if (el && "orig" in el.dataset) el.dataset.orig = el.value;
        aviso("Salvo");
        // Texto longo NÃO recarrega o painel: a pessoa já pode estar
        // escrevendo no campo seguinte, e trocar o HTML roubaria o foco.
        if (recarregarDepois) await recarregar(r.acao);
        else notificar(r.acao);
      } catch (err) {
        aviso(err.message, true);
        if (el && "orig" in el.dataset) { el.value = el.dataset.orig; }
      } finally {
        if (el) el.classList.remove("salvando");
      }
    }

    // Checklist em FILA, e o painel só recarrega quando ela esvazia. Quem
    // escreve checklist escreve cinco itens em seguida, ou marca três de uma
    // vez; recarregar entre um e outro trocaria o HTML debaixo do dedo. A
    // ordem das gravações é a do clique — o item 2 não passa na frente do 1.
    let fila = Promise.resolve();
    let pendentes = 0;
    let ultimoItem = null;
    let erroFila = null;
    function checklist(op, extra, focar) {
      pendentes++;
      fila = fila.then(async () => {
        const a = dadosDaAcao(cont);
        try {
          const r = await postJSON(a.url + "/checklist", Object.assign({ op }, extra));
          ultimoItem = r.acao;
        } catch (err) {
          erroFila = err.message;
        }
        pendentes--;
        if (pendentes === 0) {
          await recarregar(ultimoItem, focar);
          if (erroFila) aviso(erroFila, true);
          ultimoItem = null;
          erroFila = null;
        }
      });
      return fila;
    }

    function esc(t) {
      return String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    function etiquetasAtuais() {
      return [...cont.querySelectorAll("[data-etiquetas] .etiqueta")].map((e) => e.dataset.valor);
    }

    function adicionarEtiqueta(input) {
      const v = input.value.trim();
      if (!v) return;
      const atuais = etiquetasAtuais();
      input.value = "";
      if (atuais.some((t) => t.toLowerCase() === v.toLowerCase())) return;
      salvarCampo("etiquetas", atuais.concat([v]), null, true);
    }

    cont.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-fechar-gaveta]")) { if (opcoes.aoFechar) opcoes.aoFechar(); return; }

      if (t.closest("[data-copiar-link]")) {
        const a = dadosDaAcao(cont);
        const link = location.origin + "/acoes?aba=acoes&acao=" + encodeURIComponent(a.codigo);
        const ok = () => aviso("Link copiado");
        if (navigator.clipboard) navigator.clipboard.writeText(link).then(ok, () => aviso(link));
        else aviso(link);
        return;
      }

      const chip = t.closest("[data-filtro-atividade] .fchip");
      if (chip) {
        chip.parentElement.querySelectorAll(".fchip").forEach((c) => c.classList.toggle("on", c === chip));
        const f = chip.dataset.f;
        cont.querySelectorAll("[data-lista-atividade] .evento").forEach((ev) => {
          ev.style.display = !f || ev.dataset.tipo === f ? "" : "none";
        });
        return;
      }

      const tipoBtn = t.closest("[data-tipo-compositor] button");
      if (tipoBtn) {
        const form = tipoBtn.closest("[data-compositor]");
        form.dataset.tipo = tipoBtn.dataset.tipo;
        tipoBtn.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === tipoBtn));
        const ta = form.querySelector("textarea");
        ta.placeholder = tipoBtn.dataset.tipo === "comentario"
          ? "Consideração, decisão ou cobrança."
          : "O que mudou? Ex.: versão preliminar consolidada, falta validar com o supervisor.";
        ta.focus();
        return;
      }

      const apagar = t.closest("[data-chk-apagar]");
      if (apagar) {
        checklist("apagar", { item_id: apagar.closest("[data-item]").dataset.item });
        return;
      }

      const tirar = t.closest("[data-tirar-etiqueta]");
      if (tirar) {
        const v = tirar.closest(".etiqueta").dataset.valor;
        salvarCampo("etiquetas", etiquetasAtuais().filter((x) => x !== v), null, true);
        return;
      }

      const dlgEx = cont.querySelector("[data-dlg-excluir]");
      if (t.closest("[data-abrir-excluir]") && dlgEx) { dlgEx.showModal(); return; }
      if (dlgEx && (t === dlgEx || t.closest("[data-fechar]"))) { dlgEx.close(); return; }
      if (t.closest("[data-confirmar-excluir]")) {
        dlgEx.close();
        cont.querySelector("[data-form-excluir]").submit();
      }
    });

    cont.addEventListener("change", (e) => {
      const t = e.target;

      if (t.matches("[data-mudar-status]")) {
        const a = dadosDaAcao(cont);
        const novo = t.value;
        t.value = a.status;   // só muda de verdade se o diálogo confirmar
        AcaoMover.abrir(a, novo).then((item) => { if (item) recarregar(item); });
        return;
      }

      if (t.matches("[data-chk-marcar]")) {
        checklist(t.checked ? "marcar" : "desmarcar", { item_id: t.closest("[data-item]").dataset.item });
        return;
      }

      if (t.matches("select[data-campo], input[type=date][data-campo]")) {
        salvarCampo(t.dataset.campo, t.value || null, null, true);
        return;
      }

      if (t.matches("[data-nova-etiqueta]")) {
        // `change` é o que o datalist dispara ao escolher uma sugestão.
        adicionarEtiqueta(t);
      }
    });

    // Apoio: grava quando o dropdown FECHA, não a cada caixa marcada —
    // recarregar o painel no meio da escolha fecharia a lista na cara de
    // quem ainda está marcando. `toggle` não borbulha, daí a captura.
    cont.addEventListener("toggle", (e) => {
      const dd = e.target;
      if (!dd.matches || !dd.matches("[data-apoio]") || dd.open) return;
      const marcados = [...dd.querySelectorAll("input[type=checkbox]")].filter((c) => c.checked).map((c) => c.value);
      const antes = dd.dataset.orig;
      const agora = marcados.slice().sort().join(",");
      if (antes === undefined || antes === agora) return;
      salvarCampo("apoio_ids", marcados, null, true);
    }, true);
    cont.addEventListener("toggle", (e) => {
      const dd = e.target;
      if (dd.matches && dd.matches("[data-apoio]") && dd.open) {
        dd.dataset.orig = [...dd.querySelectorAll("input:checked")].map((c) => c.value).sort().join(",");
      }
    }, true);
    // Clique fora fecha o dropdown de apoio — é o que dispara a gravação.
    document.addEventListener("click", (e) => {
      cont.querySelectorAll("details[data-apoio][open]").forEach((dd) => {
        if (!dd.contains(e.target)) dd.open = false;
      });
    });

    cont.addEventListener("focusout", (e) => {
      const t = e.target;
      if (t.matches("textarea[data-campo]") && t.value !== t.dataset.orig) {
        salvarCampo(t.dataset.campo, t.value, t, false);
      }
    });

    cont.addEventListener("input", (e) => {
      const t = e.target;
      if (t.matches("textarea.editavel, textarea.acao-p-titulo")) ajustarAltura(t);
      if (t.matches("input[type=range][name=progresso]")) {
        const lbl = t.closest("form").querySelector("[data-rotulo-prog]");
        if (lbl) lbl.textContent = t.value + "%";
      }
    });

    cont.addEventListener("keydown", (e) => {
      const t = e.target;
      // Título é uma linha lógica: Enter confirma, não quebra.
      if (t.matches("textarea.acao-p-titulo") && e.key === "Enter") { e.preventDefault(); t.blur(); }
      if (t.matches("textarea.editavel") && e.key === "Escape") {
        t.value = t.dataset.orig; ajustarAltura(t); t.blur(); e.stopPropagation();
      }
      if (t.matches("[data-nova-etiqueta]") && e.key === "Enter") { e.preventDefault(); adicionarEtiqueta(t); }
      if (t.closest("[data-compositor]") && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); t.closest("form").requestSubmit();
      }
    });

    cont.addEventListener("submit", async (e) => {
      const form = e.target;

      if (form.matches("[data-chk-novo]")) {
        e.preventDefault();
        const campo = form.elements.texto;
        const texto = campo.value.trim();
        if (!texto) return;
        // O campo NÃO trava: o item aparece na hora (esmaecido até gravar) e
        // o campo já está livre para o próximo. Travado, o que se digitava
        // durante a gravação caía num campo desabilitado e sumia — medido no
        // ensaio de 29/09/2026: de três itens digitados em seguida, entrou um.
        campo.value = "";
        const ul = cont.querySelector(".checklist");
        if (ul) {
          ul.insertAdjacentHTML("beforeend", '<li class="pendente"><label><input type="checkbox" disabled>'
            + '<span class="chk-texto">' + esc(texto) + "</span></label></li>");
        }
        checklist("criar", { texto }, "[data-chk-novo] input");
        return;
      }

      if (form.matches("[data-compositor]")) {
        e.preventDefault();
        const a = dadosDaAcao(cont);
        const tipo = form.dataset.tipo;
        const texto = form.elements.texto.value.trim();
        const erro = form.querySelector("[data-erro]");
        erro.textContent = "";
        if (!texto) { erro.textContent = "Escreva o que houve."; form.elements.texto.focus(); return; }
        const corpo = { texto };
        if (tipo === "atualizacao") {
          if (form.elements.progresso) corpo.progresso = form.elements.progresso.value;
          if (form.elements.proximo_passo) corpo.proximo_passo = form.elements.proximo_passo.value;
        }
        const btn = form.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          const r = await postJSON(a.url + (tipo === "comentario" ? "/comentar" : "/atualizar"), corpo);
          await recarregar(r.acao);
          aviso(tipo === "comentario" ? "Comentário registrado" : "Atualização registrada");
        } catch (err) {
          erro.textContent = err.message;
          btn.disabled = false;
        }
      }
    });

    preparar(cont);
    return { recarregar };
  }

  // ---------------------------------------------------------------------
  // Página cheia
  // ---------------------------------------------------------------------
  const pagina = document.querySelector(".acao-pagina[data-acao-contenedor]");
  if (pagina) ligar(pagina, { modo: "pagina" });

  // ---------------------------------------------------------------------
  // Painel lateral (só na página do quadro)
  // ---------------------------------------------------------------------
  const gaveta = document.getElementById("gaveta");
  if (!gaveta) return;
  const fundo = document.getElementById("gaveta-fundo");
  const corpo = gaveta.querySelector("[data-acao-contenedor]");
  let abertaId = null;
  let pedido = 0;

  function urlCom(codigo) {
    const u = new URL(location.href);
    if (codigo) { u.searchParams.set("acao", codigo); u.searchParams.set("aba", "acoes"); }
    else u.searchParams.delete("acao");
    return u;
  }

  function avisarQuadro(nome, id) {
    document.dispatchEvent(new CustomEvent(nome, { detail: { id } }));
  }

  async function abrir(id, empurrar) {
    const meu = ++pedido;
    abertaId = id;
    gaveta.hidden = false;
    fundo.hidden = false;
    // Força o layout antes de pôr a classe, para a transição acontecer.
    // (Não é rAF: com o painel do navegador oculto, rAF não roda — §6.)
    void gaveta.offsetWidth;
    gaveta.classList.add("aberta");
    document.body.classList.add("gaveta-aberta");
    corpo.innerHTML = '<div class="gaveta-carregando">Carregando…</div>';
    avisarQuadro("gavetaaberta", id);
    let html;
    try {
      const r = await fetch("/acoes/" + encodeURIComponent(id) + "/painel", { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status);
      html = await r.text();
    } catch (e) {
      if (meu === pedido) corpo.innerHTML = '<div class="gaveta-carregando">Ação não encontrada.</div>';
      return;
    }
    if (meu !== pedido) return;   // outro cartão foi clicado no meio
    corpo.innerHTML = html;
    preparar(corpo);
    gaveta.scrollTop = 0;
    const a = dadosDaAcao(corpo);
    if (empurrar !== false && a && new URL(location.href).searchParams.get("acao") !== a.codigo) {
      // push, não replace: o "voltar" do navegador fecha o painel, que é o
      // que a pessoa espera de algo que abriu por cima.
      history.pushState({ acao: a.codigo }, "", urlCom(a.codigo));
    }
    const foco = corpo.querySelector("[data-fechar-gaveta]");
    if (foco) foco.focus({ preventScroll: true });
  }

  function fechar(empurrar) {
    if (!abertaId) return;
    const id = abertaId;
    abertaId = null;
    pedido++;
    gaveta.classList.remove("aberta");
    fundo.hidden = true;
    document.body.classList.remove("gaveta-aberta");
    setTimeout(() => { if (!abertaId) { gaveta.hidden = true; corpo.innerHTML = ""; } }, 220);
    if (empurrar !== false && new URL(location.href).searchParams.get("acao")) {
      history.pushState({}, "", urlCom(null));
    }
    avisarQuadro("gavetafechada", id);
    const cartao = document.querySelector('.cartao-k[data-id="' + id + '"], tr[data-id="' + id + '"]');
    if (cartao) cartao.focus({ preventScroll: true });
  }

  function idPorCodigo(codigo) {
    const lista = (window.__ACOES__ && window.__ACOES__.acoes) || [];
    const achada = lista.find((a) => a.codigo === codigo);
    return achada ? achada.id : null;
  }

  function abrirPorCodigo(codigo, empurrar) {
    const id = idPorCodigo(codigo);
    if (id) abrir(id, empurrar);
    else {
      // Código que não está na lista desta pessoa: ou não existe, ou é de
      // outra pessoa. A tela diz o mesmo nos dois casos, como o 404.
      gaveta.hidden = false; fundo.hidden = false;
      void gaveta.offsetWidth;
      gaveta.classList.add("aberta");
      abertaId = "?";
      corpo.innerHTML = '<div class="gaveta-carregando">Ação ' + codigo.replace(/[<>&"]/g, "")
        + ' não encontrada.<br><br><button type="button" class="btn sec" data-fechar-gaveta>Fechar</button></div>';
    }
  }

  ligar(corpo, {
    modo: "gaveta",
    aoMudar: (item) => document.dispatchEvent(new CustomEvent("acaoatualizada", { detail: item })),
    aoFechar: () => fechar(),
  });
  corpo.addEventListener("click", (e) => {
    if (abertaId === "?" && e.target.closest("[data-fechar-gaveta]")) fechar();
  });
  fundo.addEventListener("click", () => fechar());
  document.addEventListener("keydown", (e) => {
    // Esc fecha o painel — mas não quando há um <dialog> aberto por cima
    // (o diálogo de mover é quem deve receber aquele Esc).
    if (e.key === "Escape" && abertaId && !document.querySelector("dialog[open]")) fechar();
  });
  window.addEventListener("popstate", () => {
    const codigo = new URL(location.href).searchParams.get("acao");
    if (!codigo) fechar(false);
    else abrirPorCodigo(codigo, false);
  });

  window.AcaoGaveta = { abrir, fechar, abrirPorCodigo, aberta: () => abertaId };

  // Link direto (?acao=AC-007) abre o painel ao carregar.
  const inicial = new URL(location.href).searchParams.get("acao");
  if (inicial) abrirPorCodigo(inicial, false);
})();
