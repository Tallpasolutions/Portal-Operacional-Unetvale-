-- =====================================================================
-- Vínculo de supervisor por TÉCNICO, e não só por empresa.
-- Rode no Supabase: SQL Editor -> cole -> Run.
--
-- Por que a 0003 não bastava: ela assume que a empresa é a menor unidade de
-- supervisão. Na prática não é. A UNETVALE tem 26 técnicos repartidos entre
-- supervisores diferentes, e INFRA WAVE aparece hoje sob dois supervisores ao
-- mesmo tempo — ou seja, dentro da mesma empresa há gente de chefes distintos.
-- Vincular só por empresa obrigaria a mentir: ou o supervisor enxerga colegas
-- que não são dele, ou não enxerga os próprios.
--
-- As duas formas convivem de propósito. Empresa inteira é o caso comum e
-- continua sendo um clique; técnico avulso resolve o resto sem forçar quem
-- supervisiona uma empresa fechada a marcar nome por nome.
-- O alcance do supervisor é a UNIÃO das duas: equipes vinculadas + técnicos
-- vinculados.
-- =====================================================================

create table if not exists public.supervisor_tecnicos (
  usuario_id  uuid not null references public.usuarios(id) on delete cascade,

  -- Chave de comparação: rótulo "EMPRESA - Nome" normalizado (maiúsculas, sem
  -- acento, espaços colapsados). Guardar o normalizado é o que faz o vínculo
  -- sobreviver ao dado real — o WVSA entrega "INFRA UNET -  Mauricio Capitanio"
  -- com espaço duplo num painel e simples no outro, e sem normalizar o mesmo
  -- técnico viraria duas pessoas diferentes.
  tecnico     text not null,

  -- O rótulo como veio, só para a tela mostrar o nome com acento e grafia
  -- original. Nunca é usado para comparar.
  rotulo      text not null,

  criado_em   timestamptz not null default now(),
  primary key (usuario_id, tecnico)
);

create index if not exists supervisor_tecnicos_tecnico_idx
  on public.supervisor_tecnicos (tecnico);

-- Mesmo padrão das demais: RLS ligado e sem policy pública. O acesso é só pelo
-- Flask com a service_role, que ignora RLS. Nada exposto ao browser.
alter table public.supervisor_tecnicos enable row level security;
