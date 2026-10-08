// Instrução de trabalho: o editor do rascunho e o anexo do fluxo.
//
// Página única com as seções em ordem de leitura — a mesma ordem do PDF. O
// texto é editado no lugar e salva sozinho 1,2 s depois de parar de digitar,
// como a ata das reuniões. Campos de texto NÃO redesenham a seção ao digitar
// (roubaria o foco); só mudança de estrutura (passo novo, apagar, subir)
// redesenha.
//
// Os passos podem vir do fluxo: o gerador é um só (fluxo_gerar_it.js), e a
// prévia mostra o que entra, o que muda e o que sairia — passo escrito à mão
// nunca some em silêncio.
(function () {
  "use strict";
  const D = window.__IT__;
  if (!D) return;
  const R = window.FluxoRender, IT = window.FluxoIT;
  const esc = R.esc;

  // ---- anexo do fluxo (leitura e editor) ------------------------------------
  function desenharFluxo(el) {
    if (!el || !D.fluxo || !D.fluxo.documento) return;
    el.innerHTML = R.paraSVG(D.fluxo.documento, { margem: 16 });
    const s = el.querySelector("svg");
    if (s) { s.removeAttribute("width"); s.removeAttribute("height"); s.style.width = "100%"; s.style.height = "auto"; }
  }
  document.querySelectorAll("[data-fluxo]").forEach(desenharFluxo);

  const raiz = document.getElementById("it-editor");
  if (!raiz || !D.editavel) return;

  const LS = `it:backup:${D.codigo}:${D.rev}`;
  let c = normalizar(D.conteudo);
  let versao = D.versao;
  const estadoEl = document.getElementById("it-estado");
  const faixa = document.querySelector(".it-faixa");

  function normalizar(x) {
    x = JSON.parse(JSON.stringify(x || {}));
    ["objetivo", "aplicacao", "criterios", "registros"].forEach((k) => { if (typeof x[k] !== "string") x[k] = ""; });
    ["responsabilidades", "definicoes", "epis", "materiais", "referencias", "seguranca", "passos"].forEach((k) => {
      if (!Array.isArray(x[k])) x[k] = [];
    });
    return x;
  }

  // ===========================================================================
  // Desenho das seções
  // ===========================================================================
  const AUTO = (txt, campo, ph, rows) =>
    `<textarea class="editavel it-auto" data-campo="${campo}" rows="${rows || 2}" placeholder="${esc(ph)}">${esc(txt || "")}</textarea>`;

  function secao(id, titulo, dica, corpo, extra) {
    return `<section class="card it-card" data-secao="${id}"><div class="card-h"><span>${titulo}` +
      (dica ? ` <span class="rotulo-leve">${dica}</span>` : "") + `</span>${extra || ""}</div><div class="card-b">${corpo}</div></section>`;
  }

  function linhasPar(lista, chave, a, b, phA, phB) {
    return `<div class="it-pares" data-lista="${chave}">` + lista.map((r, i) =>
      `<div class="it-par" data-i="${i}"><input type="text" data-campo="${chave}.${i}.${a}" value="${esc(r[a] || "")}" placeholder="${esc(phA)}" maxlength="${a === "papel" ? 120 : 80}">` +
      `<textarea class="editavel it-auto" rows="1" data-campo="${chave}.${i}.${b}" placeholder="${esc(phB)}">${esc(r[b] || "")}</textarea>` +
      `<button type="button" class="icone-btn" data-remover="${chave}.${i}" title="Remover" aria-label="Remover">×</button></div>`).join("") +
      `</div><button type="button" class="btn-ghost" data-adicionar="${chave}">+ Linha</button>`;
  }

  function marcas(chave, ph) {
    return `<div class="it-marcas-ed" data-lista="${chave}">` + c[chave].map((x, i) =>
      `<span class="etiqueta">${esc(x)}<button type="button" data-remover="${chave}.${i}" aria-label="Remover ${esc(x)}">×</button></span>`).join("") +
      `<input type="text" class="it-marca-nova" data-nova="${chave}" list="sug-${chave}" placeholder="${esc(ph)}" maxlength="200"></div>` +
      `<datalist id="sug-${chave}">${(D.sugestoes[chave] || []).filter((s) => !c[chave].includes(s)).map((s) => `<option value="${esc(s)}">`).join("")}</datalist>`;
  }

  function passosHTML() {
    if (!c.passos.length) {
      return `<p class="acao-p-vazio">Nenhum passo ainda.${D.fluxo ? " Gere a partir do fluxo ou escreva o primeiro." : ""}</p>`;
    }
    return `<div class="it-passos-ed">` + c.passos.map((p, i) =>
      `<div class="it-passo${p.tipo === "decisao" ? " it-decisao" : ""}" data-i="${i}">` +
      `<div class="it-passo-n">${i + 1}</div>` +
      `<div class="it-passo-corpo">` +
        `<div class="it-passo-topo"><input type="text" class="it-quem" data-campo="passos.${i}.quem" value="${esc(p.quem || "")}" list="it-raias" placeholder="Quem" maxlength="120">` +
        (p.no_id ? `<span class="badge badge-azul" title="Veio do fluxo; regerar atualiza a atividade se ninguém a editou">do fluxo</span>` : `<span class="badge badge-cinza">à mão</span>`) +
        `<span class="it-passo-ferr"><button type="button" class="icone-btn" data-mover="${i}:-1" title="Subir" aria-label="Subir"${i === 0 ? " disabled" : ""}>↑</button>` +
        `<button type="button" class="icone-btn" data-mover="${i}:1" title="Descer" aria-label="Descer"${i === c.passos.length - 1 ? " disabled" : ""}>↓</button>` +
        `<button type="button" class="icone-btn" data-remover="passos.${i}" title="Apagar passo" aria-label="Apagar passo">×</button></span></div>` +
        `<textarea class="editavel it-auto it-ativ-ed" rows="1" data-campo="passos.${i}.atividade" placeholder="O que fazer — verbo no infinitivo">${esc(p.atividade || "")}</textarea>` +
        (p.desvio_texto ? `<div class="it-desvio">${esc(p.desvio_texto)}</div>` : "") +
        `<label class="it-rot">Como fazer</label>` +
        `<textarea class="editavel it-auto" rows="1" data-campo="passos.${i}.detalhe" placeholder="O detalhe que o técnico precisa para não errar">${esc(p.detalhe || "")}</textarea>` +
        `<label class="it-rot">Atenção</label>` +
        `<textarea class="editavel it-auto it-aten-ed" rows="1" data-campo="passos.${i}.atencao" placeholder="Risco, cuidado, o que não fazer">${esc(p.atencao || "")}</textarea>` +
      `</div></div>`).join("") + `</div>`;
  }

  function desenhar() {
    const foco = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.campo;
    IT.textoDesvios(c.passos);
    raiz.innerHTML =
      secao("objetivo", "Objetivo", "para que esta instrução existe", AUTO(c.objetivo, "objetivo", "Padronizar a transferência da rede óptica do poste antigo para o novo…", 2)) +
      secao("aplicacao", "Aplicação", "onde e quando vale", AUTO(c.aplicacao, "aplicacao", "Toda troca de poste avisada pela Celesc nas 11 cidades atendidas…", 2)) +
      secao("responsabilidades", "Responsabilidades", "quem responde por quê",
        linhasPar(c.responsabilidades, "responsabilidades", "papel", "descricao", "Técnico de campo", "Executar a transferência e registrar as fotos na OS")) +
      secao("definicoes", "Definições e siglas", "opcional",
        linhasPar(c.definicoes, "definicoes", "termo", "significado", "CTO", "Caixa de terminação óptica")) +
      secao("epis", "EPIs, materiais e ferramentas", "Enter adiciona",
        `<h4 class="it-sub">EPIs</h4>${marcas("epis", "Capacete, cinto paraquedista…")}` +
        `<h4 class="it-sub">Materiais e ferramentas</h4>${marcas("materiais", "Escada, máquina de fusão…")}`) +
      secao("seguranca", "Segurança", "alertas em destaque no PDF",
        `<div class="it-alertas-ed">` + c.seguranca.map((a, i) =>
          `<div class="it-alerta-ed it-${a.nivel}"><select data-campo="seguranca.${i}.nivel" aria-label="Nível">` +
          `<option value="atencao"${a.nivel === "atencao" ? " selected" : ""}>Atenção</option><option value="perigo"${a.nivel === "perigo" ? " selected" : ""}>Perigo</option></select>` +
          `<textarea class="editavel it-auto" rows="1" data-campo="seguranca.${i}.texto">${esc(a.texto || "")}</textarea>` +
          `<button type="button" class="icone-btn" data-remover="seguranca.${i}" aria-label="Remover">×</button></div>`).join("") + `</div>` +
        `<div class="it-prontos">` + (D.alertas || []).filter((a) => !c.seguranca.some((x) => x.texto === a.texto)).map((a, i) =>
          `<button type="button" class="fchip" data-alerta="${i}">+ ${esc(a.texto.split(":")[0].split("—")[0].trim())}</button>`).join("") +
        `<button type="button" class="fchip" data-adicionar="seguranca">+ Alerta em branco</button></div>`) +
      secao("passos", "Passo a passo", c.passos.length ? `${c.passos.length} passos` : "",
        passosHTML() + `<button type="button" class="btn-ghost" data-adicionar="passos" style="margin-top:10px;">+ Passo</button>`,
        D.fluxo ? `<button type="button" class="btn-ghost" data-gerar>Gerar do fluxo</button>` : "") +
      secao("criterios", "Critérios de aceitação", "como saber que ficou certo", AUTO(c.criterios, "criterios", "Sinal da rede conferido no poste novo; nenhum cliente sem serviço…", 2)) +
      secao("registros", "Registros", "o que fica guardado, e onde", AUTO(c.registros, "registros", "Fotos antes e depois anexadas à OS no WVSA.", 2)) +
      secao("referencias", "Referências", "NRs, normas, outras ITs", marcas("referencias", "NR-35, IT-INF-002…")) +
      (D.fluxo ? secao("anexo", `Anexo A — Fluxograma: ${esc(D.fluxo.titulo || "")}`, D.fluxo.congelado ? "congelado" : "como está hoje; congela na aprovação",
        `<div class="it-fluxo" data-fluxo-ed></div>`) : "") +
      `<datalist id="it-raias">${(D.raias || []).map((t) => `<option value="${esc(t)}">`).join("")}</datalist>`;
    desenharFluxo(raiz.querySelector("[data-fluxo-ed]"));
    raiz.querySelectorAll(".it-auto").forEach(crescer);
    if (foco) { const el = raiz.querySelector(`[data-campo="${foco}"]`); if (el) el.focus(); }
  }

  function crescer(t) { t.style.height = "auto"; t.style.height = (t.scrollHeight + 2) + "px"; }

  // ===========================================================================
  // Edição
  // ===========================================================================
  function definir(caminho, valor) {
    const partes = caminho.split(".");
    let o = c;
    for (let i = 0; i < partes.length - 1; i++) o = o[partes[i]];
    o[partes[partes.length - 1]] = valor;
  }

  raiz.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.classList.contains("it-auto")) crescer(t);
    if (!t.dataset.campo) return;
    definir(t.dataset.campo, t.value);
    agendar();
  });
  raiz.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.tagName === "SELECT" && t.dataset.campo) { definir(t.dataset.campo, t.value); agendar(); desenhar(); }
  });
  raiz.addEventListener("keydown", (ev) => {
    const t = ev.target;
    if (t.dataset.nova && ev.key === "Enter") {
      ev.preventDefault();
      adicionarMarca(t);
    }
  });
  // Escolher da lista de sugestões não dispara Enter: adiciona ao sair.
  raiz.addEventListener("focusout", (ev) => { if (ev.target.dataset && ev.target.dataset.nova) adicionarMarca(ev.target); });

  function adicionarMarca(t) {
    const v = t.value.trim();
    if (!v) return;
    const lista = c[t.dataset.nova];
    if (!lista.some((x) => x.toLowerCase() === v.toLowerCase())) lista.push(v.slice(0, 200));
    t.value = "";
    agendar();
    desenhar();
    const novo = raiz.querySelector(`[data-nova="${t.dataset.nova}"]`);
    if (novo) novo.focus();
  }

  raiz.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.remover) {
      const [lista, i] = b.dataset.remover.split(".");
      c[lista].splice(Number(i), 1);
    } else if (b.dataset.adicionar) {
      const k = b.dataset.adicionar;
      if (k === "responsabilidades") c.responsabilidades.push({ papel: "", descricao: "" });
      if (k === "definicoes") c.definicoes.push({ termo: "", significado: "" });
      if (k === "seguranca") c.seguranca.push({ nivel: "atencao", texto: "" });
      if (k === "passos") c.passos.push({ id: "m" + Date.now().toString(36), no_id: null, tipo: "acao", quem: "", atividade: "", detalhe: "", atencao: "", desvios: [] });
    } else if (b.dataset.alerta != null) {
      const prontos = (D.alertas || []).filter((a) => !c.seguranca.some((x) => x.texto === a.texto));
      c.seguranca.push(Object.assign({}, prontos[Number(b.dataset.alerta)]));
    } else if (b.dataset.mover) {
      const [i, d] = b.dataset.mover.split(":").map(Number);
      const j = i + d;
      if (j < 0 || j >= c.passos.length) return;
      [c.passos[i], c.passos[j]] = [c.passos[j], c.passos[i]];
    } else if (b.dataset.gerar != null) {
      abrirGerar();
      return;
    } else return;
    agendar();
    desenhar();
    // Passo novo: o cursor já vai para a atividade dele.
    if (b.dataset.adicionar === "passos") {
      const el = raiz.querySelector(`[data-campo="passos.${c.passos.length - 1}.atividade"]`);
      if (el) el.focus();
    }
  });

  // ===========================================================================
  // Gerar do fluxo, com prévia
  // ===========================================================================
  let previa = null;
  const dlg = document.getElementById("dlg-gerar");
  const btnTopo = document.getElementById("it-gerar");
  if (btnTopo) btnTopo.addEventListener("click", abrirGerar);

  function abrirGerar() {
    if (!D.fluxo || !dlg) return;
    const g = IT.gerar(D.fluxo.documento);
    const m = IT.mesclar(c.passos, g.passos);
    previa = m;
    const item = (p) => `<li>${esc(p.atividade || "(sem texto)")}${p.quem ? ` <span class="rotulo-leve">${esc(p.quem)}</span>` : ""}</li>`;
    let h = "";
    if (g.avisos.length) h += `<div class="alert alert-erro" style="margin-top:10px">${g.avisos.map(esc).join("<br>")}</div>`;
    if (!g.passos.length) h += `<p>O fluxo não tem nenhuma forma de ação ligada ao Início. Desenhe o caminho e tente de novo.</p>`;
    else {
      h += `<p>${g.passos.length} passos no fluxo: <b>${m.novos.length}</b> novos, <b>${m.alterados.length}</b> atualizados, ${m.iguais} iguais.` +
           ` Detalhe e atenção escritos à mão ficam.</p>`;
      if (m.novos.length) h += `<h4 class="it-sub">Entram</h4><ul class="it-ul">${m.novos.map(item).join("")}</ul>`;
      if (m.alterados.length) h += `<h4 class="it-sub">Mudam conforme o fluxo</h4><ul class="it-ul">${m.alterados.map(item).join("")}</ul>`;
      if (m.conflitos.length) h += `<h4 class="it-sub">Editados à mão — ficam como estão</h4><ul class="it-ul">` +
        m.conflitos.map((x) => `<li>${esc(x.passo.atividade)} <span class="rotulo-leve">o fluxo agora diz: ${esc(x.fluxoDiz)}</span></li>`).join("") + `</ul>`;
      if (m.removidos.length) h += `<h4 class="it-sub">Saíram do fluxo</h4><p class="subnote" style="margin:0 0 6px">Marque os que devem ficar na instrução como passo escrito à mão.</p>` +
        `<div class="lista-marcar">` + m.removidos.map((p, i) =>
          `<label class="linha-marcar"><input type="checkbox" data-manter="${i}"> ${esc(p.atividade)}</label>`).join("") + `</div>`;
    }
    document.getElementById("it-previa").innerHTML = h;
    document.getElementById("it-aplicar").disabled = !g.passos.length;
    dlg.showModal();
  }

  const btnAplicar = document.getElementById("it-aplicar");
  if (btnAplicar) btnAplicar.addEventListener("click", () => {
    if (!previa) return;
    const manter = [...document.querySelectorAll("#it-previa [data-manter]:checked")].map((x) => previa.removidos[Number(x.dataset.manter)]);
    c.passos = previa.passos.concat(manter.map((p) => Object.assign({}, p, { no_id: null, desvios: [], gerado: null })));
    // Responsabilidades em branco ganham as raias do fluxo: são os papéis.
    if (!c.responsabilidades.length && D.raias && D.raias.length) {
      c.responsabilidades = D.raias.map((t) => ({ papel: t, descricao: "" }));
    }
    dlg.close();
    agendar();
    desenhar();
  });

  // ===========================================================================
  // Salvamento (o mesmo desenho do fluxo: versão lida, conflito não sobrescreve)
  // ===========================================================================
  let sujo = false, salvando = false, timer = null, conflito = false, tentativa = 0, salvoEm = Date.now();
  function estado(txt, cls) { if (estadoEl) { estadoEl.textContent = txt; estadoEl.className = "fluxo-estado" + (cls ? " " + cls : ""); } }
  function relogio() {
    if (sujo || salvando || conflito) return;
    const s = Math.round((Date.now() - salvoEm) / 1000);
    estado(s < 5 ? "Salvo agora" : s < 60 ? `Salvo há ${s} s` : `Salvo há ${Math.round(s / 60)} min`, "ok");
  }
  setInterval(relogio, 5000);

  function agendar() {
    sujo = true;
    if (!conflito) estado("Alterações não salvas", "pendente");
    try { localStorage.setItem(LS, JSON.stringify({ c, versao, quando: Date.now() })); } catch (e) { /* sem storage */ }
    clearTimeout(timer);
    timer = setTimeout(salvar, 1200);
  }

  async function salvar() {
    if (!sujo || salvando || conflito) return true;
    salvando = true;
    estado("Salvando…", "pendente");
    const enviado = JSON.stringify(c);
    try {
      const r = await fetch(D.urls.salvar, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rev: D.rev, versao, conteudo: JSON.parse(enviado) }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        versao = j.versao; salvoEm = Date.now(); tentativa = 0;
        if (JSON.stringify(c) === enviado) { sujo = false; try { localStorage.removeItem(LS); } catch (e) { /* idem */ } relogio(); }
        else { salvando = false; agendar(); return true; }
        return true;
      }
      if (r.status === 409) {
        conflito = true;
        estado("Não salvo", "erro");
        faixa.innerHTML = j.erro === "conflito"
          ? `<b>${esc(j.por_nome || "Outra pessoa")} salvou esta instrução${j.em_hora ? " às " + esc(j.em_hora) : ""} enquanto você editava.</b> Nada foi sobrescrito: o seu texto está guardado neste navegador.` +
            `<span class="fluxo-faixa-acoes"><button type="button" class="btn" data-recarregar>Recarregar e comparar</button></span>`
          : `<b>${esc(j.erro || "Esta revisão mudou de estado.")}</b><span class="fluxo-faixa-acoes"><button type="button" class="btn" data-recarregar>Recarregar</button></span>`;
        faixa.className = "fluxo-faixa it-faixa erro";
        faixa.hidden = false;
        return false;
      }
      if (r.status >= 400 && r.status < 500) { estado("Não salvo: " + (j.erro || "recusado"), "erro"); return false; }
      throw new Error("HTTP " + r.status);
    } catch (e) {
      tentativa++;
      const espera = Math.min(30000, 2000 * Math.pow(2, tentativa - 1));
      estado(`Sem conexão — tentando de novo em ${Math.round(espera / 1000)} s`, "erro");
      clearTimeout(timer); timer = setTimeout(salvar, espera);
      return false;
    } finally { salvando = false; }
  }

  if (faixa) faixa.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-recarregar]")) { sujo = false; location.reload(); }
    if (ev.target.closest("[data-recuperar]")) {
      const bk = lerBackup();
      if (bk) { c = normalizar(bk.c); faixa.hidden = true; agendar(); desenhar(); }
    }
    if (ev.target.closest("[data-descartar]")) { try { localStorage.removeItem(LS); } catch (e) { /* idem */ } faixa.hidden = true; }
  });

  function lerBackup() { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) { return null; } }
  function conferirBackup() {
    const bk = lerBackup();
    if (!bk) return;
    if (JSON.stringify(normalizar(bk.c)) === JSON.stringify(c)) { try { localStorage.removeItem(LS); } catch (e) { /* idem */ } return; }
    const quando = new Date(bk.quando).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    faixa.innerHTML = `<b>Há texto desta revisão que não chegou ao servidor</b> (${esc(quando)}).` +
      (bk.versao !== versao ? " Alguém salvou depois — recuperar troca o texto atual pelo seu." : "") +
      `<span class="fluxo-faixa-acoes"><button type="button" class="btn sec" data-descartar>Descartar</button><button type="button" class="btn" data-recuperar>Recuperar</button></span>`;
    faixa.className = "fluxo-faixa it-faixa aviso";
    faixa.hidden = false;
  }

  // Enviar para aprovação depois de salvar: o que vai para o gestor é o que
  // está no banco, e os últimos segundos de digitação não podem ficar de fora.
  document.querySelectorAll("form[data-salvar-antes]").forEach((f) => f.addEventListener("submit", async (ev) => {
    if (!sujo) return;
    ev.preventDefault();
    clearTimeout(timer);
    if (await salvar()) { sujo = false; f.submit(); }
  }));

  window.addEventListener("beforeunload", (ev) => {
    if (!sujo || conflito) return;
    try {
      fetch(D.urls.salvar, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rev: D.rev, versao, conteudo: c }) });
    } catch (e) { /* o backup local cobre */ }
    ev.preventDefault(); ev.returnValue = "";
  });

  desenhar();
  conferirBackup();
  relogio();
  if (D.gerarAoAbrir) abrirGerar();
})();
