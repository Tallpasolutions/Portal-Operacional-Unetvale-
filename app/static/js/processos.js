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

  // Seletor que troca de página (o fluxo aberto, na aba Fluxograma).
  document.querySelectorAll("select[data-navegar]").forEach((s) => {
    s.addEventListener("change", () => { location.href = s.value; });
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
