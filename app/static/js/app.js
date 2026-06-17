// Shell: alterna a sidebar (recolher no desktop, abrir/fechar no mobile).
(function () {
  const btn = document.getElementById("toggle-menu");
  if (!btn) return;
  const ehMobile = () => window.matchMedia("(max-width:820px)").matches;
  btn.addEventListener("click", () => {
    document.body.classList.toggle(ehMobile() ? "menu-open" : "collapsed");
  });
  // fecha o menu ao clicar fora (mobile)
  document.addEventListener("click", (e) => {
    if (!ehMobile()) return;
    const dentro = e.target.closest("#sidebar") || e.target.closest("#toggle-menu");
    if (!dentro) document.body.classList.remove("menu-open");
  });
})();
