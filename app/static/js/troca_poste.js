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
  // `let`: o botão "Atualizar do WVSA" do modal troca o catálogo inteiro pelo
  // que o coletor acabou de copiar, sem recarregar a página.
  let CATALOGO = TP.catalogos || {};
  const ROTULO_CAUSA = TP.rotulos_causa || {};

  // O grupo vem do servidor só com os `ids` — os trechos são procurados aqui,
  // no `linhas` que a página já tem. Mandar os dois seria repetir 209 kB.
  const PORID = new Map(LINHAS.map((l) => [l.id, l]));
  const trechosDo = (g) => (g.ids || []).map((id) => PORID.get(id)).filter(Boolean);

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

  // O pacote padrão traz de hoje em diante. Um período pedido na URL
  // (`?de=&ate=`) é o que a página abre mostrando — é assim que o histórico
  // chega, e o link com o período continua valendo se for mandado a alguém.
  const PEDIDO = TP.pedido || TP.padrao;
  const CARREGADO = TP.carregado || { de: HOJE, ate: null };
  // Cidade, risco e tipo de serviço são CONJUNTOS: vazio = todos. O bairro
  // segue um só, com chave "cidade|bairro" — com duas cidades marcadas,
  // "CENTRO" sozinho seria dois lugares.
  const estado = { de: PEDIDO.de, ate: PEDIDO.ate, cidades: new Set(), bairro: "",
                   riscos: new Set(), causas: new Set(), turno: "", ordem: null, desc: false };
  const chaveBairro = (l) => `${l.cidade}|${l.bairro}`;

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
      (o.semCidade || !estado.cidades.size || estado.cidades.has(l.cidade)) &&
      (o.semBairro || !estado.bairro || chaveBairro(l) === estado.bairro) &&
      (o.semRisco || !estado.riscos.size || estado.riscos.has(l.classificacao)) &&
      (o.semCausa || !estado.causas.size || estado.causas.has(l.causa_categoria)));
  }

  // ---- seleção múltipla (`.dropdown` de marcar) ---------------------------
  //
  // A lista é redesenhada a cada filtro (as contagens mudam), mas só é
  // RECRIADA quando as opções mudam: com as mesmas opções, atualiza contagem
  // e marcação no lugar. Recriar o HTML a cada clique troca o nó sob o cursor
  // e o clique seguinte cai num nó já removido (CLAUDE.md §6, "chips que se
  // reconstroem") — numa lista que fica aberta enquanto se marca, é o caso.
  function desenharMulti(id, opcoes, marcados, vazio, total) {
    const det = $(id);
    const lista = det.querySelector(".lista-marcar");
    const assinatura = opcoes.map((o) => o.valor).join("\u0001");
    if (lista.dataset.assinatura !== assinatura) {
      lista.dataset.assinatura = assinatura;
      lista.innerHTML = `<button type="button" class="todos-marcar" data-todos>${vazio}</button>` +
        opcoes.map((o) => `
          <label class="linha-marcar"><input type="checkbox" value="${escHtml(o.valor)}">
            <span>${escHtml(o.rotulo)} <span class="n"></span></span>
            <button type="button" class="so" data-so="${escHtml(o.valor)}" title="Só esta opção">só</button>
          </label>`).join("");
    }
    const porValor = new Map(opcoes.map((o) => [o.valor, o]));
    lista.querySelector("[data-todos]").textContent = `${vazio} (${fmt(total)})`;
    lista.querySelectorAll(".linha-marcar").forEach((linha) => {
      const cb = linha.querySelector("input");
      cb.checked = marcados.has(cb.value);
      linha.querySelector(".n").textContent = `(${fmt(porValor.get(cb.value).n)})`;
    });
    const escolhidos = opcoes.filter((o) => marcados.has(o.valor));
    det.querySelector("[data-resumo]").textContent = !escolhidos.length ? vazio
      : escolhidos.length === 1 ? escolhidos[0].rotulo
      : `${escolhidos.length} escolhidos`;
    det.querySelector("summary").classList.toggle("on", escolhidos.length > 0);
  }

  /** Liga um `.dropdown` ao conjunto do estado. Delegado no contêiner, que
   * sobrevive aos redesenhos da lista. */
  function ligarMulti(id, conjunto, depois) {
    const lista = $(id).querySelector(".lista-marcar");
    lista.addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox]");
      if (!cb) return;
      if (cb.checked) estado[conjunto].add(cb.value); else estado[conjunto].delete(cb.value);
      if (depois) depois();
      render();
    });
    lista.addEventListener("click", (e) => {
      const so = e.target.closest("[data-so]");
      const todos = e.target.closest("[data-todos]");
      if (!so && !todos) return;
      // Dentro do <label>: sem isto o clique no "só" também alternaria o checkbox.
      e.preventDefault();
      estado[conjunto] = new Set(so ? [so.dataset.so] : []);
      if (depois) depois();
      render();
    });
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

    const sumidas = [...estado.cidades].filter((c) => !cont.has(c));
    if (sumidas.length) {
      avisar(`${sumidas.join(", ")} não ${sumidas.length > 1 ? "têm" : "tem"} desligamento neste período — ${sumidas.length > 1 ? "saíram" : "saiu"} do filtro de cidade.`);
      sumidas.forEach((c) => estado.cidades.delete(c));
      estado.bairro = "";
    }
    desenharMulti("#tp-cidade",
      ordenado.map(([nome, c]) => ({ valor: nome, rotulo: nome, n: c.total })),
      estado.cidades, "Todas", total);
  }

  // O atributo `hidden` não basta aqui: `.toolbar label` tem `display:flex` no
  // style.css, e display sempre vence o atributo. Mexer no display direto
  // mantém a correção dentro deste módulo, sem tocar o CSS compartilhado.
  const mostrar = (el, visivel) => { el.style.display = visivel ? "" : "none"; };

  function preencherBairros() {
    const wrap = $("#tp-bairro-wrap");
    if (!estado.cidades.size) { mostrar(wrap, false); estado.bairro = ""; return; }
    const cont = new Map();
    for (const l of aplicar({ semBairro: true })) {
      if (l.bairro) cont.set(chaveBairro(l), (cont.get(chaveBairro(l)) || 0) + 1);
    }
    if (!cont.size) { mostrar(wrap, false); estado.bairro = ""; return; }
    if (estado.bairro && !cont.has(estado.bairro)) estado.bairro = "";
    mostrar(wrap, true);
    // Com mais de uma cidade, o nome dela vai junto: "CENTRO" existe em várias.
    const comCidade = estado.cidades.size > 1;
    const sel = $("#tp-bairro");
    sel.innerHTML = `<option value="">Todos</option>` +
      [...cont.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, n]) => {
          const [cid, b] = k.split("|");
          return `<option value="${escHtml(k)}">${escHtml(b)}${comCidade ? ` · ${escHtml(cid)}` : ""} (${n})</option>`;
        }).join("");
    sel.value = estado.bairro;
  }

  /** Tipos de serviço PRESENTES no recorte, com a contagem.
   *
   * Só os que existem: oferecer "Serviço comercial" quando não há nenhum leva
   * a pessoa a filtrar e ver tabela vazia sem entender por quê. Ignora o
   * próprio filtro de causa ao montar a lista, senão escolher um tipo apagaria
   * os outros e prenderia o usuário na primeira seleção.
   */
  function preencherCausas() {
    const base = aplicar({ semCausa: true });
    const cont = {};
    for (const l of base) {
      if (l.causa_categoria) cont[l.causa_categoria] = (cont[l.causa_categoria] || 0) + 1;
    }
    const chaves = Object.keys(cont).sort((a, b) => cont[b] - cont[a]);
    [...estado.causas].forEach((c) => { if (!cont[c]) estado.causas.delete(c); });
    desenharMulti("#tp-causa",
      chaves.map((c) => ({ valor: c, rotulo: ROTULO_CAUSA[c] || c, n: cont[c] })),
      estado.causas, "Todos", base.length);
  }

  function preencherRiscos() {
    const base = aplicar({ semRisco: true });
    const cont = new Map();
    for (const l of base) cont.set(l.classificacao, (cont.get(l.classificacao) || 0) + 1);
    const presentes = ORDEM.filter((r) => cont.has(r));
    [...estado.riscos].forEach((r) => { if (!cont.has(r)) estado.riscos.delete(r); });
    desenharMulti("#tp-risco",
      presentes.map((r) => ({ valor: r, rotulo: ROTULO[r] || r, n: cont.get(r) })),
      estado.riscos, "Todos", base.length);
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
      kpi(fmt(agruparLinhas(linhas).length), "Deslocamentos (bairro · dia)"),
      kpi(fmt(linhas.length), "Trechos que eles cobrem"),
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
      (estado.de && estado.de < HOJE ? " • inclui desligamentos já realizados" : "") +
      (TP.ultima_coleta ? ` • coletado em <b>${TP.ultima_coleta}</b>` : "");
  }

  // ---- gráficos ----------------------------------------------------------
  function grafico(id, cfg) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
  }

  function renderGraficos(linhas) {
    // Por dia, empilhado por risco: mostra QUANDO o problema chega.
    // Conta DESLOCAMENTO, não trecho. A Celesc fatia o mesmo bairro em várias
    // ruas para o mesmo desligamento: em 04/09/2026, Areias do Meio tinha 17
    // trechos num dia — o gráfico mostrava 17 eventos onde há uma viagem só, e
    // o pico dizia mais sobre como a Celesc redigiu o aviso do que sobre o que
    // vem pela frente. O total de trechos continua no KPI ao lado.
    const grupos = agruparLinhas(linhas);
    const dias = [...new Set(grupos.map((g) => g.data))].sort();
    const riscosPresentes = ORDEM.filter((r) => grupos.some((g) => g.classificacao === r));
    grafico("g-tp-dia", {
      type: "bar",
      data: {
        labels: dias.map((d) => dataBR(d).slice(0, 5)),
        datasets: riscosPresentes.map((r) => ({
          label: ROTULO[r] || r,
          data: dias.map((d) => grupos.filter((g) => g.data === d && g.classificacao === r).length),
          backgroundColor: COR_RISCO[r],
        })),
      },
      options: {
        plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: "Desligamentos" } } },
      },
    });

    // Também por deslocamento, pela mesma razão do gráfico acima — e aqui o
    // efeito era pior: a cidade cujo aviso a Celesc escreveu rua a rua subia no
    // ranking sobre a que escreveu o bairro inteiro numa linha, sem diferença
    // nenhuma de trabalho.
    const porCidade = new Map();
    for (const g of grupos) {
      const c = porCidade.get(g.cidade) || { total: 0, critico: 0 };
      c.total++; if (g.classificacao === "critico") c.critico++;
      porCidade.set(g.cidade, c);
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
          <td><b>${g.cidade}</b><div style="font-size:12px;color:var(--muted)">${g.bairro || "sem bairro"}</div>${motivoHtml(g.ordem)}</td>
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
  /** Monta os campos do modal a partir do catálogo copiado do WVSA.
   *
   * Roda uma vez: as listas vêm do servidor e não mudam durante a sessão. Se o
   * catálogo estiver vazio (o coletor nunca sincronizou), os selects ficam com
   * a opção neutra e a OS sai como saía antes — sem escolha, não quebrada.
   */
  function montarCamposOs() {
    desenharOpcoesOs();
    // `infra` é o padrão histórico (era o valor cravado no código), mas agora é
    // um default visível que dá para trocar, não uma decisão escondida.
    $("#tp-os-executor").value = "infra";

    const conta = () => {
      const n = $("#tp-os-tecnicos").querySelectorAll("input:checked").length;
      $("#tp-os-tec-conta").textContent = n ? `· ${n} selecionado${n > 1 ? "s" : ""}` : "";
    };
    // Ouvinte no contêiner, preso UMA vez: a lista é redesenhada quando a
    // agenda é atualizada, e um ouvinte por desenho contaria em dobro.
    $("#tp-os-tecnicos").addEventListener("change", conta);
    conta();
    $("#tp-os-agenda-atualizar").addEventListener("click", atualizarAgenda);
  }

  /** Os selects fixos e a lista da equipe, a partir do CATALOGO atual. */
  function desenharOpcoesOs() {
    const opcoes = (lista, vazio) =>
      `<option value="">${vazio}</option>` +
      (lista || []).map((o) => `<option value="${o.valor}">${o.rotulo}</option>`).join("");

    $("#tp-os-executor").innerHTML = opcoes(CATALOGO.executor, "— escolher —");
    $("#tp-os-periodo").innerHTML = opcoes(CATALOGO.periodo, "não definir");
    $("#tp-os-tipo-tecnico").innerHTML = opcoes(CATALOGO.tipo_tecnico, "não definir");

    const grupos = CATALOGO.tecnicos_por_empresa || [];
    $("#tp-os-tecnicos").innerHTML = grupos.length
      ? grupos.map((g) => `
          <div style="padding:6px 8px 2px;font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;">${g.empresa}</div>
          ${g.tecnicos.map((t) => `
            <label class="linha-marcar">
              <input type="checkbox" value="${t.valor}">
              <span>${t.rotulo}</span>
            </label>`).join("")}`).join("")
      : `<div style="padding:12px;color:var(--muted);font-size:12.5px">Catálogo do WVSA ainda não sincronizado — a OS sairá sem equipe designada.</div>`;
  }

  /** Preenche a agenda com os slots DO DIA daquele grupo.
   *
   * Depende do grupo, então roda ao abrir o modal — e não uma vez no início,
   * como os selects fixos. A agenda do WVSA cobre poucos dias à frente
   * (medido em 10/09/2026: 35 slots em três dias) e o desligamento costuma
   * estar semanas à frente, então o normal é NÃO haver slot: a tela diz isso,
   * em vez de mostrar uma lista de outro dia.
   */
  let grupoNoModal = null;

  function montarAgenda(g) {
    grupoNoModal = g;
    mostrarCopia();
    const sel = $("#tp-os-agendamento");
    const nota = $("#tp-os-agenda-nota");
    const doDia = (CATALOGO.agendamento_por_data || {})[g.data] || [];

    sel.innerHTML = `<option value="">não agendar</option>` +
      doDia.map((a) => {
        const m = a.metadados || {};
        return `<option value="${a.valor}">${m.turno || ""} · ${m.tecnico || a.rotulo}</option>`;
      }).join("");
    sel.disabled = !doDia.length;
    nota.textContent = doDia.length
      ? `${doDia.length} horário${doDia.length > 1 ? "s" : ""} livre${doDia.length > 1 ? "s" : ""} em ${g.data_br}.`
      : `Nenhum horário na agenda do WVSA para ${g.data_br}. A OS é criada sem agendamento — dá para encaixar depois, no próprio WVSA.`;
  }

  const hhmm = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  /** "Agenda copiada do WVSA às 14:32 (há 12 min)" — ao lado do botão.
   *
   * É o que explica por que o horário que a pessoa acabou de liberar no WVSA
   * não está na lista: a cópia é de antes. Sem isso a lista parece a verdade.
   */
  function mostrarCopia(extra) {
    const quando = CATALOGO.agenda_copiada_em;
    let txt = "";
    if (quando) {
      const min = Math.max(0, Math.round((Date.now() - new Date(quando)) / 60000));
      const dia = new Date(quando).toLocaleDateString("pt-BR");
      const hoje = new Date().toLocaleDateString("pt-BR");
      txt = `Agenda copiada do WVSA ${dia === hoje ? "" : `em ${dia} `}às ${hhmm(quando)}` +
            (dia === hoje ? ` (${min < 1 ? "agora" : `há ${min} min`})` : "") + ".";
    }
    $("#tp-os-agenda-copia").innerHTML = [txt, extra].filter(Boolean).join(" ");
  }

  /** Botão "Atualizar do WVSA": pede ao coletor uma cópia da agenda AGORA.
   *
   * O caso: o operador liberou a agenda de um técnico no WVSA e o horário
   * não aparece, porque a cópia automática é de 15 em 15 min. O portal não
   * alcança o WVSA (CLAUDE.md §2) — o pedido fica no banco, o `enviar_os.py`
   * atende de dentro da rede (ciclo de 5 s), e a tela espera o desfecho.
   *
   * O modal fica aberto e o que já foi escolhido fica escolhido: refazer
   * equipe e período depois de atualizar é o atrito que manda a pessoa
   * abrir a OS direto no WVSA.
   */
  async function atualizarAgenda() {
    const btn = $("#tp-os-agenda-atualizar");
    const rotulo = btn.textContent;
    const fim = (extra) => { btn.disabled = false; btn.textContent = rotulo; mostrarCopia(extra); };
    const erro = (t) => `<span style="color:var(--danger)">${escHtml(t)}</span>`;
    btn.disabled = true;
    btn.textContent = "Pedindo ao coletor…";
    try {
      const r = await fetch("/troca-poste/agenda/atualizar", { method: "POST" });
      const p = await r.json();
      if (!r.ok) throw new Error(p.erro || `HTTP ${r.status}`);
      const inicio = Date.now();
      while (Date.now() - inicio < 90000) {
        await new Promise((ok) => setTimeout(ok, 2000));
        let e;
        try {
          const r2 = await fetch(`/troca-poste/agenda/atualizar?pedido=${encodeURIComponent(p.pedido_em)}`);
          e = await r2.json();
          if (!r2.ok) throw new Error(e.erro || `HTTP ${r2.status}`);
        } catch { continue; }  // uma volta perdida não é desfecho
        if (!e.atendido) {
          // Passou de um ciclo e meio do coletor: dizer que é ELE que falta,
          // e não o portal, poupa a pessoa de clicar de novo achando que travou.
          if (Date.now() - inicio > 15000) btn.textContent = "Aguardando o coletor…";
          continue;
        }
        if (!e.ok) { fim(erro(`Não deu para copiar a agenda: ${e.erro || "falha sem detalhe"}.`)); return; }
        const antes = ((CATALOGO.agendamento_por_data || {})[grupoNoModal && grupoNoModal.data] || []).length;
        aplicarCatalogos(e.catalogos || {});
        const depois = ((CATALOGO.agendamento_por_data || {})[grupoNoModal && grupoNoModal.data] || []).length;
        fim(grupoNoModal && antes !== depois ? `<b>${antes} → ${depois} horários em ${grupoNoModal.data_br}.</b>` : "");
        return;
      }
      fim(erro("O coletor não respondeu em 90 s. Ele roda na máquina da Unetvale, dentro da rede do WVSA — pode estar desligada ou fora da VPN. A lista abaixo continua sendo a da última cópia."));
    } catch (e) {
      fim(erro(`Não foi possível pedir a atualização: ${e.message}`));
    }
  }

  /** Troca o catálogo e redesenha o modal sem perder o que já foi escolhido. */
  function aplicarCatalogos(novo) {
    const c = camposOs();
    CATALOGO = novo;
    desenharOpcoesOs();
    preencherCampos(c);
    if (!grupoNoModal) return;
    montarAgenda(grupoNoModal);
    const sel = $("#tp-os-agendamento");
    if (c.agendamento) {
      if ([...sel.options].some((op) => op.value === c.agendamento)) {
        sel.value = c.agendamento;
      } else {
        $("#tp-os-agenda-nota").textContent += " O horário que estava escolhido não está mais livre.";
      }
    }
  }

  /** O que o operador escolheu no modal. */
  function camposOs() {
    return {
      executor: $("#tp-os-executor").value || "infra",
      periodo: $("#tp-os-periodo").value || null,
      tipo_tecnico: $("#tp-os-tipo-tecnico").value || null,
      agendamento: $("#tp-os-agendamento").value || null,
      tecnico_ids: [...$("#tp-os-tecnicos").querySelectorAll("input:checked")].map((i) => i.value),
    };
  }

  function confirmarModal(dlg, texto, aoConfirmar) {
    // `.modal`/`<dialog>` no lugar de `confirm()`: a caixa do navegador vem com
    // o domínio no topo e não pertence à tela (CLAUDE.md §5).
    dlg.querySelector("#tp-dlg-os-texto").innerHTML = texto;
    const ok = dlg.querySelector("#tp-dlg-os-ok");
    const fechar = () => { dlg.close(); ok.onclick = null; };
    dlg.querySelectorAll("[data-fechar]").forEach((b) => { b.onclick = fechar; });
    // Lê os campos ANTES de fechar: `<dialog>` fechado não devolve valor de
    // input, e a OS sairia com tudo vazio sem erro nenhum.
    ok.onclick = () => { const c = camposOs(); fechar(); aoConfirmar(c); };
    dlg.showModal();
  }

  async function abrirEEnviar(g, botao, campos) {
    const marcar = (txt, on) => { botao.textContent = txt; botao.disabled = on; };
    marcar("Criando…", true);
    let ordemId = null;
    try {
      const r1 = await fetch("/troca-poste/os", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // O grupo inteiro numa OS: é o que o texto da solicitação descreve.
        body: JSON.stringify({ desligamento_ids: g.ids, solicitacao: g.script_os, ...campos }),
      });
      const rascunho = await r1.json();
      if (!r1.ok) throw new Error(rascunho.erro || `HTTP ${r1.status}`);

      // Já existia OS para este bairro/dia — é o desfecho normal de dois
      // operadores na mesma tela, não um erro.
      if (rascunho.ja_existia) {
        // Já havia OS para este bairro/dia — o desfecho normal de dois
        // operadores na mesma tela, e agora também de uma tela aberta antes de
        // o grupo ter sido resolvido em outra aba.
        const r = await fetch(`/troca-poste/os/${rascunho.ordem_id}`);
        const o = await r.json();
        marcarAberto(g, o);
        avisar(reenviavel(g.ordem)
          ? `Este bairro/dia já tem uma ordem que não chegou ao WVSA (${o.status}). Use "Tentar de novo" na linha dele.`
          : `Este bairro/dia já tem OS (${rascunho.status}). Nada foi criado em duplicidade.`);
        return;
      }

      ordemId = rascunho.ordem_id;
      marcar("Enviando…", true);
      const r2 = await fetch(`/troca-poste/os/${rascunho.ordem_id}/enviar`, { method: "POST" });
      const env = await r2.json();
      if (!r2.ok) throw new Error(env.erro || `HTTP ${r2.status}`);

      await acompanhar(rascunho.ordem_id, botao, g);
    } catch (e) {
      marcar("Erro — tentar de novo", false);
      avisar(`Não foi possível enviar: ${e.message}`);
      // A ordem já nasceu (o rascunho foi gravado) e o que falhou foi o passo
      // seguinte: a linha passa a apontar para ELA, senão o próximo clique
      // tentaria criar de novo e cairia na ordem existente.
      if (ordemId) {
        try { marcarAberto(g, await (await fetch(`/troca-poste/os/${ordemId}`)).json()); } catch { /* fica o botão */ }
      }
    }
  }

  /** Poll do resultado. O envio roda dentro da VPN, então leva alguns segundos. */
  /** Marca o grupo como resolvido e o tira da lista NA HORA.
   *
   * Sem isto o grupo só sai no próximo carregamento da página — e é exatamente
   * na janela entre o clique e o recarregar que alguém clica de novo achando
   * que a primeira vez não pegou.
   */
  function marcarAberto(g, o) {
    if (g) {
      g.ordem = { ordem_id: o.id, status: o.status,
                  wvsa_os_numero: o.wvsa_os_numero, ensaio: o.dry_run === true,
                  erro: o.erro || null, erro_ambiguo: o.erro_ambiguo === true,
                  campos: o.campos || {} };
    }
    // A MESMA ordem pode passar por aqui várias vezes (falhou, tentou de novo,
    // saiu): troca a linha pelo id em vez de empilhar uma linha por tentativa.
    const linha = { id: o.id, status: o.status, wvsa_os_numero: o.wvsa_os_numero,
                    executor: o.executor, periodo: o.periodo, agendamento: o.agendamento,
                    data_inicio: o.data_inicio, erro: o.erro || null,
                    erro_ambiguo: o.erro_ambiguo === true, campos: o.campos || {},
                    criado_em: new Date().toISOString(),
                    agrupamentos: { rotulo: g ? `${g.bairro || "SEM BAIRRO"} — ${g.data_br}` : "—" } };
    const atual = (TP.ordens || []).findIndex((x) => x.id === o.id);
    if (atual >= 0) {
      TP.ordens[atual] = { ...TP.ordens[atual], ...linha,
                           criado_em: TP.ordens[atual].criado_em,
                           agrupamentos: TP.ordens[atual].agrupamentos || linha.agrupamentos };
    } else {
      TP.ordens = [linha, ...(TP.ordens || [])];
    }
    renderOrdens();
    renderCandidatos(aplicar());
  }

  /** A ordem do grupo não chegou ao WVSA e pode ser enviada de novo?
   *
   * `erro` é a falha do envio; `rascunho` é o clique que criou a ordem e caiu
   * antes de autorizar o envio. Os dois deixavam o grupo preso: o botão
   * "Abrir OS" refazia a CRIAÇÃO, o banco devolvia a ordem existente pela
   * `chave_idempotencia`, e nada era reenviado — a ordem ficava parada para
   * sempre, com o grupo listado entre os "já com OS". Ensaio fica de fora: ele
   * carrega `dry_run` da criação e nunca vira envio real.
   */
  function reenviavel(o) {
    return !!o && !o.ensaio && (o.status === "erro" || o.status === "rascunho");
  }

  /** Reenvia a ordem que já existe, com os campos escolhidos agora. */
  async function reenviar(g, botao, campos) {
    botao.textContent = "Enviando…"; botao.disabled = true;
    try {
      const r = await fetch(`/troca-poste/os/${g.ordem.ordem_id}/enviar`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campos }),
      });
      const env = await r.json();
      if (!r.ok) throw new Error(env.erro || `HTTP ${r.status}`);
      await acompanhar(g.ordem.ordem_id, botao, g);
    } catch (e) {
      botao.textContent = "Tentar de novo"; botao.disabled = false;
      avisar(`Não foi possível reenviar: ${e.message}`);
    }
  }

  async function acompanhar(ordemId, botao, grupo) {
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
        avisar("Ensaio concluído: payload registrado, nenhuma OS criada no WVSA.");
        marcarAberto(grupo, o);
        return;
      }
      if (o.status === "criada") {
        avisar(o.wvsa_os_numero
          ? `OS ${o.wvsa_os_numero} criada no WVSA.`
          : "OS criada no WVSA.");
        marcarAberto(grupo, o);
        return;
      }
      if (o.status === "erro") {
        // `o.erro` já é a frase do servidor (`motivo_erro`), com o texto do
        // WVSA quando ele explicou. Redesenhar põe o grupo de volta na lista
        // com "Tentar de novo" ligado a ESTA ordem — antes o botão refazia a
        // criação, e o banco devolvia a mesma ordem sem reenviar nada.
        marcarAberto(grupo, o);
        avisar(`A OS não foi criada. ${o.erro || "Falha sem detalhe."}`);
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

  // ---- mini-mapa dos candidatos -----------------------------------------
  //
  // UMA instância de Leaflet, movida para a linha aberta. Criar e destruir um
  // mapa por linha vazaria listeners e refaria o download dos tiles a cada
  // clique; mover o container e chamar `invalidateSize` reaproveita os dois.
  let mapaOS = null, caixaOS = null;

  function caixaDoMapa() {
    if (!caixaOS) {
      caixaOS = document.createElement("div");
      // `max-width` pelo viewport: a célula do detalhe é tão larga quanto a
      // TABELA, que no celular já rola de lado. Sem a trava, o mapa nascia com
      // 597px numa tela de 375 e só se via metade dele — os pontos ficavam
      // atrás da borda até alguém arrastar a tabela.
      caixaOS.style.cssText = "height:280px;border-radius:8px;overflow:hidden;" +
        "border:1px solid var(--borda-2);max-width:min(100%, calc(100vw - 72px));";
    }
    return caixaOS;
  }

  /** Desenha os trechos DAQUELE grupo, de perto. */
  function mapaDoGrupo(g, destino) {
    destino.appendChild(caixaDoMapa());
    if (!mapaOS) {
      // Sem zoom por rolagem: o mapa vive dentro de uma página que rola, e
      // capturar a roda faria a página travar sob o cursor.
      mapaOS = L.map(caixaOS, { scrollWheelZoom: false, attributionControl: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mapaOS);
      mapaOS.__camada = L.layerGroup().addTo(mapaOS);
    }
    mapaOS.__camada.clearLayers();

    const pts = trechosDo(g).filter((l) => l.lat != null && l.lon != null);
    for (const l of pts) {
      const via = [l.tipo_via, l.logradouro].filter(Boolean).join(" ") || l.endereco;
      L.circleMarker([l.lat, l.lon], {
        radius: 7, color: "#fff", weight: 2,
        fillColor: COR_RISCO[l.classificacao] || COR_RISCO.indeterminado, fillOpacity: 0.95,
      }).bindTooltip(via, { direction: "top" }).addTo(mapaOS.__camada);
    }

    // `invalidateSize` antes de enquadrar: o container acabou de aparecer e o
    // Leaflet ainda o considera do tamanho anterior — enquadrar antes disso
    // deixaria os pontos apertados num canto (§6).
    setTimeout(() => {
      mapaOS.invalidateSize();
      if (!pts.length) { mapaOS.setView([-27.1, -48.75], 9); return; }
      if (pts.length === 1) { mapaOS.setView([pts[0].lat, pts[0].lon], 17); return; }
      // `maxZoom` para não colar demais quando os trechos são vizinhos: a
      // pergunta aqui é "onde é isso", e a rua ao lado precisa aparecer.
      mapaOS.fitBounds(L.latLngBounds(pts.map((l) => [l.lat, l.lon])).pad(0.25), { maxZoom: 17 });
    }, 60);

    return pts.length;
  }

  const escHtml = (t) => String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /** Por que a última tentativa falhou, embaixo do bairro. Vazio se não falhou. */
  function motivoHtml(o) {
    if (!o || o.status !== "erro") return "";
    return `<div style="font-size:12px;color:var(--danger);margin-top:4px;max-width:46ch;">` +
      `${escHtml(o.erro || "A tentativa anterior falhou.")}</div>`;
  }

  /** Põe no modal o que a tentativa anterior escolheu. */
  function preencherCampos(c) {
    c = c || {};
    if (c.executor) $("#tp-os-executor").value = c.executor;
    $("#tp-os-periodo").value = c.periodo || "";
    $("#tp-os-tipo-tecnico").value = c.tipo_tecnico || "";
    const marcados = new Set((c.tecnico_ids || []).map(String));
    $("#tp-os-tecnicos").querySelectorAll("input[type=checkbox]").forEach((i) => {
      i.checked = marcados.has(i.value);
    });
    $("#tp-os-tecnicos").dispatchEvent(new Event("change"));
  }

  /** "Tentar de novo": o mesmo modal, com a escolha anterior e o motivo da falha.
   *
   * A falha mais comum em produção (as duas recusas do WVSA até 09/10/2026) é
   * "O campo selecionado da agenda já está sendo usado": o slot foi ocupado
   * entre a cópia da agenda e o envio. Repetir com o MESMO slot falharia igual,
   * então o horário anterior só volta selecionado se ainda estiver livre.
   */
  function abrirReenvio(g, botao) {
    const o = g.ordem;
    const c = o.campos || {};
    preencherCampos(c);
    montarAgenda(g);
    const sel = $("#tp-os-agendamento");
    if (c.agendamento) {
      if ([...sel.options].some((op) => op.value === c.agendamento)) {
        sel.value = c.agendamento;
      } else {
        $("#tp-os-agenda-nota").textContent +=
          " O horário escolhido na tentativa anterior não está mais livre.";
      }
    }
    $("#tp-dlg-os-ok").textContent = "Tentar de novo";
    const trechos = g.ids.length === 1 ? "1 trecho" : `${g.ids.length} trechos`;
    // Conexão que caiu no meio do POST não diz se o WVSA gravou. Reenviar sem
    // conferir é o caminho para a OS sair DUAS vezes e deslocar duas equipes.
    const aviso = o.erro_ambiguo
      ? `<div class="alert alert-erro" style="margin:12px 0 0;"><b>Confira no WVSA antes.</b> ` +
        `A conexão caiu durante o envio, e a OS pode ter sido criada mesmo assim. ` +
        `Procure por ${escHtml(g.bairro || "este bairro")} em ${g.data_br} na listagem de OS de infra; ` +
        `se ela estiver lá, não tente de novo.</div>`
      : "";
    confirmarModal($("#tp-dlg-os"),
      `<b>${escHtml(g.cidade)} — ${escHtml(g.bairro || "sem bairro")}</b><br>${g.data_br} · ${trechos}<br><br>` +
      `A tentativa anterior não criou a OS:<br><span style="color:var(--danger)">${escHtml(o.erro || "o clique anterior criou a ordem, mas o envio não chegou a ser autorizado.")}</span>` +
      aviso,
      (campos) => reenviar(g, botao, campos));
  }

  function renderCandidatos(linhas) {
    // Os grupos vêm prontos do servidor (com o script do bairro/dia já
    // montado). Aqui só se recorta pelos ids que sobreviveram ao filtro da
    // tela — remontar o agrupamento no cliente daria uma segunda definição da
    // mesma regra, e o script exibido deixaria de ser o script enviado.
    // TODOS os grupos do recorte, não só os críticos. A classificação continua
    // ordenando (crítico primeiro) e aparece no badge de cada linha, mas
    // esconder o resto tirava da tela desligamento que a operação quer abrir —
    // inclusive os `indeterminado`, que são exatamente os que esperam revisão.
    const visiveis = new Set(linhas.map((l) => l.id));
    const noRecorte = GRUPOS.filter((g) => g.ids.some((id) => visiveis.has(id)));

    // Grupo que JÁ tem OS sai da lista. A `chave_idempotencia` impede a
    // duplicata no banco, mas o risco nunca foi o banco: é o botão continuar
    // convidando ao clique num lugar já resolvido — e a pessoa clicar achando
    // que a primeira tentativa falhou, ou ir conferir no WVSA se abriu duas.
    // Eles não somem da tela: estão logo abaixo, na tabela de Ordens de
    // serviço, agora identificados pelo bairro e pelo dia.
    // Grupo do passado não é candidato: o histórico está aqui para consulta,
    // e OS de obra que já aconteceu não desloca ninguém. O servidor recusa
    // também — isto só evita o botão convidando ao clique.
    const passados = noRecorte.filter((g) => (g.data || "") < HOJE).length;
    // Ordem que NÃO chegou ao WVSA (falhou, ou o clique caiu no meio) continua
    // aqui, com "Tentar de novo": o lugar não está resolvido, e escondê-la entre
    // os "já com OS" com selo verde dizia o contrário.
    const cand = noRecorte.filter((g) => (!g.ordem || reenviavel(g.ordem)) && (g.data || "") >= HOJE);
    const abertos = noRecorte.filter((g) => g.ordem && !reenviavel(g.ordem));
    candidatosOs = cand;
    renderKpisOs();

    $("#tp-cand-contagem").textContent =
      `${fmt(cand.length)} ${cand.length === 1 ? "grupo" : "grupos"} no recorte` +
      (abertos.length ? ` · ${fmt(abertos.length)} já com OS` : "") +
      (passados ? ` · ${fmt(passados)} já realizados, fora da lista` : "");

    const nota = $("#tp-cand-abertos");
    if (nota) {
      nota.innerHTML = abertos.length
        ? abertos.map((g) => {
            const o = g.ordem;
            const marca = o.ensaio
              ? `<span class="badge badge-ambar">ensaio</span>`
              : `<span class="badge badge-verde">OS ${o.wvsa_os_numero || o.status}</span>`;
            return `<span class="chip">${g.cidade} · ${g.bairro || "sem bairro"} · ${g.data_br} ${marca}</span>`;
          }).join("")
        : "";
    }
    // No detalhe, o mapa vem ANTES do script: em tela estreita a `.charts-2`
    // vira uma coluna, e com o script em cima seria preciso rolar o texto
    // inteiro para chegar ao que se clicou para ver.
    //
    // Os dois ficam em blocos ROTULADOS e separados de propósito. O mapa não
    // tem como entrar no texto da OS — o envio manda `g.script_os`, que vem do
    // pacote do servidor, e o JS nunca lê o `<pre>` da tela —, mas empilhados
    // sem rótulo eles PARECEM uma coisa só, e quem olha fica sem saber o que
    // exatamente vai para o WVSA.
    const corpo = $("#tp-candidatos").querySelector("tbody");
    corpo.innerHTML = cand.map((g, i) => `
      <tr data-i="${i}" class="tp-cand" style="cursor:pointer">
        <td><span class="badge ${BADGE[g.classificacao]}">${g.risco_rotulo}</span></td>
        <td><b>${g.cidade}</b><div style="font-size:12px;color:var(--muted)">${g.bairro || "sem bairro"}</div>${motivoHtml(g.ordem)}</td>
        <td style="white-space:nowrap">${g.data_br}<div style="font-size:12px;color:var(--muted)">${g.hora_inicio || ""}${g.hora_fim ? "–" + g.hora_fim : ""}</div></td>
        <td class="num">${g.qtd}</td>
        <td><button class="btn-ghost" data-script="${i}">Ver no mapa</button></td>
        <td>${ENVIO_LIGADO
          ? `<button class="btn" data-enviar="${i}">${reenviavel(g.ordem) ? "Tentar de novo" : ENSAIO ? "Abrir OS (ensaio)" : "Abrir OS no WVSA"}</button>`
          : `<button class="btn sec" disabled title="O envio ao WVSA está desligado no ambiente (OS_ENVIO_HABILITADO).">Envio desligado</button>`}</td>
      </tr>
      <tr data-script-de="${i}" hidden>
        <td colspan="6" style="background:var(--fundo);">
          <div class="grid charts-2" style="gap:14px;">
            <div>
              <div class="upd" style="margin-bottom:6px;">Onde é — ${g.qtd} ${g.qtd === 1 ? "trecho" : "trechos"}</div>
              <div data-mapa-de="${i}"></div>
            </div>
            <div>
              <div class="upd" style="margin-bottom:6px;">Script que vai para a OS — só este texto é enviado</div>
              <pre style="margin:0;white-space:pre-wrap;font-size:12.5px;line-height:1.5;background:#fff;border:1px solid var(--borda-2);border-radius:8px;padding:12px;">${(g.script_os || "").replace(/</g, "&lt;")}</pre>
            </div>
          </div>
        </td>
      </tr>`).join("") ||
      `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted)">Nenhum crítico no recorte atual.</td></tr>`;

    /** Abre o detalhe de UM grupo e fecha o que estava aberto.
     *
     * Acordeão, e não vários abertos: o mini-mapa é uma instância só, movida
     * para a linha aberta. Dois detalhes abertos disputariam o mesmo elemento
     * e um deles ficaria com um buraco onde o mapa estava.
     */
    function abrirDetalhe(i) {
      const alvo = corpo.querySelector(`tr[data-script-de="${i}"]`);
      const jaAberto = !alvo.hidden;
      corpo.querySelectorAll("tr[data-script-de]").forEach((tr) => { tr.hidden = true; });
      corpo.querySelectorAll("button[data-script]").forEach((b) => { b.textContent = "Ver no mapa"; });
      if (jaAberto) return;                       // clicar de novo fecha
      alvo.hidden = false;
      const botao = corpo.querySelector(`button[data-script="${i}"]`);
      if (botao) botao.textContent = "Ocultar";
      const n = mapaDoGrupo(cand[Number(i)], alvo.querySelector(`[data-mapa-de="${i}"]`));
      if (!n) avisar("Nenhum trecho deste grupo tem posição — não há o que mostrar no mapa.");
    }

    corpo.onclick = (e) => {
      const verScript = e.target.closest("button[data-script]");
      if (verScript) { abrirDetalhe(verScript.dataset.script); return; }
      // A linha inteira abre o detalhe: procurar o botão para ver onde é a
      // obra é um clique a mais em cima de um alvo pequeno.
      const linha = e.target.closest("tr.tp-cand");
      if (linha && !e.target.closest("button")) { abrirDetalhe(linha.dataset.i); return; }
      const enviar = e.target.closest("button[data-enviar]");
      // Sem ENVIO_LIGADO o botão nem é renderizado com `data-enviar`, então
      // este caminho não existe. A recusa de verdade está no servidor.
      if (!enviar) return;
      const g = cand[Number(enviar.dataset.enviar)];
      if (reenviavel(g.ordem)) { abrirReenvio(g, enviar); return; }
      montarAgenda(g);
      $("#tp-dlg-os-ok").textContent = "Abrir OS";
      const trechos = g.ids.length === 1 ? "1 trecho" : `${g.ids.length} trechos`;
      confirmarModal($("#tp-dlg-os"),
        `<b>${g.cidade} — ${g.bairro || "sem bairro"}</b><br>${g.data_br} · ${trechos}<br><br>` +
        (ENSAIO
          ? "Modo ensaio: o payload será montado e registrado, e <b>nenhuma OS</b> será criada no WVSA."
          : "Isso cria a OS de verdade e desloca equipe."),
        (campos) => abrirEEnviar(g, enviar, campos));
    };
  }

  // Os dois primeiros KPIs seguem o FILTRO, como a lista logo abaixo: com a
  // barra de filtro nesta aba (13/10/2026), "89 grupos candidatos" em cima
  // de uma lista de 8 de Penha parecia defeito — e já não batia antes, porque
  // contava todo o pacote carregado, não o período. Os de status são da
  // tabela de ordens, que não passa pelo filtro.
  let kpisStatusOs = [];
  // Os MESMOS candidatos da lista (sem OS, de hoje em diante), para o número
  // de cima fechar com o "N grupos no recorte" do cartão logo abaixo.
  let candidatosOs = [];
  function renderKpisOs() {
    const criticos = candidatosOs.filter((g) => g.classificacao === "critico");
    $("#tp-os-kpis").innerHTML = [
      `<div class="kpi"><div class="v">${fmt(candidatosOs.length)}</div><div class="l">Candidatos a OS (bairro · dia)</div></div>`,
      `<div class="kpi"><div class="v">${fmt(criticos.length)}</div><div class="l">Deles, críticos</div></div>`,
      ...kpisStatusOs,
    ].join("");
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
    kpisStatusOs = [
      `<div class="kpi"><div class="v">${fmt(conta("rascunho"))}</div><div class="l">Rascunhos</div></div>`,
      `<div class="kpi"><div class="v">${fmt(conta("ensaio"))}</div><div class="l">Ensaios</div></div>`,
      `<div class="kpi"><div class="v">${fmt(conta("criada"))}</div><div class="l">Enviadas ao WVSA</div></div>`,
    ];
    renderKpisOs();
    $("#tp-os-tabela").querySelector("tbody").innerHTML = os.map((o) => `
      <tr>
        <td><span class="badge ${o.status === "criada" ? "badge-verde" : o.status === "erro" ? "badge-vermelho" : o.status === "ensaio" ? "badge-ambar" : "badge-cinza"}">${o.status}</span></td>
        <td><b>${(o.agrupamentos && o.agrupamentos.rotulo) || "—"}</b>${motivoHtml(o)}${botaoReenvio(o)}</td>
        <td>${o.criado_em ? dataBR((o.criado_em || "").slice(0, 10)) : "—"}</td>
        <td>${o.executor || "—"}</td><td>${o.periodo || "—"}</td>
        <td>${o.agendamento || "—"}</td><td>${o.wvsa_os_numero || "—"}</td>
      </tr>`).join("") ||
      `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted)">Nenhuma OS criada ainda.</td></tr>`;
  }

  /** O grupo desta ordem, se ele está no pacote (de hoje em diante). */
  const grupoDaOrdem = (o) => GRUPOS.find((g) => g.ordem && g.ordem.ordem_id === o.id);

  /** "Tentar de novo" também na tabela de ordens — é onde se vê o `erro`.
   *
   * Só aparece se o grupo está no pacote: o modal precisa da agenda do dia e
   * dos trechos, e ordem de obra que já passou não se reenvia (o servidor
   * recusa com 400). Aí a linha mostra só o motivo.
   */
  function botaoReenvio(o) {
    if (!ENVIO_LIGADO || o.status !== "erro") return "";
    if ((o.data_inicio || "") && o.data_inicio.slice(0, 10) < HOJE) {
      return `<div style="font-size:12px;color:var(--muted);margin-top:2px;">Data já passou — não se reenvia.</div>`;
    }
    if (!grupoDaOrdem(o)) return "";
    return `<div style="margin-top:6px;"><button class="btn-ghost" data-reenviar="${escHtml(o.id)}">Tentar de novo</button></div>`;
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
    preencherCausas();
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
  // Negativo é para trás: "-30" são os 30 dias ANTERIORES a hoje, sem hoje.
  function periodoDoPreset(dias) {
    if (dias < 0) return { de: somaDias(HOJE, dias), ate: somaDias(HOJE, -1) };
    if (dias === 1) return { de: somaDias(HOJE, 1), ate: somaDias(HOJE, 1) };
    return { de: HOJE, ate: somaDias(HOJE, dias) };
  }
  function marcarPreset() {
    [...$("#tp-presets").children].forEach((x) => {
      const p = periodoDoPreset(Number(x.dataset.dias));
      x.classList.toggle("active", p.de === estado.de && p.ate === estado.ate);
    });
  }

  /** Aplica o período; recarrega quando ele sai do que o servidor mandou.
   *
   * Filtrar no cliente um pacote que só tem de hoje em diante devolvia tabela
   * vazia para qualquer data passada, sem aviso — parecia que não havia
   * histórico, e ele estava todo no banco. Dentro do que veio, segue sem
   * round-trip, como antes.
   */
  function mudouPeriodo() {
    marcarPreset();
    const cobre = estado.de && estado.de >= CARREGADO.de &&
                  (!CARREGADO.ate || (estado.ate && estado.ate <= CARREGADO.ate));
    if (cobre) { render(); return; }
    const u = new URL(location.href);
    u.searchParams.set("de", estado.de || HOJE);
    if (estado.ate) u.searchParams.set("ate", estado.ate);
    else u.searchParams.delete("ate");
    $("#tp-subnote").textContent = "Carregando o período…";
    location.assign(u);
  }

  $("#tp-presets").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-dias]");
    if (!b) return;
    Object.assign(estado, periodoDoPreset(Number(b.dataset.dias)));
    mudouPeriodo();
  });
  $("#tp-de").addEventListener("change", (e) => { estado.de = e.target.value; mudouPeriodo(); });
  $("#tp-ate").addEventListener("change", (e) => { estado.ate = e.target.value; mudouPeriodo(); });
  ligarMulti("#tp-cidade", "cidades", () => { estado.bairro = ""; });
  ligarMulti("#tp-risco", "riscos");
  ligarMulti("#tp-causa", "causas");
  $("#tp-bairro").addEventListener("change", (e) => { estado.bairro = e.target.value; render(); });

  // Um `.dropdown` aberto por vez, e clicar fora fecha: são três listas
  // lado a lado na barra, e abertas juntas uma cobriria a outra.
  const DROPS = [...document.querySelectorAll("#tp-filtros .dropdown")];
  DROPS.forEach((d) => d.addEventListener("toggle", () => {
    if (d.open) DROPS.forEach((x) => { if (x !== d) x.open = false; });
  }));
  document.addEventListener("click", (e) => {
    DROPS.forEach((d) => { if (d.open && !d.contains(e.target)) d.open = false; });
  });
  $("#tp-turno").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-turno]");
    if (!b) return;
    estado.turno = b.dataset.turno;
    [...$("#tp-turno").children].forEach((x) => x.classList.toggle("active", x === b));
    render();
  });
  $("#tp-limpar").addEventListener("click", () => {
    Object.assign(estado, { de: TP.padrao.de, ate: TP.padrao.ate, cidades: new Set(), bairro: "",
                            riscos: new Set(), causas: new Set(), turno: "", ordem: null, desc: false });
    [...$("#tp-turno").children].forEach((x) => x.classList.toggle("active", x.dataset.turno === ""));
    mudouPeriodo();
  });
  $("#tp-exportar").addEventListener("click", () => exportarCsv(aplicar()));


  $("#tp-tabela").querySelector("thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    const col = th.dataset.col;
    estado.desc = estado.ordem === col ? !estado.desc : false;
    estado.ordem = col;
    renderTabela(aplicar());
  });

  // Delegado no `tbody`: a tabela de ordens é redesenhada a cada mudança de
  // estado, e um ouvinte preso ao botão morreria com ele.
  $("#tp-os-tabela").querySelector("tbody").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-reenviar]");
    if (!b) return;
    const g = GRUPOS.find((x) => x.ordem && x.ordem.ordem_id === b.dataset.reenviar);
    if (g && reenviavel(g.ordem)) abrirReenvio(g, b);
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
    // `style.display`: `.toolbar` tem display próprio e venceria o `hidden`.
    mostrar($("#tp-filtros"), b.dataset.aba !== "revisao");
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
  montarCamposOs();
  renderOrdens();
  marcarPreset();
  render();
  abrirAba(new URL(location.href).searchParams.get("aba") || "desligamentos");
})();
