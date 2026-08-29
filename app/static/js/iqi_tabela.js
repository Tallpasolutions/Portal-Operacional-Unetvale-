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

  // Base do recorte: o supervisor escolhido (null = todos). Vem antes dos
  // chips de empresa, que refinam dentro do que o supervisor já alcança.
  let alcanceSup = null;

  const noAlcance = () =>
    window.__iqiSupervisor
      ? window.__iqiSupervisor.filtrar(dados().tecnicos, alcanceSup)
      : dados().tecnicos;

  // As empresas oferecidas saem do alcance do supervisor, não do universo
  // inteiro: com um supervisor escolhido, um chip de empresa fora do time
  // dele só poderia levar a um recorte vazio.
  const empresasDisponiveis = () => [...new Set(noAlcance().map((t) => empresaDe(t.nome)))].sort();

  function tecnicosFiltrados() {
    return noAlcance()
      .filter((t) => !empresasSel.size || empresasSel.has(empresaDe(t.nome)))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt"));
  }

  function mesesExibidos() {
    const todos = dados().meses;
    return mesesSel.size ? todos.filter((m) => mesesSel.has(m)) : todos;
  }

  /** Diz por que o recorte ficou vazio; gráfico em branco parece defeito. */
  function notaSupervisor() {
    const box = document.getElementById("tm-supervisores");
    if (!box || !window.__iqiSupervisor) return;
    let nota = box.parentNode.querySelector(".nota-sup");
    if (!nota) {
      nota = document.createElement("div");
      nota.className = "subnote nota-sup";
      nota.style.cssText = "flex-basis:100%;margin:2px 0 0";
      box.insertAdjacentElement("afterend", nota);
    }
    nota.textContent = window.__iqiSupervisor.aviso(alcanceSup, dados().tecnicos) || "";
  }

  function renderFiltros() {
    document.querySelectorAll(".tm-ind-nome").forEach((e) => (e.textContent = dados().label || indAtual));

    // O supervisor recorta a base; os chips de empresa refinam dentro dela.
    // Não dá para traduzir o supervisor em chips de empresa, como era antes:
    // o vínculo pode ser de técnicos avulsos dentro de uma empresa que ele não
    // supervisiona inteira — marcar a empresa mostraria colegas de outro time.
    const supBox = document.getElementById("tm-supervisores");
    const SUP = window.__iqiSupervisor ? window.__iqiSupervisor.lista : [];
    if (supBox) {
      supBox.innerHTML = SUP.length
        ? SUP.map((s) => {
            const partes = [];
            if (s.equipes && s.equipes.length) partes.push(s.equipes.join(", "));
            if (s.tecnicos && s.tecnicos.length) partes.push(`${s.tecnicos.length} tecnico(s) avulso(s)`);
            return `<button class="fchip" data-sup="${s.id}" title="${partes.join(" + ") || "sem vinculo"}">${s.nome}</button>`;
          }).join("")
        : '<span style="font-size:12.5px;color:var(--muted)">nenhum cadastrado — veja Configurações</span>';
      supBox.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        const jaEra = b.classList.contains("on");
        alcanceSup = jaEra ? null : window.__iqiSupervisor.alcanceDe(b.dataset.sup);
        empresasSel.clear();
        renderFiltros(); renderTabela();
        notaSupervisor();
        // `renderFiltros` reconstruiu os chips: remarca pelo dataset, não pela
        // referência antiga do elemento, que já saiu do DOM.
        if (!jaEra) {
          const novo = supBox.querySelector(`button[data-sup="${b.dataset.sup}"]`);
          if (novo) novo.classList.add("on");
        }
      }));
    }

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
    const META = d.meta, MINOS = d.minOS;

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
          // % colorido: verde dentro da meta, vermelho fora, cinza se poucas OSs
          // (>= : quem fez exatamente o mínimo de OSs conta no indicador)
          const pctCls = reg[0] >= MINOS ? (reg[2] < META ? "meta-ok" : "meta-fora") : "meta-neutro";
          row += `<td class="num${cls}">${reg[0]}</td><td class="num${cls}">${reg[1]}</td><td class="num ${pctCls}">${fmtPct(reg[2])}</td>`;
        } else {
          row += `<td class="num vazio-cel">—</td>`.repeat(3); // sem OS no mês
        }
      });
      body += `<tr>${row}</tr>`;
    });
    if (!tecs.length) {
      body = `<tr><td class="sticky-col">—</td><td colspan="${meses.length * 3}" style="text-align:center;color:var(--muted);padding:24px;">Nenhum técnico para os filtros selecionados.</td></tr>`;
    }
    document.getElementById("tab-mensal").innerHTML = `<thead><tr>${h1}</tr><tr>${h2}</tr></thead><tbody>${body}</tbody>`;
    publicar();
  }

  /** Estado dos filtros desta visualização, para os blocos abaixo da tabela.
   *
   * A Causa raiz fica na mesma página e usa estes mesmos chips: supervisor,
   * empresa e período. Dois conjuntos de filtros na mesma tela deixariam
   * alguém ler a causa raiz de uma equipe ao lado da tabela de outra.
   *
   * `meses` sai em "AAAA-MM" porque é assim que o payload das categorias
   * indexa; aqui dentro eles são "MM/AAAA", que é o formato do IQI/IQM.
   */
  function publicar() {
    document.dispatchEvent(new CustomEvent("iqifiltrotabela", { detail: {
      ind: indAtual,
      alcanceSup: alcanceSup,
      empresas: [...empresasSel],
      meses: mesesExibidos().map((m) => { const [mm, aa] = m.split("/"); return `${aa}-${mm}`; }),
      // Quais meses estão fechados, pela MESMA regra da tabela (fim do mês +
      // 30 dias de auditoria). Sem repassar, a Causa raiz marcaria só o
      // último como parcial e julho apareceria fechado no dia 29 de agosto.
      fechados: mesesExibidos().filter(mesFechado)
        .map((m) => { const [mm, aa] = m.split("/"); return `${aa}-${mm}`; }),
    } }));
  }

  // Segue o indicador do seletor compartilhado (#indToggle do iqi.js), sem alterá-lo.
  document.getElementById("indToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (!btn || btn.dataset.id === indAtual) return;
    indAtual = btn.dataset.id;
    empresasSel.clear(); mesesSel.clear(); alcanceSup = null;
    document.querySelectorAll("#tm-supervisores .fchip").forEach((x) => x.classList.remove("on"));
    renderFiltros(); renderTabela();
  });

  // Alterna entre as DUAS visualizações. Ofensores e Por empresa moram dentro
  // do Gráfico; a Causa raiz, dentro da Tabela mensal. O evento "iqiview" avisa
  // os blocos de dentro para renderizarem ao serem exibidos — canvas e tabela
  // medidos com a página oculta saem com tamanho zero.
  sw.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    sw.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    const v = b.dataset.view;
    ["grafico", "tabela"].forEach((nome) => {
      const el = document.getElementById("view-" + nome);
      if (el) el.hidden = nome !== v;
    });
    if (v === "tabela") { renderFiltros(); renderTabela(); }
    document.dispatchEvent(new CustomEvent("iqiview", { detail: v }));
  }));
})();
