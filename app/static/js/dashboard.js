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
  function recortaveis() { qualidade(); causaRaiz(); }
  if (window.DashFiltro) document.addEventListener("dashfiltro", recortaveis);
  else recortaveis();

  // -------------------------------------------------------- cancelamentos
  var c = D.cancelamentos || {};
  Dash.parMes($("cmt-par"), c.visiveis, function (d) { return Dash.pct(d.pct); },
    { base: function (d) { return Dash.num(d.tecnico) + " de " + Dash.num(d.total) + " cancelamentos"; },
      vazio: "Sem dados de cancelamento ainda." });

  Dash.preencherSelect($("ca-mes"), (c.visiveis || []).map(function (d) { return d.mes; }),
    c.mes_padrao);
  function cancelamentos() {
    var mes = $("ca-mes").value;
    var d = (c.visiveis || []).filter(function (x) { return x.mes === mes; })[0];
    if (!d) {
      ["ca-grupos", "ca-cidades", "ca-casa", "ca-ticket", "cmt-motivos"].forEach(function (id) { Dash.vazio($(id)); });
      return;
    }
    $("ca-total").textContent = Dash.num(d.total);
    $("ca-tec").textContent = Dash.num(d.tecnico) + " (" + Dash.pct(d.pct) + ")";
    $("ca-valor").textContent = Dash.moeda(d.valor);
    $("ca-quando").textContent = Dash.rotuloMes(d.mes);
    var nada = "Nenhum cancelamento registrado em " + Dash.rotuloMes(d.mes) + " até agora.";
    Dash.rank($("cmt-motivos"), d.motivos_tecnicos,
      { limite: 6, vazio: d.total ? "Sem motivos técnicos no mês." : nada });
    Dash.rank($("ca-grupos"), d.grupos, { limite: 10, vazio: nada });
    Dash.rank($("ca-cidades"), d.cidades, { limite: 10, destacarTopo: false, vazio: nada });
    Dash.rank($("ca-casa"), d.tempo_casa, { limite: 10, destacarTopo: false, vazio: nada });
    Dash.rank($("ca-ticket"), d.faixa_ticket, { limite: 10, destacarTopo: false, vazio: nada });
  }
  $("ca-mes").addEventListener("change", cancelamentos);
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
  var CANAIS = [["ligacoes", "Ligações"], ["chats", "Chats"], ["os", "OS"]];
  (function () {
    var i = D.idf || {};
    var atual = (i.visiveis || [])[(i.visiveis || []).length - 1];
    if (!atual) {
      Dash.vazio($("idf-kpis"), "Sem IDF ainda — depende da credencial do gestor no coletor.");
      Dash.vazio($("idf-reguas"));
      return;
    }
    $("idf-kpis").innerHTML = CANAIS.map(function (p) {
      var d = atual[p[0]] || {};
      // Zero avaliacao nao e nota zero. No dia 1 do mes o canal sem feedback
      // aparecia como "0,00", que se le como pessimo atendimento em vez de
      // "ninguem avaliou ainda".
      return kpi(p[1] + " · " + Dash.num(d.n) + " avaliações",
                 d.n ? Dash.nota(d.nota) : "—");
    }).join("");
    $("idf-mes").textContent = Dash.rotuloMes(atual.mes);
    $("idf-reguas").innerHTML = CANAIS.map(function (p) {
      var d = atual[p[0]] || {}, ok = Number(d.pct_resolvido) || 0, nao = Math.max(0, 100 - ok);
      return '<div class="regua"><span class="rc">' + p[1] + "</span>" +
        '<span class="rr"><span class="rs ok" style="width:' + ok.toFixed(1) + '%"></span>' +
        '<span class="rs no" style="width:' + nao.toFixed(1) + '%"></span>' +
        "<b>" + Dash.pct(ok, 1) + "</b></span>" +
        '<span class="rd">' + Dash.num(Math.round(d.n * nao / 100)) + " não resolvidos</span></div>";
    }).join("");
  })();

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
