-- =====================================================================
-- Histórico de execuções do coletor (monitoramento de falhas).
-- Rode no Supabase: SQL Editor -> cole -> Run.
-- =====================================================================
create table if not exists public.coletor_log (
  id            uuid primary key default gen_random_uuid(),
  executado_em  timestamptz not null default now(),
  modulo        text,                 -- produtividade | iqi | massivas | geral
  status        text not null,        -- ok | erro | skip
  mensagem      text
);

create index if not exists coletor_log_ts_idx on public.coletor_log (executado_em desc);

-- Acesso só pelo backend/coletor (service_role ignora RLS). Nada exposto ao browser.
alter table public.coletor_log enable row level security;
