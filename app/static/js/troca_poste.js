// Troca de Poste — filtro de período/cidade, KPIs, gráficos e abas.
// Tudo deriva de window.__TP__; nada de valor fixo no código. Mesmo padrão dos
// outros módulos: o servidor injeta o pacote e o cliente filtra sem round-trip.
(function () {
  const TP = window.__TP__ || {};
  const LINHAS = TP.linhas || [];
  if (!LINHAS.length) return;

  const ROTULO = TP.rotulos_risco || {};
  const ORDEM = TP.ordem_risco || [];
  const HOJE = TP.hoje;
  const ENVIO_LIGADO = TP.envio_os_habilitado === true;

  // Cores por risco: seguem o CUSTO DO ERRO, não estética. Crítico é fibra a
  // menos de 25 m — errar para menos ali é cabo rompido e cliente fora do ar.
  const COR_RISCO = {
    critico: "#e63757",
    alto: "#f5803e",
    medio: "#e5a000",
    baixo: "#00b074",
    sem_rede: "#9da9bb",
    indeterminado: "#27bcfd",
  };
  const BADGE = {
    critico: "badge-vermelho", alto: "badge-ambar", medio: "badge-ambar",
    baixo: "badge-verde", sem_rede: "badge-cinza", indeterminado: "badge-cinza",
  };

  const charts = {};
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("pt-BR"));
  const dataBR = (iso) => (iso ? iso.split("-").reverse().join("/") : "—");

  const estado = { de: TP.padrao.de, ate: TP.padrao.ate, cidade: "", bairro: "",
                   risco: "", turno: "", ordem: null, desc: false };

  // Turno pelo início do desligamento: até 12:00 é manhã, depois é tarde.
  // Sem hora de início não dá para afirmar o turno — a linha fica de fora de
  // ambos os filtros em vez de ser chutada para um deles.
  function noTurno(l) {
    if (!estado.turno) return true;
    if (!l.hora_inicio) return false;
    const manha = l.hora_inicio < "12:00";
    return estado.turno === "manha" ? manha : !manha;
  }

  const somaDias = (iso, dias) => {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + dias);
    return d.toISOString().slice(0, 10);
  };

  // ---- filtragem ---------------------------------------------------------
  const noPeriodo = (l) => (!estado.de || l.data >= estado.de) && (!estado.ate || l.data <= estado.ate);
  function aplicar(opcoes) {
    const o = opcoes || {};
    return LINHAS.filter((l) =>
      noPeriodo(l) &&
      (o.semTurno || noTurno(l)) &&
      (o.semCidade || !estado.cidade || l.cidade === estado.cidade) &&
      (o.semBairro || !estado.bairro || l.bairro === estado.bairro) &&
      (o.semRisco || !estado.risco || l.classificacao === estado.risco));
  }

  // ---- selects dependentes do período ------------------------------------
  function preencherCidades() {
    // A lista ignora o filtro de cidade: senão o usuário fica preso na primeira
    // escolha. Cidade sem evento no período simplesmente não aparece — filtro
    // que oferece opção de resultado vazio faz parecer que o sistema perdeu dado.
    const cont = new Map();
    for (const l of aplicar({ semCidade: true, semBairro: true })) {
      const c = cont.get(l.cidade) || { total: 0, critico: 0 };
      c.total++; if (l.classificacao === "critico") c.critico++;
      cont.set(l.cidade, c);
    }
    const ordenado = [...cont.entries()].sort((a, b) => b[1].critico - a[1].critico || b[1].total - a[1].total);
    const total = [...cont.values()].reduce((s, c) => s + c.total, 0);

    if (estado.cidade && !cont.has(estado.cidade)) {
      avisar(`${estado.cidade} não tem desligamento neste período — filtro de cidade removido.`);
      estado.cidade = ""; estado.bairro = "";
    }
    const sel = $("#tp-cidade");
    sel.innerHTML = `<option value="">Todas (${total})</option>` +
      ordenado.map(([nome, c]) => `<option value="${nome}">${nome} (${c.total})</option>`).join("");
    sel.value = estado.cidade;
  }

  // O atributo `hidden` não basta aqui: `.toolbar label` tem `display:flex` no
  // style.css, e display sempre vence o atributo. Mexer no display direto
  // mantém a correção dentro deste módulo, sem tocar o CSS compartilhado.
  const mostrar = (el, visivel) => { el.style.display = visivel ? "" : "none"; };

  function preencherBairros() {
    const wrap = $("#tp-bairro-wrap");
    if (!estado.cidade) { mostrar(wrap, false); estado.bairro = ""; return; }
    const cont = new Map();
    for (const l of aplicar({ semBairro: true })) {
      if (l.bairro) cont.set(l.bairro, (cont.get(l.bairro) || 0) + 1);
    }
    if (!cont.size) { mostrar(wrap, false); estado.bairro = ""; return; }
    if (estado.bairro && !cont.has(estado.bairro)) estado.bairro = "";
    mostrar(wrap, true);
    const sel = $("#tp-bairro");
    sel.innerHTML = `<option value="">Todos</option>` +
      [...cont.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([b, n]) => `<option value="${b}">${b} (${n})</option>`).join("");
    sel.value = estado.bairro;
  }

  function preencherRiscos() {
    const cont = new Map();
    for (const l of aplicar({ semRisco: true })) cont.set(l.classificacao, (cont.get(l.classificacao) || 0) + 1);
    const sel = $("#tp-risco");
    const presentes = ORDEM.filter((r) => cont.has(r));
    if (estado.risco && !cont.has(estado.risco)) estado.risco = "";
    sel.innerHTML = `<option value="">Todos</option>` +
      presentes.map((r) => `<option value="${r}">${ROTULO[r] || r} (${cont.get(r)})</option>`).join("");
    sel.value = estado.risco;
  }

  let timerAviso = null;
  function avisar(msg) {
    const chips = $("#tp-chips");
    chips.innerHTML = `<span class="chip" style="background:#fdeede;color:#b65a16;">${msg}</span>`;
    clearTimeout(timerAviso);
    timerAviso = setTimeout(() => { chips.innerHTML = ""; }, 6000);
  }

  // ---- KPIs e subtítulo --------------------------------------------------
  function renderKpis(linhas) {
    const cont = {};
    for (const r of ORDEM) cont[r] = 0;
    for (const l of linhas) cont[l.classificacao] = (cont[l.classificacao] || 0) + 1;
    const cidades = new Set(linhas.map((l) => l.cidade)).size;

    const kpi = (v, rot, cor) =>
      `<div class="kpi"><div class="v"${cor ? ` style="color:${cor}"` : ""}>${v}</div><div class="l">${rot}</div></div>`;

    $("#tp-kpis").innerHTML = [
      kpi(fmt(linhas.length), "Desligamentos no período"),
      kpi(fmt(cont.critico), "Crítico — fibra a menos de 25 m", COR_RISCO.critico),
      kpi(fmt(cont.alto), "Alto", COR_RISCO.alto),
      kpi(fmt(cont.medio), "Médio"),
      kpi(fmt(cont.indeterminado), "Indeterminado — precisa de revisão"),
      kpi(fmt(cont.sem_rede), "Sem rede"),
      kpi(fmt(cidades), "Cidades atingidas"),
    ].join("");

    const futuros = linhas.map((l) => l.data).filter((d) => d >= HOJE).sort();
    const prox = futuros.length ? dataBR(futuros[0]).slice(0, 5) : null;
    $("#tp-subnote").innerHTML =
      `${fmt(linhas.length)} desligamentos • ${cidades} cidades • ${dataBR(estado.de)} a ${dataBR(estado.ate)}` +
      (estado.turno ? ` • ${estado.turno === "manha" ? "manhã" : "tarde"}` : "") +
      (prox ? ` • próximo em ${prox}` : "") +
      (TP.ultima_coleta ? ` • coletado em <b>${TP.ultima_coleta}</b>` : "");
  }

  // ---- gráficos ----------------------------------------------------------
  function grafico(id, cfg) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
  }

  function renderGraficos(linhas) {
    // Por dia, empilhado por risco: mostra QUANDO o problema chega.
    const dias = [...new Set(linhas.map((l) => l.data))].sort();
    const riscosPresentes = ORDEM.filter((r) => linhas.some((l) => l.classificacao === r));
    grafico("g-tp-dia", {
      type: "bar",
      data: {
        labels: dias.map((d) => dataBR(d).slice(0, 5)),
        datasets: riscosPresentes.map((r) => ({
          label: ROTULO[r] || r,
          data: dias.map((d) => linhas.filter((l) => l.data === d && l.classificacao === r).length),
          backgroundColor: COR_RISCO[r],
        })),
      },
      options: {
        plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: "Desligamentos" } } },
      },
    });

    const porCidade = new Map();
    for (const l of linhas) {
      const c = porCidade.get(l.cidade) || { total: 0, critico: 0 };
      c.total++; if (l.classificacao === "critico") c.critico++;
      porCidade.set(l.cidade, c);
    }
    const rank = [...porCidade.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 12);
    grafico("g-tp-cidades", {
      type: "bar",
      data: {
        labels: rank.map(([c]) => c),
        datasets: [
          { label: "Sem risco crítico", data: rank.map(([, v]) => v.total - v.critico), backgroundColor: "#27bcfd", stack: "c" },
          { label: "Crítico", data: rank.map(([, v]) => v.critico), backgroundColor: COR_RISCO.critico, stack: "c" },
        ],
      },
      options: {
        indexAxis: "y",
        plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { x: { stacked: true, beginAtZero: true }, y: { stacked: true } },
      },
    });
  }

  // ---- tabela ------------------------------------------------------------
  function renderTabela(linhas) {
    const ordenadas = [...linhas];
    if (estado.ordem) {
      const c = estado.ordem;
      ordenadas.sort((a, b) => {
        let x = a[c], y = b[c];
        if (c === "classificacao") { x = ORDEM.indexOf(x); y = ORDEM.indexOf(y); }
        if (x == null) return 1;
        if (y == null) return -1;
        const r = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
        return estado.desc ? -r : r;
      });
    }
    $("#tp-contagem").textContent = `${fmt(ordenadas.length)} no recorte`;
    const corpo = ordenadas.map((l) => `
      <tr>
        <td><span class="badge ${BADGE[l.classificacao] || "badge-cinza"}">${l.risco_rotulo}</span></td>
        <td><b>${l.cidade}</b><div style="font-size:12px;color:var(--muted)">${l.bairro || "—"}</div></td>
        <td>${[l.tipo_via, l.logradouro].filter(Boolean).join(" ") || l.endereco}
          ${(l.numero_inicio != null || l.numero_fim != null)
            ? `<div style="font-size:12px;color:var(--muted)">nº ${l.numero_inicio ?? "?"} a ${l.numero_fim ?? "?"}</div>` : ""}</td>
        <td style="white-space:nowrap">${l.data_br}
          <div style="font-size:12px;color:var(--muted)">${l.hora_inicio || "—"}–${l.hora_fim || "—"}</div></td>
        <td class="num">${l.dist_cabo != null ? Math.round(l.dist_cabo) + " m" : "—"}</td>
        <td class="num">${l.qtd_postes ?? "—"}</td>
        <td class="num"><span style="color:${l.geo_validacao === "ok" ? "var(--success)" : "var(--muted)"};font-weight:${l.geo_validacao === "ok" ? 700 : 400}">${l.geo_score != null ? Math.round(l.geo_score) : "—"}</span></td>
      </tr>`).join("");
    $("#tp-tabela").querySelector("tbody").innerHTML =
      corpo || `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted)">Nenhum desligamento com estes filtros.</td></tr>`;
  }

  // ---- abas fixas (não dependem do filtro) -------------------------------
  function renderRevisao() {
    const itens = TP.revisao || [];
    $("#tp-badge-revisao").textContent = itens.length ? ` (${itens.length})` : "";
    $("#tp-rev-kpis").innerHTML = [
      `<div class="kpi"><div class="v">${fmt(itens.length)}</div><div class="l">Na fila de revisão</div></div>`,
      `<div class="kpi"><div class="v">${fmt(LINHAS.filter((l) => l.geo_validacao === "ok").length)}</div><div class="l">Aceitos automaticamente</div></div>`,
    ].join("");
    $("#tp-rev-tabela").querySelector("tbody").innerHTML = itens.map((i) => `
      <tr>
        <td class="num"><b>${i.score != null ? Math.round(i.score) : "—"}</b></td>
        <td><b>${i.cidade}</b><div style="font-size:12px;color:var(--muted)">${i.bairro || "—"}</div></td>
        <td>${i.endereco}</td>
        <td style="white-space:nowrap">${i.data_br}</td>
        <td>${i.metodo || "—"}</td>
        <td class="num">${i.providers_ok ?? "—"}/${i.providers_consultados ?? "—"}</td>
        <td class="num">${i.dispersao != null ? Math.round(i.dispersao) + " m" : "—"}</td>
      </tr>`).join("") ||
      `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted)">Fila vazia — nada aguardando revisão.</td></tr>`;
  }

  // ---- candidatos a OS ---------------------------------------------------
  // Confirmação obrigatória antes de enviar: o clique cria OS real e desloca
  // equipe. O texto do confirm diz o endereço, para não haver "cliquei errado".
  async function abrirEEnviar(l, botao) {
    const script = l.script_os || "";
    if (!confirm(
      `Criar OS no WVSA para:\n\n${l.cidade} — ${l.bairro || ""}\n` +
      `${[l.tipo_via, l.logradouro].filter(Boolean).join(" ")}\n${l.data_br}\n\n` +
      `Isso cria a OS de verdade e desloca equipe.`)) return;

    const marcar = (txt, on) => { botao.textContent = txt; botao.disabled = on; };
    marcar("Criando…", true);
    try {
      const r1 = await fetch("/troca-poste/os", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desligamento_id: l.id, solicitacao: script, executor: "infra" }),
      });
      const rascunho = await r1.json();
      if (!r1.ok) throw new Error(rascunho.erro || `HTTP ${r1.status}`);

      marcar("Enviando…", true);
      const r2 = await fetch(`/troca-poste/os/${rascunho.ordem_id}/enviar`, { method: "POST" });
      const env = await r2.json();
      if (!r2.ok) throw new Error(env.erro || `HTTP ${r2.status}`);

      await acompanhar(rascunho.ordem_id, botao);
    } catch (e) {
      marcar("Erro — tentar de novo", false);
      alert(`Não foi possível enviar: ${e.message}`);
    }
  }

  /** Poll do resultado. O envio roda dentro da VPN, então leva alguns segundos. */
  async function acompanhar(ordemId, botao) {
    const limite = Date.now() + 90000;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 1500));
      let o;
      try {
        o = await (await fetch(`/troca-poste/os/${ordemId}`)).json();
      } catch { continue; }

      if (o.status === "criada") {
        botao.textContent = o.wvsa_os_numero ? `OS ${o.wvsa_os_numero}` : "OS criada";
        botao.disabled = true;
        botao.classList.add("on");
        return;
      }
      if (o.status === "erro") {
        botao.textContent = "Erro — tentar de novo";
        botao.disabled = false;
        alert(`O WVSA recusou: ${o.erro || "sem detalhe"}`);
        return;
      }
    }
    // Estourou o tempo: a ordem pode estar só esperando o coletor subir. Dizer
    // isso é diferente de dizer que falhou.
    botao.textContent = "Aguardando o coletor";
    botao.disabled = false;
    alert("A ordem está na fila, mas o processo de envio não respondeu em 90s. " +
          "Verifique se o coletor está rodando na rede Unetvale — a OS não foi perdida.");
  }

  function renderCandidatos(linhas) {
    const cand = linhas.filter((l) => l.classificacao === "critico");
    $("#tp-cand-contagem").textContent = `${fmt(cand.length)} no recorte`;
    const corpo = $("#tp-candidatos").querySelector("tbody");
    corpo.innerHTML = cand.map((l, i) => `
      <tr data-i="${i}">
        <td><span class="badge ${BADGE[l.classificacao]}">${l.risco_rotulo}</span></td>
        <td><b>${l.cidade}</b><div style="font-size:12px;color:var(--muted)">${l.bairro || "—"}</div></td>
        <td>${[l.tipo_via, l.logradouro].filter(Boolean).join(" ") || l.endereco}</td>
        <td style="white-space:nowrap">${l.data_br}<div style="font-size:12px;color:var(--muted)">${l.hora_inicio || ""}–${l.hora_fim || ""}</div></td>
        <td><button class="btn-ghost" data-script="${i}">Ver script</button></td>
        <td>${ENVIO_LIGADO
          ? `<button class="btn" data-enviar="${i}">Enviar ao WVSA</button>`
          : `<button class="btn sec" disabled title="O envio ao WVSA está desligado no ambiente (OS_ENVIO_HABILITADO). O fluxo ainda não foi validado ponta a ponta.">Envio desligado</button>`}</td>
      </tr>
      <tr data-script-de="${i}" hidden>
        <td colspan="6" style="background:var(--fundo);">
          <pre style="margin:0;white-space:pre-wrap;font-size:12.5px;line-height:1.5;">${(l.script_os || "").replace(/</g, "&lt;")}</pre>
        </td>
      </tr>`).join("") ||
      `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted)">Nenhum crítico no recorte atual.</td></tr>`;

    corpo.onclick = (e) => {
      const verScript = e.target.closest("button[data-script]");
      if (verScript) {
        const i = verScript.dataset.script;
        const lin = corpo.querySelector(`tr[data-script-de="${i}"]`);
        lin.hidden = !lin.hidden;
        verScript.textContent = lin.hidden ? "Ver script" : "Ocultar";
        return;
      }
      const enviar = e.target.closest("button[data-enviar]");
      // Sem ENVIO_LIGADO o botão nem é renderizado com `data-enviar`, então
      // este caminho não existe. A recusa de verdade está no servidor.
      if (enviar) abrirEEnviar(cand[Number(enviar.dataset.enviar)], enviar);
    };
  }

  function renderOrdens() {
    const aviso = $("#tp-os-aviso");
    if (aviso) {
      aviso.className = ENVIO_LIGADO ? "alert alert-erro" : "alert alert-ok";
      aviso.innerHTML = ENVIO_LIGADO
        ? "<b>Envio real ligado.</b> Clicar em <b>Enviar ao WVSA</b> cria a OS de verdade e " +
          "desloca equipe. Cada OS tem seu próprio botão — nenhum job envia sozinho, e a mesma " +
          "ordem não é enviada duas vezes."
        : "<b>Envio ao WVSA desligado.</b> Esta tela mostra os candidatos e o script exato que " +
          "seria enviado, mas nenhuma OS é criada. O fluxo existe e está pronto; falta validá-lo " +
          "ponta a ponta contra o WVSA antes de liberar.";
    }
    // A nota explicativa acompanha o estado: descrever o envio como se ele
    // acontecesse, com o botão desligado, é pior do que não explicar nada.
    const nota = $("#tp-os-nota");
    if (nota) {
      nota.innerHTML = ENVIO_LIGADO
        ? "O envio acontece por um processo dentro da rede Unetvale: o WVSA não é alcançável " +
          "pela internet. Do clique ao número da OS leva alguns segundos. Se esse processo " +
          "estiver fora do ar, a ordem fica em <b>pronta</b> aguardando — nunca é dada como " +
          "enviada sem ter sido."
        : "Quando for liberado, o envio passará por um processo dentro da rede Unetvale — o WVSA " +
          "não é alcançável pela internet, então a Vercel não consegue criar a OS diretamente.";
    }
    const os = TP.ordens || [];
    const conta = (s) => os.filter((o) => o.status === s).length;
    $("#tp-os-kpis").innerHTML = [
      `<div class="kpi"><div class="v">${fmt(LINHAS.filter((l) => l.classificacao === "critico").length)}</div><div class="l">Candidatos (críticos)</div></div>`,
      `<div class="kpi"><div class="v">${fmt(conta("rascunho"))}</div><div class="l">Rascunhos</div></div>`,
      `<div class="kpi"><div class="v">${fmt(conta("criada"))}</div><div class="l">Enviadas ao WVSA</div></div>`,
    ].join("");
    $("#tp-os-tabela").querySelector("tbody").innerHTML = os.map((o) => `
      <tr>
        <td><span class="badge ${o.status === "criada" ? "badge-verde" : o.status === "erro" ? "badge-vermelho" : "badge-cinza"}">${o.status}</span></td>
        <td>${o.criado_em ? dataBR((o.criado_em || "").slice(0, 10)) : "—"}</td>
        <td>${o.executor || "—"}</td><td>${o.periodo || "—"}</td>
        <td>${o.agendamento || "—"}</td><td>${o.wvsa_os_numero || "—"}</td>
        <td style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(o.solicitacao || "").slice(0, 120)}</td>
      </tr>`).join("") ||
      `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted)">Nenhuma OS criada ainda.</td></tr>`;
  }

  // ---- CSV ---------------------------------------------------------------
  function exportarCsv(linhas) {
    const cab = ["Risco", "Cidade", "Bairro", "Endereço", "Data", "Início", "Fim", "Dist. cabo (m)", "Postes", "Score geo"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const corpo = linhas.map((l) => [
      l.risco_rotulo, l.cidade, l.bairro, [l.tipo_via, l.logradouro].filter(Boolean).join(" ") || l.endereco,
      l.data_br, l.hora_inicio, l.hora_fim, l.dist_cabo, l.qtd_postes, l.geo_score,
    ].map(esc).join(";"));
    const blob = new Blob(["﻿" + [cab.map(esc).join(";"), ...corpo].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `troca-de-poste_${estado.de}_a_${estado.ate}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- render principal --------------------------------------------------
  function render() {
    preencherCidades();
    preencherBairros();
    preencherRiscos();
    const linhas = aplicar();
    renderKpis(linhas);
    renderGraficos(linhas);
    renderTabela(linhas);
    renderCandidatos(linhas);
    $("#tp-de").value = estado.de;
    $("#tp-ate").value = estado.ate;
    if (window.__tpMapa) window.__tpMapa.atualizar(linhas);
  }

  // ---- eventos -----------------------------------------------------------
  $("#tp-presets").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-dias]");
    if (!b) return;
    const dias = Number(b.dataset.dias);
    estado.de = HOJE;
    estado.ate = dias <= 1 ? somaDias(HOJE, dias) : somaDias(HOJE, dias);
    if (dias === 1) estado.de = somaDias(HOJE, 1);
    [...$("#tp-presets").children].forEach((x) => x.classList.toggle("active", x === b));
    render();
  });
  $("#tp-de").addEventListener("change", (e) => { estado.de = e.target.value; marcarPresetLivre(); render(); });
  $("#tp-ate").addEventListener("change", (e) => { estado.ate = e.target.value; marcarPresetLivre(); render(); });
  $("#tp-cidade").addEventListener("change", (e) => { estado.cidade = e.target.value; estado.bairro = ""; render(); });
  $("#tp-bairro").addEventListener("change", (e) => { estado.bairro = e.target.value; render(); });
  $("#tp-risco").addEventListener("change", (e) => { estado.risco = e.target.value; render(); });
  $("#tp-turno").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-turno]");
    if (!b) return;
    estado.turno = b.dataset.turno;
    [...$("#tp-turno").children].forEach((x) => x.classList.toggle("active", x === b));
    render();
  });
  $("#tp-limpar").addEventListener("click", () => {
    Object.assign(estado, { de: TP.padrao.de, ate: TP.padrao.ate, cidade: "", bairro: "",
                            risco: "", turno: "", ordem: null, desc: false });
    [...$("#tp-presets").children].forEach((x) => x.classList.toggle("active", x.dataset.dias === "7"));
    [...$("#tp-turno").children].forEach((x) => x.classList.toggle("active", x.dataset.turno === ""));
    render();
  });
  $("#tp-exportar").addEventListener("click", () => exportarCsv(aplicar()));

  function marcarPresetLivre() {
    [...$("#tp-presets").children].forEach((x) => x.classList.remove("active"));
  }

  $("#tp-tabela").querySelector("thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    const col = th.dataset.col;
    estado.desc = estado.ordem === col ? !estado.desc : false;
    estado.ordem = col;
    renderTabela(aplicar());
  });

  $("#tp-abas").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-aba]");
    if (!b) return;
    [...$("#tp-abas").children].forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll("section[data-painel]").forEach((s) => {
      s.hidden = s.dataset.painel !== b.dataset.aba;
    });
    // O mapa e os gráficos precisam de tamanho real para desenhar: se o painel
    // estava oculto, o canvas media 0. Redesenha ao entrar na aba.
    if (b.dataset.aba === "desligamentos") Object.values(charts).forEach((c) => c.resize());
    if (b.dataset.aba === "mapa" && window.__tpMapa) window.__tpMapa.aoMostrar(aplicar());
  });

  // ---- início ------------------------------------------------------------
  renderRevisao();
  renderOrdens();
  render();
})();
