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

  async function acompanhar() {
    const inicio = Date.now();
    timer = setInterval(async () => {
      let s;
      try { s = await (await fetch("/api/atualizar/status")).json(); } catch (e) { return; }
      if (!s.rodando) { clearInterval(timer); timer = null; location.reload(); return; }
      if (Date.now() - inicio > 5 * 60 * 1000) {
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
