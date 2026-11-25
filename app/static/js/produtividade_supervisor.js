// Produtividade — visão do supervisor (pedido de 25/11/2026).
//
// Capacidade total, em campo, executadas e recusas do time de cada
// supervisor no período, e os cinco técnicos que mais pesam em três réguas:
// aproveitamento, média de produtividade e recusas (com os motivos e se a
// recusa passou pelo supervisor). O cálculo é do servidor
// (`war_room.visao_supervisores`, as mesmas regras da War Room) e o recorte
// também: o supervisor recebe só o próprio time.
//
// Sem filtro próprio: segue o período (mês, semana, dia) e o supervisor da
// barra da página, publicados por produtividade.js no evento `prodfiltro`.
// Sem período escolhido, vale o mês atual.
(function () {
  "use strict";
  var corpo = document.getElementById("ps-corpo");
  if (!corpo) return;
  var MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(n) { return Number(n || 0).toLocaleString("pt-BR"); }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function br(s) { return s.slice(8, 10) + "/" + MESES[+s.slice(5, 7) - 1]; }
  function hojeBR() { return iso(new Date(Date.now() - 3 * 3600e3)); }
  function primeiro(n) { return String(n || "—").split(" ")[0]; }

  // Semana ISO -> segunda e domingo (a mesma conta do produtividade.js).
  function semana(s) {
    var p = s.split("-W").map(Number);
    var jan4 = new Date(Date.UTC(p[0], 0, 4));
    var seg = new Date(jan4); seg.setUTCDate(jan4.getUTCDate() - (jan4.getUTCDay() + 6) % 7 + (p[1] - 1) * 7);
    var dom = new Date(seg); dom.setUTCDate(seg.getUTCDate() + 6);
    return [iso(seg), iso(dom)];
  }

  function periodo(f) {
    var lim = [];
    if (f.dias && f.dias.length) lim = f.dias.slice();
    else if (f.semanas && f.semanas.length) f.semanas.forEach(function (s) { lim = lim.concat(semana(s)); });
    else if (f.meses && f.meses.length) f.meses.forEach(function (m) {
      var p = m.split("-").map(Number);
      lim.push(m + "-01", iso(new Date(Date.UTC(p[0], p[1], 0))));
    });
    else { var h = hojeBR(); lim = [h.slice(0, 8) + "01", h]; }
    lim.sort();
    var ate = lim[lim.length - 1] > hojeBR() ? hojeBR() : lim[lim.length - 1];
    return [lim[0], ate];
  }

  var DADOS = null, ESCOLHIDO = null, PEDIDO = "", FILTRO = window.__prodFiltro || {};

  async function buscar() {
    var p = periodo(FILTRO), chave = p.join("|");
    if (chave === PEDIDO && DADOS) { desenhar(); return; }
    PEDIDO = chave;
    document.getElementById("ps-periodo").textContent = "· " + br(p[0]) + " a " + br(p[1]);
    corpo.classList.add("ps-carregando");
    try {
      var r = await fetch("/produtividade/supervisores?de=" + p[0] + "&ate=" + p[1],
        { credentials: "same-origin", headers: { "Accept": "application/json" } });
      var j = await r.json();
      if (!r.ok) throw new Error(j.erro || "HTTP " + r.status);
      if (chave !== PEDIDO) return;          // outro filtro chegou enquanto buscava
      DADOS = j;
      desenhar();
    } catch (e) {
      corpo.innerHTML = '<p class="subnote" style="margin:0">Não foi possível carregar a visão do supervisor (' + esc(e.message) + ").</p>";
    } finally {
      corpo.classList.remove("ps-carregando");
    }
  }

  function pct(v) { return v === null || v === undefined ? "—" : v + "%"; }
  function barraAp(v) {
    return v === null || v === undefined ? "—"
      : '<span class="wr-ap"><i style="width:' + Math.min(v, 100) + '%"></i></span> <b>' + v + "%</b>";
  }
  function validacao(v) {
    // [sim, não, sem resposta, sem número]
    var t = v[0] + v[1] + v[2] + v[3];
    if (!t) return '<span class="subnote" style="margin:0">—</span>';
    return '<span class="ps-val"><span class="badge badge-verde" title="Validada com o supervisor">' + v[0] + " sim</span>" +
      '<span class="badge badge-vermelho" title="Não passou pelo supervisor">' + v[1] + " não</span>" +
      '<span class="badge badge-cinza" title="Sem resposta na War Room' + (v[3] ? "; " + v[3] + " sem número de OS" : "") + '">' +
      (v[2] + v[3]) + " sem resposta</span></span>";
  }

  function visaoGeral(lista) {
    return '<div class="tabela-wrap"><table class="tbl ps-geral"><thead><tr><th>Supervisor</th><th class="num">Técnicos</th>' +
      '<th class="num">Capacidade total</th><th class="num">Em campo</th><th class="num">Executadas</th>' +
      '<th class="num">Recusas</th><th class="num">Taxa de recusa</th><th>Aproveitamento</th><th>Recusa validada?</th></tr></thead><tbody>' +
      lista.map(function (l) {
        return '<tr class="clicavel' + (l.id === ESCOLHIDO ? " wr-cap-on" : "") + '" data-s="' + l.id + '" title="Clique para ver os técnicos de ' +
          esc(l.nome) + '"><td><b>' + esc(l.nome) + '</b></td><td class="num">' + num(l.tecnicos) + '</td><td class="num">' +
          num(l.cap_total) + '</td><td class="num">' + num(l.cap_campo) + '</td><td class="num">' + num(l.exec) +
          '</td><td class="num">' + num(l.rec) + '</td><td class="num">' + pct(l.taxa_recusa) + "</td><td>" +
          barraAp(l.aproveitamento) + "</td><td>" + validacao(l.validacao) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function top(tit, sub, lista, col, val) {
    var corpoT = lista.length ? lista.map(function (f, i) {
      return "<tr><td>" + (i + 1) + "</td><td><b>" + esc(f.n) + '</b><span class="subnote ps-emp">' + esc(f.e || "—") +
        (f.cad ? "" : " · fora do cadastro") + "</span></td><td>" + val(f) + "</td></tr>";
    }).join("") : '<tr><td colspan="3" class="subnote">Ninguém nesta régua no período.</td></tr>';
    return '<div class="card ps-top"><div class="card-h"><span>' + tit + '</span><span class="subnote" style="margin:0">' + sub +
      '</span></div><div class="card-b tabela-wrap"><table class="tbl"><thead><tr><th>#</th><th>Técnico</th><th>' + col +
      "</th></tr></thead><tbody>" + corpoT + "</tbody></table></div></div>";
  }

  function detalhe(l) {
    var k = [
      [num(l.cap_total), "Capacidade total", "cadastro × " + DADOS.cap_externa + " ou " + DADOS.cap_interna + " OS, dias com operação"],
      [num(l.cap_campo), "Capacidade em campo", "dias em campo de cada técnico × " + DADOS.cap_externa + " ou " + DADOS.cap_interna],
      [num(l.exec), "Executadas", "OS de cliente com sucesso"],
      [num(l.rec), "Recusadas", pct(l.taxa_recusa) + " das OS fechadas"],
      [pct(l.aproveitamento), "Aproveitamento", "executadas ÷ capacidade em campo"],
      [l.cap_total ? Math.round(100 * l.cap_campo / l.cap_total) + "%" : "—", "Da equipe em campo", "em campo ÷ total"],
    ];
    var min = DADOS.min_dias;
    var motivos = l.motivos.length ? l.motivos.map(function (m) {
      var w = Math.round(100 * m[1] / l.motivos[0][1]);
      return '<div class="ps-mot"><span class="ps-mot-r">' + esc(m[0]) + '</span><span class="wr-ap"><i style="width:' + w +
        '%"></i></span><b>' + num(m[1]) + "</b></div>";
    }).join("") : '<p class="subnote" style="margin:0">Nenhuma recusa no período.</p>';
    return '<div class="ps-tit"><b>Time de ' + esc(l.nome) + "</b> <span class=\"subnote\" style=\"margin:0\">" + l.tecnicos +
      " técnicos · " + DADOS.dias + " dias com operação</span></div>" +
      '<div class="kpis ps-kpis">' + k.map(function (x) {
        return '<div class="kpi"><div class="v">' + x[0] + '</div><div class="l">' + x[1] + '</div><div class="l ps-kpi-b">' + x[2] + "</div></div>";
      }).join("") + "</div>" +
      '<h4 class="ps-sec">Técnicos ofensores</h4>' +
      '<div class="grid ps-tops">' +
      top("Aproveitamento", "menor uso da capacidade em campo · " + min + "+ dias", l.top_aproveitamento, "Aproveitamento", function (f) {
        return barraAp(f.ap) + ' <span class="subnote" style="margin:0">' + num(f.exec) + " de " + num(f.cap_campo) + "</span>";
      }) +
      top("Média de produtividade", "menos OS executadas por dia em campo · " + min + "+ dias", l.top_media, "OS/dia", function (f) {
        return "<b>" + String(f.media).replace(".", ",") + '</b> <span class="subnote" style="margin:0">' + num(f.exec) + " em " + f.dias_campo + " dias</span>";
      }) +
      top("Recusas", "mais OS encerradas sem sucesso", l.top_recusas, "Recusas · motivo · validada?", function (f) {
        return "<b>" + num(f.rec) + "</b>" + (f.motivos[0] ? '<span class="subnote ps-emp">' + esc(f.motivos[0][0]) + " (" + f.motivos[0][1] + ")</span>" : "") +
          validacao(f.val);
      }) +
      "</div>" +
      '<div class="grid charts-2 ps-baixo"><div class="card"><div class="card-h">Motivos das recusas do time</div><div class="card-b">' + motivos +
      '</div></div><div class="card"><div class="card-h">A recusa passou pelo supervisor?</div><div class="card-b">' + validacao(l.validacao) +
      '<p class="subnote" style="margin:10px 0 0">Resposta Sim/Não dada na War Room, que começou em 19/11/2026: recusa de antes ' +
      "aparece como sem resposta. OS sem número (coleta antiga) não tem como ser validada.</p></div></div></div>";
  }

  function desenhar() {
    var lista = (DADOS && DADOS.supervisores) || [];
    if (!lista.length) {
      corpo.innerHTML = '<p class="subnote" style="margin:0">Nenhum time com OS de cliente no período.</p>';
      return;
    }
    // O supervisor (que só recebe o próprio time) cai direto no dele.
    if (lista.length === 1) ESCOLHIDO = lista[0].id;
    if (ESCOLHIDO && !lista.some(function (l) { return l.id === ESCOLHIDO; })) ESCOLHIDO = null;
    var l = lista.filter(function (x) { return x.id === ESCOLHIDO; })[0];
    corpo.innerHTML = (lista.length > 1 ? visaoGeral(lista) : "") +
      (l ? detalhe(l) : '<p class="subnote" style="margin:12px 0 0">Clique num supervisor para ver os técnicos ofensores do time.</p>') +
      (DADOS.tem_cadastro ? "" : '<p class="subnote" style="margin:12px 0 0">Sem o cadastro da Equipe técnica, a capacidade total não é calculada.</p>');
  }

  corpo.addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-s]");
    if (!tr) return;
    var id = tr.getAttribute("data-s");
    ESCOLHIDO = ESCOLHIDO === id ? null : id;
    desenhar();
  });

  // Escolher um supervisor no filtro da página abre o time dele aqui; o
  // clique numa linha daqui não mexe no filtro da página.
  ESCOLHIDO = FILTRO.sup || null;
  var espera = null;
  document.addEventListener("prodfiltro", function (e) {
    var antes = FILTRO.sup || "";
    FILTRO = e.detail || {};
    if ((FILTRO.sup || "") !== antes) ESCOLHIDO = FILTRO.sup || null;
    clearTimeout(espera);
    espera = setTimeout(buscar, 250);
  });
  buscar();
})();
