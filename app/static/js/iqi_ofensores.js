// IQI/IQM — visualização "Ofensores": técnicos com % ACIMA DA MÉDIA do mês
// (entre os avaliados, i.e., com ao menos minOS OSs), do pior para o melhor.
// Componente independente; segue o indicador do seletor compartilhado e usa a
// meta oficial do indicador. Meses parciais entram (acompanhamento do mês).
(function () {
  const PACOTE = window.__PACOTE__ || {};
  if (!document.getElementById("view-ofensores") || !Object.keys(PACOTE).length) return;

  const inds = Object.keys(PACOTE);
  let indAtual = inds[0];
  let mesIdx = null;
  let chart = null;

  const fmt = (v) => v.toFixed(2).replace(".", ",") + "%";
  const dados = () => PACOTE[indAtual];
  const mesFechado = (m) => {
    const [mm, yyyy] = m.split("/").map(Number);
    const lim = new Date(yyyy, mm, 0);
    lim.setDate(lim.getDate() + 30);
    return new Date() > lim;
  };

  function montarMeses() {
    const d = dados();
    const sel = document.getElementById("of-mes");
    sel.innerHTML = d.meses.map((m, i) =>
      `<option value="${i}">${m}${mesFechado(m) ? "" : " (Parcial)"}</option>`).join("");
    // padrão = mês mais recente (o objetivo é acompanhar o andamento)
    mesIdx = d.meses.length - 1;
    sel.value = mesIdx;
  }

  function calcular() {
    const d = dados();
    const avaliados = d.tecnicos
      .map((t) => ({ nome: t.nome, curto: t.nome.split(" - ").pop(),
                     os: t.m[mesIdx][0], cham: t.m[mesIdx][1], pct: t.m[mesIdx][2] }))
      .filter((r) => r.os >= d.minOS);
    const media = avaliados.length ? avaliados.reduce((s, r) => s + r.pct, 0) / avaliados.length : 0;
    const ofensores = avaliados.filter((r) => r.pct > media).sort((a, b) => b.pct - a.pct);
    return { avaliados, media, ofensores, meta: d.meta };
  }

  function render() {
    const d = dados();
    if (mesIdx === null || mesIdx >= d.meses.length) montarMeses();
    document.querySelectorAll(".tm-ind-nome").forEach((e) => (e.textContent = d.label || indAtual));
    const { avaliados, media, ofensores, meta } = calcular();

    document.getElementById("of-media").textContent = avaliados.length ? fmt(media) : "—";
    document.getElementById("of-aval").textContent = avaliados.length;
    document.getElementById("of-qtd").textContent = ofensores.length;

    // rótulo de valor sobre cada barra (ranking curto: rotular todos é o ponto)
    const rotulos = {
      id: "rotulosOf",
      afterDatasetsDraw(ch) {
        const ctx = ch.ctx, meta0 = ch.getDatasetMeta(0);
        ctx.save(); ctx.textAlign = "center";
        ctx.font = "600 10px -apple-system, Segoe UI, Roboto, Arial";
        ctx.fillStyle = "#344050";
        meta0.data.forEach((bar, i) => { const r = ofensores[i]; if (r) ctx.fillText(fmt(r.pct), bar.x, bar.y - 6); });
        ctx.restore();
      },
    };

    if (chart) chart.destroy();
    chart = new Chart(document.getElementById("g-ofensores"), {
      type: "bar",
      data: {
        labels: ofensores.map((r) => r.curto),
        datasets: [
          { label: "% do técnico", data: ofensores.map((r) => r.pct),
            backgroundColor: ofensores.map((r) => (r.pct >= meta ? "#e63757" : "#f5803e")),
            order: 3, maxBarThickness: 38 },
          { label: `Meta (${fmt(meta)})`, type: "line", data: ofensores.map(() => meta),
            borderColor: "#e63757", borderWidth: 1.4, borderDash: [6, 4], pointRadius: 0, order: 1 },
          { label: `Média do mês (${fmt(media)})`, type: "line", data: ofensores.map(() => media),
            borderColor: "#5e6e82", borderWidth: 1.4, borderDash: [2, 3], pointRadius: 0, order: 2 },
        ],
      },
      options: {
        layout: { padding: { top: 22 } },
        plugins: {
          legend: { display: true },
          tooltip: { callbacks: { label: (c) => {
            if (c.datasetIndex === 1) return "Meta: " + fmt(meta);
            if (c.datasetIndex === 2) return "Média do mês: " + fmt(media);
            const r = ofensores[c.dataIndex];
            return [r.nome, `${indAtual}: ${fmt(r.pct)} | OSs: ${r.os} | c/ chamado: ${r.cham} | +${fmt(r.pct - media).replace("%", "")} p.p. vs média`];
          } } },
        },
        scales: { y: { beginAtZero: true, ticks: { callback: (v) => v + "%" } } },
      },
      plugins: [rotulos],
    });

    document.querySelector("#tab-ofensores tbody").innerHTML = ofensores.length
      ? ofensores.map((r) => `<tr>
          <td>${r.nome}</td><td class="num">${r.os}</td><td class="num">${r.cham}</td>
          <td class="num" style="color:${r.pct >= meta ? "var(--danger)" : "#b65a16"};font-weight:700;">${fmt(r.pct)}</td>
          <td class="num">+${(r.pct - media).toFixed(2).replace(".", ",")}</td>
        </tr>`).join("")
      : `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px;">Nenhum ofensor no mês (todos na média ou abaixo).</td></tr>`;
  }

  document.getElementById("of-mes").addEventListener("change", (e) => { mesIdx = +e.target.value; render(); });

  // segue o indicador compartilhado (IQI/IQM)
  document.getElementById("indToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (!btn || btn.dataset.id === indAtual) return;
    indAtual = btn.dataset.id; mesIdx = null;
    if (!document.getElementById("view-ofensores").hidden) render();
  });

  // renderiza quando a visualização é ativada
  document.addEventListener("iqiview", (e) => { if (e.detail === "ofensores") render(); });
})();
