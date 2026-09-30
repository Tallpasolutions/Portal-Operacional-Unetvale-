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
//
// Cross-filter: clicar numa linha de Cat 4, 5 ou 6 filtra as OUTRAS duas
// tabelas pelos protocolos daquela linha (a própria continua inteira, com a
// linha marcada). A contagem é `Dash.contarCategorias`, a mesma do Dashboard.
(function () {
  "use strict";
  var CR = window.__CAUSA_RAIZ__ || {};
  var Dash = window.Dash;
  var Sup = window.__iqiSupervisor;
  var raiz = document.getElementById("view-causaraiz");
  if (!raiz || !Dash) return;

  var TEC = CR.tec || [];
  var sel = {};   // {cat4|cat5|cat6: rotulo} — o cross-filter
  var ROTULO = { cat4: "Categoria 4", cat5: "Categoria 5", cat6: "Categoria 6" };

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

  // -------------------------------------------------------------- tabela
  // `dados` = {linhas: {categoria: {mes: n}}, porMes, total}. `campo` liga o
  // clique da linha ao cross-filter. O rodapé "Total" é de PROTOCOLOS, não a
  // soma das linhas — na Cat 6, que é múltipla, a soma passa do total.
  function tabela(el, dados, titulo, campo, vazio) {
    var ms = mesesExibidos();
    if (!ms.length || !Object.keys(dados.linhas).length) {
      el.innerHTML = '<tbody><tr><td class="vazio-cel" style="padding:22px;text-align:center;">' +
        (vazio || "Nenhuma reincidência neste recorte.") + "</td></tr></tbody>";
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
      var marca = sel[campo] === undefined ? "" : (sel[campo] === nome ? " selecionado" : " apagado");
      return '<tr class="clicavel' + marca + '" data-campo="' + campo + '" data-rotulo="' + Dash.esc(nome) +
        '" title="' + (sel[campo] === nome ? "Clique para desfazer o filtro" : "Clique para filtrar as outras tabelas") + '">' +
        '<td class="sticky-col nome">' + Dash.esc(nome) + "</td>" +
        ms.map(function (m) {
          var v = linha[m] || 0;
          return '<td class="' + (v ? "" : "vazio-cel") + (ehParcial(m) ? " parcial-cell" : "") +
            '">' + (v || "—") + "</td>";
        }).join("") +
        '<td class="nome">' + soma(linha) + "</td></tr>";
    }).join("");

    var rodape = '<tfoot><tr class="total"><td class="sticky-col">Protocolos</td>' +
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
      document.getElementById("icr-tab6").innerHTML = "";
      return;
    }
    document.querySelectorAll("#view-causaraiz .tm-ind-nome").forEach(function (e) { e.textContent = ind; });
    var permitidos = (alcanceSup || empresasSel.size) ? tecnicosPermitidos() : null;
    var d = Dash.contarCategorias(CR, ind, mesesExibidos(),
      { tecnicos: permitidos, sel: sel, campos: ["cat4", "cat5", "cat6"] });
    document.getElementById("icr-total").textContent = Dash.num(d.total);
    document.getElementById("icr-tec").textContent = Dash.num(d.tecnicos);
    function dados(campo) { return { linhas: d.mensal[campo] || {}, porMes: d.porMes, total: d.total }; }
    tabela(document.getElementById("icr-tab4"), dados("cat4"), "Categoria 4", "cat4");
    tabela(document.getElementById("icr-tab5"), dados("cat5"), "Categoria 5", "cat5");
    // "Não coletada" ≠ "nenhum ajuste": a Cat 6 entrou na coleta em 29/09/2026
    // e os meses anteriores só a têm depois do backfill.
    tabela(document.getElementById("icr-tab6"), dados("cat6"), "Categoria 6", "cat6",
      d.total && !d.coletados.cat6
        ? "A Categoria 6 destes meses ainda não foi coletada (entrou em 29/09/2026; os anteriores dependem do backfill)."
        : "Nenhum ajuste de Categoria 6 registrado neste recorte.");
    document.getElementById("icr-sel").innerHTML = Object.keys(sel).map(function (c) {
      return '<span class="chip">' + Dash.esc(ROTULO[c]) + ": " + Dash.esc(sel[c]) +
        ' <button type="button" data-campo="' + c + '" aria-label="Remover filtro">×</button></span>';
    }).join("");
  }

  // Um ouvinte no bloco inteiro (delegado): as tabelas são redesenhadas a cada
  // clique, e ouvinte preso à linha morreria com ela.
  raiz.addEventListener("click", function (e) {
    var chip = e.target.closest("#icr-sel button[data-campo]");
    if (chip) { delete sel[chip.dataset.campo]; render(); return; }
    var tr = e.target.closest("tr.clicavel[data-campo]");
    if (!tr) return;
    var c = tr.dataset.campo, r = tr.getAttribute("data-rotulo");
    if (sel[c] === r) delete sel[c]; else sel[c] = r;
    render();
  });

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
