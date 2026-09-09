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
  let limites = null;         // enquadramento dos pontos, para reaplicar após o resize
  let carregando = false;

  // Postes só acima deste zoom: são milhares e, de longe, viram uma mancha que
  // esconde os cabos — que é o que importa ver.
  const ZOOM_POSTES = 15;

  // --- agrupamento por bairro/dia -----------------------------------------
  //
  // O mapa NÃO colapsa o grupo num pino só, e isso é decisão medida: em
  // 09/09/2026, dos 39 grupos com dois ou mais trechos posicionados, a
  // dispersão MEDIANA era 916 m e a máxima 12,6 km — só 6 cabiam em 200 m. Um
  // pino no centro mandaria a equipe para onde não há obra. O trecho é a
  // verdade que o mapa existe para mostrar; o grupo entra como contorno.
  //
  // O que o contorno revelou vale mais que o contorno: a dispersão é um
  // detector de geocodificação errada, e melhor que o score. Em Navegantes ·
  // PRTO DAS BALSAS, 13 dos 14 trechos estavam a ~300 m uns dos outros e UM,
  // com `validacao='revisar'` e score 28, a 7 km — sozinho ele criava os 9,2
  // km de dispersão do grupo. Nos 12 grupos com mais de 2 km, os pontos fora
  // do lugar eram sempre os `revisar`. "Este endereço está a 7 km dos outros
  // 13 do mesmo bairro no mesmo dia" é evidência; "score 28" é desconfiança.
  const DIST_SUSPEITA_M = 1500;

  /** Distância aproximada em metros. Equirretangular basta: as cidades ficam
   *  todas em ~27°S e num raio de dezenas de km, onde o erro é desprezível
   *  perto do que se quer medir (centenas de metros contra quilômetros). */
  function metros(a, b) {
    const R = 111320;
    const dLat = (b[0] - a[0]) * R;
    const dLon = (b[1] - a[1]) * R * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
    return Math.hypot(dLat, dLon);
  }

  function mediana(v) {
    const o = [...v].sort((x, y) => x - y);
    return o.length % 2 ? o[(o.length - 1) / 2] : (o[o.length / 2 - 1] + o[o.length / 2]) / 2;
  }

  /**
   * Agrupa por `grupo_chave` (carimbada pelo servidor) e marca o que está
   * fora do lugar.
   *
   * O centro é a MEDIANA das coordenadas, não a média: com um ponto a 7 km, a
   * média é puxada para o meio do nada e passa a acusar o cluster inteiro de
   * estar longe do centro. A mediana ignora o outlier, que é justamente o que
   * se quer isolar.
   *
   * ⚠️ Com apenas DOIS pontos afastados não dá para saber qual é o errado, e
   * chutar marcaria o certo metade das vezes. Aí só se marca o que a própria
   * geocodificação já não avaliza (`validacao != 'ok'`); se os dois forem
   * confiáveis, ou nenhum for, nenhum é acusado — o grupo aparece disperso e
   * quem olha decide.
   */
  function agrupar(linhas) {
    const mapaG = new Map();
    for (const l of linhas) {
      if (l.lat == null || l.lon == null) continue;
      const k = l.grupo_chave || l.id;
      if (!mapaG.has(k)) mapaG.set(k, []);
      mapaG.get(k).push(l);
    }

    const grupos = [];
    for (const [chave, itens] of mapaG) {
      const centro = [mediana(itens.map((i) => i.lat)), mediana(itens.map((i) => i.lon))];
      const dist = new Map(itens.map((i) => [i, metros(centro, [i.lat, i.lon])]));

      let fora = [];
      if (itens.length >= 3) {
        fora = itens.filter((i) => dist.get(i) > DIST_SUSPEITA_M);
      } else if (itens.length === 2 && metros([itens[0].lat, itens[0].lon],
                                              [itens[1].lat, itens[1].lon]) > DIST_SUSPEITA_M) {
        const duvidosos = itens.filter((i) => i.geo_validacao !== "ok");
        if (duvidosos.length === 1) fora = duvidosos;
      }

      const nucleo = itens.filter((i) => !fora.includes(i));
      const raio = nucleo.length > 1
        ? Math.max(...nucleo.map((i) => dist.get(i)))
        : 0;
      grupos.push({ chave, itens, centro, dist, fora, nucleo, raio });
    }
    return grupos;
  }

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

  /** Reaplica o enquadramento depois de o container mudar de tamanho.
   *
   * `invalidateSize` avisa o Leaflet do novo tamanho, mas NÃO recalcula o
   * zoom: o `fitBounds` que rodou num container menor continua valendo, e os
   * pontos ficam num canto — ou, no pior caso, o mapa abre o mundo inteiro.
   */
  function reenquadrar() {
    if (!mapa) return;
    mapa.invalidateSize();
    if (limites) mapa.fitBounds(limites);
  }

  /** Remede e reenquadra enquanto a PÁGINA ainda se assenta.
   *
   * O caso concreto: a legenda da malha só ganha altura quando o
   * `/troca-poste/rede.json` responde, e até lá ali está escrito "carregando
   * malha...". A altura do mapa calculada antes disso sobra ou falta, e nada
   * mandava recalcular.
   *
   * ⚠️ Observar o CONTAINER não resolve: se a medida errada já foi escrita,
   * ele não muda mais de tamanho e o observer nunca dispara — a medida errada
   * se protege. Quem muda é a página em volta, e é ela que se observa.
   *
   * Converge sozinho: `ajustarAltura` acaba calculando o mesmo valor, escrever
   * a mesma altura não gera novo evento, e o laço para.
   *
   * ⚠️ Medido em 09/09/2026 com o painel do navegador OCULTO, onde
   * `requestAnimationFrame` não roda e o layout fica adiado — ali o mapa
   * chegava a abrir o mundo inteiro por `?aba=mapa`. Não consegui reproduzir
   * isso com a página sendo pintada, então parte daquele sintoma pode ser do
   * ambiente de teste. O que NÃO depende disso, e é a correção que importa,
   * está no `reenquadrar`.
   */
  function observarPagina() {
    if (typeof ResizeObserver !== "function" || document.body._tpObservado) return;
    document.body._tpObservado = true;
    let pendente = null;
    new ResizeObserver(() => {
      clearTimeout(pendente);
      pendente = setTimeout(() => { ajustarAltura(); reenquadrar(); }, 80);
    }).observe(document.body);
  }

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

  function grupoDe(grupos, l) {
    return grupos.find((g) => g.itens.includes(l)) || null;
  }

  function popup(l, grupo, suspeito) {
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
        ${grupo && grupo.itens.length > 1
          ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #e3e8ef;color:#5e6e82;font-size:12px">
               Um de <b>${grupo.itens.length} trechos</b> deste bairro no mesmo dia — uma OS só.
             </div>`
          : ""}
        ${suspeito
          ? `<div style="margin-top:8px;padding:8px;border-radius:6px;background:#fdeede;color:#b65a16;font-size:12px">
               <b>Fora do lugar.</b> Está a ${(suspeito.distancia / 1000).toFixed(1)} km dos outros
               ${suspeito.grupo.nucleo.length} trechos do mesmo bairro no mesmo dia.
               ${l.geo_validacao === "ok"
                  ? "A posição foi aceita automaticamente, mas a distância não fecha — vale conferir."
                  : "A posição já estava marcada para revisão: quase certamente é a geocodificação, não a obra."}
             </div>`
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

    // O grupo entra ANTES dos pontos, para o contorno ficar por baixo deles.
    const grupos = agrupar(comCoord);
    const foraDoLugar = new Map();   // linha -> {grupo, distancia}
    for (const g of grupos) {
      if (g.nucleo.length > 1 && g.raio > 60) {
        // Contorno do NÚCLEO, não de todos os trechos: incluir o ponto
        // suspeito esticaria o círculo até ele e o faria parecer dentro do
        // bairro — apagando o próprio sinal que se quer mostrar.
        L.circle(g.centro, {
          radius: g.raio * 1.15,
          color: "#5e6e82", weight: 1, opacity: 0.35, dashArray: "4 4",
          fillColor: "#5e6e82", fillOpacity: 0.05, interactive: false,
        }).addTo(camada);
      }
      for (const l of g.fora) {
        foraDoLugar.set(l, { grupo: g, distancia: g.dist.get(l) });
        // A linha tracejada até o núcleo é o que torna o problema legível de
        // relance: um raio longo saindo de um aglomerado compacto.
        L.polyline([g.centro, [l.lat, l.lon]], {
          color: "#b65a16", weight: 1.5, opacity: 0.7,
          dashArray: "5 5", interactive: false,
        }).addTo(camada);
      }
    }

    for (const l of ordenadas) {
      const suspeito = foraDoLugar.get(l);
      L.circleMarker([l.lat, l.lon], {
        radius: l.classificacao === "critico" ? 7 : 5,
        // Anel âmbar tracejado no que está fora do lugar: a cor do
        // preenchimento continua sendo o RISCO, que é outra informação e não
        // pode ser substituída.
        color: suspeito ? "#b65a16" : "#fff",
        weight: suspeito ? 2.5 : 1.5,
        dashArray: suspeito ? "3 3" : null,
        fillColor: COR[l.classificacao] || COR.indeterminado,
        fillOpacity: 0.9,
      }).bindPopup(popup(l, grupoDe(grupos, l), suspeito)).addTo(camada);
    }

    limites = comCoord.length
      ? L.latLngBounds(comCoord.map((l) => [l.lat, l.lon])).pad(0.15) : null;
    if (limites) mapa.fitBounds(limites);
    observarPagina();
    ajustarAltura();

    // Sem coordenada não é "sem risco": é endereço que a geocodificação não
    // resolveu. Dizer quantos ficaram de fora evita ler o mapa como completo.
    const semCoord = ultimasLinhas.length - comCoord.length;
    const presentes = [...new Set(comCoord.map((l) => l.classificacao))];
    const legenda = presentes.map((r) =>
      `<span style="display:inline-flex;align-items:center;gap:5px">
         <span style="width:10px;height:10px;border-radius:50%;background:${COR[r]}"></span>${ROTULO[r] || r}</span>`).join("");
    const nGrupos = grupos.length;
    const nFora = foraDoLugar.size;
    document.getElementById("tp-mapa-legenda").innerHTML =
      legenda +
      `<span class="upd-sep">·</span><span>${nGrupos} ${nGrupos === 1 ? "bairro/dia" : "bairros/dia"}</span>` +
      (nFora ? `<span class="upd-sep">·</span>
         <span style="color:#b65a16;font-weight:600" title="Trecho a mais de ${DIST_SUSPEITA_M} m dos outros do mesmo bairro no mesmo dia — quase sempre é a geocodificação, não a obra.">
           ${nFora} fora do lugar</span>` : "") +
      (semCoord ? `<span class="upd-sep">·</span><span>${semCoord} sem posição</span>` : "");
  }

  // ---- malha óptica -----------------------------------------------------
  let grupoPostes = null;

  function aplicarZoomPostes() {
    if (!grupoPostes || !mapa) return;
    const deveMostrar = mapa.getZoom() >= ZOOM_POSTES;
    if (deveMostrar && !camadaRede.hasLayer(grupoPostes)) camadaRede.addLayer(grupoPostes);
    if (!deveMostrar && camadaRede.hasLayer(grupoPostes)) camadaRede.removeLayer(grupoPostes);
    atualizarLegendaRede();
    // A legenda acabou de ganhar altura, então o espaço que sobra para o mapa
    // mudou. Sem remedir, ele fica com a altura calculada quando ali ainda
    // estava escrito "carregando malha...".
    ajustarAltura();
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
      //
      // ⚠️ E o enquadramento tem de ser REAPLICADO depois do `invalidateSize`.
      // Este é o ponto que não depende de suposição: `invalidateSize` avisa o
      // Leaflet do novo tamanho e **não** recalcula o zoom. O `fitBounds` que
      // rodou com o container menor continua valendo, e os pontos ficam
      // apertados num canto do mapa já redimensionado.
      setTimeout(() => { ajustarAltura(); reenquadrar(); }, 60);
      // Segunda passada num quadro posterior: cobre o navegador sem
      // ResizeObserver e o caso em que a página já estava estável (aí o
      // observer não dispara, e sem isto ficaria a medida do primeiro quadro).
      requestAnimationFrame(() => requestAnimationFrame(
        () => { ajustarAltura(); reenquadrar(); }));
    },
  };
})();
