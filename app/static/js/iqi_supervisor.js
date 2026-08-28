// Filtro por supervisor, compartilhado pelas visões do IQI/IQM.
//
// O alcance de um supervisor vem de Configurações e tem DUAS formas, que se
// somam: equipes inteiras e técnicos avulsos. A segunda existe porque a
// empresa nem sempre é a unidade de supervisão — os 26 técnicos da UNETVALE
// se dividem entre supervisores, e INFRA WAVE responde a dois ao mesmo tempo.
//
// Fica num arquivo próprio porque as três visões (Gráfico, Tabela mensal e
// Ofensores) são componentes independentes, cada uma com seu seletor de mês.
// Duplicar a mesma lógica em três lugares faria elas divergirem na primeira
// mudança — aqui a regra de "quem pertence a este supervisor" existe uma vez só.
(function () {
  const SUPERVISORES = window.__SUPERVISORES__ || [];
  const APELIDOS = window.__APELIDOS_EMPRESA__ || {};

  /** Empresa a partir do rótulo "EMPRESA - Nome", com o apelido resolvido. */
  function empresaDe(nome) {
    const i = (nome || "").indexOf(" - ");
    if (i < 0) return "";
    const e = nome.slice(0, i).trim().toUpperCase();
    return APELIDOS[e] || e;
  }

  /**
   * Mesma chave que o Python gravou em `supervisor_tecnicos`: maiúsculas, sem
   * acento, espaços colapsados. Precisa bater caractere a caractere — o WVSA
   * entrega "INFRA UNET -  Mauricio Capitanio" com espaço duplo num painel e
   * simples no outro, e comparar o texto cru perderia o vínculo em silêncio.
   */
  function chaveTecnico(nome) {
    if (!nome) return "";
    const i = nome.indexOf(" - ");
    const rotulo = i >= 0 ? `${empresaDe(nome)} - ${nome.slice(i + 3)}` : nome;
    return rotulo
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
  }

  /**
   * Preenche um `<select>` de supervisor.
   *
   * Sem supervisor cadastrado o select aparece desabilitado dizendo o porquê,
   * em vez de ficar vazio e sem explicação — o caminho para resolver é
   * cadastrar em Configurações, e a tela deve dizer isso.
   */
  function popular(id, aoMudar, fonte) {
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
        `<option value="${s.id}" title="${resumo(s)}">${s.nome}</option>`).join("");
    // Nota logo abaixo do select, para o caso de o recorte não sobrar nada.
    const nota = document.createElement("div");
    nota.className = "subnote";
    nota.style.cssText = "flex-basis:100%;margin:2px 0 0";
    sel.insertAdjacentElement("afterend", nota);

    sel.addEventListener("change", () => {
      const alcance = alcanceDe(sel.value);
      aoMudar(alcance);
      nota.textContent = fonte ? (aviso(alcance, fonte()) || "") : "";
    });
  }

  /**
   * Por que o recorte ficou vazio — ou `null` se não ficou.
   *
   * Um gráfico em branco sem explicação faz parecer defeito. E aqui não é:
   * as equipes de infraestrutura são excluídas do IQI/IQM de propósito (só o
   * time operacional entra), então o supervisor de INFRA legitimamente não
   * tem número neste indicador. A tela precisa dizer isso em vez de calar.
   */
  function aviso(alcance, tecnicos) {
    if (!alcance) return null;
    if (filtrar(tecnicos, alcance).length) return null;
    if (!alcance.equipes.size && !alcance.tecnicos.size) {
      return "Este supervisor ainda não tem equipe nem técnico vinculado — vincule em Configurações.";
    }
    return "Nenhum técnico deste supervisor entra no IQI/IQM. Equipes de infraestrutura ficam "
         + "fora deste indicador, que mede só o time operacional; use Produtividade para elas.";
  }

  /** Texto do `title`: o que este supervisor enxerga. */
  function resumo(s) {
    const partes = [];
    if (s.equipes && s.equipes.length) partes.push(s.equipes.join(", "));
    if (s.tecnicos && s.tecnicos.length) partes.push(`${s.tecnicos.length} técnico(s) avulso(s)`);
    return partes.join(" + ") || "sem vínculo";
  }

  /** Alcance do supervisor escolhido, ou `null` para "todos". */
  function alcanceDe(id) {
    if (!id) return null;
    const s = SUPERVISORES.find((x) => x.id === id);
    if (!s) return null;
    return {
      equipes: new Set(s.equipes || []),
      tecnicos: new Set(s.tecnicos || []),
    };
  }

  /**
   * Aplica o recorte a uma lista de técnicos.
   *
   * `alcance = null` significa "sem filtro". Um alcance VAZIO é diferente: é
   * supervisor sem nada vinculado, e aí o resultado correto é nenhum técnico —
   * não "todos". Tratar os dois casos igual mostraria o indicador inteiro como
   * se fosse a equipe daquela pessoa.
   *
   * Equipe e técnico avulso se SOMAM: quem supervisiona a WAVE inteira e mais
   * dois nomes da UNETVALE vê os três grupos juntos.
   */
  function filtrar(tecnicos, alcance) {
    if (!alcance) return tecnicos;
    return tecnicos.filter((t) => {
      const nome = t.nome || t;
      return alcance.equipes.has(empresaDe(nome)) || alcance.tecnicos.has(chaveTecnico(nome));
    });
  }

  window.__iqiSupervisor = {
    popular, alcanceDe, filtrar, aviso, empresaDe, chaveTecnico, lista: SUPERVISORES,
  };
})();
