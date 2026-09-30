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
  //
  // Com `o.aoClicar`, cada linha vira filtro (cross-filter): clicar chama
  // `aoClicar(rotulo)`, e `o.selecionado` marca a linha escolhida. O ouvinte é
  // UM, delegado no contêiner, e não um por linha: a lista é redesenhada a
  // cada filtro, e ouvinte preso à linha morreria junto com ela — o clique
  // seguinte cairia num nó já removido (a armadilha dos chips, CLAUDE.md §6).
  function rank(el, dados, opcoes) {
    if (!el) return;
    var o = opcoes || {};
    el._aoClicar = o.aoClicar || null;
    if (o.aoClicar && !el._delegado) {
      el._delegado = true;
      el.addEventListener("click", function (e) {
        var linha = e.target.closest(".rank-linha[data-rotulo]");
        if (linha && el._aoClicar) el._aoClicar(linha.getAttribute("data-rotulo"));
      });
    }
    var linhas = Object.keys(dados || {}).map(function (k) {
      var v = dados[k];
      var qtd = (v && typeof v === "object") ? v.qtd : v;
      return { rotulo: k, qtd: qtd || 0, valor: (v && typeof v === "object") ? v.valor : null };
    }).filter(function (l) { return l.qtd > 0; });

    if (!linhas.length) { vazio(el, o.vazio); return; }

    linhas.sort(function (a, b) { return b.qtd - a.qtd; });
    if (o.limite) {
      // A linha selecionada nunca sai por causa do corte: sumir com o filtro
      // ativo da tela deixaria a pessoa sem ter onde clicar para desfazer.
      var sel = linhas.filter(function (l) { return l.rotulo === o.selecionado; })[0];
      linhas = linhas.slice(0, o.limite);
      if (sel && linhas.indexOf(sel) < 0) linhas.push(sel);
    }
    var max = linhas[0].qtd;
    var total = linhas.reduce(function (s, l) { return s + l.qtd; }, 0);

    el.innerHTML = linhas.map(function (l, i) {
      var largura = max ? (l.qtd / max * 100) : 0;
      // Só a primeira linha ganha destaque: é a leitura principal da lista, e
      // pintar várias tiraria o sentido do destaque.
      var cls = (i === 0 && o.destacarTopo !== false) ? " topo" : "";
      if (o.suaves && o.suaves.indexOf(l.rotulo) >= 0) cls = " suave";
      if (o.aoClicar) cls += " clicavel";
      if (o.selecionado !== undefined && o.selecionado !== null) {
        cls += l.rotulo === o.selecionado ? " selecionado" : " apagado";
      }
      // `base` troca o denominador do % do title. A Cat 6 é múltipla: a soma
      // das linhas passa do total de protocolos, e "% do exibido" mentiria.
      var den = o.base || total;
      var titulo = l.rotulo + " — " + num(l.qtd) +
        (den ? " (" + (l.qtd / den * 100).toFixed(1).replace(".", ",") + "% " +
          (o.base ? "dos protocolos" : "do exibido") + ")" : "") +
        (l.valor ? " · " + moeda(l.valor) : "") +
        (o.aoClicar ? (l.rotulo === o.selecionado ? " · clique para desfazer" : " · clique para filtrar") : "");
      return '<div class="rank-linha' + cls + '" data-rotulo="' + esc(l.rotulo) + '" title="' + esc(titulo) + '">' +
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

  // ------------------------------------------------------------------
  // Categorias (AII): contagem a partir dos registros compactos.
  //
  // Uma função só para o Dashboard e para o /iqi. As duas telas mostram a
  // MESMA causa raiz; duas contagens divergiriam no primeiro ajuste.
  //
  // `CR` é o que `gerencial.causa_raiz()` / `_registros_categorias` mandam:
  // `campos` (ordem das posições), `multiplos` (campos que são LISTA de
  // índices — hoje só a Cat 6), as listas de texto e {IQI|IQM: {mes: [reg]}}.
  //
  // Opções:
  //   tecnicos  Set de índices de técnico que passam (null = todos)
  //   sel       {campo: rotulo} — o cross-filter
  //   campos    quais campos contar
  //
  // CROSS-FILTER: ao contar um campo, aplica-se a seleção de TODOS OS OUTROS,
  // não a dele. É o que deixa o cartão clicado inteiro (com a linha marcada)
  // e recorta os demais. Filtrar o próprio campo reduziria o cartão a uma
  // linha só, sem ter onde clicar para trocar de causa.
  //
  // O filtro é sobre REGISTROS, não sobre uma árvore Cat 4 → Cat 5: medido em
  // 08/2026, "Trocado Conector ONU" aparece sob Conector E sob Equipamento.
  // Uma árvore fixa esconderia um dos dois.
  var LISTA_DE = { tecnico: "tec", cat1: "c1", cat2: "c2", cat3: "c3",
                   cat4: "c4", cat5: "c5", cidade: "cid", cat6: "c6" };

  function contarCategorias(CR, ind, meses, opcoes) {
    var o = opcoes || {};
    var campos = CR.campos || ["tecnico", "cat1", "cat2", "cat3", "cat4", "cat5", "cidade"];
    var multiplos = CR.multiplos || ["cat6"];
    var pos = {};
    campos.forEach(function (c, i) { pos[c] = i; });
    var lista = function (c) { return CR[LISTA_DE[c]] || []; };
    var alvo = o.campos || ["cat1", "cat2", "cat4", "cat5", "cat6", "cidade"];

    // Seleção como ÍNDICE, uma vez só — comparar texto por registro seria
    // milhares de comparações de string a cada clique.
    var selIdx = {};
    Object.keys(o.sel || {}).forEach(function (c) {
      if (o.sel[c] === null || o.sel[c] === undefined || pos[c] === undefined) return;
      selIdx[c] = lista(c).indexOf(o.sel[c]);
    });

    function tem(reg, campo, idx) {
      var v = reg[pos[campo]];
      if (multiplos.indexOf(campo) >= 0) return Array.isArray(v) && v.indexOf(idx) >= 0;
      return v === idx;
    }
    function passa(reg, exceto) {
      for (var c in selIdx) {
        if (c !== exceto && !tem(reg, c, selIdx[c])) return false;
      }
      return true;
    }

    var saida = { total: 0, porMes: {}, tecnicos: 0, contas: {}, mensal: {}, coletados: {} };
    var tecs = new Set();
    alvo.forEach(function (c) { saida.contas[c] = {}; saida.mensal[c] = {}; saida.coletados[c] = 0; });
    var blocos = CR[ind] || {};
    (meses || []).forEach(function (m) {
      saida.porMes[m] = 0;
      (blocos[m] || []).forEach(function (reg) {
        if (o.tecnicos && !o.tecnicos.has(reg[pos.tecnico])) return;
        if (passa(reg, null)) {
          saida.total++;
          saida.porMes[m]++;
          if (reg[pos.tecnico] >= 0) tecs.add(reg[pos.tecnico]);
        }
        alvo.forEach(function (c) {
          var i = pos[c];
          if (i === undefined || i >= reg.length) return;   // registro anterior ao campo
          if (!passa(reg, c)) return;
          saida.coletados[c]++;
          var vals = multiplos.indexOf(c) >= 0 ? (reg[i] || []) : [reg[i]];
          var L = lista(c);
          vals.forEach(function (v) {
            if (typeof v !== "number" || v < 0 || v >= L.length) return;
            var nome = L[v];
            saida.contas[c][nome] = (saida.contas[c][nome] || 0) + 1;
            var mm = saida.mensal[c][nome] = saida.mensal[c][nome] || {};
            mm[m] = (mm[m] || 0) + 1;
          });
        });
      });
    });
    saida.tecnicos = tecs.size;
    return saida;
  }

  // Índices de técnico (na lista `tec` do CR) que passam num predicado de nome.
  function tecnicosQuePassam(CR, passaNome) {
    if (!passaNome) return null;
    var s = new Set();
    (CR.tec || []).forEach(function (nome, i) { if (nome && passaNome(nome)) s.add(i); });
    return s;
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
    rotuloMes: rotuloMes, preencherSelect: preencherSelect,
    contarCategorias: contarCategorias, tecnicosQuePassam: tecnicosQuePassam
  };
})();
