// Massivas — agregações portadas de lib/data.ts para JS + Chart.js.
// Filtro global de período (intervalo de meses) e cross-filter por cidade
// (clicar numa cidade no ranking filtra KPIs/tabela; clicar no mês na evolução
// define o período). Nada hardcoded: tudo deriva do payload.
(function () {
  const M = window.__PAYLOAD__ || {};
  if (!M.meses || !M.meses.length) return;

  const MESES = M.meses, METRICAS = M.metricas || [];
  const CORES = ["#2c7be5", "#27bcfd", "#f5803e", "#00b074"];
  const corMetrica = (i) => CORES[i % CORES.length];

  let iniIdx = 0, fimIdx = MESES.length - 1;
  let mesDia = MESES[MESES.length - 1];
  let metricaDia = METRICAS[0];
  let cidadeSel = null;
  const charts = {};

  const mesesNoIntervalo = () => { const [a, b] = iniIdx <= fimIdx ? [iniIdx, fimIdx] : [fimIdx, iniIdx]; return MESES.slice(a, b + 1); };
  const setMeses = () => new Set(mesesNoIntervalo());

  function somaMetrica(metrica, set) { return M.diario.filter((d) => d.metrica === metrica && set.has(d.mes)).reduce((s, d) => s + d.valor, 0); }
  function somaTotalOs(campo, set) { return (M.totais_mes || []).filter((t) => set.has(t.mes)).reduce((s, t) => s + (t[campo] || 0), 0); }
  function somaCidades(set) {
    return M.cidades.filter((c) => set.has(c.mes) && (!cidadeSel || c.cidade === cidadeSel))
      .reduce((a, c) => ({ massivas: a.massivas + c.massivas, tp: a.tp + c.trocas_poste }), { massivas: 0, tp: 0 });
  }
  function serieMensal() {
    return mesesNoIntervalo().map((mes) => {
      const row = { mes };
      for (const m of METRICAS) row[m] = M.diario.filter((d) => d.mes === mes && d.metrica === m).reduce((s, d) => s + d.valor, 0);
      return row;
    });
  }
  function serieDiaria(mes, metrica) {
    return M.diario.filter((d) => d.mes === mes && d.metrica === metrica).sort((a, b) => a.dia - b.dia);
  }
  function rankingCidades(set) {
    const acc = new Map();
    for (const c of M.cidades) { if (!set.has(c.mes)) continue; const cur = acc.get(c.cidade) || { massivas: 0, tp: 0 }; cur.massivas += c.massivas; cur.tp += c.trocas_poste; acc.set(c.cidade, cur); }
    return [...acc.entries()].map(([cidade, v]) => ({ cidade, massivas: v.massivas, tp: v.tp, semTp: v.massivas - v.tp }))
      .sort((a, b) => b.massivas - a.massivas);
  }

  function renderKpis() {
    const set = setMeses();
    const cid = somaCidades(set);
    const totalOs = somaTotalOs("total_os", set);
    const osTp = somaTotalOs("total_os_por_tp", set);
    const pctTp = cid.massivas ? (cid.tp / cid.massivas * 100) : 0;
    const kpis = [
      ["Massivas abertas", cid.massivas.toLocaleString("pt-BR")],
      ["Trocas de poste", cid.tp.toLocaleString("pt-BR")],
      ["Total de OS", totalOs.toLocaleString("pt-BR")],
      ["OS por TP", osTp.toLocaleString("pt-BR")],
      ["% massivas que foram TP", pctTp.toFixed(1).replace(".", ",") + "%"],
    ];
    document.getElementById("m-kpis").innerHTML = kpis.map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  }

  function renderEvolucao() {
    const serie = serieMensal();
    desenhar("g-evolucao", {
      type: "line",
      data: { labels: serie.map((r) => r.mes), datasets: METRICAS.map((m, i) => ({
        label: m, data: serie.map((r) => r[m]), borderColor: corMetrica(i), backgroundColor: corMetrica(i), tension: .3, pointRadius: 3 })) },
      options: opcoes({ onClick: (evt) => {
        const pts = charts["g-evolucao"].getElementsAtEventForMode(evt, "index", { intersect: false }, true);
        if (!pts.length) return;
        const mes = serie[pts[0].index].mes; const idx = MESES.indexOf(mes);
        iniIdx = idx; fimIdx = idx; document.getElementById("m-ini").value = idx; document.getElementById("m-fim").value = idx; renderTudo();
      } }),
    });
  }

  function renderDiaria() {
    const s = serieDiaria(mesDia, metricaDia);
    desenhar("g-diaria", {
      type: "bar",
      data: { labels: s.map((d) => d.dia), datasets: [{ label: `${metricaDia} — ${mesDia}`, data: s.map((d) => d.valor), backgroundColor: "#2c7be5" }] },
      options: opcoes({ plugins: { legend: { display: false } } }),
    });
  }

  function renderCidades() {
    const set = setMeses();
    const rk = rankingCidades(set).slice(0, 20);
    const cores = rk.map((c) => (cidadeSel && c.cidade === cidadeSel) ? "#1f5fc0" : "#2c7be5");
    desenhar("g-cidades", {
      type: "bar",
      data: { labels: rk.map((c) => c.cidade), datasets: [
        { label: "Sem TP", data: rk.map((c) => c.semTp), backgroundColor: cores, stack: "s" },
        { label: "Troca de poste", data: rk.map((c) => c.tp), backgroundColor: "#f5803e", stack: "s" },
      ] },
      options: opcoes({ indexAxis: "y", scales: { x: { stacked: true }, y: { stacked: true } },
        onClick: (evt) => {
          const pts = charts["g-cidades"].getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
          if (!pts.length) return;
          const cidade = rk[pts[0].index].cidade; cidadeSel = (cidadeSel === cidade) ? null : cidade; renderTudo();
        } }),
    });
  }

  function renderTabela() {
    const set = setMeses();
    let linhas = rankingCidades(set).map((c) => ({ cidade: c.cidade, massivas: c.massivas, tp: c.tp, pct: c.massivas ? c.tp / c.massivas * 100 : 0 }));
    const busca = (document.getElementById("m-busca").value || "").toLowerCase();
    if (busca) linhas = linhas.filter((l) => l.cidade.toLowerCase().includes(busca));
    if (cidadeSel) linhas = linhas.filter((l) => l.cidade === cidadeSel);
    const tot = linhas.reduce((a, l) => ({ massivas: a.massivas + l.massivas, tp: a.tp + l.tp }), { massivas: 0, tp: 0 });
    const corpo = linhas.map((l) =>
      `<tr data-cidade="${l.cidade}" style="cursor:pointer;"><td>${l.cidade}</td><td class="num">${l.massivas}</td><td class="num">${l.tp}</td><td class="num">${l.pct.toFixed(1).replace(".", ",")}%</td></tr>`).join("");
    const totalPct = tot.massivas ? (tot.tp / tot.massivas * 100) : 0;
    document.querySelector("#tab-cidades tbody").innerHTML = corpo +
      `<tr class="total"><td>Total</td><td class="num">${tot.massivas}</td><td class="num">${tot.tp}</td><td class="num">${totalPct.toFixed(1).replace(".", ",")}%</td></tr>`;
    document.querySelectorAll("#tab-cidades tbody tr[data-cidade]").forEach((tr) =>
      tr.addEventListener("click", () => { const c = tr.dataset.cidade; cidadeSel = (cidadeSel === c) ? null : c; renderTudo(); }));
  }

  function renderChips() {
    const box = document.getElementById("chips-massivas"); const chips = [];
    const ms = mesesNoIntervalo();
    if (ms.length !== MESES.length) chips.push(`<span class="chip">Período: ${ms[0]} – ${ms[ms.length - 1]}<button id="c-per">×</button></span>`);
    if (cidadeSel) chips.push(`<span class="chip">Cidade: ${cidadeSel}<button id="c-cid">×</button></span>`);
    box.innerHTML = chips.join("");
    const cp = document.getElementById("c-per"); if (cp) cp.addEventListener("click", () => { iniIdx = 0; fimIdx = MESES.length - 1; sincSelects(); renderTudo(); });
    const cc = document.getElementById("c-cid"); if (cc) cc.addEventListener("click", () => { cidadeSel = null; renderTudo(); });
  }

  function renderTudo() { sincSelects(); renderChips(); renderKpis(); renderEvolucao(); renderDiaria(); renderCidades(); renderTabela(); }

  function opcoes(extra) { return Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } } } }, extra); }
  function desenhar(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart(document.getElementById(id), cfg); }

  function preencher(id, valores, render) { document.getElementById(id).innerHTML = valores.map((v) => `<option value="${render ? render(v) : v}">${v}</option>`).join(""); }
  function sincSelects() {
    document.getElementById("m-ini").value = iniIdx;
    document.getElementById("m-fim").value = fimIdx;
  }

  // selects de intervalo (índices) e visão diária
  document.getElementById("m-ini").innerHTML = MESES.map((m, i) => `<option value="${i}">${m}</option>`).join("");
  document.getElementById("m-fim").innerHTML = MESES.map((m, i) => `<option value="${i}">${m}</option>`).join("");
  document.getElementById("m-dia").innerHTML = MESES.map((m) => `<option value="${m}">${m}</option>`).join("");
  document.getElementById("m-metrica").innerHTML = METRICAS.map((m) => `<option value="${m}">${m}</option>`).join("");
  document.getElementById("m-fim").value = fimIdx;
  document.getElementById("m-dia").value = mesDia;

  document.getElementById("m-ini").addEventListener("change", (e) => { iniIdx = +e.target.value; renderTudo(); });
  document.getElementById("m-fim").addEventListener("change", (e) => { fimIdx = +e.target.value; renderTudo(); });
  document.getElementById("m-dia").addEventListener("change", (e) => { mesDia = e.target.value; renderDiaria(); });
  document.getElementById("m-metrica").addEventListener("change", (e) => { metricaDia = e.target.value; renderDiaria(); });
  document.getElementById("m-busca").addEventListener("input", renderTabela);
  document.getElementById("m-limpar").addEventListener("click", () => { iniIdx = 0; fimIdx = MESES.length - 1; cidadeSel = null; renderTudo(); });
  document.querySelectorAll("#tab-cidades th").forEach((th) => th.addEventListener("click", () => {
    // ordenação simples por coluna (reaproveita render; ordena dataset base)
    ordenarTabela(th.dataset.col);
  }));

  let ordCol = "massivas", ordDir = -1;
  function ordenarTabela(col) {
    if (ordCol === col) ordDir *= -1; else { ordCol = col; ordDir = -1; }
    // reusa renderTabela mas com ordenação aplicada via monkey sort
    const set = setMeses();
    let linhas = rankingCidades(set).map((c) => ({ cidade: c.cidade, massivas: c.massivas, tp: c.tp, pct: c.massivas ? c.tp / c.massivas * 100 : 0 }));
    if (cidadeSel) linhas = linhas.filter((l) => l.cidade === cidadeSel);
    linhas.sort((a, b) => (typeof a[col] === "string" ? a[col].localeCompare(b[col]) : a[col] - b[col]) * ordDir);
    document.querySelector("#tab-cidades tbody").innerHTML = linhas.map((l) =>
      `<tr data-cidade="${l.cidade}" style="cursor:pointer;"><td>${l.cidade}</td><td class="num">${l.massivas}</td><td class="num">${l.tp}</td><td class="num">${l.pct.toFixed(1).replace(".", ",")}%</td></tr>`).join("");
    document.querySelectorAll("#tab-cidades tbody tr[data-cidade]").forEach((tr) =>
      tr.addEventListener("click", () => { const c = tr.dataset.cidade; cidadeSel = (cidadeSel === c) ? null : c; renderTudo(); }));
  }

  renderTudo();
})();
