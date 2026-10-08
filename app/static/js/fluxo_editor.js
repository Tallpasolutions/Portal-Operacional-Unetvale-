// Folha de desenho do fluxograma (aba Fluxograma da página do processo).
//
// Sem framework e sem build, como o resto do portal. O documento é um objeto
// só (`doc`), desenhado inteiro por fluxo_render.js a cada mudança — com
// algumas centenas de formas isso custa poucos milissegundos, e um desenho
// incremental traria de volta a classe de defeito "a tela mostra uma coisa e
// o documento tem outra".
//
// Sem requestAnimationFrame de propósito: com o painel do navegador oculto o
// rAF não roda e a tela parece travada (CLAUDE.md §6). Tudo desenha na hora.
//
// Salvamento: automático 1,5 s depois da última mudança, com a versão lida
// (concorrência otimista). Conflito NÃO sobrescreve: a faixa oferece
// recarregar a versão do outro ou salvar a minha como cópia.
(function () {
  "use strict";
  const D = window.__FLUXO__;
  const raizEl = document.getElementById("fluxo-editor");
  if (!D || !raizEl) return;
  const F = window.FluxoFormas, R = window.FluxoRender, IT = window.FluxoIT;

  const $ = (s, el) => (el || raizEl).querySelector(s);
  const esc = R.esc;
  const folha = $(".fluxo-folha");
  const svg = $("svg.fluxo-svg");
  const mundo = svg.querySelector("#fx-mundo");
  const camada = {
    raias: mundo.querySelector("#fx-raias"), ligacoes: mundo.querySelector("#fx-ligacoes"),
    nos: mundo.querySelector("#fx-nos"), livres: mundo.querySelector("#fx-livres"),
    sobre: mundo.querySelector("#fx-sobre"),
  };
  const grade = svg.querySelector("#fx-grade");
  const props = $(".fluxo-props");
  const estadoEl = $(".fluxo-estado");
  const faixa = $(".fluxo-faixa");
  const editorTexto = $(".fluxo-texto");
  const menuProxima = $(".fluxo-proxima");

  const GRADE = 8;
  const MIN = 24;
  const LS_BACKUP = "fluxo:backup:" + D.id;
  const LS_VISTA = "fluxo:vista:" + D.id;
  const LS_CLIP = "fluxo:clip";

  // Edição no celular produz mais erro que fluxo: abaixo de 900 px a folha é
  // de leitura, com pan e pinça (decisão do plano, 08/10/2026).
  const leitura = !D.editavel || window.matchMedia("(max-width: 899px)").matches;
  raizEl.classList.toggle("somente-leitura", leitura);

  let doc = normalizar(D.documento);
  let versao = D.versao;
  let vista = { x: 40, y: 40, zoom: 1 };
  let sel = new Set();
  let ferramenta = leitura ? "mao" : "selecao";
  let formaPendente = null;
  let pairando = null;
  let arrasto = null;
  // Modo "ligar": clicou na bolinha (ou no "Ligar a uma forma existente")
  // sem arrastar — a seta acompanha o mouse e o próximo clique numa forma
  // fecha a ligação. Arrastar e soltar em cima da forma continua valendo.
  let ligando = null;
  let espaco = false;
  const desfazer = [], refazer = [];

  // ===========================================================================
  // Documento
  // ===========================================================================
  function normalizar(d) {
    d = d && typeof d === "object" ? JSON.parse(JSON.stringify(d)) : {};
    d.v = 1;
    ["raias", "nos", "ligacoes", "livres"].forEach((k) => { if (!Array.isArray(d[k])) d[k] = []; });
    delete d.vista;
    return d;
  }

  function novoId(p) {
    let id;
    do { id = p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6); }
    while (achar(id));
    return id;
  }

  function achar(id) {
    for (const [tipo, lista] of [["no", doc.nos], ["lig", doc.ligacoes], ["livre", doc.livres], ["raia", doc.raias]]) {
      const i = lista.findIndex((x) => x.id === id);
      if (i >= 0) return { tipo, obj: lista[i], lista, i };
    }
    return null;
  }
  const no = (id) => doc.nos.find((x) => x.id === id);
  const snap = (v) => Math.round(v / GRADE) * GRADE;

  function registrar() {
    desfazer.push(JSON.stringify(doc));
    if (desfazer.length > 200) desfazer.shift();
    refazer.length = 0;
  }

  function voltar(de, para) {
    if (!de.length) return;
    para.push(JSON.stringify(doc));
    doc = normalizar(JSON.parse(de.pop()));
    sel = new Set([...sel].filter((id) => achar(id)));
    mudou();
  }

  function mudou(semSalvar) {
    desenhar();
    montarProps();
    if (!semSalvar) agendarSalvar();
  }

  // ===========================================================================
  // Desenho
  // ===========================================================================
  function desenhar() {
    const c = R.camadas(doc, { sel });
    camada.raias.innerHTML = c.raias;
    camada.ligacoes.innerHTML = c.ligacoes;
    camada.nos.innerHTML = c.nos;
    camada.livres.innerHTML = c.livres;
    desenharSobre();
  }

  function aplicarVista() {
    mundo.setAttribute("transform", `translate(${vista.x} ${vista.y}) scale(${vista.zoom})`);
    grade.setAttribute("patternTransform", `translate(${vista.x} ${vista.y}) scale(${vista.zoom})`);
    const z = $("[data-zoom]");
    if (z) z.textContent = Math.round(vista.zoom * 100) + "%";
    try { localStorage.setItem(LS_VISTA, JSON.stringify(vista)); } catch (e) { /* sem storage */ }
    desenharSobre();
  }

  // Alças, portas, guias, retângulo de seleção — em coordenadas do MUNDO,
  // com o tamanho dividido pelo zoom para parecerem iguais em qualquer escala.
  function desenharSobre() {
    if (leitura) { camada.sobre.innerHTML = ""; return; }
    const z = vista.zoom, a = 7 / z, lw = 1.4 / z;
    let s = "";
    const nosSel = doc.nos.filter((x) => sel.has(x.id));
    nosSel.forEach((x) => {
      s += `<rect x="${x.x - 4 / z}" y="${x.y - 4 / z}" width="${x.w + 8 / z}" height="${x.h + 8 / z}" fill="none"` +
           ` stroke="#2c7be5" stroke-width="${lw}" stroke-dasharray="${4 / z} ${3 / z}" pointer-events="none"/>`;
    });
    if (nosSel.length === 1 && sel.size === 1 && F.forma(nosSel[0].tipo).grupo !== "raias") {
      const x = nosSel[0];
      const al = { nw: [x.x, x.y], n: [x.x + x.w / 2, x.y], ne: [x.x + x.w, x.y], e: [x.x + x.w, x.y + x.h / 2],
                   se: [x.x + x.w, x.y + x.h], s: [x.x + x.w / 2, x.y + x.h], sw: [x.x, x.y + x.h], w: [x.x, x.y + x.h / 2] };
      Object.keys(al).forEach((k) => {
        s += `<rect data-alca="${k}" x="${al[k][0] - a / 2}" y="${al[k][1] - a / 2}" width="${a}" height="${a}"` +
             ` fill="#fff" stroke="#2c7be5" stroke-width="${lw}" class="fx-alca fx-alca-${k}"/>`;
      });
    }
    if (nosSel.length === 1 && nosSel[0].tipo === "fase") {
      const x = nosSel[0];
      s += `<rect data-alca="s" x="${x.x + x.w / 2 - a / 2}" y="${x.y + x.h - a / 2}" width="${a}" height="${a}" fill="#fff" stroke="#2c7be5" stroke-width="${lw}" class="fx-alca fx-alca-s"/>`;
    }
    // Alça do trecho do meio da ligação selecionada.
    if (sel.size === 1) {
      const l = doc.ligacoes.find((x) => sel.has(x.id));
      if (l && (l.rota || "ortogonal") === "ortogonal") {
        const r = R.rota(l, R.nosPorId(doc));
        if (r && r.eixo) {
          const ps = r.pontos, i = Math.floor(ps.length / 2);
          const m = { x: (ps[i - 1].x + ps[i].x) / 2, y: (ps[i - 1].y + ps[i].y) / 2 };
          s += `<circle data-alca="meio" cx="${m.x}" cy="${m.y}" r="${5 / z}" fill="#fff" stroke="#2c7be5" stroke-width="${lw}"` +
               ` class="fx-alca fx-alca-${r.eixo === "x" ? "e" : "n"}"/>`;
        }
      }
      const rr = doc.raias.find((x) => sel.has(x.id));
      if (rr) {
        s += `<rect data-alca="raia" x="${rr.x + rr.w / 2 - 14 / z}" y="${rr.y + rr.h - 4 / z}" width="${28 / z}" height="${8 / z}" rx="${3 / z}"` +
             ` fill="#fff" stroke="#2c7be5" stroke-width="${lw}" class="fx-alca fx-alca-s"/>`;
      }
    }
    // Portas da forma sob o mouse: é dali que se puxa a seta. Enquanto uma
    // seta está sendo ligada, quem desenha as portas (de TODAS as formas) é
    // a `setaProvisoria`.
    const ligandoAgora = (arrasto && arrasto.tipo === "porta") || ligando;
    const alvo = pairando && no(pairando);
    if (alvo && !ligandoAgora && (ferramenta === "selecao" || ferramenta === "conector") && !arrasto) {
      F.forma(alvo.tipo).portas.forEach((p) => {
        const pt = F.porta(alvo, p);
        s += `<circle data-porta="${p}" data-no="${esc(alvo.id)}" cx="${pt.x}" cy="${pt.y}" r="${5.5 / z}"` +
             ` fill="#fff" stroke="#2c7be5" stroke-width="${1.6 / z}" class="fx-porta"/>`;
      });
    }
    if (arrasto) {
      if (arrasto.tipo === "marquee" && arrasto.ret) {
        const r = arrasto.ret;
        s += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="rgba(44,123,229,.08)" stroke="#2c7be5" stroke-width="${lw}" pointer-events="none"/>`;
      }
      if (arrasto.tipo === "porta") s += setaProvisoria(arrasto, z);
      (arrasto.guias || []).forEach((g) => {
        s += `<line x1="${g[0]}" y1="${g[1]}" x2="${g[2]}" y2="${g[3]}" stroke="#e63757" stroke-width="${1 / z}" stroke-dasharray="${3 / z} ${3 / z}" pointer-events="none"/>`;
      });
      if (arrasto.tipo === "caneta" && arrasto.pontos.length > 1) {
        s += `<path d="M${arrasto.pontos.map((p) => p[0] + " " + p[1]).join("L")}" stroke="#344050" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>`;
      }
      if ((arrasto.tipo === "seta" || arrasto.tipo === "linha") && arrasto.ate) {
        s += `<path d="M${arrasto.de.x} ${arrasto.de.y}L${arrasto.ate.x} ${arrasto.ate.y}" stroke="#344050" stroke-width="2" fill="none" pointer-events="none"/>`;
      }
    }
    if (ligando && !arrasto) s += setaProvisoria(ligando, z);
    camada.sobre.innerHTML = s;
  }

  // Enquanto a seta é ligada: as portas de TODAS as outras formas aparecem
  // (é para onde ela pode ir — pedido de 08/10/2026: "não aparecem as
  // bolinhas dos outros desenhos"), a porta que vai receber a seta fica verde
  // e maior, e a seta provisória gruda nela. Soltar no corpo da forma (sem
  // porta perto) marca a forma inteira de verde: liga pelo lado que olha
  // para a origem.
  function setaProvisoria(t, z) {
    if (!t.ate) return "";
    let s = "";
    doc.nos.forEach((x) => {
      if (x.id === t.de) return;
      F.forma(x.tipo).portas.forEach((k) => {
        const pt = F.porta(x, k);
        s += `<circle cx="${pt.x}" cy="${pt.y}" r="${4.5 / z}" fill="#fff" stroke="#2c7be5" stroke-width="${1.4 / z}" opacity=".85" pointer-events="none"/>`;
      });
    });
    const o = t.origem;
    const fimPorta = t.alvoPorta && no(t.alvoPorta.no) && F.porta(no(t.alvoPorta.no), t.alvoPorta.porta);
    const fim = fimPorta || t.ate;
    s += `<path d="M${o.x} ${o.y}L${fim.x} ${fim.y}" stroke="#2c7be5" stroke-width="${1.8 / z}" stroke-dasharray="${5 / z} ${4 / z}" fill="none" pointer-events="none"/>`;
    if (fimPorta) {
      s += `<circle cx="${fimPorta.x}" cy="${fimPorta.y}" r="${8 / z}" fill="#00b074" fill-opacity=".25" stroke="#00b074" stroke-width="${2.2 / z}" pointer-events="none"/>`;
    } else if (t.alvo && no(t.alvo)) {
      const alvo = no(t.alvo);
      s += `<rect x="${alvo.x - 5 / z}" y="${alvo.y - 5 / z}" width="${alvo.w + 10 / z}" height="${alvo.h + 10 / z}" rx="${6 / z}" fill="none" stroke="#00b074" stroke-width="${2 / z}" pointer-events="none"/>`;
    }
    return s;
  }

  // ===========================================================================
  // Coordenadas e vista
  // ===========================================================================
  function noMundo(ev) {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left - vista.x) / vista.zoom, y: (ev.clientY - r.top - vista.y) / vista.zoom };
  }

  function zoomEm(fator, cx, cy) {
    const z = Math.min(4, Math.max(0.1, vista.zoom * fator));
    const wx = (cx - vista.x) / vista.zoom, wy = (cy - vista.y) / vista.zoom;
    vista.zoom = z;
    vista.x = cx - wx * z;
    vista.y = cy - wy * z;
    aplicarVista();
  }

  function enquadrar() {
    const b = R.limites(doc);
    const r = svg.getBoundingClientRect();
    const W = r.width || 800, H = r.height || 500;
    const z = Math.min(1.25, Math.max(0.15, Math.min((W - 60) / (b.w || 1), (H - 60) / (b.h || 1))));
    vista = { zoom: z, x: (W - b.w * z) / 2 - b.x * z, y: (H - b.h * z) / 2 - b.y * z };
    aplicarVista();
  }

  function centralizarEm(ids) {
    const nos = doc.nos.filter((x) => ids.includes(x.id));
    if (!nos.length) return;
    const b = R.limites({ nos });
    const r = svg.getBoundingClientRect();
    vista.x = r.width / 2 - (b.x + b.w / 2) * vista.zoom;
    vista.y = r.height / 2 - (b.y + b.h / 2) * vista.zoom;
    aplicarVista();
  }

  // ===========================================================================
  // Raias
  // ===========================================================================
  function raiaDe(x, y) {
    return doc.raias.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  }

  function reatribuirRaias(nos) {
    (nos || doc.nos).forEach((x) => {
      const r = raiaDe(x.x + x.w / 2, x.y + x.h / 2);
      x.raia = r ? r.id : null;
    });
  }

  // Raias empilhadas, sem vão: mudar a altura ou a ordem de uma desloca as de
  // baixo e LEVA junto as formas de cada uma. A largura acompanha a forma mais
  // à direita, para nenhum passo ficar fora da raia de quem o executa.
  function ajustarRaias(yInicio) {
    if (!doc.raias.length) return;
    const x0 = Math.min(...doc.raias.map((r) => r.x));
    let y = yInicio == null ? Math.min(...doc.raias.map((r) => r.y)) : yInicio;
    let direita = 0;
    doc.nos.forEach((x) => { direita = Math.max(direita, x.x + x.w); });
    const w = Math.max(1200, snap(direita - x0 + 80));
    doc.raias.forEach((r) => {
      const dy = y - r.y;
      if (dy) doc.nos.forEach((x) => { if (x.raia === r.id) x.y += dy; });
      r.x = x0; r.y = y; r.w = w;
      y += r.h;
    });
  }

  // ===========================================================================
  // Criação
  // ===========================================================================
  function criarNo(tipo, cx, cy, extra) {
    const f = F.forma(tipo);
    const x = { id: novoId("n"), tipo, x: snap(cx - f.w / 2), y: snap(cy - f.h / 2), w: f.w, h: f.h, texto: "" };
    if (tipo === "terminal") {
      const temInicio = doc.nos.some((o) => o.tipo === "terminal" && IT.norm(o.texto).startsWith("inicio"));
      x.texto = temInicio ? "Fim" : "Início";
    }
    if (tipo === "conector") x.texto = "A";
    if (tipo === "fase") { x.texto = "Fase"; x.h = Math.max(f.h, doc.raias.reduce((s, r) => s + r.h, 0) || f.h); x.y = doc.raias.length ? doc.raias[0].y : x.y; }
    Object.assign(x, extra || {});
    doc.nos.push(x);
    reatribuirRaias([x]);
    return x;
  }

  function ligar(deId, dePorta, paraId, paraPorta) {
    if (deId === paraId) return null;
    const origem = no(deId);
    const l = { id: novoId("l"), de: { no: deId, porta: dePorta || "auto" }, para: { no: paraId, porta: paraPorta || "auto" },
                texto: "", rota: "ortogonal" };
    // Decisão: a primeira saída sugere "Sim", a segunda "Não". É o que quase
    // sempre se escreve, e saída sem rótulo é o aviso mais comum da conferência.
    if (origem && origem.tipo === "decisao") {
      const ja = doc.ligacoes.filter((x) => x.de.no === deId).map((x) => IT.norm(x.texto));
      l.texto = !ja.includes("sim") ? "Sim" : (!ja.includes("nao") ? "Não" : "");
    }
    if (origem && origem.tipo === "anotacao") { l.traco = "tracejado"; l.seta = "nenhuma"; }
    const destino = no(paraId);
    if (destino && destino.tipo === "anotacao") { l.traco = "tracejado"; l.seta = "nenhuma"; }
    doc.ligacoes.push(l);
    return l;
  }

  function apagarSelecao() {
    if (!sel.size) return;
    registrar();
    const ids = new Set(sel);
    doc.nos = doc.nos.filter((x) => !ids.has(x.id));
    const vivos = new Set(doc.nos.map((x) => x.id));
    doc.ligacoes = doc.ligacoes.filter((l) => !ids.has(l.id) && vivos.has(l.de.no) && vivos.has(l.para.no));
    doc.livres = doc.livres.filter((f) => !ids.has(f.id));
    const raiasFora = doc.raias.filter((r) => ids.has(r.id)).map((r) => r.id);
    if (raiasFora.length) {
      doc.raias = doc.raias.filter((r) => !ids.has(r.id));
      doc.nos.forEach((x) => { if (raiasFora.includes(x.raia)) x.raia = null; });
      ajustarRaias();
      reatribuirRaias();
    }
    sel.clear();
    mudou();
  }

  // ===========================================================================
  // Área de transferência — entre fluxos, pelo localStorage (o do sistema
  // pediria permissão e não carrega estrutura).
  // ===========================================================================
  function copiar() {
    const ids = new Set(sel);
    const nos = doc.nos.filter((x) => ids.has(x.id));
    const dentro = new Set(nos.map((x) => x.id));
    const pacote = {
      nos, livres: doc.livres.filter((f) => ids.has(f.id)),
      ligacoes: doc.ligacoes.filter((l) => dentro.has(l.de.no) && dentro.has(l.para.no)),
    };
    if (!pacote.nos.length && !pacote.livres.length) return false;
    try { localStorage.setItem(LS_CLIP, JSON.stringify(pacote)); } catch (e) { return false; }
    return true;
  }

  function colar(desloc) {
    let pacote;
    try { pacote = JSON.parse(localStorage.getItem(LS_CLIP) || "null"); } catch (e) { pacote = null; }
    if (!pacote || !(pacote.nos || []).length && !(pacote.livres || []).length) return;
    registrar();
    const d = desloc == null ? 24 : desloc;
    const novo = {};
    sel = new Set();
    (pacote.nos || []).forEach((x) => {
      const c = Object.assign({}, x, { id: novoId("n"), x: x.x + d, y: x.y + d });
      novo[x.id] = c.id;
      doc.nos.push(c); sel.add(c.id);
    });
    (pacote.ligacoes || []).forEach((l) => {
      if (!novo[l.de.no] || !novo[l.para.no]) return;
      doc.ligacoes.push(Object.assign({}, l, { id: novoId("l"), meio: null,
        de: { no: novo[l.de.no], porta: l.de.porta }, para: { no: novo[l.para.no], porta: l.para.porta } }));
    });
    (pacote.livres || []).forEach((f) => {
      const c = Object.assign({}, f, { id: novoId("f"), pontos: f.pontos.map((p) => [p[0] + d, p[1] + d]) });
      doc.livres.push(c); sel.add(c.id);
    });
    reatribuirRaias(doc.nos.filter((x) => sel.has(x.id)));
    ajustarRaias();
    mudou();
  }

  // ===========================================================================
  // Alinhar e distribuir
  // ===========================================================================
  function alinhar(modo) {
    const nos = doc.nos.filter((x) => sel.has(x.id));
    if (nos.length < 2) return;
    registrar();
    const b = R.limites({ nos });
    nos.forEach((x) => {
      if (modo === "esquerda") x.x = b.x;
      if (modo === "centro") x.x = snap(b.x + b.w / 2 - x.w / 2);
      if (modo === "direita") x.x = b.x + b.w - x.w;
      if (modo === "topo") x.y = b.y;
      if (modo === "meio") x.y = snap(b.y + b.h / 2 - x.h / 2);
      if (modo === "base") x.y = b.y + b.h - x.h;
    });
    reatribuirRaias(nos);
    mudou();
  }

  function distribuir(eixo) {
    const nos = doc.nos.filter((x) => sel.has(x.id));
    if (nos.length < 3) return;
    registrar();
    const k = eixo === "h" ? "x" : "y", t = eixo === "h" ? "w" : "h";
    nos.sort((a, b) => a[k] - b[k]);
    const ini = nos[0][k], fim = nos[nos.length - 1][k] + nos[nos.length - 1][t];
    const ocupado = nos.reduce((s, x) => s + x[t], 0);
    const vao = (fim - ini - ocupado) / (nos.length - 1);
    let p = ini;
    nos.forEach((x) => { x[k] = Math.round(p); p += x[t] + vao; });
    reatribuirRaias(nos);
    mudou();
  }

  // ===========================================================================
  // Ponteiro
  // ===========================================================================
  const ponteiros = new Map();

  function alvoDo(ev) {
    const t = ev.target;
    const alca = t.closest && t.closest("[data-alca]");
    if (alca) return { tipo: "alca", alca: alca.dataset.alca };
    const porta = t.closest && t.closest("[data-porta]");
    if (porta) return { tipo: "porta", no: porta.dataset.no, porta: porta.dataset.porta };
    const g = t.closest && t.closest(".fx-no, .fx-lig, .fx-livre, .fx-raia");
    if (!g) return { tipo: "vazio" };
    if (g.classList.contains("fx-no")) return { tipo: "no", id: g.dataset.id };
    if (g.classList.contains("fx-lig")) return { tipo: "lig", id: g.dataset.id };
    if (g.classList.contains("fx-livre")) return { tipo: "livre", id: g.dataset.id };
    // Raia só pega clique pela faixa do título: o corpo é chão, e clicar no
    // chão tem de começar a seleção por retângulo.
    if (t.closest("[data-parte=cab]")) return { tipo: "raia", id: g.dataset.id };
    return { tipo: "vazio" };
  }

  // Forma sob o ponteiro, achada pela POSIÇÃO. Durante o arrasto a folha
  // captura o ponteiro, e aí todo evento chega com `ev.target` = a folha:
  // perguntar ao evento qual forma está embaixo devolvia sempre "nenhuma", e
  // soltar a seta em cima de uma forma abria o menu de forma nova (defeito
  // relatado em 08/10/2026). Com ímã: perto da borda (18 px na tela) também
  // conta, que é onde a mão erra.
  // Destino da seta: a porta mais perto do mouse (até 16 px na tela) vale
  // ela; senão, a forma sob o mouse (com ímã) vale a forma, porta "auto".
  function destinoSob(ev, excluir) {
    const p = noMundo(ev), raio = 16 / vista.zoom;
    let perto = null, dist = Infinity;
    doc.nos.forEach((x) => {
      if (x.id === excluir) return;
      F.forma(x.tipo).portas.forEach((k) => {
        const pt = F.porta(x, k), d = Math.hypot(pt.x - p.x, pt.y - p.y);
        if (d <= raio && d < dist) { dist = d; perto = { no: x.id, porta: k }; }
      });
    });
    if (perto) return perto;
    const id = formaSob(ev, excluir);
    return id ? { no: id, porta: "auto" } : null;
  }

  function marcarDestino(t, ev) {
    const d = destinoSob(ev, t.de);
    t.alvo = d ? d.no : null;
    t.alvoPorta = d && d.porta !== "auto" ? d : null;
    return d;
  }

  function formaSob(ev, excluir) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const porta = el && el.closest && el.closest("[data-porta]");
    if (porta && porta.dataset.no !== excluir && no(porta.dataset.no)) return porta.dataset.no;
    const g = el && el.closest && el.closest("#fx-nos .fx-no");
    if (g && g.dataset.id !== excluir && no(g.dataset.id)) return g.dataset.id;
    const p = noMundo(ev), m = 18 / vista.zoom;
    let melhor = null, dist = Infinity;
    doc.nos.forEach((x) => {
      if (x.id === excluir || F.forma(x.tipo).grupo === "raias") return;
      if (p.x < x.x - m || p.x > x.x + x.w + m || p.y < x.y - m || p.y > x.y + x.h + m) return;
      const d = Math.hypot(p.x - (x.x + x.w / 2), p.y - (x.y + x.h / 2));
      if (d < dist) { dist = d; melhor = x.id; }
    });
    return melhor;
  }

  // Fecha a ligação de `t` (arrasto ou modo ligar) no destino `d`
  // ({no, porta}): a porta verde, ou a forma inteira (porta "auto").
  function concluirLigacao(t, d) {
    registrar();
    const l = ligar(t.de, t.porta, d.no, d.porta);
    if (l) sel = new Set([l.id]);
    mudou();
  }

  function entrarLigando(de, porta, origem, ate) {
    ligando = { de, porta, origem, ate: ate || origem, alvo: null };
    folha.dataset.ferramenta = "ligando";
    aviso("Clique na forma de destino. Esc cancela.");
    desenharSobre();
  }

  function sairLigando() {
    ligando = null;
    folha.dataset.ferramenta = formaPendente ? "forma" : ferramenta;
    pairando = null;
    desenharSobre();
  }

  function selecionar(id, somar) {
    if (somar) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
    else if (!sel.has(id)) sel = new Set([id]);
  }

  svg.addEventListener("pointerdown", (ev) => {
    fecharProxima();
    if (editorTexto && !editorTexto.hidden) confirmarTexto();
    ponteiros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (ponteiros.size === 2) { arrasto = { tipo: "pinca" }; return; }
    // Captura para o arrasto continuar fora da folha. Ponteiro que o
    // navegador não reconhece (caneta em alguns tablets) lança aqui, e o
    // gesto não pode morrer por causa disso.
    try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* segue sem captura */ }
    folha.focus({ preventScroll: true });
    const p = noMundo(ev);
    const alvo = alvoDo(ev);

    if (ev.button === 1 || espaco || ferramenta === "mao" || leitura) {
      arrasto = { tipo: "pan", sx: ev.clientX, sy: ev.clientY, vx: vista.x, vy: vista.y };
      folha.classList.add("arrastando");
      return;
    }
    if (ev.button !== 0) return;

    if (ligando) {
      const t = ligando, d = destinoSob(ev, t.de);
      sairLigando();
      if (d) concluirLigacao(t, d);
      else abrirProxima(t, p, ev);
      return;
    }

    if (formaPendente) {
      registrar();
      const x = criarNo(formaPendente, p.x, p.y);
      formaPendente = null;
      marcarFerramenta("selecao");
      sel = new Set([x.id]);
      ajustarRaias();
      mudou();
      return;
    }
    if (ferramenta === "caneta") { arrasto = { tipo: "caneta", pontos: [[p.x, p.y]] }; return; }
    if (ferramenta === "seta" || ferramenta === "linha") { arrasto = { tipo: ferramenta, de: p, ate: p }; return; }
    if (ferramenta === "texto" || ferramenta === "nota") {
      registrar();
      const x = criarNo(ferramenta, p.x, p.y);
      marcarFerramenta("selecao");
      sel = new Set([x.id]);
      mudou();
      editarTexto(x.id);
      return;
    }

    if (alvo.tipo === "porta") {
      const o = F.porta(no(alvo.no), alvo.porta);
      arrasto = { tipo: "porta", de: alvo.no, porta: alvo.porta, origem: o, ate: p, p0: p };
      return;
    }
    if (ferramenta === "conector" && alvo.tipo === "no") {
      const o = no(alvo.id);
      arrasto = { tipo: "porta", de: alvo.id, porta: "auto", origem: { x: o.x + o.w / 2, y: o.y + o.h / 2 }, ate: p, p0: p };
      return;
    }
    if (alvo.tipo === "alca") {
      if (alvo.alca === "meio") {
        const l = doc.ligacoes.find((x) => sel.has(x.id));
        const r = R.rota(l, R.nosPorId(doc));
        arrasto = { tipo: "meio", l, eixo: r.eixo, registrado: false };
      } else if (alvo.alca === "raia") {
        const r = doc.raias.find((x) => sel.has(x.id));
        arrasto = { tipo: "raia", r, h0: r.h, y0: p.y, registrado: false };
      } else {
        const x = doc.nos.find((o) => sel.has(o.id));
        arrasto = { tipo: "alca", alca: alvo.alca, no: x, orig: { x: x.x, y: x.y, w: x.w, h: x.h }, p0: p, registrado: false };
      }
      return;
    }
    if (alvo.tipo === "raia") {
      // Raia não se arrasta: elas são empilhadas, e a ordem muda pelos
      // botões do painel — arrastar a primeira deslocaria o diagrama inteiro.
      sel = new Set([alvo.id]);
      desenhar(); montarProps();
      return;
    }
    if (alvo.tipo === "no" || alvo.tipo === "livre") {
      selecionar(alvo.id, ev.shiftKey);
      const orig = {};
      doc.nos.forEach((x) => { if (sel.has(x.id)) orig[x.id] = { x: x.x, y: x.y }; });
      doc.livres.forEach((f) => { if (sel.has(f.id)) orig[f.id] = { pontos: f.pontos.map((q) => q.slice()) }; });
      arrasto = { tipo: "mover", p0: p, orig, principal: alvo.id, registrado: false, moveu: false };
      desenhar();
      montarProps();
      return;
    }
    if (alvo.tipo === "lig") {
      selecionar(alvo.id, ev.shiftKey);
      desenhar(); montarProps();
      return;
    }
    // vazio: seleção por retângulo
    if (!ev.shiftKey) sel = new Set();
    arrasto = { tipo: "marquee", p0: p, base: new Set(sel) };
    desenhar(); montarProps();
  });

  svg.addEventListener("pointermove", (ev) => {
    if (ponteiros.has(ev.pointerId)) {
      const antes = ponteiros.get(ev.pointerId);
      ponteiros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, ax: antes.x, ay: antes.y });
    }
    if (arrasto && arrasto.tipo === "pinca" && ponteiros.size === 2) { pinca(); return; }
    const p = noMundo(ev);
    if (!arrasto && ligando) {
      ligando.ate = p;
      marcarDestino(ligando, ev);
      desenharSobre();
      return;
    }
    if (!arrasto) {
      if (leitura) return;
      const alvo = alvoDo(ev);
      const id = alvo.tipo === "no" ? alvo.id : (alvo.tipo === "porta" ? alvo.no : null);
      if (id !== pairando) { pairando = id; desenharSobre(); }
      return;
    }
    const a = arrasto;
    if (a.tipo === "pan") {
      vista.x = a.vx + (ev.clientX - a.sx);
      vista.y = a.vy + (ev.clientY - a.sy);
      aplicarVista();
    } else if (a.tipo === "mover") {
      moverSelecao(a, p, ev.altKey);
    } else if (a.tipo === "alca") {
      redimensionar(a, p, ev.shiftKey);
    } else if (a.tipo === "meio") {
      if (!a.registrado) { registrar(); a.registrado = true; }
      a.l.meio = snap(a.eixo === "x" ? p.x : p.y);
      desenhar();
    } else if (a.tipo === "raia") {
      if (!a.registrado) { registrar(); a.registrado = true; }
      a.r.h = Math.max(120, snap(a.h0 + p.y - a.y0));
      ajustarRaias();
      desenhar();
    } else if (a.tipo === "marquee") {
      const r = { x: Math.min(a.p0.x, p.x), y: Math.min(a.p0.y, p.y), w: Math.abs(p.x - a.p0.x), h: Math.abs(p.y - a.p0.y) };
      a.ret = r;
      const dentro = (x, y, w, h) => x >= r.x && y >= r.y && x + w <= r.x + r.w && y + h <= r.y + r.h;
      sel = new Set(a.base);
      doc.nos.forEach((x) => { if (dentro(x.x, x.y, x.w, x.h)) sel.add(x.id); });
      doc.livres.forEach((f) => { if (f.pontos.every((q) => dentro(q[0], q[1], 0, 0))) sel.add(f.id); });
      desenhar();
    } else if (a.tipo === "porta") {
      a.ate = p;
      marcarDestino(a, ev);
      desenharSobre();
    } else if (a.tipo === "caneta") {
      const u = a.pontos[a.pontos.length - 1];
      if (Math.hypot(p.x - u[0], p.y - u[1]) * vista.zoom > 2) a.pontos.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
      desenharSobre();
    } else if (a.tipo === "seta" || a.tipo === "linha") {
      a.ate = ev.shiftKey ? ortogonal(a.de, p) : p;
      desenharSobre();
    }
  });

  function ortogonal(de, p) {
    return Math.abs(p.x - de.x) > Math.abs(p.y - de.y) ? { x: p.x, y: de.y } : { x: de.x, y: p.y };
  }

  function terminarPonteiro(ev) {
    ponteiros.delete(ev.pointerId);
    if (!arrasto) return;
    const a = arrasto;
    if (a.tipo === "pinca") { if (ponteiros.size < 2) arrasto = null; return; }
    arrasto = null;
    folha.classList.remove("arrastando");
    const p = noMundo(ev);
    if (a.tipo === "mover") {
      if (a.moveu) {
        reatribuirRaias(doc.nos.filter((x) => a.orig[x.id]));
        ajustarRaias();
        mudou();
      } else desenharSobre();
    } else if (a.tipo === "alca") {
      if (a.registrado) { reatribuirRaias([a.no]); ajustarRaias(); mudou(); }
    } else if (a.tipo === "meio" || a.tipo === "raia") {
      if (a.registrado) mudou();
    } else if (a.tipo === "marquee") {
      desenhar(); montarProps();
    } else if (a.tipo === "porta") {
      const d = destinoSob(ev, a.de);
      const andou = Math.hypot(p.x - a.p0.x, p.y - a.p0.y) * vista.zoom;
      if (d && andou > 6) concluirLigacao(a, d);
      else if (andou <= 6) entrarLigando(a.de, a.porta, a.origem, p);
      else abrirProxima(a, p, ev);
    } else if (a.tipo === "caneta") {
      if (a.pontos.length > 1) {
        registrar();
        doc.livres.push({ id: novoId("f"), tipo: "caneta", pontos: rdp(a.pontos, 1.2 / vista.zoom) });
        mudou();
      } else desenharSobre();
    } else if (a.tipo === "seta" || a.tipo === "linha") {
      if (Math.hypot(a.ate.x - a.de.x, a.ate.y - a.de.y) > 6) {
        registrar();
        doc.livres.push({ id: novoId("f"), tipo: a.tipo, pontos: [[snap(a.de.x), snap(a.de.y)], [snap(a.ate.x), snap(a.ate.y)]] });
        marcarFerramenta("selecao");
        mudou();
      } else desenharSobre();
    }
  }
  svg.addEventListener("pointerup", terminarPonteiro);
  svg.addEventListener("pointercancel", terminarPonteiro);
  svg.addEventListener("pointerleave", () => { if (!arrasto && pairando) { pairando = null; desenharSobre(); } });

  function pinca() {
    const [a, b] = [...ponteiros.values()];
    if (a.ax == null || b.ax == null) return;
    const d0 = Math.hypot(a.ax - b.ax, a.ay - b.ay), d1 = Math.hypot(a.x - b.x, a.y - b.y);
    const r = svg.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
    const pcx = (a.ax + b.ax) / 2 - r.left, pcy = (a.ay + b.ay) / 2 - r.top;
    vista.x += cx - pcx; vista.y += cy - pcy;
    if (d0 > 0) zoomEm(d1 / d0, cx, cy); else aplicarVista();
    a.ax = a.x; a.ay = a.y; b.ax = b.x; b.ay = b.y;
  }

  // Ramer–Douglas–Peucker: o traço da mão chega com centenas de pontos;
  // guardar todos incharia o documento sem mudar o desenho.
  function rdp(ps, tol) {
    if (ps.length < 3) return ps;
    const [a, b] = [ps[0], ps[ps.length - 1]];
    let max = 0, idx = 0;
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    for (let i = 1; i < ps.length - 1; i++) {
      const d = Math.abs(dy * ps[i][0] - dx * ps[i][1] + b[0] * a[1] - b[1] * a[0]) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max <= tol) return [a, b];
    return rdp(ps.slice(0, idx + 1), tol).slice(0, -1).concat(rdp(ps.slice(idx), tol));
  }

  // Mover com ímã: grade de 8 px e guias inteligentes (borda ou centro
  // alinhado com outra forma). Alt solta o ímã.
  function moverSelecao(a, p, livre) {
    let dx = p.x - a.p0.x, dy = p.y - a.p0.y;
    if (!a.moveu && Math.hypot(dx, dy) * vista.zoom < 3) return;
    if (!a.registrado) { registrar(); a.registrado = true; }
    a.moveu = true;
    a.guias = [];
    const prin = no(a.principal);
    if (prin && a.orig[prin.id] && !livre) {
      const o = a.orig[prin.id];
      dx = snap(o.x + dx) - o.x; dy = snap(o.y + dy) - o.y;
      const tol = 6 / vista.zoom;
      const outros = doc.nos.filter((x) => !a.orig[x.id] && F.forma(x.tipo).grupo !== "raias");
      const xsM = [0, prin.w / 2, prin.w], ysM = [0, prin.h / 2, prin.h];
      let melhorX = null, melhorY = null;
      outros.forEach((q) => {
        [q.x, q.x + q.w / 2, q.x + q.w].forEach((cx) => xsM.forEach((off) => {
          const d = cx - (o.x + dx + off);
          if (Math.abs(d) < tol && (!melhorX || Math.abs(d) < Math.abs(melhorX.d))) melhorX = { d, cx, q };
        }));
        [q.y, q.y + q.h / 2, q.y + q.h].forEach((cy) => ysM.forEach((off) => {
          const d = cy - (o.y + dy + off);
          if (Math.abs(d) < tol && (!melhorY || Math.abs(d) < Math.abs(melhorY.d))) melhorY = { d, cy, q };
        }));
      });
      if (melhorX) {
        dx += melhorX.d;
        const y0 = Math.min(o.y + dy, melhorX.q.y) - 10, y1 = Math.max(o.y + dy + prin.h, melhorX.q.y + melhorX.q.h) + 10;
        a.guias.push([melhorX.cx, y0, melhorX.cx, y1]);
      }
      if (melhorY) {
        dy += melhorY.d;
        const x0 = Math.min(o.x + dx, melhorY.q.x) - 10, x1 = Math.max(o.x + dx + prin.w, melhorY.q.x + melhorY.q.w) + 10;
        a.guias.push([x0, melhorY.cy, x1, melhorY.cy]);
      }
    } else if (!livre) { dx = snap(dx); dy = snap(dy); }
    doc.nos.forEach((x) => { const o = a.orig[x.id]; if (o) { x.x = o.x + dx; x.y = o.y + dy; } });
    doc.livres.forEach((f) => { const o = a.orig[f.id]; if (o) f.pontos = o.pontos.map((q) => [q[0] + dx, q[1] + dy]); });
    desenhar();
  }

  function redimensionar(a, p, proporcional) {
    if (!a.registrado) { registrar(); a.registrado = true; }
    const o = a.orig, x = a.no;
    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    const k = a.alca;
    if (k.includes("w")) x0 = Math.min(x1 - MIN, snap(p.x));
    if (k.includes("e")) x1 = Math.max(x0 + MIN, snap(p.x));
    if (k.includes("n")) y0 = Math.min(y1 - MIN, snap(p.y));
    if (k.includes("s")) y1 = Math.max(y0 + MIN, snap(p.y));
    if (proporcional && k.length === 2) {
      const r = o.w / o.h, w = x1 - x0;
      const h = w / r;
      if (k.includes("n")) y0 = y1 - h; else y1 = y0 + h;
    }
    x.x = x0; x.y = y0; x.w = x1 - x0; x.h = y1 - y0;
    desenhar();
  }

  // Roda do mouse: Ctrl/⌘ (ou pinça do trackpad) aproxima; sem modificador,
  // rola a folha — o gesto que o trackpad já faz.
  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    if (ev.ctrlKey || ev.metaKey) zoomEm(Math.exp(-ev.deltaY * 0.0022), ev.clientX - r.left, ev.clientY - r.top);
    else { vista.x -= ev.deltaX; vista.y -= ev.deltaY; aplicarVista(); }
  }, { passive: false });

  svg.addEventListener("dblclick", (ev) => {
    if (leitura) return;
    const alvo = alvoDo(ev);
    if (alvo.tipo === "no" || alvo.tipo === "lig" || alvo.tipo === "raia") { editarTexto(alvo.id); return; }
    if (alvo.tipo === "vazio") {
      // Duplo clique no chão escreve, como no Excalidraw.
      const p = noMundo(ev);
      registrar();
      const x = criarNo("texto", p.x, p.y);
      sel = new Set([x.id]);
      mudou();
      editarTexto(x.id);
    }
  });

  // Soltar forma arrastada da paleta.
  svg.addEventListener("dragover", (ev) => { if (!leitura) ev.preventDefault(); });
  svg.addEventListener("drop", (ev) => {
    const tipo = ev.dataTransfer.getData("text/x-fluxo-forma");
    if (!tipo || leitura) return;
    ev.preventDefault();
    const p = noMundo(ev);
    registrar();
    const x = criarNo(tipo, p.x, p.y);
    sel = new Set([x.id]);
    ajustarRaias();
    mudou();
  });

  // ===========================================================================
  // "Próxima forma": soltar a seta no vazio oferece a forma seguinte — o fluxo
  // cresce sem voltar à paleta.
  // ===========================================================================
  const PROXIMAS = ["processo", "decisao", "documento", "dados", "subprocesso", "terminal"];
  function abrirProxima(a, p, ev) {
    if (!menuProxima) return;
    const r = folha.getBoundingClientRect();
    menuProxima.innerHTML = `<button type="button" class="fluxo-proxima-existente" data-proxima="__existente">` +
      `<svg viewBox="0 0 36 22" aria-hidden="true"><path d="M3 11h22" stroke="#2c7be5" stroke-width="2" stroke-dasharray="4 3" fill="none"/>` +
      `<rect x="24" y="4" width="10" height="14" rx="2" fill="#e3f6ee" stroke="#00b074" stroke-width="1.6"/></svg>` +
      `<span>Ligar a uma forma existente</span></button>` +
      `<div class="fluxo-proxima-t">Criar e ligar</div>` + PROXIMAS.map((t) =>
      `<button type="button" data-proxima="${t}" title="${esc(F.forma(t).nome)}">${miniatura(t)}<span>${esc(F.forma(t).nome)}</span></button>`).join("");
    menuProxima.style.left = Math.min(r.width - 200, ev.clientX - r.left + 6) + "px";
    menuProxima.style.top = Math.min(r.height - 230, ev.clientY - r.top + 6) + "px";
    menuProxima.hidden = false;
    menuProxima._dados = { de: a.de, porta: a.porta, p, origem: a.origem };
  }
  function fecharProxima() { if (menuProxima) menuProxima.hidden = true; }
  if (menuProxima) menuProxima.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-proxima]");
    if (!b) return;
    const d = menuProxima._dados;
    fecharProxima();
    if (b.dataset.proxima === "__existente") { entrarLigando(d.de, d.porta, d.origem, d.p); return; }
    registrar();
    const f = F.forma(b.dataset.proxima);
    // A forma nova nasce com o lado de entrada no ponto onde a seta parou.
    const origem = no(d.de);
    const pt = d.porta && d.porta !== "auto" ? F.porta(origem, d.porta) : null;
    let cx = d.p.x, cy = d.p.y;
    if (pt && pt.dy) cy += pt.dy * f.h / 2;
    if (pt && pt.dx) cx += pt.dx * f.w / 2;
    const x = criarNo(b.dataset.proxima, cx, cy);
    ligar(d.de, d.porta, x.id, "auto");
    sel = new Set([x.id]);
    ajustarRaias();
    mudou();
    editarTexto(x.id);
  });

  // ===========================================================================
  // Texto no lugar
  // ===========================================================================
  let editando = null;
  function editarTexto(id) {
    if (leitura || !editorTexto) return;
    const ach = achar(id);
    if (!ach) return;
    const z = vista.zoom;
    let box, valor, tam = R.FONTE, alinhar = "center";
    if (ach.tipo === "no") {
      const x = ach.obj, f = F.forma(x.tipo), a = f.texto(x.w, x.h);
      box = { x: x.x + a.x, y: x.y + a.y, w: a.w, h: Math.max(a.h, 24) };
      valor = x.texto || ""; tam = x.fonte || R.FONTE;
      if (f.alinhar === "esquerda") alinhar = "left";
    } else if (ach.tipo === "lig") {
      const r = R.rota(ach.obj, R.nosPorId(doc));
      if (!r) return;
      const m = R.meioDoCaminho(r.pontos);
      box = { x: m.x - 60, y: m.y - 14, w: 120, h: 28 };
      valor = ach.obj.texto || ""; tam = 12;
    } else if (ach.tipo === "raia") {
      const rr = ach.obj;
      box = { x: rr.x + R.RAIA_CAB + 6, y: rr.y + 6, w: 220, h: 30 };
      valor = rr.titulo || ""; alinhar = "left";
    } else return;
    editando = { id, tipo: ach.tipo, original: valor };
    Object.assign(editorTexto.style, {
      left: (vista.x + box.x * z) + "px", top: (vista.y + box.y * z) + "px",
      width: Math.max(80, box.w * z) + "px", height: Math.max(26, box.h * z) + "px",
      fontSize: Math.max(11, tam * z) + "px", textAlign: alinhar,
    });
    editorTexto.value = valor;
    editorTexto.hidden = false;
    editorTexto.focus();
    editorTexto.select();
  }

  function confirmarTexto(cancelar) {
    if (!editando) return;
    const e = editando;
    editando = null;
    editorTexto.hidden = true;
    const valor = editorTexto.value.replace(/\s+$/, "");
    if (cancelar || valor === e.original) { folha.focus({ preventScroll: true }); return; }
    const ach = achar(e.id);
    if (!ach) return;
    registrar();
    if (e.tipo === "no") {
      ach.obj.texto = valor.slice(0, 1000);
      crescerParaTexto(ach.obj);
    } else if (e.tipo === "lig") ach.obj.texto = valor.slice(0, 200);
    else if (e.tipo === "raia") ach.obj.titulo = valor.slice(0, 120) || "Raia";
    folha.focus({ preventScroll: true });
    mudou();
  }

  // Texto que não cabe faz a forma crescer para baixo, em vez de vazar pela
  // borda — a forma que esconde metade do texto é a que ninguém lê.
  function crescerParaTexto(x) {
    const f = F.forma(x.tipo);
    if (f.rotuloAbaixo || f.rotuloTopo || f.semTexto) return;
    const a = f.texto(x.w, x.h);
    const precisa = R.alturaTexto(x);
    if (precisa > a.h) x.h = snap(x.h + (precisa - a.h) + 6);
  }

  if (editorTexto) {
    editorTexto.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") { ev.preventDefault(); confirmarTexto(false); }
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); confirmarTexto(false); }
      // Em rótulo de seta e título de raia, Enter confirma: não há segunda linha.
      if (ev.key === "Enter" && editando && editando.tipo !== "no") { ev.preventDefault(); confirmarTexto(false); }
    });
    editorTexto.addEventListener("blur", () => confirmarTexto(false));
  }

  // ===========================================================================
  // Teclado
  // ===========================================================================
  function digitando(ev) {
    const t = ev.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  }

  document.addEventListener("keydown", (ev) => {
    if (digitando(ev)) return;
    if (!raizEl.isConnected) return;
    const mod = ev.metaKey || ev.ctrlKey;
    const k = ev.key.toLowerCase();
    if (k === " " && !espaco) { espaco = true; folha.classList.add("mao"); ev.preventDefault(); return; }
    if (mod && k === "s") { ev.preventDefault(); salvarAgora(); return; }
    if (mod && k === "0") { ev.preventDefault(); enquadrar(); return; }
    if (mod && (k === "=" || k === "+")) { ev.preventDefault(); const r = svg.getBoundingClientRect(); zoomEm(1.2, r.width / 2, r.height / 2); return; }
    if (mod && k === "-") { ev.preventDefault(); const r = svg.getBoundingClientRect(); zoomEm(1 / 1.2, r.width / 2, r.height / 2); return; }
    if (leitura) return;
    if (mod && k === "z") { ev.preventDefault(); if (ev.shiftKey) voltar(refazer, desfazer); else voltar(desfazer, refazer); return; }
    if (mod && k === "y") { ev.preventDefault(); voltar(refazer, desfazer); return; }
    if (mod && k === "a") { ev.preventDefault(); sel = new Set(doc.nos.map((x) => x.id).concat(doc.livres.map((f) => f.id))); desenhar(); montarProps(); return; }
    if (mod && k === "c") { if (copiar()) { ev.preventDefault(); aviso("Copiado."); } return; }
    if (mod && k === "x") { if (copiar()) { ev.preventDefault(); apagarSelecao(); } return; }
    if (mod && k === "v") { ev.preventDefault(); colar(); return; }
    if (mod && k === "d") { ev.preventDefault(); if (copiar()) colar(24); return; }
    if (k === "delete" || k === "backspace") { ev.preventDefault(); apagarSelecao(); return; }
    if (k === "escape" && ligando) { sairLigando(); return; }
    if (k === "escape") {
      if (formaPendente || ferramenta !== "selecao") { formaPendente = null; marcarFerramenta("selecao"); return; }
      fecharProxima(); sel.clear(); desenhar(); montarProps(); return;
    }
    if (k === "enter" && sel.size === 1) { ev.preventDefault(); editarTexto([...sel][0]); return; }
    if (k.startsWith("arrow") && sel.size) {
      ev.preventDefault();
      const passo = ev.shiftKey ? 10 : 1;
      const dx = k === "arrowleft" ? -passo : k === "arrowright" ? passo : 0;
      const dy = k === "arrowup" ? -passo : k === "arrowdown" ? passo : 0;
      registrar();
      doc.nos.forEach((x) => { if (sel.has(x.id)) { x.x += dx; x.y += dy; } });
      doc.livres.forEach((f) => { if (sel.has(f.id)) f.pontos = f.pontos.map((q) => [q[0] + dx, q[1] + dy]); });
      reatribuirRaias(doc.nos.filter((x) => sel.has(x.id)));
      mudou();
      return;
    }
    if (mod || ev.altKey) return;
    const atalho = { v: "selecao", h: "mao", c: "conector", t: "texto", p: "caneta", n: "nota", a: "seta", l: "linha" }[k];
    if (atalho) { marcarFerramenta(atalho); }
  });
  document.addEventListener("keyup", (ev) => {
    if (ev.key === " ") { espaco = false; folha.classList.remove("mao"); }
  });

  // ===========================================================================
  // Barra
  // ===========================================================================
  function marcarFerramenta(f) {
    ferramenta = f;
    raizEl.querySelectorAll("[data-ferramenta]").forEach((b) => b.classList.toggle("on", b.dataset.ferramenta === f));
    folha.dataset.ferramenta = formaPendente ? "forma" : f;
  }

  raizEl.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || !raizEl.contains(b)) return;
    if (b.dataset.ferramenta) { formaPendente = null; marcarFerramenta(b.dataset.ferramenta); return; }
    const acao = b.dataset.acao;
    if (!acao) return;
    const r = svg.getBoundingClientRect();
    switch (acao) {
      case "desfazer": voltar(desfazer, refazer); break;
      case "refazer": voltar(refazer, desfazer); break;
      case "zoom-mais": zoomEm(1.2, r.width / 2, r.height / 2); break;
      case "zoom-menos": zoomEm(1 / 1.2, r.width / 2, r.height / 2); break;
      case "enquadrar": enquadrar(); break;
      case "grade": raizEl.classList.toggle("sem-grade"); b.classList.toggle("on"); break;
      case "foco": document.body.classList.toggle("fluxo-foco"); b.classList.toggle("on"); setTimeout(() => aplicarVista(), 0); break;
      case "png": exportarPNG(); break;
      case "svg": exportarSVG(); break;
      case "salvar-agora": salvarAgora(); break;
      case "alinhar": alinhar(b.dataset.modo); fecharDetalhes(b); break;
      case "distribuir": distribuir(b.dataset.modo); fecharDetalhes(b); break;
    }
  });

  function fecharDetalhes(b) { const d = b.closest("details"); if (d) d.open = false; }

  // ===========================================================================
  // Paleta — montada daqui, do catálogo: uma definição só das formas.
  // ===========================================================================
  function miniatura(tipo) {
    const f = F.forma(tipo);
    const c = R.camadas({ nos: [{ id: "m", tipo, x: 0, y: 0, w: f.w, h: f.h, texto: "" }], raias: [], ligacoes: [], livres: [] }, {});
    return `<svg viewBox="-3 -3 ${f.w + 6} ${f.h + 6}" aria-hidden="true" preserveAspectRatio="xMidYMid meet">${c.nos}</svg>`;
  }

  function montarPaleta() {
    const pal = $(".fluxo-paleta-formas");
    if (!pal) return;
    pal.innerHTML = F.GRUPOS.map((g) => {
      const tipos = Object.keys(F.FORMAS).filter((t) => F.FORMAS[t].grupo === g.id);
      const raiaBtn = g.id === "raias" ? `<button type="button" class="fluxo-forma" data-nova-raia="1" title="Raia: quem executa">` +
        `<svg viewBox="0 0 60 36" aria-hidden="true"><rect x="1" y="1" width="58" height="34" fill="#e7f0fd" fill-opacity=".4" stroke="#5e6e82"/><rect x="1" y="1" width="12" height="34" fill="#e7f0fd" stroke="#5e6e82"/></svg><span>Raia</span></button>` : "";
      return `<div class="fluxo-grupo" data-grupo="${g.id}"><div class="fluxo-grupo-t">${esc(g.nome)}</div><div class="fluxo-grupo-g">` +
        raiaBtn + tipos.map((t) => `<button type="button" class="fluxo-forma" draggable="true" data-forma="${t}"` +
          ` data-busca="${esc((F.FORMAS[t].nome + " " + F.FORMAS[t].dica).toLowerCase())}" title="${esc(F.FORMAS[t].nome + " — " + F.FORMAS[t].dica)}">` +
          `${miniatura(t)}<span>${esc(F.FORMAS[t].nome)}</span></button>`).join("") +
        `</div></div>`;
    }).join("");
    pal.addEventListener("dragstart", (ev) => {
      const b = ev.target.closest("[data-forma]");
      if (!b) return;
      ev.dataTransfer.setData("text/x-fluxo-forma", b.dataset.forma);
      ev.dataTransfer.effectAllowed = "copy";
    });
    pal.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      if (b.dataset.novaRaia) { novaRaia(); return; }
      // Clique: a próxima batida na folha põe a forma ali.
      formaPendente = b.dataset.forma;
      ferramenta = "selecao";
      raizEl.querySelectorAll("[data-ferramenta]").forEach((x) => x.classList.remove("on"));
      folha.dataset.ferramenta = "forma";
      aviso(`Clique na folha para pôr ${F.forma(formaPendente).nome}. Esc cancela.`);
    });
    const busca = $(".fluxo-paleta-busca");
    if (busca) busca.addEventListener("input", () => {
      const t = busca.value.trim().toLowerCase();
      pal.querySelectorAll("[data-forma]").forEach((b) => { b.hidden = t && !b.dataset.busca.includes(t); });
      pal.querySelectorAll(".fluxo-grupo").forEach((g) => {
        g.hidden = t && !g.querySelector("[data-forma]:not([hidden])");
      });
    });
  }

  function novaRaia() {
    registrar();
    const u = doc.raias[doc.raias.length - 1];
    const idx = doc.raias.length;
    const cores = ["brand", "warning", "success", "ouro", "muted"];
    doc.raias.push({ id: novoId("r"), titulo: "Nova raia", x: u ? u.x : 0, y: u ? u.y + u.h : 0,
                     w: u ? u.w : 1400, h: 240, cor: cores[idx % cores.length] });
    ajustarRaias();
    sel = new Set([doc.raias[doc.raias.length - 1].id]);
    mudou();
    editarTexto(doc.raias[doc.raias.length - 1].id);
  }

  // ===========================================================================
  // Painel de propriedades
  // ===========================================================================
  let registrouNoFoco = false;

  function swatches(atual, padrao) {
    return `<div class="fx-cores">` + F.ORDEM_CORES.map((c) =>
      `<button type="button" class="fx-cor${(atual || padrao) === c ? " on" : ""}" data-cor="${c}" title="${esc(F.CORES[c].nome)}"` +
      ` style="--c:${F.CORES[c].traco};--f:${F.CORES[c].fundo}"></button>`).join("") + `</div>`;
  }

  function opcoes(lista, atual) {
    return lista.map(([v, t]) => `<option value="${esc(v)}"${v === atual ? " selected" : ""}>${esc(t)}</option>`).join("");
  }

  function montarProps() {
    if (!props) return;
    if (leitura) { props.innerHTML = ""; return; }
    const ids = [...sel];
    let h = "";
    if (!ids.length) h = propsFolha();
    else if (ids.length === 1) {
      const a = achar(ids[0]);
      if (a.tipo === "no") h = propsNo(a.obj);
      else if (a.tipo === "lig") h = propsLig(a.obj);
      else if (a.tipo === "livre") h = propsLivre(a.obj);
      else h = propsRaia(a.obj);
    } else h = propsVarios(ids);
    props.innerHTML = h;
    registrouNoFoco = false;
  }

  function propsFolha() {
    const avisos = IT ? IT.conferir(doc) : [];
    const contagem = `${doc.nos.filter(IT.participa).length} formas · ${doc.ligacoes.length} setas · ${doc.raias.length} raias`;
    return `<h4>Folha</h4><p class="fx-sub">${contagem}</p>` +
      `<div class="fx-campo"><label>Raias <span class="rotulo-leve">quem executa</span></label>` +
      (doc.raias.length ? `<ul class="fx-raias">` + doc.raias.map((r) =>
        `<li><button type="button" class="fx-link" data-ir="${esc(r.id)}"><i style="background:${F.CORES[r.cor || "brand"].traco}"></i>${esc(r.titulo || "Raia")}</button></li>`).join("") + `</ul>`
        : `<p class="fx-sub">Nenhuma raia. Sem raia, o passo da instrução sai sem responsável.</p>`) +
      `<button type="button" class="btn-ghost" data-props="nova-raia">+ Raia</button></div>` +
      `<div class="fx-campo"><label>Conferência do fluxo</label>` +
      (avisos.length ? `<ul class="fx-avisos">` + avisos.map((a) =>
        `<li><button type="button" class="fx-link" data-ir="${esc(a.ids.join(","))}">${esc(a.texto)}</button></li>`).join("") + `</ul>`
        : `<p class="fx-ok">Tudo ligado: um Início, cada decisão com saídas rotuladas e um Fim alcançável.</p>`) + `</div>` +
      `<div class="fx-campo fx-atalhos"><label>Atalhos</label><p class="fx-sub">Arraste uma forma da paleta ou clique nela e na folha. ` +
      `Puxe a seta pelos pontos azuis da forma. Duplo clique escreve. Espaço + arrastar move a folha; Ctrl + roda aproxima. ` +
      `Ctrl+Z desfaz, Ctrl+D duplica, Del apaga, Shift seleciona vários.</p></div>`;
  }

  function propsNo(x) {
    const f = F.forma(x.tipo);
    const raias = [["", "Sem raia"]].concat(doc.raias.map((r) => [r.id, r.titulo || "Raia"]));
    let saidas = "";
    if (x.tipo === "decisao") {
      const ls = doc.ligacoes.filter((l) => l.de.no === x.id);
      saidas = `<div class="fx-campo"><label>Saídas</label>` + (ls.length ? ls.map((l) => {
        const dest = no(l.para.no);
        return `<div class="fx-saida"><input type="text" data-lig-texto="${esc(l.id)}" value="${esc(l.texto || "")}" placeholder="Sim / Não" maxlength="200">` +
               `<span>→ ${esc((dest && (dest.texto || F.forma(dest.tipo).nome)) || "?").slice(0, 28)}</span></div>`;
      }).join("") : `<p class="fx-sub">Puxe uma seta para cada resposta.</p>`) + `</div>`;
    }
    // De qual passo de qual instrução esta forma virou: mexer aqui muda o
    // papel na próxima geração.
    const naIT = (D.passos || {})[x.id] || [];
    const itHTML = naIT.length ? `<div class="fx-campo"><label>Na instrução de trabalho</label>` + naIT.map((r) =>
      `<a class="fx-link" href="${esc(D.urls.instrucao.replace("IT-XXX-000", r.it))}?rev=${r.rev}">${esc(r.it)} · passo ${r.passo} ↗</a>`).join("") + `</div>` : "";
    return `<h4>${esc(f.nome)}</h4><p class="fx-sub">${esc(f.dica || "")}</p>` + itHTML +
      (f.semTexto ? "" : `<div class="fx-campo"><label for="fx-texto">Texto</label><textarea id="fx-texto" data-prop="texto" rows="3" maxlength="1000">${esc(x.texto || "")}</textarea></div>`) +
      (f.grupo === "fluxograma" || f.grupo === "" ? `<div class="fx-campo"><label for="fx-raia">Raia <span class="rotulo-leve">responsável na instrução</span></label>` +
        `<select id="fx-raia" data-prop="raia">${opcoes(raias, x.raia || "")}</select></div>` : "") +
      `<div class="fx-campo"><label>Cor</label>${swatches(x.cor, f.cor)}</div>` +
      `<div class="fx-campo fx-linha2">` +
        `<div><label for="fx-fonte">Fonte</label><select id="fx-fonte" data-prop="fonte">${opcoes([["12", "Pequena"], ["13", "Normal"], ["15", "Grande"], ["18", "Título"]], String(x.fonte || 13))}</select></div>` +
        `<div><label for="fx-borda">Borda</label><select id="fx-borda" data-prop="borda">${opcoes([["cheia", "Contínua"], ["tracejada", "Tracejada"]], x.borda || "cheia")}</select></div>` +
      `</div>` +
      `<div class="fx-campo"><label class="fx-check"><input type="checkbox" data-prop="negrito"${x.negrito ? " checked" : ""}> Negrito</label></div>` +
      saidas +
      `<div class="fx-campo fx-botoes"><button type="button" class="btn-ghost" data-props="frente">Trazer para frente</button>` +
      `<button type="button" class="btn-ghost" data-props="tras">Enviar para trás</button>` +
      `<button type="button" class="btn-ghost" data-props="apagar">Apagar</button></div>`;
  }

  function propsLig(l) {
    const de = no(l.de.no), para = no(l.para.no);
    const nome = (x) => esc(((x && (x.texto || F.forma(x.tipo).nome)) || "?").slice(0, 30));
    return `<h4>Seta</h4><p class="fx-sub">${nome(de)} → ${nome(para)}</p>` +
      `<div class="fx-campo"><label for="fx-ltexto">Rótulo</label><input type="text" id="fx-ltexto" data-prop="texto" value="${esc(l.texto || "")}" maxlength="200" placeholder="Sim, Não, se aprovado…"></div>` +
      `<div class="fx-campo fx-linha2">` +
        `<div><label for="fx-rota">Caminho</label><select id="fx-rota" data-prop="rota">${opcoes([["ortogonal", "Em ângulo"], ["reta", "Reta"], ["curva", "Curva"]], l.rota || "ortogonal")}</select></div>` +
        `<div><label for="fx-traco">Traço</label><select id="fx-traco" data-prop="traco">${opcoes([["cheio", "Contínuo"], ["tracejado", "Tracejado"]], l.traco || "cheio")}</select></div>` +
      `</div>` +
      `<div class="fx-campo"><label for="fx-seta">Ponta</label><select id="fx-seta" data-prop="seta">${opcoes([["fim", "No destino"], ["ambas", "Nas duas pontas"], ["nenhuma", "Sem ponta"]], l.seta || "fim")}</select></div>` +
      `<p class="fx-sub">Tracejado é fluxo de informação; contínuo, a sequência do trabalho.</p>` +
      `<div class="fx-campo fx-botoes"><button type="button" class="btn-ghost" data-props="inverter">Inverter sentido</button>` +
      (typeof l.meio === "number" ? `<button type="button" class="btn-ghost" data-props="desentortar">Refazer caminho</button>` : "") +
      `<button type="button" class="btn-ghost" data-props="apagar">Apagar</button></div>`;
  }

  function propsLivre(f) {
    const nomes = { caneta: "Traço livre", seta: "Seta livre", linha: "Linha" };
    return `<h4>${nomes[f.tipo] || "Traço"}</h4>` +
      `<div class="fx-campo"><label>Cor</label>${swatches(f.cor, "muted")}</div>` +
      `<div class="fx-campo fx-linha2"><div><label for="fx-esp">Espessura</label><select id="fx-esp" data-prop="espessura">${opcoes([["1", "Fina"], ["2", "Normal"], ["4", "Grossa"]], String(f.espessura || 2))}</select></div>` +
      `<div><label for="fx-ftraco">Traço</label><select id="fx-ftraco" data-prop="traco">${opcoes([["cheio", "Contínuo"], ["tracejado", "Tracejado"]], f.traco || "cheio")}</select></div></div>` +
      `<div class="fx-campo fx-botoes"><button type="button" class="btn-ghost" data-props="apagar">Apagar</button></div>`;
  }

  function propsRaia(r) {
    const i = doc.raias.indexOf(r);
    const n = doc.nos.filter((x) => x.raia === r.id).length;
    return `<h4>Raia</h4><p class="fx-sub">${n} forma${n === 1 ? "" : "s"} dentro. O título vira o “Quem” da instrução.</p>` +
      `<div class="fx-campo"><label for="fx-rtitulo">Título</label><input type="text" id="fx-rtitulo" data-prop="titulo" value="${esc(r.titulo || "")}" maxlength="120" placeholder="Time interno, Técnico de campo…"></div>` +
      `<div class="fx-campo"><label>Cor</label>${swatches(r.cor, "brand")}</div>` +
      `<div class="fx-campo fx-botoes">` +
      `<button type="button" class="btn-ghost" data-props="subir"${i === 0 ? " disabled" : ""}>↑ Subir</button>` +
      `<button type="button" class="btn-ghost" data-props="descer"${i === doc.raias.length - 1 ? " disabled" : ""}>↓ Descer</button>` +
      `<button type="button" class="btn-ghost" data-props="apagar">Remover raia</button></div>` +
      `<p class="fx-sub">Arraste a alça de baixo para mudar a altura. Remover a raia não apaga as formas.</p>`;
  }

  function propsVarios(ids) {
    const nNos = doc.nos.filter((x) => sel.has(x.id)).length;
    return `<h4>${ids.length} itens</h4>` +
      (nNos >= 2 ? `<div class="fx-campo"><label>Alinhar</label><div class="fx-grade3">` +
        [["esquerda", "Esquerda"], ["centro", "Centro"], ["direita", "Direita"], ["topo", "Topo"], ["meio", "Meio"], ["base", "Base"]]
          .map(([m, t]) => `<button type="button" class="btn-ghost" data-alinhar="${m}">${t}</button>`).join("") + `</div></div>` : "") +
      (nNos >= 3 ? `<div class="fx-campo"><label>Distribuir</label><div class="fx-grade3">` +
        `<button type="button" class="btn-ghost" data-distribuir="h">Na horizontal</button><button type="button" class="btn-ghost" data-distribuir="v">Na vertical</button></div></div>` : "") +
      `<div class="fx-campo"><label>Cor</label>${swatches(null, null)}</div>` +
      `<div class="fx-campo fx-botoes"><button type="button" class="btn-ghost" data-props="apagar">Apagar ${ids.length}</button></div>`;
  }

  if (props) {
    props.addEventListener("focusin", (ev) => { if (ev.target.matches("[data-prop], [data-lig-texto]")) registrouNoFoco = false; });
    props.addEventListener("input", (ev) => {
      const t = ev.target;
      if (!t.matches("[data-prop], [data-lig-texto]") || t.type === "checkbox" || t.tagName === "SELECT") return;
      // Digitar no painel registra UMA entrada de desfazer por campo, não uma
      // por letra.
      if (!registrouNoFoco) { registrar(); registrouNoFoco = true; }
      aplicarProp(t);
      desenhar();
      agendarSalvar();
    });
    props.addEventListener("change", (ev) => {
      const t = ev.target;
      if (!t.matches("[data-prop], [data-lig-texto]")) return;
      if (t.type === "checkbox" || t.tagName === "SELECT") {
        registrar();
        aplicarProp(t);
        if (t.dataset.prop === "raia") ajustarRaias();
        mudou();
      } else {
        const x = no([...sel][0]);
        if (x && t.dataset.prop === "texto") { crescerParaTexto(x); desenhar(); }
        montarProps();
      }
    });
    props.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      if (b.dataset.cor) {
        registrar();
        sel.forEach((id) => { const a = achar(id); if (a) a.obj.cor = b.dataset.cor; });
        mudou();
        return;
      }
      if (b.dataset.ir != null) {
        const ids = b.dataset.ir.split(",").filter(Boolean);
        if (ids.length) { sel = new Set(ids); centralizarEm(ids); desenhar(); montarProps(); }
        return;
      }
      if (b.dataset.alinhar) { alinhar(b.dataset.alinhar); return; }
      if (b.dataset.distribuir) { distribuir(b.dataset.distribuir); return; }
      const a = b.dataset.props;
      const alvo = sel.size === 1 ? achar([...sel][0]) : null;
      if (a === "nova-raia") { novaRaia(); return; }
      if (a === "apagar") { apagarSelecao(); return; }
      if (!alvo) return;
      registrar();
      if (a === "frente" || a === "tras") {
        alvo.lista.splice(alvo.i, 1);
        if (a === "frente") alvo.lista.push(alvo.obj); else alvo.lista.unshift(alvo.obj);
      } else if (a === "inverter") {
        const t = alvo.obj.de; alvo.obj.de = alvo.obj.para; alvo.obj.para = t; alvo.obj.meio = null;
      } else if (a === "desentortar") {
        alvo.obj.meio = null;
      } else if (a === "subir" || a === "descer") {
        const i = alvo.i, j = a === "subir" ? i - 1 : i + 1;
        if (j < 0 || j >= doc.raias.length) return;
        // Trocar a ordem leva as formas junto: o empilhamento recalcula o y de
        // cada raia a partir do topo de antes, e cada uma arrasta as suas.
        const y0 = Math.min(...doc.raias.map((r) => r.y));
        [doc.raias[i], doc.raias[j]] = [doc.raias[j], doc.raias[i]];
        ajustarRaias(y0);
      }
      mudou();
    });
  }

  function aplicarProp(t) {
    if (t.dataset.ligTexto) {
      const l = doc.ligacoes.find((x) => x.id === t.dataset.ligTexto);
      if (l) l.texto = t.value.slice(0, 200);
      return;
    }
    const a = achar([...sel][0]);
    if (!a) return;
    const k = t.dataset.prop;
    let v = t.type === "checkbox" ? t.checked : t.value;
    if (k === "fonte" || k === "espessura") v = Number(v);
    if (k === "raia") {
      // Escolher a raia no painel MOVE a forma para dentro dela: raia escrita
      // no painel e forma desenhada em outra raia seriam duas verdades.
      a.obj.raia = v || null;
      const r = doc.raias.find((x) => x.id === v);
      if (r && (a.obj.y < r.y || a.obj.y + a.obj.h > r.y + r.h)) a.obj.y = snap(r.y + r.h / 2 - a.obj.h / 2);
      return;
    }
    a.obj[k] = v;
  }

  // ===========================================================================
  // Salvamento
  // ===========================================================================
  let sujo = false, salvando = false, timer = null, tentativa = 0, conflito = false, salvoEm = Date.now();
  let erroFixo = null;

  function estado(txt, classe) {
    if (!estadoEl) return;
    estadoEl.textContent = txt;
    estadoEl.className = "fluxo-estado" + (classe ? " " + classe : "");
  }

  function relogio() {
    if (sujo || salvando || conflito || erroFixo || leitura) return;
    const s = Math.round((Date.now() - salvoEm) / 1000);
    estado(s < 5 ? "Salvo agora" : s < 60 ? `Salvo há ${s} s` : `Salvo há ${Math.round(s / 60)} min`, "ok");
  }
  setInterval(relogio, 5000);

  function guardarBackup() {
    try { localStorage.setItem(LS_BACKUP, JSON.stringify({ doc, versao, quando: Date.now() })); } catch (e) { /* cheio ou bloqueado */ }
  }
  function limparBackup() { try { localStorage.removeItem(LS_BACKUP); } catch (e) { /* idem */ } }

  function agendarSalvar() {
    if (leitura) return;
    sujo = true;
    erroFixo = null;
    if (!conflito) estado("Alterações não salvas", "pendente");
    guardarBackup();
    clearTimeout(timer);
    timer = setTimeout(salvar, 1500);
  }

  function salvarAgora() { clearTimeout(timer); if (sujo) salvar(); else aviso("Nada a salvar."); }

  async function salvar() {
    if (!sujo || salvando || conflito || leitura) return;
    salvando = true;
    estado("Salvando…", "pendente");
    const enviado = JSON.stringify(doc);
    try {
      const r = await fetch(D.urls.salvar, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: JSON.parse(enviado), versao }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        versao = j.versao;
        salvoEm = Date.now();
        tentativa = 0;
        if (JSON.stringify(doc) === enviado) { sujo = false; limparBackup(); relogio(); }
        else { salvando = false; agendarSalvar(); return; }
      } else if (r.status === 409) {
        conflito = true;
        mostrarConflito(j);
      } else if (r.status >= 400 && r.status < 500) {
        // Documento recusado: tentar de novo daria o mesmo erro. Fica no
        // backup local até alguém corrigir o que foi apontado.
        erroFixo = j.erro || "O servidor recusou o fluxo.";
        estado("Não salvo: " + erroFixo, "erro");
      } else throw new Error("HTTP " + r.status);
    } catch (e) {
      tentativa++;
      const espera = Math.min(30000, 2000 * Math.pow(2, tentativa - 1));
      estado(`Sem conexão — tentando de novo em ${Math.round(espera / 1000)} s`, "erro");
      clearTimeout(timer);
      timer = setTimeout(salvar, espera);
    } finally {
      salvando = false;
    }
  }

  function mostrarFaixa(html, classe) {
    if (!faixa) return;
    faixa.innerHTML = html;
    faixa.className = "fluxo-faixa " + (classe || "");
    faixa.hidden = false;
  }

  function mostrarConflito(j) {
    estado("Conflito — não salvo", "erro");
    const quem = (j.por_nome || "Outra pessoa");
    const quando = j.em_hora ? ` às ${j.em_hora}` : "";
    mostrarFaixa(`<b>${esc(quem)} salvou este fluxo${esc(quando)} enquanto você editava.</b> ` +
      `Nada foi sobrescrito: suas alterações estão guardadas neste navegador.` +
      `<span class="fluxo-faixa-acoes"><button type="button" class="btn sec" data-faixa="recarregar">Ver a versão de ${esc(quem)}</button>` +
      `<button type="button" class="btn" data-faixa="copia">Salvar a minha como cópia</button></span>`, "erro");
  }

  if (faixa) faixa.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-faixa]");
    if (!b) return;
    const a = b.dataset.faixa;
    if (a === "recarregar") { limparBackup(); window.onbeforeunload = null; sujo = false; location.reload(); }
    if (a === "fechar") { faixa.hidden = true; }
    if (a === "descartar") { limparBackup(); faixa.hidden = true; }
    if (a === "recuperar") {
      const bk = lerBackup();
      if (bk) { registrar(); doc = normalizar(bk.doc); faixa.hidden = true; mudou(); }
    }
    if (a === "copia") {
      b.disabled = true;
      try {
        const r = await fetch(D.urls.novo, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ titulo: (D.titulo + " (minha cópia)").slice(0, 120), documento: doc }),
        });
        const j = await r.json();
        if (!r.ok || !j.url) throw new Error(j.erro || "falhou");
        limparBackup(); sujo = false; location.href = j.url;
      } catch (e) {
        b.disabled = false;
        aviso("Não consegui criar a cópia: " + e.message);
      }
    }
  });

  function lerBackup() {
    try { return JSON.parse(localStorage.getItem(LS_BACKUP) || "null"); } catch (e) { return null; }
  }

  // Ao abrir: havia alteração não salva neste navegador?
  function conferirBackup() {
    const bk = lerBackup();
    if (!bk || leitura) return;
    if (JSON.stringify(normalizar(bk.doc)) === JSON.stringify(doc)) { limparBackup(); return; }
    const quando = new Date(bk.quando).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    const velha = bk.versao !== versao;
    mostrarFaixa(`<b>Há alterações deste fluxo que não chegaram ao servidor</b> (${esc(quando)}).` +
      (velha ? ` Alguém salvou depois disso — recuperar troca a versão atual pela sua.` : "") +
      `<span class="fluxo-faixa-acoes"><button type="button" class="btn sec" data-faixa="descartar">Descartar</button>` +
      `<button type="button" class="btn" data-faixa="recuperar">Recuperar</button></span>`, "aviso");
  }

  window.addEventListener("beforeunload", (ev) => {
    if (!sujo || leitura || conflito) return;
    // Última tentativa, sem esperar resposta; o backup local cobre se falhar.
    try {
      fetch(D.urls.salvar, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
                             body: JSON.stringify({ doc, versao }) });
    } catch (e) { /* o backup local cobre */ }
    ev.preventDefault();
    ev.returnValue = "";
  });

  // Presença: avisa ANTES do conflito que outra pessoa está no fluxo.
  async function pulsar() {
    if (leitura || document.hidden) return;
    try {
      const r = await fetch(D.urls.presenca, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json();
      const el = $(".fluxo-presenca");
      if (el) { el.hidden = !j.outro; el.textContent = j.outro ? `${j.outro} também está neste fluxo` : ""; }
    } catch (e) { /* presença é aviso; falhar não atrapalha o desenho */ }
  }

  // ===========================================================================
  // Exportação
  // ===========================================================================
  function nomeArquivo(ext) {
    return `${D.processo.codigo} - ${D.titulo}`.replace(/[\\/:*?"<>|]+/g, "-") + "." + ext;
  }
  function baixar(blob, nome) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportarSVG() {
    baixar(new Blob([R.paraSVG(doc)], { type: "image/svg+xml" }), nomeArquivo("svg"));
  }
  function exportarPNG() {
    const s = R.paraSVG(doc);
    const b = R.limites(doc);
    const img = new Image();
    img.onload = () => {
      // 2x: o PNG vai para WhatsApp e é aberto no celular com zoom.
      const esc2 = Math.min(2, 8000 / Math.max(b.w + 48, b.h + 48));
      const c = document.createElement("canvas");
      c.width = Math.round((b.w + 48) * esc2); c.height = Math.round((b.h + 48) * esc2);
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((blob) => baixar(blob, nomeArquivo("png")), "image/png");
    };
    img.onerror = () => aviso("Não consegui gerar o PNG. Tente o SVG.");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
  }

  // ===========================================================================
  // Avisos curtos
  // ===========================================================================
  let avisoTimer = null;
  function aviso(txt) {
    const el = $(".fluxo-aviso");
    if (!el) return;
    el.textContent = txt;
    el.hidden = false;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // Ganchos para a barra de versões (diálogos no template).
  window.FluxoEditor = {
    documento: () => doc,
    sujo: () => sujo,
    restaurar(novoDoc) { registrar(); doc = normalizar(novoDoc); sel.clear(); mudou(); enquadrar(); },
    aviso,
    salvarAgora,
  };

  // ===========================================================================
  // Versões com nome (diálogos do processo.html)
  // ===========================================================================
  const formVersao = document.getElementById("form-versao");
  if (formVersao) formVersao.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    // A foto é do que está no BANCO: salva antes, ou a versão com nome
    // perderia os últimos segundos de desenho.
    if (sujo) { clearTimeout(timer); await salvar(); }
    try {
      const r = await fetch(D.urls.versao, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: formVersao.nome.value }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || "falhou");
      formVersao.closest("dialog").close();
      formVersao.reset();
      aviso("Versão salva.");
    } catch (e) { aviso("Não consegui salvar a versão: " + e.message); }
  });

  const dlgVersoes = document.getElementById("dlg-versoes");
  const listaVersoes = document.getElementById("lista-versoes");
  const MOTIVO = { manual: "Salva à mão", aprovacao_it: "Aprovação de instrução", antes_de_restaurar: "Antes de restaurar" };
  if (dlgVersoes && listaVersoes) {
    // O diálogo abre pelo processos.js; a lista é buscada a cada abertura.
    new MutationObserver(async () => {
      if (!dlgVersoes.open) return;
      listaVersoes.innerHTML = `<p class="acao-p-vazio">Carregando…</p>`;
      try {
        const j = await (await fetch(D.urls.versoes)).json();
        listaVersoes.innerHTML = j.versoes.length ? `<table class="tbl"><thead><tr><th>Versão</th><th>Quando</th><th>Quem</th><th></th></tr></thead><tbody>` +
          j.versoes.map((v) => `<tr><td><b>${esc(v.nome || "Sem nome")}</b><br><span class="subnote" style="margin:0">${esc(MOTIVO[v.motivo] || v.motivo)} · v${v.versao}</span></td>` +
            `<td>${esc(v.quando)}</td><td>${esc(v.autor || "—")}</td>` +
            `<td>${leitura ? "" : `<button type="button" class="btn-ghost" data-restaurar="${esc(v.id)}">Restaurar</button>`}</td></tr>`).join("") +
          `</tbody></table>` : `<p class="acao-p-vazio">Nenhuma versão salva ainda. As instruções aprovadas guardam a delas sozinhas.</p>`;
      } catch (e) { listaVersoes.innerHTML = `<p class="acao-p-vazio">Não consegui carregar as versões.</p>`; }
    }).observe(dlgVersoes, { attributes: true, attributeFilter: ["open"] });
    listaVersoes.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-restaurar]");
      if (!b) return;
      b.disabled = true;
      try {
        if (sujo) { clearTimeout(timer); await salvar(); }
        await fetch(D.urls.versao, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nome: "Antes de restaurar", motivo: "antes_de_restaurar" }) });
        const j = await (await fetch(D.urls.versaoDoc.replace("__ID__", b.dataset.restaurar))).json();
        if (!j.documento) throw new Error(j.erro || "versão vazia");
        dlgVersoes.close();
        window.FluxoEditor.restaurar(j.documento);
        aviso("Versão restaurada. Ctrl+Z desfaz.");
      } catch (e) { b.disabled = false; aviso("Não consegui restaurar: " + e.message); }
    });
  }

  // ===========================================================================
  // Partida
  // ===========================================================================
  montarPaleta();
  marcarFerramenta(ferramenta);
  desenhar();
  montarProps();
  let vistaSalva = null;
  try { vistaSalva = JSON.parse(localStorage.getItem(LS_VISTA) || "null"); } catch (e) { vistaSalva = null; }
  // A vista guardada é da tela em que foi deixada: no celular (leitura) a de
  // um computador cortaria o desenho. Lá a folha abre sempre enquadrada.
  if (vistaSalva && vistaSalva.zoom && !leitura) { vista = vistaSalva; aplicarVista(); } else enquadrar();
  conferirBackup();
  relogio();
  if (leitura && D.editavel) estado("Somente leitura nesta tela — edite no computador.", "");
  else if (!D.editavel) estado(D.motivoLeitura || "Somente leitura", "");
  if (!leitura) { pulsar(); setInterval(pulsar, 60000); }
  // O tamanho da folha muda com a janela e com o modo foco; a vista não.
  window.addEventListener("resize", () => aplicarVista());
})();
