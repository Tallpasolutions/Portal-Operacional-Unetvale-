// Módulo Ações — abas e gráficos do Painel. O quadro, a lista e o
// cronograma moram em acoes_quadro.js; o painel da ação, em acao_painel.js.
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
  // link de 4px dentro dela. Só as que levam a outra página (`data-href`, as
  // reuniões): as linhas da Lista de ações abrem o painel lateral, e quem
  // cuida delas é o acoes_quadro.js.
  document.querySelectorAll("tr.clicavel[data-href]").forEach((tr) => {
    tr.addEventListener("click", () => { location.href = tr.dataset.href; });
  });

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

    fluxo();
    carga();

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

  // Abertas × concluídas por semana. Barras lado a lado, e não empilhadas:
  // a pergunta é "fechamos mais do que abrimos?", e isso é comparar a altura
  // das duas, não somar.
  function fluxo() {
    const f = R.fluxo_semanal || [];
    const ctx = document.getElementById("g-fluxo");
    if (!ctx || !f.length) return;
    if (charts.fluxo) charts.fluxo.destroy();
    charts.fluxo = new Chart(ctx, {
      type: "bar",
      data: {
        labels: f.map((d) => d.rotulo),
        datasets: [
          { label: "Abertas", data: f.map((d) => d.abertas), backgroundColor: "#2c7be5" },
          { label: "Concluídas", data: f.map((d) => d.concluidas), backgroundColor: "#00b074" },
        ],
      },
      options: {
        plugins: {
          legend: { position: "top" },
          tooltip: { callbacks: { title: (it) => "Semana de " + it[0].label } },
        },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } },
      },
    });
  }

  // Carga em aberto por responsável: status empilhados numa barra e as
  // atrasadas numa barra vermelha AO LADO (outra pilha). Empilhar as
  // atrasadas junto contaria a mesma ação duas vezes — ela já está no
  // status dela.
  function carga() {
    const c = R.carga_por_pessoa || [];
    const ctx = document.getElementById("g-carga");
    if (!ctx) return;
    if (!c.length) {
      document.getElementById("box-carga").innerHTML = '<div class="vazio" style="padding:30px;">Nenhuma ação em aberto.</div>';
      return;
    }
    // Uma linha por pessoa com altura decente, em vez de espremer 12 nomes
    // nos 340px de sempre.
    document.getElementById("box-carga").style.height = Math.max(240, c.length * 42 + 70) + "px";
    const abertos = ["Não iniciada", "Em andamento", "Aguardando"];
    if (charts.carga) charts.carga.destroy();
    charts.carga = new Chart(ctx, {
      type: "bar",
      data: {
        labels: c.map((d) => d.nome),
        datasets: abertos.map((s) => ({
          label: s, data: c.map((d) => d.por_status[s] || 0), backgroundColor: COR[s], stack: "status",
        })).concat([{
          label: "Atrasadas", data: c.map((d) => d.atrasadas), backgroundColor: COR["Atrasada"], stack: "atraso",
        }]),
      },
      options: {
        indexAxis: "y",
        plugins: { legend: { position: "top" } },
        scales: {
          x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
          y: { stacked: true, grid: { display: false } },
        },
      },
    });
  }

  // Desenha ao carregar só se o Painel já estiver visível.
  const painel = document.querySelector('[data-painel="painel"]');
  if (painel && !painel.hidden) desenhar();

  // ---- Dropdown de participantes ----------------------------------------
  // O <details> abre e fecha sozinho; o JS só escreve quantos foram marcados
  // no resumo. Sem isso o dropdown fechado não diria nada sobre a escolha.
  const dd = document.getElementById("dd-participantes");
  if (dd) {
    const resumo = dd.querySelector("[data-resumo]");
    const caixas = dd.querySelectorAll('input[type="checkbox"]');

    function escrever() {
      const marcados = [...caixas].filter((c) => c.checked);
      if (!marcados.length) { resumo.textContent = "Escolher participantes"; return; }
      if (marcados.length <= 2) {
        resumo.textContent = marcados
          .map((c) => c.closest("label").textContent.trim())
          .join(", ");
        return;
      }
      resumo.textContent = marcados.length + " participantes";
    }

    dd.addEventListener("change", escrever);
    // Clique fora fecha — senão o painel fica aberto por cima do resto do
    // formulário e esconde os campos de baixo.
    document.addEventListener("click", (e) => {
      if (dd.open && !dd.contains(e.target)) dd.open = false;
    });
    escrever();
  }
})();
