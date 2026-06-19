-- =====================================================================
-- Controle de atualização sob demanda (botão "Atualizar" no app).
-- O app grava `pedido_em`; o watcher do coletor (dentro da VPN) detecta e roda.
-- Rode no Supabase: SQL Editor -> cole -> Run.
-- =====================================================================
create table if not exists public.controle (
  id         int primary key default 1,
  pedido_em  timestamptz,
  constraint controle_linha_unica check (id = 1)
);

insert into public.controle (id) values (1) on conflict (id) do nothing;

alter table public.controle enable row level security;
