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
