// Ofensores do time: o desenho da visão por supervisor, UM só para as duas
// telas que a mostram — a Produtividade (período do filtro) e a War Room
// (dia, 7 dias ou mês). Os dados vêm de `war_room.visao_supervisores`.
//
// Os três top 5 têm as MESMAS colunas (pedido de 26/11/2026): Capacidade
// (em campo, no período), Executadas, Recusadas e % de aproveitamento
// (executadas ÷ capacidade em campo). Muda só o critério de ordem de cada
// um, escrito no cabeçalho.
(function () {
  "use strict";

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(n) { return Number(n || 0).toLocaleString("pt-BR"); }
  function pct(v) { return v === null || v === undefined ? "—" : v + "%"; }
  function barraAp(v) {
    return v === null || v === undefined ? "—"
      : '<span class="wr-ap"><i style="width:' + Math.min(v, 100) + '%"></i></span> <b>' + v + "%</b>";
  }
  // [sim, não, sem resposta, sem número de OS]
  function validacao(v) {
    var t = v[0] + v[1] + v[2] + v[3];
    if (!t) return '<span class="subnote" style="margin:0">—</span>';
    return '<span class="ps-val"><span class="badge badge-verde" title="Validada com o supervisor">' + v[0] + " sim</span>" +
      '<span class="badge badge-vermelho" title="Não passou pelo supervisor">' + v[1] + " não</span>" +
      '<span class="badge badge-cinza" title="Sem resposta na War Room' + (v[3] ? "; " + v[3] + " sem número de OS" : "") + '">' +
      (v[2] + v[3]) + " sem resposta</span></span>";
  }

  function geral(lista, escolhido) {
    return '<div class="tabela-wrap"><table class="tbl ps-geral"><thead><tr><th>Supervisor</th><th class="num">Técnicos</th>' +
      '<th class="num">Capacidade total</th><th class="num">Em campo</th><th class="num">Executadas</th>' +
      '<th class="num">Recusas</th><th class="num">Taxa de recusa</th><th>Aproveitamento</th><th>Recusa validada?</th></tr></thead><tbody>' +
      lista.map(function (l) {
        return '<tr class="clicavel' + (l.id === escolhido ? " wr-cap-on" : "") + '" data-ofs="' + l.id + '" title="Clique para ver os técnicos de ' +
          esc(l.nome) + '"><td><b>' + esc(l.nome) + '</b></td><td class="num">' + num(l.tecnicos) + '</td><td class="num">' +
          num(l.cap_total) + '</td><td class="num">' + num(l.cap_campo) + '</td><td class="num">' + num(l.exec) +
          '</td><td class="num">' + num(l.rec) + '</td><td class="num">' + pct(l.taxa_recusa) + "</td><td>" +
          barraAp(l.aproveitamento) + "</td><td>" + validacao(l.validacao) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  // Uma tabela de top 5. `extra(f)` vai abaixo do nome: o que explica a
  // posição do técnico naquele ranking (OS/dia, motivo da recusa).
  function top(tit, sub, lista, extra) {
    var corpo = lista.length ? lista.map(function (f, i) {
      return "<tr><td>" + (i + 1) + "</td><td><b>" + esc(f.n) + '</b><span class="subnote ps-emp">' + esc(f.e || "—") +
        (f.cad ? "" : " · fora do cadastro") + "</span>" + (extra ? extra(f) : "") + "</td>" +
        '<td class="num">' + num(f.cap_campo) + '</td><td class="num">' + num(f.exec) + '</td><td class="num">' + num(f.rec) +
        "</td><td>" + barraAp(f.ap) + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="subnote">Ninguém nesta régua no período.</td></tr>';
    return '<div class="card ps-top"><div class="card-h"><span>' + tit + '</span><span class="subnote" style="margin:0">' + sub +
      '</span></div><div class="card-b tabela-wrap"><table class="tbl"><thead><tr><th>#</th><th>Técnico</th>' +
      // No celular os cabeçalhos encurtam (.ps-curto) para a tabela caber sem rolar de lado.
      '<th class="num" title="Capacidade em campo no período: dias em campo × 4 ou 6"><span class="ps-longo">Capacidade</span><span class="ps-curto">Cap.</span></th>' +
      '<th class="num"><span class="ps-longo">Executadas</span><span class="ps-curto">Exec.</span></th>' +
      '<th class="num"><span class="ps-longo">Recusadas</span><span class="ps-curto">Rec.</span></th>' +
      '<th title="Executadas ÷ capacidade em campo"><span class="ps-longo">Aproveitamento</span><span class="ps-curto">%</span></th></tr></thead><tbody>' +
      corpo + "</tbody></table></div></div>";
  }

  function detalhe(l, d) {
    var ce = d.cap_externa, ci = d.cap_interna, min = d.min_dias;
    var k = [
      [num(l.cap_total), "Capacidade total", "cadastro × " + ce + " ou " + ci + " OS, dias com operação"],
      [num(l.cap_campo), "Capacidade em campo", "dias em campo de cada técnico × " + ce + " ou " + ci],
      [num(l.exec), "Executadas", "OS de cliente com sucesso"],
      [num(l.rec), "Recusadas", pct(l.taxa_recusa) + " das OS fechadas"],
      [pct(l.aproveitamento), "Aproveitamento", "executadas ÷ capacidade em campo"],
      [l.cap_total ? Math.round(100 * l.cap_campo / l.cap_total) + "%" : "—", "Da equipe em campo", "em campo ÷ total"],
    ];
    var diasTxt = min > 1 ? " · " + min + "+ dias em campo" : "";
    var motivos = l.motivos.length ? l.motivos.map(function (m) {
      var w = Math.round(100 * m[1] / l.motivos[0][1]);
      return '<div class="ps-mot"><span class="ps-mot-r">' + esc(m[0]) + '</span><span class="wr-ap"><i style="width:' + w +
        '%"></i></span><b>' + num(m[1]) + "</b></div>";
    }).join("") : '<p class="subnote" style="margin:0">Nenhuma recusa no período.</p>';
    return '<div class="ps-tit"><b>Time de ' + esc(l.nome) + '</b> <span class="subnote" style="margin:0">' + l.tecnicos +
      " técnicos · " + d.dias + (d.dias === 1 ? " dia" : " dias") + " com operação</span></div>" +
      '<div class="kpis ps-kpis">' + k.map(function (x) {
        return '<div class="kpi"><div class="v">' + x[0] + '</div><div class="l">' + x[1] + '</div><div class="l ps-kpi-b">' + x[2] + "</div></div>";
      }).join("") + "</div>" +
      '<h4 class="ps-sec">Top 5 técnicos ofensores</h4>' +
      '<div class="ps-tops">' +
      top("Menor aproveitamento", "executadas ÷ capacidade em campo" + diasTxt, l.top_aproveitamento) +
      top("Menor média de produtividade", "OS executadas por dia em campo" + diasTxt, l.top_media, function (f) {
        return '<span class="subnote ps-emp"><b>' + String(f.media).replace(".", ",") + " OS/dia</b> em " + f.dias_campo +
          (f.dias_campo === 1 ? " dia" : " dias") + "</span>";
      }) +
      top("Mais recusas", "OS encerradas sem sucesso", l.top_recusas, function (f) {
        return (f.motivos[0] ? '<span class="subnote ps-emp">' + esc(f.motivos[0][0]) + " (" + f.motivos[0][1] + ")</span>" : "") +
          validacao(f.val);
      }) +
      "</div>" +
      '<div class="grid charts-2 ps-baixo"><div class="card"><div class="card-h">Motivos das recusas do time</div><div class="card-b">' + motivos +
      '</div></div><div class="card"><div class="card-h">A recusa passou pelo supervisor?</div><div class="card-b">' + validacao(l.validacao) +
      '<p class="subnote" style="margin:10px 0 0">Resposta Sim/Não dada na War Room, que começou em 19/11/2026: recusa de antes ' +
      "aparece como sem resposta. OS sem número (coleta antiga) não tem como ser validada.</p></div></div></div>";
  }

  window.Ofensores = { geral: geral, detalhe: detalhe, esc: esc };
})();
