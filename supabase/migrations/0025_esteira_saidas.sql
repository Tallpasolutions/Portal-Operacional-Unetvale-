-- =====================================================================
-- Esteira: POR QUE cada OS saiu da fila (triagem — 25/11/2026).
-- Aditiva e reaplicável: só cria.
-- =====================================================================
--
-- `esteira_movimentos` diz QUEM saiu e quando; não diz por quê. Sair da fila
-- é ser agendada, ser fechada ou ser DEVOLVIDA ao dono da OS ("Rejeitando OS
-- para o dono" no histórico do WVSA) antes de ir a campo. A terceira é a
-- triagem que o Renan começou em 25/11/2026 — 86 devoluções dele num dia —,
-- e é ela que derruba o backlog da War Room sem que nada na tela diga por
-- quê: "backlog −100" se lê como "o time agendou".
--
-- Uma linha por SAÍDA (os, saiu_em): a OS sai e volta (mediana de 1,8 dia
-- no histórico), e cada passagem tem o seu motivo. `saiu_em` é o `em` do
-- movimento `sai` — a hora da coleta que notou a saída.
--
-- É ESPELHO do WVSA, não dado que nasce aqui: tudo sai da ficha da OS e se
-- relê de lá. Por isso o upsert e nenhum trigger de imutabilidade. O que
-- não se reescreve é a CLASSIFICAÇÃO (motivo, destino, quem devolveu): ela
-- é decidida na primeira leitura, logo depois da saída, quando a ficha
-- ainda mostra o estado em que a OS saiu. Uma releitura dias depois veria
-- os localizadores já limpos pela resposta do consultor (a #601025 foi
-- devolvida e respondida no mesmo minuto). Só `situacao` e o que vem
-- depois da devolução são atualizados. `p_reclassificar` existe para quando
-- a regra do coletor mudar.
--
-- O vocabulário importa (CLAUDE.md §4, War Room): DEVOLVIDA é esta. "Recusa"
-- é o técnico encerrando sem sucesso; "Rejeitada" do WVSA é a validação do
-- fechamento. Três coisas, três palavras.

create table if not exists public.esteira_saidas (
  os               integer     not null references public.esteira_os (os) on delete restrict,
  saiu_em          timestamptz not null,
  dia_operacional  date        generated always as ((saiu_em at time zone 'UTC')::date) stored,
  finalidade       text,
  -- copiado do movimento: saída notada pela primeira coleta depois de mais
  -- de 12 h parada. O dia dela é incerto, e o fluxo da esteira a deixa fora
  -- da conta do dia (0020) — a triagem segue a mesma régua, senão "N das M
  -- que saíram" compararia conjuntos diferentes (75 saídas em 25/11/2026).
  apos_lacuna      boolean     not null default false,
  motivo           text        not null,
  destino          text,
  devolvida_em     timestamptz,
  devolvida_por    text,
  comentario       text,
  situacao         text,
  respondida_em    timestamptz,
  agendada_para    date,
  verificado_em    timestamptz not null default now(),
  criado_em        timestamptz not null default now(),
  primary key (os, saiu_em),
  constraint esteira_saidas_motivo_ck check (motivo in ('devolvida', 'agendada', 'fechada', 'outro')),
  constraint esteira_saidas_destino_ck check (destino is null or destino in
    ('N1', 'Comercial', 'Relacionamento', 'Suporte', 'Infra')),
  constraint esteira_saidas_situacao_ck check (situacao is null or situacao in
    ('aguardando', 'voltou_esteira', 'agendada', 'cancelada')),
  -- destino e situação só fazem sentido para a devolvida
  constraint esteira_saidas_devolvida_ck check (
    motivo = 'devolvida' or (destino is null and situacao is null and devolvida_em is null)),
  constraint esteira_saidas_comentario_ck check (comentario is null or length(comentario) <= 500)
);

create index if not exists esteira_saidas_dia_idx on public.esteira_saidas (dia_operacional);
create index if not exists esteira_saidas_aguardando_idx on public.esteira_saidas (devolvida_em)
  where motivo = 'devolvida' and situacao = 'aguardando';

-- Carimbo da última classificação: entra na `versao` da War Room, para a
-- tela se atualizar quando a rodada termina de classificar, e não só na
-- rodada seguinte (a lista é aplicada ANTES das fichas).
alter table public.esteira_coleta add column if not exists saidas_em timestamptz;

-- ---------------------------------------------------------------------
-- p_linhas = [{os, saiu_em, finalidade?, apos_lacuna?, motivo?, destino?, devolvida_em?,
--   devolvida_por?, comentario?, situacao?, respondida_em?, agendada_para?}]
--
-- Linha com `motivo` = primeira leitura (insere; numa saída já classificada
-- só reescreve a classificação com p_reclassificar). Linha sem `motivo` =
-- releitura da situação de uma devolvida já gravada.
-- ---------------------------------------------------------------------
create or replace function public.esteira_aplicar_saidas(
  p_linhas        jsonb,
  p_em            timestamptz,
  p_reclassificar boolean default false
) returns jsonb language plpgsql as $$
declare
  v_novas int;
  v_atual int;
begin
  if p_em is null then
    raise exception 'p_em é obrigatório';
  end if;
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'p_linhas precisa ser uma lista';
  end if;

  with x as (
    select (e->>'os')::int os, (e->>'saiu_em')::timestamptz saiu_em,
           nullif(e->>'finalidade', '') finalidade,
           coalesce((e->>'apos_lacuna')::boolean, false) apos_lacuna, e->>'motivo' motivo,
           nullif(e->>'destino', '') destino,
           nullif(e->>'devolvida_em', '')::timestamptz devolvida_em,
           left(nullif(e->>'devolvida_por', ''), 120) devolvida_por,
           left(nullif(e->>'comentario', ''), 500) comentario,
           nullif(e->>'situacao', '') situacao,
           nullif(e->>'respondida_em', '')::timestamptz respondida_em,
           nullif(e->>'agendada_para', '')::date agendada_para
    from jsonb_array_elements(p_linhas) e
    where e->>'os' ~ '^\d+$' and nullif(e->>'saiu_em', '') is not null
      and nullif(e->>'motivo', '') is not null
  )
  insert into public.esteira_saidas as s (os, saiu_em, finalidade, apos_lacuna, motivo, destino,
    devolvida_em, devolvida_por, comentario, situacao, respondida_em, agendada_para, verificado_em)
  select x.os, x.saiu_em, x.finalidade, x.apos_lacuna, x.motivo, x.destino, x.devolvida_em, x.devolvida_por,
         x.comentario, x.situacao, x.respondida_em, x.agendada_para, p_em
  from x
  where exists (select 1 from public.esteira_os o where o.os = x.os)
  on conflict (os, saiu_em) do update set
    finalidade    = coalesce(s.finalidade, excluded.finalidade),
    apos_lacuna   = excluded.apos_lacuna,
    motivo        = case when p_reclassificar then excluded.motivo else s.motivo end,
    destino       = case when p_reclassificar then excluded.destino else s.destino end,
    devolvida_em  = case when p_reclassificar then excluded.devolvida_em else s.devolvida_em end,
    devolvida_por = case when p_reclassificar then excluded.devolvida_por else s.devolvida_por end,
    comentario    = case when p_reclassificar then excluded.comentario else s.comentario end,
    situacao      = case when p_reclassificar or s.motivo = 'devolvida'
                         then excluded.situacao else s.situacao end,
    respondida_em = case when p_reclassificar or s.motivo = 'devolvida'
                         then excluded.respondida_em else s.respondida_em end,
    agendada_para = case when p_reclassificar or s.motivo = 'devolvida'
                         then excluded.agendada_para else s.agendada_para end,
    verificado_em = p_em;
  get diagnostics v_novas = row_count;

  update public.esteira_saidas s set
    situacao      = coalesce(nullif(e->>'situacao', ''), s.situacao),
    respondida_em = coalesce(nullif(e->>'respondida_em', '')::timestamptz, s.respondida_em),
    agendada_para = coalesce(nullif(e->>'agendada_para', '')::date, s.agendada_para),
    verificado_em = p_em
  from jsonb_array_elements(p_linhas) e
  where nullif(e->>'motivo', '') is null
    and e->>'os' ~ '^\d+$' and nullif(e->>'saiu_em', '') is not null
    and s.os = (e->>'os')::int and s.saiu_em = (e->>'saiu_em')::timestamptz
    and s.motivo = 'devolvida';
  get diagnostics v_atual = row_count;

  update public.esteira_coleta set saidas_em = p_em where id = 1;
  return jsonb_build_object('gravadas', v_novas, 'situacoes', v_atual);
end;
$$;

alter table public.esteira_saidas enable row level security;
revoke all on public.esteira_saidas from anon, authenticated;
grant select, insert, update on public.esteira_saidas to service_role;

revoke execute on function public.esteira_aplicar_saidas(jsonb, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.esteira_aplicar_saidas(jsonb, timestamptz, boolean) to service_role;
