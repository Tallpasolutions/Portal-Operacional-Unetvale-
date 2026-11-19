// War Room de Operações: números do dia, rotina dos supervisores e desvios.
//
// Tudo sai de window.__WR__ (montado por app/war_room.py). O DIA muda os
// números e recarrega a página — eles vêm do servidor. O resto (período,
// status, busca, cross-filter dos rankings) filtra os desvios aqui, sem ir
// ao servidor. As gravações voltam JSON e a tela se redesenha no lugar.
(function () {
  "use strict";

  var D = window.__WR__;
  var EU = window.__WR_EU__;
  var ADMIN = !!window.__WR_ADMIN__;
  if (!D) return;
  var esc = Dash.esc, num = Dash.num;
  var $ = function (id) { return document.getElementById(id); };
  var CAT = D.catalogo;

  function porId(lista) { var m = {}; lista.forEach(function (x) { m[x.id] = x; }); return m; }
  var MOM = porId(CAT.momentos), TIPO = porId(CAT.tipos), CAUSA = porId(CAT.causas),
      RESP = porId(CAT.responsaveis);
  // Chave que saiu do catálogo continua aparecendo — crua, mas aparece.
  function rot(mapa, id) { return (mapa[id] && mapa[id].rotulo) || id || "—"; }

  var SEMANA = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];
  function diaSemana(iso) { return (new Date(iso + "T12:00:00").getDay() + 6) % 7; }   // 0 = segunda
  function rotDia(iso) { return iso.slice(8, 10) + "/" + iso.slice(5, 7); }
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  // ---------------------------------------------------------------------
  // Fontes
  // ---------------------------------------------------------------------
  $("wr-fontes").innerHTML =
    "Sem retirada e sem infra. Produtividade atualizada em <b>" + esc(D.produtividade.atualizado || "—") +
    "</b> (de 2 em 2 h); esteira em <b>" + esc(D.esteira.atualizado || "—") + "</b> (de 10 em 10 min)." +
    " Régua: média do mesmo dia da semana de " + rotDia(D.base_de) + " a " + rotDia(D.base_ate) + ".";

  // ---------------------------------------------------------------------
  // Números do dia
  // ---------------------------------------------------------------------
  function delta(atual, ref, maiorMelhor) {
    if (ref === undefined || ref === null) return "";
    var d = atual - ref;
    var cls = maiorMelhor === null ? "" : ((maiorMelhor ? d >= 0 : d <= 0) ? " ok" : " fora");
    var sinal = d > 0 ? "+" : (d < 0 ? "−" : "±");
    return '<span class="d' + cls + '">' + sinal + num(Math.abs(d)) + "</span>";
  }

  function numeros() {
    var dia = D.dia, w = diaSemana(dia), emAndamento = dia === D.hoje;
    var p = D.produtividade.por_dia[dia] || [0, 0];
    var bp = D.produtividade.base[w];
    var ent = D.esteira.entradas[dia] || 0;
    var be = D.esteira.base[w];
    var bk = D.esteira.backlog[dia];
    // O backlog compara com a véspera da War Room: é a fila que ela herdou.
    var vesp = new Date(D.inicio + "T12:00:00"); vesp.setDate(vesp.getDate() - 1);
    var vespIso = vesp.toISOString().slice(0, 10);
    var bkIni = D.esteira.backlog[vespIso];
    // Com o dia em andamento não há diferença a mostrar: às 14h, "−77" contra
    // a média do dia INTEIRO assusta e não diz nada sobre o ritmo. O backlog
    // continua comparando — ele é uma foto, não um acumulado do dia.
    var andamento = emAndamento ? " · dia em andamento" : "";
    var cel = [
      { q: "Executadas com sucesso", n: p[0],
        d: bp && !emAndamento ? delta(p[0], bp[0], true) : "",
        b: bp ? "média de " + SEMANA[w] + ": " + num(bp[0]) + andamento : "sem régua" + andamento },
      { q: "Encerradas sem sucesso", n: p[1],
        d: bp && !emAndamento ? delta(p[1], bp[1], false) : "",
        b: bp ? "média de " + SEMANA[w] + ": " + num(bp[1]) + andamento : "" },
      { q: "Entraram na esteira", n: ent, d: be && !emAndamento ? delta(ent, be, null) : "",
        b: (be ? "média de " + SEMANA[w] + ": " + num(be) : "sem régua") +
           " · dia das 21h às 21h" + (D.esteira.lacuna[dia] ? " · +" + D.esteira.lacuna[dia] + " após lacuna de coleta" : "") },
      { q: "Backlog da esteira", n: bk ? bk[0] : null,
        d: bk && bkIni && dia >= D.inicio ? delta(bk[0], bkIni[0], false) : "",
        b: bk ? num(bk[1]) + " não agendadas" + (bkIni && dia >= D.inicio ? " · em " + rotDia(vespIso) + ": " + num(bkIni[0]) : "")
              : "sem foto da esteira neste dia" },
    ];
    $("wr-numeros").innerHTML = cel.map(function (c, i) {
      return '<div class="' + (i === 0 ? "foco" : "") + '"><span class="q">' + c.q + "</span>" +
        '<span class="n">' + (c.n === null ? "—" : num(c.n)) + " " + (c.d || "") + "</span>" +
        '<span class="b">' + c.b + "</span></div>";
    }).join("");
  }

  // ---------------------------------------------------------------------
  // Gráficos e a tabela dia a dia
  // ---------------------------------------------------------------------
  function diasGrafico() {
    var set = {};
    Object.keys(D.produtividade.por_dia).forEach(function (d) { set[d] = 1; });
    Object.keys(D.esteira.entradas).forEach(function (d) { set[d] = 1; });
    Object.keys(D.esteira.backlog).forEach(function (d) { set[d] = 1; });
    return Object.keys(set).filter(function (d) { return d <= D.hoje; }).sort();
  }

  function graficos() {
    var dias = diasGrafico();
    var verde = css("--success"), azul = css("--brand");
    // Antes do início da War Room as barras ficam esmaecidas: o "antes" é
    // contexto, o "depois" é o que se acompanha.
    function cor(c) { return dias.map(function (d) { return d < D.inicio ? c + "59" : c; }); }
    var suc = dias.map(function (d) { return (D.produtividade.por_dia[d] || [null])[0]; });
    var ent = dias.map(function (d) { return D.esteira.entradas[d] === undefined ? null : D.esteira.entradas[d]; });
    var rotulos = dias.map(function (d) { return rotDia(d) + (d === D.inicio ? " ★" : ""); });
    new Chart($("wr-ch-fluxo"), {
      type: "bar",
      data: { labels: rotulos, datasets: [
        { label: "Executadas com sucesso", data: suc, backgroundColor: cor(verde) },
        { label: "Entraram na esteira", data: ent, backgroundColor: cor(azul) },
      ] },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true } },
        plugins: { tooltip: { callbacks: { title: function (it) {
          var d = dias[it[0].dataIndex];
          return rotDia(d) + " (" + SEMANA[diaSemana(d)] + ")" + (d < D.inicio ? " — antes da War Room" : "");
        } } } },
      },
    });
    $("wr-fluxo-nota").innerHTML = "★ " + rotDia(D.inicio) + ", início da War Room; as barras anteriores ficam mais claras. " +
      "Executadas por dia civil (Produtividade); entradas por dia operacional, das 21h às 21h (esteira).";

    var bdias = Object.keys(D.esteira.backlog).sort();
    new Chart($("wr-ch-backlog"), {
      type: "line",
      data: { labels: bdias.map(function (d) { return rotDia(d) + (d === D.inicio ? " ★" : ""); }), datasets: [
        { label: "Na fila", data: bdias.map(function (d) { return D.esteira.backlog[d][0]; }),
          borderColor: azul, backgroundColor: azul + "22", fill: true, tension: 0.25 },
        { label: "Não agendadas", data: bdias.map(function (d) { return D.esteira.backlog[d][1]; }),
          borderColor: css("--ink"), backgroundColor: "transparent", borderDash: [5, 4], tension: 0.25 },
      ] },
      options: { interaction: { mode: "index", intersect: false },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true } } },
    });

    var linhas = dias.slice().reverse().map(function (d) {
      var p = D.produtividade.por_dia[d], bk = D.esteira.backlog[d];
      return "<tr" + (d < D.inicio ? ' class="wr-antes"' : "") + "><td>" + rotDia(d) + " · " + SEMANA[diaSemana(d)].slice(0, 3) +
        "</td><td class='num'>" + (p ? num(p[0]) : "—") + "</td><td class='num'>" + (p ? num(p[1]) : "—") +
        "</td><td class='num'>" + (D.esteira.entradas[d] === undefined ? "—" : num(D.esteira.entradas[d])) +
        "</td><td class='num'>" + (bk ? num(bk[0]) : "—") + "</td><td class='num'>" + (bk ? num(bk[1]) : "—") + "</td></tr>";
    }).join("");
    $("wr-tab-dias").innerHTML = "<thead><tr><th>Dia</th><th>Executadas com sucesso</th><th>Encerradas sem sucesso</th>" +
      "<th>Entraram na esteira</th><th>Backlog</th><th>Não agendadas</th></tr></thead><tbody>" + linhas + "</tbody>";
  }

  // Cartão recolhido (§5): o corpo só abre no clique.
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-alternar]");
    if (!b) return;
    var card = $(b.getAttribute("data-alternar"));
    var corpo = card.querySelector(".card-b");
    var abrir = corpo.hidden;
    corpo.hidden = !abrir;
    card.classList.toggle("recolhido", !abrir);
    b.textContent = abrir ? "Esconder" : "Mostrar";
  });

  // ---------------------------------------------------------------------
  // Fetch com JSON (o mesmo contrato do painel de Ações)
  // ---------------------------------------------------------------------
  async function postJSON(url, corpo) {
    var r;
    try {
      r = await fetch(url, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(corpo || {}),
      });
    } catch (e) {
      throw new Error("Sem conexão. Nada foi salvo.");
    }
    var dados = null;
    try { dados = await r.json(); } catch (e) { /* sessão expirada devolve HTML */ }
    if (!r.ok || !dados || dados.erro) {
      throw new Error((dados && dados.erro) ||
        (r.status === 404 ? "Desvio não encontrado." :
         !dados ? "Sua sessão expirou. Recarregue a página." : "Não foi possível salvar. Tente de novo."));
    }
    return dados;
  }

  // ---------------------------------------------------------------------
  // Rotina do dia
  // ---------------------------------------------------------------------
  function rotina() {
    var porMom = {};
    D.rodadas.forEach(function (r) { (porMom[r.momento] = porMom[r.momento] || []).push(r); });
    var desviosDia = {};
    D.desvios.forEach(function (d) {
      if (d.dia === D.dia && !d.anulado) desviosDia[d.momento] = (desviosDia[d.momento] || 0) + 1;
    });
    var podeMarcar = D.tem_tabela;
    $("wr-rotina").innerHTML = CAT.momentos.filter(function (m) { return m.rodada; }).map(function (m) {
      var quem = porMom[m.id] || [];
      var minha = quem.some(function (r) { return r.usuario_id === EU; });
      var nDes = desviosDia[m.id] || 0;
      return '<div class="wr-passo' + (quem.length ? " feito" : "") + '">' +
        '<div class="wr-passo-t"><b>' + esc(m.rotulo) + "</b><span>" + esc(m.quando) + "</span></div>" +
        '<div class="wr-passo-q">' + (quem.length
          ? quem.map(function (r) { return esc(r.nome.split(" ")[0]) + " " + esc(r.hora || ""); }).join(" · ")
          : "ninguém marcou ainda") + "</div>" +
        '<div class="wr-passo-r">' +
          (nDes ? '<span class="badge badge-ambar">' + nDes + " desvio" + (nDes > 1 ? "s" : "") + "</span>"
                : '<span class="badge badge-cinza">sem desvio</span>') +
          (podeMarcar ? '<button type="button" class="btn-ghost' + (minha ? " wr-minha" : "") + '" data-rodada="' + m.id + '">' +
            (minha ? "✓ Conferi" : "Marcar conferido") + "</button>" : "") +
        "</div></div>";
    }).join("");
  }

  $("wr-rotina").addEventListener("click", async function (e) {
    var b = e.target.closest("[data-rodada]");
    if (!b || b.disabled) return;
    var feito = !b.classList.contains("wr-minha");
    b.disabled = true;
    try {
      var r = await postJSON("/war-room/rodadas", { dia: D.dia, momento: b.getAttribute("data-rodada"), feito: feito });
      D.rodadas = r.rodadas;
      rotina();
    } catch (err) {
      b.disabled = false;
      alertar(err.message);
    }
  });

  // Aviso curto no rodapé, sem `alert()` do navegador (§5).
  function alertar(msg) {
    var el = $("wr-aviso");
    if (!el) {
      el = document.createElement("div");
      el.id = "wr-aviso"; el.className = "wr-aviso"; el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove("on"); }, 4500);
  }

  // ---------------------------------------------------------------------
  // Desvios: filtro, rankings e lista
  // ---------------------------------------------------------------------
  var F = { periodo: "dia", status: "", busca: "", tipo: null, causa: null, resp: null, tec: null };

  function noPeriodo(d) { return F.periodo === "tudo" || d.dia === D.dia; }
  function passa(d, exceto) {
    if (!noPeriodo(d)) return false;
    if (F.status === "anulado") { if (!d.anulado) return false; }
    else if (d.anulado) return false;
    else if (F.status && d.status !== F.status) return false;
    if (F.busca) {
      var alvo = [d.tecnico, d.empresa, (d.os || []).join(" "), d.solucao, d.detalhe, d.responsavel_nome, d.por,
                  rot(TIPO, d.tipo), rot(CAUSA, d.causa)].join(" ").toLowerCase();
      if (alvo.indexOf(F.busca) < 0) return false;
    }
    // Cross-filter: cada ranking recorta os outros, nunca a si mesmo.
    if (exceto !== "tipo" && F.tipo && rot(TIPO, d.tipo) !== F.tipo) return false;
    if (exceto !== "causa" && F.causa && rot(CAUSA, d.causa) !== F.causa) return false;
    if (exceto !== "resp" && F.resp && rot(RESP, d.responsavel) !== F.resp) return false;
    if (exceto !== "tec" && F.tec && (d.tecnico || "(sem técnico)") !== F.tec) return false;
    return true;
  }

  function contar(campo, fn) {
    var c = {};
    D.desvios.forEach(function (d) { if (passa(d, campo)) { var k = fn(d); c[k] = (c[k] || 0) + 1; } });
    return c;
  }

  function rankings() {
    var vazio = F.periodo === "dia" ? "Nenhum desvio registrado em " + rotDia(D.dia) + "." : "Nenhum desvio registrado.";
    [["tipo", "wr-rank-tipo", function (d) { return rot(TIPO, d.tipo); }],
     ["causa", "wr-rank-causa", function (d) { return rot(CAUSA, d.causa); }],
     ["resp", "wr-rank-resp", function (d) { return rot(RESP, d.responsavel); }],
     ["tec", "wr-rank-tec", function (d) { return d.tecnico || "(sem técnico)"; }]].forEach(function (r) {
      Dash.rank($(r[1]), contar(r[0], r[2]), {
        limite: 10, vazio: vazio, selecionado: F[r[0]],
        aoClicar: function (rotulo) { F[r[0]] = F[r[0]] === rotulo ? null : rotulo; desvios(); },
      });
    });
  }

  function kpis(lista) {
    var pend = lista.filter(function (d) { return d.status === "pendente" && !d.anulado; }).length;
    var tecs = {};
    lista.forEach(function (d) { if (d.tecnico) tecs[d.tecnico] = 1; });
    $("wr-kpis").innerHTML = [
      [lista.length, F.status === "anulado" ? "anulados" : "desvios"],
      [pend, "pendentes"],
      [Object.keys(tecs).length, "técnicos envolvidos"],
      [lista.filter(function (d) { return d.tipo === "encerr_sem_validacao"; }).length, "encerraram sem validar"],
    ].map(function (k) { return '<div class="kpi"><div class="v">' + num(k[0]) + '</div><div class="l">' + k[1] + "</div></div>"; }).join("");
  }

  function tabela(lista) {
    var tudo = F.periodo === "tudo";
    $("wr-contagem").textContent = "· " + num(lista.length) + (tudo ? " desde " + rotDia(D.inicio) : " em " + rotDia(D.dia));
    if (!lista.length) {
      $("wr-tabela").innerHTML = '<tbody><tr><td class="vazio-celula">' +
        (D.desvios.length ? "Nenhum desvio neste filtro." : "Nenhum desvio registrado ainda. Use “+ Registrar desvio”.") +
        "</td></tr></tbody>";
      return;
    }
    $("wr-tabela").innerHTML = "<thead><tr>" + (tudo ? "<th>Dia</th>" : "") +
      "<th>Hora</th><th>Momento</th><th>O que aconteceu</th><th>Técnico</th><th>OS</th><th>Causa</th>" +
      "<th>Responsável</th><th>Solução</th><th>Situação</th><th>Registrou</th></tr></thead><tbody>" +
      lista.map(function (d) {
        var sit = d.anulado ? '<span class="badge badge-cinza" title="' + esc((d.anulado_motivo || "") + " — " + (d.anulado_por || "")) + '">anulado</span>'
          : d.status === "pendente" ? '<span class="badge badge-ambar">pendente</span>'
          : '<span class="badge badge-verde" title="' + esc(d.resolvido ? "em " + d.resolvido + (d.resolvido_por ? " por " + d.resolvido_por : "") : "") + '">resolvido</span>';
        return '<tr data-id="' + d.id + '" class="' + (d.anulado ? "wr-anulado" : "clicavel") + '" title="' + (d.anulado ? "" : "Clique para atualizar") + '">' +
          (tudo ? "<td>" + rotDia(d.dia) + "</td>" : "") +
          "<td>" + esc(d.hora || "") + "</td>" +
          "<td>" + esc(rot(MOM, d.momento)) + "</td>" +
          "<td>" + esc(rot(TIPO, d.tipo)) + (d.horario ? " <b>(" + esc(d.horario) + ")</b>" : "") + "</td>" +
          "<td>" + esc(d.tecnico || "—") + (d.empresa ? ' <span class="subnote wr-emp">' + esc(d.empresa) + "</span>" : "") + "</td>" +
          "<td>" + (d.os || []).map(function (o) { return "#" + esc(o); }).join(" ") + "</td>" +
          "<td>" + esc(rot(CAUSA, d.causa)) + (d.detalhe ? '<div class="subnote wr-det">' + esc(d.detalhe) + "</div>" : "") + "</td>" +
          "<td>" + esc(rot(RESP, d.responsavel)) + (d.responsavel_nome ? '<div class="subnote wr-det">' + esc(d.responsavel_nome) + "</div>" : "") + "</td>" +
          '<td class="wr-sol">' + esc(d.solucao || "") + "</td>" +
          "<td>" + sit + "</td>" +
          "<td>" + esc((d.por || "—").split(" ")[0]) + "</td></tr>";
      }).join("") + "</tbody>";
  }

  function filtrados() { return D.desvios.filter(function (d) { return passa(d); }); }

  function desvios() {
    if (!D.tem_tabela) { rotina(); return; }
    var lista = filtrados();
    rankings();
    kpis(lista);
    tabela(lista);
    rotina();
  }

  // Filtros
  $("wr-dia").addEventListener("change", function () {
    var v = this.value;
    if (!v) return;
    location.search = v === D.hoje ? "" : "?dia=" + v;
  });
  $("wr-hoje").addEventListener("click", function () { location.search = ""; });
  $("wr-periodo").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-p]");
    if (!b) return;
    F.periodo = b.getAttribute("data-p");
    this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x === b); });
    desvios();
  });
  $("wr-status").addEventListener("change", function () { F.status = this.value; desvios(); });
  $("wr-busca").addEventListener("input", function () { F.busca = this.value.trim().toLowerCase(); desvios(); });
  $("wr-limpar").addEventListener("click", function () {
    F.status = ""; F.busca = ""; F.tipo = F.causa = F.resp = F.tec = null;
    $("wr-status").value = ""; $("wr-busca").value = "";
    desvios();
  });

  // CSV do que está na tela
  var csvBtn = $("wr-csv");
  if (csvBtn) csvBtn.addEventListener("click", function () {
    var cab = ["Dia", "Hora", "Momento", "O que aconteceu", "Horário", "Técnico", "Empresa", "OS", "Causa", "Detalhe",
               "Responsável", "Nome do responsável", "Solução", "Situação", "Registrou", "Motivo da anulação"];
    var linhas = filtrados().map(function (d) {
      return [d.dia, d.hora, rot(MOM, d.momento), rot(TIPO, d.tipo), d.horario, d.tecnico, d.empresa,
              (d.os || []).join(" "), rot(CAUSA, d.causa), d.detalhe, rot(RESP, d.responsavel), d.responsavel_nome,
              d.solucao, d.anulado ? "anulado" : d.status, d.por, d.anulado_motivo];
    });
    var txt = [cab].concat(linhas).map(function (l) {
      return l.map(function (v) { return '"' + String(v === null || v === undefined ? "" : v).replace(/"/g, '""') + '"'; }).join(";");
    }).join("\r\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + txt], { type: "text/csv;charset=utf-8" }));
    a.download = "war-room-desvios-" + (F.periodo === "tudo" ? "desde-" + D.inicio : D.dia) + ".csv";
    a.click();
  });

  // ---------------------------------------------------------------------
  // Encerradas sem sucesso no dia (Produtividade)
  // ---------------------------------------------------------------------
  function semSucesso() {
    var porTec = {};
    D.produtividade.sem_sucesso.forEach(function (o) {
      var k = o.tecnico || "—";
      var t = porTec[k] = porTec[k] || { empresa: o.empresa, n: 0, motivos: {} };
      t.n++;
      t.motivos[o.motivo] = (t.motivos[o.motivo] || 0) + 1;
    });
    var nomes = Object.keys(porTec).sort(function (a, b) { return porTec[b].n - porTec[a].n || a.localeCompare(b); });
    $("wr-ss-contagem").textContent = "· " + num(D.produtividade.sem_sucesso.length) + " em " + rotDia(D.dia);
    if (!nomes.length) {
      $("wr-ss").innerHTML = '<tbody><tr><td class="vazio-celula">Nenhuma OS de cliente encerrada sem sucesso em ' +
        rotDia(D.dia) + " até a última coleta da Produtividade.</td></tr></tbody>";
      return;
    }
    $("wr-ss").innerHTML = "<thead><tr><th>Técnico</th><th>Empresa</th><th>OS</th><th>Motivo registrado no fechamento</th></tr></thead><tbody>" +
      nomes.map(function (t) {
        var m = porTec[t].motivos;
        return "<tr><td>" + esc(t) + "</td><td>" + esc(porTec[t].empresa || "") + "</td><td class='num'>" + porTec[t].n + "</td><td>" +
          Object.keys(m).sort(function (a, b) { return m[b] - m[a]; })
            .map(function (k) { return esc(k) + (m[k] > 1 ? " (" + m[k] + ")" : ""); }).join(" · ") + "</td></tr>";
      }).join("") + "</tbody>";
  }

  // ---------------------------------------------------------------------
  // Registrar
  // ---------------------------------------------------------------------
  var dlg = $("wr-dlg"), form = $("wr-form");
  var tecEmpresa = {};
  D.produtividade.tecnicos.forEach(function (t) { tecEmpresa[t[0]] = t[1]; });
  $("wr-tecnicos").innerHTML = D.produtividade.tecnicos.map(function (t) {
    return '<option value="' + esc(t[0]) + '">' + esc(t[1]) + "</option>";
  }).join("");

  function opcoes(sel, lista, vazio) {
    sel.innerHTML = (vazio ? '<option value="">' + vazio + "</option>" : "") +
      lista.map(function (x) { return '<option value="' + x.id + '">' + esc(x.rotulo) + "</option>"; }).join("");
  }
  opcoes($("wr-f-momento"), CAT.momentos, "Escolha…");
  opcoes($("wr-f-causa"), CAT.causas, "Escolha…");
  opcoes($("wr-f-resp"), CAT.responsaveis, "Escolha…");

  // Os tipos do momento primeiro; os demais continuam ao alcance — um
  // desvio de rota pode aparecer no check das 12h.
  function tiposDoMomento() {
    var m = $("wr-f-momento").value, sel = $("wr-f-tipo"), atual = sel.value;
    var deste = CAT.tipos.filter(function (t) { return m && t.momentos.indexOf(m) >= 0; });
    var outros = CAT.tipos.filter(function (t) { return deste.indexOf(t) < 0; });
    function grupo(rotulo, lista) {
      if (!lista.length) return "";
      return '<optgroup label="' + rotulo + '">' + lista.map(function (t) {
        return '<option value="' + t.id + '">' + esc(t.rotulo) + "</option>"; }).join("") + "</optgroup>";
    }
    sel.innerHTML = '<option value="">Escolha…</option>' +
      (m ? grupo("Deste momento", deste) + grupo("Outros tipos", outros) : grupo("Tipos", CAT.tipos));
    if (atual) sel.value = atual;
    camposCondicionais();
  }

  function camposCondicionais() {
    var t = TIPO[$("wr-f-tipo").value];
    $("wr-f-horario-campo").hidden = !(t && t.pede_horario);
    var c = CAUSA[$("wr-f-causa").value];
    $("wr-f-detalhe-opc").textContent = c && c.pede_detalhe ? "(obrigatório com “Outra causa”)" : "(opcional)";
    var emp = tecEmpresa[$("wr-f-tecnico").value.trim()];
    $("wr-f-empresa").textContent = emp ? emp : ($("wr-f-tecnico").value.trim() ? "fora da lista da Produtividade — empresa em branco" : "");
  }
  $("wr-f-momento").addEventListener("change", tiposDoMomento);
  $("wr-f-tipo").addEventListener("change", camposCondicionais);
  $("wr-f-causa").addEventListener("change", camposCondicionais);
  $("wr-f-tecnico").addEventListener("input", camposCondicionais);

  function toggleStatus(id, valor) {
    $(id).querySelectorAll("button").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-s") === valor); });
  }
  function statusDe(id) { var b = $(id).querySelector("button.active"); return b ? b.getAttribute("data-s") : "resolvido"; }
  ["wr-f-status", "wr-e-status"].forEach(function (id) {
    $(id).addEventListener("click", function (e) {
      var b = e.target.closest("button[data-s]");
      if (b) toggleStatus(id, b.getAttribute("data-s"));
    });
  });

  function erro(id, msg) { var el = $(id); el.textContent = msg || ""; el.hidden = !msg; }

  function abrirRegistro(manterMomento) {
    var mom = manterMomento ? $("wr-f-momento").value : "";
    form.reset();
    $("wr-f-momento").value = mom;
    toggleStatus("wr-f-status", "resolvido");
    tiposDoMomento();
    erro("wr-form-erro");
    $("wr-form-dia").textContent = "Desvio de " + rotDia(D.dia) + (D.dia === D.hoje ? " (hoje)" : "") + ".";
    if (!dlg.open) dlg.showModal();
    (mom ? $("wr-f-tipo") : $("wr-f-momento")).focus();
  }
  var novo = $("wr-novo");
  if (novo) novo.addEventListener("click", function () { abrirRegistro(false); });

  document.querySelectorAll("dialog [data-fechar]").forEach(function (b) {
    b.addEventListener("click", function () { b.closest("dialog").close(); });
  });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    var outro = e.submitter && e.submitter.value === "novo";
    var tec = $("wr-f-tecnico").value.trim();
    var corpo = {
      dia: D.dia, momento: $("wr-f-momento").value, tipo: $("wr-f-tipo").value,
      horario: $("wr-f-horario").value, tecnico: tec, empresa: tecEmpresa[tec] || "",
      os: $("wr-f-os").value, causa: $("wr-f-causa").value, detalhe: $("wr-f-detalhe").value,
      responsavel: $("wr-f-resp").value, responsavel_nome: $("wr-f-resp-nome").value,
      solucao: $("wr-f-solucao").value, status: statusDe("wr-f-status"),
    };
    var botoes = form.querySelectorAll("button[type=submit]");
    botoes.forEach(function (b) { b.disabled = true; });
    try {
      var r = await postJSON("/war-room/desvios", corpo);
      D.desvios.unshift(r.desvio);
      desvios();
      alertar("Desvio registrado.");
      if (outro) abrirRegistro(true); else dlg.close();
    } catch (err) {
      erro("wr-form-erro", err.message);
    } finally {
      botoes.forEach(function (b) { b.disabled = false; });
    }
  });

  // ---------------------------------------------------------------------
  // Atualizar e anular
  // ---------------------------------------------------------------------
  var emEdicao = null;
  function substituir(novoD) {
    for (var i = 0; i < D.desvios.length; i++) if (D.desvios[i].id === novoD.id) D.desvios[i] = novoD;
    desvios();
  }

  var tab = $("wr-tabela");
  if (tab) tab.addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    var d = D.desvios.filter(function (x) { return x.id === tr.getAttribute("data-id"); })[0];
    if (!d || d.anulado) return;
    emEdicao = d;
    $("wr-edit-resumo").textContent = rot(TIPO, d.tipo) + (d.tecnico ? " · " + d.tecnico : "") +
      " · registrado por " + d.por + " às " + d.hora + " de " + rotDia(d.dia) + ".";
    $("wr-e-solucao").value = d.solucao || "";
    toggleStatus("wr-e-status", d.status);
    // Anular é de quem registrou; o botão some para os outros em vez de
    // oferecer um clique que o servidor vai recusar.
    $("wr-dlg-edit").querySelector("[data-anular]").hidden = !(ADMIN || d.registrado_por === EU);
    erro("wr-edit-erro");
    $("wr-dlg-edit").showModal();
  });

  $("wr-form-edit").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!emEdicao) return;
    var corpo = {};
    var sol = $("wr-e-solucao").value.trim(), st = statusDe("wr-e-status");
    if (sol !== (emEdicao.solucao || "")) corpo.solucao = sol;
    if (st !== emEdicao.status) corpo.status = st;
    if (!Object.keys(corpo).length) { $("wr-dlg-edit").close(); return; }
    try {
      var r = await postJSON("/war-room/desvios/" + emEdicao.id, corpo);
      substituir(r.desvio);
      $("wr-dlg-edit").close();
      alertar("Desvio atualizado.");
    } catch (err) { erro("wr-edit-erro", err.message); }
  });

  $("wr-dlg-edit").querySelector("[data-anular]").addEventListener("click", function () {
    $("wr-dlg-edit").close();
    $("wr-a-motivo").value = "";
    erro("wr-anular-erro");
    $("wr-dlg-anular").showModal();
    $("wr-a-motivo").focus();
  });

  $("wr-form-anular").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!emEdicao) return;
    try {
      var r = await postJSON("/war-room/desvios/" + emEdicao.id + "/anular", { motivo: $("wr-a-motivo").value });
      substituir(r.desvio);
      $("wr-dlg-anular").close();
      alertar("Desvio anulado.");
    } catch (err) { erro("wr-anular-erro", err.message); }
  });

  // ---------------------------------------------------------------------
  numeros();
  graficos();
  semSucesso();
  desvios();
})();
