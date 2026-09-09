-- =====================================================================
-- A ata é o relato; os itens são sugestões à parte.
-- Rode no Supabase: SQL Editor -> cole -> Run.
--
-- Até aqui decisões, encaminhamentos, pendências e riscos apareciam DUAS
-- vezes: como seção dentro do texto da ata e como sugestões no card "Itens
-- da ata". Medido em 08/09/2026 na reunião "Orçamento - Operações": a seção
-- ENCAMINHAMENTOS repetia, palavra por palavra, as 10 linhas do card logo
-- abaixo — e o PDF levava as duas.
--
-- Três colunas, cada uma resolvendo uma parte:
--
-- `itens_na_ata` — a escolha por reunião. `default false` porque a ata passa
--   a ser o relato (resumo e pontos discutidos), e quem quiser as listas de
--   volta pede pelo botão. Ata JÁ gravada não muda sozinha: `ata_markdown`
--   é texto no banco e continua como está até alguém remontar.
--
-- `ata_dados` — a estrutura que o modelo devolveu. Sem ela, alternar o botão
--   exigiria chamar a IA de novo (cota, e ata diferente da que foi conferida).
--   Com ela, `_markdown` remonta o texto na hora, e é determinístico.
--
-- `descartado_em`/`descartado_por` em reuniao_ata_itens — remover uma
--   sugestão MARCA, não apaga. Reunião é dado que nasce aqui e não tem de
--   onde recoletar (§2); e é a marca que faz a regeração não trazer de volta
--   o que alguém já recusou. `aplicado_em` continua sendo o freio: item que
--   virou comentário em `acao_eventos` (append-only) não se descarta.
--
-- Aditiva: `add column if not exists`.
-- =====================================================================
alter table public.reunioes
  add column if not exists itens_na_ata boolean not null default false,
  add column if not exists ata_dados jsonb;

alter table public.reuniao_ata_itens
  add column if not exists descartado_em timestamptz,
  add column if not exists descartado_por uuid references public.usuarios(id);

-- A tela pede sempre "os não descartados desta reunião, na ordem".
create index if not exists reuniao_ata_itens_vivos_idx
  on public.reuniao_ata_itens (reuniao_id, ordem)
  where descartado_em is null;
