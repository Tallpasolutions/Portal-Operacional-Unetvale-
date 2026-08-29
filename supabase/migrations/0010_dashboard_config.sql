-- =====================================================================
-- Preferências de exibição do Dashboard. Rode no Supabase: SQL Editor -> Run.
-- Aditiva: só cria.
-- =====================================================================

-- Chave/valor simples. Nasceu de uma necessidade concreta: o coletor guarda de
-- janeiro até o mês atual, mas a tela mostra dois meses (fechado × corrente).
-- Quem quiser olhar mais para trás muda aqui, em Configurações, sem deploy.
--
-- Separada de `dashboard_metas` porque não é meta: meta tem direção e entra na
-- comparação dos cards; isto é preferência de exibição. Misturar as duas faria
-- "quantos meses mostrar" aparecer na lista de indicadores.
create table if not exists public.dashboard_config (
  chave         text primary key,
  valor         text,
  atualizado_em timestamptz not null default now()
);

insert into public.dashboard_config (chave, valor) values
  ('meses_visiveis', '2')
on conflict (chave) do nothing;

alter table public.dashboard_config enable row level security;
