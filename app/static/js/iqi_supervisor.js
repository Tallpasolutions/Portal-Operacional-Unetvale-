// Filtro por supervisor, compartilhado pelas visões do IQI/IQM.
//
// O vínculo supervisor -> equipes vem de Configurações. Aqui ele vira um
// recorte: escolher um supervisor restringe o indicador aos técnicos das
// equipes dele.
//
// Fica num arquivo próprio porque as três visões (Gráfico, Tabela mensal e
// Ofensores) são componentes independentes, cada uma com seu seletor de mês.
// Duplicar a mesma lógica em três lugares faria elas divergirem na primeira
// mudança — aqui a regra de "quem pertence a este supervisor" existe uma vez só.
(function () {
  const SUPERVISORES = window.__SUPERVISORES__ || [];

  /** Empresa a partir do rótulo "EMPRESA - Nome" do WVSA. */
  function empresaDe(nome) {
    return nome && nome.includes(" - ") ? nome.split(" - ")[0].trim() : "";
  }

  /**
   * Preenche um `<select>` de supervisor.
   *
   * Sem supervisor cadastrado o select aparece desabilitado dizendo o porquê,
   * em vez de ficar vazio e sem explicação — o caminho para resolver é
   * cadastrar em Configurações, e a tela deve dizer isso.
   */
  function popular(id, aoMudar) {
    const sel = document.getElementById(id);
    if (!sel) return;

    if (!SUPERVISORES.length) {
      sel.innerHTML = '<option value="">nenhum cadastrado</option>';
      sel.disabled = true;
      sel.title = "Cadastre supervisores e vincule equipes em Configurações.";
      return;
    }

    sel.innerHTML =
      '<option value="">Todos</option>' +
      SUPERVISORES.map((s) =>
        `<option value="${s.id}" title="${s.equipes.join(", ")}">${s.nome}</option>`).join("");
    sel.addEventListener("change", () => aoMudar(equipesDe(sel.value)));
  }

  /** Equipes do supervisor escolhido, ou `null` para "todos". */
  function equipesDe(id) {
    if (!id) return null;
    const s = SUPERVISORES.find((x) => x.id === id);
    return s && s.equipes.length ? new Set(s.equipes) : new Set();
  }

  /**
   * Aplica o recorte a uma lista de técnicos.
   *
   * `equipes = null` significa "sem filtro". Um Set VAZIO é diferente: é
   * supervisor sem equipe vinculada, e aí o resultado correto é nenhum
   * técnico — não "todos". Tratar os dois casos igual mostraria o indicador
   * inteiro como se fosse a equipe daquela pessoa.
   */
  function filtrar(tecnicos, equipes) {
    if (!equipes) return tecnicos;
    return tecnicos.filter((t) => equipes.has(empresaDe(t.nome || t)));
  }

  window.__iqiSupervisor = { popular, equipesDe, filtrar, empresaDe, lista: SUPERVISORES };
})();
