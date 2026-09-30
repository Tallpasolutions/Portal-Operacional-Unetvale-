// Tela do Dashboard: uma página, cinco blocos.
//
// Sem filtro, todo número veio do servidor (app/gerencial.py): o consolidado
// do WVSA, o "vs meta", o entrou/saiu da esteira. COM filtro global (empresa,
// supervisor, técnico, ofensores) ou cross-filter de causa raiz, os blocos que
// conhecem o técnico recontam aqui, a partir dos registros que o servidor
// mandou — e dizem que é "soma do recorte", nunca "WVSA". Contagem já agregada
// não se recorta depois; é a mesma razão da causa raiz do /iqi.
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

  var F = window.DashFiltro || { passa: function () { return true; }, ativo: function () { return false; },
                                 mesWvsa: function (m) { return m; } };

  // ------------------------------------------------------------ qualidade
  // Com recorte, o % de cada mês é reincidências ÷ OSs SOMADAS dos técnicos
  // que passam no filtro (só operacional, igual ao ranking do /iqi). Não é o
  // consolidado do WVSA — que inclui infra e quem saiu — e a tela diz isso.
  function serieDoRecorte(ind, q) {
    var ms = q.meses || [];
    return (q.serie || []).map(function (p) {
      var i = ms.indexOf(p.mes);
      var os = 0, ch = 0;
      if (i >= 0) {
        (q.tecnicos || []).forEach(function (t) {
          if (!t.m || !t.m[i] || !F.passa(t.nome, { ind: ind, mes: p.mes })) return;
          os += t.m[i][0] || 0;
          ch += t.m[i][1] || 0;
        });
      }
      return { mes: p.mes, os: os, chamados: ch, pct: os ? ch / os * 100 : null };
    });
  }

  function qualidade() {
    var filtrado = F.ativo();
    ["IQI", "IQM"].forEach(function (ind) {
      var q = (D.qualidade || {})[ind] || {};
      var pref = ind.toLowerCase();
      var rot = $(pref + "-meta");
      if (rot) {
        rot.textContent = (q.meta === null || q.meta === undefined)
          ? "meta não definida" : "meta ≤ " + Dash.pct(q.meta, 2);
      }
      var serieUsada = q.serie || [], visiveis = q.visiveis;
      if (filtrado) {
        serieUsada = serieDoRecorte(ind, q);
        var n = (q.visiveis || []).length;
        visiveis = serieUsada.slice(-n).map(function (d, k) {
          var orig = q.visiveis[k] || {};
          var vm = null;
          if (q.meta !== null && q.meta !== undefined && d.pct !== null) {
            var dif = Math.round((d.pct - q.meta) * 100) / 100;
            vm = { alvo: q.meta, dentro: d.pct <= q.meta, diferenca: dif };
          }
          return { mes: d.mes, pct: d.pct, os: d.os, chamados: d.chamados,
                   parcial: orig.parcial, vs_meta: vm };
        });
      }
      Dash.parMes($(pref + "-par"), visiveis, function (d) { return Dash.pct(d.pct); },
        { base: function (d) {
            return Dash.num(d.chamados) + " de " + Dash.num(d.os) + " OSs" + (filtrado ? " · soma do recorte" : "");
          },
          vazio: filtrado ? "Nenhum técnico do recorte com OS de " + ind + "."
                          : "Sem dados de " + ind + " ainda." });
      serie(ind, q, serieUsada);
    });
    fonteQualidade(filtrado);
  }

  // De onde vem o consolidado. Nao e enfeite: o numero desta tela inclui
  // infraestrutura e inclui tecnico que ja saiu, enquanto o ranking do /iqi
  // exclui infra — quem somar o de la nao chega neste, e precisa saber por que.
  function fonteQualidade(filtrado) {
    var el = $("qual-fonte");
    if (!el) return;
    el.style.color = "";
    if (filtrado) {
      el.textContent = "Recorte: " + F.resumo() + ". O % é a soma dos técnicos do recorte " +
        "(só operacional, sem infra) — não é o consolidado do WVSA, que volta ao limpar o filtro.";
      return;
    }
    var fontes = ["IQI", "IQM"].map(function (i) { return ((D.qualidade || {})[i] || {}).fonte; });
    if (fontes.indexOf("soma") >= 0) {
      el.innerHTML = "\u26a0\ufe0f Consolidado ainda pela soma dos t\u00e9cnicos: a coleta que traz a " +
        "s\u00e9rie do WVSA n\u00e3o rodou depois da atualiza\u00e7\u00e3o. O n\u00famero pode divergir do relat\u00f3rio.";
      el.style.color = "var(--warning)";
    } else if (fontes.indexOf("wvsa") >= 0) {
      el.textContent = "IQI e IQM s\u00e3o o consolidado do relat\u00f3rio indicadores4 do WVSA \u2014 o m\u00eas inteiro, " +
        "com infraestrutura e com quem j\u00e1 saiu da equipe. O ranking por t\u00e9cnico do /iqi exclui infra, " +
        "ent\u00e3o a soma de l\u00e1 n\u00e3o fecha com este n\u00famero.";
    }
  }

  var graficos = {};
  function serie(ind, q, dadosSerie) {
    var cv = $("g-" + ind.toLowerCase() + "-serie");
    if (graficos[ind]) { graficos[ind].destroy(); graficos[ind] = null; }
    if (!cv || !window.Chart || !(dadosSerie || []).length) return;
    var pontos = dadosSerie.filter(function (p) { return p.pct !== null; });
    if (!pontos.length) return;

    var ctx = cv.getContext("2d");
    var brand = css("--brand"), danger = css("--danger");

    // Preenchimento em gradiente, e nao cor chapada com alfa: a area encosta
    // no eixo sem virar uma faixa solida que compete com a linha.
    var fundo = ctx.createLinearGradient(0, 0, 0, cv.clientHeight || 190);
    fundo.addColorStop(0, brand + "33");
    fundo.addColorStop(1, brand + "00");

    // So o ultimo mes ganha ponto visivel. Marcar os oito polui a linha; o
    // que se procura e onde a serie esta agora.
    var ultimo = pontos.length - 1;

    var ds = [{
      label: ind + " %",
      data: pontos.map(function (p) { return p.pct; }),
      borderColor: brand, backgroundColor: fundo, fill: true,
      tension: 0.35, borderWidth: 2.5,
      pointRadius: pontos.map(function (_, i) { return i === ultimo ? 4 : 0; }),
      pointHoverRadius: 5,
      pointBackgroundColor: "#fff",
      pointBorderColor: brand, pointBorderWidth: 2.5
    }];
    if (q.meta !== null && q.meta !== undefined) {
      ds.push({
        label: "Meta", data: pontos.map(function () { return Number(q.meta); }),
        borderColor: danger, borderDash: [5, 4], borderWidth: 1.5,
        pointRadius: 0, pointHoverRadius: 0, fill: false, tension: 0
      });
    }

    graficos[ind] = new Chart(cv, {
      type: "line",
      data: { labels: pontos.map(function (p) { return Dash.rotuloMes(p.mes); }), datasets: ds },
      options: {
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 6, right: 4 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) {
            return (c.datasetIndex === 1 ? "Meta: " : ind + ": ") + Dash.pct(c.parsed.y);
          } } }
        },
        scales: {
          // Quatro marcas bastam para ler a tendencia, e a grade fina fica
          // atras da serie em vez de disputar com ela.
          y: { ticks: { maxTicksLimit: 4, callback: function (v) { return v + "%"; } },
               grid: { color: "rgba(11,23,39,.045)" } },
          // Rotulo curto e reto: girado a 45 graus ele engordava o eixo e
          // comia a altura do grafico, que ja e baixo.
          x: { ticks: { maxRotation: 0, autoSkipPadding: 12,
                        callback: function (v) {
                          var m = this.getLabelForValue(v);
                          return m ? m.slice(0, 3) + m.slice(-3) : m;
                        } },
               grid: { display: false } }
        }
      }
    });
  }

  // ----------------------------------------------------------- causa raiz
  // Conta a partir dos registros (Dash.contarCategorias), recortando pelo
  // filtro global e pelo cross-filter. Clicar numa barra filtra as OUTRAS
  // categorias por aqueles protocolos; clicar de novo desfaz. Seleções em
  // cartões diferentes se somam (E).
  var cr = D.causa_raiz || {};
  var crInd = "IQI";
  var crSel = {};
  var ROTULO_CAMPO = { cat1: "Cat 1", cat2: "Cat 2", cat4: "Cat 4", cat5: "Cat 5", cat6: "Cat 6", cidade: "Cidade" };
  // Abre no ultimo mes COM dado (gerencial.mes_padrao), nao no mais recente:
  // na virada do mes o mais recente esta vazio e a tela inteira parecia
  // quebrada horas depois de a coleta ter rodado.
  Dash.preencherSelect($("cr-mes"), cr.visiveis || [], cr.mes_padrao);

  function alternar(campo) {
    return function (rotulo) {
      if (crSel[campo] === rotulo) delete crSel[campo]; else crSel[campo] = rotulo;
      causaRaiz();
    };
  }

  function causaRaiz() {
    Array.prototype.forEach.call($("cr-ind").children, function (b) {
      b.classList.toggle("active", b.dataset.ind === crInd);
    });
    var mes = $("cr-mes").value;
    var tecs = F.ativo()
      ? Dash.tecnicosQuePassam(cr, function (nome) { return F.passa(nome, { ind: crInd, mes: mes }); })
      : null;
    var d = Dash.contarCategorias(cr, crInd, mes ? [mes] : [], { tecnicos: tecs, sel: crSel });
    $("cr-total").textContent = Dash.num(d.total);

    // Mes sem registro nao e falha de coleta, e o texto nao pode dizer que e:
    // "a proxima coleta preenchera" mandava conferir o coletor por um mes que
    // ainda nao aconteceu.
    var nada = (F.ativo() || Object.keys(crSel).length)
      ? "Nenhuma reincidência de " + crInd + " neste recorte em " + Dash.rotuloMes(mes) + "."
      : "Nenhuma reincidência de " + crInd + " registrada em " + Dash.rotuloMes(mes) + " até agora.";
    function r(id, campo, limite, topo) {
      Dash.rank($(id), d.contas[campo] || {}, {
        limite: limite, destacarTopo: topo, vazio: nada,
        aoClicar: alternar(campo), selecionado: crSel[campo]
      });
    }
    r("cr-cat4", "cat4", 10, true);
    r("cr-cat5", "cat5", 12, true);
    r("cr-cat1", "cat1", 8, false);
    r("cr-cat2", "cat2", 8, false);
    r("cr-cidades", "cidade", 10, false);

    // Cat 6: múltipla, e só existe nos meses coletados depois de 29/09/2026.
    // "Não coletada" e "nenhum ajuste" são respostas diferentes — a primeira
    // manda rodar o backfill, a segunda é informação.
    var nota6 = $("cr-cat6-nota");
    if (!d.coletados.cat6 && d.total) {
      Dash.vazio($("cr-cat6"), "A Categoria 6 deste mês ainda não foi coletada — ela entrou na coleta " +
        "em 29/09/2026 e os meses anteriores dependem do backfill (enviar.py --so ger_categorias --full).");
      if (nota6) nota6.textContent = "";
    } else {
      Dash.rank($("cr-cat6"), d.contas.cat6 || {}, {
        limite: 12, destacarTopo: false, base: d.total, aoClicar: alternar("cat6"), selecionado: crSel.cat6,
        vazio: d.total ? "Nenhum ajuste de Categoria 6 registrado neste recorte." : nada
      });
      if (nota6) nota6.textContent = "um protocolo pode ter vários ajustes";
    }

    // O que está selecionado, com o X para desfazer — o mesmo `.chip` das
    // outras telas. Recria só este contêiner, que não é onde se clicou para
    // filtrar.
    $("cr-sel").innerHTML = Object.keys(crSel).map(function (c) {
      return '<span class="chip">' + Dash.esc(ROTULO_CAMPO[c] || c) + ": " + Dash.esc(crSel[c]) +
        ' <button type="button" data-campo="' + c + '" aria-label="Remover filtro">×</button></span>';
    }).join("");
  }
  $("cr-sel").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-campo]");
    if (b) { delete crSel[b.dataset.campo]; causaRaiz(); }
  });
  $("cr-ind").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-ind]");
    if (b) { crInd = b.dataset.ind; causaRaiz(); }
  });
  $("cr-mes").addEventListener("change", causaRaiz);

  // Os dois blocos recortáveis redesenham a cada mudança do filtro global. A
  // primeira publicação chega no DOMContentLoaded (ver dashboard_filtro.js);
  // sem o filtro na página, desenham já.
  function recortaveis() { qualidade(); causaRaiz(); if (typeof cancelamentos === "function" && c) cancelamentos(); }
  if (window.DashFiltro) document.addEventListener("dashfiltro", recortaveis);
  else recortaveis();

  // -------------------------------------------------------- cancelamentos
  var c = D.cancelamentos || {};
  Dash.parMes($("cmt-par"), c.visiveis, function (d) { return Dash.pct(d.pct); },
    { base: function (d) { return Dash.num(d.tecnico) + " de " + Dash.num(d.total) + " cancelamentos"; },
      vazio: "Sem dados de cancelamento ainda." });

  Dash.preencherSelect($("ca-mes"), (c.visiveis || []).map(function (d) { return d.mes; }),
    c.mes_padrao);
  var TX = c.textos || {};
  var txt = function (lista, i) { return (TX[lista] || [])[i] || ""; };
  var GRUPO_TECNICO = "PROBLEMA TECNICO";

  function mesCancel() {
    var mes = $("ca-mes").value;
    return (c.visiveis || []).filter(function (x) { return x.mes === mes; })[0];
  }

  // Selects de grupo e motivo com o que EXISTE no mês, e a contagem ao lado.
  function montarMotivos(d) {
    var gSel = $("ca-grupo"), mSel = $("ca-motivo");
    var gAtual = gSel.value, mAtual = mSel.value;
    var porGrupo = {}, porMotivo = {};
    (d && d.contratos || []).forEach(function (r) {
      var g = txt("grupo", r[3]), m = txt("motivo", r[2]);
      porGrupo[g] = (porGrupo[g] || 0) + 1;
      if (!gAtual || g === gAtual) porMotivo[m] = (porMotivo[m] || 0) + 1;
    });
    function opcoes(mapa, todos) {
      return '<option value="">' + todos + "</option>" + Object.keys(mapa)
        .sort(function (a, b) { return mapa[b] - mapa[a]; })
        .map(function (k) { return '<option value="' + Dash.esc(k) + '">' + Dash.esc(k) + " (" + mapa[k] + ")</option>"; })
        .join("");
    }
    gSel.innerHTML = opcoes(porGrupo, "Todos");
    gSel.value = porGrupo[gAtual] ? gAtual : "";
    mSel.innerHTML = opcoes(porMotivo, "Todos");
    mSel.value = porMotivo[mAtual] ? mAtual : "";
    // Sem o detalhe por contrato (mês coletado antes de 29/09/2026) não há o
    // que filtrar — o select desabilitado diz isso melhor que uma lista vazia.
    var sem = !(d && d.detalhe);
    gSel.disabled = mSel.disabled = sem;
    gSel.title = mSel.title = sem ? "Este mês foi coletado antes do detalhe por contrato existir." : "";
  }

  function contratosFiltrados(d) {
    var g = $("ca-grupo").value, m = $("ca-motivo").value;
    return (d.contratos || []).filter(function (r) {
      return (!g || txt("grupo", r[3]) === g) && (!m || txt("motivo", r[2]) === m);
    });
  }

  function contar(regs, lista, col) {
    var out = {};
    regs.forEach(function (r) { var k = txt(lista, r[col]); if (k) out[k] = (out[k] || 0) + 1; });
    return out;
  }

  function cancelamentos() {
    var d = mesCancel();
    if (!d) {
      ["ca-grupos", "ca-cidades", "ca-casa", "cmt-motivos"].forEach(function (id) { Dash.vazio($(id)); });
      ofensorCancel(null);
      return;
    }
    montarMotivos(d);
    var filtrado = !!($("ca-grupo").value || $("ca-motivo").value);
    var regs = filtrado ? contratosFiltrados(d) : null;
    var nada = "Nenhum cancelamento registrado em " + Dash.rotuloMes(d.mes) + " até agora.";
    var nadaFiltro = "Nenhum cancelamento deste motivo em " + Dash.rotuloMes(d.mes) + ".";
    $("ca-quando").textContent = Dash.rotuloMes(d.mes);
    Dash.rank($("cmt-motivos"), d.motivos_tecnicos,
      { limite: 6, vazio: d.total ? "Sem motivos técnicos no mês." : nada });

    if (!filtrado) {
      // Sem filtro, os números do próprio relatório — os que batem com o WVSA.
      $("ca-total").textContent = Dash.num(d.total);
      $("ca-tec").textContent = Dash.num(d.tecnico) + " (" + Dash.pct(d.pct) + ")";
      $("ca-valor").textContent = Dash.moeda(d.valor);
      $("ca-valor").title = "";
      $("ca-filtro-nota").textContent = "";
      Dash.rank($("ca-grupos"), d.grupos, { limite: 10, vazio: nada });
      Dash.rank($("ca-cidades"), d.cidades, { limite: 10, destacarTopo: false, vazio: nada });
      Dash.rank($("ca-casa"), d.tempo_casa, { limite: 10, destacarTopo: false, vazio: nada });
    } else {
      var tec = regs.filter(function (r) { return txt("grupo", r[3]) === GRUPO_TECNICO; }).length;
      $("ca-total").textContent = Dash.num(regs.length);
      $("ca-tec").textContent = Dash.num(tec) + " (" + Dash.pct(regs.length ? tec / regs.length * 100 : null) + ")";
      // A tabela dinâmica do IGC não traz o valor de cada contrato: a receita
      // só existe para o mês inteiro. Um "—" com o porquê, em vez de um número
      // que não é do recorte.
      $("ca-valor").textContent = "—";
      $("ca-valor").title = "O relatório só publica a receita do mês inteiro, não por motivo.";
      $("ca-filtro-nota").textContent = Dash.num(regs.length) + " de " + Dash.num(d.total) +
        " cancelamentos do mês. Receita perdida não é recortada: o relatório só a publica para o mês inteiro.";
      Dash.rank($("ca-grupos"), contar(regs, "grupo", 3), { limite: 10, vazio: nadaFiltro });
      Dash.rank($("ca-cidades"), contar(regs, "cidade", 1), { limite: 10, destacarTopo: false, vazio: nadaFiltro });
      Dash.rank($("ca-casa"), contar(regs, "casa", 4), { limite: 10, destacarTopo: false, vazio: nadaFiltro });
    }
    ofensorCancel(d);
  }

  // Técnico do último atendimento: contrato do CMT × contrato do IGC (cidade,
  // motivo). Obedece ao filtro global (é o único pedaço da seção com técnico)
  // e ao filtro de motivo.
  function ofensorCancel(d) {
    var nota = $("ca-of-nota"), tTec = $("ca-of-tec"), tCid = $("ca-of-cid");
    var vazioTab = function (el, msg) {
      el.innerHTML = '<tbody><tr><td class="vazio-cel" style="padding:22px;text-align:center;">' + msg + "</td></tr></tbody>";
    };
    if (!d || !d.detalhe) {
      nota.textContent = "";
      var msg = d ? "O técnico do último atendimento passou a ser coletado em 29/09/2026; " +
        Dash.rotuloMes(d.mes) + " foi coletado antes disso." : "Sem dados de cancelamento ainda.";
      vazioTab(tTec, msg); vazioTab(tCid, msg);
      return;
    }
    var g = $("ca-grupo").value;
    if (g && g !== GRUPO_TECNICO) {
      nota.textContent = "";
      var m2 = "O técnico do último atendimento só existe para o grupo " + GRUPO_TECNICO +
        " — nos outros motivos o técnico não explica o cancelamento.";
      vazioTab(tTec, m2); vazioTab(tCid, m2);
      return;
    }
    var porContrato = {};
    contratosFiltrados(d).forEach(function (r) { porContrato[r[0]] = r; });
    var tecnicos = (d.contratos || []).filter(function (r) { return txt("grupo", r[3]) === GRUPO_TECNICO; });
    var comOs = d.ultimo.filter(function (u) { return porContrato[u[0]]; });
    var noRecorte = comOs.filter(function (u) { return F.passa(txt("tecnico", u[1]), { mes: d.mes }); });

    nota.innerHTML = "Última OS antes do cancelamento, pelo relatório CMT do WVSA. Cobre só o grupo " +
      "<b>" + GRUPO_TECNICO + "</b> e só quem teve OS: em " + Dash.esc(Dash.rotuloMes(d.mes)) + ", <b>" +
      Dash.num(d.ultimo.length) + " de " + Dash.num(tecnicos.length) + "</b> cancelamentos técnicos. " +
      "O % é sobre os " + Dash.num(noRecorte.length) + " do recorte." +
      (F.ativo() ? " Recorte: " + Dash.esc(F.resumo()) + "." : "");
    $("ca-of-quando").textContent = Dash.rotuloMes(d.mes);
    if (!noRecorte.length) {
      var m3 = F.ativo() ? "Nenhum técnico do recorte fez o último atendimento de um cancelado neste mês."
                         : "Nenhum cancelamento técnico com OS neste mês.";
      vazioTab(tTec, m3); vazioTab(tCid, m3);
      return;
    }
    var tot = noRecorte.length;
    function agrupa(chave, outra) {
      var out = {};
      noRecorte.forEach(function (u) {
        var k = chave(u), o = outra(u);
        var a = out[k] = out[k] || { n: 0, outros: {} };
        a.n++; a.outros[o] = (a.outros[o] || 0) + 1;
      });
      return Object.keys(out).map(function (k) {
        var os = out[k].outros, top = Object.keys(os).sort(function (a, b) { return os[b] - os[a]; })[0];
        return { k: k, n: out[k].n, top: top, topN: os[top] };
      }).sort(function (a, b) { return b.n - a.n || a.k.localeCompare(b.k); });
    }
    var tec = function (u) { return txt("tecnico", u[1]); };
    var cid = function (u) { return txt("cidade", porContrato[u[0]][1]) || "(sem cidade)"; };
    var pct = function (n) { return Dash.pct(n / tot * 100, 1); };

    tTec.innerHTML = '<thead><tr><th>Técnico</th><th>Empresa</th><th class="num">Clientes</th><th class="num">%</th><th>Cidade que mais pesa</th></tr></thead><tbody>' +
      agrupa(tec, cid).map(function (r) {
        var p = r.k.indexOf(" - ");
        return "<tr><td>" + Dash.esc(p >= 0 ? r.k.slice(p + 3) : r.k) + "</td><td>" +
          Dash.esc(p >= 0 ? r.k.slice(0, p) : "") + '</td><td class="num">' + r.n + '</td><td class="num">' +
          pct(r.n) + "</td><td>" + Dash.esc(r.top) + (r.n > 1 ? " (" + r.topN + ")" : "") + "</td></tr>";
      }).join("") + "</tbody>";
    tCid.innerHTML = '<thead><tr><th>Cidade</th><th class="num">Clientes</th><th class="num">%</th><th>Técnico que mais pesa</th></tr></thead><tbody>' +
      agrupa(cid, tec).map(function (r) {
        return "<tr><td>" + Dash.esc(r.k) + '</td><td class="num">' + r.n + '</td><td class="num">' + pct(r.n) +
          "</td><td>" + Dash.esc(r.top) + (r.n > 1 ? " (" + r.topN + ")" : "") + "</td></tr>";
      }).join("") + "</tbody>";
  }

  $("ca-mes").addEventListener("change", cancelamentos);
  $("ca-grupo").addEventListener("change", function () { $("ca-motivo").value = ""; cancelamentos(); });
  $("ca-motivo").addEventListener("change", cancelamentos);
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
  // Três fontes, porque nenhum endpoint do WVSA entrega tudo junto (ver
  // coletor/gerencial.py:idf_detalhado): o painel (números oficiais), a
  // lista de feedbacks (quem, nota, resolvido) e o drill por setor/cidade.
  //
  // Sem filtro, os números são os do painel do WVSA. Com filtro, recontados
  // da lista — ou do cubo por cidade, quando há cidade, porque a lista não diz
  // a cidade de cada feedback e não se inventa a atribuição.
  var CANAIS = [["ligacoes", "Ligações"], ["chats", "Chats"], ["os", "OS"]];
  var I = D.idf || {};
  var ITX = I.textos || {};
  var LIMIAR = Number(I.limiar === undefined || I.limiar === null ? 3 : I.limiar);
  var idfCanal = "chats", idfTodos = false;
  var ipessoa = function (i) { return (ITX.pessoa || [])[i] || ""; };
  document.querySelectorAll(".idf-limiar").forEach(function (e) {
    e.textContent = String(LIMIAR).replace(".", ",");
  });
  Dash.preencherSelect($("idf-mes-sel"), (I.visiveis || []).map(function (v) { return v.mes; }),
    ((I.visiveis || [])[(I.visiveis || []).length - 1] || {}).mes);

  function idfMes() {
    var m = $("idf-mes-sel").value;
    return (I.visiveis || []).filter(function (v) { return v.mes === m; })[0];
  }

  function setorDe(blk) {
    var out = {};
    ["ligacoes", "chats"].forEach(function (c) {
      ((blk.setor_de || {})[c] || []).forEach(function (r) {
        out[ipessoa(r[0])] = (ITX.setor || [])[r[1]] || "";
      });
    });
    return out;
  }

  // Selects com o que existe no mês. Recriados quando o mês muda, mantendo a
  // escolha se ela ainda existir.
  function montarFiltrosIdf(blk) {
    var set = new Set(), cid = new Set(), at = new Set();
    var sd = setorDe(blk);
    Object.keys(sd).forEach(function (p) { if (sd[p]) set.add(sd[p]); });
    ["chats", "os"].forEach(function (c) {
      ((blk.cidade || {})[c] || []).forEach(function (r) { var n = (ITX.cidade || [])[r[0]]; if (n) cid.add(n); });
    });
    ["ligacoes", "chats"].forEach(function (c) {
      ((blk.feedbacks || {})[c] || []).forEach(function (r) { var n = ipessoa(r[1]); if (n) at.add(n); });
    });
    function preencher(id, valores, todos) {
      var el = $(id), atual = el.value;
      var ord = Array.from(valores).sort(function (a, b) { return a.localeCompare(b, "pt-BR"); });
      el.innerHTML = '<option value="">' + todos + "</option>" + ord.map(function (v) {
        return '<option value="' + Dash.esc(v) + '">' + Dash.esc(v) + "</option>";
      }).join("");
      el.value = valores.has(atual) ? atual : "";
      el.disabled = !valores.size;
      el.title = valores.size ? "" : "O detalhe por feedback passou a ser coletado em 29/09/2026.";
    }
    preencher("idf-setor", set, "Todos");
    preencher("idf-cidade", cid, "Todas");
    preencher("idf-atendente", at, "Todos");
  }

  function filtrosIdf() {
    return { setor: $("idf-setor").value, cidade: $("idf-cidade").value, atendente: $("idf-atendente").value };
  }

  /**
   * O canal se aplica ao filtro? E a pessoa passa?
   *   ligação: sem cidade no WVSA; subsetor e atendente valem.
   *   chat: tudo vale.
   *   OS: técnico de campo — subsetor e atendente NÃO se aplicam; quem
   *       recorta é o filtro global.
   */
  function canalAplica(canal, f) {
    if (canal === "ligacoes" && f.cidade) return false;
    if (canal === "os" && (f.setor || f.atendente)) return false;
    return true;
  }
  function pessoaPassa(canal, nome, f, sd, mes) {
    if (canal === "os") return F.passa(nome, { mes: mes });
    if (f.setor && sd[nome] !== f.setor) return false;
    if (f.atendente && nome !== f.atendente) return false;
    return true;
  }
  function recortaCanal(canal, f) {
    return !!(f.setor || f.cidade || f.atendente || (canal === "os" && F.ativo()));
  }

  /** {n, nota, pct_resolvido, porPessoa:{nome:{n, soma, res, com}}} do canal no recorte. */
  function medirCanal(blk, canal, f, sd) {
    var porPessoa = {}, n = 0, soma = 0, com = 0, res = 0, semRes = false;
    if (f.cidade) {
      // Cubo (cidade, pessoa, qtd, média): média ponderada pela quantidade.
      // Resolvido não existe no cubo — o WVSA não o publica por cidade.
      semRes = true;
      ((blk.cidade || {})[canal] || []).forEach(function (r) {
        if ((ITX.cidade || [])[r[0]] !== f.cidade) return;
        var nome = ipessoa(r[1]);
        if (!pessoaPassa(canal, nome, f, sd, blk.mes) || r[3] === null) return;
        n += r[2]; soma += r[2] * r[3];
        var a = porPessoa[nome] = porPessoa[nome] || { n: 0, soma: 0, res: 0, com: 0 };
        a.n += r[2]; a.soma += r[2] * r[3];
      });
    } else {
      ((blk.feedbacks || {})[canal] || []).forEach(function (r) {
        var nome = ipessoa(r[1]);
        if (!pessoaPassa(canal, nome, f, sd, blk.mes)) return;
        var a = porPessoa[nome] = porPessoa[nome] || { n: 0, soma: 0, res: 0, com: 0 };
        if (r[2] !== null) { n++; soma += r[2]; a.n++; a.soma += r[2]; }
        if (r[3] !== -1) { com++; a.com++; if (r[3] === 1) { res++; a.res++; } }
      });
    }
    return { n: n, nota: n ? soma / n : null, pct_resolvido: (!semRes && com) ? res / com * 100 : null,
             porPessoa: porPessoa, semRes: semRes };
  }

  function kpiIdf(rotulo, valor, alerta, nota) {
    return '<div class="kpi' + (alerta ? " kpi-alerta" : "") + '"><b class="v"' +
      (alerta ? ' style="color:var(--danger)"' : "") + ">" + valor +
      (alerta ? ' <span class="badge badge-vermelho" style="font-size:11px;vertical-align:middle">alerta</span>' : "") +
      '</b><div class="l">' + Dash.esc(rotulo) + "</div>" +
      (nota ? '<div class="subnote" style="margin:4px 0 0">' + Dash.esc(nota) + "</div>" : "") + "</div>";
  }

  function idf() {
    var blk = idfMes();
    if (!blk) {
      Dash.vazio($("idf-kpis"), "Sem IDF ainda — depende da credencial do gestor no coletor.");
      Dash.vazio($("idf-reguas"));
      ["idf-pessoas", "idf-alertas"].forEach(function (id) { $(id).innerHTML = ""; });
      return;
    }
    var detalhe = !!blk.feedbacks;
    if (detalhe) montarFiltrosIdf(blk); else montarFiltrosIdf({});
    var f = filtrosIdf(), sd = setorDe(blk);
    $("idf-mes").textContent = Dash.rotuloMes(blk.mes);

    var medidas = {};
    CANAIS.forEach(function (p) {
      var c = p[0];
      if (!canalAplica(c, f)) { medidas[c] = { naoAplica: true }; return; }
      medidas[c] = (detalhe && recortaCanal(c, f)) ? medirCanal(blk, c, f, sd)
        : { n: (blk[c] || {}).n, nota: (blk[c] || {}).n ? (blk[c] || {}).nota : null,
            pct_resolvido: (blk[c] || {}).pct_resolvido, oficial: true };
    });

    var partes = [];
    if (f.setor) partes.push("subsetor " + f.setor);
    if (f.cidade) partes.push(f.cidade);
    if (f.atendente) partes.push(f.atendente);
    if (F.ativo()) partes.push("OS: " + F.resumo());
    $("idf-filtro-nota").textContent = partes.length
      ? "Recorte: " + partes.join(" · ") + ". Números recontados dos feedbacks" +
        (f.cidade ? " (com cidade: do drill por cidade do WVSA, sem % resolvido — o relatório não o publica por cidade)" : "") + "."
      : "";

    $("idf-kpis").innerHTML = CANAIS.map(function (p) {
      var d = medidas[p[0]];
      if (d.naoAplica) {
        return kpiIdf(p[1], "—", false,
          p[0] === "ligacoes" ? "ligação não tem cidade no WVSA" : "subsetor e atendente não se aplicam a OS");
      }
      // Zero avaliação não é nota zero: "—", não "0,00".
      var alerta = d.nota !== null && d.nota < LIMIAR;
      return kpiIdf(p[1] + " · " + Dash.num(d.n) + " avaliações", d.n ? Dash.nota(d.nota) : "—", alerta);
    }).join("");

    $("idf-reguas").innerHTML = CANAIS.map(function (p) {
      var d = medidas[p[0]];
      if (d.naoAplica || d.pct_resolvido === null || d.pct_resolvido === undefined) {
        return '<div class="regua"><span class="rc">' + p[1] + '</span><span class="rr"></span><span class="rd">' +
          (d.naoAplica ? "não se aplica ao recorte" : "sem % resolvido no recorte") + "</span></div>";
      }
      var ok = Number(d.pct_resolvido) || 0, nao = Math.max(0, 100 - ok);
      return '<div class="regua"><span class="rc">' + p[1] + "</span>" +
        '<span class="rr"><span class="rs ok" style="width:' + ok.toFixed(1) + '%"></span>' +
        '<span class="rs no" style="width:' + nao.toFixed(1) + '%"></span>' +
        "<b>" + Dash.pct(ok, 1) + "</b></span>" +
        '<span class="rd">' + Dash.num(Math.round((d.n || 0) * nao / 100)) + " não resolvidos</span></div>";
    }).join("");

    tabelaPessoas(blk, f, sd, detalhe);
    tabelaAlertas(blk, f, sd, detalhe);
  }

  function vazioTabela(el, msg) {
    el.innerHTML = '<tbody><tr><td class="vazio-cel" style="padding:22px;text-align:center;">' + msg + "</td></tr></tbody>";
  }

  // Por atendente (ou técnico, em OS): pior média primeiro — é o alerta que se
  // procura. Linha abaixo do limiar ganha o badge.
  function tabelaPessoas(blk, f, sd, detalhe) {
    Array.prototype.forEach.call($("idf-canal").children, function (b) {
      b.classList.toggle("active", b.dataset.canal === idfCanal);
    });
    var el = $("idf-pessoas");
    if (!detalhe) { vazioTabela(el, "O detalhe por atendente passou a ser coletado em 29/09/2026."); return; }
    if (!canalAplica(idfCanal, f)) {
      vazioTabela(el, idfCanal === "ligacoes" ? "Ligação não tem cidade no WVSA." : "Subsetor e atendente não se aplicam a OS.");
      return;
    }
    var m = medirCanal(blk, idfCanal, f, sd);
    var linhas = Object.keys(m.porPessoa).filter(function (k) { return k && m.porPessoa[k].n; }).map(function (k) {
      var a = m.porPessoa[k];
      return { nome: k, n: a.n, media: a.soma / a.n, res: a.com ? a.res / a.com * 100 : null };
    }).sort(function (a, b) { return a.media - b.media || b.n - a.n; });
    if (!linhas.length) { vazioTabela(el, "Nenhuma avaliação neste recorte."); return; }
    var ehOs = idfCanal === "os";
    el.innerHTML = "<thead><tr><th>" + (ehOs ? "Técnico" : "Atendente") + "</th><th>" + (ehOs ? "Empresa" : "Subsetor") +
      '</th><th class="num">Avaliações</th><th class="num">Média</th><th class="num">' +
      (ehOs ? "Internet ok" : "Resolvido") + "</th></tr></thead><tbody>" +
      linhas.map(function (r) {
        var alerta = r.media < LIMIAR;
        var p = r.nome.indexOf(" - ");
        var nome = ehOs && p >= 0 ? r.nome.slice(p + 3) : r.nome;
        var grupo = ehOs ? (p >= 0 ? r.nome.slice(0, p) : "") : (sd[r.nome] || "—");
        return "<tr" + (alerta ? ' class="linha-alerta"' : "") + "><td>" + Dash.esc(nome) +
          (alerta ? ' <span class="badge badge-vermelho">alerta</span>' : "") + "</td><td>" + Dash.esc(grupo) +
          '</td><td class="num">' + r.n + '</td><td class="num">' + Dash.nota(r.media) + '</td><td class="num">' +
          (r.res === null ? "—" : Dash.pct(r.res, 1)) + "</td></tr>";
      }).join("") + "</tbody>";
  }

  var NOME_CANAL = { ligacoes: "Ligação", chats: "Chat", os: "OS" };
  function tabelaAlertas(blk, f, sd, detalhe) {
    var el = $("idf-alertas"), btn = $("idf-alertas-todos"), qtd = $("idf-alertas-qtd");
    btn.style.display = "none";
    if (!detalhe) { qtd.textContent = ""; vazioTabela(el, "A lista de feedbacks passou a ser coletada em 29/09/2026."); return; }
    if (f.cidade) {
      qtd.textContent = "";
      vazioTabela(el, "A lista de feedbacks do WVSA não traz a cidade — com cidade escolhida, não há como saber quais são de lá.");
      return;
    }
    var lista = (blk.alertas || []).filter(function (a) {
      return a[3] !== null && a[3] < LIMIAR && canalAplica(a[0], f) && pessoaPassa(a[0], ipessoa(a[2]), f, sd, blk.mes);
    }).sort(function (a, b) { return a[3] - b[3] || b[1] - a[1]; });
    qtd.textContent = lista.length ? Dash.num(lista.length) + " no mês" : "";
    if (!lista.length) { vazioTabela(el, "Nenhuma avaliação abaixo de " + String(LIMIAR).replace(".", ",") + " neste recorte."); return; }
    var mm = String(blk.mes).split("-")[1];
    var mostrar = idfTodos ? lista : lista.slice(0, 50);
    el.innerHTML = '<thead><tr><th>Dia</th><th>Canal</th><th>Atendente / técnico</th><th class="num">Nota</th><th>Observação</th><th>OS</th></tr></thead><tbody>' +
      mostrar.map(function (a) {
        return "<tr><td>" + String(a[1]).padStart(2, "0") + "/" + mm + "</td><td>" + NOME_CANAL[a[0]] + "</td><td>" +
          Dash.esc(ipessoa(a[2])) + '</td><td class="num"><span class="badge badge-vermelho">' + a[3] + "</span></td><td>" +
          Dash.esc(a[4] || "") + "</td><td>" + (a[5] ? "#" + a[5] : "") + "</td></tr>";
      }).join("") + "</tbody>";
    if (lista.length > 50 && !idfTodos) { btn.style.display = ""; btn.textContent = "Ver todos (" + lista.length + ")"; }
  }

  $("idf-alertas-todos").addEventListener("click", function () { idfTodos = true; idf(); });
  $("idf-canal").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-canal]");
    if (b) { idfCanal = b.dataset.canal; idf(); }
  });
  ["idf-mes-sel", "idf-setor", "idf-cidade", "idf-atendente"].forEach(function (id) {
    $(id).addEventListener("change", function () { idfTodos = false; idf(); atendimento(); });
  });

  // ---------------------------------------------------------- TMA / TMF
  var A = D.atendimento || {};
  var AC = {};
  (A.campos || []).forEach(function (c, i) { AC[c] = i; });
  function semAcento(t) {
    return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function minutos(seg) {
    if (seg === null || seg === undefined) return "—";
    var m = Math.round(seg / 60);
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0");
  }
  // Mediana aproximada: a faixa onde a contagem acumulada passa da metade.
  function medianaFaixa(faixas) {
    var tot = (faixas || []).reduce(function (s, n) { return s + n; }, 0);
    if (!tot) return null;
    var lim = A.faixas_min || [], acc = 0;
    for (var i = 0; i < faixas.length; i++) {
      acc += faixas[i];
      if (acc >= tot / 2) return i < lim.length ? "≤ " + minutos(lim[i] * 60) : "> " + minutos(lim[lim.length - 1] * 60);
    }
    return null;
  }

  function atendimento() {
    var mesIdf = $("idf-mes-sel").value;
    var blk = (A.visiveis || []).filter(function (v) { return v.mes === mesIdf; })[0] ||
              (A.visiveis || []).filter(function (v) { return v.mes === A.mes_padrao; })[0];
    var kp = $("at-kpis"), tab = $("at-tab"), nota = $("at-nota"), dep = $("at-dep");
    if (!blk) {
      Dash.vazio(kp, "O TMA/TMF do chat passou a ser coletado em 29/09/2026 (1x por dia) — a próxima coleta preenche este bloco.");
      nota.textContent = ""; tab.innerHTML = ""; dep.innerHTML = ""; dep.disabled = true;
      return;
    }
    var L = blk.linhas || [];
    var atual = dep.value, deps = {};
    L.forEach(function (r) { deps[r[AC.departamento]] = (deps[r[AC.departamento]] || 0) + r[AC.conversas]; });
    dep.disabled = false;
    dep.innerHTML = '<option value="">Todos</option>' + Object.keys(deps).sort(function (a, b) { return deps[b] - deps[a]; })
      .map(function (d) { return '<option value="' + Dash.esc(d) + '">' + Dash.esc(d) + " (" + Dash.num(deps[d]) + ")</option>"; }).join("");
    dep.value = deps[atual] ? atual : "";
    var fAt = semAcento($("idf-atendente").value);
    var linhas = L.filter(function (r) {
      return (!dep.value || r[AC.departamento] === dep.value) && (!fAt || semAcento(r[AC.atendente]) === fAt);
    });
    var tot = { conv: 0, nT: 0, sT: 0, nF: 0, sF: 0, fT: [], fF: [] };
    linhas.forEach(function (r) {
      tot.conv += r[AC.conversas]; tot.nT += r[AC.n_tma]; tot.sT += r[AC.soma_tma];
      tot.nF += r[AC.n_tmf]; tot.sF += r[AC.soma_tmf];
      (r[AC.faixas_tma] || []).forEach(function (n, i) { tot.fT[i] = (tot.fT[i] || 0) + n; });
      (r[AC.faixas_tmf] || []).forEach(function (n, i) { tot.fF[i] = (tot.fF[i] || 0) + n; });
    });
    var tma = tot.nT ? tot.sT / tot.nT : null, tmf = tot.nF ? tot.sF / tot.nF : null;
    function vsMeta(seg, chave) {
      var alvo = (A.metas || {})[chave];
      if (alvo === null || alvo === undefined || seg === null) return "";
      return " · meta " + alvo + " min";
    }
    var fora = function (seg, chave) {
      var alvo = (A.metas || {})[chave];
      return alvo !== null && alvo !== undefined && seg !== null && seg / 60 > alvo;
    };
    kp.innerHTML =
      kpiIdf("TMA · mediana " + (medianaFaixa(tot.fT) || "—") + vsMeta(tma, "tma_chat"), minutos(tma), fora(tma, "tma_chat")) +
      kpiIdf("TMF · mediana " + (medianaFaixa(tot.fF) || "—") + vsMeta(tmf, "tmf_chat"), minutos(tmf), fora(tmf, "tmf_chat")) +
      kpiIdf("Conversas em " + Dash.rotuloMes(blk.mes) + (blk.parcial ? " (parcial)" : ""), Dash.num(tot.conv), false);
    nota.textContent = "TMA = do início à última mensagem, só conversa fechada com atendente; " +
      "TMF = espera até a 1ª resposta de uma pessoa (o bot não conta). A média é puxada por conversa esquecida aberta — " +
      "leia a mediana ao lado." + (fAt ? " Atendente: " + $("idf-atendente").value + "." : "");

    var porAt = {};
    linhas.forEach(function (r) {
      var k = r[AC.atendente];
      if (!k) return;   // conversa sem atendente humano (bot) não tem TMA/TMF
      var a = porAt[k] = porAt[k] || { conv: 0, nT: 0, sT: 0, nF: 0, sF: 0 };
      a.conv += r[AC.conversas]; a.nT += r[AC.n_tma]; a.sT += r[AC.soma_tma]; a.nF += r[AC.n_tmf]; a.sF += r[AC.soma_tmf];
    });
    var ord = Object.keys(porAt).sort(function (a, b) { return porAt[b].conv - porAt[a].conv; });
    if (!ord.length) { vazioTabela(tab, "Nenhuma conversa com atendente neste recorte."); return; }
    tab.innerHTML = '<thead><tr><th>Atendente</th><th class="num">Conversas</th><th class="num">TMA</th><th class="num">TMF</th></tr></thead><tbody>' +
      ord.map(function (k) {
        var a = porAt[k], t1 = a.nT ? a.sT / a.nT : null, t2 = a.nF ? a.sF / a.nF : null;
        return "<tr><td>" + Dash.esc(k) + '</td><td class="num">' + Dash.num(a.conv) + '</td><td class="num">' +
          minutos(t1) + '</td><td class="num">' + minutos(t2) + "</td></tr>";
      }).join("") + "</tbody>";
  }
  $("at-dep").addEventListener("change", atendimento);

  idf();
  atendimento();
  // O IDF de OS obedece ao filtro global (técnico); o resto do bloco, não.
  document.addEventListener("dashfiltro", idf);

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
