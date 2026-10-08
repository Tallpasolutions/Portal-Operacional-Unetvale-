// Fluxo -> instrução de trabalho, e a "Conferência do fluxo".
//
// Funções PURAS (sem DOM): rodam no editor, na tela da instrução e no teste
// por script com `node`. Determinístico de propósito — mesma folha, mesmos
// passos, sem IA. Quem desenhou sabe o que escreveu; o gerador só percorre.
(function (raiz) {
  "use strict";
  const F = raiz.FluxoFormas || (typeof require !== "undefined" ? require("./fluxo_formas.js") : null);

  function indices(doc) {
    const nos = {}, saem = {}, entram = {};
    (doc.nos || []).forEach((x) => { nos[x.id] = x; saem[x.id] = []; entram[x.id] = []; });
    (doc.ligacoes || []).forEach((l) => {
      const a = l.de && l.de.no, b = l.para && l.para.no;
      if (!nos[a] || !nos[b]) return;
      saem[a].push(l);
      entram[b].push(l);
    });
    return { nos, saem, entram };
  }

  // Ordem de leitura de uma folha: de cima para baixo, da esquerda para a
  // direita. É o que deixa o gerador estável — a mesma folha sai igual.
  function ordemLeitura(a, b) {
    const ay = a.y + a.h / 2, by = b.y + b.h / 2;
    if (Math.abs(ay - by) > 12) return ay - by;
    return (a.x + a.w / 2) - (b.x + b.w / 2);
  }

  const norm = (s) => String(s || "").trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");

  function ehInicio(no, idx) {
    if (no.tipo !== "terminal") return false;
    const t = norm(no.texto);
    if (/^(inicio|comeco|start)/.test(t)) return true;
    return !idx.entram[no.id].length && idx.saem[no.id].length > 0;
  }
  function ehFim(no, idx) {
    return no.tipo === "terminal" && !ehInicio(no, idx);
  }

  // Formas que participam do fluxo (as livres e os ícones são ilustração).
  function participa(no) {
    const g = F.forma(no.tipo).grupo;
    return g === "fluxograma" || g === "" /* forma desconhecida */;
  }

  // ---------------------------------------------------------------------------
  // Conferência: aviso, não bloqueio. O fluxo pode estar no meio do desenho.
  // ---------------------------------------------------------------------------
  function conferir(doc) {
    const idx = indices(doc);
    const avisos = [];
    const nos = (doc.nos || []).filter(participa);
    const inicios = nos.filter((x) => ehInicio(x, idx));
    const fins = nos.filter((x) => ehFim(x, idx));

    if (!nos.length) return [{ texto: "A folha está vazia. Comece pelo Terminal de Início.", ids: [] }];
    if (!inicios.length) avisos.push({ texto: "Falta o Início: um Terminal escrito “Início”.", ids: [] });
    if (inicios.length > 1) avisos.push({ texto: `${inicios.length} Inícios. Um fluxo tem um começo só — os outros viram conectores?`, ids: inicios.map((x) => x.id) });
    if (!fins.length) avisos.push({ texto: "Falta o Fim: um Terminal sem saída.", ids: [] });

    nos.forEach((no) => {
      const nome = no.texto ? `“${no.texto.replace(/\s+/g, " ").slice(0, 40)}”` : F.forma(no.tipo).nome;
      if (no.tipo === "anotacao") return;
      if (no.tipo === "decisao") {
        const s = idx.saem[no.id];
        if (s.length < 2) avisos.push({ texto: `Decisão ${nome} tem ${s.length ? "uma saída só" : "nenhuma saída"}.`, ids: [no.id] });
        else if (s.some((l) => !String(l.texto || "").trim())) avisos.push({ texto: `Decisão ${nome}: rotule as saídas (Sim/Não).`, ids: [no.id] });
      }
      if (ehInicio(no, idx) || ehFim(no, idx) || no.tipo === "conector" || no.tipo === "fora_pagina") return;
      if (!idx.entram[no.id].length) avisos.push({ texto: `${nome} não recebe nenhuma seta.`, ids: [no.id] });
      else if (!idx.saem[no.id].length) avisos.push({ texto: `${nome} não leva a lugar nenhum.`, ids: [no.id] });
    });

    // Conector "A" precisa do par "A": um sai, outro chega.
    const conectores = nos.filter((x) => x.tipo === "conector");
    const porRotulo = {};
    conectores.forEach((c) => { (porRotulo[norm(c.texto)] = porRotulo[norm(c.texto)] || []).push(c); });
    Object.keys(porRotulo).forEach((k) => {
      if (porRotulo[k].length < 2) avisos.push({ texto: `Conector “${porRotulo[k][0].texto || "?"}” sem par.`, ids: porRotulo[k].map((x) => x.id) });
    });

    // Fim alcançável a partir do Início.
    if (inicios.length && fins.length) {
      const visto = alcance(inicios[0], idx, doc);
      if (!fins.some((f) => visto.has(f.id))) avisos.push({ texto: "Nenhum Fim é alcançado a partir do Início.", ids: fins.map((x) => x.id) });
      const soltas = nos.filter((x) => !visto.has(x.id) && x.tipo !== "anotacao");
      if (soltas.length) avisos.push({ texto: `${soltas.length} forma${soltas.length > 1 ? "s" : ""} fora do caminho do Início.`, ids: soltas.map((x) => x.id) });
    }
    return avisos;
  }

  // Tudo que se alcança do Início, atravessando conectores pelo rótulo.
  function alcance(inicio, idx, doc) {
    const visto = new Set();
    const fila = [inicio.id];
    const conectores = (doc.nos || []).filter((x) => x.tipo === "conector");
    while (fila.length) {
      const id = fila.shift();
      if (visto.has(id)) continue;
      visto.add(id);
      const no = idx.nos[id];
      idx.saem[id].forEach((l) => fila.push(l.para.no));
      if (no && no.tipo === "conector") {
        conectores.filter((c) => c.id !== id && norm(c.texto) === norm(no.texto)).forEach((c) => fila.push(c.id));
      }
    }
    return visto;
  }

  const API = { conferir, indices, ordemLeitura, ehInicio, ehFim, participa, alcance, norm };
  raiz.FluxoIT = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
