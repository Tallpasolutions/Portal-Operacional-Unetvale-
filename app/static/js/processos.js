// Módulo Processos — catálogo e página do processo: abas, filtro, diálogos.
// O editor do fluxo mora em fluxo_editor.js; a instrução, em instrucao.js.
(function () {
  // ---- abas ---------------------------------------------------------------
  // No catálogo as abas trocam no cliente (o dado das duas já veio). Na
  // página do processo cada aba é uma navegação (`data-href`): o documento do
  // fluxo é a parte pesada e só a aba Fluxograma o carrega.
  const barra = document.getElementById("pr-abas");
  if (barra) {
    barra.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-aba]");
      if (!b) return;
      if (b.dataset.href) { location.href = b.dataset.href; return; }
      const aba = b.dataset.aba;
      barra.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll("[data-painel]").forEach((s) => {
        s.hidden = s.dataset.painel !== aba;
      });
      const u = new URL(location);
      u.searchParams.set("aba", aba);
      history.replaceState(null, "", u);
    });
  }

  // Seletor que troca de página (o fluxo aberto, a revisão da instrução).
  document.querySelectorAll("select[data-navegar]").forEach((s) => {
    s.addEventListener("change", () => { location.href = s.value; });
  });
  // Seletor que grava ao escolher (o fluxo de origem da instrução).
  document.querySelectorAll("select[data-enviar]").forEach((s) => {
    s.addEventListener("change", () => s.form.submit());
  });

  // ---- diálogos -------------------------------------------------------------
  // `<dialog>` da casa, nunca `confirm()` (CLAUDE.md §5).
  document.addEventListener("click", (e) => {
    const abrir = e.target.closest("[data-abrir]");
    if (abrir) {
      const dlg = document.getElementById(abrir.dataset.abrir);
      if (dlg && dlg.showModal) {
        dlg.showModal();
        const primeiro = dlg.querySelector("input:not([type=hidden]), textarea, select");
        if (primeiro) primeiro.focus();
      }
      return;
    }
    const fechar = e.target.closest("dialog [data-fechar]");
    if (fechar) fechar.closest("dialog").close();
  });

  // Linha inteira clicável: no computador o alvo é a linha, não o link de 4px
  // dentro dela. Clique num link ou botão da própria linha segue o caminho dele.
  document.querySelectorAll("tr.clicavel[data-href]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a, button, form")) return;
      location.href = tr.dataset.href;
    });
  });

  // ---- gerar instrução do fluxo --------------------------------------------
  // A IT é de uma ou mais raias do fluxo (decisão de 20/10/2026). O diálogo
  // lista as raias com quantos passos cada uma vira, preenche o nome e diz o
  // executor — tudo pelo gerador do fluxo_gerar_it.js, o mesmo que a tela da
  // instrução usa depois. O servidor confere as raias de novo ao criar.
  const formIT = document.getElementById("form-nova-it");
  if (formIT && window.FluxoIT) (function () {
    const IT = window.FluxoIT;
    const selFluxo = formIT.querySelector("#ni-fluxo");
    const lista = formIT.querySelector("#ni-raias");
    const boxRaias = formIT.querySelector("[data-ni-raias]");
    const boxExecuta = formIT.querySelector("[data-ni-executa]");
    const selExecuta = formIT.querySelector("#ni-executa");
    const titulo = formIT.querySelector("#ni-titulo");
    const resumo = formIT.querySelector("#ni-resumo");
    const criar = formIT.querySelector("#ni-criar");
    const processo = formIT.dataset.processo;
    const docs = {};
    let doc = null, desenhadoPara = null, tituloEditado = false;

    const esc = (t) => String(t == null ? "" : t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const norm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    // Mesma regra de `processos.executa_das_raias`: é o servidor quem grava.
    const executaDe = (raias) => raias.some((r) => norm(r.titulo).includes("campo")) ? "campo" : "interno";
    const rotuloExecuta = (k) => { const o = selExecuta && selExecuta.querySelector(`option[value="${k}"]`); return o ? o.textContent : k; };
    const marcadas = () => [...lista.querySelectorAll("input[name=raias]:checked")].map((x) => x.value);

    titulo.addEventListener("input", () => { tituloEditado = titulo.value.trim() !== ""; });

    function nomeAuto(raias) {
      const nomes = raias.map((r) => r.titulo).filter(Boolean);
      if (!nomes.length) return processo;
      const quem = nomes.length === 1 ? nomes[0] : nomes.slice(0, -1).join(", ") + " e " + nomes[nomes.length - 1];
      return `${processo} — ${quem}`.slice(0, 160);
    }

    function atualizar() {
      if (!selFluxo.value) {
        resumo.textContent = "Sem fluxo: a instrução nasce vazia e você escreve os passos.";
        if (!tituloEditado) titulo.value = processo;
        criar.disabled = false;
        return;
      }
      if (!doc) { criar.disabled = true; return; }
      const ids = marcadas();
      const raias = (doc.raias || []).filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, titulo: (r.titulo || "").trim() }));
      if (!tituloEditado) titulo.value = nomeAuto(raias);
      if (!raias.length) {
        resumo.textContent = "Marque pelo menos uma raia.";
        criar.disabled = true;
        return;
      }
      const n = IT.gerar(doc, { raias: ids }).passos.length;
      resumo.innerHTML = `<b>${n} passo${n === 1 ? "" : "s"}</b> · executa: ${esc(rotuloExecuta(executaDe(raias)))}`;
      criar.disabled = n === 0;
    }

    // A lista só é RECRIADA quando o fluxo muda; marcar e desmarcar só
    // recalcula o resumo — recriar a cada clique roubaria o clique seguinte
    // (CLAUDE.md §6, chips).
    function desenharRaias() {
      const raias = doc.raias || [];
      if (!raias.length) {
        lista.innerHTML = `<p class="acao-p-vazio">Este fluxo não tem raias. Desenhe as raias na folha: são elas que dizem quem faz cada passo.</p>`;
        return;
      }
      const contagem = raias.map((r) => IT.gerar(doc, { raias: [r.id] }).passos.length);
      // Padrão: a raia de campo (é para o técnico que a IT existe); sem ela,
      // a primeira que tem passo.
      let padrao = raias.findIndex((r, i) => contagem[i] > 0 && norm(r.titulo).includes("campo"));
      if (padrao < 0) padrao = contagem.findIndex((c) => c > 0);
      lista.innerHTML = raias.map((r, i) =>
        `<label class="linha-marcar"><input type="checkbox" name="raias" value="${esc(r.id)}"${i === padrao ? " checked" : ""}>` +
        ` ${esc(r.titulo || "Raia " + (i + 1))} <span class="rotulo-leve">${contagem[i]} passo${contagem[i] === 1 ? "" : "s"}</span></label>`).join("");
    }

    async function preparar() {
      const id = selFluxo.value;
      boxRaias.hidden = !id;
      boxExecuta.hidden = !!id;
      if (!id) { doc = null; atualizar(); return; }
      if (desenhadoPara === id && doc) { atualizar(); return; }
      doc = null;
      criar.disabled = true;
      lista.innerHTML = `<p class="acao-p-vazio">Carregando as raias do fluxo…</p>`;
      try {
        // Guarda a PROMESSA, não o resultado: dois cliques seguidos esperam a
        // mesma busca em vez de pedir o documento duas vezes.
        if (!docs[id]) {
          docs[id] = fetch(formIT.dataset.urlDoc.replace("__ID__", encodeURIComponent(id)))
            .then((r) => r.json().then((j) => { if (!r.ok || !j.ok) throw new Error("HTTP " + r.status); return j.documento; }));
          docs[id].catch(() => { delete docs[id]; });
        }
        const carregado = await docs[id];
        if (selFluxo.value !== id) return;  // trocou de fluxo enquanto carregava
        if (desenhadoPara === id && doc) { atualizar(); return; }
        doc = carregado;
        desenhadoPara = id;
        desenharRaias();
      } catch (e) {
        lista.innerHTML = `<p class="acao-p-vazio">Não consegui carregar o fluxo. Feche e abra de novo.</p>`;
      }
      atualizar();
    }

    lista.addEventListener("change", atualizar);
    selFluxo.addEventListener("change", () => { desenhadoPara = null; preparar(); });
    document.addEventListener("click", (e) => { if (e.target.closest('[data-abrir="dlg-nova-it"]')) preparar(); });
    formIT.addEventListener("submit", (e) => { if (criar.disabled) e.preventDefault(); });
  })();

  // ---- filtro do catálogo ---------------------------------------------------
  // Um filtro só, valendo para as duas abas. É leitura: o catálogo inteiro já
  // veio, e recarregar a cada letra seria trocar de página para esconder linha.
  const busca = document.getElementById("pr-busca");
  const chips = document.getElementById("pr-publico");
  if (!busca || !chips) return;
  let publico = "";

  function aplicar() {
    const termo = busca.value.trim().toLowerCase();
    document.querySelectorAll("[data-painel]").forEach((painel) => {
      const linhas = painel.querySelectorAll("tr[data-busca]");
      let visiveis = 0;
      linhas.forEach((tr) => {
        const ok = (!termo || tr.dataset.busca.includes(termo)) &&
                   (!publico || tr.dataset.publico === publico);
        tr.hidden = !ok;
        if (ok) visiveis++;
      });
      const aviso = painel.querySelector(".pr-sem-resultado");
      if (aviso) aviso.hidden = !linhas.length || visiveis > 0;
    });
  }

  busca.addEventListener("input", aplicar);
  chips.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-publico]");
    if (!b) return;
    publico = b.dataset.publico;
    // Só a classe muda: recriar os chips trocaria o nó sob o cursor e o
    // clique seguinte cairia num nó já removido (CLAUDE.md §6).
    chips.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    aplicar();
  });
})();
