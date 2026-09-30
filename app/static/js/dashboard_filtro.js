// Dashboard — filtro global: Empresa, Supervisor, Técnico e "Só ofensores".
//
// Este arquivo é DONO do estado e só dele. Os blocos da página não leem os
// controles: escutam o evento `dashfiltro` no `document` e perguntam a
// `window.DashFiltro.passa(nome, ctx)` se um técnico entra no recorte. É o
// mesmo desenho do /iqi (`iqifiltro`), pelo mesmo motivo: um filtro por bloco
// deixaria alguém ler a causa raiz de uma equipe ao lado do IQI de outra.
//
// ⚠️ A primeira publicação sai no `DOMContentLoaded`, não em
// `setTimeout(…, 0)`: os blocos são <script> que carregam DEPOIS deste, e o
// timer de 0 ms pode ser atendido entre dois <script> — a publicação cairia no
// vazio e a página nasceria sem recorte até o primeiro clique (CLAUDE.md §4).
//
// Empresa, apelido de empresa e alcance de supervisor vêm de iqi_supervisor.js
// — a MESMA definição do /iqi. Uma segunda cópia aqui perderia técnico em
// silêncio na primeira empresa nova.
(function () {
  "use strict";
  var D = window.__DASH__ || {};
  var Sup = window.__iqiSupervisor;
  var raiz = document.getElementById("dash-filtro");
  if (!raiz || !Sup) return;

  var estado = { empresas: new Set(), tecnicos: new Set(), alcanceSup: null, soOfensores: false };

  // ------------------------------------------------------------- técnicos
  // Todos os nomes que algum bloco recortável conhece. Deduplicados pela
  // chave do técnico (sem acento, espaço colapsado), porque o WVSA grafa a
  // mesma pessoa de jeitos diferentes em relatórios diferentes.
  function nomesConhecidos() {
    var porChave = {};
    function add(nome) {
      if (!nome || nome.indexOf(" - ") < 0) return;
      var k = Sup.chaveTecnico(nome);
      if (!porChave[k]) porChave[k] = nome;
    }
    ((D.causa_raiz || {}).tec || []).forEach(add);
    ["IQI", "IQM"].forEach(function (ind) {
      (((D.qualidade || {})[ind] || {}).tecnicos || []).forEach(function (t) { add(t.nome); });
    });
    // Técnico do último atendimento (cancelamento) e técnico do feedback de
    // OS (IDF): só entram nomes no formato "EMPRESA - Nome" (o `add` recusa o
    // resto), então atendente de ligação/chat não vira técnico na lista.
    (((D.cancelamentos || {}).textos || {}).tecnico || []).forEach(add);
    (((D.idf || {}).textos || {}).pessoa || []).forEach(add);
    return Object.keys(porChave).map(function (k) { return porChave[k]; })
      .sort(function (a, b) { return a.localeCompare(b, "pt-BR"); });
  }
  var NOMES = nomesConhecidos();

  // ------------------------------------------------------------ ofensores
  // Conjunto de chaves de técnico ofensor por (indicador, mês). Calculado sob
  // demanda e guardado: o mesmo mês é perguntado milhares de vezes por
  // renderização (uma por registro de categoria).
  var cacheOf = {};
  function mesWvsa(mes) {
    // "AAAA-MM" (coletas do Dashboard) -> "MM/AAAA" (payload do IQI/IQM).
    if (!mes) return mes;
    if (String(mes).indexOf("/") > 0) return mes;
    var p = String(mes).split("-");
    return p[1] + "/" + p[0];
  }
  function ofensores(ind, mes) {
    var chave = ind + "|" + mes;
    if (cacheOf[chave]) return cacheOf[chave];
    var q = (D.qualidade || {})[ind] || {};
    var i = (q.meses || []).indexOf(mesWvsa(mes));
    var s = new Set();
    if (i >= 0 && window.IqiRegras) {
      window.IqiRegras.ofensoresDoMes(q.tecnicos, i, q.minOS).ofensores.forEach(function (r) {
        s.add(Sup.chaveTecnico(r.nome));
      });
    }
    cacheOf[chave] = s;
    return s;
  }

  /**
   * O técnico `nome` ("EMPRESA - Nome") entra no recorte?
   *
   * `ctx.ind` e `ctx.mes` só importam para "Só ofensores": ofensor é por
   * indicador E por mês. Sem `ind` (cancelamento, IDF de OS), vale ser
   * ofensor em QUALQUER um dos dois indicadores naquele mês.
   */
  function passa(nome, ctx) {
    if (!nome) return !ativo();
    if (estado.empresas.size && !estado.empresas.has(Sup.empresaDe(nome))) return false;
    if (estado.alcanceSup && !Sup.filtrar([nome], estado.alcanceSup).length) return false;
    var k = Sup.chaveTecnico(nome);
    if (estado.tecnicos.size && !estado.tecnicos.has(k)) return false;
    if (estado.soOfensores) {
      var c = ctx || {};
      var inds = c.ind ? [c.ind] : ["IQI", "IQM"];
      if (!inds.some(function (ind) { return ofensores(ind, c.mes).has(k); })) return false;
    }
    return true;
  }

  function ativo() {
    return !!(estado.empresas.size || estado.tecnicos.size || estado.alcanceSup || estado.soOfensores);
  }

  /** Texto curto do recorte, para os blocos dizerem o que estão mostrando. */
  function resumo() {
    var p = [];
    if (estado.empresas.size) p.push(Array.from(estado.empresas).join(", "));
    if (estado.alcanceSup) {
      var sel = document.getElementById("df-sup");
      p.push("supervisor " + (sel && sel.selectedOptions[0] ? sel.selectedOptions[0].text : ""));
    }
    if (estado.tecnicos.size) p.push(estado.tecnicos.size + " técnico(s)");
    if (estado.soOfensores) p.push("só ofensores");
    return p.join(" · ");
  }

  // ------------------------------------------------------------- controles
  function empresas() {
    var s = new Set();
    NOMES.forEach(function (n) { var e = Sup.empresaDe(n); if (e) s.add(e); });
    return Array.from(s).sort();
  }

  function montarEmpresas() {
    var lista = document.querySelector("#df-empresa .lista-marcar");
    lista.innerHTML = empresas().map(function (e) {
      return '<label class="linha-marcar"><input type="checkbox" value="' + Dash.esc(e) + '"> ' +
        Dash.esc(e) + "</label>";
    }).join("");
    lista.addEventListener("change", function () {
      estado.empresas = new Set(Array.prototype.map.call(
        lista.querySelectorAll("input:checked"), function (i) { return i.value; }));
      montarTecnicos();
      publicar();
    });
  }

  // Técnicos agrupados por empresa, só os que sobram depois da empresa e do
  // supervisor: oferecer quem já está fora do recorte leva a pessoa a marcar
  // e ver tudo vazio sem entender por quê.
  function montarTecnicos() {
    var lista = document.querySelector("#df-tecnico .lista-marcar");
    var busca = (document.getElementById("df-busca").value || "").trim().toLowerCase();
    var grupos = {};
    NOMES.forEach(function (n) {
      var e = Sup.empresaDe(n);
      if (estado.empresas.size && !estado.empresas.has(e)) return;
      if (estado.alcanceSup && !Sup.filtrar([n], estado.alcanceSup).length) return;
      if (busca && n.toLowerCase().indexOf(busca) < 0 && !estado.tecnicos.has(Sup.chaveTecnico(n))) return;
      (grupos[e] = grupos[e] || []).push(n);
    });
    var html = Object.keys(grupos).sort().map(function (e) {
      return '<div class="grupo-titulo">' + Dash.esc(e) + "</div>" + grupos[e].map(function (n) {
        var k = Sup.chaveTecnico(n);
        return '<label class="linha-marcar"><input type="checkbox" value="' + Dash.esc(k) + '"' +
          (estado.tecnicos.has(k) ? " checked" : "") + "> " + Dash.esc(n.split(" - ").slice(1).join(" - ")) +
          "</label>";
      }).join("");
    }).join("");
    lista.innerHTML = html || '<div class="subnote" style="padding:8px">Nenhum técnico neste recorte.</div>';
  }

  function resumoDropdown(id, n, vazio, um) {
    var el = document.querySelector("#" + id + " [data-resumo]");
    if (el) el.textContent = n ? (n === 1 ? um : n + " escolhidos") : vazio;
  }

  function publicar() {
    resumoDropdown("df-empresa", estado.empresas.size, "Todas as empresas",
      Array.from(estado.empresas)[0] || "");
    resumoDropdown("df-tecnico", estado.tecnicos.size, "Todos os técnicos", "1 técnico");
    var of = document.getElementById("df-ofensores");
    of.classList.toggle("on", estado.soOfensores);
    of.setAttribute("aria-pressed", estado.soOfensores ? "true" : "false");
    // `style.display`, não o atributo `hidden`: o `.btn-ghost` tem display
    // próprio, e `hidden` perde para ele (CLAUDE.md §6).
    document.getElementById("df-limpar").style.display = ativo() ? "" : "none";
    document.getElementById("df-resumo").textContent = ativo() ? "Recorte: " + resumo() : "";
    // Os blocos que NÃO recortam por técnico ganham uma etiqueta dizendo isso
    // enquanto houver filtro. Sem ela, a esteira continuaria mostrando a
    // operação inteira ao lado de números filtrados, sem aviso nenhum.
    document.body.classList.toggle("dash-filtrado", ativo());
    document.dispatchEvent(new CustomEvent("dashfiltro", { detail: { ativo: ativo() } }));
  }

  montarEmpresas();
  montarTecnicos();

  document.querySelector("#df-tecnico .lista-marcar").addEventListener("change", function (e) {
    var i = e.target;
    if (!i || i.type !== "checkbox") return;
    if (i.checked) estado.tecnicos.add(i.value); else estado.tecnicos.delete(i.value);
    publicar();
  });
  document.getElementById("df-busca").addEventListener("input", montarTecnicos);

  // Supervisor: só aparece quando há o que escolher. `popular` desabilita o
  // select com "nenhum cadastrado" — útil no /iqi, mas aqui, numa barra que
  // é a primeira coisa da tela, seria um controle morto em destaque.
  var boxSup = document.getElementById("df-sup-box");
  if (Sup.lista && Sup.lista.length) {
    Sup.popular("df-sup", function (alcance) {
      estado.alcanceSup = alcance;
      montarTecnicos();
      publicar();
    });
  } else if (boxSup) {
    boxSup.style.display = "none";
  }

  document.getElementById("df-ofensores").addEventListener("click", function () {
    estado.soOfensores = !estado.soOfensores;
    publicar();
  });
  document.getElementById("df-limpar").addEventListener("click", function () {
    estado = { empresas: new Set(), tecnicos: new Set(), alcanceSup: null, soOfensores: false };
    raiz.querySelectorAll("input[type=checkbox]").forEach(function (i) { i.checked = false; });
    var sel = document.getElementById("df-sup");
    if (sel) sel.value = "";
    document.getElementById("df-busca").value = "";
    montarTecnicos();
    publicar();
  });

  window.DashFiltro = { passa: passa, ativo: ativo, resumo: resumo, mesWvsa: mesWvsa };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", publicar);
  } else {
    publicar();
  }
})();
