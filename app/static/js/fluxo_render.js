// Documento do fluxo -> SVG. Função pura: o mesmo desenho no editor, no
// visualizador do celular, na exportação PNG/SVG e no anexo do PDF da
// instrução de trabalho. A geometria de cada forma vem de fluxo_formas.js.
//
// Gera TEXTO (string de SVG), não nós do DOM: é o que serve aos quatro usos
// — o editor joga num <g> com innerHTML, a exportação embrulha num <svg>
// solto, o PDF imprime. Todo texto do usuário passa por `esc`: o documento
// vem do banco e é escrito por qualquer pessoa com o módulo.
(function (raiz) {
  "use strict";
  const F = raiz.FluxoFormas || (typeof require !== "undefined" ? require("./fluxo_formas.js") : null);

  const FAMILIA = "-apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  const FONTE = 13;
  const RAIA_CAB = 30;  // largura da faixa do título da raia
  const STUB = 18;      // quanto a ligação anda reto antes de dobrar

  const n = (v) => Math.round(v * 100) / 100;
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function cor(chave) { return F.CORES[chave] || F.CORES.muted; }

  // ---- texto ----------------------------------------------------------------
  // A quebra mede com o canvas na MESMA fonte do SVG; fora do navegador (o
  // teste por script em node) a largura é estimada.
  let ctx = null;
  function largura(txt, tam, peso) {
    if (typeof document !== "undefined") {
      if (!ctx) ctx = document.createElement("canvas").getContext("2d");
      ctx.font = `${peso || 400} ${tam}px ${FAMILIA}`;
      return ctx.measureText(txt).width;
    }
    return txt.length * tam * 0.55;
  }

  function quebrar(texto, max, tam, peso) {
    const linhas = [];
    String(texto || "").split("\n").forEach((par) => {
      const palavras = par.split(/\s+/).filter(Boolean);
      if (!palavras.length) { linhas.push(""); return; }
      let atual = "";
      palavras.forEach((p) => {
        // Palavra maior que a linha (um código, um link) quebra no caractere.
        while (largura(p, tam, peso) > max && p.length > 1) {
          let i = p.length - 1;
          while (i > 1 && largura(p.slice(0, i), tam, peso) > max) i--;
          if (atual) { linhas.push(atual); atual = ""; }
          linhas.push(p.slice(0, i));
          p = p.slice(i);
        }
        const tentativa = atual ? atual + " " + p : p;
        if (largura(tentativa, tam, peso) <= max) atual = tentativa;
        else { if (atual) linhas.push(atual); atual = p; }
      });
      linhas.push(atual);
    });
    return linhas;
  }

  // Altura de que o texto precisa — o editor cresce a forma quando o texto
  // não cabe, em vez de deixá-lo vazar por baixo da borda.
  function alturaTexto(no) {
    const f = F.forma(no.tipo);
    const tam = no.fonte || FONTE;
    const area = f.texto(no.w, no.h);
    const linhas = quebrar(no.texto, Math.max(10, area.w), tam, no.negrito ? 700 : 400);
    return linhas.length * tam * 1.3;
  }

  function textoSVG(no, f, c) {
    if (f.semTexto || !no.texto) return "";
    const tam = no.fonte || FONTE;
    const peso = no.negrito ? 700 : 400;
    const area = f.texto(no.w, no.h);
    const linhas = quebrar(no.texto, Math.max(10, area.w), tam, peso);
    const lh = tam * 1.3;
    const total = linhas.length * lh;
    const esquerda = f.alinhar === "esquerda";
    const x = esquerda ? area.x : area.x + area.w / 2;
    let y0;
    if (f.rotuloAbaixo || f.rotuloTopo) y0 = area.y + tam;
    else y0 = area.y + (area.h - total) / 2 + tam * 0.98;
    const tspans = linhas.map((l, i) =>
      `<tspan x="${n(x)}" y="${n(y0 + i * lh)}">${esc(l) || " "}</tspan>`).join("");
    return `<text font-family="${FAMILIA}" font-size="${tam}" font-weight="${peso}" fill="${c.texto}"` +
           ` text-anchor="${esquerda ? "start" : "middle"}">${tspans}</text>`;
  }

  // ---- formas ---------------------------------------------------------------
  function attrs(o) {
    return Object.keys(o).map((k) => `${k}="${typeof o[k] === "number" ? n(o[k]) : esc(o[k])}"`).join(" ");
  }

  function noSVG(no, opts) {
    const f = F.forma(no.tipo);
    const c = cor(no.cor || f.cor);
    const tracejado = no.borda === "tracejada";
    const partes = f.desenho(no.w, no.h).map((p) => {
      let estilo;
      if (p.papel === "invisivel") estilo = `fill="transparent" stroke="none"`;
      else if (p.papel === "linha") estilo = `fill="none" stroke="${c.traco}" stroke-width="1.4"`;
      else if (p.papel === "icone") estilo = `fill="none" stroke="${c.traco}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
      else if (p.papel === "tracejado") estilo = `fill="none" stroke="${c.traco}" stroke-width="1.4" stroke-dasharray="6 4"`;
      else estilo = `fill="${f.semBorda ? "transparent" : c.fundo}" stroke="${f.semBorda ? "none" : c.traco}" stroke-width="1.6"` +
                    (tracejado ? ` stroke-dasharray="6 4"` : "");
      return `<${p.tag} ${attrs(p.attrs)} ${estilo}/>`;
    }).join("");
    const extra = opts && opts.marcar && opts.marcar.has(no.id) ? ` class="fx-no fx-marcado"` : ` class="fx-no"`;
    return `<g${extra} data-id="${esc(no.id)}" data-tipo="${esc(no.tipo)}" transform="translate(${n(no.x)} ${n(no.y)})">` +
           partes + textoSVG(no, f, c) + `</g>`;
  }

  // ---- raias ----------------------------------------------------------------
  function raiaSVG(r, i, opts) {
    const c = cor(r.cor || "brand");
    const sel = opts && opts.sel && opts.sel.has(r.id);
    const cx = r.x + RAIA_CAB / 2, cy = r.y + r.h / 2;
    return `<g class="fx-raia" data-id="${esc(r.id)}">` +
      `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" fill="${c.fundo}" fill-opacity="0.22"` +
      ` stroke="${sel ? "#2c7be5" : "#d8e2ef"}" stroke-width="${sel ? 2 : 1.2}"/>` +
      `<rect data-parte="cab" x="${n(r.x)}" y="${n(r.y)}" width="${RAIA_CAB}" height="${n(r.h)}" fill="${c.fundo}"` +
      ` stroke="#d8e2ef" stroke-width="1.2"/>` +
      `<text data-parte="cab" transform="translate(${n(cx)} ${n(cy)}) rotate(-90)" text-anchor="middle" dominant-baseline="central"` +
      ` font-family="${FAMILIA}" font-size="13" font-weight="700" fill="${c.texto}">${esc(r.titulo || "Raia " + (i + 1))}</text>` +
      `</g>`;
  }

  // ---- ligações -------------------------------------------------------------
  function centro(no) { return { x: no.x + no.w / 2, y: no.y + no.h / 2 }; }

  // Porta "auto": a que olha para a outra forma. Respeita as portas que a
  // forma oferece (a anotação só liga pela esquerda).
  function portaAuto(a, b) {
    const ca = centro(a), cb = centro(b);
    const dx = cb.x - ca.x, dy = cb.y - ca.y;
    let pref;
    if (Math.abs(dx) > Math.abs(dy) * 1.15) pref = dx > 0 ? ["e", "s", "n", "w"] : ["w", "s", "n", "e"];
    else pref = dy > 0 ? ["s", "e", "w", "n"] : ["n", "e", "w", "s"];
    const ofer = F.forma(a.tipo).portas;
    return pref.find((p) => ofer.indexOf(p) >= 0) || ofer[0] || "e";
  }

  function simplificar(ps) {
    const out = [];
    ps.forEach((p) => {
      const u = out[out.length - 1];
      if (u && Math.abs(u.x - p.x) < 0.5 && Math.abs(u.y - p.y) < 0.5) return;
      out.push({ x: p.x, y: p.y });
    });
    // tira o ponto do meio de três colineares
    for (let i = out.length - 2; i > 0; i--) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      if ((Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) ||
          (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)) out.splice(i, 1);
    }
    return out;
  }

  function nosPorId(doc) {
    const m = {};
    (doc.nos || []).forEach((x) => { m[x.id] = x; });
    return m;
  }

  // Pontos da ligação. `l.meio` é a coordenada do trecho do meio que a pessoa
  // arrastou (x quando o trecho é vertical, y quando é horizontal).
  function rota(l, mapa) {
    const a = mapa[l.de && l.de.no], b = mapa[l.para && l.para.no];
    if (!a || !b) return null;
    const pa = F.porta(a, l.de.porta && l.de.porta !== "auto" ? l.de.porta : portaAuto(a, b));
    const pb = F.porta(b, l.para.porta && l.para.porta !== "auto" ? l.para.porta : portaAuto(b, a));
    if (l.rota === "reta" || l.rota === "curva") return { pontos: [pa, pb], pa, pb };
    // Portas frente a frente quase alinhadas (diferença menor que 6 px):
    // seta reta, terminando na borda do destino na altura da origem. O
    // cotovelo de 4 px que a rota em ângulo faria aí parece erro de desenho.
    const frente = pa.dx * pb.dx === -1 || pa.dy * pb.dy === -1;
    if (frente && typeof l.meio !== "number") {
      if (pa.dx && Math.abs(pa.y - pb.y) < 6 && (pb.x - pa.x) * pa.dx > 0) {
        const fim = { x: pb.x, y: pa.y, dx: pb.dx, dy: 0 };
        return { pontos: [pa, fim], pa, pb: fim, eixo: null };
      }
      if (pa.dy && Math.abs(pa.x - pb.x) < 6 && (pb.y - pa.y) * pa.dy > 0) {
        const fim = { x: pa.x, y: pb.y, dx: 0, dy: pb.dy };
        return { pontos: [pa, fim], pa, pb: fim, eixo: null };
      }
    }
    const A = { x: pa.x + pa.dx * STUB, y: pa.y + pa.dy * STUB };
    const B = { x: pb.x + pb.dx * STUB, y: pb.y + pb.dy * STUB };
    const hA = pa.dx !== 0, hB = pb.dx !== 0;
    let meio;
    if (hA && hB) {
      const mx = typeof l.meio === "number" ? l.meio : (A.x + B.x) / 2;
      meio = [{ x: mx, y: A.y }, { x: mx, y: B.y }];
    } else if (!hA && !hB) {
      const my = typeof l.meio === "number" ? l.meio : (A.y + B.y) / 2;
      meio = [{ x: A.x, y: my }, { x: B.x, y: my }];
    } else if (hA) {
      meio = [{ x: B.x, y: A.y }];
    } else {
      meio = [{ x: A.x, y: B.y }];
    }
    return { pontos: simplificar([pa, A].concat(meio, [B, pb])), pa, pb, eixo: hA && hB ? "x" : (!hA && !hB ? "y" : null) };
  }

  function ponta(de, para, c) {
    const ang = Math.atan2(para.y - de.y, para.x - de.x);
    const L = 11, W = 5.5;
    const bx = para.x - Math.cos(ang) * L, by = para.y - Math.sin(ang) * L;
    const px = -Math.sin(ang) * W, py = Math.cos(ang) * W;
    return `<polygon points="${n(para.x)},${n(para.y)} ${n(bx + px)},${n(by + py)} ${n(bx - px)},${n(by - py)}" fill="${c}"/>`;
  }

  // Meio do caminho pelo comprimento — onde vai o rótulo (Sim/Não) e a alça
  // de arrastar o trecho.
  function meioDoCaminho(ps) {
    let total = 0;
    for (let i = 1; i < ps.length; i++) total += Math.hypot(ps[i].x - ps[i - 1].x, ps[i].y - ps[i - 1].y);
    let alvo = total / 2;
    for (let i = 1; i < ps.length; i++) {
      const s = Math.hypot(ps[i].x - ps[i - 1].x, ps[i].y - ps[i - 1].y);
      if (alvo <= s && s > 0) {
        const t = alvo / s;
        return { x: ps[i - 1].x + (ps[i].x - ps[i - 1].x) * t, y: ps[i - 1].y + (ps[i].y - ps[i - 1].y) * t, seg: i };
      }
      alvo -= s;
    }
    return ps.length ? { x: ps[0].x, y: ps[0].y, seg: 1 } : { x: 0, y: 0, seg: 1 };
  }

  function ligacaoSVG(l, mapa, opts) {
    const r = rota(l, mapa);
    if (!r) return "";
    const sel = opts && opts.sel && opts.sel.has(l.id);
    const c = sel ? "#2c7be5" : (l.cor ? cor(l.cor).traco : "#5e6e82");
    const ps = r.pontos;
    let d;
    if (l.rota === "curva") {
      const k = Math.max(40, Math.hypot(r.pb.x - r.pa.x, r.pb.y - r.pa.y) / 3);
      d = `M${n(r.pa.x)} ${n(r.pa.y)}C${n(r.pa.x + r.pa.dx * k)} ${n(r.pa.y + r.pa.dy * k)} ` +
          `${n(r.pb.x + r.pb.dx * k)} ${n(r.pb.y + r.pb.dy * k)} ${n(r.pb.x)} ${n(r.pb.y)}`;
    } else {
      d = "M" + ps.map((p) => n(p.x) + " " + n(p.y)).join("L");
    }
    const traco = l.traco === "tracejado" ? ` stroke-dasharray="6 4"` : "";
    let s = `<g class="fx-lig" data-id="${esc(l.id)}">` +
      `<path class="fx-lig-hit" d="${d}" fill="none" stroke="transparent" stroke-width="14"/>` +
      `<path d="${d}" fill="none" stroke="${c}" stroke-width="${sel ? 2.4 : 1.6}"${traco} stroke-linejoin="round"/>`;
    const seta = l.seta || "fim";
    // Na curva a ponta segue a tangente de chegada, que é a direção da porta.
    const antesFim = l.rota === "curva" ? { x: r.pb.x + r.pb.dx * 20, y: r.pb.y + r.pb.dy * 20 } : ps[ps.length - 2];
    const depoisIni = l.rota === "curva" ? { x: r.pa.x + r.pa.dx * 20, y: r.pa.y + r.pa.dy * 20 } : ps[1];
    if (seta === "fim" || seta === "ambas") s += ponta(antesFim, r.pb, c);
    if (seta === "ambas") s += ponta(depoisIni, r.pa, c);
    if (l.texto) {
      const m = meioDoCaminho(ps);
      const tam = 12, w = largura(l.texto, tam, 600) + 10, h = tam + 8;
      s += `<rect x="${n(m.x - w / 2)}" y="${n(m.y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="4" fill="#ffffff" fill-opacity="0.94"/>` +
           `<text x="${n(m.x)}" y="${n(m.y + tam * 0.36)}" text-anchor="middle" font-family="${FAMILIA}" font-size="${tam}"` +
           ` font-weight="600" fill="${sel ? "#1f5fc0" : "#5e6e82"}">${esc(l.texto)}</text>`;
    }
    return s + `</g>`;
  }

  // ---- livres (caneta, seta, linha) ----------------------------------------
  function livreSVG(f, opts) {
    const ps = f.pontos || [];
    if (ps.length < 2) return "";
    const sel = opts && opts.sel && opts.sel.has(f.id);
    const c = sel ? "#2c7be5" : cor(f.cor || "muted").traco;
    const esp = f.espessura || 2;
    let d;
    if (f.tipo === "caneta" && ps.length > 2) {
      // Curva pelos pontos médios: o traço da mão sai liso, sem os cantos
      // dos pontos amostrados.
      d = `M${n(ps[0][0])} ${n(ps[0][1])}`;
      for (let i = 1; i < ps.length - 1; i++) {
        const mx = (ps[i][0] + ps[i + 1][0]) / 2, my = (ps[i][1] + ps[i + 1][1]) / 2;
        d += `Q${n(ps[i][0])} ${n(ps[i][1])} ${n(mx)} ${n(my)}`;
      }
      const u = ps[ps.length - 1];
      d += `L${n(u[0])} ${n(u[1])}`;
    } else {
      d = "M" + ps.map((p) => n(p[0]) + " " + n(p[1])).join("L");
    }
    let s = `<g class="fx-livre" data-id="${esc(f.id)}">` +
      `<path class="fx-lig-hit" d="${d}" fill="none" stroke="transparent" stroke-width="14"/>` +
      `<path d="${d}" fill="none" stroke="${c}" stroke-width="${esp}" stroke-linecap="round" stroke-linejoin="round"` +
      (f.traco === "tracejado" ? ` stroke-dasharray="6 4"` : "") + `/>`;
    if (f.tipo === "seta") {
      const a = ps[ps.length - 2], b = ps[ps.length - 1];
      s += ponta({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, c);
    }
    return s + `</g>`;
  }

  // ---- documento inteiro ----------------------------------------------------
  // Ordem de pintura: raias atrás, ligações por baixo das formas (a seta não
  // corta o texto de quem ela atravessa), traços livres por cima de tudo.
  function camadas(doc, opts) {
    const mapa = nosPorId(doc);
    return {
      raias: (doc.raias || []).map((r, i) => raiaSVG(r, i, opts)).join(""),
      ligacoes: (doc.ligacoes || []).map((l) => ligacaoSVG(l, mapa, opts)).join(""),
      nos: (doc.nos || []).map((x) => noSVG(x, opts)).join(""),
      livres: (doc.livres || []).map((f) => livreSVG(f, opts)).join(""),
    };
  }

  function limites(doc) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const somar = (x, y, w, h) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    };
    (doc.raias || []).forEach((r) => somar(r.x, r.y, r.w, r.h));
    (doc.nos || []).forEach((x) => {
      somar(x.x, x.y, x.w, x.h);
      const f = F.forma(x.tipo);
      if (f.rotuloAbaixo || f.rotuloTopo) { const a = f.texto(x.w, x.h); somar(x.x + a.x, x.y + a.y, a.w, a.h); }
    });
    (doc.livres || []).forEach((f) => (f.pontos || []).forEach((p) => somar(p[0], p[1], 0, 0)));
    if (x0 === Infinity) return { x: 0, y: 0, w: 400, h: 300 };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // SVG solto, com cores literais e fundo branco — exportação e PDF.
  function paraSVG(doc, opts) {
    opts = opts || {};
    const m = opts.margem == null ? 24 : opts.margem;
    const b = limites(doc);
    const vb = [b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m].map(n);
    const c = camadas(doc, {});
    const tam = opts.largura ? ` width="${n(opts.largura)}"` : ` width="${vb[2]}" height="${vb[3]}"`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}"${tam} preserveAspectRatio="xMidYMid meet">` +
           `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="#ffffff"/>` +
           c.raias + c.ligacoes + c.nos + c.livres + `</svg>`;
  }

  const API = { camadas, paraSVG, limites, rota, nosPorId, meioDoCaminho, quebrar, alturaTexto,
                largura, esc, RAIA_CAB, FONTE, FAMILIA };
  raiz.FluxoRender = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
