-- =====================================================================
-- Supervisores e o vínculo com as equipes.
-- Rode no Supabase: SQL Editor -> cole -> Run.
--
-- Por que duas tabelas NOVAS em vez de uma coluna em `usuarios`: a `usuarios`
-- está em produção com contas ativas, e um ALTER nela para um recurso novo é
-- risco desnecessário. Assim o recurso é aditivo e reversível — desfazer é
-- dropar estas duas tabelas, sem tocar em quem já loga.
--
-- O admin continua sendo definido pelo ADMIN_EMAIL (env), como já era. Este
-- arquivo só introduz o papel de SUPERVISOR.
-- =====================================================================

-- Quem é supervisor. A linha existir já significa "é supervisor" — não há
-- coluna de status, porque supervisor sem vínculo continua sendo supervisor
-- (só não enxerga equipe nenhuma ainda).
create table if not exists public.supervisores (
  usuario_id  uuid primary key references public.usuarios(id) on delete cascade,
  criado_em   timestamptz not null default now()
);

-- Equipes sob cada supervisor. `equipe` é o nome da empresa/equipe exatamente
-- como vem do WVSA no rótulo "EMPRESA - Nome" (ex.: WAVE, RM, UNETVALE) —
-- é a chave que o painel usa para agrupar, então é por ela que se vincula.
create table if not exists public.supervisor_equipes (
  usuario_id  uuid not null references public.usuarios(id) on delete cascade,
  equipe      text not null,
  criado_em   timestamptz not null default now(),
  primary key (usuario_id, equipe)
);

create index if not exists supervisor_equipes_equipe_idx
  on public.supervisor_equipes (equipe);

-- Mesmo padrão das demais: RLS ligado e sem policy pública. O acesso é só
-- pelo Flask com a service_role, que ignora RLS. Nada exposto ao browser.
alter table public.supervisores       enable row level security;
alter table public.supervisor_equipes enable row level security;
