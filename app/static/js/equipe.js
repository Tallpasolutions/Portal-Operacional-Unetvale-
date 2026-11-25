// Equipe técnica: a planilha "Equipe técnica" dentro do portal.
//
// Tudo sai de window.__EQ__ (app/equipe.py). O filtro do topo é do cliente
// e vale para a página inteira. O admin edita no lugar: Sim/Não por clique,
// supervisor pelo select da linha, o resto pelo modal (clique no nome). Cada
// gravação volta o técnico do servidor e a tela se redesenha sem recarregar.
(function () {
  "use strict";

  var D = window.__EQ__;
  var ADMIN = !!window.__EQ_ADMIN__;
  if (!D || !D.tem_tabela) return;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(n) { return Number(n || 0).toLocaleString("pt-BR"); }
  function norma(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function rotDia(iso) { return iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : "—"; }
  function iniciais(nome) {
    var p = String(nome || "").trim().split(/\s+/);
    return ((p[0] || "")[0] || "").toUpperCase() + (p.length > 1 ? (p[p.length - 1][0] || "").toUpperCase() : "");
  }

  // A cor do supervisor é a POSIÇÃO dele na lista por nome — a mesma pessoa,
  // a mesma cor, na tabela e no PDF.
  var SUP = {};
  D.supervisores.forEach(function (s, i) { SUP[s.id] = { nome: s.nome, cor: i % 6 }; });
  function primeiro(nome) { return String(nome || "").split(" ")[0]; }

  var F = { busca: "", sup: "", emp: "", inativos: false };

  function passa(t) {
    if (!F.inativos && !t.ativo) return false;
    var ids = t.supervisores || (t.supervisor_id ? [t.supervisor_id] : []);
    if (F.sup === "-" && ids.length) return false;
    if (F.sup && F.sup !== "-" && ids.indexOf(F.sup) < 0) return false;
    if (F.emp && t.empresa !== F.emp) return false;
    if (F.busca) {
      var alvo = norma([t.nome, t.nome_wvsa, t.empresa, t.cidades].join(" "));
      if (alvo.indexOf(norma(F.busca)) < 0) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // KPIs — os da planilha, mais a capacidade total
  // ---------------------------------------------------------------------
  function kpis(lista) {
    var ativos = lista.filter(function (t) { return t.ativo; });
    var internos = ativos.filter(function (t) { return t.interno; }).length;
    var externos = ativos.length - internos;
    var cap = internos * D.cap_interna + externos * D.cap_externa;
    var wr = ativos.filter(function (t) { return !t.retirada; });
    var wrInt = wr.filter(function (t) { return t.interno; }).length;
    var capWr = wrInt * D.cap_interna + (wr.length - wrInt) * D.cap_externa;
    var empresas = {};
    ativos.forEach(function (t) { empresas[t.empresa] = 1; });
    var cel = [
      [ativos.length, "técnicos"],
      [Object.keys(empresas).length, "empresas"],
      [ativos.filter(function (t) { return t.agenda_automatica; }).length, "na agenda automática"],
      [internos, "internos"],
      [ativos.filter(function (t) { return t.retencao; }).length, "em retenção"],
    ];
    $("eq-kpis").innerHTML = cel.map(function (k) {
      return '<div class="kpi"><div class="v">' + num(k[0]) + '</div><div class="l">' + k[1] + "</div></div>";
    }).join("") +
      '<div class="kpi eq-kpi-cap"><div class="v">' + num(cap) + ' <small>OS/dia</small></div>' +
      '<div class="l">capacidade total · ' + internos + " × " + D.cap_interna + " + " + externos + " × " + D.cap_externa +
      '</div><div class="l eq-kpi-wr">War Room (sem retirada): <b>' + num(capWr) + "</b></div></div>";
  }

  // ---------------------------------------------------------------------
  // Tabela, agrupada por empresa como na planilha
  // ---------------------------------------------------------------------
  function sn(t, campo, titulo) {
    var v = !!t[campo];
    var ic = v ? '<span class="eq-sim" aria-label="Sim">✓</span>' : '<span class="eq-nao" aria-label="Não">–</span>';
    if (!ADMIN) return '<td class="eq-c">' + ic + "</td>";
    return '<td class="eq-c"><button type="button" class="eq-sn" data-campo="' + campo + '" data-id="' + t.id +
      '" title="' + titulo + ": clique para " + (v ? "desmarcar" : "marcar") + '">' + ic + "</button></td>";
  }

  // O supervisor sai do VÍNCULO de Configurações (decisão de 25/11/2026),
  // não mais do cadastro: é o mesmo que recorta a Produtividade, o IQI e a
  // War Room. Por isso aqui ele só é mostrado — quem muda é a tela de
  // Configurações (o admin para todos, o supervisor para o próprio time).
  function supCel(t) {
    var ids = t.supervisores || (t.supervisor_id ? [t.supervisor_id] : []);
    var cel = ids.map(function (id) {
      var s = SUP[id];
      return s ? '<span class="eq-pilula av-' + s.cor + '">' + esc(primeiro(s.nome)) + "</span>" : "";
    }).join(" ");
    var tit = "Responsável pelo vínculo de Configurações";
    if (!cel) {
      cel = '<span class="badge badge-ambar">sem supervisor</span>';
      tit = "Nenhum supervisor tem esta empresa nem este técnico em Configurações";
    }
    return '<td title="' + tit + '">' + (ADMIN ? '<a class="eq-sup-link" href="/configuracoes#supervisores">' + cel + "</a>" : cel) + "</td>";
  }

  function obsCel(t) {
    var o = t.obs;
    if (!o) {
      return '<td><span class="badge badge-ambar" title="Nenhuma OS deste nome no WVSA em ' + D.dias_observados +
        ' dias. Se ele trabalhou, o nome no WVSA é outro.">sem OS no WVSA</span></td>';
    }
    if (!o.cliente) {
      return '<td class="eq-obs"><b>' + num(o.outras) + '</b> <span class="subnote">só retirada/infra · último ' + rotDia(o.ultimo) + "</span></td>";
    }
    var pe = Math.round(100 * o.externas / o.cliente);
    return '<td class="eq-obs"><b>' + num(o.cliente) + '</b> <span class="eq-mini" title="' + o.externas + " externas · " +
      o.internas + ' internas"><i style="width:' + pe + '%"></i></span><span class="subnote"> último ' + rotDia(o.ultimo) + "</span></td>";
  }

  function tabela() {
    var lista = D.tecnicos.filter(passa);
    kpis(lista);
    $("eq-contagem").textContent = "· " + lista.length + (lista.length === 1 ? " técnico" : " técnicos");
    var porEmp = {}, ordem = [];
    lista.forEach(function (t) {
      if (!porEmp[t.empresa]) { porEmp[t.empresa] = []; ordem.push(t.empresa); }
      porEmp[t.empresa].push(t);
    });
    if (!lista.length) {
      $("eq-tabela").innerHTML = '<tbody><tr><td class="vazio" style="border:none">Nenhum técnico neste filtro.</td></tr></tbody>';
      return;
    }
    var corpo = ordem.map(function (emp) {
      var ts = porEmp[emp];
      var cap = ts.reduce(function (s, t) { return s + (t.ativo ? (t.interno ? D.cap_interna : D.cap_externa) : 0); }, 0);
      return '<tr class="eq-grupo"><td colspan="9"><b>' + esc(emp) + '</b><span class="subnote"> ' + ts.length +
        (ts.length === 1 ? " técnico" : " técnicos") + " · " + num(cap) + " OS/dia</span></td></tr>" +
        ts.map(function (t) {
          var cls = (t.ativo ? "" : "eq-inativo ") + (t.retirada ? "eq-retirada" : "");
          var nome = '<span class="avatar">' + esc(iniciais(t.nome)) + "</span><span><b>" + esc(t.nome) + "</b>" +
            (t.nome_wvsa ? '<span class="eq-wvsa">no WVSA: ' + esc(t.nome_wvsa) + "</span>" : "") +
            (t.ativo ? "" : '<span class="eq-wvsa">inativo</span>') + "</span>";
          return '<tr class="' + cls + '"><td class="eq-nome">' +
            (ADMIN ? '<button type="button" class="eq-editar" data-id="' + t.id + '" title="Editar">' + nome + "</button>" : nome) +
            "</td>" + sn(t, "agenda_automatica", "Agenda automática") + sn(t, "retencao", "Retenção") +
            sn(t, "interno", "Interno") + sn(t, "retirada", "Só retirada") + supCel(t) +
            '<td class="eq-cid">' + esc(t.cidades || "—") + "</td>" +
            '<td class="num">' + (t.ativo ? (t.interno ? D.cap_interna : D.cap_externa) : "—") + "</td>" + obsCel(t) + "</tr>";
        }).join("");
    }).join("");
    $("eq-tabela").innerHTML = "<thead><tr><th>Técnico</th><th class='eq-c'>Agenda automática</th><th class='eq-c'>Retenção</th>" +
      "<th class='eq-c'>Interno</th><th class='eq-c'>Só retirada</th><th>Supervisor</th><th>Cidades</th>" +
      "<th class='num'>OS/dia</th><th>OS de cliente · " + D.dias_observados + " dias <span class='eq-leg'><i></i> externas</span></th>" +
      "</tr></thead><tbody>" + corpo + "</tbody>";
  }

  // ---------------------------------------------------------------------
  // Fora do cadastro e últimas mudanças
  // ---------------------------------------------------------------------
  function fora() {
    var lista = D.fora.filter(function (o) {
      if (F.emp && o.empresa !== F.emp) return false;
      return !F.busca || norma(o.nome + " " + o.empresa).indexOf(norma(F.busca)) >= 0;
    });
    $("eq-fora-contagem").textContent = "· " + lista.length;
    if (!lista.length) {
      $("eq-fora").innerHTML = '<p class="subnote" style="margin:0">Todo técnico que fechou OS de cliente está no cadastro.</p>';
      return;
    }
    $("eq-fora").innerHTML = '<p class="subnote" style="margin:0 0 10px">A War Room conta estes pelo perfil das OS ' +
      "(maioria externa = " + D.cap_externa + ", senão " + D.cap_interna + "). Incluir no cadastro passa a usar a marcação de interno.</p>" +
      '<div class="tabela-wrap"><table class="tbl"><thead><tr><th>Técnico</th><th>Empresa</th><th class="num">OS de cliente</th>' +
      '<th class="num">Externas</th><th class="num">Internas</th><th>Último dia</th>' + (ADMIN ? "<th></th>" : "") +
      "</tr></thead><tbody>" + lista.map(function (o, i) {
        return "<tr><td><b>" + esc(o.nome) + "</b></td><td>" + esc(o.empresa) + '</td><td class="num">' + num(o.cliente) +
          '</td><td class="num">' + num(o.externas) + '</td><td class="num">' + num(o.internas) + "</td><td>" + rotDia(o.ultimo) +
          "</td>" + (ADMIN ? '<td><button type="button" class="btn-ghost" data-incluir="' + i + '">Incluir</button></td>' : "") + "</tr>";
      }).join("") + "</tbody></table></div>";
    FORA_VISTA = lista;
  }
  var FORA_VISTA = [];

  function mudancas() {
    var m = D.mudancas || [];
    $("eq-mudancas").innerHTML = m.length ? '<ul class="linha-tempo">' + m.map(function (x) {
      return "<li><b>" + esc(x.tecnico) + "</b> — " + esc(x.texto) + ' <span class="subnote">' + esc(x.em) + " · " + esc(x.por) + "</span></li>";
    }).join("") + "</ul>" : '<p class="subnote" style="margin:0">Nenhuma mudança desde a carga da planilha de 19/11/2026.</p>';
  }

  function empresas() {
    var set = {};
    D.tecnicos.forEach(function (t) { set[t.empresa] = 1; });
    var lista = Object.keys(set).sort();
    var sel = $("eq-emp"), atual = sel.value;
    sel.innerHTML = '<option value="">Todas</option>' + lista.map(function (e) {
      return '<option value="' + esc(e) + '"' + (e === atual ? " selected" : "") + ">" + esc(e) + "</option>";
    }).join("");
    if ($("eq-empresas")) $("eq-empresas").innerHTML = lista.map(function (e) { return '<option value="' + esc(e) + '">'; }).join("");
  }

  function tudo() { empresas(); tabela(); fora(); mudancas(); }

  // ---------------------------------------------------------------------
  // Filtro
  // ---------------------------------------------------------------------
  $("eq-busca").addEventListener("input", function () { F.busca = this.value.trim(); tabela(); fora(); });
  $("eq-sup").addEventListener("change", function () { F.sup = this.value; tabela(); });
  $("eq-emp").addEventListener("change", function () { F.emp = this.value; tabela(); fora(); });
  $("eq-inativos").addEventListener("change", function () { F.inativos = this.checked; tabela(); });

  document.querySelector("[data-recolher]").addEventListener("click", function () {
    var card = $("eq-mud-card"), b = card.querySelector(".card-b");
    var abrir = b.hidden;
    b.hidden = !abrir;
    card.classList.toggle("recolhido", !abrir);
    this.textContent = abrir ? "Ocultar" : "Mostrar";
  });

  // ---------------------------------------------------------------------
  // Edição (só admin; o servidor confere de novo)
  // ---------------------------------------------------------------------
  function aviso(msg) {
    var el = $("eq-aviso");
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove("on"); }, 4500);
  }

  async function postJSON(url, corpo) {
    var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                               body: JSON.stringify(corpo), credentials: "same-origin" });
    var j = {};
    try { j = await r.json(); } catch (e) { /* corpo não JSON */ }
    if (!r.ok) throw new Error(j.erro || "O servidor recusou (HTTP " + r.status + ").");
    return j;
  }

  function substituir(t) {
    var antigo = D.tecnicos.filter(function (x) { return x.id === t.id; })[0];
    t.obs = antigo ? antigo.obs : null;
    var achou = false;
    D.tecnicos = D.tecnicos.map(function (x) { if (x.id === t.id) { achou = true; return t; } return x; });
    if (!achou) D.tecnicos.push(t);
    D.tecnicos.sort(function (a, b) {
      return norma(a.empresa).localeCompare(norma(b.empresa)) || norma(a.nome).localeCompare(norma(b.nome));
    });
  }

  async function gravar(id, campo, valor) {
    try {
      var j = await postJSON("/equipe/tecnicos/" + id, { campo: campo, valor: valor });
      substituir(j.tecnico);
      tabela();
      aviso("Gravado.");
    } catch (e) {
      aviso(e.message);
      tabela();
    }
  }

  if (!ADMIN) { tudo(); return; }

  $("eq-tabela").addEventListener("click", function (e) {
    var b = e.target.closest(".eq-sn");
    if (b) {
      var t = D.tecnicos.filter(function (x) { return x.id === b.dataset.id; })[0];
      if (t) gravar(t.id, b.dataset.campo, !t[b.dataset.campo]);
      return;
    }
    var ed = e.target.closest(".eq-editar");
    if (ed) abrir(D.tecnicos.filter(function (x) { return x.id === ed.dataset.id; })[0]);
  });
  $("eq-fora").addEventListener("click", function (e) {
    var b = e.target.closest("[data-incluir]");
    if (!b) return;
    var o = FORA_VISTA[+b.dataset.incluir];
    // Interno NÃO vem marcado pelo perfil das OS: é justamente o palpite
    // que o cadastro substitui. Quem inclui decide.
    abrir(null, { nome: o.nome, empresa: o.empresa });
  });

  var dlg = $("eq-dlg"), EDITANDO = null;
  var CAMPOS = { nome: "eq-f-nome", empresa: "eq-f-empresa", nome_wvsa: "eq-f-wvsa", cidades: "eq-f-cidades" };
  var MARCAS = { interno: "eq-f-interno", agenda_automatica: "eq-f-agenda", retencao: "eq-f-retencao",
                 retirada: "eq-f-retirada", ativo: "eq-f-ativo" };

  function abrir(t, sugestao) {
    EDITANDO = t || null;
    var base = t || Object.assign({ ativo: true }, sugestao || {});
    $("eq-form-t").textContent = t ? "Editar " + t.nome : "Incluir técnico";
    Object.keys(CAMPOS).forEach(function (c) { $(CAMPOS[c]).value = base[c] || ""; });
    Object.keys(MARCAS).forEach(function (c) { $(MARCAS[c]).checked = !!base[c]; });
    // `hidden` perde para o display:flex do rótulo (§6): vai por style.
    $("eq-f-ativo-l").style.display = t ? "" : "none";
    $("eq-form-erro").hidden = true;
    dlg.showModal();
    $("eq-f-nome").focus();
  }

  $("eq-novo").addEventListener("click", function () { abrir(null); });
  dlg.querySelector("[data-fechar]").addEventListener("click", function () { dlg.close(); });

  $("eq-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var dados = {};
    Object.keys(CAMPOS).forEach(function (c) { dados[c] = $(CAMPOS[c]).value.trim() || null; });
    Object.keys(MARCAS).forEach(function (c) { dados[c] = $(MARCAS[c]).checked; });
    var erro = $("eq-form-erro");
    try {
      if (!EDITANDO) {
        var novo = (await postJSON("/equipe/tecnicos", dados)).tecnico;
        var incluido = norma(dados.nome_wvsa || dados.nome).replace(/\s+/g, " ").trim();
        var veio = D.fora.filter(function (o) { return norma(o.nome).replace(/\s+/g, " ").trim() === incluido; })[0];
        substituir(novo);
        // O que a Produtividade mostra dele já estava na lista de fora do
        // cadastro: vai junto, sem esperar recarregar.
        if (veio) novo.obs = veio;
        D.fora = D.fora.filter(function (o) { return o !== veio; });
      } else {
        // Um campo por pedido: é o que o histórico registra, e o que muda
        // é só o que a pessoa trocou.
        for (var c in dados) {
          var antes = EDITANDO[c];
          var igual = typeof dados[c] === "boolean" ? !!antes === dados[c] : (antes || null) === dados[c];
          if (igual) continue;
          var j = await postJSON("/equipe/tecnicos/" + EDITANDO.id, { campo: c, valor: dados[c] });
          substituir(j.tecnico);
          EDITANDO = j.tecnico;
        }
      }
      dlg.close();
      tudo();
      aviso("Cadastro gravado.");
    } catch (err) {
      erro.textContent = err.message;
      erro.hidden = false;
    }
  });

  tudo();
})();
