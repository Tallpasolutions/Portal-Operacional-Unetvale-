-- =====================================================================
-- Módulo Esteira de Agendamento. Rode no Supabase: SQL Editor -> Run.
-- Aditiva e reaplicável: só cria.
-- =====================================================================
--
-- Veio do Esteira-OS do Renan (app Flask próprio + Supabase próprio +
-- Vercel própria). Aqui ele vira módulo do portal, e o dado passa a ser do
-- tipo que NASCE AQUI (§2 do CLAUDE.md): a fila em si se recoleta do WVSA,
-- mas "quem entrou e quem saiu, em que dia" é diferença entre duas coletas
-- e não existe em relatório nenhum. Por isso `esteira_movimentos` é
-- append-only.
--
-- Tudo em `public` com prefixo, e não num schema `esteira`: schema novo só
-- responde pelo PostgREST depois de ser acrescentado à mão em Settings ->
-- API -> Exposed schemas, e esquecer isso dá 406 em toda leitura. Os
-- módulos que nasceram neste repositório (acao_*, processo_*, dashboard_*)
-- moram todos em `public`; `troca_poste` tem schema porque veio do monorepo.
-- O prefixo resolve o que o schema resolveria: `ordens_servico`, `cidades`
-- e `finalidades` do módulo antigo eram nomes genéricos demais.
--
-- O DIA OPERACIONAL vai de 21h a 21h (Brasília). 21h de Brasília é 00h UTC,
-- então o dia operacional é a DATA UTC — uma coluna gerada, uma definição
-- só. Nem o coletor nem o JS recalculam: três cópias da regra seriam três
-- respostas para "entradas hoje".

-- ---------------------------------------------------------------------
-- Fila: uma linha por OS que já passou pela esteira.
--
-- A linha fica depois que a OS sai (`ativa = false`): é ela que guarda o
-- endereço e a coordenada, e uma OS que volta para a fila (5.667 vezes no
-- histórico do módulo antigo, mediana de 1,8 dia) não precisa ser buscada e
-- geocodificada de novo.
--
-- Finalidade e cidade são TEXTO, sem catálogo. O módulo antigo tinha
-- tabelas `finalidades`/`cidades` com FK, e a coluna `grupo` do catálogo
-- estava vazia nas 24 linhas: o join só custava. A tela agrupa por texto.
-- ---------------------------------------------------------------------
create table if not exists public.esteira_os (
  os                  integer     primary key,
  cliente             text,
  aberto_por          text,
  solicitacao         text,
  finalidade          text,
  cidade              text,
  bairro              text,
  tipo_pessoa         text,
  categorias          text,
  endereco            text,
  lat                 double precision,
  lng                 double precision,
  geo_precisao        text,
  entrou_fila         timestamptz,
  hrs_parada          numeric,
  tags                jsonb       not null default '[]'::jsonb,
  -- NULL = a ficha ainda não foi lida. O módulo antigo gravava
  -- 'nao_agendada' por padrão, e uma OS recém-chegada aparecia como "não
  -- agendada" antes de alguém olhar — o contrário do que se sabia dela.
  agendamento         text,
  agendado_para       date,
  visitas             integer     not null default 0,
  contatos            integer     not null default 0,
  ativa               boolean     not null default true,
  visto_em            timestamptz,
  saiu_em             timestamptz,
  status_em           timestamptz,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  constraint esteira_os_agendamento_ck check (agendamento is null or agendamento in
    ('nao_agendada', 'agendada_nao_confirmada', 'agendada_confirmada'))
);

create index if not exists esteira_os_ativa_idx on public.esteira_os (ativa) where ativa;

-- ---------------------------------------------------------------------
-- Movimentos: quem entrou e quem saiu da fila, e quando.
--
-- Substitui o `fluxo_diario` (contagens) e o `fluxo_os_dia` (listas) do
-- módulo antigo: o agregado sai daqui por consulta, e a lista de "o que
-- entrou" passa a existir para QUALQUER dia, não só para hoje.
--
-- Uma linha por (dia operacional, tipo, OS) — o mesmo unique do
-- `fluxo_os_dia`. Uma OS que entra duas vezes no mesmo dia conta UMA. É a
-- definição do histórico importado, e mantê-la é o que deixa o antes e o
-- depois da virada comparáveis. (O `fluxo_diario` antigo contava cada
-- transição e fica 3–10% acima da lista, medido em 22/10/2026.)
--
-- ⚠️ SAIR DA FILA NÃO É SER RESOLVIDA. A OS sai quando é agendada e volta
-- quando a visita falha. Nenhum texto da tela pode chamar saída de
-- "resolvida".
--
-- `apos_lacuna`: movimento da primeira coleta depois de mais de 12 h sem
-- coleta boa. A fila mudou de verdade, mas não se sabe em que dia — e foi
-- isso que fez o 20/10/2026 aparecer com 904 entradas no site antigo (o
-- coletor tinha ficado parado de 09/10 a 19/10). Fica gravado, e a tela
-- mostra à parte, nunca como "entradas de hoje".
-- ---------------------------------------------------------------------
create table if not exists public.esteira_movimentos (
  id               bigint      generated always as identity primary key,
  os               integer     not null references public.esteira_os (os) on delete restrict,
  tipo             text        not null,
  em               timestamptz not null,
  dia_operacional  date        generated always as ((em at time zone 'UTC')::date) stored,
  finalidade       text,
  cidade           text,
  origem           text        not null default 'coletor',
  apos_lacuna      boolean     not null default false,
  constraint esteira_movimentos_tipo_ck check (tipo in ('ent', 'sai')),
  constraint esteira_movimentos_origem_ck check (origem in ('coletor', 'legado')),
  constraint esteira_movimentos_uk unique (dia_operacional, tipo, os)
);

create index if not exists esteira_movimentos_os_idx on public.esteira_movimentos (os);

-- ---------------------------------------------------------------------
-- Foto do backlog por dia operacional: a ÚLTIMA coleta do dia vence.
--
-- É foto, não evento — reescrever ao longo do dia é o comportamento certo.
-- `pendente` = OS cuja ficha ainda não foi lida (agendamento NULL).
-- ---------------------------------------------------------------------
create table if not exists public.esteira_backlog_diario (
  dia             date        primary key,
  abertas         integer     not null default 0,
  agendadas_conf  integer     not null default 0,
  agendadas_nconf integer     not null default 0,
  nao_agendadas   integer     not null default 0,
  pendente        integer     not null default 0,
  abertas_fin     jsonb       not null default '{}'::jsonb,
  abertas_cid     jsonb       not null default '{}'::jsonb,
  nag_fin         jsonb       not null default '{}'::jsonb,
  nag_cid         jsonb       not null default '{}'::jsonb,
  atualizado_em   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Backlog OFICIAL mensal do WVSA (indicadores2 por grupo + agendamento1 no
-- total, `grupo = 'TOTAL'`). Espelho: recoleta-se.
-- ---------------------------------------------------------------------
create table if not exists public.esteira_backlog_oficial (
  mes            date        not null,
  grupo          text        not null,
  entradas       integer     not null default 0,
  saidas         integer     not null default 0,
  atualizado_em  timestamptz not null default now(),
  primary key (mes, grupo)
);

-- ---------------------------------------------------------------------
-- "OS fechada sem sucesso pelo técnico", uma por evento da ficha.
-- ---------------------------------------------------------------------
create table if not exists public.esteira_tentativas (
  id           bigint      generated always as identity primary key,
  os           integer     not null references public.esteira_os (os) on delete restrict,
  data_evento  timestamptz not null,
  tecnico      text,
  motivo       text,
  observacoes  text,
  texto        text,
  criado_em    timestamptz not null default now(),
  constraint esteira_tentativas_uk unique (os, data_evento)
);

-- ---------------------------------------------------------------------
-- Estado da coleta. Uma linha só, como o `coletor_heartbeat`.
--
-- `ok_em` é o carimbo da última LISTA aplicada — é contra ele que se mede a
-- lacuna e a idade do card no /monitoramento. Os carimbos são escritos pela
-- função, com o `p_em` que o coletor mandou; a hora do Mac do coletor e a
-- do banco não se misturam numa mesma comparação.
-- ---------------------------------------------------------------------
create table if not exists public.esteira_coleta (
  id             int         primary key default 1 check (id = 1),
  iniciado_em    timestamptz,
  ok_em          timestamptz,
  total          integer,
  entraram       integer,
  sairam         integer,
  status_em      timestamptz,
  backlog_em     timestamptz,
  erro_em        timestamptz,
  erro           text
);

insert into public.esteira_coleta (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Append-only em `esteira_movimentos`.
--
-- Nem a service_role faz UPDATE ou DELETE. Para limpar dado de teste:
-- `alter table ... disable trigger esteira_movimentos_imutavel`, apagar, e
-- REATIVAR (o mesmo procedimento de `acao_eventos`, §6).
-- ---------------------------------------------------------------------
create or replace function public.esteira_imutavel()
returns trigger language plpgsql as $$
begin
  raise exception '% é append-only: % não é permitido', tg_table_name, tg_op;
end;
$$;

drop trigger if exists esteira_movimentos_imutavel on public.esteira_movimentos;
create trigger esteira_movimentos_imutavel
  before update or delete on public.esteira_movimentos
  for each row execute function public.esteira_imutavel();

-- ---------------------------------------------------------------------
-- Foto do dia, recalculada a partir da fila ativa.
-- ---------------------------------------------------------------------
create or replace function public.esteira_gravar_foto(p_em timestamptz)
returns void language plpgsql as $$
declare
  v_dia date := (p_em at time zone 'UTC')::date;
begin
  insert into public.esteira_backlog_diario as b (
    dia, abertas, agendadas_conf, agendadas_nconf, nao_agendadas, pendente,
    abertas_fin, abertas_cid, nag_fin, nag_cid, atualizado_em)
  select
    v_dia,
    count(*),
    count(*) filter (where agendamento = 'agendada_confirmada'),
    count(*) filter (where agendamento = 'agendada_nao_confirmada'),
    count(*) filter (where agendamento = 'nao_agendada'),
    count(*) filter (where agendamento is null),
    coalesce((select jsonb_object_agg(k, n) from (
      select coalesce(finalidade, '(sem finalidade)') k, count(*) n
      from public.esteira_os where ativa group by 1) x), '{}'::jsonb),
    coalesce((select jsonb_object_agg(k, n) from (
      select coalesce(cidade, '(sem cidade)') k, count(*) n
      from public.esteira_os where ativa group by 1) x), '{}'::jsonb),
    coalesce((select jsonb_object_agg(k, n) from (
      select coalesce(finalidade, '(sem finalidade)') k, count(*) n
      from public.esteira_os where ativa and agendamento = 'nao_agendada' group by 1) x), '{}'::jsonb),
    coalesce((select jsonb_object_agg(k, n) from (
      select coalesce(cidade, '(sem cidade)') k, count(*) n
      from public.esteira_os where ativa and agendamento = 'nao_agendada' group by 1) x), '{}'::jsonb),
    now()
  from public.esteira_os where ativa
  on conflict (dia) do update set
    abertas = excluded.abertas, agendadas_conf = excluded.agendadas_conf,
    agendadas_nconf = excluded.agendadas_nconf, nao_agendadas = excluded.nao_agendadas,
    pendente = excluded.pendente, abertas_fin = excluded.abertas_fin,
    abertas_cid = excluded.abertas_cid, nag_fin = excluded.nag_fin,
    nag_cid = excluded.nag_cid, atualizado_em = excluded.atualizado_em;
end;
$$;

-- ---------------------------------------------------------------------
-- Aplicar uma coleta da LISTA. Uma transação: movimentos, fila e foto.
--
-- O módulo antigo fazia `PATCH ativa=false` em tudo e só depois o upsert:
-- entre um e outro o site via zero OS, e uma falha no meio deixava a fila
-- inteira inativa — e a coleta seguinte registrava TODAS como entrada.
--
-- p_oss: [{os, aberto_por, cliente, solicitacao, finalidade, cidade,
--          bairro, tipo_pessoa, categorias, entrou_fila, hrs_parada, tags}]
--
-- Recusa (não grava nada):
--   * lista vazia — WVSA fora, sessão expirada ou layout mudou;
--   * encolhimento para menos da metade da fila ativa, salvo `p_forcar`.
--     Uma resposta truncada viraria centenas de "saídas" que, sendo
--     append-only, não se desfazem;
--   * coleta mais antiga que a última aplicada (retry atrasado).
--
-- Sem nenhuma OS ativa (banco novo, sem importação), a primeira coleta é a
-- LINHA DE BASE: grava a fila e nenhum movimento. Senão o primeiro dia
-- teria a fila inteira como "entrada".
-- ---------------------------------------------------------------------
create or replace function public.esteira_aplicar_coleta(
  p_oss    jsonb,
  p_em     timestamptz,
  p_forcar boolean default false
) returns jsonb language plpgsql as $$
declare
  v_n_novo   int;
  v_n_ativo  int;
  v_ok_em    timestamptz;
  v_lacuna   boolean;
  v_base     boolean;
  v_ent      int := 0;
  v_sai      int := 0;
begin
  -- Dois coletores ao mesmo tempo (um retry manual durante a rodada do
  -- launchd) comparariam contra a mesma fila e duplicariam a decisão.
  perform pg_advisory_xact_lock(hashtext('esteira_aplicar_coleta'));

  if p_em is null then
    raise exception 'p_em é obrigatório';
  end if;
  if p_oss is null or jsonb_typeof(p_oss) <> 'array' or jsonb_array_length(p_oss) = 0 then
    raise exception 'lista vazia: a coleta não trouxe nenhuma OS (WVSA fora, sessão expirada ou layout mudou)';
  end if;

  select ok_em into v_ok_em from public.esteira_coleta where id = 1;
  if v_ok_em is not null and p_em <= v_ok_em then
    raise exception 'coleta de % é mais antiga que a última aplicada (%)', p_em, v_ok_em;
  end if;

  create temp table _novo on commit drop as
  select distinct on ((x->>'os')::int)
    (x->>'os')::int                         as os,
    nullif(x->>'aberto_por', '')            as aberto_por,
    nullif(x->>'cliente', '')               as cliente,
    nullif(x->>'solicitacao', '')           as solicitacao,
    nullif(x->>'finalidade', '')            as finalidade,
    nullif(x->>'cidade', '')                as cidade,
    nullif(x->>'bairro', '')                as bairro,
    nullif(x->>'tipo_pessoa', '')           as tipo_pessoa,
    nullif(x->>'categorias', '')            as categorias,
    nullif(x->>'entrou_fila', '')::timestamptz as entrou_fila,
    nullif(x->>'hrs_parada', '')::numeric   as hrs_parada,
    coalesce(x->'tags', '[]'::jsonb)        as tags
  from jsonb_array_elements(p_oss) x
  where x->>'os' ~ '^\d+$';

  select count(*) into v_n_novo from _novo;
  if v_n_novo = 0 then
    raise exception 'lista sem nenhum número de OS válido';
  end if;

  select count(*) into v_n_ativo from public.esteira_os where ativa;
  v_base := v_n_ativo = 0;
  if not p_forcar and v_n_ativo >= 20 and v_n_novo * 2 < v_n_ativo then
    raise exception 'encolhimento: % OS na coleta contra % ativas — resposta truncada? Use --forcar se a fila caiu de verdade',
      v_n_novo, v_n_ativo;
  end if;
  v_lacuna := v_ok_em is not null and p_em - v_ok_em > interval '12 hours';

  if not v_base then
    -- A OS nova precisa existir antes do movimento (FK), e nasce INATIVA:
    -- com o padrão da coluna (`ativa = true`) ela pareceria já estar na
    -- fila, e a entrada logo abaixo nunca seria registrada.
    insert into public.esteira_os (os, ativa) select n.os, false from _novo n
      on conflict (os) do nothing;

    insert into public.esteira_movimentos (os, tipo, em, finalidade, cidade, apos_lacuna)
    select n.os, 'ent', p_em, n.finalidade, n.cidade, v_lacuna
    from _novo n
    where not exists (select 1 from public.esteira_os o where o.os = n.os and o.ativa)
    on conflict on constraint esteira_movimentos_uk do nothing;
    get diagnostics v_ent = row_count;

    insert into public.esteira_movimentos (os, tipo, em, finalidade, cidade, apos_lacuna)
    select o.os, 'sai', p_em, o.finalidade, o.cidade, v_lacuna
    from public.esteira_os o
    where o.ativa and not exists (select 1 from _novo n where n.os = o.os)
    on conflict on constraint esteira_movimentos_uk do nothing;
    get diagnostics v_sai = row_count;

    update public.esteira_os o set ativa = false, saiu_em = p_em, atualizado_em = now()
    where o.ativa and not exists (select 1 from _novo n where n.os = o.os);
  end if;

  -- O que vem da LISTA. Endereço, coordenada e agendamento vêm da ficha
  -- (`esteira_aplicar_status`) e não são tocados aqui.
  insert into public.esteira_os as o (
    os, aberto_por, cliente, solicitacao, finalidade, cidade, bairro,
    tipo_pessoa, categorias, entrou_fila, hrs_parada, tags, ativa, visto_em, saiu_em)
  select n.os, n.aberto_por, n.cliente, n.solicitacao, n.finalidade, n.cidade, n.bairro,
         n.tipo_pessoa, n.categorias, n.entrou_fila, n.hrs_parada, n.tags, true, p_em, null
  from _novo n
  on conflict (os) do update set
    aberto_por = excluded.aberto_por, cliente = excluded.cliente,
    solicitacao = excluded.solicitacao, finalidade = excluded.finalidade,
    cidade = excluded.cidade, bairro = coalesce(excluded.bairro, o.bairro),
    tipo_pessoa = excluded.tipo_pessoa, categorias = excluded.categorias,
    entrou_fila = coalesce(excluded.entrou_fila, o.entrou_fila),
    hrs_parada = excluded.hrs_parada, tags = excluded.tags,
    -- Voltou para a fila: o status lido antes da saída já não vale.
    agendamento = case when o.ativa then o.agendamento end,
    agendado_para = case when o.ativa then o.agendado_para end,
    ativa = true, visto_em = p_em, saiu_em = null, atualizado_em = now();

  perform public.esteira_gravar_foto(p_em);

  update public.esteira_coleta set
    ok_em = p_em, total = v_n_novo, entraram = v_ent, sairam = v_sai,
    erro = null, erro_em = null
  where id = 1;

  return jsonb_build_object('total', v_n_novo, 'entraram', v_ent, 'sairam', v_sai,
                            'apos_lacuna', v_lacuna, 'linha_de_base', v_base);
end;
$$;

-- ---------------------------------------------------------------------
-- Aplicar o que foi lido nas FICHAS (`/os/{n}`).
--
-- p_status: [{os, agendamento, agendado_para (AAAA-MM-DD), visitas,
--             contatos, endereco, cidade, bairro, lat, lng, geo_precisao,
--             sem_sucesso: {data_evento, tecnico, motivo, observacoes, texto}}]
-- Campo ausente = não lido nesta rodada, e fica como estava.
-- ---------------------------------------------------------------------
create or replace function public.esteira_aplicar_status(
  p_status jsonb,
  p_em     timestamptz
) returns jsonb language plpgsql as $$
declare
  v_n   int;
  v_t   int;
begin
  if p_em is null then
    raise exception 'p_em é obrigatório';
  end if;
  if p_status is null or jsonb_typeof(p_status) <> 'array' then
    raise exception 'p_status precisa ser uma lista';
  end if;

  update public.esteira_os o set
    agendamento   = case when x ? 'agendamento' then nullif(x->>'agendamento', '') else o.agendamento end,
    agendado_para = case when x ? 'agendado_para' then nullif(x->>'agendado_para', '')::date else o.agendado_para end,
    visitas       = coalesce((x->>'visitas')::int, o.visitas),
    contatos      = coalesce((x->>'contatos')::int, o.contatos),
    endereco      = coalesce(nullif(x->>'endereco', ''), o.endereco),
    bairro        = coalesce(o.bairro, nullif(x->>'bairro', '')),
    cidade        = coalesce(o.cidade, nullif(x->>'cidade', '')),
    lat           = coalesce((x->>'lat')::double precision, o.lat),
    lng           = coalesce((x->>'lng')::double precision, o.lng),
    geo_precisao  = coalesce(nullif(x->>'geo_precisao', ''), o.geo_precisao),
    status_em     = case when x ? 'agendamento' then p_em else o.status_em end,
    atualizado_em = now()
  from jsonb_array_elements(p_status) x
  where x->>'os' ~ '^\d+$' and o.os = (x->>'os')::int;
  get diagnostics v_n = row_count;

  insert into public.esteira_tentativas (os, data_evento, tecnico, motivo, observacoes, texto)
  select (x->>'os')::int, (x->'sem_sucesso'->>'data_evento')::timestamptz,
         nullif(x->'sem_sucesso'->>'tecnico', ''), nullif(x->'sem_sucesso'->>'motivo', ''),
         nullif(x->'sem_sucesso'->>'observacoes', ''), nullif(x->'sem_sucesso'->>'texto', '')
  from jsonb_array_elements(p_status) x
  where x->>'os' ~ '^\d+$'
    and jsonb_typeof(x->'sem_sucesso') = 'object'
    and nullif(x->'sem_sucesso'->>'data_evento', '') is not null
    and exists (select 1 from public.esteira_os o where o.os = (x->>'os')::int)
  on conflict on constraint esteira_tentativas_uk do nothing;
  get diagnostics v_t = row_count;

  perform public.esteira_gravar_foto(p_em);
  update public.esteira_coleta set status_em = p_em where id = 1;
  return jsonb_build_object('atualizadas', v_n, 'tentativas_novas', v_t);
end;
$$;

-- ---------------------------------------------------------------------
-- Backlog oficial: p_linhas = [{mes: 'AAAA-MM-01', grupo, entradas, saidas}]
-- ---------------------------------------------------------------------
create or replace function public.esteira_aplicar_backlog(
  p_linhas jsonb,
  p_em     timestamptz
) returns int language plpgsql as $$
declare
  v_n int;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' or jsonb_array_length(p_linhas) = 0 then
    raise exception 'backlog oficial vazio';
  end if;
  insert into public.esteira_backlog_oficial as b (mes, grupo, entradas, saidas, atualizado_em)
  select (x->>'mes')::date, x->>'grupo', coalesce((x->>'entradas')::int, 0),
         coalesce((x->>'saidas')::int, 0), now()
  from jsonb_array_elements(p_linhas) x
  where nullif(x->>'grupo', '') is not null
  on conflict (mes, grupo) do update set
    entradas = excluded.entradas, saidas = excluded.saidas, atualizado_em = excluded.atualizado_em;
  get diagnostics v_n = row_count;
  update public.esteira_coleta set backlog_em = p_em where id = 1;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Leitura do fluxo por dia, em UM valor jsonb.
--
-- Uma linha por (dia, tipo, finalidade/cidade) passa de 1000 em 60 dias, e
-- o PostgREST corta função que devolve conjunto no mesmo `db-max-rows`
-- (§6). Um jsonb só não é cortado.
--
-- Formato: {"AAAA-MM-DD": {"ent": {"t": n, "lacuna": n, "fin": {...},
--           "cid": {...}}, "sai": {...}}} — movimentos `apos_lacuna` contam
-- em "lacuna", fora de "t" e das quebras.
-- ---------------------------------------------------------------------
create or replace function public.esteira_fluxo(p_de date, p_ate date)
returns jsonb language sql stable as $$
  with m as (
    select dia_operacional d, tipo, finalidade, cidade, apos_lacuna
    from public.esteira_movimentos
    where dia_operacional between p_de and p_ate
  ),
  por_tipo as (
    select d, tipo,
      jsonb_build_object(
        't', count(*) filter (where not apos_lacuna),
        'lacuna', count(*) filter (where apos_lacuna),
        'fin', coalesce((select jsonb_object_agg(k, n) from (
                 select coalesce(m2.finalidade, '(sem finalidade)') k, count(*) n from m m2
                 where m2.d = m.d and m2.tipo = m.tipo and not m2.apos_lacuna group by 1) x), '{}'::jsonb),
        'cid', coalesce((select jsonb_object_agg(k, n) from (
                 select coalesce(m2.cidade, '(sem cidade)') k, count(*) n from m m2
                 where m2.d = m.d and m2.tipo = m.tipo and not m2.apos_lacuna group by 1) x), '{}'::jsonb)
      ) v
    from m group by d, tipo
  )
  select coalesce(jsonb_object_agg(d::text, dia), '{}'::jsonb)
  from (select d, jsonb_object_agg(tipo, v) dia from por_tipo group by d) x;
$$;

-- ---------------------------------------------------------------------
-- Importação ÚNICA do histórico do Esteira-OS (backup de 22/10/2026).
--
-- Idempotente: rodar de novo não duplica nem sobrescreve. A fila importada
-- não pisa em linha que o coletor novo já tenha gravado (`do nothing`).
-- `p_tabela` ∈ os | movimentos | tentativas | backlog_diario |
-- backlog_oficial | coleta. Os dados não moram em migration (nomes e
-- endereços de cliente não vão para o Git): chegam pelo script
-- `coletor/importar_esteira_legado.py`.
-- ---------------------------------------------------------------------
create or replace function public.esteira_importar_legado(p_tabela text, p_linhas jsonb)
returns int language plpgsql as $$
declare
  v_n int := 0;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'p_linhas precisa ser uma lista';
  end if;

  if p_tabela = 'os' then
    insert into public.esteira_os (
      os, cliente, aberto_por, finalidade, cidade, bairro, endereco, lat, lng,
      geo_precisao, entrou_fila, hrs_parada, tags, agendamento, agendado_para,
      visitas, contatos, ativa, visto_em, saiu_em, criado_em, atualizado_em)
    select (x->>'os')::int, nullif(x->>'cliente', ''), nullif(x->>'aberto_por', ''),
           nullif(x->>'finalidade', ''), nullif(x->>'cidade', ''), nullif(x->>'bairro', ''),
           nullif(x->>'endereco', ''), nullif(x->>'lat', '')::double precision,
           nullif(x->>'lng', '')::double precision, nullif(x->>'geo_precisao', ''),
           nullif(x->>'entrou_fila', '')::timestamptz, nullif(x->>'hrs_parada', '')::numeric,
           coalesce(x->'tags', '[]'::jsonb), nullif(x->>'agendamento', ''),
           nullif(x->>'agendado_para', '')::date,
           coalesce(nullif(x->>'visitas', '')::int, 0), coalesce(nullif(x->>'contatos', '')::int, 0),
           (x->>'ativa')::boolean, nullif(x->>'atualizado_em', '')::timestamptz,
           case when not (x->>'ativa')::boolean then nullif(x->>'atualizado_em', '')::timestamptz end,
           coalesce(nullif(x->>'criado_em', '')::timestamptz, now()),
           coalesce(nullif(x->>'atualizado_em', '')::timestamptz, now())
    from jsonb_array_elements(p_linhas) x
    on conflict (os) do nothing;
    get diagnostics v_n = row_count;

  elsif p_tabela = 'movimentos' then
    insert into public.esteira_movimentos (os, tipo, em, finalidade, cidade, origem)
    select (x->>'os')::int, x->>'tipo', (x->>'em')::timestamptz,
           nullif(x->>'finalidade', ''), nullif(x->>'cidade', ''), 'legado'
    from jsonb_array_elements(p_linhas) x
    on conflict on constraint esteira_movimentos_uk do nothing;
    get diagnostics v_n = row_count;

  elsif p_tabela = 'tentativas' then
    insert into public.esteira_tentativas (os, data_evento, tecnico, motivo, observacoes, texto, criado_em)
    select (x->>'os')::int, (x->>'data_evento')::timestamptz, nullif(x->>'tecnico', ''),
           nullif(x->>'motivo', ''), nullif(x->>'observacoes', ''), nullif(x->>'texto', ''),
           coalesce(nullif(x->>'criado_em', '')::timestamptz, now())
    from jsonb_array_elements(p_linhas) x
    on conflict on constraint esteira_tentativas_uk do nothing;
    get diagnostics v_n = row_count;

  elsif p_tabela = 'backlog_diario' then
    insert into public.esteira_backlog_diario (
      dia, abertas, agendadas_conf, agendadas_nconf, nao_agendadas, pendente,
      abertas_fin, abertas_cid, nag_fin, nag_cid, atualizado_em)
    select (x->>'dia')::date, (x->>'abertas')::int, (x->>'agendadas_conf')::int,
           (x->>'agendadas_nconf')::int, (x->>'nao_agendadas')::int, (x->>'pendente')::int,
           coalesce(x->'abertas_fin', '{}'), coalesce(x->'abertas_cid', '{}'),
           coalesce(x->'nag_fin', '{}'), coalesce(x->'nag_cid', '{}'),
           coalesce(nullif(x->>'atualizado_em', '')::timestamptz, now())
    from jsonb_array_elements(p_linhas) x
    on conflict (dia) do nothing;
    get diagnostics v_n = row_count;

  elsif p_tabela = 'backlog_oficial' then
    insert into public.esteira_backlog_oficial (mes, grupo, entradas, saidas)
    select (x->>'mes')::date, x->>'grupo', (x->>'entradas')::int, (x->>'saidas')::int
    from jsonb_array_elements(p_linhas) x
    on conflict (mes, grupo) do nothing;
    get diagnostics v_n = row_count;

  elsif p_tabela = 'coleta' then
    -- O carimbo da última coleta do coletor ANTIGO vira o `ok_em` daqui:
    -- é contra ele que a primeira coleta nova mede a lacuna. Só avança.
    update public.esteira_coleta set
      ok_em = (p_linhas->0->>'ok_em')::timestamptz,
      total = (select count(*) from public.esteira_os where ativa)
    where id = 1 and (ok_em is null or ok_em < (p_linhas->0->>'ok_em')::timestamptz);
    get diagnostics v_n = row_count;

  else
    raise exception 'tabela de importação desconhecida: %', p_tabela;
  end if;

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Acesso: RLS ligado e sem política; só a service_role (portal e coletor).
-- Funções em `public` ficam expostas pelo PostgREST a quem tiver EXECUTE.
-- ---------------------------------------------------------------------
alter table public.esteira_os              enable row level security;
alter table public.esteira_movimentos      enable row level security;
alter table public.esteira_backlog_diario  enable row level security;
alter table public.esteira_backlog_oficial enable row level security;
alter table public.esteira_tentativas      enable row level security;
alter table public.esteira_coleta          enable row level security;

revoke all on public.esteira_os, public.esteira_movimentos, public.esteira_backlog_diario,
  public.esteira_backlog_oficial, public.esteira_tentativas, public.esteira_coleta
  from anon, authenticated;
grant select, insert, update on public.esteira_os, public.esteira_movimentos,
  public.esteira_backlog_diario, public.esteira_backlog_oficial, public.esteira_tentativas,
  public.esteira_coleta to service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'esteira_imutavel()',
    'esteira_gravar_foto(timestamptz)',
    'esteira_aplicar_coleta(jsonb, timestamptz, boolean)',
    'esteira_aplicar_status(jsonb, timestamptz)',
    'esteira_aplicar_backlog(jsonb, timestamptz)',
    'esteira_fluxo(date, date)',
    'esteira_importar_legado(text, jsonb)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
