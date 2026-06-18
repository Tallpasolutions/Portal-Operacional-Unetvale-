// IQI/IQM — visualização "Tabela mensal" estilo planilha gerencial.
// Componente NOVO e independente: não altera o gráfico existente. Usa o mesmo
// payload (window.__PACOTE__) e segue o indicador do seletor compartilhado.
//
// Cada técnico = 1 linha. Cada mês = grupo de 3 colunas (OSs, OSs c/ chamado,
// IQI/IQM %), com cabeçalho do mês mesclado. Meses ainda em auditoria (até 30
// dias após o fim do mês) recebem automaticamente a tag "(Parcial)".
(function () {
  const PACOTE = window.__PACOTE__ || {};
  const sw = document.getElementById("view-switch");
  if (!sw || !Object.keys(PACOTE).length) return;

  const MESES_NOME = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const inds = Object.keys(PACOTE);
  let indAtual = inds[0];

  // Infra não participa do IQI/IQM — o backend já entrega só operacional.
  const empresaDe = (nome) => (nome.includes(" - ") ? nome.split(" - ")[0].trim() : "(Sem equipe)");
  const fmtPct = (v) => (v || 0).toFixed(2).replace(".", ",") + "%";

  const empresasSel = new Set(); // vazio = todas
  const mesesSel = new Set();    // vazio = todos

  const dados = () => PACOTE[indAtual];

  // Mês fechado = hoje passou de (último dia do mês + 30 dias de auditoria).
  function mesFechado(mesStr) {
    const [mm, yyyy] = mesStr.split("/").map(Number);
    const limite = new Date(yyyy, mm, 0);            // último dia do mês mm
    limite.setDate(limite.getDate() + 30);           // + janela de homologação
    return new Date() > limite;
  }
  function mesLabel(mesStr) {
    const [mm] = mesStr.split("/").map(Number);
    return MESES_NOME[mm - 1] + (mesFechado(mesStr) ? "" : " (Parcial)");
  }

  const empresasDisponiveis = () => [...new Set(dados().tecnicos.map((t) => empresaDe(t.nome)))].sort();

  function tecnicosFiltrados() {
    return dados().tecnicos
      .filter((t) => !empresasSel.size || empresasSel.has(empresaDe(t.nome)))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt"));
  }

  function mesesExibidos() {
    const todos = dados().meses;
    return mesesSel.size ? todos.filter((m) => mesesSel.has(m)) : todos;
  }

  function renderFiltros() {
    document.querySelectorAll(".tm-ind-nome").forEach((e) => (e.textContent = dados().label || indAtual));

    const empBox = document.getElementById("tm-empresas");
    empBox.innerHTML = empresasDisponiveis().map((e) =>
      `<button class="fchip ${empresasSel.has(e) ? "on" : ""}" data-emp="${e}">${e}</button>`).join("");
    empBox.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const e = b.dataset.emp;
      if (empresasSel.has(e)) empresasSel.delete(e); else empresasSel.add(e);
      renderFiltros(); renderTabela();
    }));

    const perBox = document.getElementById("tm-periodo");
    perBox.innerHTML = dados().meses.map((m) =>
      `<button class="fchip ${(!mesesSel.size || mesesSel.has(m)) ? "on" : ""}" data-mes="${m}">${mesLabel(m)}</button>`).join("");
    perBox.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const m = b.dataset.mes, todos = dados().meses;
      if (!mesesSel.size) todos.forEach((x) => mesesSel.add(x)); // "todos" -> materializa p/ remover
      if (mesesSel.has(m)) mesesSel.delete(m); else mesesSel.add(m);
      if (mesesSel.size === todos.length || mesesSel.size === 0) mesesSel.clear(); // todos selecionados = limpo
      renderFiltros(); renderTabela();
    }));
  }

  function renderTabela() {
    const meses = mesesExibidos();
    const d = dados();
    const idxMes = meses.map((m) => d.meses.indexOf(m));
    const pctLabel = (d.label || indAtual) + " %";

    let h1 = `<th class="sticky-col" rowspan="2">Técnicos</th>`;
    let h2 = "";
    meses.forEach((m) => {
      const parcial = !mesFechado(m);
      h1 += `<th colspan="3" class="mes-h${parcial ? " parcial" : ""}">${mesLabel(m)}</th>`;
      h2 += `<th class="num">OSs</th><th class="num">OSs c/ chamado</th><th class="num">${pctLabel}</th>`;
    });

    const tecs = tecnicosFiltrados();
    let body = "";
    tecs.forEach((t) => {
      let row = `<td class="sticky-col nome">${t.nome}</td>`;
      idxMes.forEach((i, k) => {
        const reg = t.m[i] || [0, 0, 0];
        const cls = mesFechado(meses[k]) ? "" : " parcial-cell";
        if (reg[0] > 0) {
          row += `<td class="num${cls}">${reg[0]}</td><td class="num${cls}">${reg[1]}</td><td class="num${cls}">${fmtPct(reg[2])}</td>`;
        } else {
          row += `<td class="num${cls}"></td><td class="num${cls}"></td><td class="num${cls}"></td>`;
        }
      });
      body += `<tr>${row}</tr>`;
    });
    if (!tecs.length) {
      body = `<tr><td class="sticky-col">—</td><td colspan="${meses.length * 3}" style="text-align:center;color:var(--muted);padding:24px;">Nenhum técnico para os filtros selecionados.</td></tr>`;
    }
    document.getElementById("tab-mensal").innerHTML = `<thead><tr>${h1}</tr><tr>${h2}</tr></thead><tbody>${body}</tbody>`;
  }

  // Segue o indicador do seletor compartilhado (#indToggle do iqi.js), sem alterá-lo.
  document.getElementById("indToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (!btn || btn.dataset.id === indAtual) return;
    indAtual = btn.dataset.id;
    empresasSel.clear(); mesesSel.clear();
    renderFiltros(); renderTabela();
  });

  // Alterna a visualização
  let montada = false;
  sw.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    sw.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    const tabela = b.dataset.view === "tabela";
    document.getElementById("view-grafico").hidden = tabela;
    document.getElementById("view-tabela").hidden = !tabela;
    if (tabela) { renderFiltros(); renderTabela(); montada = true; }
  }));
})();
