// Regras do IQI/IQM que mais de uma tela usa. Hoje: quem é OFENSOR no mês.
//
// Vive aqui, e não dentro do iqi_ofensores.js, porque o filtro "Só ofensores"
// do Dashboard precisa do MESMO conjunto que o bloco Ofensores do /iqi mostra.
// Duas cópias da regra divergiriam na primeira mudança, e as duas telas
// passariam a discordar sobre quem é ofensor no mesmo mês.
(function () {
  "use strict";

  /**
   * Ofensor = técnico com % ACIMA DA MÉDIA SIMPLES do mês, entre os avaliados
   * (quem fez ao menos `minOS` OSs). A média é das porcentagens, não
   * reincidências ÷ OSs: é a régua que o bloco Ofensores sempre usou.
   *
   * `tecnicos` já vem recortado por quem chama (supervisor no /iqi; nada no
   * Dashboard) — a média é do conjunto recebido.
   */
  function ofensoresDoMes(tecnicos, mesIdx, minOS) {
    const avaliados = (tecnicos || [])
      .filter((t) => t.m && t.m[mesIdx])
      .map((t) => ({ nome: t.nome, curto: t.nome.split(" - ").pop(),
                     os: t.m[mesIdx][0], cham: t.m[mesIdx][1], pct: t.m[mesIdx][2] }))
      .filter((r) => r.os >= (minOS || 0));
    const media = avaliados.length
      ? avaliados.reduce((s, r) => s + r.pct, 0) / avaliados.length : 0;
    const ofensores = avaliados.filter((r) => r.pct > media).sort((a, b) => b.pct - a.pct);
    return { avaliados, media, ofensores };
  }

  window.IqiRegras = { ofensoresDoMes };
})();
