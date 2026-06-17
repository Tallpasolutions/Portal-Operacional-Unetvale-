-- =====================================================================
-- Dashboard Unetvale — schema inicial (Supabase / Postgres)
-- Rode no Supabase: SQL Editor -> cole este arquivo -> Run.
-- =====================================================================

-- Usuários (auth simples: login / cadastro / troca de senha).
-- Todos têm a mesma permissão (sem RBAC, sem perfis).
create table if not exists public.usuarios (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  senha_hash  text not null,
  nome        text,
  criado_em   timestamptz not null default now()
);

-- Snapshot mais recente de cada dashboard (payload pronto p/ o front).
-- modulo: 'produtividade' | 'iqi' | 'iqm' | 'massivas'
create table if not exists public.dados_modulo (
  modulo        text primary key,
  payload       jsonb not null,
  atualizado_em timestamptz not null default now(),
  status        text not null default 'ok'
);

-- RLS ligado e SEM políticas públicas: o acesso é só pelo backend (Flask na
-- Vercel) e pelo coletor, ambos usando a service_role key (que ignora RLS).
-- Assim nada fica exposto ao browser / chave anônima.
alter table public.usuarios     enable row level security;
alter table public.dados_modulo enable row level security;
