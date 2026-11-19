-- =====================================================================
-- War Room: validação das OS encerradas sem sucesso. Rode no Supabase:
-- SQL Editor -> Run. Aditiva e reaplicável: só cria.
-- =====================================================================
--
-- Regra nº 1 do plano de ação de 19/11/2026: nenhuma OS é encerrada sem
-- sucesso sem que o supervisor saiba. Na lista "Encerradas sem sucesso no
-- dia" da War Room, o supervisor responde, OS a OS, se a recusa foi validada
-- com ele (sim) ou não (não). Sem linha = ainda sem resposta.
--
-- Uma linha por (dia, OS): a última resposta vale, com quem e quando. A OS
-- pode ser encerrada sem sucesso, reaberta e encerrada de novo noutro dia —
-- são duas recusas, duas validações. Desmarcar apaga a linha: é a caixa de
-- resposta, não um registro de fato (o fato vai para `warroom_desvios`).

create table if not exists public.warroom_validacoes (
  dia         date        not null,
  os          text        not null,
  validado    boolean     not null,
  usuario_id  uuid        not null references public.usuarios(id) on delete restrict,
  em          timestamptz not null default now(),
  primary key (dia, os),
  constraint warroom_validacoes_os_ck check (os ~ '^[0-9]{1,9}$')
);

alter table public.warroom_validacoes enable row level security;
revoke all on public.warroom_validacoes from anon, authenticated;
grant select, insert, update, delete on public.warroom_validacoes to service_role;
