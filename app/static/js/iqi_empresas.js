// IQI/IQM consolidado por empresa.
//
// A conta é `reincidências ÷ total de OSs da empresa`, e não a média dos
// percentuais dos técnicos. A diferença não é detalhe: média de percentual dá
// o mesmo peso a quem fez 11 OSs e a quem fez 60, e é assim que uma empresa
// com um técnico ruim de baixo volume parece pior do que é — ou o contrário.
//
// Ao selecionar mais de uma empresa, a linha de rodapé traz o consolidado das
// selecionadas, pela mesma fórmula (soma de reincidências ÷ soma de OSs).
//
// Fica DENTRO da visualização Gráfico, abaixo dela. Mês, indicador e
// supervisor vêm do evento `iqifiltro` (iqi.js) em vez de seletores próprios —
// os chips de empresa continuam aqui porque refinam só este bloco e não têm
// equivalente no filtro de cima.
(function () {
  const PACOTE = window.__PACOTE__ || {};
  if (!document.getElementById("view-empresas") || !Object.keys(PACOTE).length) return;

  const inds = Object.keys(PACOTE);
  let IND = inds[0];
  let mesIdx = 0;
  let chart = null;
  const selecionadas = new Set();
  // Supervisor escolhido (null = todos). Recorta os TÉCNICOS antes de somar
  // por empresa — traduzir supervisor em "empresas selecionadas", como era
  // antes, inflaria a empresa com gente que não é dele quando o vínculo é de
  // técnicos avulsos.
  let alcanceSup = null;

  const DADOS = () => PACOTE[IND];
  const mesFechado = (m) => {
    const [mm, yyyy] = m.split("/").map(Number);
    const lim = new Date(yyyy, mm, 0);
    lim.setDate(lim.getDate() + 30);
    return new Date() > lim;
  };

  const $ = (id) => document.getElementById(id);
  const pct = (v) => (v === null ? "—" : `${v.toFixed(2).replace(".", ",")}%`);

  /** Empresa a partir do rótulo "EMPRESA - Nome". */
  const empresaDe = (nome) => (nome.includes(" - ") ? nome.split(" - ")[0].trim() : "(sem empresa)");

  /**
   * Consolida por empresa no mês escolhido.
   *
   * Só entram técnicos elegíveis (acima do mínimo de OSs) — os mesmos que o
   * indicador considera nas outras visões. Incluir quem tem 3 OSs mudaria o
   * número da empresa sem mudar o do técnico, e as telas passariam a discordar.
   */
  function consolidar() {
    const d = DADOS();
    if (!d) return [];
    const acc = new Map();
    const base = window.__iqiSupervisor
      ? window.__iqiSupervisor.filtrar(d.tecnicos, alcanceSup)
      : d.tecnicos;
    for (const t of base) {
      const reg = t.m[mesIdx];
      if (!reg || reg[0] <= d.minOS) continue;
      const emp = empresaDe(t.nome);
      const cur = acc.get(emp) || { empresa: emp, tecnicos: 0, os: 0, cham: 0 };
      cur.tecnicos += 1;
      cur.os += reg[0];
      cur.cham += reg[1];
      acc.set(emp, cur);
    }
    return [...acc.values()]
      .map((e) => ({ ...e, iqi: e.os ? (e.cham / e.os) * 100 : null }))
      .sort((a, b) => (a.iqi ?? 999) - (b.iqi ?? 999));
  }

  const visiveis = (linhas) =>
    selecionadas.size ? linhas.filter((l) => selecionadas.has(l.empresa)) : linhas;

  function renderChips(linhas) {
    $("emp-chips").innerHTML = linhas.map((l) =>
      `<button class="fchip ${selecionadas.has(l.empresa) ? "on" : ""}" data-emp="${l.empresa}">${l.empresa}</button>`
    ).join("");

  }

  function renderKpis(linhas) {
    const sel = visiveis(linhas);
    const os = sel.reduce((s, l) => s + l.os, 0);
    const cham = sel.reduce((s, l) => s + l.cham, 0);
    const consolidado = os ? (cham / os) * 100 : null;
    const meta = DADOS().meta;
    const naMeta = sel.filter((l) => l.iqi !== null && l.iqi < meta).length;

    const kpi = (v, r, cor) =>
      `<div class="kpi"><div class="v"${cor ? ` style="color:${cor}"` : ""}>${v}</div><div class="l">${r}</div></div>`;

    const rotulo = selecionadas.size
      ? `${IND} consolidado — ${selecionadas.size} empresa${selecionadas.size > 1 ? "s" : ""} selecionada${selecionadas.size > 1 ? "s" : ""}`
      : `${IND} consolidado — todas as empresas`;

    $("emp-kpis").innerHTML = [
      kpi(pct(consolidado), rotulo,
          consolidado === null ? null : consolidado < meta ? "var(--success)" : "var(--danger)"),
      kpi(sel.length, "Empresas no recorte"),
      kpi(`${naMeta}/${sel.length}`, `Empresas dentro da meta (< ${meta}%)`),
      kpi(os.toLocaleString("pt-BR"), "OSs somadas"),
      kpi(cham.toLocaleString("pt-BR"), "OSs com chamado"),
    ].join("");
  }

  function renderGrafico(linhas) {
    const sel = visiveis(linhas);
    const META = DADOS().meta;
    if (chart) chart.destroy();
    $("emp-titulo-grafico").textContent = `${IND} por empresa — linha = meta ${META}%`;
    chart = new Chart($("g-empresas"), {
      type: "bar",
      data: {
        labels: sel.map((l) => l.empresa),
        datasets: [
          {
            label: `${IND} %`,
            data: sel.map((l) => l.iqi),
            // Verde dentro da meta, vermelho fora: a cor responde a pergunta
            // antes de o olho chegar no eixo.
            backgroundColor: sel.map((l) => (l.iqi !== null && l.iqi < META ? "#00b074" : "#e63757")),
          },
          {
            label: "Meta", type: "line", data: sel.map(() => META),
            borderColor: "#e63757", borderDash: [6, 4], pointRadius: 0, borderWidth: 2,
          },
        ],
      },
      options: {
        plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { y: { beginAtZero: true, title: { display: true, text: `${IND} %` } } },
      },
    });
  }

  function renderTabela(linhas) {
    const sel = visiveis(linhas);
    const META = DADOS().meta;
    $("tab-empresas").querySelector("tbody").innerHTML = sel.map((l) => `
      <tr>
        <td><b>${l.empresa}</b></td>
        <td class="num">${l.tecnicos}</td>
        <td class="num">${l.os.toLocaleString("pt-BR")}</td>
        <td class="num">${l.cham.toLocaleString("pt-BR")}</td>
        <td class="num" style="font-weight:700;color:${l.iqi < META ? "var(--success)" : "var(--danger)"}">${pct(l.iqi)}</td>
        <td><span class="badge ${l.iqi < META ? "badge-verde" : "badge-vermelho"}">${l.iqi < META ? "na meta" : "acima da meta"}</span></td>
      </tr>`).join("") ||
      `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted)">Nenhuma empresa com técnicos elegíveis neste mês.</td></tr>`;

    // Rodapé com o consolidado do recorte — é a "média geral" das empresas
    // selecionadas, pela mesma fórmula ponderada.
    const os = sel.reduce((s, l) => s + l.os, 0);
    const cham = sel.reduce((s, l) => s + l.cham, 0);
    const geral = os ? (cham / os) * 100 : null;
    $("tab-empresas").querySelector("tfoot").innerHTML = sel.length
      ? `<tr class="total">
           <td>${selecionadas.size ? `Consolidado (${sel.length} selecionadas)` : "Consolidado geral"}</td>
           <td class="num">${sel.reduce((s, l) => s + l.tecnicos, 0)}</td>
           <td class="num">${os.toLocaleString("pt-BR")}</td>
           <td class="num">${cham.toLocaleString("pt-BR")}</td>
           <td class="num">${pct(geral)}</td>
           <td></td>
         </tr>` : "";
  }

  /**
   * `comChips=false` quando só a seleção mudou.
   *
   * Reconstruir os chips a cada clique trocaria o elemento sob o cursor por um
   * novo — pisca e o clique seguinte cai num nó já removido do DOM. Aqui só a
   * classe muda; o HTML dos chips só é refeito quando a lista de empresas em si
   * muda (troca de mês ou de indicador).
   */
  function render(comChips = true) {
    const linhas = consolidar();
    if (comChips) renderChips(linhas);
    else marcarChips();
    renderKpis(linhas);
    renderGrafico(linhas);
    renderTabela(linhas);
  }

  function marcarChips() {
    document.querySelectorAll("#emp-chips .fchip").forEach((c) =>
      c.classList.toggle("on", selecionadas.has(c.dataset.emp)));
  }

  // ---- eventos -----------------------------------------------------------
  $("emp-chips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-emp]");
    if (!b) return;
    const emp = b.dataset.emp;
    if (selecionadas.has(emp)) selecionadas.delete(emp);
    else selecionadas.add(emp);
    render(false);
  });

  // Mês, indicador e supervisor vêm do filtro único da página (iqi.js).
  document.addEventListener("iqifiltro", (e) => {
    const trocouInd = e.detail.ind && e.detail.ind !== IND;
    IND = e.detail.ind || IND;
    mesIdx = Math.min(e.detail.mesIdx, DADOS().meses.length - 1);
    alcanceSup = e.detail.alcanceSup;
    // Trocar de indicador zera os chips: a lista de empresas com volume muda
    // entre IQI e IQM, e um chip que sobrou de outra visão vira recorte vazio.
    if (trocouInd) selecionadas.clear();
    render();
  });

  // Renderiza ao entrar na visão que contém este bloco: o canvas mede 0
  // enquanto está oculto, e um gráfico desenhado assim não se recupera.
  document.addEventListener("iqiview", (e) => { if (e.detail === "grafico") render(); });
})();
