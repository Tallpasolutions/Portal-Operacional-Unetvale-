// Produtividade — cross-filter (reaproveitado do projeto original, lendo o
// payload injetado pelo servidor em vez de /api/registros). Clicar em qualquer
// gráfico filtra todo o painel.
(function () {
  if (!document.getElementById("kpis")) return; // estado vazio

  let REGISTROS = [];
  let FIN = [], MOT = []; // dicionários: finalidade e motivo (índices nos registros)
  const filtros = { e: new Set(), t: new Set(), mes: new Set(), semana: new Set(), d: new Set(),
    fin: new Set(), mo: new Set(), ta: new Set(), rj: new Set() };
  let grupo = "todos"; // todos | infra | operacional
  // Infra = "INFRA" como palavra isolada (INFRA UNET/WAVE/SCHISTEL) + exceções por
  // nome (ex.: FANDARUFF). NÃO conta INFRASEG (operacional). Adicione novas equipes
  // infra sem "INFRA" no nome ao regex EXTRA_INFRA abaixo.
  const EXTRA_INFRA = /fandaruff/i;
  const ehInfra = (r) => /\binfra\b/i.test(r.e) || EXTRA_INFRA.test(r.e);
  const NOMES_DIM = { e: "Empresa", t: "Técnico", mes: "Mês", semana: "Semana", d: "Dia",
    fin: "Tipo de OS", mo: "Motivo", ta: "Atendimento", rj: "Rejeitada" };
  let ordenacaoTec = { col: "os", dir: -1 };
  let charts = {};
  const MESES_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const CORES = { os: "#2c7be5", azul: "#27bcfd", laranja: "#f5803e" };

  function isoSemana(diaStr) {
    const [y, m, d] = diaStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = (dt.getUTCDay() + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - dow + 3);
    const ano = dt.getUTCFullYear();
    const jan4 = new Date(Date.UTC(ano, 0, 4));
    const jan4dow = (jan4.getUTCDay() + 6) % 7;
    const semana = 1 + Math.round((dt - jan4) / 86400000 / 7 + (jan4dow - 3) / 7);
    return `${ano}-W${String(semana).padStart(2, "0")}`;
  }
  function rotuloMes(mes) { const [y, m] = mes.split("-"); return `${MESES_PT[+m - 1]}/${y.slice(2)}`; }
  function rotuloDia(d) { const [, m, dd] = d.split("-"); return `${dd}/${m}`; }
  function datasSemanaISO(s) {
    const [y, w] = s.split("-W").map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const jan4dow = (jan4.getUTCDay() + 6) % 7;
    const seg1 = new Date(jan4); seg1.setUTCDate(jan4.getUTCDate() - jan4dow);
    const ini = new Date(seg1); ini.setUTCDate(seg1.getUTCDate() + (w - 1) * 7);
    const fim = new Date(ini); fim.setUTCDate(ini.getUTCDate() + 6);
    return { ini, fim };
  }
  function ddmm(d) { return String(d.getUTCDate()).padStart(2, "0") + "/" + MESES_PT[d.getUTCMonth()]; }
  function rotuloSemana(s) { const w = s.split("-W")[1]; const { ini, fim } = datasSemanaISO(s); return `Sem ${w} (${ddmm(ini)}–${ddmm(fim)})`; }
  const distinct = (arr) => [...new Set(arr)];
  const media = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  function carregar() {
    const j = window.__PAYLOAD__ || { registros: [] };
    FIN = j.fin || []; MOT = j.mot || [];
    REGISTROS = j.registros.map((x) => ({ ...x, mes: x.d.slice(0, 7), semana: isoSemana(x.d) }));
    const ua = j.ultima_atualizacao ? new Date(j.ultima_atualizacao).toLocaleString("pt-BR") : "—";
    document.getElementById("sub-info").textContent =
      `${(j.total || REGISTROS.length).toLocaleString("pt-BR")} OS • período ${j.intervalo || "—"} • atualizado em ${ua}`;
    popularSelects();
    renderTudo();
  }

  function popularSelects() {
    preencher("f-empresa", distinct(REGISTROS.map((r) => r.e)).sort(), "Todas as empresas", (v) => v);
    preencher("f-tecnico", distinct(REGISTROS.map((r) => r.t)).sort(), "Todos os técnicos", (v) => v);
    preencher("f-mes", distinct(REGISTROS.map((r) => r.mes)).sort(), "Todos os meses", rotuloMes);
    preencher("f-semana", distinct(REGISTROS.map((r) => r.semana)).sort(), "Todas as semanas", rotuloSemana);
  }
  function preencher(id, valores, vazio, rotulo) {
    document.getElementById(id).innerHTML = `<option value="">${vazio}</option>` +
      valores.map((v) => `<option value="${v}">${rotulo(v)}</option>`).join("");
  }

  function passa(r) {
    return (grupo === "todos" || ehInfra(r) === (grupo === "infra")) &&
      (filtros.e.size === 0 || filtros.e.has(r.e)) &&
      (filtros.t.size === 0 || filtros.t.has(r.t)) &&
      (filtros.mes.size === 0 || filtros.mes.has(r.mes)) &&
      (filtros.semana.size === 0 || filtros.semana.has(r.semana)) &&
      (filtros.d.size === 0 || filtros.d.has(r.d)) &&
      (filtros.fin.size === 0 || filtros.fin.has(r.f)) &&
      (filtros.mo.size === 0 || filtros.mo.has(r.mo)) &&
      (filtros.ta.size === 0 || filtros.ta.has(r.ta)) &&
      (filtros.rj.size === 0 || filtros.rj.has(r.rj));
  }
  function filtrados() { return REGISTROS.filter(passa); }
  function alternar(dim, valor) { const s = filtros[dim]; if (s.has(valor)) s.delete(valor); else s.add(valor); sincronizarSelects(); renderTudo(); }
  function definir(dim, valor) { filtros[dim].clear(); if (valor) filtros[dim].add(valor); renderTudo(); }
  function sincronizarSelects() {
    const map = { e: "f-empresa", mes: "f-mes" };
    for (const [dim, id] of Object.entries(map)) {
      document.getElementById(id).value = filtros[dim].size === 1 ? [...filtros[dim]][0] : "";
    }
  }
  function semanasPermitidas() { const base = filtros.mes.size ? REGISTROS.filter((r) => filtros.mes.has(r.mes)) : REGISTROS; return distinct(base.map((r) => r.semana)).sort(); }
  function atualizarSelectSemana() {
    const permitidas = semanasPermitidas(); const set = new Set(permitidas);
    for (const s of [...filtros.semana]) if (!set.has(s)) filtros.semana.delete(s);
    const atual = filtros.semana.size === 1 ? [...filtros.semana][0] : "";
    preencher("f-semana", permitidas, filtros.mes.size ? "Todas as semanas do mês" : "Todas as semanas", rotuloSemana);
    document.getElementById("f-semana").value = atual;
  }
  function tecnicosPermitidos() { const base = filtros.e.size ? REGISTROS.filter((r) => filtros.e.has(r.e)) : REGISTROS; return distinct(base.map((r) => r.t)).sort((a, b) => a.localeCompare(b)); }
  function atualizarSelectTecnico() {
    const permitidos = tecnicosPermitidos(); const set = new Set(permitidos);
    for (const t of [...filtros.t]) if (!set.has(t)) filtros.t.delete(t);
    const atual = filtros.t.size === 1 ? [...filtros.t][0] : "";
    preencher("f-tecnico", permitidos, filtros.e.size ? "Todos os técnicos da equipe" : "Todos os técnicos", (v) => v);
    document.getElementById("f-tecnico").value = atual;
  }
  const DIMS_NUM = new Set(["fin", "mo", "ta", "rj"]);
  function rotuloDim(dim, v) {
    if (dim === "mes") return rotuloMes(v);
    if (dim === "semana") return rotuloSemana(v);
    if (dim === "d") return rotuloDia(v);
    if (dim === "fin") return FIN[v] || "—";
    if (dim === "mo") return MOT[v] || "—";
    if (dim === "ta") return v ? "Externo" : "Interno";
    if (dim === "rj") return v ? "Sim" : "Não";
    return v;
  }
  function renderChips() {
    const box = document.getElementById("chips"); const chips = [];
    for (const dim of Object.keys(filtros)) for (const v of filtros[dim]) {
      chips.push(`<span class="chip">${NOMES_DIM[dim]}: ${rotuloDim(dim, v)}<button data-dim="${dim}" data-v="${v}">×</button></span>`);
    }
    box.innerHTML = chips.join("");
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () =>
      alternar(b.dataset.dim, DIMS_NUM.has(b.dataset.dim) ? +b.dataset.v : b.dataset.v)));
  }

  function renderTudo() {
    atualizarSelectTecnico(); atualizarSelectSemana();
    const dados = filtrados();
    renderChips(); renderKpis(dados);
    renderGraficoDia(dados); renderGraficoEmpresa(dados); renderGraficoTecnico(dados); renderGraficoDias(dados);
    renderGraficoFinalidade(dados); renderGraficoMotivo(dados); renderGraficoTipoAtend(dados);
    renderTabelaTecnicos(dados); renderTabelaDias(dados);
  }

  function renderKpis(dados) {
    const dias = distinct(dados.map((r) => r.d));
    const tecnicos = distinct(dados.map((r) => r.ti));
    const porDia = {}; dados.forEach((r) => { (porDia[r.d] ||= new Set()).add(r.ti); });
    const equipesDia = Object.values(porDia).map((s) => s.size);
    const mediaEquipes = equipesDia.length ? media(equipesDia) : 0;
    const n = dados.length || 1;
    const taxaSucesso = (dados.filter((r) => r.su === 1).length / n * 100).toFixed(1).replace(".", ",");
    const taxaRej = (dados.filter((r) => r.rj === 1).length / n * 100).toFixed(1).replace(".", ",");
    const kpis = [
      ["Total de OS encerradas", dados.length.toLocaleString("pt-BR")],
      ["Técnicos ativos", tecnicos.length],
      ["Dias no período", dias.length],
      ["Média OS/dia", dias.length ? (dados.length / dias.length).toFixed(1) : "0"],
      ["Média equipes/dia", mediaEquipes.toFixed(1)],
      ["Média OS/técnico", tecnicos.length ? (dados.length / tecnicos.length).toFixed(1) : "0"],
      ["Taxa de sucesso", taxaSucesso + "%"],
      ["Taxa de rejeição", taxaRej + "%"],
    ];
    document.getElementById("kpis").innerHTML = kpis.map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  }

  function renderGraficoDia(dados) {
    const dias = distinct(dados.map((r) => r.d)).sort();
    const os = dias.map((d) => dados.filter((r) => r.d === d).length);
    const equipes = dias.map((d) => distinct(dados.filter((r) => r.d === d).map((r) => r.ti)).length);
    desenhar("g-dia", {
      type: "bar",
      data: { labels: dias.map(rotuloDia), datasets: [
        { label: "OS encerradas", data: os, backgroundColor: CORES.azul, yAxisID: "y", order: 2 },
        { label: "Equipes", data: equipes, type: "line", borderColor: CORES.laranja, backgroundColor: CORES.laranja, yAxisID: "y1", tension: .3, order: 1, pointRadius: 2 },
      ] },
      options: opcoes({ scales: {
        y: { beginAtZero: true, position: "left", title: { display: true, text: "OS" } },
        y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "Equipes" } },
      }, onClick: cliqueChart("d", dias) }),
    });
  }
  function renderGraficoEmpresa(dados) {
    const ag = agregarContagem(dados, "e");
    desenhar("g-empresa", { type: "bar", data: { labels: ag.labels, datasets: [{ label: "OS", data: ag.valores, backgroundColor: CORES.os }] },
      options: opcoes({ indexAxis: "y", onClick: cliqueChart("e", ag.labels), plugins: { legend: { display: false } } }) });
  }
  function renderGraficoTecnico(dados) {
    const ag = agregarContagem(dados, "t", 20);
    desenhar("g-tecnico", { type: "bar", data: { labels: ag.labels, datasets: [{ label: "OS", data: ag.valores, backgroundColor: CORES.azul }] },
      options: opcoes({ indexAxis: "y", onClick: cliqueChart("t", ag.labels), plugins: { legend: { display: false } } }) });
  }
  function renderGraficoDias(dados) {
    const porTec = {}; dados.forEach((r) => { (porTec[r.t] ||= new Set()).add(r.d); });
    const pares = Object.entries(porTec).map(([t, s]) => [t, s.size]).sort((a, b) => b[1] - a[1]).slice(0, 20);
    desenhar("g-dias", { type: "bar", data: { labels: pares.map((p) => p[0]), datasets: [{ label: "Dias", data: pares.map((p) => p[1]), backgroundColor: CORES.laranja }] },
      options: opcoes({ indexAxis: "y", onClick: cliqueChart("t", pares.map((p) => p[0])), plugins: { legend: { display: false } } }) });
  }
  // ----------- Tipos de OS (finalidade) -----------
  function renderGraficoFinalidade(dados) {
    const c = {}; dados.forEach((r) => { c[r.f] = (c[r.f] || 0) + 1; });
    const pares = Object.entries(c).map(([k, v]) => [+k, v]).sort((a, b) => b[1] - a[1]);
    desenhar("g-finalidade", {
      type: "bar",
      data: { labels: pares.map((p) => FIN[p[0]] || "—"), datasets: [{ label: "OS", data: pares.map((p) => p[1]), backgroundColor: CORES.os }] },
      options: opcoes({ indexAxis: "y", onClick: cliqueChart("fin", pares.map((p) => p[0])), plugins: { legend: { display: false } } }),
    });
  }

  // ----------- Motivos de não-conclusão (só OS sem sucesso) -----------
  function renderGraficoMotivo(dados) {
    const c = {}; dados.forEach((r) => { if (r.su === 0 && r.mo !== undefined) c[r.mo] = (c[r.mo] || 0) + 1; });
    const pares = Object.entries(c).map(([k, v]) => [+k, v]).sort((a, b) => b[1] - a[1]).slice(0, 15);
    desenhar("g-motivo", {
      type: "bar",
      data: { labels: pares.map((p) => MOT[p[0]] || "—"), datasets: [{ label: "OS não concluídas", data: pares.map((p) => p[1]), backgroundColor: CORES.laranja }] },
      options: opcoes({ indexAxis: "y", onClick: cliqueChart("mo", pares.map((p) => p[0])), plugins: { legend: { display: false } } }),
    });
  }

  // ----------- Interno × Externo (rosca) -----------
  function renderGraficoTipoAtend(dados) {
    const interno = dados.filter((r) => r.ta === 0).length;
    const externo = dados.filter((r) => r.ta === 1).length;
    desenhar("g-tipoatend", {
      type: "doughnut",
      data: { labels: ["Interno", "Externo"], datasets: [{ data: [interno, externo], backgroundColor: [CORES.os, CORES.laranja], borderWidth: 2, borderColor: "#fff" }] },
      options: opcoes({ cutout: "62%", onClick: cliqueChart("ta", [0, 1]) }),
    });
  }

  function agregarContagem(dados, campo, topN) {
    const c = {}; dados.forEach((r) => { c[r[campo]] = (c[r[campo]] || 0) + 1; });
    let pares = Object.entries(c).sort((a, b) => b[1] - a[1]);
    if (topN) pares = pares.slice(0, topN);
    return { labels: pares.map((p) => p[0]), valores: pares.map((p) => p[1]) };
  }

  function renderTabelaTecnicos(dados) {
    const m = {};
    dados.forEach((r) => { const k = r.t + "||" + r.e; (m[k] ||= { empresa: r.e, tecnico: r.t, os: 0, dias: new Set() }); m[k].os++; m[k].dias.add(r.d); });
    let linhas = Object.values(m).map((x) => ({ empresa: x.empresa, tecnico: x.tecnico, os: x.os, dias: x.dias.size, media: x.dias.size ? x.os / x.dias.size : 0 }));
    const busca = (document.getElementById("busca-tec").value || "").toLowerCase();
    if (busca) linhas = linhas.filter((l) => l.tecnico.toLowerCase().includes(busca) || l.empresa.toLowerCase().includes(busca));
    const { col, dir } = ordenacaoTec;
    linhas.sort((a, b) => (typeof a[col] === "string" ? a[col].localeCompare(b[col]) : a[col] - b[col]) * dir);
    document.querySelector("#tab-tecnicos tbody").innerHTML = linhas.map((l) =>
      `<tr><td>${l.empresa}</td><td>${l.tecnico}</td><td class="num">${l.os}</td><td class="num">${l.dias}</td><td class="num">${l.media.toFixed(1)}</td></tr>`).join("");
  }
  function renderTabelaDias(dados) {
    const m = {}; dados.forEach((r) => { (m[r.d] ||= { os: 0, eq: new Set() }); m[r.d].os++; m[r.d].eq.add(r.ti); });
    const linhas = Object.entries(m).sort((a, b) => b[0].localeCompare(a[0]));
    document.querySelector("#tab-dias tbody").innerHTML = linhas.map(([d, x]) =>
      `<tr><td>${rotuloDia(d)}/${d.slice(0, 4)}</td><td class="num">${x.eq.size}</td><td class="num">${x.os}</td></tr>`).join("");
  }

  function opcoes(extra) {
    return Object.assign({ responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } } } }, extra);
  }
  function desenhar(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart(document.getElementById(id), cfg); }
  function cliqueChart(dim, valores) {
    return (evt, _el, chart) => {
      const pts = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
      if (!pts.length) return;
      const valor = valores[pts[0].index];
      if (valor !== undefined) alternar(dim, valor);
    };
  }

  document.getElementById("f-empresa").addEventListener("change", (e) => definir("e", e.target.value));
  document.getElementById("f-tecnico").addEventListener("change", (e) => definir("t", e.target.value));
  document.getElementById("f-mes").addEventListener("change", (e) => definir("mes", e.target.value));
  document.getElementById("f-semana").addEventListener("change", (e) => definir("semana", e.target.value));
  // Segmentado Infra / Operacional
  document.querySelectorAll("#f-grupo button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#f-grupo button").forEach((x) => x.classList.toggle("active", x === b));
    grupo = b.dataset.g;
    filtros.e.clear(); filtros.t.clear();  // evita conflito empresa/técnico ao trocar de grupo
    sincronizarSelects(); renderTudo();
  }));
  // Toggle "Só rejeitadas"
  document.getElementById("btn-rej").addEventListener("click", () => {
    const btn = document.getElementById("btn-rej");
    const ativo = filtros.rj.has(1);
    filtros.rj.clear();
    if (!ativo) filtros.rj.add(1);
    btn.classList.toggle("on", !ativo);
    renderTudo();
  });
  document.getElementById("btn-limpar").addEventListener("click", () => {
    Object.values(filtros).forEach((s) => s.clear());
    grupo = "todos";
    document.querySelectorAll("#f-grupo button").forEach((x) => x.classList.toggle("active", x.dataset.g === "todos"));
    document.getElementById("btn-rej").classList.remove("on");
    sincronizarSelects(); renderTudo();
  });
  document.getElementById("busca-tec").addEventListener("input", () => renderTabelaTecnicos(filtrados()));
  document.querySelectorAll("#tab-tecnicos th").forEach((th) => th.addEventListener("click", () => {
    const col = th.dataset.col; ordenacaoTec.dir = ordenacaoTec.col === col ? -ordenacaoTec.dir : -1; ordenacaoTec.col = col; renderTabelaTecnicos(filtrados());
  }));

  carregar();
})();
