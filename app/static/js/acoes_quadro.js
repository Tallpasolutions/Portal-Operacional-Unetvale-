// Módulo Ações — quadro Kanban, lista e cronograma.
//
// As três visões desenham a partir do MESMO `window.__ACOES__`, com o mesmo
// filtro. O servidor já mandou só o que a pessoa pode ver (recorte de
// permissão em `acoes.listar`); aqui o filtro é de leitura, e mudar um chip
// redesenha sem ida ao servidor nem perda do painel lateral aberto.
//
// Cliques são delegados nos contêineres (`#ac-quadro`, `#ac-lista`,
// `#ac-cronograma`): o conteúdo é redesenhado a cada filtro, e ouvinte preso
// ao cartão morreria com ele — a lição do cross-filter do Dashboard.
(function () {
  "use strict";

  const P = window.__ACOES__;
  const secao = document.querySelector('[data-painel="acoes"]');
  if (!P || !secao) return;

  const STATUS = P.status;
  const TERMINAIS = ["Concluída", "Cancelada"];
  const PRIORIDADES = P.prioridades;
  // "Concluída" mostra só o último mês no quadro: a coluna é para ver o que
  // ACABOU de sair, e com o tempo ela ficaria mais comprida que todas as
  // outras juntas. O resto continua a um clique.
  const JANELA_CONCLUIDAS = 30;
  // Mesma ordem de urgência do servidor (`acoes.listar`): atrasada antes de
  // "vence em breve", e dentro do grupo a prioridade decide. É a ordem em que
  // a pauta é lida — por isso não há ordenação manual dentro da coluna.
  const ORDEM_SITUACAO = { "Atrasada": 0, "Vence em breve": 1, "No prazo": 2, "Sem prazo": 3, "Concluída": 4, "Cancelada": 5 };
  const ORDEM_PRIORIDADE = Object.fromEntries(PRIORIDADES.map((p, i) => [p, i]));

  let acoes = P.acoes.slice();
  const idxUsuario = new Map(P.usuarios.map((u, i) => [u.id, i]));
  const nomeUsuario = (id) => (P.usuarios[idxUsuario.get(id)] || {}).nome || "—";
  const nomeArea = new Map(P.areas.map((a) => [a.id, a.nome]));

  const $ = (s) => document.querySelector(s);
  const elQuadro = $("#ac-quadro");
  const elLista = $("#ac-lista");
  const elCrono = $("#ac-cronograma");

  const estado = {
    q: "", responsavel: "", area: "", prioridade: "", etiqueta: "",
    atalhos: new Set(), agrupar: "", visao: "quadro",
    ord: { col: "", dir: 1 },
    cancelAberta: false, concluidasTodas: false, raiasFechadas: new Set(),
    selecionada: null,
  };

  // ---------------------------------------------------------------- util
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const slug = (s) => semAcento(s).replace(/\s+/g, "-");
  const dataBR = (iso) => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : "");
  const diaNum = (iso) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
  const isoDe = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const HOJE = P.hoje;
  const MESES = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

  function iniciais(nome) {
    const p = String(nome || "?").trim().split(/\s+/);
    return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
  }
  function avatar(id) {
    const i = idxUsuario.has(id) ? idxUsuario.get(id) % 6 : 5;
    const nome = nomeUsuario(id);
    return '<span class="avatar av-' + i + '" title="' + esc(nome) + '">' + esc(iniciais(nome)) + "</span>";
  }

  const SVG = {
    chk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/></svg>',
    fala: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
    reuniao: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  };

  function ordenar(lista) {
    return lista.sort((a, b) =>
      (ORDEM_SITUACAO[a.situacao] ?? 9) - (ORDEM_SITUACAO[b.situacao] ?? 9)
      || (ORDEM_PRIORIDADE[a.prioridade] ?? 9) - (ORDEM_PRIORIDADE[b.prioridade] ?? 9)
      || String(a.prazo || "9999-12-31").localeCompare(String(b.prazo || "9999-12-31")));
  }

  // --------------------------------------------------------------- filtro
  function passa(a) {
    const eu = P.eu;
    if (estado.responsavel && a.responsavel_id !== estado.responsavel
        && !(a.apoio_ids || []).includes(estado.responsavel)) return false;
    if (estado.area && a.area_id !== estado.area) return false;
    if (estado.prioridade && a.prioridade !== estado.prioridade) return false;
    if (estado.etiqueta && !(a.etiquetas || []).some((t) => semAcento(t) === semAcento(estado.etiqueta))) return false;
    // Atalhos somam restrições (E, não OU): "Minhas" + "Atrasadas" é a
    // pergunta de segunda de manhã — o que é meu e está vencido.
    for (const at of estado.atalhos) {
      if (at === "minhas" && a.responsavel_id !== eu && !(a.apoio_ids || []).includes(eu)) return false;
      if (at === "atrasadas" && a.situacao !== "Atrasada") return false;
      if (at === "breve" && a.situacao !== "Vence em breve") return false;
      if (at === "criticas" && !["Crítica", "Alta"].includes(a.prioridade)) return false;
    }
    if (estado.q) {
      const alvo = semAcento([a.codigo, a.titulo, (a.etiquetas || []).join(" "),
        nomeUsuario(a.responsavel_id), nomeArea.get(a.area_id) || ""].join(" "));
      if (!semAcento(estado.q).split(/\s+/).every((p) => alvo.includes(p))) return false;
    }
    return true;
  }

  const filtrando = () => !!(estado.q || estado.responsavel || estado.area || estado.prioridade
    || estado.etiqueta || estado.atalhos.size);

  // ---------------------------------------------------------- estado na URL
  // Tudo na URL: recarregar, mandar o link para alguém e o "voltar" do
  // navegador devolvem a MESMA tela. `replaceState` para filtro (não enche o
  // histórico a cada tecla); o painel lateral é quem usa `pushState`.
  function lerURL() {
    const p = new URL(location.href).searchParams;
    estado.q = p.get("q") || "";
    estado.responsavel = p.get("responsavel") || "";
    estado.area = p.get("area") || "";
    estado.prioridade = p.get("prioridade") || "";
    estado.etiqueta = p.get("etiqueta") || "";
    estado.agrupar = p.get("agrupar") || "";
    estado.visao = ["quadro", "lista", "cronograma"].includes(p.get("visao")) ? p.get("visao") : "quadro";
    estado.atalhos = new Set((p.get("atalhos") || "").split(",").filter(Boolean));
    // Links antigos da tabela filtravam por `situacao`; viram o atalho.
    if (p.get("situacao") === "Atrasada") estado.atalhos.add("atrasadas");
    if (p.get("situacao") === "Vence em breve") estado.atalhos.add("breve");
  }
  function escreverURL() {
    const u = new URL(location.href);
    const par = { q: estado.q, responsavel: estado.responsavel, area: estado.area,
      prioridade: estado.prioridade, etiqueta: estado.etiqueta, agrupar: estado.agrupar,
      atalhos: [...estado.atalhos].join(","), visao: estado.visao === "quadro" ? "" : estado.visao };
    for (const [k, v] of Object.entries(par)) { if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); }
    u.searchParams.delete("situacao"); u.searchParams.delete("status");
    history.replaceState(history.state, "", u);
  }

  // ---------------------------------------------------------- agrupamento
  function grupos(lista) {
    if (!estado.agrupar) return [{ chave: "", rotulo: "", itens: lista }];
    const mapa = new Map();
    const chaveDe = {
      responsavel: (a) => a.responsavel_id,
      area: (a) => a.area_id || "",
      prioridade: (a) => a.prioridade,
    }[estado.agrupar];
    const rotuloDe = {
      responsavel: (k) => nomeUsuario(k),
      area: (k) => nomeArea.get(k) || "Sem área",
      prioridade: (k) => k,
    }[estado.agrupar];
    for (const a of lista) {
      const k = chaveDe(a);
      if (!mapa.has(k)) mapa.set(k, { chave: k, rotulo: rotuloDe(k), itens: [] });
      mapa.get(k).itens.push(a);
    }
    const saida = [...mapa.values()];
    if (estado.agrupar === "prioridade") saida.sort((x, y) => ORDEM_PRIORIDADE[x.chave] - ORDEM_PRIORIDADE[y.chave]);
    else saida.sort((x, y) => x.rotulo.localeCompare(y.rotulo, "pt-BR"));
    return saida;
  }

  // ---------------------------------------------------------------- cartão
  function chipPrazo(a) {
    if (a.status === "Concluída") return '<span class="ck-prazo feita">✓ ' + (a.data_conclusao ? dataBR(a.data_conclusao) : "concluída") + "</span>";
    if (a.status === "Cancelada") return '<span class="ck-prazo semprazo">cancelada</span>';
    if (a.situacao === "Atrasada") return '<span class="ck-prazo atrasada" title="Prazo ' + dataBR(a.prazo) + '">atrasada ' + (-a.dias) + "d</span>";
    if (a.situacao === "Vence em breve") return '<span class="ck-prazo breve" title="Prazo ' + dataBR(a.prazo) + '">' + (a.dias === 0 ? "vence hoje" : "vence em " + a.dias + "d") + "</span>";
    if (a.prazo) return '<span class="ck-prazo noprazo">' + dataBR(a.prazo) + "</span>";
    return '<span class="ck-prazo semprazo">sem prazo</span>';
  }

  function cartao(a) {
    const arrasta = a.pode_atualizar ? ' draggable="true"' : "";
    const tags = [];
    if (a.area_id && estado.agrupar !== "area") tags.push('<span class="ck-area">' + esc(nomeArea.get(a.area_id) || "") + "</span>");
    for (const t of a.etiquetas || []) tags.push('<span class="etiqueta">' + esc(t) + "</span>");
    const ic = [];
    if (a.chk_total) ic.push('<span class="' + (a.chk_feitos === a.chk_total ? "chk-completo" : "") + '" title="Checklist">' + SVG.chk + a.chk_feitos + "/" + a.chk_total + "</span>");
    if (a.eventos) ic.push('<span title="Atualizações e comentários">' + SVG.fala + a.eventos + "</span>");
    if (a.reunioes) ic.push('<span title="Reuniões em que apareceu">' + SVG.reuniao + a.reunioes + "</span>");
    const apoio = (a.apoio_ids || []);
    const mostrarProg = a.progresso > 0 || a.chk_total > 0;
    return '<article class="cartao-k pri-' + slug(a.prioridade) + (estado.selecionada === a.id ? " selecionado" : "")
      + '" data-id="' + a.id + '" tabindex="0"' + arrasta + ' aria-label="' + esc(a.codigo + " — " + a.titulo) + '">'
      + '<div class="ck-topo"><span class="ck-cod">' + esc(a.codigo) + '</span><span class="ck-pri">' + esc(a.prioridade) + "</span></div>"
      + '<div class="ck-titulo">' + esc(a.titulo) + "</div>"
      + (tags.length ? '<div class="ck-tags">' + tags.join("") + "</div>" : "")
      + (ic.length ? '<div class="ck-icones">' + ic.join("") + "</div>" : "")
      + (mostrarProg ? '<span class="barra" title="' + a.progresso + '%"><i style="width:' + a.progresso + '%"></i></span>' : "")
      + '<div class="ck-pe"><span class="avatares">' + avatar(a.responsavel_id)
      + apoio.slice(0, 2).map(avatar).join("")
      + (apoio.length > 2 ? '<span class="avatar av-5" title="mais ' + (apoio.length - 2) + '">+' + (apoio.length - 2) + "</span>" : "")
      + "</span>" + chipPrazo(a) + "</div>"
      + "</article>";
  }

  // ---------------------------------------------------------------- quadro
  function recenteConcluida(a) {
    if (!a.data_conclusao) return true;
    return diaNum(HOJE) - diaNum(a.data_conclusao) <= JANELA_CONCLUIDAS;
  }

  function renderQuadro(lista) {
    const gs = grupos(lista);
    const agrupando = !!estado.agrupar;
    let h = '<div class="quadro-wrap"><div class="quadro' + (estado.cancelAberta ? " cancel-aberta" : "") + '">';

    for (const s of STATUS) {
      const n = lista.filter((a) => a.status === s).length;
      if (s === "Cancelada" && !estado.cancelAberta) {
        h += '<div class="col-cab recolhida" title="Canceladas"><span class="n">' + n + "</span></div>";
        continue;
      }
      let nota = "";
      if (s === "Concluída") {
        nota = estado.concluidasTodas
          ? '<button type="button" data-concluidas="recentes">só últimos ' + JANELA_CONCLUIDAS + " dias</button>"
          : "últimos " + JANELA_CONCLUIDAS + " dias";
      }
      if (s === "Cancelada") nota = '<button type="button" data-recolher-cancel>recolher</button>';
      h += '<div class="col-cab">' + esc(s) + ' <span class="n">' + n + "</span>"
        + (nota ? '<span class="col-nota">' + nota + "</span>" : "") + "</div>";
    }

    for (const g of gs) {
      if (agrupando) {
        const atr = g.itens.filter((a) => a.situacao === "Atrasada").length;
        const fechada = estado.raiasFechadas.has(g.chave);
        h += '<div class="raia-cab' + (fechada ? " fechada" : "") + '" data-raia="' + esc(g.chave) + '" role="button" tabindex="0" aria-expanded="' + !fechada + '">'
          + '<span class="raia-seta">▾</span>'
          + (estado.agrupar === "responsavel" ? avatar(g.chave) : "")
          + "<span>" + esc(g.rotulo) + "</span>"
          + '<span class="raia-resumo">' + g.itens.length + (g.itens.length === 1 ? " ação" : " ações")
          + (atr ? " · " + atr + (atr === 1 ? " atrasada" : " atrasadas") : "") + "</span></div>";
        if (fechada) continue;
      }
      for (const s of STATUS) {
        let itens = g.itens.filter((a) => a.status === s);
        if (s === "Cancelada" && !estado.cancelAberta) {
          h += '<div class="col recolhida" data-status="Cancelada" data-abrir-cancel title="Mostrar canceladas">'
            + '<span class="col-vertical">Canceladas' + (itens.length ? " · " + itens.length : "") + "</span></div>";
          continue;
        }
        let escondidas = 0;
        if (s === "Concluída" && !estado.concluidasTodas) {
          const recentes = itens.filter(recenteConcluida);
          escondidas = itens.length - recentes.length;
          itens = recentes;
        }
        h += '<div class="col" data-status="' + esc(s) + '" data-raia="' + esc(g.chave) + '">';
        h += itens.map(cartao).join("");
        // Com raias, "Nada aqui" repetido em toda célula vazia vira ruído:
        // a raia já diz de quem é, e a célula vazia continua alvo de arrasto.
        if (!itens.length && !escondidas && !agrupando) h += '<div class="col-vazia">Nada aqui</div>';
        if (escondidas) h += '<button type="button" class="col-mais" data-concluidas="todas">+ ' + escondidas + " mais antiga" + (escondidas > 1 ? "s" : "") + "</button>";
        if (s === "Não iniciada" && P.pode_criar) h += '<button type="button" class="col-add" data-nova-na-col>+ Adicionar ação</button>';
        h += "</div>";
      }
    }
    h += "</div></div>";
    if (!lista.length && !filtrando()) {
      h = '<div class="vazio">Nenhuma ação por aqui ainda.'
        + (P.pode_criar ? " Crie a primeira em <b>+ Nova ação</b>." : " Quando alguma for atribuída a você, ela aparece aqui.") + "</div>";
    }
    elQuadro.innerHTML = h;
  }

  // ----------------------------------------------------------------- lista
  const COLUNAS_LISTA = [
    ["codigo", "ID"], ["titulo", "Ação"], ["area", "Área"], ["responsavel", "Responsável"],
    ["status", "Status"], ["prazo", "Prazo"], ["progresso", "Progresso"], ["situacao", "Situação"],
  ];
  const chaveOrd = {
    codigo: (a) => a.codigo, titulo: (a) => semAcento(a.titulo),
    area: (a) => semAcento(nomeArea.get(a.area_id) || "~"), responsavel: (a) => semAcento(nomeUsuario(a.responsavel_id)),
    status: (a) => STATUS.indexOf(a.status), prazo: (a) => a.prazo || "9999", progresso: (a) => a.progresso,
    situacao: (a) => ORDEM_SITUACAO[a.situacao] ?? 9,
  };

  function renderLista(lista) {
    if (!lista.length) { elLista.innerHTML = '<div class="vazio">Nenhuma ação com esses filtros.</div>'; return; }
    let itens = lista.slice();
    if (estado.ord.col) {
      const k = chaveOrd[estado.ord.col];
      itens.sort((a, b) => (k(a) > k(b) ? 1 : k(a) < k(b) ? -1 : 0) * estado.ord.dir);
    }
    let h = '<div class="card so-desktop"><div class="card-b tabela-wrap" style="padding:0;"><table class="tbl ac-tabela"><thead><tr>';
    for (const [k, rot] of COLUNAS_LISTA) {
      const cls = estado.ord.col === k ? (estado.ord.dir > 0 ? "ord-asc" : "ord-desc") : "";
      h += '<th data-ord="' + k + '" class="' + cls + (k === "progresso" ? " num" : "") + '">' + rot + "</th>";
    }
    h += "</tr></thead><tbody>";
    for (const a of itens) {
      h += '<tr class="clicavel' + (estado.selecionada === a.id ? " selecionado" : "") + '" data-id="' + a.id + '" tabindex="0">'
        + '<td class="cod"><b>' + esc(a.codigo) + "</b></td>"
        + "<td>" + esc(a.titulo) + ' <span class="pri pri-' + slug(a.prioridade) + '">' + esc(a.prioridade) + "</span>"
        + (a.etiquetas || []).map((t) => '<span class="etiqueta">' + esc(t) + "</span>").join("") + "</td>"
        + "<td>" + esc(nomeArea.get(a.area_id) || "—") + "</td>"
        + '<td><span class="pessoa">' + avatar(a.responsavel_id) + esc(nomeUsuario(a.responsavel_id)) + "</span></td>"
        + "<td>" + esc(a.status) + "</td>"
        + "<td>" + (a.prazo ? a.prazo.split("-").reverse().join("/") : "—") + "</td>"
        + '<td class="num"><span class="prog"><span class="barra"><i style="width:' + a.progresso + '%"></i></span><b>' + a.progresso + "%</b></span></td>"
        + "<td>" + chipPrazo(a) + "</td></tr>";
    }
    h += "</tbody></table></div></div>";
    // No celular, a lista é de cartões: tabela de 8 colunas num telefone é
    // ilegível, e é no telefone que a ação é atualizada em campo.
    h += '<div class="so-mobile ac-lista-mobile">' + itens.map(cartao).join("") + "</div>";
    elLista.innerHTML = h;
    elLista.querySelectorAll(".ac-lista-mobile .cartao-k").forEach((c) => { c.removeAttribute("draggable"); c.style.marginBottom = "8px"; });
  }

  // ------------------------------------------------------------ cronograma
  // Barra da abertura ao prazo; preenchimento = progresso; o que passou do
  // prazo fica listrado até hoje. Uma linha por ação, agrupadas por pessoa
  // (ou pelo agrupamento escolhido). Só leitura: arrastar datas seria mudar
  // prazo sem passar pela definição do gestor.
  function renderCronograma(lista) {
    const comPrazo = lista.filter((a) => a.prazo && a.status !== "Cancelada");
    const semPrazo = lista.filter((a) => !a.prazo && a.status !== "Cancelada");
    if (!comPrazo.length) {
      elCrono.innerHTML = '<div class="vazio">Nenhuma ação com prazo nesses filtros.</div>' + listaSemPrazo(semPrazo);
      return;
    }
    const hoje = diaNum(HOJE);
    const inicioDe = (a) => diaNum(a.data_abertura || a.prazo);
    // Janela: da abertura mais antiga (no máximo 4 meses atrás) ao prazo mais
    // distante (no máximo 6 meses à frente), com folga dos dois lados.
    let ini = Math.min(hoje - 7, ...comPrazo.map(inicioDe));
    let fim = Math.max(hoje + 14, ...comPrazo.map((a) => diaNum(a.prazo)));
    ini = Math.max(ini, hoje - 120) - 3;
    fim = Math.min(fim, hoje + 180) + 7;
    // Recua para uma segunda-feira: as linhas da grade caem nas semanas.
    ini -= (new Date(ini * 86400000).getUTCDay() + 6) % 7;
    const dias = fim - ini + 1;
    const PX = window.matchMedia("(max-width:820px)").matches ? 14 : 20;
    const W = dias * PX;
    const x = (d) => (d - ini) * PX;

    let grade = "";
    for (let d = ini; d <= fim; d++) {
      if ((new Date(d * 86400000).getUTCDay() + 6) % 7 === 0) grade += '<div class="crono-grade semana" style="left:' + x(d) + 'px"></div>';
    }
    const linhaHoje = '<div class="crono-hoje" style="left:' + (x(hoje) + PX / 2) + 'px"></div>';

    let cab = "";
    for (let d = ini; d <= fim; d++) {
      const iso = isoDe(d);
      if (iso.slice(8) === "01" || d === ini) {
        // Montado à mão: o `toLocaleDateString` do pt-BR devolve "out. de 26".
        const mes = MESES[+iso.slice(5, 7) - 1] + "/" + iso.slice(2, 4);
        cab += '<div class="crono-mes" style="left:' + x(d) + 'px">' + esc(mes) + "</div>";
      }
      if ((new Date(d * 86400000).getUTCDay() + 6) % 7 === 0) cab += '<div class="crono-dia" style="left:' + (x(d) + PX / 2) + 'px">' + iso.slice(8) + "</div>";
    }
    cab += '<div class="crono-hoje" style="left:' + (x(hoje) + PX / 2) + 'px"><span>hoje</span></div>';

    const agrupador = estado.agrupar || "responsavel";
    const salvo = estado.agrupar; estado.agrupar = agrupador;
    const gs = grupos(comPrazo);
    estado.agrupar = salvo;

    let h = '<div class="crono-wrap"><div class="crono" style="width:' + (W + 170) + 'px">'
      + '<div class="crono-linha crono-cab"><div class="crono-nome">'
      + ({ responsavel: "Responsável", area: "Área", prioridade: "Prioridade" }[agrupador]) + "</div>"
      + '<div class="crono-faixa" style="width:' + W + 'px;height:44px">' + cab + "</div></div>";
    const ALT = 30;
    for (const g of gs) {
      const itens = g.itens.slice().sort((a, b) => inicioDe(a) - inicioDe(b));
      let barras = "";
      itens.forEach((a, i) => {
        const top = 6 + i * ALT;
        const a0 = Math.max(inicioDe(a), ini);
        const p = Math.min(diaNum(a.prazo), fim);
        const esq = x(Math.min(a0, p));
        const larg = Math.max((p - Math.min(a0, p) + 1) * PX, PX);
        const cls = a.status === "Concluída" ? "feita" : a.situacao === "Atrasada" ? "atrasada" : "";
        if (a.situacao === "Atrasada") {
          const exIni = x(p + 1);
          barras += '<div class="crono-excesso" style="left:' + exIni + "px;width:" + Math.max(x(hoje + 1) - exIni, 0) + "px;top:" + top + 'px" title="' + (-a.dias) + ' dia(s) além do prazo"></div>';
        }
        barras += '<div class="crono-barra ' + cls + '" data-id="' + a.id + '" style="left:' + esq + "px;width:" + larg + "px;top:" + top + 'px" title="'
          + esc(a.codigo + " — " + a.titulo + " · " + (a.data_abertura ? dataBR(a.data_abertura) : "?") + " → " + dataBR(a.prazo) + " · " + a.progresso + "%") + '">'
          + '<i style="width:' + a.progresso + '%"></i>' + esc(a.codigo) + " · " + esc(a.titulo) + "</div>";
      });
      h += '<div class="crono-linha"><div class="crono-nome">' + (agrupador === "responsavel" ? avatar(g.chave) : "")
        + "<span>" + esc(g.rotulo) + "</span></div>"
        + '<div class="crono-faixa" style="width:' + W + "px;height:" + (itens.length * ALT + 12) + 'px">' + grade + linhaHoje + barras + "</div></div>";
    }
    h += "</div></div>"
      + '<div class="crono-legenda"><span><i style="background:var(--brand-l);border:1px solid var(--brand)"></i>em aberto (preenchido = progresso)</span>'
      + '<span><i style="background:#fdecee;border:1px solid var(--danger)"></i>atrasada — listrado até hoje</span>'
      + '<span><i style="background:#e3f6ee;border:1px solid var(--success)"></i>concluída</span>'
      + '<span><i style="background:var(--ouro)"></i>hoje</span></div>'
      + listaSemPrazo(semPrazo);
    elCrono.innerHTML = h;
    // Abre com "hoje" à vista, não com o começo da janela.
    const wrap = elCrono.querySelector(".crono-wrap");
    if (wrap) wrap.scrollLeft = Math.max(x(hoje) - wrap.clientWidth * 0.35, 0);
  }

  function listaSemPrazo(itens) {
    if (!itens.length) return "";
    return '<div class="crono-sem-prazo"><b>Sem prazo (' + itens.length + "):</b> "
      + itens.map((a) => '<a data-id="' + a.id + '" tabindex="0">' + esc(a.codigo) + "</a> " + esc(a.titulo)).join(" · ") + "</div>";
  }

  // -------------------------------------------------------------- desenhar
  function desenhar() {
    const lista = ordenar(acoes.filter(passa));
    const total = acoes.length;
    const atr = lista.filter((a) => a.situacao === "Atrasada").length;
    const breve = lista.filter((a) => a.situacao === "Vence em breve").length;
    $("#ac-contagem").innerHTML = lista.length + (lista.length === 1 ? " ação" : " ações")
      + (filtrando() ? " de " + total : "")
      + (atr ? ' · <b style="color:var(--danger)">' + atr + (atr === 1 ? " atrasada" : " atrasadas") + "</b>" : "")
      + (breve ? " · " + breve + " vence" + (breve > 1 ? "m" : "") + " em 7 dias" : "");

    elQuadro.hidden = estado.visao !== "quadro";
    elLista.hidden = estado.visao !== "lista";
    elCrono.hidden = estado.visao !== "cronograma";
    if (estado.visao === "quadro") renderQuadro(lista);
    else if (estado.visao === "lista") renderLista(lista);
    else renderCronograma(lista);
    sincronizarControles();
  }

  function sincronizarControles() {
    const set = (id, v) => { const el = document.getElementById(id); if (el && el.value !== v) el.value = v; };
    set("ac-q", estado.q); set("ac-f-responsavel", estado.responsavel); set("ac-f-area", estado.area);
    set("ac-f-prioridade", estado.prioridade); set("ac-f-etiqueta", estado.etiqueta); set("ac-agrupar", estado.agrupar);
    document.querySelectorAll("#ac-atalhos [data-atalho]").forEach((b) => b.classList.toggle("on", estado.atalhos.has(b.dataset.atalho)));
    document.querySelectorAll("#ac-visoes [data-visao]").forEach((b) => b.classList.toggle("active", b.dataset.visao === estado.visao));
    // `style.display`, não `hidden`: `.btn-ghost` e `.badge` têm display
    // explícito e venceriam o atributo (CLAUDE.md §6).
    const limpar = $("#ac-limpar");
    if (limpar) limpar.style.display = filtrando() ? "" : "none";
    const ativos = $("#ac-filtros-ativos");
    if (ativos) ativos.style.display = (estado.responsavel || estado.area || estado.prioridade
      || estado.etiqueta || estado.agrupar) ? "" : "none";
  }

  function mudou() { escreverURL(); desenhar(); }

  function substituir(item) {
    if (!item) return;
    const i = acoes.findIndex((a) => a.id === item.id);
    if (i >= 0) acoes[i] = item; else acoes.push(item);
    // O painel lateral acha a ação pelo código em `__ACOES__.acoes`.
    P.acoes = acoes;
  }

  // ---------------------------------------------------------- etiquetas
  function montarEtiquetas() {
    const todas = new Map();
    for (const a of acoes) for (const t of a.etiquetas || []) {
      const k = semAcento(t);
      if (!todas.has(k)) todas.set(k, t);
    }
    const lista = [...todas.values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
    const sel = $("#ac-f-etiqueta");
    if (sel) {
      const v = estado.etiqueta;
      sel.innerHTML = '<option value="">Toda etiqueta</option>' + lista.map((t) => '<option value="' + esc(t) + '">' + esc(t) + "</option>").join("");
      sel.value = v;
    }
    const dl = $("#etiquetas-em-uso");
    if (dl) dl.innerHTML = lista.map((t) => '<option value="' + esc(t) + '"></option>').join("");
  }

  // ------------------------------------------------------------ arrastar
  // HTML5 nativo. O cartão muda de coluna NA HORA (otimista) e o diálogo
  // abre; cancelar, ou o servidor recusar, devolve o cartão à origem.
  let arrastando = null;

  elQuadro.addEventListener("dragstart", (e) => {
    const c = e.target.closest(".cartao-k[draggable=true]");
    if (!c) return;
    arrastando = acoes.find((a) => a.id === c.dataset.id) || null;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", c.dataset.id);
    setTimeout(() => c.classList.add("arrastando"), 0);
  });
  elQuadro.addEventListener("dragend", (e) => {
    const c = e.target.closest(".cartao-k");
    if (c) c.classList.remove("arrastando");
    elQuadro.querySelectorAll(".col.alvo").forEach((x) => x.classList.remove("alvo"));
    arrastando = null;
  });
  elQuadro.addEventListener("dragover", (e) => {
    const col = e.target.closest(".col[data-status]");
    if (!col || !arrastando || col.dataset.status === arrastando.status) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!col.classList.contains("alvo")) {
      elQuadro.querySelectorAll(".col.alvo").forEach((x) => x.classList.remove("alvo"));
      col.classList.add("alvo");
    }
  });
  elQuadro.addEventListener("dragleave", (e) => {
    const col = e.target.closest(".col");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("alvo");
  });
  elQuadro.addEventListener("drop", (e) => {
    const col = e.target.closest(".col[data-status]");
    if (!col || !arrastando) return;
    e.preventDefault();
    const a = arrastando;
    arrastando = null;
    col.classList.remove("alvo");
    if (col.dataset.status !== a.status) mover(a, col.dataset.status);
  });

  async function mover(a, novo) {
    const antes = Object.assign({}, a);
    a.status = novo;
    // Cancelar num quadro com a coluna recolhida: abre, para a pessoa ver
    // para onde o cartão foi.
    if (novo === "Cancelada") estado.cancelAberta = true;
    desenhar();
    const r = await window.AcaoMover.abrir(antes, novo);
    if (!r) { Object.assign(a, antes); desenhar(); return; }
    substituir(r);
    desenhar();
  }

  // --------------------------------------------------------------- cliques
  function abrirAcao(id) {
    if (window.AcaoGaveta) window.AcaoGaveta.abrir(id);
  }

  elQuadro.addEventListener("click", (e) => {
    const t = e.target;
    const c = t.closest(".cartao-k");
    if (c) { abrirAcao(c.dataset.id); return; }
    if (t.closest("[data-abrir-cancel]")) { estado.cancelAberta = true; desenhar(); return; }
    if (t.closest("[data-recolher-cancel]")) { estado.cancelAberta = false; desenhar(); return; }
    const conc = t.closest("[data-concluidas]");
    if (conc) { estado.concluidasTodas = conc.dataset.concluidas === "todas"; desenhar(); return; }
    const raia = t.closest(".raia-cab");
    if (raia) {
      const k = raia.dataset.raia;
      if (estado.raiasFechadas.has(k)) estado.raiasFechadas.delete(k); else estado.raiasFechadas.add(k);
      desenhar();
      return;
    }
    const add = t.closest("[data-nova-na-col]");
    if (add) {
      // Na raia de uma pessoa, a ação nova já nasce dela.
      const col = add.closest(".col");
      const pre = {};
      if (estado.agrupar && col.dataset.raia) pre[estado.agrupar] = col.dataset.raia;
      abrirNova(pre);
    }
  });

  [elQuadro, elLista, elCrono].forEach((el) => el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const alvo = e.target.closest("[data-id]");
    if (alvo) { e.preventDefault(); abrirAcao(alvo.dataset.id); return; }
    const raia = e.target.closest(".raia-cab");
    if (raia) { e.preventDefault(); raia.click(); }
  }));

  elLista.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-ord]");
    if (th) {
      const k = th.dataset.ord;
      // Terceiro clique volta à ordem de urgência — a padrão.
      if (estado.ord.col !== k) estado.ord = { col: k, dir: 1 };
      else if (estado.ord.dir === 1) estado.ord.dir = -1;
      else estado.ord = { col: "", dir: 1 };
      desenhar();
      return;
    }
    const alvo = e.target.closest("[data-id]");
    if (alvo) abrirAcao(alvo.dataset.id);
  });

  elCrono.addEventListener("click", (e) => {
    const alvo = e.target.closest("[data-id]");
    if (alvo) abrirAcao(alvo.dataset.id);
  });

  document.addEventListener("acaoatualizada", (e) => {
    substituir(e.detail);
    montarEtiquetas();
    desenhar();
  });
  document.addEventListener("gavetaaberta", (e) => { estado.selecionada = e.detail.id; marcarSelecionada(); });
  document.addEventListener("gavetafechada", () => { estado.selecionada = null; marcarSelecionada(); });
  function marcarSelecionada() {
    document.querySelectorAll(".cartao-k.selecionado, tr.selecionado").forEach((x) => x.classList.remove("selecionado"));
    if (estado.selecionada) {
      document.querySelectorAll('.cartao-k[data-id="' + estado.selecionada + '"], tr[data-id="' + estado.selecionada + '"]')
        .forEach((x) => x.classList.add("selecionado"));
    }
  }

  // ---------------------------------------------------------------- barra
  let buscaTimer = null;
  $("#ac-q").addEventListener("input", (e) => {
    clearTimeout(buscaTimer);
    buscaTimer = setTimeout(() => { estado.q = e.target.value.trim(); mudou(); }, 120);
  });
  $("#ac-q").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target.value) { e.target.value = ""; estado.q = ""; mudou(); e.stopPropagation(); }
  });
  [["ac-f-responsavel", "responsavel"], ["ac-f-area", "area"], ["ac-f-prioridade", "prioridade"],
   ["ac-f-etiqueta", "etiqueta"], ["ac-agrupar", "agrupar"]].forEach(([id, k]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => {
      estado[k] = el.value;
      if (k === "agrupar") estado.raiasFechadas.clear();
      mudou();
    });
  });
  $("#ac-atalhos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-atalho]");
    if (b) {
      const k = b.dataset.atalho;
      if (estado.atalhos.has(k)) estado.atalhos.delete(k); else estado.atalhos.add(k);
      mudou();
      return;
    }
    if (e.target.closest("#ac-limpar")) {
      Object.assign(estado, { q: "", responsavel: "", area: "", prioridade: "", etiqueta: "" });
      estado.atalhos.clear();
      mudou();
    }
  });
  $("#ac-visoes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-visao]");
    if (!b) return;
    estado.visao = b.dataset.visao;
    mudou();
  });

  // Filtros recolhidos no celular. `style.display` e não `hidden`: o CSS
  // põe `display:flex` na barra e venceria o atributo (CLAUDE.md §6).
  const btnFiltros = $("#btn-filtros");
  const caixaFiltros = $("#ac-filtros");
  if (btnFiltros && caixaFiltros) {
    const estreito = () => window.matchMedia("(max-width:820px)").matches;
    const aplicar = () => {
      const recolher = estreito() && btnFiltros.getAttribute("aria-expanded") !== "true";
      caixaFiltros.style.display = recolher ? "none" : "";
    };
    btnFiltros.addEventListener("click", () => {
      btnFiltros.setAttribute("aria-expanded", String(btnFiltros.getAttribute("aria-expanded") !== "true"));
      aplicar();
    });
    window.addEventListener("resize", aplicar);
    aplicar();
  }

  // Atalho de teclado: "/" vai para a busca, como no Jira e no GitHub.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || secao.hidden) return;
    const t = e.target;
    if (t.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    $("#ac-q").focus();
  });

  // ------------------------------------------------------------ nova ação
  const dlgNova = $("#dlg-nova");
  function abrirNova(pre) {
    if (!dlgNova) return;
    const f = dlgNova.querySelector("form");
    f.reset();
    // O recorte atual volta junto do redirect (o servidor só aceita as
    // chaves de filtro — ver `_estado_do_quadro`).
    f.elements.voltar.value = location.search;
    const chk = $("#nova-chk");
    if (chk) chk.innerHTML = '<input type="text" name="checklist" maxlength="200" placeholder="Primeiro item (Enter adiciona outro)">';
    // Nasce com o que o quadro já diz: a raia em que se clicou ou o filtro
    // que está ligado. Quem filtrou "Ana" e clicou em adicionar quer a Ana.
    pre = pre || {};
    f.elements.responsavel_id.value = pre.responsavel || estado.responsavel || "";
    f.elements.area_id.value = pre.area || estado.area || "";
    if (pre.prioridade || estado.prioridade) f.elements.prioridade.value = pre.prioridade || estado.prioridade;
    resumoApoio();
    dlgNova.showModal();
    f.elements.titulo.focus();
  }
  function resumoApoio() {
    const dd = $("#dd-apoio-nova");
    if (!dd) return;
    const n = dd.querySelectorAll("input:checked").length;
    dd.querySelector("[data-resumo]").textContent = n ? n + (n === 1 ? " pessoa" : " pessoas") : "Ninguém";
  }
  if (dlgNova) {
    $("#btn-nova").addEventListener("click", () => abrirNova());
    dlgNova.addEventListener("click", (e) => {
      if (e.target === dlgNova || e.target.closest("[data-fechar-nova]")) dlgNova.close();
      const dd = $("#dd-apoio-nova");
      if (dd && dd.open && !dd.contains(e.target)) dd.open = false;
    });
    dlgNova.addEventListener("change", (e) => { if (e.target.closest("#dd-apoio-nova")) resumoApoio(); });
    dlgNova.addEventListener("keydown", (e) => {
      const t = e.target;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); dlgNova.querySelector("form").requestSubmit(); return; }
      // Enter num item do checklist cria o próximo, em vez de enviar o
      // formulário pela metade.
      if (e.key === "Enter" && t.name === "checklist") {
        e.preventDefault();
        if (!t.value.trim()) return;
        const prox = t.nextElementSibling;
        if (prox) { prox.focus(); return; }
        const novo = document.createElement("input");
        novo.type = "text"; novo.name = "checklist"; novo.maxLength = 200; novo.placeholder = "Outro item";
        t.after(novo);
        novo.focus();
      }
      if (e.key === "Backspace" && t.name === "checklist" && !t.value && t.previousElementSibling) {
        e.preventDefault();
        const ant = t.previousElementSibling;
        t.remove();
        ant.focus();
      }
    });
    dlgNova.querySelector("form").addEventListener("submit", (e) => {
      const b = e.target.querySelector("button[type=submit]");
      b.disabled = true;
      b.textContent = "Criando…";
    });
  }

  // ----------------------------------------------------------------- início
  lerURL();
  montarEtiquetas();
  desenhar();
})();
