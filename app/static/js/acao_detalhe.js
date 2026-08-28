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
})();
