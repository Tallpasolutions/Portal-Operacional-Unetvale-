// Helpers compartilhados pelo Dashboard e pela visualização "Causa raiz" do
// /iqi. Existe como arquivo próprio porque as duas telas mostram o MESMO
// ranking de Cat 4/5 — duas cópias divergiriam no primeiro ajuste e as telas
// passariam a discordar sobre o mesmo número.
(function () {
  "use strict";

  var BR = new Intl.NumberFormat("pt-BR");
  var MOEDA = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

  function num(v) { return BR.format(Math.round(v || 0)); }
  function moeda(v) { return MOEDA.format(v || 0); }
  function pct(v, casas) {
    if (v === null || v === undefined) return "—";
    return Number(v).toFixed(casas === undefined ? 2 : casas).replace(".", ",") + "%";
  }
  function nota(v) {
    if (v === null || v === undefined) return "—";
    return Number(v).toFixed(2).replace(".", ",");
  }

  function vazio(el, msg) {
    if (!el) return;
    el.innerHTML = '<div class="vazio" style="padding:22px;font-size:13px;">' +
      (msg || "Sem dados ainda. A próxima coleta preencherá este bloco.") + "</div>";
  }

  // `dados` é {rotulo: numero} ou {rotulo: {qtd, valor}}.
  function rank(el, dados, opcoes) {
    if (!el) return;
    var o = opcoes || {};
    var linhas = Object.keys(dados || {}).map(function (k) {
      var v = dados[k];
      var qtd = (v && typeof v === "object") ? v.qtd : v;
      return { rotulo: k, qtd: qtd || 0, valor: (v && typeof v === "object") ? v.valor : null };
    }).filter(function (l) { return l.qtd > 0; });

    if (!linhas.length) { vazio(el, o.vazio); return; }

    linhas.sort(function (a, b) { return b.qtd - a.qtd; });
    if (o.limite) linhas = linhas.slice(0, o.limite);
    var max = linhas[0].qtd;
    var total = linhas.reduce(function (s, l) { return s + l.qtd; }, 0);

    el.innerHTML = linhas.map(function (l, i) {
      var largura = max ? (l.qtd / max * 100) : 0;
      // Só a primeira linha ganha destaque: é a leitura principal da lista, e
      // pintar várias tiraria o sentido do destaque.
      var cls = (i === 0 && o.destacarTopo !== false) ? " topo" : "";
      if (o.suaves && o.suaves.indexOf(l.rotulo) >= 0) cls = " suave";
      var titulo = l.rotulo + " — " + num(l.qtd) +
        (total ? " (" + (l.qtd / total * 100).toFixed(1).replace(".", ",") + "% do exibido)" : "") +
        (l.valor ? " · " + moeda(l.valor) : "");
      return '<div class="rank-linha' + cls + '" title="' + esc(titulo) + '">' +
        '<span class="rl">' + esc(l.rotulo) + "</span>" +
        '<span class="rt"><i class="rf" style="width:' + largura.toFixed(1) + '%"></i></span>' +
        '<span class="rv">' + num(l.qtd) + "</span></div>";
    }).join("");
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Blocos de mês lado a lado. Recebe a LISTA de meses visíveis (o gestor
  // escolhe quantos em Configurações), e não um par fixo: com 2 é o
  // "fechado × corrente" de sempre; com 6, meio ano na mesma moldura.
  //
  // O último é o parcial — a janela de reincidência dele ainda está aberta e
  // o número só piora até fechar. Marcar isso não é decoração: sem a etiqueta,
  // o mês corrente parece o melhor da série todo dia 3.
  function parMes(el, visiveis, fmt, opcoes) {
    if (!el) return;
    var o = opcoes || {};
    var lista = (visiveis || []).filter(Boolean);
    if (!lista.length) { vazio(el, o.vazio); return; }
    // Índice do último mês FECHADO — é o número que vale para cobrança de
    // meta, e por isso é o que ganha destaque. Assumir "o penúltimo" estava
    // errado: quando a janela de auditoria ainda não venceu, TODOS os meses
    // exibidos podem estar parciais, e o destaque apontava para um número
    // que ainda vai mudar.
    var ultimoFechado = -1;
    lista.forEach(function (d, i) {
      var parcial = d.parcial !== undefined ? d.parcial : (i === lista.length - 1);
      if (!parcial) ultimoFechado = i;
    });
    el.innerHTML = lista.map(function (d, i) {
      var ultimo = (i === lista.length - 1);
      var parcial = d.parcial !== undefined ? d.parcial : ultimo;
      var badge = parcial
        ? '<span class="badge badge-ambar">parcial</span>'
        : '<span class="badge badge-cinza">fechado</span>';
      var vm = d.vs_meta;
      var dif = "";
      if (vm) {
        dif = '<span class="d ' + (vm.dentro ? "ok" : "fora") + '">' +
          (vm.diferenca > 0 ? "+" : "−") +
          Math.abs(vm.diferenca).toFixed(2).replace(".", ",") + " " +
          (o.unidade || "p.p.") + " vs meta</span>";
      }
      var base = o.base ? '<span class="b">' + esc(o.base(d)) + "</span>" : "";
      var foco = (i === ultimoFechado) ? ' class="foco"' : "";
      return "<div" + foco + '><span class="q">' + esc(rotuloMes(d.mes)) + " " + badge +
        '</span><span class="n">' + fmt(d) + "</span>" + dif + base + "</div>";
    }).join("");
  }

  var MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
    "agosto", "setembro", "outubro", "novembro", "dezembro"];

  // Aceita "AAAA-MM" (Dashboard) e "MM/AAAA" (payloads de IQI/IQM).
  function rotuloMes(m) {
    if (!m) return "—";
    var p = String(m).indexOf("-") > 0 ? String(m).split("-") : String(m).split("/").reverse();
    var ano = p[0], mes = parseInt(p[1], 10);
    if (!mes || mes < 1 || mes > 12) return String(m);
    return MESES[mes - 1] + "/" + String(ano).slice(-2);
  }

  function preencherSelect(sel, meses, escolhido) {
    if (!sel) return;
    sel.innerHTML = (meses || []).slice().reverse().map(function (m) {
      return '<option value="' + esc(m) + '">' + esc(rotuloMes(m)) + "</option>";
    }).join("");
    if (escolhido) sel.value = escolhido;
  }

  window.Dash = {
    rank: rank, parMes: parMes, vazio: vazio, esc: esc,
    num: num, moeda: moeda, pct: pct, nota: nota,
    rotuloMes: rotuloMes, preencherSelect: preencherSelect
  };
})();
