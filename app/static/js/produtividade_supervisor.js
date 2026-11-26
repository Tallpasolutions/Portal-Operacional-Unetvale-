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
    corpo.innerHTML = (lista.length > 1 ? Ofensores.geral(lista, ESCOLHIDO) : "") +
      (l ? Ofensores.detalhe(l, DADOS) : '<p class="subnote" style="margin:12px 0 0">Clique num supervisor para ver os técnicos ofensores do time.</p>') +
      (DADOS.tem_cadastro ? "" : '<p class="subnote" style="margin:12px 0 0">Sem o cadastro da Equipe técnica, a capacidade total não é calculada.</p>');
  }

  corpo.addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-ofs]");
    if (!tr) return;
    var id = tr.getAttribute("data-ofs");
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
