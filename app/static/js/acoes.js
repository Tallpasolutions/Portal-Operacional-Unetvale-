// Módulo Ações — abas, gráficos do Painel e o formulário de nova ação.
(function () {
  const R = window.__RESUMO__ || {};

  // ---- abas ---------------------------------------------------------------
  // O estado vai para a URL, não para uma variável: recarregar a página depois
  // de salvar precisa devolver a pessoa para a aba em que ela estava, e o
  // botão voltar do navegador tem de funcionar.
  const barra = document.getElementById("ac-abas");
  if (barra) {
    barra.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-aba]");
      if (!b) return;
      const aba = b.dataset.aba;
      barra.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll("[data-painel]").forEach((s) => {
        s.hidden = s.dataset.painel !== aba;
      });
      const u = new URL(location);
      u.searchParams.set("aba", aba);
      history.replaceState(null, "", u);
      // O canvas mede 0 enquanto está escondido: só desenha ao aparecer.
      if (aba === "painel") desenhar();
    });
  }

  // Linha da tabela inteira clicável — no computador o alvo é a linha, não um
  // link de 4px dentro dela.
  document.querySelectorAll("tr.clicavel").forEach((tr) => {
    tr.addEventListener("click", () => { location.href = tr.dataset.href; });
  });

  // Filtros recolhidos no celular. `hidden` no elemento em vez de classe: o
  // CSS já usa `display:flex` na toolbar e venceria uma classe solta.
  const btnFiltros = document.getElementById("btn-filtros");
  const filtros = document.getElementById("ac-filtros");
  if (btnFiltros && filtros) {
    const estreito = () => window.matchMedia("(max-width:820px)").matches;
    const aplicar = () => {
      const recolher = estreito() && btnFiltros.getAttribute("aria-expanded") !== "true";
      filtros.style.display = recolher ? "none" : "";
    };
    btnFiltros.addEventListener("click", () => {
      const aberto = btnFiltros.getAttribute("aria-expanded") === "true";
      btnFiltros.setAttribute("aria-expanded", String(!aberto));
      aplicar();
    });
    window.addEventListener("resize", aplicar);
    aplicar();
  }

  const novaBtn = document.getElementById("btn-nova");
  const novaForm = document.getElementById("form-nova");
  if (novaBtn && novaForm) {
    novaBtn.addEventListener("click", () => {
      novaForm.hidden = false;
      novaForm.scrollIntoView({ behavior: "smooth", block: "center" });
      novaForm.querySelector("input[name=titulo]").focus();
    });
    document.getElementById("btn-cancelar-nova")
      .addEventListener("click", () => { novaForm.hidden = true; });
  }

  // ---- gráficos -----------------------------------------------------------
  // Mesmas cores de status do resto do portal: verde = no alvo, vermelho =
  // fora, âmbar = atenção. A cor responde a pergunta antes do eixo.
  const COR = {
    "Não iniciada": "#9da9bb", "Em andamento": "#2c7be5", "Aguardando": "#f5803e",
    "Concluída": "#00b074", "Cancelada": "#d8e2ef",
    "Crítica": "#e63757", "Alta": "#f5803e", "Média": "#2c7be5", "Baixa": "#27bcfd",
    "Atrasada": "#e63757", "Vence em breve": "#f5803e", "No prazo": "#00b074",
    "Sem prazo": "#9da9bb",
  };

  let charts = {};
  let desenhado = false;

  function barras(id, dados, rotulo) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: dados.map((d) => d.rotulo),
        datasets: [{
          label: rotulo,
          data: dados.map((d) => d.n),
          backgroundColor: dados.map((d) => COR[d.rotulo] || "#2c7be5"),
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  function desenhar() {
    if (desenhado || !R.total) return;
    desenhado = true;

    barras("g-status", R.por_status || [], "Ações");

    // Prioridade mostra DUAS séries: o total e quanto dele está atrasado. Só
    // o total esconderia o que a reunião precisa ver — dez ações críticas com
    // zero atrasadas é uma situação; com seis atrasadas é outra.
    const p = R.por_prioridade || [];
    const ctxP = document.getElementById("g-prioridade");
    if (ctxP) {
      if (charts.prio) charts.prio.destroy();
      charts.prio = new Chart(ctxP, {
        type: "bar",
        data: {
          labels: p.map((d) => d.rotulo),
          datasets: [
            { label: "Total", data: p.map((d) => d.n), backgroundColor: "#d8e2ef" },
            { label: "Atrasadas", data: p.map((d) => d.atrasadas), backgroundColor: "#e63757" },
          ],
        },
        options: {
          plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
      });
    }

    // Situação em rosca: aqui a pergunta é "como está repartido", não
    // "quanto de cada" — e a rosca responde isso de relance.
    const s = (R.por_situacao || []).filter((d) => d.n > 0);
    const ctxS = document.getElementById("g-situacao");
    if (ctxS && s.length) {
      if (charts.sit) charts.sit.destroy();
      charts.sit = new Chart(ctxS, {
        type: "doughnut",
        data: {
          labels: s.map((d) => d.rotulo),
          datasets: [{ data: s.map((d) => d.n),
                       backgroundColor: s.map((d) => COR[d.rotulo] || "#2c7be5") }],
        },
        options: { plugins: { legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } } } },
      });
    }
  }

  // Desenha ao carregar só se o Painel já estiver visível.
  const painel = document.querySelector('[data-painel="painel"]');
  if (painel && !painel.hidden) desenhar();
})();
