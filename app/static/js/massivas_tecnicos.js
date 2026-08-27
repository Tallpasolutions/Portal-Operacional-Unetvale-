// Massivas — visão "Tempo de atendimento por técnico".
//
// Tempos (marcos do relatório infra11 do WVSA):
//   TMAE  início da massiva  -> acionamento da equipe
//   TMD   acionamento        -> início da execução
//   TME   início da execução -> fim da execução
//   TMM   início da massiva  -> finalização        (META: 7h)
//
// O ranking é balizado pelo TME. Mediana é o padrão porque a média é
// distorcida por massivas deixadas em aberto (e por fechamento em lote).
// Respeita o filtro de período da tela (selects De/Até).
(function () {
  const M = window.__PAYLOAD__ || {};
  const EVENTOS = M.eventos || [];
  const box = document.getElementById("t-kpis");
  if (!box) return;

  const META_MIN = 7 * 60;          // meta de 7h para o TMM
  const AMOSTRA_MINIMA = 5;         // abaixo disso, não disputa o topo
  let base = "mediana";             // mediana | media
  let ordem = "tme";
  let tecnicoSel = "";              // "" = todos
  let soInfra = false;

  // Equipe de infraestrutura: o rótulo do WVSA vem como "EMPRESA - Nome" e as
  // de infra têm INFRA no nome da empresa. Mesmo critério que routes.py usa
  // para EXCLUIR infra do IQI/IQM — as duas telas concordam sobre quem é infra.
  const ehInfra = (rotulo) => /\binfra\b|fandaruff/i.test(rotulo || "");
  let chart = null;

  // Nomes que aparecem na coluna Técnico do WVSA mas NÃO são técnicos de campo
  // (confirmado com a operação). Ficam de fora dos indicadores e do ranking.
  const NAO_TECNICOS = [/hygor\s+dos\s+santos/i];
  const ehTecnicoValido = (nome) => !!nome && !NAO_TECNICOS.some((re) => re.test(nome));

  if (!EVENTOS.length) {
    box.innerHTML = "";
    document.getElementById("tmp-aviso").innerHTML =
      "Os dados por técnico aparecem após a próxima coleta automática " +
      "(o coletor passou a trazer técnico e tempos das massivas).";
    return;
  }

  // ---------- utilidades de tempo ----------
  function parseDT(s) {
    const m = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(s || "");
    if (!m) return null;
    return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  }
  function diff(a, b) {
    const x = parseDT(a), y = parseDT(b);
    if (!x || !y) return null;
    const min = (y - x) / 60000;
    return min >= 0 ? min : null;   // negativo = registro inconsistente
  }
  function fmt(min) {
    if (min === null || min === undefined) return "—";
    const t = Math.round(min), d = Math.floor(t / 1440);
    const h = Math.floor((t % 1440) / 60), mi = t % 60;
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return mi > 0 ? `${h}h ${mi}m` : `${h}h`;
    return `${mi}m`;
  }
  const media = (v) => { const a = v.filter((x) => x !== null); return a.length ? a.reduce((s, n) => s + n, 0) / a.length : null; };
  const mediana = (v) => {
    const a = v.filter((x) => x !== null).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const agregar = (v) => (base === "media" ? media(v) : mediana(v));

  // ---------- período: acompanha os selects De/Até da tela ----------
  function mesesSelecionados() {
    const meses = M.meses || [];
    const ini = document.getElementById("m-ini");
    const fim = document.getElementById("m-fim");
    if (!ini || !fim || ini.value === "" || fim.value === "") return new Set(meses);
    const a = Math.min(+ini.value, +fim.value), b = Math.max(+ini.value, +fim.value);
    return new Set(meses.slice(a, b + 1));
  }

  function tempos(e) {
    return {
      tmae: diff(e.ini, e.acio),
      tmd: diff(e.acio, e.exec_ini),
      tme: diff(e.exec_ini, e.exec_fim),
      tmm: diff(e.ini, e.final),
    };
  }

  function calcular() {
    const set = mesesSelecionados();
    const eventos = EVENTOS
      .filter((e) => !e.mes || set.has(e.mes))
      // remove quem não é técnico de campo (ex.: cadastros administrativos)
      .filter((e) => !e.tecnico || ehTecnicoValido(e.tecnico))
      // filtro de técnico da barra superior
      .filter((e) => !tecnicoSel || e.tecnico === tecnicoSel)
      .filter((e) => !soInfra || ehInfra(e.tecnico));

    const grupos = new Map();
    for (const e of eventos) {
      const k = e.tecnico || "(sem técnico atribuído)";
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(e);
    }

    const linhas = [];
    for (const [nome, lista] of grupos) {
      const t = lista.map(tempos);
      const comTmm = t.map((x) => x.tmm).filter((x) => x !== null);
      linhas.push({
        tecnico: nome,
        semTecnico: nome === "(sem técnico atribuído)",
        n: lista.length,
        tp: lista.filter((e) => e.tp).length,
        erro: lista.length ? (lista.filter((e) => e.erro === true).length / lista.length) * 100 : 0,
        tmae: agregar(t.map((x) => x.tmae)),
        tmd: agregar(t.map((x) => x.tmd)),
        tme: agregar(t.map((x) => x.tme)),
        tmm: agregar(t.map((x) => x.tmm)),
        naMeta: comTmm.filter((x) => x <= META_MIN).length,
        avaliadas: comTmm.length,
      });
    }
    return { linhas, eventos };
  }

  function ordenar(linhas) {
    return [...linhas].sort((a, b) => {
      if (a.semTecnico !== b.semTecnico) return a.semTecnico ? 1 : -1;   // sem técnico vai pro fim
      const ap = a.n < AMOSTRA_MINIMA, bp = b.n < AMOSTRA_MINIMA;
      if (ap !== bp) return ap ? 1 : -1;                                  // amostra baixa não lidera
      const va = ordem === "tecnico" ? 0 : (a[ordem] ?? -1);
      const vb = ordem === "tecnico" ? 0 : (b[ordem] ?? -1);
      return ordem === "tecnico" ? a.tecnico.localeCompare(b.tecnico, "pt") : vb - va;
    });
  }

  // ---------- render ----------
  function renderKpis(linhas, eventos) {
    const t = eventos.map(tempos);
    const comTmm = t.map((x) => x.tmm).filter((x) => x !== null);
    const dentro = comTmm.filter((x) => x <= META_MIN).length;
    const tmm = agregar(t.map((x) => x.tmm));

    // O TMM é o único com meta (7h), então é o único que ganha cor: verde-claro
    // dentro da meta, vermelho-claro acima dela. As cores são as mesmas do
    // badge-verde e do alert-erro do style.css, para não nascer uma terceira
    // paleta só aqui.
    // `null` (sem massiva fechada no recorte) fica neutro — não é "no prazo".
    const estiloTmm =
      tmm === null ? ""
      : tmm <= META_MIN
        ? ' style="background:#e3f6ee;border-color:#b9e6d3"'
        : ' style="background:#fdecee;border-color:#f5c2cc"';

    const geral = [
      ["TMAE (acionamento)", fmt(agregar(t.map((x) => x.tmae))), ""],
      ["TMD (deslocamento)", fmt(agregar(t.map((x) => x.tmd))), ""],
      ["TME (execução)", fmt(agregar(t.map((x) => x.tme))), ""],
      ["TMM (massiva)", fmt(tmm), estiloTmm],
      ["Dentro da meta de 7h", comTmm.length ? `${Math.round((dentro / comTmm.length) * 100)}%` : "—", ""],
      ["Técnicos", linhas.filter((l) => !l.semTecnico).length, ""],
    ];
    box.innerHTML = geral
      .map(([l, v, estilo]) => `<div class="kpi"${estilo}><div class="v">${v}</div><div class="l">${l}</div></div>`)
      .join("");
  }

  function renderGrafico(linhas) {
    const dados = ordenar(linhas).filter((l) => !l.semTecnico && l.tme !== null).slice(0, 15);
    const cores = dados.map((l) => (l.tmm !== null && l.tmm > META_MIN ? "#e63757" : "#2c7be5"));
    const curto = (n) => (n.includes(" - ") ? n.split(" - ").pop() : n);

    if (chart) chart.destroy();
    chart = new Chart(document.getElementById("g-tecnicos"), {
      type: "bar",
      data: {
        labels: dados.map((l) => curto(l.tecnico)),
        datasets: [{ label: "TME", data: dados.map((l) => l.tme), backgroundColor: cores, maxBarThickness: 34 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => {
            const l = dados[c.dataIndex];
            return [l.tecnico,
              `TME ${fmt(l.tme)} · TMM ${fmt(l.tmm)}`,
              `TMAE ${fmt(l.tmae)} · TMD ${fmt(l.tmd)}`,
              `${l.n} massivas (${l.tp} TP) · ${l.naMeta}/${l.avaliadas} na meta`];
          } } },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => fmt(v) } } },
      },
    });
  }

  function renderTabela(linhas) {
    const busca = (document.getElementById("t-busca").value || "").toLowerCase();
    let dados = ordenar(linhas);
    if (busca) dados = dados.filter((l) => l.tecnico.toLowerCase().includes(busca));

    document.querySelector("#tab-tecnicos-massiva tbody").innerHTML = dados.map((l) => {
      const fora = l.tmm !== null && l.tmm > META_MIN;
      const tag = l.semTecnico
        ? ' <span class="badge badge-ambar">sem técnico</span>'
        : (l.n < AMOSTRA_MINIMA ? ' <span class="badge badge-cinza">amostra baixa</span>' : "");
      return `<tr${l.semTecnico ? ' style="opacity:.7"' : ""}>
        <td>${l.tecnico}${tag}</td>
        <td class="num">${l.n}${l.tp ? ` <span style="color:var(--muted-l)">(${l.tp} TP)</span>` : ""}</td>
        <td class="num">${fmt(l.tmae)}</td>
        <td class="num">${fmt(l.tmd)}</td>
        <td class="num" style="font-weight:700">${fmt(l.tme)}</td>
        <td class="num" style="font-weight:700;color:${fora ? "var(--danger)" : (l.tmm !== null ? "var(--success)" : "inherit")}">${fmt(l.tmm)}</td>
        <td class="num">${l.avaliadas ? `${l.naMeta}/${l.avaliadas}` : "—"}</td>
        <td class="num">${l.n ? Math.round(l.erro) + "%" : "—"}</td>
      </tr>`;
    }).join("");
  }

  function renderTudo() {
    const { linhas, eventos } = calcular();
    renderKpis(linhas, eventos);
    renderGrafico(linhas);
    renderTabela(linhas);
  }

  // ---------- exportar imagem (mesmo padrão do IQI) ----------
  function exportar() {
    if (!chart) return;
    const dpr = Math.max(window.devicePixelRatio || 1, 2);
    const w = chart.width, h = chart.height, head = 56;
    const out = document.createElement("canvas");
    out.width = w * dpr; out.height = (h + head) * dpr;
    const ctx = out.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h + head);
    ctx.textAlign = "left"; ctx.fillStyle = "#13243f";
    ctx.font = "700 18px -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText(`Massivas — TME por técnico (${base}) — meta TMM 7h`, 16, 26);
    ctx.fillStyle = "#5e6e82"; ctx.font = "12px -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText("Vermelho = TMM acima da meta · TME = tempo de execução", 16, 45);
    ctx.drawImage(chart.canvas, 0, head, w, h);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `massivas_tempo_por_tecnico_${base}.png`;
    a.click();
  }

  // ---------- filtro de técnico (barra superior) ----------
  function popularSelectTecnicos() {
    const sel = document.getElementById("t-filtro");
    if (!sel) return;
    const nomes = [...new Set(
      EVENTOS.map((e) => e.tecnico).filter((n) => ehTecnicoValido(n))
    )].sort((a, b) => a.localeCompare(b, "pt"));
    sel.innerHTML =
      '<option value="">Todos os técnicos</option>' +
      nomes.map((n) => `<option value="${n}">${n}</option>`).join("");
    sel.addEventListener("change", (e) => {
      tecnicoSel = e.target.value;
      renderTudo();
    });
  }
  popularSelectTecnicos();

  // "Limpar filtros" da tela também zera o técnico e o recorte de infra
  const btnLimpar = document.getElementById("m-limpar");
  if (btnLimpar) btnLimpar.addEventListener("click", () => {
    tecnicoSel = "";
    soInfra = false;
    const sel = document.getElementById("t-filtro");
    if (sel) sel.value = "";
    const bi = document.getElementById("t-infra");
    if (bi) bi.classList.remove("on");
    setTimeout(renderTudo, 0);
  });

  const btnInfra = document.getElementById("t-infra");
  if (btnInfra) btnInfra.addEventListener("click", () => {
    soInfra = !soInfra;
    btnInfra.classList.toggle("on", soInfra);
    // Técnico específico + só-infra se contradizem: o recorte por equipe
    // manda, e o select volta para "todos".
    if (soInfra) {
      tecnicoSel = "";
      const sel = document.getElementById("t-filtro");
      if (sel) sel.value = "";
    }
    renderTudo();
  });

  // ---------- eventos de UI ----------
  document.querySelectorAll("#t-base button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#t-base button").forEach((x) => x.classList.toggle("active", x === b));
    base = b.dataset.b;
    document.getElementById("t-base-txt").textContent = base;
    renderTudo();
  }));
  document.getElementById("t-busca").addEventListener("input", () => renderTabela(calcular().linhas));
  document.getElementById("t-export").addEventListener("click", exportar);
  document.querySelectorAll("#tab-tecnicos-massiva th").forEach((th) => th.addEventListener("click", () => {
    const c = th.dataset.col;
    ordem = c === "n" ? "n" : c === "erro" ? "erro" : c === "meta" ? "avaliadas" : c;
    renderTudo();
  }));
  // acompanha o filtro de período da tela
  ["m-ini", "m-fim"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", renderTudo);
  });

  renderTudo();
})();
