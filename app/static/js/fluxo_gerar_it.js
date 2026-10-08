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

  // ---------------------------------------------------------------------------
  // Gerar os passos da instrução
  // ---------------------------------------------------------------------------
  // Cada forma de AÇÃO alcançável do Início vira um passo, na ordem do
  // caminho (Sim antes de Não, e de cima para baixo). A raia vira o "Quem".
  // Conector, junção, mesclar e Fim não viram passo: são o caminho entre eles.
  //
  // Os desvios ficam ESTRUTURADOS (`{rotulo, no}`), e não como "passo 5": a
  // pessoa reordena os passos depois, e um número escrito ficaria apontando
  // para o passo errado. O texto ("Sim → passo 5") é recalculado a cada
  // mudança por `textoDesvios`, que é a única função que o escreve.
  const PRIORIDADE_ROTULO = (t) => {
    const r = norm(t);
    if (/^(sim|s|yes|ok|aprovad)/.test(r)) return 0;
    if (/^(nao|n|no|reprovad)/.test(r)) return 2;
    return 1;
  };

  function ehPasso(no) {
    if (!participa(no)) return false;
    if (no.tipo === "decisao") return true;
    return !!F.forma(no.tipo).acao;
  }

  function gerar(doc) {
    const idx = indices(doc);
    const raias = {};
    (doc.raias || []).forEach((r) => { raias[r.id] = (r.titulo || "").trim(); });
    const conectores = (doc.nos || []).filter((x) => x.tipo === "conector");
    const pares = (no) => conectores.filter((c) => c.id !== no.id && norm(c.texto) === norm(no.texto));

    const saidasOrdenadas = (id) => idx.saem[id].slice().sort((a, b) =>
      (PRIORIDADE_ROTULO(a.texto) - PRIORIDADE_ROTULO(b.texto)) ||
      ordemLeitura(idx.nos[a.para.no], idx.nos[b.para.no]));

    // Ordem do caminho.
    const nos = (doc.nos || []).filter(participa);
    const inicios = nos.filter((x) => ehInicio(x, idx)).sort(ordemLeitura);
    const raizes = inicios.length ? inicios : nos.filter((x) => !idx.entram[x.id].length).sort(ordemLeitura);
    const ordem = [], visto = new Set();
    function visitar(id) {
      if (visto.has(id)) return;
      visto.add(id);
      const no = idx.nos[id];
      if (!no) return;
      if (ehPasso(no)) ordem.push(id);
      saidasOrdenadas(id).forEach((l) => visitar(l.para.no));
      if (no.tipo === "conector" && !idx.saem[id].length) pares(no).forEach((c) => visitar(c.id));
    }
    raizes.forEach((r) => visitar(r.id));

    // Para onde uma saída leva, atravessando o que não é passo.
    function destino(id, guarda) {
      guarda = guarda || new Set();
      if (guarda.has(id)) return null;
      guarda.add(id);
      const no = idx.nos[id];
      if (!no) return null;
      if (ehPasso(no)) return { no: id };
      if (no.tipo === "terminal") return { fim: true };
      if (no.tipo === "fora_pagina") return { fora: (no.texto || "outro fluxo").trim() };
      let prox = idx.saem[id];
      if (no.tipo === "conector" && !prox.length) {
        for (const c of pares(no)) { const d = destino(c.id, guarda); if (d) return d; }
        return null;
      }
      for (const l of prox) { const d = destino(l.para.no, guarda); if (d) return d; }
      return null;
    }

    // Anotações ligadas à forma (por qualquer lado da seta).
    function anotacoes(id) {
      const txt = [];
      (doc.ligacoes || []).forEach((l) => {
        const outro = l.de.no === id ? l.para.no : (l.para.no === id ? l.de.no : null);
        const o = outro && idx.nos[outro];
        if (o && o.tipo === "anotacao" && (o.texto || "").trim()) txt.push(o.texto.trim());
      });
      return txt.join("\n");
    }

    const passos = ordem.map((id, i) => {
      const no = idx.nos[id];
      const atividade = (no.texto || "").replace(/\s+/g, " ").trim() || F.forma(no.tipo).nome;
      const quem = raias[no.raia] || "";
      const desvios = [];
      const sai = saidasOrdenadas(id);
      if (no.tipo === "decisao") {
        sai.forEach((l) => {
          const d = destino(l.para.no);
          if (d) desvios.push(Object.assign({ rotulo: (l.texto || "").trim() || "Saída" }, d));
        });
      } else {
        // Caminho linear não precisa de desvio escrito; só o salto (volta a
        // um passo anterior, pula o seguinte ou encerra antes do fim da lista).
        sai.forEach((l) => {
          const d = destino(l.para.no);
          if (!d) return;
          const seguinte = ordem[i + 1];
          if (d.no && d.no === seguinte) return;
          if (d.fim && i === ordem.length - 1) return;
          desvios.push(Object.assign({ rotulo: sai.length > 1 ? ((l.texto || "").trim() || "Depois") : "Depois" }, d));
        });
      }
      return {
        id: "p_" + id, no_id: id, tipo: no.tipo === "decisao" ? "decisao" : "acao",
        quem, atividade, detalhe: "", atencao: anotacoes(id), desvios,
        gerado: { atividade, quem },
      };
    });

    const avisos = [];
    const fora = nos.filter((x) => ehPasso(x) && !visto.has(x.id));
    if (!raizes.length) avisos.push("Não há por onde começar: falta o Terminal de Início.");
    if (fora.length) avisos.push(`${fora.length} forma${fora.length > 1 ? "s" : ""} fora do caminho do Início não ${fora.length > 1 ? "viraram passos" : "virou passo"}: ` +
      fora.map((x) => `“${(x.texto || F.forma(x.tipo).nome).replace(/\s+/g, " ").slice(0, 30)}”`).join(", ") + ".");
    const semQuem = passos.filter((p) => !p.quem).length;
    if (semQuem) avisos.push(`${semQuem} passo${semQuem > 1 ? "s" : ""} sem responsável: a forma está fora de qualquer raia.`);
    return { passos, avisos };
  }

  // ---------------------------------------------------------------------------
  // Mesclar com o que já foi escrito — regerar não apaga ninguém.
  // ---------------------------------------------------------------------------
  // O casamento é pela forma de origem (`no_id`). Detalhe e atenção escritos
  // à mão ficam. A atividade só é trocada se ninguém a editou (ela ainda é a
  // que o fluxo gerou da última vez); editada, ela fica e a prévia mostra o
  // que o fluxo diz agora. Passo cuja forma sumiu NÃO some em silêncio: vai
  // para `removidos`, e quem decide é a pessoa. Passo escrito à mão (sem
  // `no_id`) fica depois do mesmo passo que o precedia.
  function mesclar(atuais, gerados) {
    atuais = atuais || [];
    const porNo = {};
    atuais.forEach((p) => { if (p.no_id) porNo[p.no_id] = p; });
    const novos = [], alterados = [], conflitos = [];
    let iguais = 0;
    const doFluxo = gerados.map((g) => {
      const a = porNo[g.no_id];
      if (!a) { novos.push(g); return Object.assign({}, g); }
      const ant = a.gerado || {};
      const editouAtiv = ant.atividade != null && a.atividade !== ant.atividade;
      const editouQuem = ant.quem != null && a.quem !== ant.quem;
      const r = Object.assign({}, a, {
        tipo: g.tipo, desvios: g.desvios, gerado: g.gerado,
        atividade: editouAtiv ? a.atividade : g.atividade,
        quem: editouQuem ? a.quem : g.quem,
        atencao: (a.atencao || "").trim() ? a.atencao : g.atencao,
      });
      const mudouFluxo = ant.atividade !== g.atividade || ant.quem !== g.quem;
      if (mudouFluxo && (editouAtiv || editouQuem)) conflitos.push({ passo: r, fluxoDiz: g.atividade });
      else if (mudouFluxo) alterados.push(r);
      else iguais++;
      return r;
    });
    const vivos = new Set(gerados.map((g) => g.no_id));
    const removidos = atuais.filter((p) => p.no_id && !vivos.has(p.no_id));

    // Passos à mão: depois do passo do fluxo que os precedia.
    const resultado = doFluxo.slice();
    let ancora = null;
    const manuaisPorAncora = [];
    atuais.forEach((p) => {
      if (p.no_id && vivos.has(p.no_id)) { ancora = p.no_id; return; }
      if (!p.no_id) manuaisPorAncora.push({ p, ancora });
    });
    manuaisPorAncora.reverse().forEach(({ p, ancora }) => {
      const i = ancora ? resultado.findIndex((x) => x.no_id === ancora) : -1;
      resultado.splice(i + 1, 0, p);
    });
    return { passos: resultado, novos, alterados, conflitos, removidos, iguais };
  }

  // "Sim → passo 5 · Não → encerrar". Recalculado a cada mudança da lista,
  // para o número acompanhar a reordenação.
  function textoDesvios(passos) {
    const pos = {};
    passos.forEach((p, i) => { if (p.no_id) pos[p.no_id] = i + 1; });
    passos.forEach((p, i) => {
      p.desvio_texto = (p.desvios || []).map((d) => {
        // "Depois → passo seguinte" (ou "encerrar" no último) é o que a
        // leitura já faz sozinha: depois de reordenar, o salto gerado pode
        // ter virado só isso, e escrito vira ruído.
        if (p.tipo !== "decisao" && d.rotulo === "Depois" &&
            ((d.no && pos[d.no] === i + 2) || (d.fim && i === passos.length - 1))) return null;
        let alvo;
        if (d.no) alvo = pos[d.no] ? `passo ${pos[d.no]}` : "passo removido";
        else if (d.fim) alvo = "encerrar";
        else if (d.fora) alvo = `continua em ${d.fora}`;
        else return null;
        return `${d.rotulo} → ${alvo}`;
      }).filter(Boolean).join(" · ");
    });
    return passos;
  }

  const API = { conferir, indices, ordemLeitura, ehInicio, ehFim, participa, alcance, norm,
                gerar, mesclar, textoDesvios, ehPasso };
  raiz.FluxoIT = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
