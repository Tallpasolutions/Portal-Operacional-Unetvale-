// IQI/IQM — bloco "Causa raiz": Categoria 4 e Categoria 5 mês a mês.
//
// Fica DENTRO da visualização Tabela mensal, abaixo dela, e usa OS MESMOS
// chips: supervisor, empresa e período chegam pelo evento `iqifiltrotabela`.
// Ter dois conjuntos de filtros na mesma tela deixaria alguém ler a causa raiz
// de uma equipe ao lado da tabela de outra.
//
// Lê `window.__CAUSA_RAIZ__`, que vem de `gerencial.causa_raiz()`: registros
// COMPACTOS, um por reincidência, com o técnico dentro. É preciso ser assim —
// contagem já agregada no servidor não se recorta por empresa nem por
// supervisor depois, e é justamente esse cruzamento que esta tela existe para
// fazer.
//
// Categorias 1 e 2 não entram aqui de propósito: elas dizem como o cliente
// pediu e como o N1 encerrou, não a causa. Ficam no Dashboard.
(function () {
  "use strict";
  var CR = window.__CAUSA_RAIZ__ || {};
  var Dash = window.Dash;
  var Sup = window.__iqiSupervisor;
  var raiz = document.getElementById("view-causaraiz");
  if (!raiz || !Dash) return;

  var campos = CR.campos || ["tecnico", "cat1", "cat2", "cat3", "cat4", "cat5", "cidade"];
  var pos = {};
  campos.forEach(function (c, i) { pos[c] = i; });
  var TEC = CR.tec || [], C4 = CR.c4 || [], C5 = CR.c5 || [];

  var ind = "IQI";
  var alcanceSup = null;
  var empresasSel = new Set();
  // Meses a exibir e quais deles já fecharam — ambos vêm da Tabela mensal.
  var mesesVisiveis = null;
  var fechados = new Set();

  var MESES_NOME = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

  function meses() { return CR.meses || []; }
  function mesesExibidos() {
    if (!mesesVisiveis) return meses();
    // Interseção: o período vem do IQI/IQM, que pode ter mês sem categoria
    // coletada (e vice-versa).
    return meses().filter(function (m) { return mesesVisiveis.indexOf(m) >= 0; });
  }

  // Parcial pela MESMA regra da Tabela mensal: o mês só fecha 30 dias depois
  // de terminar, que é a janela de auditoria da reincidência. Marcar apenas o
  // último mês faria julho aparecer fechado no dia 29 de agosto — quando ele
  // ainda pode piorar.
  function ehParcial(m) { return !fechados.has(m); }
  function rotuloMes(m) {
    var mm = parseInt(String(m).split("-")[1], 10);
    return (MESES_NOME[mm - 1] || m) + (ehParcial(m) ? " (Parcial)" : "");
  }

  // ------------------------------------------------------------- recorte
  // Índices de técnico que passam no filtro. Calculado uma vez por mudança de
  // filtro, não por registro: são milhares de registros contra ~100 técnicos.
  function tecnicosPermitidos() {
    var permitidos = new Set();
    TEC.forEach(function (nome, i) {
      if (!nome) return;
      if (alcanceSup && !Sup.filtrar([nome], alcanceSup).length) return;
      if (empresasSel.size && !empresasSel.has(Sup.empresaDe(nome))) return;
      permitidos.add(i);
    });
    return permitidos;
  }

  function empresasDisponiveis() {
    var set = new Set();
    TEC.forEach(function (nome) {
      if (!nome) return;
      if (alcanceSup && !Sup.filtrar([nome], alcanceSup).length) return;
      var e = Sup.empresaDe(nome);
      if (e) set.add(e);
    });
    return [...set].sort();
  }

  /** {categoria: {mes: n}} + totais, para um dos campos (cat4 | cat5). */
  function contar(campo, permitidos) {
    var blocos = CR[ind] || {};
    var iTec = pos.tecnico, iCat = pos[campo];
    var lista = campo === "cat4" ? C4 : C5;
    var linhas = {}, porMes = {}, total = 0, tecnicosVistos = new Set();
    mesesExibidos().forEach(function (m) {
      porMes[m] = 0;
      (blocos[m] || []).forEach(function (r) {
        if (permitidos && !permitidos.has(r[iTec])) return;
        total++; porMes[m]++;
        if (r[iTec] >= 0) tecnicosVistos.add(r[iTec]);
        var c = r[iCat];
        if (c < 0 || c >= lista.length) return;
        var nome = lista[c];
        (linhas[nome] = linhas[nome] || {})[m] = (linhas[nome][m] || 0) + 1;
      });
    });
    return { linhas: linhas, porMes: porMes, total: total, tecnicos: tecnicosVistos.size };
  }

  // -------------------------------------------------------------- tabela
  function tabela(el, dados, titulo) {
    var ms = mesesExibidos();
    if (!ms.length || !Object.keys(dados.linhas).length) {
      el.innerHTML = '<tbody><tr><td class="vazio-cel" style="padding:22px;text-align:center;">' +
        "Nenhuma reincidência neste recorte." + "</td></tr></tbody>";
      return;
    }
    // Ordena pelo TOTAL do período, não pelo último mês: a pergunta é qual
    // causa mais pesou no recorte inteiro.
    var nomes = Object.keys(dados.linhas).sort(function (a, b) {
      return soma(dados.linhas[b]) - soma(dados.linhas[a]);
    });
    var cab = '<thead><tr><th class="sticky-col">' + Dash.esc(titulo) + "</th>" +
      ms.map(function (m) {
        return '<th class="mes-h' + (ehParcial(m) ? " parcial" : "") + '">' +
          Dash.esc(rotuloMes(m)) + "</th>";
      }).join("") + '<th class="mes-h">Total</th></tr></thead>';

    var corpo = nomes.map(function (nome) {
      var linha = dados.linhas[nome];
      return '<tr><td class="sticky-col nome">' + Dash.esc(nome) + "</td>" +
        ms.map(function (m) {
          var v = linha[m] || 0;
          return '<td class="' + (v ? "" : "vazio-cel") + (ehParcial(m) ? " parcial-cell" : "") +
            '">' + (v || "—") + "</td>";
        }).join("") +
        '<td class="nome">' + soma(linha) + "</td></tr>";
    }).join("");

    var rodape = '<tfoot><tr class="total"><td class="sticky-col">Total</td>' +
      ms.map(function (m) { return "<td>" + (dados.porMes[m] || 0) + "</td>"; }).join("") +
      "<td>" + dados.total + "</td></tr></tfoot>";
    el.innerHTML = cab + "<tbody>" + corpo + "</tbody>" + rodape;
  }

  function soma(linha) {
    return mesesExibidos().reduce(function (s, m) { return s + (linha[m] || 0); }, 0);
  }

  function render() {
    if (!meses().length) {
      document.getElementById("icr-tab4").innerHTML =
        '<tbody><tr><td class="vazio-cel" style="padding:22px;text-align:center;">' +
        "A causa raiz vem do relatório de análises (AII), coletado junto do Dashboard. " +
        "A próxima coleta preenche esta tabela.</td></tr></tbody>";
      document.getElementById("icr-tab5").innerHTML = "";
      return;
    }
    document.querySelectorAll("#view-causaraiz .tm-ind-nome").forEach(function (e) { e.textContent = ind; });
    var permitidos = (alcanceSup || empresasSel.size) ? tecnicosPermitidos() : null;
    var d4 = contar("cat4", permitidos);
    var d5 = contar("cat5", permitidos);
    document.getElementById("icr-total").textContent = Dash.num(d4.total);
    document.getElementById("icr-tec").textContent = Dash.num(d4.tecnicos);
    tabela(document.getElementById("icr-tab4"), d4, "Categoria 4");
    tabela(document.getElementById("icr-tab5"), d5, "Categoria 5");
  }

  // Indicador, supervisor, empresa e período: tudo vem da Tabela mensal, que é
  // dona dos chips desta página.
  document.addEventListener("iqifiltrotabela", function (e) {
    ind = e.detail.ind || ind;
    alcanceSup = e.detail.alcanceSup || null;
    empresasSel = new Set(e.detail.empresas || []);
    mesesVisiveis = e.detail.meses || null;
    fechados = new Set(e.detail.fechados || []);
    render();
  });

  // Também ao entrar na visualização: a tabela cruza milhares de registros, e
  // fazer isso em toda carga do /iqi custaria a quem nunca abre esta tela.
  document.addEventListener("iqiview", function (e) {
    if (e.detail === "tabela") render();
  });
})();
