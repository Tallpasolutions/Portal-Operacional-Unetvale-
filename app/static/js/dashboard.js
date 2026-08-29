// Tela do Dashboard: uma página, cinco blocos. Só renderização — todo número
// já veio calculado do servidor (app/gerencial.py), inclusive o "vs meta" e o
// entrou/saiu da esteira. O JS não recalcula indicador.
(function () {
  "use strict";
  var D = window.__DASH__ || {};
  var Dash = window.Dash;
  var $ = function (id) { return document.getElementById(id); };

  function kpi(l, v, cor) {
    return '<div class="kpi"><b class="v"' + (cor ? ' style="color:' + cor + '"' : "") +
      ">" + v + '</b><div class="l">' + Dash.esc(l) + "</div></div>";
  }
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  // ------------------------------------------------------------ qualidade
  ["IQI", "IQM"].forEach(function (ind) {
    var q = (D.qualidade || {})[ind] || {};
    var pref = ind.toLowerCase();
    var rot = $(pref + "-meta");
    if (rot) {
      rot.textContent = (q.meta === null || q.meta === undefined)
        ? "meta não definida" : "meta ≤ " + Dash.pct(q.meta, 2);
    }
    Dash.parMes($(pref + "-par"), q.visiveis, function (d) { return Dash.pct(d.pct); },
      { base: function (d) { return Dash.num(d.chamados) + " de " + Dash.num(d.os) + " OSs"; },
        vazio: "Sem dados de " + ind + " ainda." });
    serie(ind, q);
  });

  function serie(ind, q) {
    var cv = $("g-" + ind.toLowerCase() + "-serie");
    if (!cv || !window.Chart || !(q.serie || []).length) return;
    var pontos = q.serie.filter(function (p) { return p.pct !== null; });
    if (!pontos.length) return;
    var ds = [{
      label: ind + " %", data: pontos.map(function (p) { return p.pct; }),
      borderColor: css("--brand"), backgroundColor: css("--brand") + "22",
      fill: true, tension: .3
    }];
    if (q.meta !== null && q.meta !== undefined) {
      ds.push({
        label: "Meta", data: pontos.map(function () { return Number(q.meta); }),
        borderColor: css("--danger"), borderDash: [5, 4], borderWidth: 1.5,
        pointRadius: 0, fill: false
      });
    }
    new Chart(cv, {
      type: "line",
      data: { labels: pontos.map(function (p) { return Dash.rotuloMes(p.mes); }), datasets: ds },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: function (v) { return v + "%"; } } } }
      }
    });
  }

  // ----------------------------------------------------------- causa raiz
  var cr = D.causa_raiz || {};
  var crInd = "IQI";
  Dash.preencherSelect($("cr-mes"), cr.visiveis || []);
  function causaRaiz() {
    Array.prototype.forEach.call($("cr-ind").children, function (b) {
      b.classList.toggle("active", b.dataset.ind === crInd);
    });
    var d = ((cr[crInd] || {})[$("cr-mes").value]) || {};
    $("cr-total").textContent = Dash.num(d.total || 0);
    Dash.rank($("cr-cat4"), d.cat4 || {}, { limite: 10 });
    Dash.rank($("cr-cat5"), d.cat5 || {}, { limite: 12 });
    Dash.rank($("cr-cat1"), d.cat1 || {}, { limite: 8, destacarTopo: false });
    Dash.rank($("cr-cat2"), d.cat2 || {}, { limite: 8, destacarTopo: false });
    Dash.rank($("cr-cidades"), d.cidade || {}, { limite: 10, destacarTopo: false });
  }
  $("cr-ind").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-ind]");
    if (b) { crInd = b.dataset.ind; causaRaiz(); }
  });
  $("cr-mes").addEventListener("change", causaRaiz);
  causaRaiz();

  // -------------------------------------------------------- cancelamentos
  var c = D.cancelamentos || {};
  Dash.parMes($("cmt-par"), c.visiveis, function (d) { return Dash.pct(d.pct); },
    { base: function (d) { return Dash.num(d.tecnico) + " de " + Dash.num(d.total) + " cancelamentos"; },
      vazio: "Sem dados de cancelamento ainda." });

  Dash.preencherSelect($("ca-mes"), (c.visiveis || []).map(function (d) { return d.mes; }));
  function cancelamentos() {
    var mes = $("ca-mes").value;
    var d = (c.visiveis || []).filter(function (x) { return x.mes === mes; })[0];
    if (!d) {
      ["ca-grupos", "ca-cidades", "ca-casa", "ca-ticket", "cmt-motivos"].forEach(function (id) { Dash.vazio($(id)); });
      return;
    }
    $("ca-total").textContent = Dash.num(d.total);
    $("ca-tec").textContent = Dash.num(d.tecnico) + " (" + Dash.pct(d.pct) + ")";
    $("ca-valor").textContent = Dash.moeda(d.valor);
    $("ca-quando").textContent = Dash.rotuloMes(d.mes);
    Dash.rank($("cmt-motivos"), d.motivos_tecnicos, { limite: 6, vazio: "Sem motivos técnicos no mês." });
    Dash.rank($("ca-grupos"), d.grupos, { limite: 10 });
    Dash.rank($("ca-cidades"), d.cidades, { limite: 10, destacarTopo: false });
    Dash.rank($("ca-casa"), d.tempo_casa, { limite: 10, destacarTopo: false });
    Dash.rank($("ca-ticket"), d.faixa_ticket, { limite: 10, destacarTopo: false });
  }
  $("ca-mes").addEventListener("change", cancelamentos);
  cancelamentos();

  // -------------------------------------------------------------- esteira
  (function () {
    var e = D.esteira || {};
    if (!e.total) {
      ["es-kpis", "es-mov", "es-fin", "es-cid"].forEach(function (id) {
        Dash.vazio($(id), "Sem coleta da esteira ainda.");
      });
      return;
    }
    $("es-kpis").innerHTML =
      kpi("Esteira útil (sem retiradas)", Dash.num(e.util)) +
      kpi("Fila de retirada", Dash.num(e.retiradas), css("--warning")) +
      kpi("Total na fila", Dash.num(e.total)) +
      kpi("Coletado às", hora(e.atualizado_em));

    var m = e.movimento;
    if (!m) {
      Dash.vazio($("es-mov"), "O movimento aparece a partir da segunda coleta do dia.");
    } else if (!m.tem_comparacao) {
      Dash.vazio($("es-mov"), "Só a foto da abertura (" + m.abertura_em +
        ") até agora. A próxima coleta mostra o que entrou e o que saiu.");
    } else {
      // Sinal só quando há movimento: "+0" e "−0" existem em aritmética, não
      // em português — e a leitura da tela é "nada entrou".
      var sinal = function (n, s) { return (n ? s : "") + Dash.num(n); };
      $("es-mov").innerHTML =
        kpi("Entraram na fila", sinal(m.entraram, "+"), m.entraram ? css("--danger") : "") +
        kpi("Saíram da fila", sinal(m.sairam, "−"), m.sairam ? css("--success") : "") +
        kpi("Saldo do dia", (m.saldo > 0 ? "+" : m.saldo < 0 ? "−" : "") + Dash.num(Math.abs(m.saldo))) +
        kpi("Na abertura", Dash.num(m.abertura_total));
      $("es-mov-quando").textContent = "abertura " + m.abertura_em + " → " + m.atual_em +
        " · " + m.capturas + " coleta(s)";
    }
    // Retirada aparece na lista, mas sem o destaque de "maior ofensor": ela é
    // sempre a maior e não é trabalho que a operação escolha fazer.
    Dash.rank($("es-fin"), e.por_finalidade || {}, { limite: 12, suaves: ["Retirada", "Retirada Condomínio"] });
    Dash.rank($("es-cid"), e.cidades || {}, { limite: 12, destacarTopo: false });
  })();

  function hora(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return "—"; }
  }

  // ------------------------------------------------------------------ IDF
  var CANAIS = [["ligacoes", "Ligações"], ["chats", "Chats"], ["os", "OS"]];
  (function () {
    var i = D.idf || {};
    var atual = (i.visiveis || [])[(i.visiveis || []).length - 1];
    if (!atual) {
      Dash.vazio($("idf-kpis"), "Sem IDF ainda — depende da credencial do gestor no coletor.");
      Dash.vazio($("idf-reguas"));
      return;
    }
    $("idf-kpis").innerHTML = CANAIS.map(function (p) {
      var d = atual[p[0]] || {};
      return kpi(p[1] + " · " + Dash.num(d.n) + " avaliações", Dash.nota(d.nota));
    }).join("");
    $("idf-mes").textContent = Dash.rotuloMes(atual.mes);
    $("idf-reguas").innerHTML = CANAIS.map(function (p) {
      var d = atual[p[0]] || {}, ok = Number(d.pct_resolvido) || 0, nao = Math.max(0, 100 - ok);
      return '<div class="regua"><span class="rc">' + p[1] + "</span>" +
        '<span class="rr"><span class="rs ok" style="width:' + ok.toFixed(1) + '%"></span>' +
        '<span class="rs no" style="width:' + nao.toFixed(1) + '%"></span>' +
        "<b>" + Dash.pct(ok, 1) + "</b></span>" +
        '<span class="rd">' + Dash.num(Math.round(d.n * nao / 100)) + " não resolvidos</span></div>";
    }).join("");
  })();

  // ---------------------------------------------------------------- salas
  (function () {
    var s = D.salas || {};
    if (!s.total) {
      Dash.vazio($("salas-kpis"), "Sem coleta de salas ainda — depende da credencial do gestor.");
      Dash.vazio($("salas-tipos"));
      return;
    }
    $("salas-kpis").innerHTML = kpi("Em aberto", Dash.num(s.abertas)) +
      kpi("Solicitações no período", Dash.num(s.total));
    Dash.rank($("salas-tipos"), s.por_tipo || {}, { limite: 6, destacarTopo: false });
  })();
})();
