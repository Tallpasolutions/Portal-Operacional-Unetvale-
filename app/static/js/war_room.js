// War Room de Operações: números do dia, rotina dos supervisores e desvios.
//
// Tudo sai de window.__WR__ (montado por app/war_room.py). O DIA muda os
// números — eles vêm do servidor, por `/war-room/pacote`, e a tela se
// redesenha sem recarregar (clique num dia do gráfico, na tabela dia a dia
// ou no campo Dia). A mesma rota traz a ATUALIZAÇÃO AUTOMÁTICA: de 2 em 2 min
// a tela pergunta os carimbos das fontes e, se mudaram, pede o pacote de
// novo. O resto (período, status, busca, cross-filter dos rankings) filtra
// os desvios aqui. As gravações voltam JSON e a tela se redesenha no lugar.
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

  // Cross-filter das recusas: tipo de OS e motivo. Sobrevive à troca de dia
  // e à atualização automática, como a série isolada do gráfico.
  var REC = { tipo: null, motivo: null };
  var TIPO_OS = {};
  (CAT.tipos_os || []).forEach(function (t) { TIPO_OS[t.id] = t.rotulo; });
  function rotTipo(id) { return TIPO_OS[id] || id || "—"; }

  // ---------------------------------------------------------------------
  // Fontes
  // ---------------------------------------------------------------------
  // A cadência da Produtividade é do coletor (coleta rápida de 10 em 10 min
  // na semana de 23/11/2026, de 2 em 2 h fora dela) e o app não a conhece:
  // a tela diz QUANDO atualizou, não promete de quanto em quanto.
  function fontes() {
    var hora = function (t) { return t ? t.slice(-5) : "—"; };
    $("wr-barra-rot").innerHTML =
      '<span class="wr-pill">sem retirada e sem infra</span>' +
      '<span title="Produtividade atualizada em ' + esc(D.produtividade.atualizado || "—") + '">Produtividade <b>' +
      esc(hora(D.produtividade.atualizado)) + "</b></span>" +
      '<span title="Esteira atualizada em ' + esc(D.esteira.atualizado || "—") + '">esteira <b>' + esc(hora(D.esteira.atualizado)) +
      "</b></span>" + '<span class="wr-barra-regua">régua: média do mesmo dia da semana de ' + rotDia(D.base_de) + " a " +
      rotDia(D.base_ate) + "</span>";
  }

  // ---------------------------------------------------------------------
  // Números do dia
  // ---------------------------------------------------------------------
  // Variação contra a régua, em pílula: verde quando vai no sentido bom,
  // vermelho quando vai no ruim, neutra quando não há sentido (entradas).
  function delta(atual, ref, maiorMelhor) {
    if (ref === undefined || ref === null) return "";
    var d = atual - ref;
    var cls = maiorMelhor === null || !d ? "" : ((maiorMelhor ? d > 0 : d < 0) ? " ok" : " fora");
    var seta = d > 0 ? "▲" : (d < 0 ? "▼" : "");
    return '<span class="wr-delta' + cls + '">' + seta + " " + num(Math.abs(d)) + "</span>";
  }

  // Mini-gráfico de 14 dias até o dia em foco, em SVG (quatro canvases a
  // mais pesariam e não somam nada que um traço não diga). O último ponto
  // é o dia em foco, marcado. Sem dado num dia, o traço quebra.
  function sparkline(vals) {
    var W = 240, H = 30, P = 3;
    var ok = vals.filter(function (v) { return v !== null && v !== undefined; });
    if (ok.length < 2) return "";
    var max = Math.max.apply(null, ok), min = Math.min.apply(null, ok);
    var esc_ = max - min || 1;
    var x = function (i) { return P + i * (W - 2 * P) / (vals.length - 1); };
    var y = function (v) { return H - P - (v - min) * (H - 2 * P) / esc_; };
    var seg = [], cur = [];
    vals.forEach(function (v, i) {
      if (v === null || v === undefined) { if (cur.length) seg.push(cur); cur = []; return; }
      cur.push(x(i).toFixed(1) + "," + y(v).toFixed(1));
    });
    if (cur.length) seg.push(cur);
    var ult = vals[vals.length - 1];
    return '<svg class="wr-spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      seg.map(function (p) { return '<polyline points="' + p.join(" ") + '"/>'; }).join("") +
      (ult !== null && ult !== undefined ? '<circle cx="' + x(vals.length - 1).toFixed(1) + '" cy="' + y(ult).toFixed(1) + '" r="2.6"/>' : "") +
      "</svg>";
  }

  function ultimosDias(n) {
    var out = [], d = new Date(D.dia + "T12:00:00");
    for (var i = n - 1; i >= 0; i--) {
      var x = new Date(d); x.setDate(d.getDate() - i);
      out.push(x.toISOString().slice(0, 10));
    }
    return out;
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
    var dias14 = ultimosDias(14);
    var pd = function (i) { return dias14.map(function (d) { var x = D.produtividade.por_dia[d]; return x ? x[i] : null; }); };
    var taxa = p[0] + p[1] ? Math.round(100 * p[1] / (p[0] + p[1])) : null;
    // Com o dia em andamento não há diferença a mostrar: às 14h, "−77" contra
    // a média do dia INTEIRO assusta e não diz nada sobre o ritmo. O backlog
    // continua comparando — ele é uma foto, não um acumulado do dia.
    var cel = [
      { q: "Executadas com sucesso", n: p[0], cor: "suc",
        d: bp && !emAndamento ? delta(p[0], bp[0], true) : "",
        b: bp ? "média de " + SEMANA[w] + " <b>" + num(bp[0]) + "</b>" : "sem régua",
        s: sparkline(pd(0)) },
      { q: "Recusas", n: p[1], cor: "rec",
        d: bp && !emAndamento ? delta(p[1], bp[1], false) : "",
        b: (taxa !== null ? "<b>" + taxa + "%</b> das OS fechadas" : "") + (bp ? " · média <b>" + num(bp[1]) + "</b>" : ""),
        s: sparkline(pd(1)) },
      { q: "Entraram na esteira", n: ent, cor: "ent",
        d: be && !emAndamento ? delta(ent, be, null) : "",
        b: (be ? "média de " + SEMANA[w] + " <b>" + num(be) + "</b>" : "sem régua") +
           (D.esteira.lacuna[dia] ? " · +" + D.esteira.lacuna[dia] + " após lacuna" : ""),
        s: sparkline(dias14.map(function (d) { return D.esteira.entradas[d] === undefined ? null : D.esteira.entradas[d]; })) },
      { q: "Backlog da esteira", n: bk ? bk[0] : null, cor: "bk",
        d: bk && bkIni && dia >= D.inicio ? delta(bk[0], bkIni[0], false) : "",
        b: bk ? "<b>" + num(bk[1]) + "</b> não agendadas" + (bkIni && dia >= D.inicio ? " · " + rotDia(vespIso) + ": " + num(bkIni[0]) : "")
              : "sem foto da esteira neste dia",
        s: sparkline(dias14.map(function (d) { var b = D.esteira.backlog[d]; return b ? b[0] : null; })) },
    ];
    $("wr-numeros").innerHTML = cel.map(function (c) {
      return '<div class="wr-kpi wr-k-' + c.cor + '"><div class="wr-kpi-t"><span class="q">' + c.q + "</span>" +
        (emAndamento && c.cor !== "bk" ? '<span class="wr-vivo" title="Dia em andamento: o número ainda cresce">ao vivo</span>' : "") +
        '</div><div class="wr-kpi-n"><span class="n">' + (c.n === null ? "—" : num(c.n)) + "</span>" + (c.d || "") + "</div>" +
        '<div class="wr-kpi-p"><span class="b">' + c.b + "</span>" + c.s + "</div></div>";
    }).join("");
    capacidade();
  }

  // "Total" na tela, `instalada` no código e no pacote: o rótulo era
  // "Instalada" e foi trocado em 24/11/2026 porque, na mesma página, há o
  // tipo de OS "Instalação" e as duas palavras se confundiam.
  // Capacidade em três réguas sobre a MESMA escala (a total): a equipe
  // inteira, quem foi a campo e o que saiu com sucesso. Duas razões em
  // destaque: quanto da equipe trabalhou e quanto do que ela podia fazer
  // virou OS resolvida. Sem cadastro (migration 0023) cai só no em campo.
  // Supervisor escolhido no bloco de capacidade (null = operação inteira).
  // O supervisor abre no próprio time, como a lista de encerradas.
  var CAPSUP;
  function capacidade() {
    var dia = D.dia, el = $("wr-cap");
    var PS = D.produtividade.por_supervisor || [];
    if (CAPSUP === undefined) {
      CAPSUP = SUP && PS.some(function (l) { return l.id === EU; }) ? EU : null;
    }
    var linha = CAPSUP === null ? null : PS.filter(function (l) { return l.id === CAPSUP; })[0];
    if (CAPSUP !== null && !linha) { CAPSUP = null; }
    var inst = (D.produtividade.instalada || {})[dia];
    var cap = (D.produtividade.capacidade || {})[dia];
    var p = D.produtividade.por_dia[dia] || [0, 0];
    // Os números do recorte: operação inteira, ou a linha do supervisor.
    var tot = linha ? linha.total : inst, campoCap = linha ? linha.campo[0] : (cap ? cap[0] : null);
    var campoN = linha ? linha.campo[1] : (cap ? cap[1] + cap[2] : 0);
    var exe = linha ? linha.exec : p[0], rec = linha ? linha.rec : p[1];
    var topo = Math.max(tot ? tot[0] : 0, campoCap || 0, exe + rec, 1);
    function barra(rot, v, cls, det) {
      return '<div class="wr-cap-l"><span class="wr-cap-r">' + rot + '</span><span class="wr-cap-t"><i class="' + cls +
        '" style="width:' + (v === null ? 0 : (100 * v / topo)).toFixed(1) + '%"></i></span><span class="wr-cap-v">' +
        (v === null ? "—" : num(v)) + "</span>" + (det ? '<span class="wr-cap-d">' + det + "</span>" : "") + "</div>";
    }
    var pct = function (a, b) { return b ? Math.round(100 * a / b) + "%" : "—"; };
    var fora = !linha && cap && cap[3] ? " · " + cap[3] + " fora do cadastro" : "";
    var escolha = PS.length ? '<div class="toggle toggle-mini wr-cap-sup" id="wr-cap-sup">' +
      '<button type="button" data-s="" class="' + (CAPSUP === null ? "active" : "") + '">Operação</button>' +
      PS.filter(function (l) { return l.id; }).map(function (l) {
        return '<button type="button" data-s="' + l.id + '" class="' + (CAPSUP === l.id ? "active" : "") + '">' +
          esc(nomeCurto(l.nome)) + "</button>";
      }).join("") + "</div>" : "";
    var tabela = PS.length ? '<div class="tabela-wrap wr-cap-tab"><table class="tbl"><thead><tr><th>Supervisor</th>' +
      '<th class="num">Técnicos</th><th class="num">Capacidade total</th><th class="num">Em campo</th>' +
      '<th class="num">Executadas</th><th class="num">Recusas</th><th class="num">Taxa de recusa</th>' +
      '<th>Aproveitamento</th></tr></thead><tbody>' + PS.map(function (l) {
        var ap = l.campo[0] ? Math.round(100 * l.exec / l.campo[0]) : null;
        var tx = l.exec + l.rec ? Math.round(100 * l.rec / (l.exec + l.rec)) : null;
        return '<tr class="' + (l.id ? "clicavel" : "") + (l.id && l.id === CAPSUP ? " wr-cap-on" : "") + '"' +
          (l.id ? ' data-s="' + l.id + '" title="Clique para ver a capacidade deste time"' : "") + "><td><b>" + esc(l.nome) +
          '</b></td><td class="num">' + num(l.tecnicos) + '</td><td class="num">' + num(l.total[0]) +
          '</td><td class="num">' + num(l.campo[0]) + ' <span class="subnote" style="margin:0">' + l.campo[1] + " téc.</span>" +
          '</td><td class="num">' + num(l.exec) + '</td><td class="num">' + num(l.rec) +
          '</td><td class="num">' + (tx === null ? "—" : tx + "%") + "</td><td>" +
          (ap === null ? "—" : '<span class="wr-ap"><i style="width:' + Math.min(ap, 100) + '%"></i></span> <b>' + ap + "%</b>") +
          "</td></tr>";
      }).join("") + "</tbody></table></div>" : "";
    el.innerHTML = '<div class="wr-cap-topo"><span class="wr-cap-tit">' + (linha ? "Time de " + esc(linha.nome) : "Operação inteira") +
      "</span>" + escolha + "</div>" +
      '<div class="wr-cap-grade"><div class="wr-cap-barras">' +
      barra("Total", tot ? tot[0] : null, "i-inst", tot ? tot[2] + " internos × " + D.cap_interna + " + " + tot[1] + " externos × " + D.cap_externa : "sem cadastro") +
      barra("Em campo", campoCap, "i-campo", campoN ? campoN + (campoN === 1 ? " técnico" : " técnicos") + " em campo" + fora : "ninguém em campo") +
      barra("Executadas", exe, "i-exec", num(rec) + " recusas") +
      '</div><div class="wr-cap-kpis">' +
      '<div><span class="n">' + (tot && campoCap !== null ? pct(campoCap, tot[0]) : "—") + '</span><span class="q">da equipe em campo</span>' +
      '<span class="b">capacidade em campo ÷ capacidade total</span></div>' +
      '<div><span class="n">' + (campoCap ? pct(exe, campoCap) : "—") + '</span><span class="q">aproveitamento</span>' +
      '<span class="b">executadas ÷ capacidade em campo</span></div>' +
      "</div></div>" + listaTecnicos(linha) + tabela +
      '<p class="subnote" style="margin:12px 0 0">' + (dia === D.hoje ? "Dia em andamento: em campo e executadas ainda crescem. " : "") +
        "De quem é cada técnico: o time de cada supervisor em Configurações (equipes inteiras e técnicos nome a nome).</p>";
  }

  // A lista de técnicos do supervisor escolhido (pedido de 25/11/2026):
  // quem a conta considera em campo no dia e quem não, e o supervisor
  // corrige — esteve em campo sem fechar OS, ou fechou uma e foi embora.
  // A correção é do banco (append-only), vale no topo, no gráfico e aqui.
  function podeCorrigir() {
    if (!SUP || !D.produtividade.tem_presenca) return false;
    var lim = new Date(D.hoje + "T12:00:00"); lim.setDate(lim.getDate() - 7);
    return D.dia >= lim.toISOString().slice(0, 10);
  }
  function listaTecnicos(linha) {
    if (!linha || !linha.tecs || !linha.tecs.length) return "";
    var pode = podeCorrigir();
    var dentro = linha.tecs.filter(function (t) { return t.c; }), fora = linha.tecs.filter(function (t) { return !t.c; });
    function linhaTec(t) {
      var p = t.p;
      var sit = t.auto ? '<span class="badge badge-verde">fechou OS</span>' : '<span class="badge badge-cinza">não fechou OS</span>';
      var cor = p ? '<span class="subnote wr-quem">' + (p.presente ? "marcado em campo" : "marcado fora") + " por " +
        esc(nomeCurto(p.por)) + " " + esc(p.hora || "") +
        (pode ? ' · <button type="button" class="wr-desfazer" data-pres="auto" data-k="' + esc(t.k) + '" title="Volta a valer o que a Produtividade diz">automático</button>' : "") +
        "</span>" : "";
      var cel = pode
        ? '<span class="toggle toggle-mini wr-valida wr-pres" data-k="' + esc(t.k) + '">' +
          '<button type="button" data-p="sim" class="' + (t.c ? "active" : "") + '">Em campo</button>' +
          '<button type="button" data-p="nao" class="' + (!t.c ? "active wr-nao" : "") + '">Fora</button></span>'
        : '<span class="badge ' + (t.c ? "badge-verde" : "badge-cinza") + '">' + (t.c ? "em campo" : "fora") + "</span>";
      return '<tr class="' + (t.c ? "" : "wr-tec-fora") + '"><td><b>' + esc(t.n) + '</b><span class="subnote wr-emp">' + esc(t.e || "—") +
        (t.cad ? "" : " · fora do cadastro") + '<span class="wr-so-cel"> · ' + num(t.x) + (t.r ? " + " + t.r + " rec." : " OS") + "</span></span></td>" +
        "<td>" + (t.i ? "interno · " + D.cap_interna : "externo · " + D.cap_externa) + "</td>" +
        '<td class="num">' + num(t.x) + (t.r ? ' <span class="subnote" style="margin:0">+ ' + t.r + " rec.</span>" : "") + "</td>" +
        "<td>" + sit + "</td><td>" + cel + cor + "</td></tr>";
    }
    function grupo(tit, lista) {
      return lista.length ? '<tr class="eq-grupo"><td colspan="5"><b>' + tit + '</b><span class="subnote"> ' + lista.length +
        (lista.length === 1 ? " técnico" : " técnicos") + "</span></td></tr>" + lista.map(linhaTec).join("") : "";
    }
    return '<div class="wr-cap-tecs"><div class="wr-cap-tecs-t"><b>Técnicos de ' + esc(nomeCurto(linha.nome)) + "</b>" +
      '<span class="subnote" style="margin:0">' + (pode ? "corrija quem esteve ou não em campo: muda a capacidade em campo"
        : SUP ? "só os últimos 7 dias podem ser corrigidos" : "o supervisor corrige quem esteve em campo") + "</span></div>" +
      '<div class="tabela-wrap"><table class="tbl wr-ss wr-tecs"><thead><tr><th>Técnico</th><th>Perfil</th>' +
      '<th class="num">Executadas</th><th>No WVSA</th><th>Na conta do dia</th></tr></thead><tbody>' +
      grupo("Considerados em campo", dentro) + grupo("Não considerados", fora) + "</tbody></table></div></div>";
  }

  $("wr-cap").addEventListener("click", async function (e) {
    var pb = e.target.closest("[data-p]") || e.target.closest("[data-pres]");
    if (pb) {
      if (pb.disabled) return;
      var k = pb.getAttribute("data-k") || pb.parentNode.getAttribute("data-k");
      var linha = (D.produtividade.por_supervisor || []).filter(function (l) { return l.id === CAPSUP; })[0];
      var t = linha && linha.tecs.filter(function (x) { return x.k === k; })[0];
      if (!t) return;
      var presente = pb.hasAttribute("data-pres") ? null : pb.getAttribute("data-p") === "sim";
      // Clicar no estado que já vale não grava nada: sem correção, "Em campo"
      // de quem fechou OS é o próprio automático.
      if (presente !== null && t.c === presente) return;
      pb.disabled = true;
      try {
        var r = await postJSON("/war-room/presenca", { dia: D.dia, tecnico: k, presente: presente });
        aplicar(r.pacote);
        alertar(presente === null ? "Voltou ao automático." : "Correção gravada.");
      } catch (err) {
        pb.disabled = false;
        alertar(err.message);
      }
      return;
    }
    var b = e.target.closest("[data-s]");
    if (!b) return;
    var id = b.getAttribute("data-s") || null;
    CAPSUP = CAPSUP === id && b.tagName === "TR" ? null : id;
    capacidade();
    desenharOfensores();
  });

  // ---------------------------------------------------------------------
  // Top 5 ofensores (pedido de 26/11/2026)
  // ---------------------------------------------------------------------
  // O cálculo é do servidor (`/war-room/ofensores`, o mesmo da visão do
  // supervisor da Produtividade) e o desenho é `supervisor_ofensores.js`,
  // um só para as duas telas. O supervisor do bloco é o da capacidade
  // (CAPSUP): escolher num lugar escolhe no outro. O período é deste bloco
  // e vai até o dia em foco; só se pede de novo quando ele muda ou quando a
  // Produtividade/Esteira trazem dado novo.
  var OF = { per: "mes", chave: "", dados: null, versao: null };
  function ofPeriodo() {
    var ate = D.dia, de = ate;
    if (OF.per === "7") {
      var d = new Date(ate + "T12:00:00"); d.setDate(d.getDate() - 6); de = d.toISOString().slice(0, 10);
    } else if (OF.per === "mes") de = ate.slice(0, 8) + "01";
    return [de, ate];
  }
  async function ofensores() {
    var el = $("wr-of");
    if (!el || !window.Ofensores) return;
    var p = ofPeriodo(), chave = p.join("|") + "|" + D.versao;
    $("wr-of-sub").textContent = rotDia(p[0]) + (p[0] === p[1] ? "" : " a " + rotDia(p[1]));
    if (chave === OF.chave && OF.dados) { desenharOfensores(); return; }
    OF.chave = chave;
    el.classList.add("ps-carregando");
    try {
      var r = await fetch("/war-room/ofensores?de=" + p[0] + "&ate=" + p[1],
        { credentials: "same-origin", headers: { "Accept": "application/json" } });
      var j = null;
      try { j = await r.json(); } catch (e) { /* sessão expirada devolve HTML */ }
      if (!r.ok || !j) throw new Error((j && j.erro) || "HTTP " + r.status);
      if (chave !== OF.chave) return;          // outro período chegou enquanto buscava
      OF.dados = j;
      desenharOfensores();
    } catch (e) {
      OF.chave = "";
      el.innerHTML = '<p class="subnote" style="margin:0">Não foi possível carregar o top 5 (' + esc(e.message) + ").</p>";
    } finally {
      el.classList.remove("ps-carregando");
    }
  }
  function desenharOfensores() {
    var el = $("wr-of");
    if (!el || !OF.dados || !window.Ofensores) return;
    var lista = OF.dados.supervisores || [];
    if (!lista.length) {
      el.innerHTML = '<p class="subnote" style="margin:0">Nenhum time com OS de cliente no período.</p>';
      return;
    }
    var escolhido = CAPSUP && lista.some(function (l) { return l.id === CAPSUP; }) ? CAPSUP
      : lista.length === 1 ? lista[0].id : null;
    var l = lista.filter(function (x) { return x.id === escolhido; })[0];
    el.innerHTML = (lista.length > 1 ? Ofensores.geral(lista, escolhido) : "") +
      (l ? Ofensores.detalhe(l, OF.dados)
         : '<p class="subnote" style="margin:12px 0 0">Clique num supervisor (aqui ou na capacidade) para ver o top 5 do time.</p>');
  }
  if ($("wr-of")) {
    $("wr-of").addEventListener("click", function (e) {
      var tr = e.target.closest("tr[data-ofs]");
      if (!tr) return;
      var id = tr.getAttribute("data-ofs");
      CAPSUP = CAPSUP === id ? null : id;
      capacidade();
      desenharOfensores();
    });
    $("wr-of-per").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-p]");
      if (!b || b.classList.contains("active")) return;
      OF.per = b.getAttribute("data-p");
      this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x === b); });
      ofensores();
    });
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

  // Cross-filter dos gráficos (pedido de 23/11/2026):
  // * clicar num DIA (qualquer barra da coluna, nos dois gráficos, ou a linha
  //   da tabela dia a dia) põe a tela inteira naquele dia — números, rotina,
  //   encerradas sem sucesso e desvios. Clicar de novo no dia em foco volta
  //   para hoje;
  // * clicar na LEGENDA isola a série; clicar de novo mostra todas. O padrão
  //   do Chart.js (esconder a clicada) faz o contrário do que se quer ao
  //   procurar um número: com quatro barras por dia, o que se quer é ver UMA.
  // A série isolada sobrevive à atualização automática e à troca de dia.
  var CH = {}, ISOLADA = {};

  function legendaIsola(nome) {
    return function (ev, item, legend) {
      var ch = legend.chart, i = item.datasetIndex;
      var so = ISOLADA[nome] === ch.data.datasets[i].label ? null : ch.data.datasets[i].label;
      ISOLADA[nome] = so;
      ch.data.datasets.forEach(function (ds, j) { ch.setDatasetVisibility(j, !so || ds.label === so); });
      ch.update();
    };
  }

  function aplicarIsolada(nome) {
    var ch = CH[nome], so = ISOLADA[nome];
    if (!ch || !so) return;
    if (!ch.data.datasets.some(function (ds) { return ds.label === so; })) { ISOLADA[nome] = null; return; }
    ch.data.datasets.forEach(function (ds, j) { ch.setDatasetVisibility(j, ds.label === so); });
    ch.update("none");
  }

  function cliqueDia(lista) {
    return {
      onClick: function (ev, els, chart) {
        var el = chart.getElementsAtEventForMode(ev, "index", { intersect: false }, false)[0];
        if (el) trocarDia(lista[el.index] === D.dia && D.dia !== D.hoje ? D.hoje : lista[el.index]);
      },
      onHover: function (ev, els) { ev.native.target.style.cursor = els.length ? "pointer" : "default"; },
    };
  }

  // O dia em foco ganha uma faixa azul-clara atrás das barras e o rótulo em
  // negrito: com 30 dias no eixo, sem isso não se sabe qual dia a tela abaixo
  // está mostrando. Faixa e não contorno: a barra tem ~3 px, e um contorno
  // de 2 px pintava a coluna inteira de escuro — o vermelho sumia.
  var faixaFoco = {
    id: "wrFaixa",
    beforeDatasetsDraw: function (ch, args, o) {
      var i = o.indice, x = ch.scales.x, n = ch.data.labels.length;
      if (i === undefined || i < 0 || !n) return;
      var w = x.width / n, cx = x.getPixelForValue(i), a = ch.chartArea;
      ch.ctx.save();
      ch.ctx.fillStyle = "rgba(44,123,229,.13)";
      ch.ctx.fillRect(cx - w / 2, a.top, w, a.bottom - a.top);
      ch.ctx.restore();
    },
  };
  function eixoX(lista) {
    return { grid: { display: false }, ticks: {
      font: function (c) { return lista[c.index] === D.dia ? { weight: "bold" } : {}; },
      color: function (c) { return lista[c.index] === D.dia ? css("--ink-d") : css("--muted"); },
    } };
  }

  // Quem fechou OS de cliente no dia em foco e não está no cadastro entra na
  // capacidade em campo pelo palpite antigo (maioria das OS em 30 dias). A
  // nota diz quem, para o admin incluir no cadastro.
  function foraNota() {
    if (!D.produtividade.tem_cadastro) return " O cadastro da equipe ainda não está no banco (migration 0023): " +
      "a capacidade em campo usa o perfil pela maioria das OS em 30 dias.";
    var f = D.produtividade.fora_cadastro || [];
    if (!f.length) return "";
    return " Em " + rotDia(D.dia) + ", " + f.length + (f.length === 1 ? " técnico fora" : " técnicos fora") +
      " do cadastro entrou pela maioria das OS em 30 dias: " + f.map(esc).join(", ") + ".";
  }

  function graficos() {
    var dias = diasGrafico();
    var verde = css("--success"), azul = css("--brand"), vermelho = css("--danger");
    // Antes do início da War Room as barras ficam esmaecidas: o "antes" é
    // contexto, o "depois" é o que se acompanha.
    function cor(c) { return dias.map(function (d) { return d < D.inicio ? c + "59" : c; }); }
    // Com um tipo de OS escolhido no cross-filter das recusas, executadas e
    // recusas viram as DAQUELE tipo. Capacidade e entradas não se recortam
    // por tipo (a esteira não chega aqui por finalidade de cliente) — o
    // rótulo da série diz o recorte.
    var PT = D.produtividade.por_tipo || {};
    function doTipo(d, i) {
      if (!REC.tipo) { var p = D.produtividade.por_dia[d]; return p ? p[i] : null; }
      var t = PT[d]; if (!t) return D.produtividade.por_dia[d] ? 0 : null;
      return (t[REC.tipo] || [0, 0])[i];
    }
    var sufixo = REC.tipo ? " · " + rotTipo(REC.tipo) : "";
    var suc = dias.map(function (d) { return doTipo(d, 0); });
    // Recusa = OS de cliente encerrada sem sucesso, a mesma da lista "OS a OS"
    // e do número "Encerradas sem sucesso" (é a palavra da mesa: "a recusa
    // passou pelo supervisor?"). Não é o "Rejeitada" do WVSA, que é a
    // validação do fechamento.
    var rec = dias.map(function (d) { return doTipo(d, 1); });
    var CAP = D.produtividade.capacidade || {};
    var cap = dias.map(function (d) { return CAP[d] ? CAP[d][0] : null; });
    var INST = D.produtividade.instalada || {};
    var inst = dias.map(function (d) { return INST[d] ? INST[d][0] : null; });
    var cinza = css("--muted-l");
    var ent = dias.map(function (d) { return D.esteira.entradas[d] === undefined ? null : D.esteira.entradas[d]; });
    var rotulos = dias.map(function (d) { return rotDia(d) + (d === D.inicio ? " ★" : ""); });
    if (CH.fluxo) CH.fluxo.destroy();
    CH.fluxo = new Chart($("wr-ch-fluxo"), {
      type: "bar",
      data: { labels: rotulos, datasets: [
        // Linha em degrau, por cima das barras: é o teto da equipe inteira,
        // e só muda quando o cadastro muda. Some sem a migration 0023.
        // Tudo em BARRAS (pedido de 24/11/2026 — a versão com capacidade e
        // entradas em linha não foi aceita, como o backlog em 19/11). Quatro
        // grupos por dia, cada um com o seu `stack`: capacidade total, em
        // campo, OS fechadas (sucesso + recusa empilhados) e entradas. O
        // gráfico ocupa a largura toda para as barras terem corpo.
        { label: "Capacidade total", data: inst, stack: "inst", backgroundColor: cor(cinza),
          maxBarThickness: 11, hidden: !D.produtividade.tem_cadastro },
        { label: "Capacidade em campo", data: cap, stack: "campo", backgroundColor: cor(css("--muted")), maxBarThickness: 11 },
        { label: "Executadas com sucesso" + sufixo, data: suc, stack: "f", backgroundColor: cor(verde),
          maxBarThickness: 11, borderColor: "#fff", borderWidth: { top: 2 }, borderRadius: 3 },
        { label: "Recusas" + sufixo, data: rec, stack: "f", backgroundColor: cor(vermelho),
          maxBarThickness: 11, borderRadius: { topLeft: 3, topRight: 3 } },
        { label: "Entraram na esteira", data: ent, stack: "ent", backgroundColor: cor(azul), maxBarThickness: 11 },
      ] },
      plugins: [faixaFoco],
      options: Object.assign({
        interaction: { mode: "index", intersect: false },
        scales: { x: Object.assign(eixoX(dias), { stacked: true }), y: { beginAtZero: true, stacked: true } },
        plugins: {
          wrFaixa: { indice: dias.indexOf(D.dia) },
          legend: { onClick: legendaIsola("fluxo"), align: "start", labels: { boxWidth: 7, boxHeight: 7, padding: 12 } },
          tooltip: { callbacks: {
            title: function (it) {
              var d = dias[it[0].dataIndex];
              return rotDia(d) + " (" + SEMANA[diaSemana(d)] + ")" + (d < D.inicio ? " — antes da War Room" : "");
            },
            afterBody: function (it) {
              var d = dias[it[0].dataIndex], c = CAP[d], i = INST[d], l = [];
              if (i) l.push("Total: " + i[1] + " externos × " + D.cap_externa + " + " + i[2] +
                " internos × " + D.cap_interna);
              if (c) l.push("Em campo: " + c[1] + " externos × " + D.cap_externa + " + " + c[2] +
                " internos × " + D.cap_interna + (c[3] ? " (" + c[3] + " fora do cadastro)" : ""));
              return l;
            },
            footer: function (it) {
              return dias[it[0].dataIndex] === D.dia ? "Dia em foco na tela" : "Clique para ver este dia";
            },
          } },
        },
      }, cliqueDia(dias)),
    });
    aplicarIsolada("fluxo");
    // Nota curta: a explicação de cada série mora no tooltip e na legenda.
    $("wr-fluxo-nota").innerHTML = "★ " + rotDia(D.inicio) + " início da War Room (antes, mais claro) · por dia: capacidade total, " +
      "em campo, OS fechadas (sucesso + recusa) e entradas · " + D.cap_interna + " OS/dia por interno, " + D.cap_externa +
      " por externo." + foraNota();

    // Em barras, como o gráfico ao lado (pedido de 19/11/2026): mesma leitura
    // de dia a dia, mesmo esmaecido antes do início.
    var bdias = Object.keys(D.esteira.backlog).sort();
    function corB(c) { return bdias.map(function (d) { return d < D.inicio ? c + "59" : c; }); }
    // Ouro e não azul-escuro: os dois azuis da casa ficam a ΔE 9 um do outro
    // (validador de paleta), difíceis de separar até com visão normal.
    var escuro = css("--ouro");
    if (CH.backlog) CH.backlog.destroy();
    CH.backlog = new Chart($("wr-ch-backlog"), {
      type: "bar",
      data: { labels: bdias.map(function (d) { return rotDia(d) + (d === D.inicio ? " ★" : ""); }), datasets: [
        { label: "Na fila", data: bdias.map(function (d) { return D.esteira.backlog[d][0]; }), backgroundColor: corB(azul), maxBarThickness: 12 },
        { label: "Não agendadas", data: bdias.map(function (d) { return D.esteira.backlog[d][1]; }), backgroundColor: corB(escuro), maxBarThickness: 12 },
      ] },
      plugins: [faixaFoco],
      options: Object.assign({ interaction: { mode: "index", intersect: false },
        scales: { x: eixoX(bdias), y: { beginAtZero: true } },
        plugins: { wrFaixa: { indice: bdias.indexOf(D.dia) }, legend: { onClick: legendaIsola("backlog"), align: "start", labels: { boxWidth: 7, boxHeight: 7, padding: 12 } },
          tooltip: { callbacks: { title: function (it) {
            var d = bdias[it[0].dataIndex];
            return rotDia(d) + " (" + SEMANA[diaSemana(d)] + ")" + (d < D.inicio ? " — antes da War Room" : "");
          } } } } }, cliqueDia(bdias)),
    });
    aplicarIsolada("backlog");

    var linhas = dias.slice().reverse().map(function (d) {
      var p = D.produtividade.por_dia[d], bk = D.esteira.backlog[d];
      var cls = (d < D.inicio ? "wr-antes " : "") + "clicavel" + (d === D.dia ? " wr-dia-foco" : "");
      return '<tr class="' + cls + '" data-dia="' + d + '" title="Clique para ver este dia"><td>' + rotDia(d) + " · " + SEMANA[diaSemana(d)].slice(0, 3) +
        "</td><td class='num'>" + (INST[d] ? num(INST[d][0]) : "—") +
        "</td><td class='num'>" + (CAP[d] ? num(CAP[d][0]) : "—") +
        "</td><td class='num'>" + (p ? num(p[0]) : "—") + "</td><td class='num'>" + (p ? num(p[1]) : "—") +
        "</td><td class='num'>" + (D.esteira.entradas[d] === undefined ? "—" : num(D.esteira.entradas[d])) +
        "</td><td class='num'>" + (bk ? num(bk[0]) : "—") + "</td><td class='num'>" + (bk ? num(bk[1]) : "—") + "</td></tr>";
    }).join("");
    $("wr-tab-dias").innerHTML = "<thead><tr><th>Dia</th><th>Capacidade total</th><th>Em campo</th><th>Executadas com sucesso</th><th>Recusas (sem sucesso)</th>" +
      "<th>Entraram na esteira</th><th>Backlog</th><th>Não agendadas</th></tr></thead><tbody>" + linhas + "</tbody>";
  }

  $("wr-tab-dias").addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-dia]");
    if (tr) trocarDia(tr.getAttribute("data-dia"));
  });

  // ---------------------------------------------------------------------
  // Triagem da esteira (migration 0025): OS DEVOLVIDAS ao dono antes de ir
  // a campo. Discreto de propósito (decisão de 25/11/2026): uma linha sob o
  // backlog e um cartão recolhido, nenhum número no topo. Não recorta por
  // supervisor — a triagem é da fila inteira, não do time de ninguém.
  // ---------------------------------------------------------------------
  var DESTINO_ROT = { N1: "N1 (suporte)", Comercial: "Comercial", Relacionamento: "Relacionamento",
    Suporte: "Suporte (fora da N1)", Infra: "Infra", "—": "Não identificado" };
  function triagem() {
    var T = D.triagem, card = $("wr-tri-card"), linha = $("wr-tri-linha");
    if (!T) { card.style.display = "none"; linha.style.display = "none"; return; }
    card.style.display = "";
    var pd = T.por_dia[D.dia] || [0, 0, 0, 0];
    var dev = pd[0], lidas = pd[0] + pd[1] + pd[2] + pd[3];
    var sai = (D.esteira.saidas || {})[D.dia] || 0;
    if (dev) {
      linha.innerHTML = "Neste dia, <b>" + num(dev) + "</b> das " + num(sai) +
        " OS que saíram da fila foram <b>devolvidas</b> ao dono na triagem: não foram a campo nem foram agendadas.";
      linha.title = "Devolvida = a OS voltou ao consultor, N1, Comercial ou Relacionamento antes da visita " +
        "(\"Rejeitando OS para o dono\" no WVSA). Não é recusa de técnico. O detalhe está no cartão Triagem da esteira, abaixo.";
      linha.style.display = "";
    } else {
      linha.style.display = "none";
    }
    $("wr-tri-cont").textContent = "· " + rotDia(D.dia) + ": " + num(dev) +
      (D.dia >= D.inicio ? " · desde " + rotDia(D.inicio) + ": " + num(T.desde.total) : "");
    $("wr-tri-nota").textContent = "OS de cliente (sem retirada e sem infra) que saíram da esteira porque foram devolvidas ao dono " +
      "(\"Rejeitando OS para o dono\" no WVSA), lidas na ficha de cada uma. Não é recusa de técnico, e vale para a fila inteira: " +
      "o supervisor escolhido nas listas abaixo não recorta. O motivo é um palpite pelo comentário de quem devolveu.";

    var SIT = {};
    T.situacoes.forEach(function (x) { SIT[x.id] = x.rotulo; });
    var porDest = {}, porSit = {}, porMot = {};
    T.lista.forEach(function (o) {
      var d = DESTINO_ROT[o.destino || "—"] || o.destino;
      porDest[d] = (porDest[d] || 0) + 1;
      var st = SIT[o.situacao] || o.situacao;
      porSit[st] = (porSit[st] || 0) + 1;
      var m = T.motivos[o.motivo] || o.motivo;
      porMot[m] = (porMot[m] || 0) + 1;
    });
    var vazio = "Nenhuma devolução em " + rotDia(D.dia) + ".";
    Dash.rank($("wr-tri-destino"), porDest, { vazio: vazio, destacarTopo: false });
    Dash.rank($("wr-tri-situacao"), porSit, { vazio: vazio, destacarTopo: false });
    Dash.rank($("wr-tri-motivo"), porMot, { vazio: vazio, destacarTopo: false, limite: 8 });

    $("wr-tri-lista").innerHTML = T.lista.length ? "<thead><tr><th>Hora</th><th>OS</th><th>Tipo</th><th>Finalidade</th>" +
      "<th>Para quem</th><th>Devolveu</th><th>Comentário</th><th>Depois</th></tr></thead><tbody>" +
      T.lista.map(function (o) {
        var depois = SIT[o.situacao] || o.situacao;
        if (o.situacao === "agendada" && o.agendada_para) depois += " · " + rotDia(o.agendada_para);
        return "<tr><td class='num'>" + esc(o.hora || "—") + "</td>" +
          '<td><a href="' + D.wvsa_os + encodeURIComponent(o.os) + '" target="_blank" rel="noopener" title="Abrir a OS no WVSA">#' + esc(o.os) + "</a></td>" +
          '<td><span class="wr-tipo-os wr-t-' + esc(o.tipo || "servicos") + '">' + esc(rotTipo(o.tipo)) + "</span></td>" +
          "<td>" + esc(o.finalidade) + "</td><td>" + esc(DESTINO_ROT[o.destino || "—"] || o.destino) + "</td>" +
          "<td>" + esc(nomeCurto(o.por)) + "</td>" +
          "<td class='wr-tri-com' title='" + esc(T.motivos[o.motivo] || "") + "'>" + esc(o.comentario || "—") + "</td>" +
          "<td>" + esc(depois) + "</td></tr>";
      }).join("") + "</tbody>" : "";

    // Conferência: o que a ficha disse de cada saída do dia. As saídas que
    // a rodada ainda não leu aparecem como tais — não somem da conta.
    var conf = "";
    if (sai || lidas) {
      conf = "Das " + num(sai) + " saídas de cliente do dia: " + num(pd[0]) + " devolvidas · " + num(pd[1]) + " agendadas · " +
        num(pd[2]) + " fechadas · " + num(pd[3]) + " outro motivo";
      if (sai > lidas) conf += " · " + num(sai - lidas) + " ainda sem leitura da ficha";
      conf += ".";
    }
    if (T.lacuna[D.dia]) {
      conf += (conf ? " " : "") + "Fora da conta, como no fluxo da esteira: " + num(T.lacuna[D.dia]) +
        " saídas notadas depois de uma lacuna de coleta, sem dia certo.";
    }
    $("wr-tri-conf").textContent = conf;
  }

  // ---------------------------------------------------------------------
  // Trocar de dia e atualizar sozinha
  // ---------------------------------------------------------------------
  var carregando = false;

  async function buscarPacote(dia) {
    var r = await fetch("/war-room/pacote?dia=" + encodeURIComponent(dia), {
      credentials: "same-origin", headers: { "Accept": "application/json" } });
    var j = null;
    try { j = await r.json(); } catch (e) { /* sessão expirada devolve HTML */ }
    if (!r.ok || !j || !j.pacote) throw new Error((j && j.erro) || (!j ? "Sua sessão expirou. Recarregue a página." : "Não foi possível carregar o dia."));
    return j.pacote;
  }

  async function trocarDia(dia) {
    if (!dia || carregando || dia > D.hoje || dia === D.dia) return;
    carregando = true;
    document.body.classList.add("wr-carregando");
    try {
      aplicar(await buscarPacote(dia));
      // A URL acompanha (link copiável e F5 no mesmo dia), sem recarregar.
      history.replaceState(null, "", location.pathname + (D.dia === D.hoje ? "" : "?dia=" + D.dia));
    } catch (err) {
      alertar(err.message);
    } finally {
      carregando = false;
      document.body.classList.remove("wr-carregando");
    }
  }

  // Redesenha tudo a partir do pacote novo. Filtros dos desvios, supervisor
  // da lista de encerradas e série isolada ficam como estavam.
  function aplicar(novo) {
    D = novo;
    $("wr-dia").value = D.dia;
    $("wr-dia").max = D.hoje;
    $("wr-hoje").hidden = D.dia === D.hoje;
    var bNovo = $("wr-novo");
    if (bNovo) bNovo.disabled = !D.tem_tabela;
    fontes();
    numeros();
    graficos();
    triagem();
    supOpcoes();
    tecnicosLista();
    semSucesso();
    desvios();
    avisoResponsavel();
    ofensores();
  }

  // De 2 em 2 min, só com a aba visível: pergunta os carimbos (duas linhas
  // pequenas) e pede o pacote só quando mudaram. Com modal aberto espera —
  // redesenhar no meio de um registro trocaria a lista sob o formulário.
  // Na virada do dia, quem estava em "hoje" passa para o dia novo.
  var POLL_MS = 120000;
  // Mexer na lista e a lista mudar sob o mouse é como a resposta cai na
  // linha do lado (24/11/2026: o Sim/Não da #596787 foi parar na #603974,
  // 2 s depois do desvio). Com interação nos últimos 30 s, a atualização
  // espera; uma nova tentativa sai 15 s depois.
  var ultimaInteracao = 0, ESPERA_INTERACAO = 30000, retentativa = null;
  ["click", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      if (e.target.closest && e.target.closest(".main")) ultimaInteracao = Date.now();
    }, true);
  });
  function tentarDeNovo() {
    clearTimeout(retentativa);
    retentativa = setTimeout(conferirNovidade, 15000);
  }

  async function conferirNovidade() {
    if (document.hidden || carregando || document.querySelector("dialog[open]")) return;
    if (gravando || Date.now() - ultimaInteracao < ESPERA_INTERACAO) { tentarDeNovo(); return; }
    var meu = false;
    try {
      var r = await fetch("/war-room/versao", { credentials: "same-origin", headers: { "Accept": "application/json" } });
      var j = await r.json();
      var emHoje = D.dia === D.hoje;
      var virou = emHoje && new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10) !== D.hoje;
      if ((j.versao === D.versao && !virou) || carregando) return;   // trocou de dia enquanto perguntava
      carregando = meu = true;
      var inicio = Date.now();
      var novo = await buscarPacote(emHoje ? (virou ? "" : D.dia) : D.dia);
      if (document.querySelector("dialog[open]")) { tentarDeNovo(); return; }   // abriu um modal enquanto buscava
      // Gravou (ou está gravando) depois que o pacote começou a ser lido:
      // ele pode não ter a gravação. Descarta e lê de novo daqui a pouco.
      if (gravando || ultimaEscrita >= inicio || ultimaInteracao >= inicio) { tentarDeNovo(); return; }
      aplicar(novo);
    } catch (e) {
      /* rede caiu ou sessão expirou: tenta de novo no próximo ciclo, calado */
    } finally {
      if (meu) carregando = false;
    }
  }
  setInterval(conferirNovidade, POLL_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) conferirNovidade(); });

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
  // Toda gravação passa por aqui e deixa marca: a atualização automática
  // NÃO pode aplicar um pacote lido antes (ou durante) uma gravação. Foi o
  // defeito de 24/11/2026: o pacote leva 1–3 s; se o supervisor respondia
  // Sim/Não ou registrava um desvio nesse meio-tempo, a gravação chegava ao
  // banco, mas o pacote velho redesenhava a tela por cima — a resposta
  // "sumia", e ele refazia (o desvio da #603311 saiu duas vezes, 50 s
  // depois). Voltar para a aba depois de abrir a OS no WVSA dispara a
  // atualização, então era o fluxo normal da mesa.
  var gravando = 0, ultimaEscrita = 0;
  async function postJSON(url, corpo) {
    gravando++;
    try { return await postJSONcru(url, corpo); }
    finally { gravando--; ultimaEscrita = Date.now(); }
  }
  async function postJSONcru(url, corpo) {
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
    if (!$("wr-rotina")) return;          // só supervisor recebe o cartão
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

  if ($("wr-rotina")) $("wr-rotina").addEventListener("click", async function (e) {
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
  // A barra própria dos desvios (pedido de 24/11/2026): supervisor, técnico,
  // OS, momento, status, quem registrou e busca. Tipo, causa e responsável
  // entram pelo clique nos rankings e viram chip; técnico também, e o select
  // acompanha. Tudo recorta KPIs, rankings, lista e CSV.
  var F = { periodo: "dia", status: "", busca: "", os: "", sup: "", mom: "", por: "",
            tipo: null, causa: null, resp: null, tec: null };
  var SUP = !!window.__WR_SUP__;
  var temBarra = !!$("wr-d-filtros");

  // Supervisor do desvio = quem responde pelo técnico (`sups`, calculado no
  // servidor pela mesma regra das encerradas) OU quem o registrou: desvio
  // sem técnico — daily atrasada, rota — é do supervisor que o anotou.
  // O desvio recém-registrado volta do POST sem `sups`; vem do mapa.
  function supsDoDesvio(d) {
    if (!d.sups) d.sups = (D.tec_sups || {})[d.tecnico] || [];
    return d.sups;
  }
  function doSupervisor(d, id) { return supsDoDesvio(d).indexOf(id) >= 0 || d.registrado_por === id; }

  function noPeriodo(d) { return F.periodo === "tudo" || d.dia === D.dia; }
  function passa(d, exceto) {
    if (!noPeriodo(d)) return false;
    if (F.status === "anulado") { if (!d.anulado) return false; }
    else if (d.anulado) return false;
    else if (F.status && d.status !== F.status) return false;
    if (F.sup && !doSupervisor(d, F.sup)) return false;
    if (F.os && !(d.os || []).some(function (o) { return String(o).indexOf(F.os) >= 0; })) return false;
    if (F.mom && d.momento !== F.mom) return false;
    if (F.por && d.registrado_por !== F.por) return false;
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
  function filtrando() {
    return !!(F.status || F.busca || F.os || F.sup || F.mom || F.por || F.tipo || F.causa || F.resp || F.tec);
  }

  function contar(campo, fn) {
    var c = {};
    D.desvios.forEach(function (d) { if (passa(d, campo)) { var k = fn(d); c[k] = (c[k] || 0) + 1; } });
    return c;
  }

  function rankings() {
    var vazio = filtrando() ? "Nenhum desvio neste filtro."
      : F.periodo === "dia" ? "Nenhum desvio registrado em " + rotDia(D.dia) + "." : "Nenhum desvio registrado.";
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

  // Opções dos selects da barra. Técnico e "Registrou" são os que aparecem
  // nos desvios do período (oferecer quem não tem desvio leva a uma lista
  // vazia sem explicação); o escolhido continua na lista mesmo se sumir.
  // O HTML só é trocado quando as opções mudam: com o select aberto, trocar
  // o nó a cada redesenho fecha a lista sob o dedo (§6, chips).
  function opcoesSelect(sel, pares, atual) {
    var html = '<option value="">Todos</option>' + pares.map(function (p) {
      return '<option value="' + esc(p[0]) + '">' + esc(p[1]) + "</option>"; }).join("");
    if (sel._html !== html) { sel.innerHTML = html; sel._html = html; }
    sel.value = atual || "";
  }
  function barra() {
    if (!temBarra) return;
    var tecs = {}, pors = {};
    D.desvios.forEach(function (d) {
      if (!noPeriodo(d)) return;
      tecs[d.tecnico || "(sem técnico)"] = 1;
      if (d.registrado_por) pors[d.registrado_por] = d.por || "—";
    });
    if (F.tec) tecs[F.tec] = 1;
    var porNome = {};
    (D.supervisores || []).forEach(function (x) { porNome[x.id] = x.nome; });
    if (F.por && !pors[F.por]) pors[F.por] = porNome[F.por] || "—";
    opcoesSelect($("wr-d-sup"), (D.supervisores || []).map(function (x) { return [x.id, x.nome]; })
      .sort(function (a, b) { return a[1].localeCompare(b[1], "pt-BR"); }), F.sup);
    opcoesSelect($("wr-d-tec"), Object.keys(tecs).sort(function (a, b) {
      // "(sem técnico)" por último: é exceção, não nome.
      return (a[0] === "(") - (b[0] === "(") || a.localeCompare(b, "pt-BR"); })
      .map(function (t) { return [t, t]; }), F.tec);
    opcoesSelect($("wr-d-mom"), CAT.momentos.map(function (m) { return [m.id, m.rotulo]; }), F.mom);
    opcoesSelect($("wr-d-por"), Object.keys(pors).map(function (id) { return [id, pors[id]]; })
      .sort(function (a, b) { return a[1].localeCompare(b[1], "pt-BR"); }), F.por);
    // O que veio do clique nos rankings, com × para tirar.
    var chips = [["tipo", "Tipo"], ["causa", "Causa"], ["resp", "Responsável"]].filter(function (c) { return F[c[0]]; });
    var el = $("wr-d-chips");
    el.hidden = !chips.length;
    el.innerHTML = chips.map(function (c) {
      return '<span class="chip">' + c[1] + ": " + esc(F[c[0]]) +
        ' <button type="button" data-tira="' + c[0] + '" aria-label="Tirar o filtro de ' + c[1].toLowerCase() + '">×</button></span>';
    }).join("");
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
    var doPeriodo = filtrando() ? D.desvios.filter(function (d) { return noPeriodo(d) && !d.anulado; }).length : null;
    $("wr-contagem").textContent = "· " + num(lista.length) + (tudo ? " desde " + rotDia(D.inicio) : " em " + rotDia(D.dia)) +
      (doPeriodo !== null && F.status !== "anulado" && doPeriodo !== lista.length ? " (de " + num(doPeriodo) + ")" : "");
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
    if (!D.tem_tabela || !temBarra) { rotina(); return; }
    var lista = filtrados();
    barra();
    rankings();
    kpis(lista);
    tabela(lista);
    rotina();
  }

  // Filtros
  $("wr-dia").addEventListener("change", function () { if (this.value) trocarDia(this.value); });
  $("wr-hoje").addEventListener("click", function () { trocarDia(D.hoje); });
  if (temBarra) {
    // O supervisor abre a barra já no próprio time, como a lista de
    // encerradas: é o desvio do time dele que ele acompanha.
    if (SUP && (D.supervisores || []).some(function (s) { return s.id === EU; })) F.sup = EU;
    $("wr-periodo").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-p]");
      if (!b) return;
      F.periodo = b.getAttribute("data-p");
      this.querySelectorAll("button").forEach(function (x) { x.classList.toggle("active", x === b); });
      desvios();
    });
    [["wr-status", "status"], ["wr-d-sup", "sup"], ["wr-d-mom", "mom"], ["wr-d-por", "por"]].forEach(function (c) {
      $(c[0]).addEventListener("change", function () { F[c[1]] = this.value; desvios(); });
    });
    $("wr-d-tec").addEventListener("change", function () { F.tec = this.value || null; desvios(); });
    // Só dígitos: "#586420" colado da lista vira 586420.
    $("wr-d-os").addEventListener("input", function () { F.os = this.value.replace(/\D/g, ""); desvios(); });
    $("wr-busca").addEventListener("input", function () { F.busca = this.value.trim().toLowerCase(); desvios(); });
    $("wr-d-chips").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-tira]");
      if (b) { F[b.getAttribute("data-tira")] = null; desvios(); }
    });
    // Limpar devolve o supervisor a "Todos" também: é o "ver tudo" da mesa.
    $("wr-limpar").addEventListener("click", function () {
      F.status = F.busca = F.os = F.sup = F.mom = F.por = "";
      F.tipo = F.causa = F.resp = F.tec = null;
      $("wr-busca").value = ""; $("wr-d-os").value = ""; $("wr-status").value = "";
      desvios();
    });
  }

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
  // OS a OS. O supervisor diz se a recusa passou por ele (Sim/Não) e
  // registra o desvio dali mesmo, com o formulário já preenchido.
  var ssSup = $("wr-ss-sup");
  function supOpcoes() {
    var atual = ssSup.value;
    ssSup.innerHTML = '<option value="">Todos</option>' + (D.supervisores || []).map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.nome) + "</option>"; }).join("");
    ssSup.value = atual;
    if (ssSup.value !== atual) ssSup.value = "";
  }
  supOpcoes();
  // O supervisor abre a tela já no próprio time: são as OS dele que ele valida.
  if (SUP && (D.supervisores || []).some(function (s) { return s.id === EU; })) ssSup.value = EU;
  ssSup.addEventListener("change", semSucesso);

  // Ordenação da lista OS a OS. Começa pela hora (a ordem do dia, a mesma
  // do servidor) e sobrevive a cada redesenho — validar uma linha não pode
  // devolver a lista à ordem de partida. Empate desempata pela hora.
  var SS_ORD = { col: "hora", dir: 1 };
  var SS_COLS = [["hora", "Hora"], ["os", "OS"], ["tecnico", "Técnico"], ["sup", "Supervisor"],
    ["tipo", "Tipo"], ["finalidade", "Finalidade"], ["motivo", "Motivo registrado no fechamento"],
    ["validada", "Validada com o supervisor?"]];
  var supNome = {};
  function nomeCurto(n) { return (n || "—").split(" ")[0]; }
  function supsDe(o) { return (o.sups || []).map(function (id) { return supNome[id] || "—"; }); }
  function chaveSS(o, col) {
    switch (col) {
      // "Sem resposta" primeiro: é o que falta o supervisor olhar. Sem
      // número de OS não há como validar, então vai para o fim.
      case "validada":
        if (!o.os) return 3;
        var v = (D.validacoes || {})[o.os];
        return v ? (v.validado ? 2 : 1) : 0;
      case "os": return o.os ? +o.os : Infinity;
      case "hora": return o.hora || "99:99";
      // Técnico sem supervisor vai para o fim no ▲: é exceção, não começo.
      case "sup": return supsDe(o).join(", ").toLowerCase() || "\uffff";
      case "tipo": return rotTipo(o.tipo).toLowerCase();
      default: return String(o[col] || "").toLowerCase();
    }
  }
  function ordenarSS(lista) {
    return lista.slice().sort(function (a, b) {
      var x = chaveSS(a, SS_ORD.col), y = chaveSS(b, SS_ORD.col);
      var c = (x < y ? -1 : x > y ? 1 : 0) * SS_ORD.dir;
      if (c) return c;
      x = chaveSS(a, "hora"); y = chaveSS(b, "hora");
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  // A recusa que a ficha mudou de dia pode ter o desvio registrado no dia do
  // relatório (`dia_rel`), antes de a ficha ser lida.
  function temDesvio(os, diaRel) {
    return D.desvios.some(function (d) {
      return !d.anulado && (d.dia === D.dia || (diaRel && d.dia === diaRel)) && (d.os || []).indexOf(os) >= 0;
    });
  }

  function passaRec(o, exceto) {
    if (exceto !== "tipo" && REC.tipo && o.tipo !== REC.tipo) return false;
    if (exceto !== "motivo" && REC.motivo && (o.motivo || "Não informado") !== REC.motivo) return false;
    return true;
  }

  // Tipos: recusas e TAXA de recusa (recusas ÷ OS do tipo no dia). A taxa
  // usa o total do dia inteiro (`por_tipo`), que não conhece supervisor: com
  // o filtro de supervisor ela sairia com numerador do time e denominador da
  // operação, então some — e a nota diz por quê. Cada contagem aplica o
  // filtro do OUTRO campo, não o próprio (o cross-filter do Dashboard).
  function recusasPorTipo(doSup, filtroSup) {
    var porTipo = {}, porMotivo = {};
    doSup.forEach(function (o) {
      if (passaRec(o, "tipo")) porTipo[o.tipo] = (porTipo[o.tipo] || 0) + 1;
      if (passaRec(o, "motivo")) { var m = o.motivo || "Não informado"; porMotivo[m] = (porMotivo[m] || 0) + 1; }
    });
    var tot = (D.produtividade.por_tipo || {})[D.dia] || {};
    var comTaxa = !filtroSup;
    var linhas = (CAT.tipos_os || []).map(function (t) {
      var n = porTipo[t.id] || 0, os = tot[t.id] ? tot[t.id][0] + tot[t.id][1] : 0;
      return { id: t.id, rotulo: t.rotulo, n: n, os: os };
    });
    var totRec = linhas.reduce(function (x, l) { return x + l.n; }, 0) || 1;
    var el = $("wr-rank-tipo-os");
    el.innerHTML = linhas.map(function (l) {
      var sel = REC.tipo ? (REC.tipo === l.id ? " selecionado" : " apagado") : "";
      var taxa = comTaxa && l.os ? Math.round(100 * l.n / l.os) : null;
      var tit = l.rotulo + ": " + num(l.n) + (l.n === 1 ? " recusa" : " recusas") +
        (comTaxa && l.os ? " em " + num(l.os) + " OS do tipo no dia" : "") +
        (REC.tipo === l.id ? " · clique para desfazer" : " · clique para filtrar");
      return '<button type="button" class="wr-tcard wr-t-' + l.id + sel + '" data-tipo="' + l.id + '" title="' + esc(tit) + '">' +
        '<span class="wr-tcard-r">' + esc(l.rotulo) + "</span>" +
        '<span class="wr-tcard-n">' + num(l.n) + '<small>' + (l.n === 1 ? "recusa" : "recusas") + "</small></span>" +
        '<span class="wr-tcard-b"><i style="width:' + (100 * l.n / totRec).toFixed(1) + '%"></i></span>' +
        '<span class="wr-tcard-p">' + (taxa !== null ? "<b>" + taxa + "%</b> de recusa · " + num(l.os) + " OS" :
          Math.round(100 * l.n / totRec) + "% das recusas") + "</span></button>";
    }).join("");
    Dash.rank($("wr-rank-motivo"), porMotivo, {
      limite: 10, selecionado: REC.motivo,
      vazio: "Nenhuma recusa " + (REC.tipo ? "de " + rotTipo(REC.tipo) + " " : "") + "em " + rotDia(D.dia) + ".",
      aoClicar: function (rotulo) { REC.motivo = REC.motivo === rotulo ? null : rotulo; recorteRec(); },
    });
    $("wr-rec-sub").textContent = rotDia(D.dia) + (filtroSup ? " · time de " + nomeCurto(supNome[filtroSup]) : " · operação inteira") + " · clique num tipo para filtrar";
    $("wr-rec-nota").textContent = comTaxa
      ? "Nos cartões, a taxa de recusa de cada tipo no dia (recusas ÷ OS de cliente daquele tipo). Tipo recorta motivos, lista e gráfico; motivo recorta tipos e lista."
      : "Com supervisor escolhido, a taxa de recusa some: o total de OS do dia não é separado por time.";
    var chips = [];
    if (REC.tipo) chips.push(["tipo", "Tipo: " + rotTipo(REC.tipo)]);
    if (REC.motivo) chips.push(["motivo", "Motivo: " + REC.motivo]);
    var c = $("wr-rec-chips");
    c.style.display = chips.length ? "" : "none";   // `hidden` perde para o display:flex de .chips (§6)
    c.innerHTML = chips.map(function (x) {
      return '<span class="chip">' + esc(x[1]) + ' <button type="button" data-rec="' + x[0] + '" aria-label="Tirar filtro">×</button></span>';
    }).join("") + (chips.length ? '<button type="button" class="btn-ghost" data-rec="tudo">Limpar recorte das recusas</button>' : "");
  }

  // Tipo também recorta o gráfico; motivo, só os blocos e a lista (o
  // gráfico não tem motivo por dia).
  function recorteRec(mudouTipo) {
    semSucesso();
    if (mudouTipo) graficos();
  }
  $("wr-rank-tipo-os").addEventListener("click", function (e) {
    var l = e.target.closest("[data-tipo]");
    if (!l) return;
    var t = l.getAttribute("data-tipo");
    REC.tipo = REC.tipo === t ? null : t;
    recorteRec(true);
  });
  $("wr-rec-chips").addEventListener("click", function (e) {
    var b = e.target.closest("[data-rec]");
    if (!b) return;
    var k = b.getAttribute("data-rec"), tinhaTipo = !!REC.tipo;
    if (k === "tudo") { REC.tipo = null; REC.motivo = null; } else REC[k] = null;
    recorteRec(tinhaTipo && !REC.tipo);
  });

  // Ordem da última lista desenhada (índices em `sem_sucesso`). Responder
  // uma linha redesenha mantendo essa ordem: com a lista ordenada por
  // "Validada", a linha respondida saltava para baixo e a de baixo subia
  // para o lugar dela, sob o mouse. A ordem só muda no clique do cabeçalho,
  // no filtro ou com dados novos.
  var ORDEM_SS = null;
  function semSucesso(manterOrdem) {
    var filtro = ssSup.value;
    supNome = {};
    (D.supervisores || []).forEach(function (x) { supNome[x.id] = x.nome; });
    var doSup = D.produtividade.sem_sucesso.filter(function (o) { return !filtro || (o.sups || []).indexOf(filtro) >= 0; });
    recusasPorTipo(doSup, filtro);
    var lista = doSup.filter(function (o) { return passaRec(o); });
    var V = D.validacoes || {};
    var sim = 0, nao = 0, semNum = 0;
    lista.forEach(function (o) {
      if (!o.os) { semNum++; return; }
      var v = V[o.os];
      if (v && v.validado) sim++; else if (v) nao++;
    });
    var aResponder = lista.length - sim - nao - semNum;
    $("wr-ss-contagem").textContent = "· " + num(lista.length) + " em " + rotDia(D.dia) +
      (filtro || REC.tipo || REC.motivo ? " (de " + num(D.produtividade.sem_sucesso.length) + ")" : "");
    var nota = [];
    if (D.validacoes === null) nota.push("A validação ainda não tem a tabela no banco (migration 0022).");
    else nota.push(num(sim) + " validadas com o supervisor · " + num(nao) + " não validadas · " + num(aResponder) + " sem resposta");
    if (semNum) nota.push(num(semNum) + " sem número de OS (coleta anterior à atualização do coletor) — sem link e sem validação");
    if (!SUP) nota.push("só supervisor responde a validação");
    $("wr-ss-nota").textContent = nota.join(" · ") + ".";
    if (!lista.length) {
      $("wr-ss").innerHTML = '<tbody><tr><td class="vazio-celula">' + (REC.tipo || REC.motivo
        ? "Nenhuma recusa neste recorte de tipo e motivo em " + rotDia(D.dia) + "."
        : filtro
        ? "Nenhuma OS do time deste supervisor encerrada sem sucesso em " + rotDia(D.dia) + "."
        : "Nenhuma OS de cliente encerrada sem sucesso em " + rotDia(D.dia) + " até a última coleta da Produtividade.") +
        "</td></tr></tbody>";
      return;
    }
    var podeValidar = SUP && D.validacoes !== null;
    $("wr-ss").innerHTML = "<thead><tr>" + SS_COLS.map(function (c) {
        var cls = c[0] === SS_ORD.col ? (SS_ORD.dir > 0 ? "ord-asc" : "ord-desc") : "";
        var tit = c[0] === "hora" ? "Hora em que o técnico fechou a OS sem sucesso"
          : c[0] === "validada" ? "Clique para ver primeiro as sem resposta" : "Ordenar";
        return '<th data-ord="' + c[0] + '" class="' + cls + '" title="' + tit + '">' + c[1] + "</th>";
      }).join("") + "<th></th></tr></thead><tbody>" +
      (function () {
        var ord;
        if (manterOrdem && ORDEM_SS) {
          var pos = {}; ORDEM_SS.forEach(function (i, k) { pos[i] = k; });
          ord = lista.slice().sort(function (a, b) {
            var x = pos[D.produtividade.sem_sucesso.indexOf(a)], y = pos[D.produtividade.sem_sucesso.indexOf(b)];
            return (x === undefined ? 1e9 : x) - (y === undefined ? 1e9 : y);
          });
        } else ord = ordenarSS(lista);
        ORDEM_SS = ord.map(function (o) { return D.produtividade.sem_sucesso.indexOf(o); });
        return ord;
      })().map(function (o) {
        var idx = D.produtividade.sem_sucesso.indexOf(o);
        var v = o.os ? V[o.os] : null;
        var celV;
        if (!o.os) celV = '<span class="subnote" style="margin:0">—</span>';
        else if (podeValidar) {
          var est = v ? (v.validado ? "sim" : "nao") : "";
          celV = '<span class="toggle toggle-mini wr-valida" data-os="' + esc(o.os) + '">' +
            '<button type="button" data-v="sim" class="' + (est === "sim" ? "active" : "") + '">Sim</button>' +
            '<button type="button" data-v="nao" class="' + (est === "nao" ? "active wr-nao" : "") + '">Não</button></span>' +
            (v ? '<span class="subnote wr-quem">' + esc(v.nome.split(" ")[0]) + " " + esc(v.hora || "") +
              ' · <button type="button" class="wr-desfazer" data-os="' + esc(o.os) + '" title="Apagar a resposta (volta a sem resposta)">desfazer</button></span>' : "");
        } else {
          celV = v ? '<span class="badge ' + (v.validado ? "badge-verde" : "badge-vermelho") + '">' + (v.validado ? "sim" : "não") +
            "</span> <span class='subnote wr-quem'>" + esc(v.nome.split(" ")[0]) + " " + esc(v.hora || "") + "</span>"
            : '<span class="badge badge-cinza">sem resposta</span>';
        }
        var feito = o.os && temDesvio(o.os, o.dia_rel);
        return "<tr>" +
          // Hora da ficha quando ela discordou do relatório; o relatório vai
          // embaixo, porque é ele que aparece na Produtividade e no WVSA.
          "<td>" + esc(o.hora || "—") + (o.hora_rel
            ? ' <span class="subnote wr-emp" title="O relatório da Produtividade do WVSA traz ' + esc(o.hora_rel) +
              '. A hora ao lado é a da ficha da OS (fechada sem sucesso pelo técnico).">relatório ' + esc(o.hora_rel) + "</span>"
            : "") + "</td>" +
          "<td>" + (o.os ? '<a href="' + D.wvsa_os + encodeURIComponent(o.os) + '" target="_blank" rel="noopener" title="Abrir a OS no WVSA">#' + esc(o.os) + "</a>" : "—") + "</td>" +
          "<td>" + esc(o.tecnico || "—") + (o.empresa ? ' <span class="subnote wr-emp">' + esc(o.empresa) + "</span>" : "") + "</td>" +
          "<td>" + (supsDe(o).length
            ? supsDe(o).map(function (n) { return '<span title="' + esc(n) + '">' + esc(nomeCurto(n)) + "</span>"; }).join(", ")
            : '<span class="subnote" style="margin:0" title="Nenhum supervisor tem a equipe ou o técnico em Configurações">sem supervisor</span>') + "</td>" +
          '<td><span class="wr-tipo-os wr-t-' + esc(o.tipo || "servicos") + '">' + esc(rotTipo(o.tipo)) + "</span></td>" +
          "<td>" + esc(o.finalidade || "") + "</td>" +
          "<td>" + esc(o.motivo || "") + "</td>" +
          "<td>" + celV + "</td>" +
          "<td>" + (D.tem_tabela ? '<button type="button" class="btn-ghost wr-reg' + (feito ? " wr-reg-feito" : "") + '" data-idx="' + idx + '">' +
            (feito ? "✓ Desvio registrado" : "Registrar desvio") + "</button>" : "") + "</td></tr>";
      }).join("") + "</tbody>";
  }

  $("wr-ss").addEventListener("click", async function (e) {
    var th = e.target.closest("th[data-ord]");
    if (th) {
      var col = th.getAttribute("data-ord");
      if (SS_ORD.col === col) SS_ORD.dir *= -1; else { SS_ORD.col = col; SS_ORD.dir = 1; }
      semSucesso();
      return;
    }
    var reg = e.target.closest("button.wr-reg");
    if (reg) { abrirRegistro(false, D.produtividade.sem_sucesso[+reg.getAttribute("data-idx")]); return; }
    var desf = e.target.closest("button.wr-desfazer");
    if (desf) { await validar(desf.getAttribute("data-os"), null, null); return; }
    var b = e.target.closest(".wr-valida button[data-v]");
    if (!b || b.disabled) return;
    var os = b.parentNode.getAttribute("data-os");
    var atual = (D.validacoes || {})[os];
    var quer = b.getAttribute("data-v") === "sim";
    // Clicar de novo na resposta já marcada NÃO desfaz mais (24/11/2026): um
    // segundo clique — porque a tela demorou, ou um duplo clique — apagava a
    // resposta em silêncio, e a OS voltava a "sem resposta". Desfazer agora
    // é o "desfazer" explícito ao lado de quem respondeu.
    if (atual && atual.validado === quer) return;
    await validar(os, quer, b.parentNode);
  });

  async function validar(os, valor, caixa) {
    if (caixa) caixa.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
    try {
      // Desfazer apaga onde a resposta mora: a da recusa que mudou de dia
      // pode estar gravada no dia do relatório.
      var atualV = (D.validacoes || {})[os];
      var dia = valor === null && atualV && atualV.dia ? atualV.dia : D.dia;
      var r = await postJSON("/war-room/validacoes", { dia: dia, os: os, validado: valor });
      if (r.validacao) D.validacoes[os] = r.validacao; else delete D.validacoes[os];
      semSucesso(true);
    } catch (err) {
      if (caixa) caixa.querySelectorAll("button").forEach(function (x) { x.disabled = false; });
      alertar(err.message);
    }
  }

  // ---------------------------------------------------------------------
  // Registrar
  // ---------------------------------------------------------------------
  var dlg = $("wr-dlg"), form = $("wr-form");
  var tecEmpresa = {};
  function tecnicosLista() {
    tecEmpresa = {};
    D.produtividade.tecnicos.forEach(function (t) { tecEmpresa[t[0]] = t[1]; });
    $("wr-tecnicos").innerHTML = D.produtividade.tecnicos.map(function (t) {
      return '<option value="' + esc(t[0]) + '">' + esc(t[1]) + "</option>";
    }).join("");
  }
  tecnicosLista();

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

  // `pre`: uma encerrada sem sucesso da lista — o formulário já nasce com o
  // momento, o técnico, a OS, o tipo pela validação e a causa pelo motivo
  // (palpite do servidor, `war_room.causa_do_motivo`). O supervisor confere.
  function abrirRegistro(manterMomento, pre) {
    var mom = pre ? "encerramento" : (manterMomento ? $("wr-f-momento").value : "");
    form.reset();
    $("wr-f-momento").value = mom;
    toggleStatus("wr-f-status", "resolvido");
    tiposDoMomento();
    if (pre) {
      var v = pre.os ? (D.validacoes || {})[pre.os] : null;
      $("wr-f-tipo").value = v ? (v.validado ? "encerr_validado" : "encerr_sem_validacao") : "";
      $("wr-f-tecnico").value = pre.tecnico || "";
      $("wr-f-os").value = pre.os || "";
      $("wr-f-causa").value = pre.causa || "";
      $("wr-f-detalhe").value = pre.causa ? "" : (pre.motivo || "").slice(0, 500);
      camposCondicionais();
    }
    erro("wr-form-erro");
    $("wr-form-dia").textContent = "Desvio de " + rotDia(D.dia) + (D.dia === D.hoje ? " (hoje)" : "") + ".";
    if (!dlg.open) dlg.showModal();
    (pre ? ($("wr-f-tipo").value ? $("wr-f-resp") : $("wr-f-tipo")) : (mom ? $("wr-f-tipo") : $("wr-f-momento"))).focus();
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
      semSucesso(true);
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
    // O POST devolve o desvio sem `sups`: o vínculo calculado no pacote fica.
    for (var i = 0; i < D.desvios.length; i++) if (D.desvios[i].id === novoD.id) {
      if (!novoD.sups) novoD.sups = D.desvios[i].sups;
      D.desvios[i] = novoD;
    }
    desvios();
    semSucesso(true);
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
  // Técnico sem responsável (pedido de 25/11/2026)
  // ---------------------------------------------------------------------
  // Fechou OS de cliente nos últimos 14 dias e não está no time de nenhum
  // supervisor — na prática, técnico novo da UNETVALE (o de empresa
  // terceira cai sozinho no supervisor da empresa). O aviso abre para todo
  // supervisor; o primeiro que responde decide para todos (trava do banco),
  // e os outros recebem quem decidiu. "Depois" adia só nesta aba.
  var CHAVE_ADIADO = "wr-resp-adiado";
  function adiados() {
    try { return JSON.parse(sessionStorage.getItem(CHAVE_ADIADO) || "[]"); } catch (e) { return []; }
  }
  function avisoResponsavel() {
    var dlg = $("wr-dlg-resp");
    if (!dlg || !SUP) return;
    var ad = adiados();
    var lista = (D.sem_responsavel || []).filter(function (p) { return ad.indexOf(p.rotulo) < 0; });
    if (!lista.length) { if (dlg.open) dlg.close(); return; }
    var opcoes = '<option value="">Escolha…</option>' + (D.supervisores || []).map(function (x) {
      return '<option value="' + x.id + '">' + esc(x.nome) + "</option>";
    }).join("") + '<option value="nenhum">Não é técnico de campo</option>';
    $("wr-resp-lista").innerHTML = lista.map(function (p) {
      return '<tr><td><b>' + esc(p.nome) + '</b><span class="subnote wr-emp">' + esc(p.empresa) +
        (p.cadastro ? " · no cadastro" : "") + "</span></td>" +
        '<td class="num">' + num(p.os) + '</td><td>' + rotDia(p.ultimo) + "</td>" +
        '<td><span class="wr-resp-acao"><select aria-label="Responsável por ' + esc(p.nome) + '">' + opcoes + "</select>" +
        '<button type="button" class="btn" data-resp="' + esc(p.rotulo) + '">Definir</button></span></td></tr>';
    }).join("");
    $("wr-resp-erro").hidden = true;
    if (!dlg.open && !document.querySelector("dialog[open]")) dlg.showModal();
  }
  if ($("wr-dlg-resp")) {
    $("wr-resp-lista").addEventListener("click", async function (e) {
      var b = e.target.closest("[data-resp]");
      if (!b || b.disabled) return;
      var sel = b.parentNode.querySelector("select");
      if (!sel.value) { erro("wr-resp-erro", "Escolha o supervisor (ou “não é técnico de campo”)."); return; }
      var rotulo = b.getAttribute("data-resp");
      b.disabled = true;
      var msg;
      try {
        await postJSON("/war-room/responsavel", { rotulo: rotulo, supervisor_id: sel.value === "nenhum" ? null : sel.value });
        msg = "Responsável definido.";
      } catch (err) {
        // 409: outro supervisor respondeu antes — a linha sai do mesmo jeito.
        if (!/já respondeu/.test(err.message)) { b.disabled = false; erro("wr-resp-erro", err.message); return; }
        msg = err.message;
      }
      D.sem_responsavel = (D.sem_responsavel || []).filter(function (p) { return p.rotulo !== rotulo; });
      alertar(msg);
      avisoResponsavel();
      // O técnico passou a ser de alguém: a capacidade por supervisor muda.
      try { aplicar(await buscarPacote(D.dia)); } catch (err) { /* atualiza no próximo ciclo */ }
    });
    $("wr-dlg-resp").querySelector("[data-adiar]").addEventListener("click", function () {
      var ad = adiados();
      (D.sem_responsavel || []).forEach(function (p) { if (ad.indexOf(p.rotulo) < 0) ad.push(p.rotulo); });
      try { sessionStorage.setItem(CHAVE_ADIADO, JSON.stringify(ad)); } catch (e) { /* aba privada */ }
      $("wr-dlg-resp").close();
    });
  }

  // ---------------------------------------------------------------------
  fontes();
  numeros();
  graficos();
  triagem();
  semSucesso();
  desvios();
  avisoResponsavel();
  ofensores();
})();
