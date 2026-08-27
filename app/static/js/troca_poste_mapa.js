// Mapa do módulo Troca de Poste.
//
// Leaflet + tiles do OpenStreetMap. Só pontos: o desligamento vira um círculo
// colorido pelo risco, e o popup diz o que o técnico precisa saber antes de
// sair (endereço, janela, distância do cabo, postes, cabos identificados).
//
// Por que Leaflet e não MapLibre: aqui basta desenhar algumas centenas de
// pontos sobre um mapa raster. MapLibre é WebGL com worker próprio — mais peso
// e mais partes para quebrar, sem ganho neste uso. Se um dia o mapa precisar
// desenhar a malha de cabos como vetor, aí MapLibre passa a valer.
(function () {
  const COR = {
    critico: "#e63757", alto: "#f5803e", medio: "#e5a000",
    baixo: "#00b074", sem_rede: "#9da9bb", indeterminado: "#27bcfd",
  };
  const ROTULO = (window.__TP__ || {}).rotulos_risco || {};

  let mapa = null;
  let camada = null;
  let ultimasLinhas = [];

  function criar() {
    if (mapa) return;
    mapa = L.map("tp-mapa", { scrollWheelZoom: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapa);
    camada = L.layerGroup().addTo(mapa);
    // Litoral norte de SC: enquadramento inicial até haver ponto para ajustar.
    mapa.setView([-27.1, -48.75], 10);
  }

  function popup(l) {
    const linha = (rot, val) => (val == null || val === "" ? "" :
      `<div style="display:flex;gap:8px;justify-content:space-between"><span style="color:#5e6e82">${rot}</span><b>${val}</b></div>`);
    return `
      <div style="font-size:13px;min-width:230px">
        <div style="font-weight:700;color:#232e3c;margin-bottom:2px">${l.cidade}${l.bairro ? " · " + l.bairro : ""}</div>
        <div style="color:#5e6e82;margin-bottom:8px">${[l.tipo_via, l.logradouro].filter(Boolean).join(" ") || l.endereco}</div>
        <div style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;
                    background:${COR[l.classificacao]}22;color:${COR[l.classificacao]};margin-bottom:8px">
          ${l.risco_rotulo}
        </div>
        ${linha("Data", `${l.data_br} ${l.hora_inicio || ""}–${l.hora_fim || ""}`)}
        ${linha("Distância do cabo", l.dist_cabo != null ? Math.round(l.dist_cabo) + " m" : null)}
        ${linha("Postes no trecho", l.qtd_postes)}
        ${linha("Confiança da posição", l.geo_score != null ? Math.round(l.geo_score) + (l.geo_validacao === "ok" ? " (aceita)" : " (a revisar)") : null)}
        ${l.cabos && l.cabos.length
          ? `<div style="margin-top:8px;color:#5e6e82">Cabos</div><div style="font-size:12px">${l.cabos.slice(0, 4).join(", ")}${l.cabos.length > 4 ? ` +${l.cabos.length - 4}` : ""}</div>`
          : ""}
      </div>`;
  }

  function desenhar(linhas) {
    ultimasLinhas = linhas || [];
    if (!mapa) return;
    camada.clearLayers();

    const comCoord = ultimasLinhas.filter((l) => l.lat != null && l.lon != null);
    // Crítico por último: fica desenhado por cima e não some sob os outros.
    const ordenadas = [...comCoord].sort((a, b) =>
      (a.classificacao === "critico" ? 1 : 0) - (b.classificacao === "critico" ? 1 : 0));

    for (const l of ordenadas) {
      L.circleMarker([l.lat, l.lon], {
        radius: l.classificacao === "critico" ? 7 : 5,
        color: "#fff", weight: 1.5,
        fillColor: COR[l.classificacao] || COR.indeterminado,
        fillOpacity: 0.9,
      }).bindPopup(popup(l)).addTo(camada);
    }

    if (comCoord.length) {
      mapa.fitBounds(L.latLngBounds(comCoord.map((l) => [l.lat, l.lon])).pad(0.15));
    }

    // Sem coordenada não é "sem risco": é endereço que a geocodificação não
    // resolveu. Dizer quantos ficaram de fora evita ler o mapa como completo.
    const semCoord = ultimasLinhas.length - comCoord.length;
    const presentes = [...new Set(comCoord.map((l) => l.classificacao))];
    const legenda = presentes.map((r) =>
      `<span style="display:inline-flex;align-items:center;gap:5px">
         <span style="width:10px;height:10px;border-radius:50%;background:${COR[r]}"></span>${ROTULO[r] || r}</span>`).join("");
    document.getElementById("tp-mapa-legenda").innerHTML =
      legenda + (semCoord ? `<span class="upd-sep">·</span><span>${semCoord} sem posição</span>` : "");
  }

  window.__tpMapa = {
    atualizar: desenhar,
    aoMostrar(linhas) {
      criar();
      desenhar(linhas || ultimasLinhas);
      // O container media 0 enquanto a aba estava oculta: sem isto o Leaflet
      // desenha os tiles no tamanho errado.
      setTimeout(() => mapa.invalidateSize(), 60);
    },
  };
})();
