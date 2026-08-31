// Shell: alterna a sidebar (recolher no desktop, abrir/fechar no mobile).
(function () {
  const btn = document.getElementById("toggle-menu");
  if (!btn) return;
  const ehMobile = () => window.matchMedia("(max-width:820px)").matches;
  btn.addEventListener("click", () => {
    if (ehMobile()) { document.body.classList.toggle("menu-open"); return; }
    const recolhido = document.body.classList.toggle("collapsed");
    try { localStorage.setItem("sidebar", recolhido ? "collapsed" : "expanded"); } catch (e) {}
  });
  // fecha o menu ao clicar fora (mobile)
  document.addEventListener("click", (e) => {
    if (!ehMobile()) return;
    const dentro = e.target.closest("#sidebar") || e.target.closest("#toggle-menu");
    if (!dentro) document.body.classList.remove("menu-open");
  });
})();

// Botão "Atualizar agora": grava um pedido (Supabase). O coletor (dentro da VPN)
// detecta e roda; aqui acompanhamos o status e recarregamos quando concluir.
(function () {
  const btn = document.getElementById("btn-atualizar");
  if (!btn) return;
  const txt = btn.querySelector(".txt");
  const setTxt = (t) => { if (txt) txt.textContent = t; };
  let timer = null;

  function parar(msg) {
    if (timer) { clearInterval(timer); timer = null; }
    btn.classList.remove("loading");
    setTxt("Atualizar");
    if (msg) alert(msg);
  }

  // Uma rodada completa leva ~8 min (a coleta é sequencial, 9 módulos). O teto
  // anterior era de 5 min, ou seja: MENOR que o normal — toda atualização
  // manual acabava em alerta de "coletor offline" com a coleta ainda rodando.
  // 15 min dá folga sobre a rodada real sem esconder um coletor de fato morto.
  const TETO_MS = 15 * 60 * 1000;

  async function acompanhar() {
    const inicio = Date.now();
    timer = setInterval(async () => {
      let s;
      try { s = await (await fetch("/api/atualizar/status")).json(); } catch (e) { return; }
      if (!s.rodando) { clearInterval(timer); timer = null; location.reload(); return; }
      // Progresso no próprio botão: sem ele, 8 min de "Atualizando…" parado
      // parecem travamento e convidam a recarregar no meio da rodada.
      setTxt(s.total ? `Atualizando… ${s.concluidos || 0}/${s.total}` : "Atualizando…");
      if (Date.now() - inicio > TETO_MS) {
        parar("A atualização está demorando — o coletor pode estar offline (sem VPN/rede Unetvale) ou desligado.");
      }
    }, 5000);
  }

  btn.addEventListener("click", async () => {
    if (btn.classList.contains("loading")) return;
    btn.classList.add("loading");
    setTxt("Atualizando…");
    try {
      const r = await fetch("/api/atualizar", { method: "POST" });
      if (!r.ok) throw new Error();
    } catch (e) {
      parar("Não foi possível solicitar a atualização. Tente novamente.");
      return;
    }
    acompanhar();
  });

  // Se já houver uma atualização em andamento ao carregar, reflete no botão.
  fetch("/api/atualizar/status").then((r) => r.json()).then((s) => {
    if (s.rodando) { btn.classList.add("loading"); setTxt("Atualizando…"); acompanhar(); }
  }).catch(() => {});
})();
