// Troca de Poste — a fila de revisão de endereço, com mapa.
//
// Por que esta tela existe: a geocodificação por consenso recusa-se a chutar.
// Quando as fontes discordam, ou quando a coordenada de uma rua é idêntica à
// de outra (o "colapso"), o sistema grava `validacao='revisar'` e NÃO
// classifica a rede — decidir sobre fibra em cima de palpite é como o script
// antigo produzia falso positivo. A fila é o que sobra para uma pessoa olhar.
//
// O que um clique aqui faz, na mesma transação (ver a migration 0012):
//   1. grava a posição como `manual`, com score 100;
//   2. **aprende o endereço** em `enderecos_alias` — na próxima coleta o mesmo
//      texto da Celesc nasce resolvido e nem consulta geocodificador;
//   3. recalcula o match, para o `indeterminado` virar o veredito de verdade.
//
// O passo 2 é o motivo de a tela existir: sem ele, revisar conserta uma linha;
// com ele, conserta o endereço para sempre. É o que faz a fila encolher.
(function () {
  const TP = window.__TP__ || {};
  const painel = document.querySelector('section[data-painel="revisao"]');
  if (!painel) return;

  let FILA = (TP.revisao || []).slice();
  let selecionado = null;
  let mapa = null;
  let pino = null;

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("pt-BR"));

  // Centro do recorte atendido (litoral/vale do Itajaí). Só serve de ponto de
  // partida para o endereço que nem coordenada sugerida tem.
  const CENTRO = [-27.1, -48.75];

  // Pino desenhado, não imagem. O `L.marker` padrão do Leaflet busca três PNGs
  // em `vendor/images/`, que a vendorização não trouxe — davam 404 e o pino
  // aparecia como um retângulo quebrado. Um `divIcon` com SVG resolve sem
  // acrescentar binário ao repositório e ainda usa os tokens de cor da casa,
  // como o resto do mapa (que desenha `circleMarker`, e por isso nunca
  // esbarrou nisso).
  const ICONE = L.divIcon({
    className: "tp-pino",
    html: '<svg viewBox="0 0 24 34" width="26" height="37" aria-hidden="true">'
        + '<path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 22 12 22s12-13 12-22C24 5.4 18.6 0 12 0z"'
        + ' fill="var(--brand)" stroke="#fff" stroke-width="2"/>'
        + '<circle cx="12" cy="12" r="4.5" fill="#fff"/></svg>',
    iconSize: [26, 37],
    // A ponta do pino é o ponto, não o centro do desenho.
    iconAnchor: [13, 36],
  });

  function avisar(msg, erro) {
    const c = $("#tp-rev-chips");
    if (!c) return;
    const cor = erro ? "background:#fdecee;color:#b21f37;" : "background:#e3f6ee;color:#0a7a52;";
    c.innerHTML = `<span class="chip" style="${cor}">${msg}</span>`;
    setTimeout(() => { if (c.firstChild) c.innerHTML = ""; }, 12000);
  }

  // ---- lista ---------------------------------------------------------------
  function motivo(i) {
    // O revisor precisa saber POR QUE a linha caiu aqui: score baixo pede
    // "confira o número", coordenada colapsada pede "esta rua foi confundida
    // com outra". São julgamentos diferentes.
    if (i.colapso) return "coordenada igual à de outra rua";
    if (i.motivo) return i.motivo;
    if (!i.providers_ok) return "nenhuma fonte respondeu";
    return "confiança abaixo do mínimo";
  }

  function render() {
    const badge = $("#tp-badge-revisao");
    if (badge) badge.textContent = FILA.length ? ` (${FILA.length})` : "";

    const aceitos = (TP.linhas || []).filter((l) => l.geo_validacao === "ok").length;
    $("#tp-rev-kpis").innerHTML = [
      `<div class="kpi"><div class="v">${fmt(FILA.length)}</div><div class="l">Na fila de revisão</div></div>`,
      `<div class="kpi"><div class="v">${fmt(FILA.filter((i) => i.colapso).length)}</div><div class="l">Coordenada confundida com outra rua</div></div>`,
      `<div class="kpi"><div class="v">${fmt(aceitos)}</div><div class="l">Aceitos automaticamente</div></div>`,
    ].join("");
    $("#tp-rev-contagem").textContent = FILA.length
      ? `${FILA.length} aguardando` : "";

    $("#tp-rev-tabela").querySelector("tbody").innerHTML = FILA.map((i, n) => `
      <tr data-n="${n}" style="cursor:pointer${selecionado === i ? ";background:var(--brand-l)" : ""}">
        <td class="num"><b>${i.score != null ? Math.round(i.score) : "—"}</b></td>
        <td>
          <b>${i.logradouro || i.endereco}</b>
          <div style="font-size:12px;color:var(--muted)">${i.cidade}${i.bairro ? " · " + i.bairro : ""}</div>
        </td>
        <td style="white-space:nowrap">${i.data_br}</td>
        <td style="font-size:12px;color:var(--muted)">${motivo(i)}</td>
      </tr>`).join("") ||
      `<tr><td colspan="4" style="text-align:center;padding:40px;color:var(--muted)">Fila vazia — nada aguardando revisão.</td></tr>`;
  }

  // ---- mapa ----------------------------------------------------------------
  function criarMapa() {
    if (mapa) return mapa;
    mapa = L.map("tp-rev-mapa", { scrollWheelZoom: true }).setView(CENTRO, 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap",
    }).addTo(mapa);
    return mapa;
  }

  function selecionar(item) {
    selecionado = item;
    criarMapa();

    const temPosicao = item.lat != null && item.lon != null;
    const alvo = temPosicao ? [item.lat, item.lon] : CENTRO;
    if (pino) { mapa.removeLayer(pino); }
    pino = L.marker(alvo, { draggable: true, icon: ICONE, autoPan: true }).addTo(mapa);
    mapa.setView(alvo, temPosicao ? 17 : 12);

    $("#tp-rev-titulo").textContent = item.logradouro || item.endereco;
    $("#tp-rev-metodo").textContent =
      `${item.cidade} · ${item.metodo || "sem método"} · ${item.providers_ok ?? 0}/${item.providers_consultados ?? 0} fontes`;
    $("#tp-rev-ajuda").innerHTML = temPosicao
      ? `Endereço da Celesc: <b>${item.endereco}</b>. O pino está onde o sistema achou ` +
        `(${motivo(item)}). Confirme se estiver certo, ou arraste até o lugar correto.`
      : `Endereço da Celesc: <b>${item.endereco}</b>. <b>Nenhuma fonte devolveu posição</b> — ` +
        `arraste o pino até o trecho antes de confirmar.`;
    $("#tp-rev-confirmar").disabled = false;
    $("#tp-rev-reprovar").disabled = false;
    render();
    setTimeout(() => {
      mapa.invalidateSize();
      // No celular a `.charts-2` vira uma coluna e o mapa fica abaixo da fila
      // inteira: clicar numa linha não mostraria nada. Só rola quando o mapa
      // está mesmo fora da tela, para não sacudir a página no desktop.
      const caixa = document.querySelector("#tp-rev-mapa").getBoundingClientRect();
      if (caixa.top > window.innerHeight - 120 || caixa.bottom < 120) {
        document.querySelector("#tp-rev-mapa").scrollIntoView({ block: "center" });
      }
    }, 60);
  }

  // ---- gravação ------------------------------------------------------------
  async function gravar(reprovar) {
    if (!selecionado) return;
    const item = selecionado;
    const botoes = [$("#tp-rev-confirmar"), $("#tp-rev-reprovar")];
    botoes.forEach((b) => { b.disabled = true; });
    const corpo = reprovar
      ? { reprovar: true }
      : { lat: pino.getLatLng().lat, lon: pino.getLatLng().lng };

    try {
      const r = await fetch(`/troca-poste/revisao/${item.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res.erro || `HTTP ${r.status}`);

      FILA = FILA.filter((i) => i !== item);
      selecionado = null;
      if (pino) { mapa.removeLayer(pino); pino = null; }
      $("#tp-rev-titulo").textContent = "Selecione um endereço";
      $("#tp-rev-metodo").textContent = "";
      render();

      // A classificação foi recalculada no banco, mas o pacote desta página é
      // anterior a isso. Dizer o resultado e oferecer o recarregamento é mais
      // honesto do que recarregar sozinho no meio de uma fila de revisão.
      avisar(reprovar
        ? `Reprovado: "${item.endereco}" saiu da fila sem coordenada.`
        : `Confirmado: "${item.endereco}" virou ${res.classificacao || "—"} e foi aprendido — ` +
          `não volta para a fila. <a href="?aba=revisao" style="color:inherit;text-decoration:underline">Atualizar a tela</a> para ver o novo risco.`);
    } catch (e) {
      botoes.forEach((b) => { b.disabled = false; });
      avisar(`Não foi possível gravar: ${e.message}`, true);
    }
  }

  // ---- eventos -------------------------------------------------------------
  $("#tp-rev-tabela").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-n]");
    if (tr) selecionar(FILA[Number(tr.dataset.n)]);
  });

  $("#tp-rev-confirmar").addEventListener("click", () => gravar(false));

  const dlg = $("#tp-dlg-reprovar");
  $("#tp-rev-reprovar").addEventListener("click", () => dlg.showModal());
  dlg.querySelectorAll("[data-fechar]").forEach((b) => b.addEventListener("click", () => dlg.close()));
  $("#tp-rev-reprovar-ok").addEventListener("click", () => { dlg.close(); gravar(true); });

  // O container mede 0 enquanto a `section` está `hidden`: o Leaflet desenha um
  // mapa de tamanho zero e só volta ao normal com `invalidateSize`.
  window.__tpRevisao = {
    aoMostrar() {
      // Cria o mapa já na abertura da aba, não só ao selecionar: sem isso o
      // lugar dele fica um retângulo branco de 420px, que parece painel
      // quebrado em vez de "escolha um endereço à esquerda".
      criarMapa();
      setTimeout(() => mapa.invalidateSize(), 60);
    },
  };

  render();
  // A aba pode já estar aberta por `?aba=revisao`. O `troca_poste.js` roda
  // ANTES deste arquivo, então o `window.__tpRevisao` que ele procura ainda não
  // existia na hora de abrir a aba — quem tem que perceber é este módulo.
  if (!painel.hidden) window.__tpRevisao.aoMostrar();
})();
