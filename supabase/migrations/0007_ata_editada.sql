-- =====================================================================
-- Ata editável à mão.
-- Rode no Supabase: SQL Editor -> cole -> Run.
--
-- A ata nasce da IA e a IA erra nome próprio e sigla. Sem poder corrigir,
-- o documento que vai para a operação carrega o erro para sempre — ou
-- alguém reescreve por fora, e aí a ata do portal deixa de ser a ata.
--
-- Guardar QUEM editou e QUANDO não é burocracia: depois da edição o texto
-- não é mais o que o modelo escreveu, e quem lê precisa saber disso. O
-- rodapé "gerada por IA" some quando há edição humana.
--
-- Aditiva, como todas: `add column if not exists`.
-- =====================================================================
alter table public.reunioes
  add column if not exists ata_editada_em  timestamptz,
  add column if not exists ata_editada_por uuid references public.usuarios(id) on delete set null;
