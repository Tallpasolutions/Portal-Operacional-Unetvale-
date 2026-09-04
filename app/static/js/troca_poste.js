// Troca de Poste — filtro de período/cidade, KPIs, gráficos e abas.
// Tudo deriva de window.__TP__; nada de valor fixo no código. Mesmo padrão dos
// outros módulos: o servidor injeta o pacote e o cliente filtra sem round-trip.
(function () {
  const TP = window.__TP__ || {};
  const LINHAS = TP.linhas || [];
  const GRUPOS = TP.grupos || [];
  // Sem sair cedo quando não há desligamento: a fila de revisão e as ordens de
  // serviço são trabalho pendente que existe independente da Celesc ter avisos
  // programados. O `return` que havia aqui apagava as duas abas junto.
  if (!document.querySelector("#tp-abas")) return;

  const ROTULO = TP.rotulos_risco || {};
  const ORDEM = TP.ordem_risco || [];
  const HOJE = TP.hoje;
  const ENVIO_LIGADO = TP.envio_os_habilitado === true;
  const ENSAIO = TP.envio_os_ensaio !== false;

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
    // Escolhe o container do painel VISÍVEL: um aviso renderizado numa aba
    // oculta é o mesmo que nenhum aviso, e é na aba de Ordens que o envio
    // falha. Substitui os `alert()` que havia aqui.
    const alvo = [...document.querySelectorAll(".chips")]
      .find((c) => c.closest("section[data-painel]") && !c.closest("section[data-painel]").hidden)
      || $("#tp-chips");
    if (!alvo) return;
    alvo.innerHTML = `<span class="chip" style="background:#fdeede;color:#b65a16;">${msg}</span>`;
    clearTimeout(timerAviso);
    timerAviso = setTimeout(() => { alvo.innerHTML = ""; }, 8000);
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
  // Agrupada por bairro e dia, como a operação enxerga: a Celesc publica o
  // mesmo bairro fatiado em várias ruas para o MESMO desligamento, e 191
  // linhas soltas escondem que são ~40 lugares. O trecho continua acessível —
  // o grupo abre no clique —, porque é ele que diz onde a equipe encosta.
  //
  // A chave vem carimbada do servidor (`grupo_chave`): agrupar aqui por conta
  // própria exigiria um terceiro normalizador de bairro, e é assim que dois
  // grupos "Centro" aparecem sem ninguém entender por quê.
  const abertos = new Set();

  function agruparLinhas(linhas) {
    const mapa = new Map();
    for (const l of linhas) {
      const k = l.grupo_chave || l.id;
      if (!mapa.has(k)) mapa.set(k, []);
      mapa.get(k).push(l);
    }
    return [...mapa.entries()].map(([chave, itens]) => {
      const num = (campo, fn) => {
        const v = itens.map((x) => x[campo]).filter((x) => x != null);
        return v.length ? fn(...v) : null;
      };
      return {
        chave, itens,
        cidade: itens[0].cidade,
        bairro: itens[0].bairro,
        data: itens[0].data,
        data_br: itens[0].data_br,
        // O grupo herda o PIOR risco: um trecho crítico faz o lugar crítico.
        classificacao: itens.map((x) => x.classificacao)
          .sort((a, b) => ORDEM.indexOf(a) - ORDEM.indexOf(b))[0],
        hora_inicio: itens.map((x) => x.hora_inicio).filter(Boolean).sort()[0] || null,
        hora_fim: itens.map((x) => x.hora_fim).filter(Boolean).sort().pop() || null,
        // Menor distância: é a que decide o risco do lugar.
        dist_cabo: num("dist_cabo", Math.min),
        // Máximo, NÃO soma: os mesmos postes aparecem em trechos vizinhos, e
        // somar inventaria rede que não existe.
        qtd_postes: num("qtd_postes", Math.max),
        // Menor score: o elo fraco é o que manda o grupo para a revisão.
        geo_score: num("geo_score", Math.min),
      };
    });
  }

  function renderTabela(linhas) {
    const grupos = agruparLinhas(linhas);
    if (estado.ordem) {
      const c = estado.ordem;
      grupos.sort((a, b) => {
        let x = a[c], y = b[c];
        if (c === "classificacao") { x = ORDEM.indexOf(x); y = ORDEM.indexOf(y); }
        if (x == null) return 1;
        if (y == null) return -1;
        const r = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
        return estado.desc ? -r : r;
      });
    } else {
      grupos.sort((a, b) => (ORDEM.indexOf(a.classificacao) - ORDEM.indexOf(b.classificacao))
                            || String(a.data).localeCompare(String(b.data))
                            || a.cidade.localeCompare(b.cidade));
    }

    $("#tp-contagem").textContent =
      `${fmt(grupos.length)} ${grupos.length === 1 ? "grupo" : "grupos"} · ${fmt(linhas.length)} trechos`;

    const via = (l) => [l.tipo_via, l.logradouro].filter(Boolean).join(" ") || l.endereco;
    const metros = (v) => (v != null ? Math.round(v) + " m" : "—");

    const corpo = grupos.map((g) => {
      const aberto = abertos.has(g.chave);
      const amostra = g.itens.slice(0, 2).map(via).join(", ")
        + (g.itens.length > 2 ? ` +${g.itens.length - 2}` : "");
      const detalhe = g.itens.map((l) => `
        <tr class="tp-trecho" data-de="${g.chave}"${aberto ? "" : " hidden"}>
          <td></td>
          <td></td>
          <td style="padding-left:26px">${via(l)}
            ${(l.numero_inicio != null || l.numero_fim != null)
              ? `<div style="font-size:12px;color:var(--muted)">nº ${l.numero_inicio ?? "?"} a ${l.numero_fim ?? "?"}</div>` : ""}</td>
          <td style="white-space:nowrap;font-size:12px;color:var(--muted)">${l.hora_inicio || "—"}–${l.hora_fim || "—"}</td>
          <td class="num">${metros(l.dist_cabo)}</td>
          <td class="num">${l.qtd_postes ?? "—"}</td>
          <td class="num"><span style="color:${l.geo_validacao === "ok" ? "var(--success)" : "var(--muted)"};font-weight:${l.geo_validacao === "ok" ? 700 : 400}">${l.geo_score != null ? Math.round(l.geo_score) : "—"}</span></td>
        </tr>`).join("");

      return `
        <tr class="tp-grupo" data-grupo="${g.chave}" style="cursor:pointer">
          <td><span class="badge ${BADGE[g.classificacao] || "badge-cinza"}">${ROTULO[g.classificacao] || g.classificacao}</span></td>
          <td><b>${g.cidade}</b><div style="font-size:12px;color:var(--muted)">${g.bairro || "sem bairro"}</div></td>
          <td>
            <b>${g.itens.length} ${g.itens.length === 1 ? "trecho" : "trechos"}</b>
            <span class="tp-seta" style="color:var(--muted)">${aberto ? "▾" : "▸"}</span>
            <div style="font-size:12px;color:var(--muted)">${amostra}</div>
          </td>
          <td style="white-space:nowrap">${g.data_br}
            <div style="font-size:12px;color:var(--muted)">${g.hora_inicio || "—"}–${g.hora_fim || "—"}</div></td>
          <td class="num">${metros(g.dist_cabo)}</td>
          <td class="num">${g.qtd_postes ?? "—"}</td>
          <td class="num">${g.geo_score != null ? Math.round(g.geo_score) : "—"}</td>
        </tr>${detalhe}`;
    }).join("");

    const tbody = $("#tp-tabela").querySelector("tbody");
    tbody.innerHTML = corpo ||
      `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted)">Nenhum desligamento com estes filtros.</td></tr>`;

    tbody.onclick = (e) => {
      const tr = e.target.closest("tr.tp-grupo");
      if (!tr) return;
      const chave = tr.dataset.grupo;
      const abrir = !abertos.has(chave);
      if (abrir) abertos.add(chave); else abertos.delete(chave);
      tbody.querySelectorAll(`tr.tp-trecho[data-de="${CSS.escape(chave)}"]`)
        .forEach((x) => { x.hidden = !abrir; });
      tr.querySelector(".tp-seta").textContent = abrir ? "▾" : "▸";
    };
  }

  // A aba Revisão é do `troca_poste_revisao.js`: ela tem mapa, estado de
  // seleção e escrita própria, e misturar isso aqui faria um arquivo só cuidar
  // de duas telas com ciclos de vida diferentes.

  // ---- candidatos a OS ---------------------------------------------------
  // Confirmação obrigatória antes de enviar: o clique cria OS real e desloca
  // equipe. O texto do confirm diz o endereço, para não haver "cliquei errado".
  function confirmarModal(dlg, texto, aoConfirmar) {
    // `.modal`/`<dialog>` no lugar de `confirm()`: a caixa do navegador vem com
    // o domínio no topo e não pertence à tela (CLAUDE.md §5).
    dlg.querySelector("#tp-dlg-os-texto").innerHTML = texto;
    const ok = dlg.querySelector("#tp-dlg-os-ok");
    const fechar = () => { dlg.close(); ok.onclick = null; };
    dlg.querySelectorAll("[data-fechar]").forEach((b) => { b.onclick = fechar; });
    ok.onclick = () => { fechar(); aoConfirmar(); };
    dlg.showModal();
  }

  async function abrirEEnviar(g, botao) {
    const marcar = (txt, on) => { botao.textContent = txt; botao.disabled = on; };
    marcar("Criando…", true);
    try {
      const r1 = await fetch("/troca-poste/os", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // O grupo inteiro numa OS: é o que o texto da solicitação descreve.
        body: JSON.stringify({ desligamento_ids: g.ids, solicitacao: g.script_os, executor: "infra" }),
      });
      const rascunho = await r1.json();
      if (!r1.ok) throw new Error(rascunho.erro || `HTTP ${r1.status}`);

      // Já existia OS para este bairro/dia — é o desfecho normal de dois
      // operadores na mesma tela, não um erro.
      if (rascunho.ja_existia && ["criada", "enviando", "pronta"].includes(rascunho.status)) {
        marcar(rascunho.status === "criada" ? "OS já criada" : "OS já na fila", true);
        botao.classList.add("on");
        return;
      }

      marcar("Enviando…", true);
      const r2 = await fetch(`/troca-poste/os/${rascunho.ordem_id}/enviar`, { method: "POST" });
      const env = await r2.json();
      if (!r2.ok) throw new Error(env.erro || `HTTP ${r2.status}`);

      await acompanhar(rascunho.ordem_id, botao);
    } catch (e) {
      marcar("Erro — tentar de novo", false);
      avisar(`Não foi possível enviar: ${e.message}`);
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

      // Ensaio é desfecho, não espera: o payload foi montado e conferido e
      // nenhuma requisição saiu. Sem reconhecê-lo aqui, todo ensaio terminaria
      // nos 90 s de timeout, dizendo que o coletor não respondeu.
      if (o.status === "ensaio") {
        botao.textContent = "Ensaio OK";
        botao.disabled = true;
        botao.classList.add("on");
        avisar("Ensaio concluído: payload registrado, nenhuma OS criada no WVSA.");
        return;
      }
      if (o.status === "criada") {
        botao.textContent = o.wvsa_os_numero ? `OS ${o.wvsa_os_numero}` : "OS criada";
        botao.disabled = true;
        botao.classList.add("on");
        return;
      }
      if (o.status === "erro") {
        botao.textContent = "Erro — tentar de novo";
        botao.disabled = false;
        avisar(`O WVSA recusou: ${o.erro || "sem detalhe"}`);
        return;
      }
    }
    // Estourou o tempo: a ordem pode estar só esperando o coletor subir. Dizer
    // isso é diferente de dizer que falhou.
    botao.textContent = "Aguardando o coletor";
    botao.disabled = false;
    avisar("A ordem está na fila, mas o processo de envio não respondeu em 90s. " +
           "Verifique se o coletor está rodando na rede Unetvale — a OS não foi perdida.");
  }

  function renderCandidatos(linhas) {
    // Os grupos vêm prontos do servidor (com o script do bairro/dia já
    // montado). Aqui só se recorta pelos ids que sobreviveram ao filtro da
    // tela — remontar o agrupamento no cliente daria uma segunda definição da
    // mesma regra, e o script exibido deixaria de ser o script enviado.
    const visiveis = new Set(linhas.map((l) => l.id));
    const cand = GRUPOS
      .filter((g) => g.classificacao === "critico" && g.ids.some((id) => visiveis.has(id)));

    $("#tp-cand-contagem").textContent =
      `${fmt(cand.length)} ${cand.length === 1 ? "grupo" : "grupos"} no recorte`;
    const corpo = $("#tp-candidatos").querySelector("tbody");
    corpo.innerHTML = cand.map((g, i) => `
      <tr data-i="${i}">
        <td><span class="badge ${BADGE[g.classificacao]}">${g.risco_rotulo}</span></td>
        <td><b>${g.cidade}</b><div style="font-size:12px;color:var(--muted)">${g.bairro || "sem bairro"}</div></td>
        <td style="white-space:nowrap">${g.data_br}<div style="font-size:12px;color:var(--muted)">${g.hora_inicio || ""}${g.hora_fim ? "–" + g.hora_fim : ""}</div></td>
        <td class="num">${g.qtd}</td>
        <td><button class="btn-ghost" data-script="${i}">Ver script</button></td>
        <td>${ENVIO_LIGADO
          ? `<button class="btn" data-enviar="${i}">${ENSAIO ? "Abrir OS (ensaio)" : "Abrir OS no WVSA"}</button>`
          : `<button class="btn sec" disabled title="O envio ao WVSA está desligado no ambiente (OS_ENVIO_HABILITADO).">Envio desligado</button>`}</td>
      </tr>
      <tr data-script-de="${i}" hidden>
        <td colspan="6" style="background:var(--fundo);">
          <pre style="margin:0;white-space:pre-wrap;font-size:12.5px;line-height:1.5;">${(g.script_os || "").replace(/</g, "&lt;")}</pre>
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
      if (!enviar) return;
      const g = cand[Number(enviar.dataset.enviar)];
      const trechos = g.ids.length === 1 ? "1 trecho" : `${g.ids.length} trechos`;
      confirmarModal($("#tp-dlg-os"),
        `<b>${g.cidade} — ${g.bairro || "sem bairro"}</b><br>${g.data_br} · ${trechos}<br><br>` +
        (ENSAIO
          ? "Modo ensaio: o payload será montado e registrado, e <b>nenhuma OS</b> será criada no WVSA."
          : "Isso cria a OS de verdade e desloca equipe."),
        () => abrirEEnviar(g, enviar));
    };
  }

  function renderOrdens() {
    // Três estados, não dois. Descrever o envio como se ele acontecesse, com o
    // botão em ensaio, seria pior do que não explicar nada.
    const aviso = $("#tp-os-aviso");
    if (aviso) {
      aviso.className = (ENVIO_LIGADO && !ENSAIO) ? "alert alert-erro" : "alert alert-ok";
      aviso.innerHTML = !ENVIO_LIGADO
        ? "<b>Envio ao WVSA desligado.</b> Esta tela mostra os candidatos agrupados e o script " +
          "exato que seria enviado, mas nenhuma OS é criada."
        : ENSAIO
          ? "<b>Modo ensaio.</b> O clique percorre o caminho inteiro — fila, payload, registro — " +
            "e para antes da requisição ao WVSA. <b>Nenhuma OS é criada.</b> É assim que se " +
            "confere o payload sem deslocar equipe; para valer, <code>OS_DRY_RUN=false</code>."
          : "<b>Envio real ligado.</b> Clicar em <b>Abrir OS no WVSA</b> cria a OS de verdade e " +
            "desloca equipe. Uma OS por bairro e dia — a mesma combinação não é enviada duas vezes.";
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
    const criticos = GRUPOS.filter((g) => g.classificacao === "critico");
    $("#tp-os-kpis").innerHTML = [
      `<div class="kpi"><div class="v">${fmt(criticos.length)}</div><div class="l">Grupos candidatos (bairro · dia)</div></div>`,
      `<div class="kpi"><div class="v">${fmt(criticos.reduce((a, g) => a + g.qtd, 0))}</div><div class="l">Trechos críticos que eles cobrem</div></div>`,
      `<div class="kpi"><div class="v">${fmt(conta("rascunho"))}</div><div class="l">Rascunhos</div></div>`,
      `<div class="kpi"><div class="v">${fmt(conta("ensaio"))}</div><div class="l">Ensaios</div></div>`,
      `<div class="kpi"><div class="v">${fmt(conta("criada"))}</div><div class="l">Enviadas ao WVSA</div></div>`,
    ].join("");
    $("#tp-os-tabela").querySelector("tbody").innerHTML = os.map((o) => `
      <tr>
        <td><span class="badge ${o.status === "criada" ? "badge-verde" : o.status === "erro" ? "badge-vermelho" : o.status === "ensaio" ? "badge-ambar" : "badge-cinza"}">${o.status}</span></td>
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

  /** Troca de aba, com o estado na URL.
   *
   * O `?aba=` existe para que a fila de revisão possa ser mandada por link —
   * "olha esses 12 endereços" é uma frase que alguém precisa dizer com um
   * endereço junto. O padrão é o mesmo do `acoes.js`.
   */
  function abrirAba(aba) {
    const botoes = [...$("#tp-abas").children];
    const b = botoes.find((x) => x.dataset.aba === aba) || botoes[0];
    botoes.forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll("section[data-painel]").forEach((s) => {
      s.hidden = s.dataset.painel !== b.dataset.aba;
    });
    const u = new URL(location.href);
    u.searchParams.set("aba", b.dataset.aba);
    history.replaceState(null, "", u);

    // Mapa e gráficos precisam de tamanho real para desenhar: enquanto o painel
    // estava `hidden`, o canvas media 0. Redesenha ao entrar na aba.
    if (b.dataset.aba === "desligamentos") Object.values(charts).forEach((c) => c.resize());
    if (b.dataset.aba === "mapa" && window.__tpMapa) window.__tpMapa.aoMostrar(aplicar());
    // A aba de revisão tem mapa próprio, e pelo mesmo motivo.
    if (b.dataset.aba === "revisao" && window.__tpRevisao) window.__tpRevisao.aoMostrar();
  }

  $("#tp-abas").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-aba]");
    if (b) abrirAba(b.dataset.aba);
  });

  // ---- início ------------------------------------------------------------
  renderOrdens();
  render();
  abrirAba(new URL(location.href).searchParams.get("aba") || "desligamentos");
})();
