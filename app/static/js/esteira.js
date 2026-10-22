// Módulo Esteira de Agendamento — Painel e o filtro único das duas abas.
//
// Dono do estado do filtro. Depois de cada mudança publica `esteirafiltro`
// com a lista recortada, que o roteirizador (esteira_mapa.js) escuta. A
// primeira publicação é no DOMContentLoaded, não num timer de 0 ms: o script
// do mapa carrega DEPOIS deste, e um setTimeout pode ser atendido entre os
// dois <script> — a primeira publicação cairia no vazio (CLAUDE.md §4, IQI).
//
// O dia operacional ("hoje") vem PRONTO do servidor (`D.hoje`). Calcular
// aqui seria a terceira cópia da regra das 21h, depois do banco e do Python.
(function () {
  "use strict";
  var D = window.__ESTEIRA__;
  if (!D) return;
  var Dash = window.Dash;
  var $ = function (id) { return document.getElementById(id); };
  var esc = Dash.esc;
  var num = Dash.num;
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  // --------------------------------------------------------------- dados
  var IDX = {};
  D.campos.forEach(function (c, i) { IDX[c] = i; });
  var RETIRADA = D.retirada || ["retirada"];
  function ehRetirada(fin) {
    var f = (fin || "").toLowerCase();
    return RETIRADA.some(function (p) { return f.indexOf(p) === 0; });
  }
  var OS = D.os.map(function (r) {
    var o = {};
    D.campos.forEach(function (c) { o[c] = r[IDX[c]]; });
    o.tags = (o.tags || []).map(function (i) {
      var t = D.tags[i] || ["", "", "", ""];
      return { i: t[0], c: t[1], t: t[2], n: t[3] };
    });
    var ss = o.sem_sucesso;
    o.sem_sucesso = ss ? { data_evento: ss[0], tecnico: ss[1] || "", motivo: ss[2] || "" } : null;
    o.hrs = Number(o.hrs_parada) || 0;
    o.retirada = ehRetirada(o.finalidade);
    o.fin = o.finalidade || "(sem finalidade)";
    o.cid = o.cidade || "(sem cidade)";
    o.busca = [o.os, o.cliente, o.bairro, o.endereco, o.cidade, o.finalidade, o.aberto_por]
      .join(" ").toLowerCase();
    return o;
  });

  // -------------------------------------------------------------- estado
  // Limites da reincidência: preferência de quem lê, guardada no navegador
  // (os mesmos 2 idas / 3 contatos do Esteira-OS). Tudo mais vai na URL.
  function lerLocal(k, padrao) {
    try { var v = localStorage.getItem(k); return v === null ? padrao : v; } catch (e) { return padrao; }
  }
  function gravarLocal(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* aba anônima */ } }

  var q = new URLSearchParams(location.search);
  var estado = {
    aba: q.get("aba") === "roteirizador" ? "roteirizador" : "painel",
    busca: q.get("q") || "",
    fins: new Set(q.getAll("fin")),
    cids: new Set(q.getAll("cid")),
    agend: q.get("agend") || "",
    urg: Number(q.get("urg")) || 0,
    semRet: q.get("ret") === "sem",
    reinc: q.get("reinc") === "1",
    rv: Math.max(1, Number(lerLocal("esteira.rv", 2)) || 2),
    rc: Math.max(1, Number(lerLocal("esteira.rc", 3)) || 3),
    ordem: "hrs", dir: -1,
    limite: 200,
  };

  function gravarUrl() {
    var p = new URLSearchParams();
    if (estado.aba !== "painel") p.set("aba", estado.aba);
    if (estado.busca) p.set("q", estado.busca);
    estado.fins.forEach(function (f) { p.append("fin", f); });
    estado.cids.forEach(function (c) { p.append("cid", c); });
    if (estado.agend) p.set("agend", estado.agend);
    if (estado.urg) p.set("urg", estado.urg);
    if (estado.semRet) p.set("ret", "sem");
    if (estado.reinc) p.set("reinc", "1");
    var s = p.toString();
    history.replaceState(null, "", location.pathname + (s ? "?" + s : ""));
  }

  function ehReinc(o) { return (o.visitas || 0) >= estado.rv && (o.contatos || 0) >= estado.rc; }

  // `ignorar` deixa um campo de fora: o rank de finalidade conta com todos os
  // filtros MENOS o de finalidade (cross-filter, como no Dashboard) — senão,
  // marcada uma finalidade, o rank viraria uma barra só e não haveria onde
  // clicar para comparar.
  function passa(o, ignorar) {
    if (estado.semRet && o.retirada && ignorar !== "fin") return false;
    if (ignorar !== "fin" && estado.fins.size && !estado.fins.has(o.fin)) return false;
    if (ignorar !== "cid" && estado.cids.size && !estado.cids.has(o.cid)) return false;
    if (estado.agend === "pendente" ? o.agendamento : (estado.agend && o.agendamento !== estado.agend)) return false;
    if (estado.urg && o.hrs < estado.urg) return false;
    if (estado.reinc && !ehReinc(o)) return false;
    if (estado.busca) {
      var termos = estado.busca.toLowerCase().split(/\s+/).filter(Boolean);
      for (var i = 0; i < termos.length; i++) if (o.busca.indexOf(termos[i]) < 0) return false;
    }
    return true;
  }

  // ------------------------------------------------------------- formatos
  // 0 h é OS que acabou de entrar — dado, não ausência. "—" só sem número.
  function fmtHrs(h) {
    if (h === null || h === undefined || h === "" || isNaN(h)) return "—";
    h = Number(h);
    var d = Math.floor(h / 24), r = h % 24;
    return d ? d + "d " + r + "h" : r + "h";
  }
  function dataBr(iso) {          // 'AAAA-MM-DD' (coluna date) -> 'DD/MM/AAAA'
    var v = String(iso || "").slice(0, 10);
    return v.length === 10 ? v.slice(8, 10) + "/" + v.slice(5, 7) + "/" + v.slice(0, 4) : "—";
  }
  function horaBr(iso) {          // timestamptz -> 'DD/MM HH:MM' em Brasília
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit" }).replace(",", "");
  }
  function idade(iso) {
    var min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 60) return "há " + min + " min";
    if (min < 60 * 36) return "há " + Math.round(min / 60) + " h";
    return "há " + Math.round(min / 1440) + " d";
  }
  var AGEND = {
    nao_agendada: { txt: "Não agendada", cls: "badge-vermelho", ord: 1 },
    agendada_nao_confirmada: { txt: "Não confirmada", cls: "badge-ambar", ord: 2 },
    agendada_confirmada: { txt: "Confirmada", cls: "badge-verde", ord: 3 },
  };
  function agendInfo(o) { return AGEND[o.agendamento] || { txt: "Ficha não lida", cls: "badge-cinza", ord: 4 }; }
  function linkOs(o) {
    // O link abre o WVSA, que só responde na VPN/rede da Unetvale — o title diz.
    return '<a href="https://wvsa8.unetvale.com.br/os/' + encodeURIComponent(o.os) +
      '" target="_blank" rel="noopener" data-os="' + esc(o.os) + '" title="Abrir no WVSA (só na rede da Unetvale)">' +
      esc(o.os) + "</a>";
  }

  // Tags que repetem o que já é coluna ficam fora da célula: três aparecem
  // em TODAS as OS da fila ("Não foi Fechada pelo Técnico", "Não Finalizada",
  // "Não Faturada" — 1.095 de 1.095 em 22/10/2026) e o calendário cinza/
  // laranja é o próprio status do agendamento. Sobra o que informa: técnico
  // que visitou (com o motivo), "Vistas" e contato.
  var ROTULO_ICONE = { "calendar-check-o": "visitou", phone: "contato", dollar: "$", check: "✓", "check-square-o": "✓" };
  var COR_TAG = { danger: "badge-vermelho", warning: "badge-ambar", success: "badge-verde", info: "badge-azul" };
  function tagsUteis(o) {
    return o.tags.filter(function (t) {
      if (t.c === "nfeito") return false;
      if (t.i === "calendar-check-o" && t.c !== "danger") return false;
      return true;
    });
  }
  function tagsHtml(o) {
    return tagsUteis(o).map(function (t) {
      var txt = t.n || (t.t && t.t.indexOf("Vistas") === 0 ? "vistas" : ROTULO_ICONE[t.i] || "•");
      if (t.t === "Vistas") txt = t.n + " vistas";
      return '<span class="badge ' + (COR_TAG[t.c] || "badge-cinza") + '" title="' + esc(t.t) + '">' + esc(txt) + "</span>";
    }).join(" ");
  }

  // ------------------------------------------------------ dropdowns (multi)
  // A lista só é RECRIADA quando as opções mudam; senão contagem e marcação
  // mudam no lugar. Ela fica aberta enquanto se marca, e recriar o HTML a
  // cada clique é a armadilha dos chips que roubam o clique (§6). Mesmo
  // desenho do `desenharMulti` da Troca de Poste.
  function desenharMulti(id, opcoes, marcados, vazio, total) {
    var det = $(id);
    var lista = det.querySelector(".lista-marcar");
    var assinatura = opcoes.map(function (o) { return o.valor; }).join("\u0001");
    if (lista.dataset.assinatura !== assinatura) {
      lista.dataset.assinatura = assinatura;
      lista.innerHTML = '<button type="button" class="todos-marcar" data-todos>' + vazio + "</button>" +
        opcoes.map(function (o) {
          return '<label class="linha-marcar"><input type="checkbox" value="' + esc(o.valor) + '">' +
            "<span>" + esc(o.valor) + ' <span class="n"></span></span>' +
            '<button type="button" class="so" data-so="' + esc(o.valor) + '" title="Só esta opção">só</button></label>';
        }).join("");
    }
    var porValor = {};
    opcoes.forEach(function (o) { porValor[o.valor] = o; });
    lista.querySelector("[data-todos]").textContent = vazio + " (" + num(total) + ")";
    lista.querySelectorAll(".linha-marcar").forEach(function (linha) {
      var cb = linha.querySelector("input");
      cb.checked = marcados.has(cb.value);
      linha.querySelector(".n").textContent = "(" + num((porValor[cb.value] || {}).n || 0) + ")";
    });
    var escolhidos = opcoes.filter(function (o) { return marcados.has(o.valor); });
    det.querySelector("[data-resumo]").textContent = !escolhidos.length ? vazio
      : escolhidos.length === 1 ? escolhidos[0].valor : escolhidos.length + " escolhidas";
    det.querySelector("summary").classList.toggle("on", escolhidos.length > 0);
  }
  function ligarMulti(id, conjunto) {
    var lista = $(id).querySelector(".lista-marcar");
    lista.addEventListener("change", function (e) {
      var cb = e.target.closest("input[type=checkbox]");
      if (!cb) return;
      if (cb.checked) estado[conjunto].add(cb.value); else estado[conjunto].delete(cb.value);
      mudou();
    });
    lista.addEventListener("click", function (e) {
      var so = e.target.closest("[data-so]");
      var todos = e.target.closest("[data-todos]");
      if (!so && !todos) return;
      e.preventDefault();
      estado[conjunto].clear();
      if (so) estado[conjunto].add(so.getAttribute("data-so"));
      mudou();
    });
  }
  // Abrir uma lista fecha a outra; clicar fora fecha as duas.
  document.addEventListener("click", function (e) {
    document.querySelectorAll("#es-filtros details.dropdown[open]").forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute("open");
    });
  });

  function contar(lista, campo) {
    var c = {};
    lista.forEach(function (o) { c[o[campo]] = (c[o[campo]] || 0) + 1; });
    return c;
  }
  function opcoesDe(contagem) {
    return Object.keys(contagem).sort(function (a, b) { return contagem[b] - contagem[a] || a.localeCompare(b); })
      .map(function (k) { return { valor: k, n: contagem[k] }; });
  }

  // ----------------------------------------------- recorte do fluxo e fotos
  // O fluxo e as fotos chegam AGREGADOS por dia, com quebra por finalidade
  // OU por cidade — não pelas duas ao mesmo tempo, nem por agendamento ou
  // tempo na fila (são da fila de agora, não do dia). A precedência é a de
  // quem escolheu mais específico:
  //   1. finalidade marcada (com "sem retiradas" junto, se ligado);
  //   2. senão, cidade marcada — "sem retiradas" fica de fora do gráfico;
  //   3. senão, só "sem retiradas": todas as finalidades menos retirada.
  // O que não recorta vai escrito na nota do gráfico.
  function recorteDia() {
    var semRet = function (k) { return !(estado.semRet && ehRetirada(k)); };
    if (estado.fins.size) {
      return { dim: "fin", aceita: function (k) { return estado.fins.has(k) && semRet(k); } };
    }
    if (estado.cids.size) return { dim: "cid", aceita: function (k) { return estado.cids.has(k); } };
    if (estado.semRet) return { dim: "fin", aceita: semRet };
    return null;
  }
  function somaMapa(mapa, aceita) {
    var s = 0;
    Object.keys(mapa || {}).forEach(function (k) { if (aceita(k)) s += mapa[k]; });
    return s;
  }
  function doDia(dia, tipo, rec) {
    var f = ((D.fluxo || {})[dia] || {})[tipo];
    if (!f) return null;
    return rec ? somaMapa(f[rec.dim], rec.aceita) : f.t;
  }
  function notaRecorte(rec) {
    var nao = [];
    if (rec && rec.dim === "fin" && estado.cids.size) nao.push("cidade");
    if (rec && rec.dim === "cid" && estado.semRet) nao.push("retiradas (estão incluídas)");
    if (estado.busca) nao.push("busca");
    if (estado.agend) nao.push("agendamento");
    if (estado.urg) nao.push("tempo na fila");
    if (estado.reinc) nao.push("reincidência");
    var s = rec ? (rec.dim === "fin" ? "recortado pela finalidade" : "recortado pela cidade") : "a esteira inteira";
    return s + (nao.length ? " · não recorta por " + nao.join(", ") : "");
  }

  function dias60() {
    var out = [], fim = new Date(D.hoje + "T12:00:00Z");
    for (var i = 59; i >= 0; i--) {
      out.push(new Date(fim.getTime() - i * 86400000).toISOString().slice(0, 10));
    }
    return out;
  }
  function rotDia(iso) { return iso.slice(8, 10) + "/" + iso.slice(5, 7); }

  // ---------------------------------------------------------------- KPIs
  function kpi(rotulo, valor, cor, acao, ativo) {
    return '<div class="kpi' + (acao ? " es-kpi-clicavel" : "") + (ativo ? " es-kpi-on" : "") + '"' +
      (acao ? ' data-acao="' + acao + '" role="button" tabindex="0"' : "") + '><b class="v"' +
      (cor ? ' style="color:' + cor + '"' : "") + ">" + valor + '</b><div class="l">' + esc(rotulo) + "</div></div>";
  }
  function renderKpis(lista) {
    var rec = recorteDia();
    var ent = doDia(D.hoje, "ent", rec), sai = doDia(D.hoje, "sai", rec);
    var c = { nao_agendada: 0, agendada_nao_confirmada: 0, agendada_confirmada: 0 }, pend = 0, reinc = 0, u30 = 0, u14 = 0, semGeo = 0;
    lista.forEach(function (o) {
      if (o.agendamento in c) c[o.agendamento]++; else pend++;
      if (ehReinc(o)) reinc++;
      if (o.hrs >= 720) u30++; else if (o.hrs >= 336) u14++;
      if (o.lat === null || o.lat === undefined) semGeo++;
    });
    $("es-kpis").innerHTML =
      kpi("Na fila" + (pend ? " · " + num(pend) + " com ficha não lida" : ""), num(lista.length)) +
      kpi("Entraram hoje", ent === null ? "—" : num(ent), ent ? css("--danger") : "", "ent") +
      kpi("Saíram hoje", sai === null ? "—" : num(sai), sai ? css("--success") : "", "sai") +
      kpi("Não agendadas", num(c.nao_agendada), css("--danger"), "agend:nao_agendada", estado.agend === "nao_agendada") +
      kpi("Agendadas, não confirmadas", num(c.agendada_nao_confirmada), css("--warning"), "agend:agendada_nao_confirmada", estado.agend === "agendada_nao_confirmada") +
      kpi("Agendadas e confirmadas", num(c.agendada_confirmada), css("--success"), "agend:agendada_confirmada", estado.agend === "agendada_confirmada") +
      kpi("Reincidentes (≥ " + estado.rv + " idas e ≥ " + estado.rc + " contatos)", num(reinc), reinc ? css("--danger") : "", "reinc", estado.reinc) +
      kpi("30 dias ou mais na fila", num(u30), u30 ? css("--danger") : "", "urg:720", estado.urg === 720) +
      kpi("14 a 29 dias na fila", num(u14), u14 ? css("--warning") : "", "urg:336", estado.urg === 336);
  }
  $("es-kpis").addEventListener("click", function (e) {
    var k = e.target.closest("[data-acao]");
    if (!k) return;
    var a = k.getAttribute("data-acao");
    if (a === "ent" || a === "sai") { abrirDia(D.hoje, a); return; }
    if (a === "reinc") estado.reinc = !estado.reinc;
    else if (a.indexOf("agend:") === 0) { var v = a.slice(6); estado.agend = estado.agend === v ? "" : v; }
    else if (a.indexOf("urg:") === 0) { var u = Number(a.slice(4)); estado.urg = estado.urg === u ? 0 : u; }
    sincronizarCampos();
    mudou();
  });

  // ------------------------------------------------------------- gráficos
  var graficos = {};
  function grafico(id, cfg) {
    if (graficos[id]) { graficos[id].data = cfg.data; graficos[id].options = cfg.options; graficos[id].update("none"); return; }
    graficos[id] = new Chart($(id), cfg);
  }

  function renderFluxo() {
    var rec = recorteDia();
    var dias = dias60();
    var ent = dias.map(function (d) { return doDia(d, "ent", rec); });
    var sai = dias.map(function (d) { return doDia(d, "sai", rec); });
    var lac = dias.map(function (d) {
      var f = (D.fluxo || {})[d] || {};
      var n = ((f.ent || {}).lacuna || 0) + ((f.sai || {}).lacuna || 0);
      return n || null;
    });
    var temLacuna = lac.some(function (v) { return v; });
    var ds = [
      { label: "Entraram", data: ent, backgroundColor: css("--danger"), _tipo: "ent" },
      { label: "Saíram", data: sai, backgroundColor: css("--success"), _tipo: "sai" },
    ];
    // Movimento registrado depois de mais de 12 h sem coleta: a fila mudou,
    // mas não se sabe em que dia. Fica à parte, nunca somado ao dia.
    if (temLacuna) ds.push({ label: "Após lacuna de coleta (dia incerto)", data: lac,
                             backgroundColor: css("--muted-l"), _tipo: "ent" });
    $("es-fluxo-nota").textContent = notaRecorte(rec);
    grafico("es-ch-fluxo", {
      type: "bar",
      data: { labels: dias.map(rotDia), datasets: ds },
      options: {
        interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { callbacks: {
          footer: function (it) {
            var e = it[0] && ent[it[0].dataIndex], s = it[0] && sai[it[0].dataIndex];
            return e === null && s === null ? "sem coleta neste dia" : "saldo " + ((e || 0) - (s || 0) > 0 ? "+" : "") + ((e || 0) - (s || 0));
          } } } },
        scales: { x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 15 } }, y: { beginAtZero: true } },
        onClick: function (ev, els, chart) {
          var el = chart.getElementsAtEventForMode(ev, "nearest", { intersect: true }, false)[0];
          if (!el) return;
          abrirDia(dias[el.index], chart.data.datasets[el.datasetIndex]._tipo);
        },
        onHover: function (ev, els) { ev.native.target.style.cursor = els.length ? "pointer" : "default"; },
      },
    });
  }

  function renderFila() {
    var rec = recorteDia();
    var dias = dias60();
    var abertas = [], nag = [];
    dias.forEach(function (d) {
      var f = (D.fotos || {})[d];
      if (!f) { abertas.push(null); nag.push(null); return; }
      if (!rec) { abertas.push(f.abertas); nag.push(f.nao_agendadas); return; }
      var a = rec.dim === "fin" ? f.abertas_fin : f.abertas_cid;
      var n = rec.dim === "fin" ? f.nag_fin : f.nag_cid;
      abertas.push(somaMapa(a, rec.aceita));
      nag.push(somaMapa(n, rec.aceita));
    });
    // Trecho que atravessa dias sem foto sai tracejado: a linha liga as duas
    // pontas, mas não houve coleta no meio (de 09/10 a 21/10/2026, por exemplo).
    var buraco = { borderDash: function (c) { return c.p1DataIndex - c.p0DataIndex > 1 ? [5, 5] : undefined; } };
    grafico("es-ch-fila", {
      type: "line",
      data: { labels: dias.map(rotDia), datasets: [
        // `order` menor desenha por cima: sem isso o preenchimento da fila
        // cobria a linha das não agendadas, que corre logo abaixo dela.
        { label: "Na fila", data: abertas, borderColor: css("--brand"), backgroundColor: "rgba(44,123,229,.10)",
          fill: true, spanGaps: true, tension: .25, order: 2, segment: buraco },
        { label: "Não agendadas", data: nag, borderColor: css("--danger"), backgroundColor: css("--danger"),
          spanGaps: true, tension: .25, order: 1, segment: buraco },
      ] },
      options: { interaction: { mode: "index", intersect: false },
        scales: { x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } }, y: { beginAtZero: true } } },
    });
  }

  function renderOficial() {
    var O = D.oficial || { meses: [], grupos: {}, total: {} };
    var sel = $("es-oficial-grupo");
    if (!sel.options.length) {
      sel.innerHTML = '<option value="TOTAL">Esteira inteira</option>' +
        Object.keys(O.grupos).map(function (g) { return '<option value="' + esc(g) + '">' + esc(g) + "</option>"; }).join("");
      sel.addEventListener("change", renderOficial);
    }
    var serie = sel.value === "TOTAL" ? O.total : (O.grupos[sel.value] || {});
    var meses = Object.keys(serie).sort().slice(-13);
    if (!meses.length) { Dash.vazio($("es-ch-oficial").parentNode, "O backlog oficial chega na próxima coleta (1x por hora)."); return; }
    var nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    grafico("es-ch-oficial", {
      type: "bar",
      data: { labels: meses.map(function (m) { return nomes[Number(m.slice(5, 7)) - 1] + "/" + m.slice(2, 4); }),
        datasets: [
          { label: "Entradas", data: meses.map(function (m) { return serie[m][0]; }), backgroundColor: css("--danger"), order: 2 },
          { label: "Saídas", data: meses.map(function (m) { return serie[m][1]; }), backgroundColor: css("--success"), order: 2 },
          // Saldo no eixo da direita: no mesmo eixo das barras (~8 mil por mês)
          // ele virava uma linha reta no zero.
          { label: "Saldo (entradas − saídas)", type: "line", yAxisID: "y1",
            data: meses.map(function (m) { return serie[m][0] - serie[m][1]; }),
            borderColor: css("--ink-d"), backgroundColor: css("--ink-d"), order: 1 },
        ] },
      options: { interaction: { mode: "index", intersect: false },
        scales: { y: { beginAtZero: true }, y1: { position: "right", grid: { drawOnChartArea: false } } } },
    });
  }

  // ------------------------------------------------------- ranks e matriz
  function renderRanks() {
    var semFin = OS.filter(function (o) { return passa(o, "fin"); });
    var semCid = OS.filter(function (o) { return passa(o, "cid"); });
    var cf = contar(semFin, "fin"), cc = contar(semCid, "cid");
    var umFin = estado.fins.size === 1 ? Array.from(estado.fins)[0] : null;
    var umCid = estado.cids.size === 1 ? Array.from(estado.cids)[0] : null;
    Dash.rank($("es-rank-fin"), cf, { aoClicar: function (r) { alternar("fins", r); }, selecionado: umFin,
      suaves: Object.keys(cf).filter(ehRetirada), vazio: "Nenhuma OS no filtro." });
    Dash.rank($("es-rank-cid"), cc, { aoClicar: function (r) { alternar("cids", r); }, selecionado: umCid,
      vazio: "Nenhuma OS no filtro." });
    desenharMulti("es-fin", opcoesDe(cf), estado.fins, "Todas", semFin.length);
    desenharMulti("es-cid", opcoesDe(cc), estado.cids, "Todas", semCid.length);
  }
  function alternar(conjunto, valor) {
    var s = estado[conjunto];
    if (s.size === 1 && s.has(valor)) s.clear(); else { s.clear(); s.add(valor); }
    mudou();
  }

  function renderMatriz(lista) {
    var cf = contar(lista, "fin");
    var fins = Object.keys(cf).sort(function (a, b) { return cf[b] - cf[a]; });
    var cols = fins.slice(0, 6), resto = fins.length > 6;
    var porCid = {};
    lista.forEach(function (o) {
      var l = porCid[o.cid] || (porCid[o.cid] = { t: 0 });
      var k = cols.indexOf(o.fin) >= 0 ? o.fin : "_outras";
      l[k] = (l[k] || 0) + 1; l.t++;
    });
    var cids = Object.keys(porCid).sort(function (a, b) { return porCid[b].t - porCid[a].t; });
    if (!cids.length) { $("es-matriz").innerHTML = '<tbody><tr><td class="vazio-cel">Nenhuma OS no filtro.</td></tr></tbody>'; return; }
    var cab = '<thead><tr><th class="sticky-col">Cidade</th>' + cols.map(function (f) { return "<th>" + esc(f) + "</th>"; }).join("") +
      (resto ? "<th>Outras</th>" : "") + "<th>Total</th></tr></thead>";
    var corpo = cids.map(function (c) {
      var l = porCid[c];
      var cel = function (v) { return v ? "<td>" + num(v) + "</td>" : '<td class="vazio-cel">·</td>'; };
      return '<tr><td class="sticky-col nome">' + esc(c) + "</td>" + cols.map(function (f) { return cel(l[f]); }).join("") +
        (resto ? cel(l._outras) : "") + "<td><b>" + num(l.t) + "</b></td></tr>";
    }).join("");
    $("es-matriz").innerHTML = cab + "<tbody>" + corpo + "</tbody>";
  }

  // --------------------------------------------------------------- tabela
  var VISTAS = new Set((lerLocal("esteira.vistas", "") || "").split(",").filter(Boolean));
  // Ordem de leitura: quem é, se está agendada e há quanto tempo espera
  // ficam nas primeiras colunas — numa tela de 1.024px o resto rola de lado.
  var COLS = [
    ["os", "OS"], ["cliente", "Cliente"], ["agend", "Agendamento"], ["hrs", "Na fila"], ["fin", "Finalidade"],
    ["cid", "Cidade · bairro"], ["entrou", "Entrou na fila"], ["reinc", "Idas · contatos"], ["tags", "Tags"],
  ];
  function chave(o, c) {
    switch (c) {
      case "os": return o.os;
      case "entrou": return o.entrou_fila || "";
      case "hrs": return o.hrs;
      case "agend": return agendInfo(o).ord;
      case "reinc": return (o.visitas || 0) * 100 + (o.contatos || 0);
      case "cliente": return (o.cliente || "").toLowerCase();
      default: return String(o[c] || "").toLowerCase();
    }
  }
  function renderTabela(lista) {
    var ord = lista.slice().sort(function (a, b) {
      var x = chave(a, estado.ordem), y = chave(b, estado.ordem);
      return (x < y ? -1 : x > y ? 1 : 0) * estado.dir;
    });
    $("es-contagem").textContent = "· " + num(lista.length) + " de " + num(OS.length);
    var cab = "<thead><tr>" + COLS.map(function (c) {
      var seta = c[0] === estado.ordem ? (estado.dir < 0 ? " ▼" : " ▲") : "";
      return c[0] === "tags" ? "<th>Tags</th>" : '<th data-ordem="' + c[0] + '" style="cursor:pointer;white-space:nowrap">' + c[1] + seta + "</th>";
    }).join("") + "</tr></thead>";
    var corpo = ord.slice(0, estado.limite).map(function (o) {
      var a = agendInfo(o);
      var ss = o.sem_sucesso;
      var urg = o.hrs >= 720 ? ' style="color:var(--danger);font-weight:700"' : o.hrs >= 336 ? ' style="color:var(--warning);font-weight:700"' : "";
      return "<tr" + (VISTAS.has(String(o.os)) ? ' class="es-vista"' : "") + ">" +
        '<td class="cod">' + linkOs(o) + '<div class="subnote" style="margin:0">' + esc(o.aberto_por || "") + "</div></td>" +
        "<td>" + esc(o.cliente || "") + "</td>" +
        '<td><span class="badge ' + a.cls + '">' + a.txt + "</span>" +
          (o.agendado_para ? ' <span class="subnote" style="margin:0">' + dataBr(o.agendado_para) + "</span>" : "") +
          (ss ? '<div class="subnote" style="margin:2px 0 0;color:var(--danger)" title="' +
            esc("Fechada sem sucesso pelo técnico " + (ss.tecnico || "?") + (ss.motivo ? " — " + ss.motivo : "")) + '">fechada s/ sucesso ' +
            horaBr(ss.data_evento).slice(0, 5) + (ss.motivo ? " · " + esc(ss.motivo) : "") + "</div>" : "") + "</td>" +
        '<td style="white-space:nowrap"' + urg + ">" + fmtHrs(o.hrs_parada) + "</td>" +
        "<td>" + esc(o.finalidade || "") + "</td>" +
        "<td>" + esc(o.cidade || "") + (o.bairro ? '<div class="subnote" style="margin:0">' + esc(o.bairro) + "</div>" : "") + "</td>" +
        '<td style="white-space:nowrap">' + horaBr(o.entrou_fila) + "</td>" +
        '<td style="white-space:nowrap' + (ehReinc(o) ? ";color:var(--danger);font-weight:700" : "") + '">' +
          (o.visitas || 0) + " · " + (o.contatos || 0) + "</td>" +
        "<td>" + tagsHtml(o) + "</td></tr>";
    }).join("");
    $("es-tabela").innerHTML = cab + "<tbody>" + (corpo || '<tr><td colspan="9" class="vazio-cel">Nenhuma OS no filtro.</td></tr>') + "</tbody>";
    var falta = ord.length - estado.limite;
    $("es-mais").style.display = falta > 0 ? "" : "none";
    $("es-mais").textContent = "Mostrar mais " + num(Math.min(falta, 200)) + " (faltam " + num(falta) + ")";
  }
  $("es-tabela").addEventListener("click", function (e) {
    var th = e.target.closest("th[data-ordem]");
    if (th) {
      var c = th.getAttribute("data-ordem");
      if (estado.ordem === c) estado.dir *= -1; else { estado.ordem = c; estado.dir = c === "hrs" || c === "reinc" ? -1 : 1; }
      renderTabela(atual);
      return;
    }
    var a = e.target.closest("a[data-os]");
    if (a) {
      // Marca a OS como "já aberta" neste navegador — a pessoa trabalha a
      // fila de cima para baixo e precisa ver onde parou.
      VISTAS.add(a.getAttribute("data-os"));
      gravarLocal("esteira.vistas", Array.from(VISTAS).slice(-2000).join(","));
      a.closest("tr").classList.add("es-vista");
    }
  });
  $("es-mais").addEventListener("click", function () { estado.limite += 200; renderTabela(atual); });

  $("es-csv").addEventListener("click", function () {
    var cab = ["OS", "Aberto por", "Cliente", "Finalidade", "Cidade", "Bairro", "Endereço", "Entrou na fila",
               "Horas na fila", "Agendamento", "Agendado para", "Idas ao local", "Contatos", "Última fechada s/ sucesso"];
    var q = function (v) { v = v === null || v === undefined ? "" : String(v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var linhas = atual.map(function (o) {
      return [o.os, o.aberto_por, o.cliente, o.finalidade, o.cidade, o.bairro, o.endereco, horaBr(o.entrou_fila),
        o.hrs, agendInfo(o).txt, o.agendado_para ? dataBr(o.agendado_para) : "", o.visitas, o.contatos,
        o.sem_sucesso ? horaBr(o.sem_sucesso.data_evento) + " " + o.sem_sucesso.tecnico +
          (o.sem_sucesso.motivo ? " — " + o.sem_sucesso.motivo : "") : ""].map(q).join(";");
    });
    // BOM para o Excel abrir com acento; ";" porque o Excel em pt-BR separa por ponto e vírgula.
    var blob = new Blob(["﻿" + cab.join(";") + "\n" + linhas.join("\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "esteira_" + D.hoje + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
  });

  // ------------------------------------------------------- modal do dia
  var dlg = $("es-dlg");
  dlg.addEventListener("click", function (e) {
    if (e.target === dlg || e.target.closest("[data-fechar]")) dlg.close();
  });
  function abrirDia(dia, tipo) {
    $("es-dlg-titulo").textContent = (tipo === "ent" ? "Entraram na fila" : "Saíram da fila") + " — " + dataBr(dia);
    $("es-dlg-nota").textContent = "Carregando…";
    $("es-dlg-tab").innerHTML = "";
    dlg.showModal();
    fetch("/esteira/movimentos?dia=" + encodeURIComponent(dia) + "&tipo=" + tipo, { headers: { Accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        var l = j.os || [];
        var lac = l.filter(function (m) { return m.apos_lacuna; }).length;
        var leg = l.filter(function (m) { return m.origem === "legado"; }).length;
        $("es-dlg-nota").textContent = num(l.length) + " OS" +
          (lac ? " · " + num(lac) + " registradas após uma lacuna de coleta (o dia exato é incerto)" : "") +
          (leg ? " · histórico do Esteira-OS (hora = quando o coletor antigo viu)" : "") +
          (tipo === "sai" ? " · saiu da fila não quer dizer resolvida" : "");
        // O selo "na fila / fora" vai sob o número da OS, e não numa coluna:
        // com seis colunas a tabela passava da largura do modal.
        $("es-dlg-tab").innerHTML = l.length ? "<thead><tr><th>OS</th><th>Cliente</th><th>Finalidade</th><th>Cidade</th><th>Hora</th></tr></thead><tbody>" +
          l.map(function (m) {
            return '<tr><td class="cod">' + linkOs(m) + "<div>" +
              (m.ativa ? '<span class="badge badge-ambar">na fila agora</span>' : '<span class="badge badge-cinza">fora da fila</span>') +
              "</div></td><td>" + esc(m.cliente || "") + "</td><td>" + esc(m.finalidade || "") +
              "</td><td>" + esc(m.cidade || "") + "</td><td>" + horaBr(m.em).slice(6) + (m.apos_lacuna ? " *" : "") + "</td></tr>";
          }).join("") + "</tbody>" : '<tbody><tr><td class="vazio-cel">Nenhuma OS neste dia.</td></tr></tbody>';
      })
      .catch(function (e) { $("es-dlg-nota").textContent = "Não foi possível carregar (" + e.message + ")."; });
  }

  // ---------------------------------------------------------------- coleta
  function renderColeta() {
    var c = D.coleta || {};
    var partes = [];
    if (c.ok_em) partes.push("Fila lida às " + horaBr(c.ok_em).slice(6) + " de " + horaBr(c.ok_em).slice(0, 5) + " (" + idade(c.ok_em) + ")");
    if (c.status_em) partes.push("fichas às " + horaBr(c.status_em).slice(6));
    if (c.backlog_em) partes.push("backlog oficial às " + horaBr(c.backlog_em).slice(6));
    var s = partes.join(" · ") + ". O coletor roda de 10 em 10 minutos, das 6h às 22h.";
    if (c.erro_em && (!c.ok_em || new Date(c.erro_em) > new Date(c.ok_em))) {
      s += " ⚠ A última tentativa, às " + horaBr(c.erro_em).slice(6) + ", falhou: " + c.erro;
    }
    $("es-coleta").textContent = s;
  }

  // ------------------------------------------------------- campos e abas
  function sincronizarCampos() {
    $("es-busca").value = estado.busca;
    $("es-agend").value = estado.agend;
    $("es-urg").value = estado.urg ? String(estado.urg) : "";
    $("es-reinc").checked = estado.reinc;
    $("es-rv").value = estado.rv;
    $("es-rc").value = estado.rc;
    document.querySelectorAll("#es-retirada button").forEach(function (b) {
      b.classList.toggle("active", (b.getAttribute("data-ret") === "sem") === estado.semRet);
    });
  }
  var tBusca;
  $("es-busca").addEventListener("input", function () {
    clearTimeout(tBusca);
    tBusca = setTimeout(function () { estado.busca = $("es-busca").value.trim(); mudou(); }, 200);
  });
  $("es-agend").addEventListener("change", function () { estado.agend = this.value; mudou(); });
  $("es-urg").addEventListener("change", function () { estado.urg = Number(this.value) || 0; mudou(); });
  $("es-reinc").addEventListener("change", function () { estado.reinc = this.checked; mudou(); });
  ["es-rv", "es-rc"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      estado.rv = Math.max(1, Number($("es-rv").value) || 2);
      estado.rc = Math.max(1, Number($("es-rc").value) || 3);
      gravarLocal("esteira.rv", estado.rv); gravarLocal("esteira.rc", estado.rc);
      sincronizarCampos(); mudou();
    });
  });
  $("es-retirada").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-ret]");
    if (!b) return;
    estado.semRet = b.getAttribute("data-ret") === "sem";
    sincronizarCampos(); mudou();
  });
  $("es-limpar").addEventListener("click", function () {
    estado.busca = ""; estado.fins.clear(); estado.cids.clear(); estado.agend = ""; estado.urg = 0;
    estado.semRet = false; estado.reinc = false;
    sincronizarCampos(); mudou();
  });
  ligarMulti("es-fin", "fins");
  ligarMulti("es-cid", "cids");

  function mostrarAba() {
    document.querySelectorAll("#es-abas button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-aba") === estado.aba);
    });
    document.querySelectorAll("section[data-painel]").forEach(function (s) {
      s.hidden = s.getAttribute("data-painel") !== estado.aba;
    });
    document.dispatchEvent(new CustomEvent("esteiraaba", { detail: { aba: estado.aba } }));
  }
  $("es-abas").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-aba]");
    if (!b) return;
    estado.aba = b.getAttribute("data-aba");
    mostrarAba(); gravarUrl();
  });

  // ---------------------------------------------------------------- render
  var atual = [];
  function mudou() { estado.limite = 200; render(); gravarUrl(); }
  function render() {
    atual = OS.filter(function (o) { return passa(o); });
    renderKpis(atual);
    renderRanks();
    renderFluxo();
    renderFila();
    renderMatriz(atual);
    renderTabela(atual);
    document.dispatchEvent(new CustomEvent("esteirafiltro", { detail: { lista: atual } }));
  }

  // API para o roteirizador: as mesmas funções de formato, uma definição só.
  window.Esteira = { fmtHrs: fmtHrs, agendInfo: agendInfo, linkOs: linkOs, esc: esc, dataBr: dataBr,
    horaBr: horaBr, ehReinc: ehReinc, atual: function () { return atual; }, aba: function () { return estado.aba; } };

  sincronizarCampos();
  renderColeta();
  renderOficial();
  document.addEventListener("DOMContentLoaded", function () { mostrarAba(); render(); });
})();
