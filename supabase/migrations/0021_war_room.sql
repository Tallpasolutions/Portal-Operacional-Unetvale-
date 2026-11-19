-- =====================================================================
-- War Room de Operações. Rode no Supabase: SQL Editor -> Run.
-- Aditiva e reaplicável: só cria.
-- =====================================================================
--
-- Nasceu em 19/11/2026, com a sala de guerra "Zerando a esteira": os
-- supervisores passam o dia na mesa, ao lado do agendamento, conferindo a
-- saída do almoxarifado, as rotas, a agenda das 10h/12h/15h/18h e as OS de
-- suporte — e registrando TODO desvio com causa, responsável e solução.
--
-- É dado que NASCE AQUI (§2 do CLAUDE.md): não há de onde recoletar. Por
-- isso nada se apaga — desvio registrado por engano se ANULA, com motivo, e
-- continua na tabela.
--
-- O catálogo (momento, tipo, causa, responsável) mora em `app/war_room.py`
-- e NÃO em `check` do banco: ele vai ser ajustado com os supervisores nos
-- primeiros dias, e cada ajuste viraria uma migration. O banco confere o que
-- não muda: status, tamanho dos textos e o formato da OS.

create table if not exists public.warroom_desvios (
  id                uuid        primary key default gen_random_uuid(),
  -- O dia a que o desvio pertence. Vem do Python (dia civil de Brasília),
  -- não de `now()::date`, que é UTC: o desvio das 21h30 cairia no dia
  -- seguinte (§6, "data de timestamptz cortada do texto ISO está em UTC").
  dia               date        not null,
  registrado_em     timestamptz not null default now(),
  registrado_por    uuid        not null references public.usuarios(id) on delete restrict,
  momento           text        not null,
  tipo              text        not null,
  causa             text        not null,
  detalhe           text,
  responsavel       text        not null,
  responsavel_nome  text,
  tecnico           text,
  empresa           text,
  -- Números de OS do WVSA. Lista porque um desvio de rota costuma envolver
  -- várias OS do mesmo técnico; vazia quando o desvio não é de OS (saída
  -- tardia do almoxarifado, por exemplo).
  os                text[]      not null default '{}',
  horario           time,
  solucao           text        not null,
  status            text        not null default 'resolvido',
  resolvido_em      timestamptz,
  resolvido_por     uuid        references public.usuarios(id) on delete restrict,
  atualizado_em     timestamptz,
  atualizado_por    uuid        references public.usuarios(id) on delete restrict,
  anulado_em        timestamptz,
  anulado_por       uuid        references public.usuarios(id) on delete restrict,
  anulado_motivo    text,
  constraint warroom_desvios_status_ck check (status in ('resolvido', 'pendente')),
  constraint warroom_desvios_textos_ck check (
    char_length(momento) <= 40 and char_length(tipo) <= 40 and char_length(causa) <= 40
    and char_length(responsavel) <= 40
    and coalesce(char_length(detalhe), 0) <= 500
    and coalesce(char_length(responsavel_nome), 0) <= 120
    and coalesce(char_length(tecnico), 0) <= 120
    and coalesce(char_length(empresa), 0) <= 80
    and char_length(solucao) between 1 and 1000
    and coalesce(char_length(anulado_motivo), 0) <= 300),
  constraint warroom_desvios_os_ck check (
    cardinality(os) <= 20 and array_to_string(os, ',') ~ '^[0-9,]*$'),
  -- Anular exige motivo: "sumiu da lista" sem porquê é o que se quer evitar.
  constraint warroom_desvios_anulado_ck check (
    anulado_em is null or (anulado_por is not null and coalesce(anulado_motivo, '') <> ''))
);

create index if not exists warroom_desvios_dia_idx on public.warroom_desvios (dia);

-- ---------------------------------------------------------------------
-- Rodadas: "o check das 10h foi feito, por quem e quando".
--
-- Sem isto, um dia sem desvio registrado e um dia em que ninguém conferiu
-- nada têm a mesma cara na tela. Uma linha por (dia, momento, pessoa): cada
-- supervisor confere o próprio time, e dois cliques são a mesma rodada.
-- Desmarcar apaga a linha — é uma caixa de seleção, não um registro de fato.
-- ---------------------------------------------------------------------
create table if not exists public.warroom_rodadas (
  dia         date        not null,
  momento     text        not null,
  usuario_id  uuid        not null references public.usuarios(id) on delete restrict,
  feito_em    timestamptz not null default now(),
  primary key (dia, momento, usuario_id),
  constraint warroom_rodadas_momento_ck check (char_length(momento) <= 40)
);

-- ---------------------------------------------------------------------
-- Acesso: RLS ligado e sem política; só a service_role (o portal).
-- O desvio NÃO tem DELETE nem para ela: anular é UPDATE.
-- ---------------------------------------------------------------------
alter table public.warroom_desvios enable row level security;
alter table public.warroom_rodadas enable row level security;

revoke all on public.warroom_desvios, public.warroom_rodadas from anon, authenticated;
revoke delete on public.warroom_desvios from service_role;
grant select, insert, update on public.warroom_desvios to service_role;
grant select, insert, update, delete on public.warroom_rodadas to service_role;
