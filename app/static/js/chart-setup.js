// Defaults globais do Chart.js — nitidez (devicePixelRatio), tipografia e estilo
// consistentes em todos os gráficos do portal. Carregado logo após o chart.umd.
(function () {
  if (!window.Chart) return;
  const C = window.Chart;
  // render em alta resolução mesmo em monitores não-retina (gráficos "espetaculares")
  C.defaults.devicePixelRatio = Math.max(window.devicePixelRatio || 1, 2);
  C.defaults.font.family = "-apple-system, Segoe UI, Roboto, Arial, sans-serif";
  C.defaults.font.size = 12;
  C.defaults.color = "#5e6e82";
  C.defaults.borderColor = "rgba(11,23,39,.06)";
  C.defaults.maintainAspectRatio = false;

  C.defaults.plugins.legend.labels.usePointStyle = true;
  C.defaults.plugins.legend.labels.boxWidth = 8;
  C.defaults.plugins.legend.labels.padding = 14;

  const t = C.defaults.plugins.tooltip;
  t.backgroundColor = "rgba(19,36,63,.96)";
  t.padding = 10; t.cornerRadius = 8; t.boxPadding = 5;
  t.titleColor = "#fff"; t.bodyColor = "#dbe7f7"; t.usePointStyle = true;

  C.defaults.elements.bar.borderRadius = 4;
  C.defaults.elements.bar.borderSkipped = false;
  C.defaults.elements.point.radius = 2.5;
  C.defaults.elements.point.hoverRadius = 5;
  C.defaults.elements.line.borderWidth = 2.5;

  C.defaults.scale.grid.color = "rgba(11,23,39,.05)";
  C.defaults.scale.grid.drawTicks = false;
  C.defaults.scale.border.display = false;
  C.defaults.scale.ticks.padding = 8;
})();
