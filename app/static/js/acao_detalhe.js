// Detalhe da ação — o formulário de atualização.
(function () {
  const rng = document.getElementById("rng-progresso");
  const lbl = document.getElementById("lbl-progresso");
  if (rng && lbl) {
    rng.addEventListener("input", () => { lbl.textContent = rng.value + "%"; });
  }

  // "Concluída precisa de data e evidência verificável" é regra da planilha, e
  // o banco também recusa. Aqui os campos APARECEM ao escolher Concluída, em
  // vez de o envio falhar depois: a pessoa descobre o que falta antes de
  // escrever o resto.
  const sel = document.getElementById("sel-status");
  const bloco = document.getElementById("campos-conclusao");
  const data = document.getElementById("in-data-conclusao");
  const evid = document.getElementById("in-evidencia");
  if (sel && bloco) {
    const sincronizar = () => {
      const concluindo = sel.value === "Concluída";
      bloco.hidden = !concluindo;
      if (data) {
        data.required = concluindo;
        if (concluindo && !data.value) data.value = new Date().toISOString().slice(0, 10);
      }
      if (evid) evid.required = concluindo;
      // Concluir com a barra em 40% é engano de digitação, não intenção.
      if (concluindo && rng) { rng.value = 100; if (lbl) lbl.textContent = "100%"; }
    };
    sel.addEventListener("change", sincronizar);
    sincronizar();
  }

  // Blocos do gestor recolhidos: o botão do cabeçalho abre o formulário.
  // O motivo está no template — a tela é para LER a ação, e dois formulários
  // abertos por padrão empurravam a linha do tempo para fora da primeira
  // dobra. O estado NÃO é persistido de propósito: depois de comentar a
  // página recarrega e a caixa volta a fechar, que é o estado de leitura.
  document.querySelectorAll("[data-abrir]").forEach(function (btn) {
    var alvo = document.getElementById(btn.dataset.abrir);
    if (!alvo) return;
    var rotulo = btn.textContent;
    btn.addEventListener("click", function () {
      var abrindo = alvo.hidden;
      alvo.hidden = !abrindo;
      // Sem isso sobra a borda de baixo do cabeçalho separando o nada.
      btn.closest(".card").classList.toggle("recolhido", !abrindo);
      btn.textContent = abrindo ? "Fechar" : rotulo;
      // Abrir e ainda ter de procurar onde escrever é um passo a mais; e o
      // foco leva o bloco para a tela, que no caso da Definição fica no pé
      // da página.
      if (abrindo) {
        var campo = alvo.querySelector("textarea, input:not([type=hidden]), select");
        if (campo) campo.focus();
      }
    });
  });

  // `confirm()` abre a caixa do sistema, com o domínio no topo — CLAUDE.md §5.
  var dlg = document.getElementById("dlg-excluir");
  var abrirEx = document.getElementById("abrir-excluir");
  if (dlg && abrirEx) {
    abrirEx.addEventListener("click", function () { dlg.showModal(); });
    dlg.addEventListener("click", function (e) {
      // Clique fora do conteúdo (na área escurecida) fecha.
      if (e.target === dlg || (e.target.dataset && e.target.dataset.fechar !== undefined)) dlg.close();
    });
    document.getElementById("confirmar-excluir").addEventListener("click", function () {
      dlg.close();
      document.getElementById("form-excluir").submit();
    });
  }
})();
