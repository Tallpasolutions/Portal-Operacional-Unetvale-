// IQI / IQM — gráfico (Chart.js) + tabela ordenável + toggle IQI/IQM + meta
// editável. Cross-filter: clicar numa barra (técnico) filtra a tabela; clicar
// na linha da tabela destaca a barra. Cálculos preservados do projeto original.
(function () {
  const PACOTE = window.__PACOTE__ || {};
  if (!Object.keys(PACOTE).length) return;

  let DATA = null, META = 17, MINOS = 10, IND = "IQI";
  let mesIdx = 0;
  let tableSort = { key: "iqi", dir: 1 };
  let selecionado = null; // técnico filtrado por clique
  let chart = null;

  const fmt = (v) => v.toFixed(2).replace(".", ",") + "%";
  const fmtMeta = (v) => (Number.isInteger(v) ? v.toString() : v.toFixed(1).replace(".", ",")) + "%";
  const bateu = (reg) => reg[0] > MINOS && reg[2] < META;
  function streak(m, idx) { let s = 0; for (let i = idx; i >= 0; i--) { if (bateu(m[i])) s++; else break; } return s; }

  function ranking(idx) {
    return DATA.tecnicos.filter((t) => bateu(t.m[idx])).map((t) => ({
      nome: t.nome, curto: t.nome.split(" - ").pop(),
      empresa: t.nome.includes(" - ") ? t.nome.split(" - ")[0] : "",
      iqi: t.m[idx][2], os: t.m[idx][0], cham: t.m[idx][1], stars: streak(t.m, idx),
    }));
  }

  function aplicar(data) {
    DATA = data; MINOS = data.minOS; IND = data.indicador || IND;
    document.getElementById("tituloGrafico").textContent = IND;
    document.querySelectorAll(".colInd").forEach((e) => (e.textContent = IND));
    document.getElementById("sub").textContent =
      `${IND} = OSs com atendimento/reincidência em até ${data.dias} dias após a ${data.evento} ÷ total de OSs. ` +
      `Considera apenas técnicos com mais de ${data.minOS} OSs de ${data.evento} no mês.`;
    const inp = document.getElementById("metaInput");
    const atual = parseFloat(inp.value);
    META = (!isNaN(atual) && atual > 0) ? atual : data.meta;
    inp.value = META;
    const sel = document.getElementById("mes");
    sel.innerHTML = data.meses.map((m, i) => `<option value="${i}">${m}</option>`).join("");
    const hoje = new Date(), atualMes = String(hoje.getMonth() + 1).padStart(2, "0") + "/" + hoje.getFullYear();
    let def = data.meses.length - 1;
    if (data.meses[def] === atualMes && data.meses.length > 1) def = data.meses.length - 2;
    sel.value = def; mesIdx = def;
    selecionado = null;
    desenhar();
  }

  function desenhar() {
    if (!DATA) return;
    const base = ranking(mesIdx);
    document.getElementById("qtd").textContent = base.length;
    document.getElementById("rec").textContent = base.length ? Math.max(...base.map((d) => d.stars)) : 0;
    renderChips();
    const dadosTabela = selecionado ? base.filter((d) => d.nome === selecionado) : base;
    const chartData = [...base].sort((a, b) => a.iqi - b.iqi || a.nome.localeCompare(b.nome, "pt"));

    const cores = chartData.map((d) => (selecionado && d.nome === selecionado) ? "#15663a" : "#1f8a4c");
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById("g-iqi"), {
      type: "bar",
      data: {
        labels: chartData.map((d) => d.curto),
        datasets: [
          { label: IND + " %", data: chartData.map((d) => d.iqi), backgroundColor: cores, order: 2 },
          { label: "Meta", type: "line", data: chartData.map(() => META), borderColor: "#c0392b",
            borderWidth: 1.4, borderDash: [6, 4], pointRadius: 0, order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => {
            if (c.datasetIndex === 1) return "Meta: " + fmtMeta(META);
            const d = chartData[c.dataIndex];
            return [`${d.nome}`, `${IND}: ${fmt(d.iqi)} | OSs: ${d.os} | c/ chamado: ${d.cham} | recorrência: ${d.stars}`];
          } } },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => v + "%" } } },
        onClick: (evt) => {
          const pts = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
          if (!pts.length) return;
          const nome = chartData[pts[0].index].nome;
          selecionado = (selecionado === nome) ? null : nome;
          desenhar();
        },
      },
    });
    renderTabela(dadosTabela);
  }

  function renderChips() {
    const box = document.getElementById("chips-iqi");
    box.innerHTML = selecionado
      ? `<span class="chip">Técnico: ${selecionado}<button id="limpa-sel">×</button></span>` : "";
    const b = document.getElementById("limpa-sel");
    if (b) b.addEventListener("click", () => { selecionado = null; desenhar(); });
  }

  function cmp(a, b, key) { return key === "nome" ? a.nome.localeCompare(b.nome, "pt") : a[key] - b[key]; }
  function renderTabela(base) {
    const data = [...base].sort((a, b) => cmp(a, b, tableSort.key) * tableSort.dir);
    document.querySelector("#tab-iqi tbody").innerHTML = data.map((d) => {
      const extra = d.stars - 1;
      return `<tr data-nome="${d.nome}" style="cursor:pointer;">
        <td>${d.nome}</td><td class="num verde">${fmt(d.iqi)}</td><td class="num">${d.os}</td>
        <td class="num">${d.cham}</td>
        <td class="num"><span class="estrela">${"★".repeat(Math.max(0, extra))}</span> <span style="color:var(--cinza-l)">(${d.stars} ${d.stars > 1 ? "meses" : "mês"})</span></td>
      </tr>`;
    }).join("");
    document.querySelectorAll("#tab-iqi tbody tr").forEach((tr) =>
      tr.addEventListener("click", () => { const n = tr.dataset.nome; selecionado = (selecionado === n) ? null : n; desenhar(); }));
    document.querySelectorAll("#tab-iqi thead th").forEach((th) => {
      const seta = th.dataset.key === tableSort.key ? (tableSort.dir > 0 ? " ▲" : " ▼") : "";
      th.dataset.label ||= th.textContent;
      th.innerHTML = th.dataset.label + seta;
    });
  }

  // toggle de indicadores
  const tog = document.getElementById("indToggle");
  const inds = Object.keys(PACOTE);
  tog.innerHTML = inds.map((k, i) => `<button data-id="${k}" class="${i === 0 ? "active" : ""}">${k}</button>`).join("");
  tog.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    tog.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    document.getElementById("metaInput").value = "";
    aplicar(PACOTE[b.dataset.id]);
  }));

  document.getElementById("mes").addEventListener("change", (e) => { mesIdx = +e.target.value; selecionado = null; desenhar(); });
  document.getElementById("metaInput").addEventListener("input", (e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v > 0) { META = v; desenhar(); } });
  document.querySelectorAll("#tab-iqi thead th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.key; if (tableSort.key === k) tableSort.dir *= -1; else { tableSort.key = k; tableSort.dir = 1; } desenhar();
  }));

  aplicar(PACOTE[inds[0]]);
})();
