// Módulo Esteira — aba Roteirizador: mapa das OS do filtro e uma rota montada à mão.
//
// Escuta `esteirafiltro` (publicado por esteira.js, dono do estado): o mapa
// mostra exatamente as OS da lista recortada, sem filtro próprio.
//
// O mapa só nasce quando a aba abre. Leaflet num contêiner oculto mede zero,
// e o `fitBounds` feito ali sobreviveria ao `invalidateSize` (§6: ele avisa o
// tamanho novo e NÃO reenquadra) — por isso `reenquadrar()` reaplica os
// limites guardados.
//
// Sem markercluster (não está vendorizado): ~1.100 `circleMarker` em SVG é a
// escala que o mapa da Troca de Poste já desenha. `L.marker` está fora por
// outro motivo: o ícone padrão do Leaflet vendorizado dá 404 (§6).
(function () {
  "use strict";
  var E = window.Esteira;
  if (!E || !window.L) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = E.esc;
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  var mapa = null, camada = null, limites = null;
  var lista = [], porOs = {};
  var LIMITE_CARDS = 300;
  // A URL de rotas do Google Maps aceita origem, destino e até 9 paradas.
  var MAX_GMAPS = 11;

  function lerRota() {
    try { return JSON.parse(localStorage.getItem("esteira.rota") || "[]").map(String); } catch (e) { return []; }
  }
  function gravarRota() {
    try { localStorage.setItem("esteira.rota", JSON.stringify(rota)); } catch (e) { /* aba anônima */ }
  }
  var rota = lerRota();
  // A rota guarda os dados da OS, não só o número: uma parada não pode sumir
  // da rota porque a OS saiu do filtro (ou da fila) depois de escolhida.
  var dadosRota = {};
  try { dadosRota = JSON.parse(localStorage.getItem("esteira.rota.dados") || "{}"); } catch (e) { dadosRota = {}; }

  function cor(o) {
    return o.hrs >= 720 ? css("--danger") : o.hrs >= 336 ? css("--warning") : css("--brand");
  }
  var PRECISAO = { street: "na rua", bairro: "no centro do bairro", city: "no centro da cidade" };

  function criar() {
    if (mapa) return;
    mapa = L.map("es-mapa", { scrollWheelZoom: true, preferCanvas: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapa);
    camada = L.layerGroup().addTo(mapa);
    mapa.setView([-27.2, -48.65], 10);
    mapa.on("popupopen", function (e) {
      var b = e.popup.getElement().querySelector("[data-rota]");
      if (b) b.addEventListener("click", function () { alternarRota(b.getAttribute("data-rota")); mapa.closePopup(); });
    });
    // Remede quando a PÁGINA muda de tamanho, não o contêiner: a medida
    // errada já escrita no contêiner não muda mais, e o observer dele nunca
    // dispararia (§6, o mesmo caso do mapa da Troca de Poste).
    if (typeof ResizeObserver === "function") {
      var t;
      new ResizeObserver(function () { clearTimeout(t); t = setTimeout(reenquadrar, 120); }).observe(document.body);
    }
  }
  function reenquadrar() {
    if (!mapa) return;
    mapa.invalidateSize();
    if (limites) mapa.fitBounds(limites, { padding: [24, 24], maxZoom: 15 });
  }

  function popup(o) {
    var a = E.agendInfo(o);
    var naRota = rota.indexOf(String(o.os)) >= 0;
    return "<b>" + E.linkOs(o) + "</b> · " + esc(o.cliente || "") +
      "<br>" + esc(o.finalidade || "") +
      "<br>" + esc(o.endereco || "(sem endereço)") + "<br>" + esc(o.bairro || "") + (o.bairro ? " · " : "") + esc(o.cidade || "") +
      '<br><span class="subnote" style="margin:0">Posição ' + esc(PRECISAO[o.geo_precisao] || "aproximada") +
      " · na fila há " + E.fmtHrs(o.hrs_parada) + "</span>" +
      '<br><span class="badge ' + a.cls + '">' + a.txt + "</span>" +
      (o.agendado_para ? " " + E.dataBr(o.agendado_para) : "") +
      '<br><button type="button" class="btn-ghost" style="margin-top:6px" data-rota="' + esc(o.os) + '">' +
      (naRota ? "Tirar da rota" : "+ Adicionar à rota") + "</button>";
  }

  function desenharMapa() {
    if (!mapa) return;
    camada.clearLayers();
    var pts = [];
    lista.forEach(function (o) {
      if (o.lat === null || o.lat === undefined || o.lng === null || o.lng === undefined) return;
      var c = cor(o);
      // Posição só da cidade é chute: anel vazado, para não parecer endereço.
      var aprox = o.geo_precisao === "city";
      var m = L.circleMarker([o.lat, o.lng], {
        radius: rota.indexOf(String(o.os)) >= 0 ? 8 : 6, color: c, weight: aprox ? 2 : 1,
        fillColor: c, fillOpacity: aprox ? 0.1 : o.geo_precisao === "bairro" ? 0.45 : 0.8,
        dashArray: aprox ? "3 3" : null,
      });
      m.bindPopup(function () { return popup(o); });
      m.addTo(camada);
      pts.push([o.lat, o.lng]);
    });
    limites = pts.length ? L.latLngBounds(pts) : null;
    reenquadrar();
  }

  function desenharCards() {
    var semPos = lista.filter(function (o) { return o.lat === null || o.lat === undefined; }).length;
    $("es-rot-contagem").textContent = "· " + E.esc(String(lista.length)) +
      (semPos ? " (" + semPos + " sem posição no mapa)" : "");
    var ord = lista.slice().sort(function (a, b) { return b.hrs - a.hrs; });
    var html = ord.slice(0, LIMITE_CARDS).map(function (o) {
      var a = E.agendInfo(o);
      var naRota = rota.indexOf(String(o.os)) >= 0;
      return '<div class="es-card' + (naRota ? " na-rota" : "") + '" data-os="' + esc(o.os) + '">' +
        '<div class="es-card-topo"><b>' + esc(o.os) + "</b> " + esc(o.cliente || "") + "</div>" +
        '<div class="subnote" style="margin:2px 0">' + esc(o.finalidade || "") + " · " + esc(o.cidade || "") +
          (o.bairro ? " · " + esc(o.bairro) : "") + "</div>" +
        '<div class="es-card-pe"><span class="badge ' + a.cls + '">' + a.txt + "</span>" +
          '<span class="subnote" style="margin:0">' + E.fmtHrs(o.hrs_parada) + "</span>" +
          '<button type="button" class="btn-ghost" data-rota="' + esc(o.os) + '">' + (naRota ? "− rota" : "+ rota") + "</button></div></div>";
    }).join("");
    if (ord.length > LIMITE_CARDS) {
      html += '<p class="subnote">Mostrando as ' + LIMITE_CARDS + " há mais tempo na fila. Refine o filtro para ver as outras " +
        (ord.length - LIMITE_CARDS) + ".</p>";
    }
    $("es-rot-cards").innerHTML = html || '<div class="vazio" style="padding:22px">Nenhuma OS no filtro.</div>';
  }

  function desenharRota() {
    $("es-rota-n").textContent = rota.length;
    $("es-rota").innerHTML = rota.map(function (n, i) {
      var o = porOs[n] || dadosRota[n] || { os: n };
      return '<li><span class="es-rota-n">' + (i + 1) + "</span><div><b>" + esc(n) + "</b> " + esc(o.cliente || "") +
        '<div class="subnote" style="margin:0">' + esc(o.endereco || "") + (o.endereco ? " · " : "") + esc(o.cidade || "") + "</div></div>" +
        '<span class="es-rota-acoes"><button type="button" class="btn-ghost" data-subir="' + esc(n) + '" title="Subir">↑</button>' +
        '<button type="button" class="btn-ghost" data-rota="' + esc(n) + '" title="Tirar">✕</button></span></li>';
    }).join("") || '<li class="subnote" style="list-style:none">Use “+ rota” nos cartões ou no mapa.</li>';
    $("es-rota-gmaps").disabled = !rota.length;
  }

  function alternarRota(n) {
    n = String(n);
    var i = rota.indexOf(n);
    if (i >= 0) { rota.splice(i, 1); delete dadosRota[n]; }
    else {
      rota.push(n);
      var o = porOs[n];
      if (o) dadosRota[n] = { os: o.os, cliente: o.cliente, endereco: o.endereco, cidade: o.cidade, lat: o.lat, lng: o.lng };
    }
    gravarRota();
    try { localStorage.setItem("esteira.rota.dados", JSON.stringify(dadosRota)); } catch (e) { /* idem */ }
    desenharRota(); desenharCards(); desenharMapa();
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("#es-rot-cards [data-rota], #es-rota [data-rota]");
    if (b) { alternarRota(b.getAttribute("data-rota")); return; }
    var s = e.target.closest("#es-rota [data-subir]");
    if (s) {
      var i = rota.indexOf(s.getAttribute("data-subir"));
      if (i > 0) { rota.splice(i - 1, 0, rota.splice(i, 1)[0]); gravarRota(); desenharRota(); }
      return;
    }
    var card = e.target.closest("#es-rot-cards .es-card");
    if (card && mapa && !e.target.closest("a")) {
      var o = porOs[card.getAttribute("data-os")];
      if (o && o.lat !== null && o.lat !== undefined) mapa.setView([o.lat, o.lng], 16);
    }
  });
  $("es-rota-limpar").addEventListener("click", function () {
    rota = []; dadosRota = {}; gravarRota();
    try { localStorage.removeItem("esteira.rota.dados"); } catch (e) { /* idem */ }
    desenharRota(); desenharCards(); desenharMapa();
  });
  $("es-rota-gmaps").addEventListener("click", function () {
    var pts = rota.map(function (n) {
      var o = porOs[n] || dadosRota[n] || {};
      if (o.lat !== null && o.lat !== undefined) return o.lat + "," + o.lng;
      return o.endereco ? [o.endereco, o.cidade, "SC", "Brasil"].filter(Boolean).join(", ") : null;
    }).filter(Boolean).slice(0, MAX_GMAPS);
    if (!pts.length) return;
    var url = pts.length === 1
      ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(pts[0])
      : "https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=" + encodeURIComponent(pts[0]) +
        "&destination=" + encodeURIComponent(pts[pts.length - 1]) +
        (pts.length > 2 ? "&waypoints=" + encodeURIComponent(pts.slice(1, -1).join("|")) : "");
    window.open(url, "_blank", "noopener");
  });

  document.addEventListener("esteirafiltro", function (e) {
    lista = e.detail.lista || [];
    porOs = {};
    lista.forEach(function (o) { porOs[String(o.os)] = o; });
    if (E.aba() !== "roteirizador") return;
    desenharCards(); desenharRota(); desenharMapa();
  });
  document.addEventListener("esteiraaba", function (e) {
    if (e.detail.aba !== "roteirizador") return;
    criar();
    desenharCards(); desenharRota(); desenharMapa();
  });
})();
