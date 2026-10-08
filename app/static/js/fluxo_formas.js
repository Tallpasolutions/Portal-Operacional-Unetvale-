// Catálogo das formas do fluxograma — o ÚNICO lugar onde a geometria existe.
//
// Editor, visualizador, exportação PNG/SVG e o anexo do PDF desenham pelo
// mesmo catálogo (via fluxo_render.js). Duas definições divergiriam: o fluxo
// sairia de um jeito na tela e de outro no papel — a armadilha dos dois
// normalizadores (CLAUDE.md §6). O servidor NÃO tem cópia desta lista: ele
// confere só a estrutura do documento (processos.validar_documento).
//
// Formas oficiais da ISO 5807 / ANSI, mais as livres (estilo Excalidraw) e
// alguns ícones da Infraestrutura. Cada forma diz:
//   nome, grupo, w/h padrão, cor padrão,
//   desenho(w, h) -> [{tag, attrs, papel}]   papel: "corpo" (preenche e
//                    contorna), "linha" (só contorno), "detalhe" (contorno fino)
//   texto(w, h)   -> {x, y, w, h}  onde o texto quebra
//   portas        -> quais portas (n, s, e, w) a forma oferece
//   acao          -> vira passo na instrução de trabalho
(function (raiz) {
  "use strict";

  // Paleta em hexadecimal, e não `var(--brand)`: o SVG exportado e o anexo do
  // PDF não têm o style.css por perto. Espelha os tokens do :root — ao mudar
  // um token lá, mude aqui.
  const CORES = {
    brand:   { fundo: "#e7f0fd", traco: "#2c7be5", texto: "#1f5fc0", nome: "Azul" },
    warning: { fundo: "#fdeede", traco: "#f5803e", texto: "#b65a16", nome: "Laranja" },
    success: { fundo: "#e3f6ee", traco: "#00b074", texto: "#0a7a52", nome: "Verde" },
    ouro:    { fundo: "#fff6dc", traco: "#e5a000", texto: "#8a6100", nome: "Ouro" },
    danger:  { fundo: "#fdecee", traco: "#e63757", texto: "#b21f37", nome: "Vermelho" },
    muted:   { fundo: "#ffffff", traco: "#5e6e82", texto: "#344050", nome: "Cinza" },
    nota:    { fundo: "#fff3b0", traco: "#e5a000", texto: "#5c4a00", nome: "Nota" },
  };
  const ORDEM_CORES = ["brand", "warning", "success", "ouro", "danger", "muted"];

  const n = (v) => Math.round(v * 100) / 100;
  const pts = (lista) => lista.map((p) => n(p[0]) + "," + n(p[1])).join(" ");
  const poli = (lista) => [{ tag: "polygon", attrs: { points: pts(lista) }, papel: "corpo" }];
  const caminho = (d, papel) => ({ tag: "path", attrs: { d }, papel: papel || "corpo" });
  const margem = (w, h, mx, my) => ({ x: mx, y: my, w: Math.max(10, w - 2 * mx), h: Math.max(10, h - 2 * my) });
  const P4 = ["n", "s", "e", "w"];

  const FORMAS = {
    // ---------------------------------------------------------- fluxograma
    terminal: {
      nome: "Terminal", dica: "Início ou fim", grupo: "fluxograma", w: 130, h: 48,
      cor: "success", portas: P4, acao: false,
      desenho: (w, h) => [{ tag: "rect", attrs: { x: 0, y: 0, width: w, height: h, rx: Math.min(h, w) / 2 }, papel: "corpo" }],
      texto: (w, h) => margem(w, h, h / 3, 4),
    },
    processo: {
      nome: "Processo", dica: "Uma atividade", grupo: "fluxograma", w: 150, h: 64,
      cor: "brand", portas: P4, acao: true,
      desenho: (w, h) => [{ tag: "rect", attrs: { x: 0, y: 0, width: w, height: h, rx: 4 }, papel: "corpo" }],
      texto: (w, h) => margem(w, h, 8, 6),
    },
    decisao: {
      nome: "Decisão", dica: "Pergunta com saídas Sim/Não", grupo: "fluxograma", w: 150, h: 84,
      cor: "warning", portas: P4, acao: true,
      desenho: (w, h) => poli([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]),
      texto: (w, h) => margem(w, h, w / 4.2, h / 4.6),
    },
    dados: {
      nome: "Dados", dica: "Entrada ou saída de informação", grupo: "fluxograma", w: 150, h: 60,
      cor: "muted", portas: P4, acao: true,
      desenho: (w, h) => { const s = Math.min(22, w * 0.18); return poli([[s, 0], [w, 0], [w - s, h], [0, h]]); },
      texto: (w, h) => margem(w, h, Math.min(22, w * 0.18) + 4, 6),
    },
    documento: {
      nome: "Documento", dica: "Documento gerado ou usado", grupo: "fluxograma", w: 150, h: 66,
      cor: "muted", portas: P4, acao: true,
      desenho: (w, h) => {
        const k = Math.min(10, h * 0.16);
        return [caminho(`M0 0H${n(w)}V${n(h - k)}Q${n(w * 0.75)} ${n(h - 3 * k)} ${n(w / 2)} ${n(h - k)}T0 ${n(h - k)}Z`)];
      },
      texto: (w, h) => ({ x: 8, y: 4, w: w - 16, h: h - Math.min(10, h * 0.16) * 2 - 4 }),
    },
    multidoc: {
      nome: "Vários documentos", dica: "Mais de um documento", grupo: "fluxograma", w: 160, h: 74,
      cor: "muted", portas: P4, acao: true,
      desenho: (w, h) => {
        const o = 6, dw = w - 2 * o, dh = h - 2 * o, k = Math.min(9, dh * 0.16);
        const doc = (x, y) => caminho(`M${n(x)} ${n(y)}H${n(x + dw)}V${n(y + dh - k)}Q${n(x + dw * 0.75)} ${n(y + dh - 3 * k)} ${n(x + dw / 2)} ${n(y + dh - k)}T${n(x)} ${n(y + dh - k)}Z`);
        return [doc(2 * o, 0), doc(o, o), doc(0, 2 * o)];
      },
      texto: (w, h) => ({ x: 8, y: 16, w: w - 28, h: h - 34 }),
    },
    subprocesso: {
      nome: "Subprocesso", dica: "Processo definido em outro fluxo", grupo: "fluxograma", w: 160, h: 64,
      cor: "brand", portas: P4, acao: true,
      desenho: (w, h) => {
        const s = Math.min(12, w * 0.08);
        return [{ tag: "rect", attrs: { x: 0, y: 0, width: w, height: h }, papel: "corpo" },
                caminho(`M${n(s)} 0V${n(h)}M${n(w - s)} 0V${n(h)}`, "linha")];
      },
      texto: (w, h) => margem(w, h, Math.min(12, w * 0.08) + 6, 6),
    },
    preparacao: {
      nome: "Preparação", dica: "Ajuste antes de executar", grupo: "fluxograma", w: 150, h: 60,
      cor: "brand", portas: P4, acao: true,
      desenho: (w, h) => { const s = Math.min(22, w * 0.18); return poli([[s, 0], [w - s, 0], [w, h / 2], [w - s, h], [s, h], [0, h / 2]]); },
      texto: (w, h) => margem(w, h, Math.min(22, w * 0.18), 6),
    },
    op_manual: {
      nome: "Operação manual", dica: "Feita à mão, sem sistema", grupo: "fluxograma", w: 150, h: 60,
      cor: "brand", portas: P4, acao: true,
      desenho: (w, h) => { const s = Math.min(20, w * 0.15); return poli([[0, 0], [w, 0], [w - s, h], [s, h]]); },
      texto: (w, h) => margem(w, h, Math.min(20, w * 0.15) + 2, 6),
    },
    entrada_manual: {
      nome: "Entrada manual", dica: "Digitação, formulário", grupo: "fluxograma", w: 150, h: 62,
      cor: "brand", portas: P4, acao: true,
      desenho: (w, h) => poli([[0, h * 0.32], [w, 0], [w, h], [0, h]]),
      texto: (w, h) => ({ x: 8, y: h * 0.28, w: w - 16, h: h * 0.68 }),
    },
    banco: {
      nome: "Banco de dados", dica: "Armazenamento, sistema", grupo: "fluxograma", w: 130, h: 74,
      cor: "muted", portas: P4, acao: true,
      desenho: (w, h) => {
        const ry = Math.min(10, h * 0.15), rx = w / 2;
        return [caminho(`M0 ${n(ry)}A${n(rx)} ${n(ry)} 0 0 1 ${n(w)} ${n(ry)}V${n(h - ry)}A${n(rx)} ${n(ry)} 0 0 1 0 ${n(h - ry)}Z`),
                caminho(`M0 ${n(ry)}A${n(rx)} ${n(ry)} 0 0 0 ${n(w)} ${n(ry)}`, "linha")];
      },
      texto: (w, h) => ({ x: 6, y: Math.min(10, h * 0.15) * 2 + 2, w: w - 12, h: h - Math.min(10, h * 0.15) * 3 - 4 }),
    },
    dados_armazenados: {
      nome: "Dados armazenados", dica: "Planilha, arquivo, registro", grupo: "fluxograma", w: 150, h: 60,
      cor: "muted", portas: P4, acao: true,
      desenho: (w, h) => {
        const s = Math.min(14, w * 0.1);
        return [caminho(`M${n(s)} 0H${n(w)}A${n(s)} ${n(h / 2)} 0 0 0 ${n(w)} ${n(h)}H${n(s)}A${n(s)} ${n(h / 2)} 0 0 1 ${n(s)} 0Z`)];
      },
      texto: (w, h) => margem(w, h, Math.min(14, w * 0.1) + 6, 6),
    },
    espera: {
      nome: "Espera", dica: "Atraso, aguardar", grupo: "fluxograma", w: 140, h: 60,
      cor: "muted", portas: P4, acao: true,
      desenho: (w, h) => {
        const r = Math.min(h / 2, w / 2);
        return [caminho(`M0 0H${n(w - r)}A${n(r)} ${n(h / 2)} 0 0 1 ${n(w - r)} ${n(h)}H0Z`)];
      },
      texto: (w, h) => ({ x: 8, y: 6, w: w - Math.min(h / 2, w / 2) - 8, h: h - 12 }),
    },
    exibicao: {
      nome: "Exibição", dica: "Tela, painel, app", grupo: "fluxograma", w: 150, h: 60,
      cor: "muted", portas: P4, acao: true,
      desenho: (w, h) => {
        const s = Math.min(22, w * 0.16), r = Math.min(h / 2, w * 0.2);
        return [caminho(`M${n(s)} 0H${n(w - r)}A${n(r)} ${n(h / 2)} 0 0 1 ${n(w - r)} ${n(h)}H${n(s)}L0 ${n(h / 2)}Z`)];
      },
      texto: (w, h) => ({ x: Math.min(22, w * 0.16), y: 6, w: w - Math.min(22, w * 0.16) - Math.min(h / 2, w * 0.2), h: h - 12 }),
    },
    conector: {
      nome: "Conector", dica: "Continua em outro ponto da folha", grupo: "fluxograma", w: 44, h: 44,
      cor: "muted", portas: P4, acao: false,
      desenho: (w, h) => [{ tag: "ellipse", attrs: { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 }, papel: "corpo" }],
      texto: (w, h) => margem(w, h, 4, 4),
    },
    fora_pagina: {
      nome: "Fora da página", dica: "Continua em outro fluxo", grupo: "fluxograma", w: 64, h: 64,
      cor: "muted", portas: P4, acao: false,
      desenho: (w, h) => poli([[0, 0], [w, 0], [w, h * 0.64], [w / 2, h], [0, h * 0.64]]),
      texto: (w, h) => ({ x: 4, y: 4, w: w - 8, h: h * 0.6 }),
    },
    mesclar: {
      nome: "Mesclar", dica: "Juntar itens", grupo: "fluxograma", w: 70, h: 60,
      cor: "muted", portas: P4, acao: false,
      desenho: (w, h) => poli([[0, 0], [w, 0], [w / 2, h]]),
      texto: (w, h) => ({ x: w * 0.2, y: 4, w: w * 0.6, h: h * 0.45 }),
    },
    extrair: {
      nome: "Extrair", dica: "Separar itens", grupo: "fluxograma", w: 70, h: 60,
      cor: "muted", portas: P4, acao: false,
      desenho: (w, h) => poli([[w / 2, 0], [w, h], [0, h]]),
      texto: (w, h) => ({ x: w * 0.2, y: h * 0.5, w: w * 0.6, h: h * 0.45 }),
    },
    juncao_ou: {
      nome: "Junção “ou”", dica: "Um caminho OU outro", grupo: "fluxograma", w: 44, h: 44,
      cor: "muted", portas: P4, acao: false, semTexto: true,
      desenho: (w, h) => [{ tag: "ellipse", attrs: { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 }, papel: "corpo" },
                          caminho(`M${n(w / 2)} ${n(h * 0.18)}V${n(h * 0.82)}M${n(w * 0.18)} ${n(h / 2)}H${n(w * 0.82)}`, "linha")],
      texto: (w, h) => margem(w, h, 4, 4),
    },
    anotacao: {
      nome: "Anotação", dica: "Comentário ligado a uma forma", grupo: "fluxograma", w: 150, h: 56,
      cor: "muted", portas: ["w"], acao: false, alinhar: "esquerda",
      desenho: (w, h) => [caminho(`M14 0H0V${n(h)}H14`, "linha")],
      texto: (w, h) => ({ x: 8, y: 4, w: w - 10, h: h - 8 }),
    },
    fase: {
      nome: "Fase", dica: "Divisor de etapa", grupo: "raias", w: 24, h: 320,
      cor: "muted", portas: [], acao: false, semTexto: false, rotuloTopo: true,
      desenho: (w, h) => [caminho(`M${n(w / 2)} 26V${n(h)}`, "tracejado")],
      texto: (w, h) => ({ x: -60, y: 0, w: w + 120, h: 22 }),
    },

    // --------------------------------------------- livres (estilo Excalidraw)
    retangulo: {
      nome: "Retângulo", dica: "Caixa livre", grupo: "livres", w: 140, h: 80, cor: "muted",
      portas: P4, acao: false,
      desenho: (w, h) => [{ tag: "rect", attrs: { x: 0, y: 0, width: w, height: h, rx: 10 }, papel: "corpo" }],
      texto: (w, h) => margem(w, h, 8, 6),
    },
    elipse: {
      nome: "Elipse", dica: "Círculo livre", grupo: "livres", w: 120, h: 80, cor: "muted",
      portas: P4, acao: false,
      desenho: (w, h) => [{ tag: "ellipse", attrs: { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 }, papel: "corpo" }],
      texto: (w, h) => margem(w, h, w * 0.15, h * 0.15),
    },
    texto: {
      nome: "Texto", dica: "Texto solto", grupo: "livres", w: 160, h: 36, cor: "muted",
      portas: P4, acao: false, semBorda: true, alinhar: "esquerda",
      desenho: (w, h) => [{ tag: "rect", attrs: { x: 0, y: 0, width: w, height: h }, papel: "invisivel" }],
      texto: (w, h) => margem(w, h, 2, 2),
    },
    nota: {
      nome: "Nota adesiva", dica: "Lembrete", grupo: "livres", w: 150, h: 110, cor: "nota",
      portas: P4, acao: false, alinhar: "esquerda",
      desenho: (w, h) => {
        const d = 16;
        return [caminho(`M0 0H${n(w)}V${n(h - d)}L${n(w - d)} ${n(h)}H0Z`),
                caminho(`M${n(w)} ${n(h - d)}H${n(w - d)}V${n(h)}`, "linha")];
      },
      texto: (w, h) => ({ x: 10, y: 8, w: w - 20, h: h - 24 }),
    },

    // ------------------------------------------------------- ícones da Infra
    // Desenho de traço só, dentro de uma caixa quadrada, com o rótulo
    // EMBAIXO: o ícone diz o que é, o texto diz qual.
    ic_poste: icone("Poste", (w, h) =>
      `M${n(w / 2)} ${n(h * 0.08)}V${n(h * 0.94)}M${n(w * 0.2)} ${n(h * 0.24)}H${n(w * 0.8)}` +
      `M${n(w * 0.26)} ${n(h * 0.24)}V${n(h * 0.14)}M${n(w * 0.74)} ${n(h * 0.24)}V${n(h * 0.14)}` +
      `M${n(w * 0.34)} ${n(h * 0.94)}H${n(w * 0.66)}M${n(w * 0.3)} ${n(h * 0.42)}Q${n(w / 2)} ${n(h * 0.56)} ${n(w * 0.7)} ${n(h * 0.42)}`),
    ic_tecnico: icone("Técnico", (w, h) =>
      `M${n(w * 0.32)} ${n(h * 0.3)}A${n(w * 0.18)} ${n(h * 0.17)} 0 0 1 ${n(w * 0.68)} ${n(h * 0.3)}Z` +
      `M${n(w * 0.38)} ${n(h * 0.3)}A${n(w * 0.12)} ${n(h * 0.12)} 0 0 0 ${n(w * 0.62)} ${n(h * 0.3)}` +
      `M${n(w * 0.2)} ${n(h * 0.92)}Q${n(w * 0.22)} ${n(h * 0.52)} ${n(w / 2)} ${n(h * 0.52)}Q${n(w * 0.78)} ${n(h * 0.52)} ${n(w * 0.8)} ${n(h * 0.92)}Z`),
    ic_veiculo: icone("Veículo", (w, h) =>
      `M${n(w * 0.06)} ${n(h * 0.3)}H${n(w * 0.62)}V${n(h * 0.72)}H${n(w * 0.06)}Z` +
      `M${n(w * 0.62)} ${n(h * 0.42)}H${n(w * 0.8)}L${n(w * 0.94)} ${n(h * 0.56)}V${n(h * 0.72)}H${n(w * 0.62)}` +
      `M${n(w * 0.22)} ${n(h * 0.8)}m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0` +
      `M${n(w * 0.76)} ${n(h * 0.8)}m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0`),
    ic_cto: icone("CTO / caixa", (w, h) =>
      `M${n(w * 0.18)} ${n(h * 0.14)}H${n(w * 0.82)}V${n(h * 0.86)}H${n(w * 0.18)}Z` +
      `M${n(w * 0.32)} ${n(h * 0.86)}V${n(h * 0.98)}M${n(w / 2)} ${n(h * 0.86)}V${n(h * 0.98)}M${n(w * 0.68)} ${n(h * 0.86)}V${n(h * 0.98)}` +
      `M${n(w * 0.3)} ${n(h * 0.34)}H${n(w * 0.7)}M${n(w * 0.3)} ${n(h * 0.5)}H${n(w * 0.7)}M${n(w * 0.3)} ${n(h * 0.66)}H${n(w * 0.56)}`),
    ic_cabo: icone("Cabo", (w, h) =>
      `M${n(w * 0.06)} ${n(h * 0.5)}C${n(w * 0.3)} ${n(h * 0.1)} ${n(w * 0.45)} ${n(h * 0.9)} ${n(w * 0.7)} ${n(h * 0.5)}S${n(w * 0.88)} ${n(h * 0.3)} ${n(w * 0.94)} ${n(h * 0.42)}` +
      `M${n(w * 0.06)} ${n(h * 0.42)}V${n(h * 0.58)}M${n(w * 0.94)} ${n(h * 0.34)}V${n(h * 0.5)}`),
    ic_onu: icone("ONU", (w, h) =>
      `M${n(w * 0.1)} ${n(h * 0.42)}H${n(w * 0.9)}V${n(h * 0.8)}H${n(w * 0.1)}Z` +
      `M${n(w * 0.72)} ${n(h * 0.42)}L${n(w * 0.8)} ${n(h * 0.12)}` +
      `M${n(w * 0.24)} ${n(h * 0.61)}h4M${n(w * 0.36)} ${n(h * 0.61)}h4M${n(w * 0.48)} ${n(h * 0.61)}h4`),
  };

  function icone(nome, d) {
    return {
      nome, dica: "Ícone da Infraestrutura", grupo: "infra", w: 64, h: 64, cor: "muted",
      portas: P4, acao: false, rotuloAbaixo: true,
      desenho: (w, h) => [{ tag: "rect", attrs: { x: 0, y: 0, width: w, height: h, rx: 10 }, papel: "invisivel" },
                          caminho(d(w, h), "icone")],
      texto: (w, h) => ({ x: -30, y: h + 4, w: w + 60, h: 34 }),
    };
  }

  // Forma desconhecida (documento de uma versão futura, ou tipo que saiu do
  // catálogo) vira caixa tracejada: o fluxo abre, em vez de quebrar a tela.
  const GENERICA = {
    nome: "Forma", dica: "", grupo: "", w: 140, h: 60, cor: "muted", portas: P4, acao: true,
    desenho: (w, h) => [{ tag: "rect", attrs: { x: 0, y: 0, width: w, height: h, rx: 4 }, papel: "tracejado" }],
    texto: (w, h) => margem(w, h, 8, 6),
  };

  const GRUPOS = [
    { id: "fluxograma", nome: "Fluxograma (ISO 5807)" },
    { id: "raias", nome: "Raias e fases" },
    { id: "livres", nome: "Livre" },
    { id: "infra", nome: "Infraestrutura" },
  ];

  function forma(tipo) {
    return FORMAS[tipo] || GENERICA;
  }

  // Ponto da porta, em coordenadas da forma. Na decisão as portas caem nos
  // vértices, que é onde o losango "sai" — o meio de cada lado é o mesmo ponto.
  function porta(no, p) {
    const x = no.x, y = no.y, w = no.w, h = no.h;
    switch (p) {
      case "n": return { x: x + w / 2, y: y, dx: 0, dy: -1 };
      case "s": return { x: x + w / 2, y: y + h, dx: 0, dy: 1 };
      case "e": return { x: x + w, y: y + h / 2, dx: 1, dy: 0 };
      case "w": return { x: x, y: y + h / 2, dx: -1, dy: 0 };
    }
    return { x: x + w / 2, y: y + h / 2, dx: 0, dy: 0 };
  }

  const API = { CORES, ORDEM_CORES, FORMAS, GRUPOS, forma, porta };
  raiz.FluxoFormas = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
