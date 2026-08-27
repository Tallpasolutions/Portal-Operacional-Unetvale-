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
  let camada = null;          // desligamentos
  let camadaRede = null;      // cabos + postes
  let ultimasLinhas = [];
  let redeCarregada = null;   // chave das cidades já baixadas
  let carregando = false;

  // Postes só acima deste zoom: são milhares e, de longe, viram uma mancha que
  // esconde os cabos — que é o que importa ver.
  const ZOOM_POSTES = 15;

  /**
   * Faz o mapa ocupar o que sobra da viewport.
   *
   * Calculado a partir da posição real do container, e não com um
   * `calc(100vh - Xpx)`: acima dele há topbar, abas, subtítulo e cabeçalho do
   * card, e qualquer um deles pode quebrar em duas linhas dependendo da
   * largura. Somar isso à mão daria um número que só vale numa tela.
   */
  function ajustarAltura() {
    const el = document.getElementById("tp-mapa");
    if (!el || el.offsetParent === null) return;   // aba oculta: não há o que medir
    const topo = el.getBoundingClientRect().top;

    // Primeiro palpite: o que sobra abaixo do topo do mapa.
    let altura = window.innerHeight - topo - 40;
    el.style.height = `${Math.max(360, Math.round(altura))}px`;

    // Depois corrige pelo que de fato sobrou. Abaixo do mapa ainda existem a
    // legenda da rede (que muda de altura conforme quebra de linha), o padding
    // do card e o do .content. Medir o excesso real evita somar esses valores à
    // mão — soma que erraria a cada mudança de layout ou de largura de tela.
    const excesso = document.documentElement.scrollHeight - window.innerHeight;
    if (excesso > 0) {
      altura -= excesso;
      el.style.height = `${Math.max(360, Math.round(altura))}px`;
    }
    if (mapa) mapa.invalidateSize();
  }

  window.addEventListener("resize", ajustarAltura);

  function criar() {
    if (mapa) return;
    mapa = L.map("tp-mapa", { scrollWheelZoom: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapa);
    camadaRede = L.layerGroup().addTo(mapa);   // embaixo
    camada = L.layerGroup().addTo(mapa);       // desligamentos por cima
    mapa.on("zoomend", aplicarZoomPostes);
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
    ajustarAltura();

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

  // ---- malha óptica -----------------------------------------------------
  let grupoPostes = null;

  function aplicarZoomPostes() {
    if (!grupoPostes || !mapa) return;
    const deveMostrar = mapa.getZoom() >= ZOOM_POSTES;
    if (deveMostrar && !camadaRede.hasLayer(grupoPostes)) camadaRede.addLayer(grupoPostes);
    if (!deveMostrar && camadaRede.hasLayer(grupoPostes)) camadaRede.removeLayer(grupoPostes);
    atualizarLegendaRede();
  }

  let infoRede = null;

  function desenharRede(rede) {
    infoRede = rede;
    camadaRede.clearLayers();
    grupoPostes = L.layerGroup();

    for (const c of rede.cabos) {
      L.polyline(c.coords, {
        color: c.externo ? "#2c7be5" : "#9da9bb",
        weight: 2,
        opacity: 0.75,
      }).bindPopup(
        `<div style="font-size:13px"><b>${c.sigla || "cabo"}</b><br>` +
        `<span style="color:#5e6e82">${c.tipo || "—"}${c.fibras ? " · " + c.fibras + " fibras" : ""}</span></div>`
      ).addTo(camadaRede);
    }

    for (const p of rede.postes) {
      L.circleMarker([p.lat, p.lon], {
        radius: 2.5, color: "#1f5fc0", weight: 1, fillColor: "#1f5fc0", fillOpacity: 0.8,
      }).bindPopup(`<div style="font-size:13px"><b>${p.sigla || "poste"}</b><br><span style="color:#5e6e82">poste alugado</span></div>`)
        .addTo(grupoPostes);
    }

    // Cabos ficam sob os desligamentos: o ponto vermelho não pode sumir.
    camadaRede.eachLayer((l) => l.bringToBack && l.bringToBack());
    aplicarZoomPostes();
  }

  async function carregarRede(linhas) {
    const cidades = [...new Set((linhas || []).map((l) => l.cidade))].sort();
    const chave = cidades.join("|");
    if (!cidades.length || chave === redeCarregada || carregando) { aplicarZoomPostes(); return; }
    carregando = true;
    atualizarLegendaRede("carregando");
    try {
      const r = await fetch(`/troca-poste/rede.json?cidades=${encodeURIComponent(cidades.join(","))}`);
      if (!r.ok) throw new Error(r.status);
      desenharRede(await r.json());
      redeCarregada = chave;
    } catch (e) {
      // Falhar calado aqui seria pior que não desenhar: o mapa pareceria dizer
      // "não há rede nesta região".
      infoRede = null;
      atualizarLegendaRede("erro");
      return;
    } finally {
      carregando = false;
    }
    atualizarLegendaRede();
  }

  function atualizarLegendaRede(situacao) {
    const el = document.getElementById("tp-mapa-rede");
    if (!el) return;
    if (situacao === "carregando") { el.textContent = "carregando malha…"; return; }
    if (situacao === "erro") {
      el.innerHTML = `<span style="color:#e63757">malha não carregou — o mapa mostra só os desligamentos</span>`;
      return;
    }
    if (!infoRede) { el.textContent = ""; return; }
    const postesVisiveis = mapa && mapa.getZoom() >= ZOOM_POSTES;
    el.innerHTML =
      `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:14px;height:3px;background:#2c7be5"></span>cabo externo</span>` +
      `<span class="upd-sep">·</span>` +
      `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:14px;height:3px;background:#9da9bb"></span>interno</span>` +
      `<span class="upd-sep">·</span><span>${infoRede.cabos.length} cabos</span>` +
      (infoRede.cabos_sem_geometria
        ? `<span class="upd-sep">·</span><span title="O Geogrid não forneceu coordenada para estes cabos — eles existem, apenas não podem ser desenhados">${infoRede.cabos_sem_geometria} sem geometria</span>`
        : "") +
      `<span class="upd-sep">·</span>` +
      (infoRede.postes_omitidos
        // "0 postes" seria mentira: eles existem, só não foram buscados.
        ? `<span title="Os postes só são carregados com até ${infoRede.max_cidades_com_postes} cidades no filtro — são milhares e só aparecem no zoom ${ZOOM_POSTES}+">postes não carregados (filtre por cidade)</span>`
        : `<span>${infoRede.postes.length} postes alugados${postesVisiveis ? "" : ` (zoom ${ZOOM_POSTES}+ para ver)`}</span>`);
  }

  window.__tpMapa = {
    atualizar: desenhar,
    aoMostrar(linhas) {
      ajustarAltura();
      criar();
      desenhar(linhas || ultimasLinhas);
      carregarRede(linhas || ultimasLinhas);
      // O container media 0 enquanto a aba estava oculta: sem isto o Leaflet
      // desenha os tiles no tamanho errado. O ajuste de altura roda de novo
      // aqui porque a legenda da rede só ganha altura depois de preenchida.
      setTimeout(() => { ajustarAltura(); mapa.invalidateSize(); }, 60);
    },
  };
})();
