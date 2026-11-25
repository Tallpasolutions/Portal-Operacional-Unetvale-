-- =====================================================================
-- Responsável por técnico, presença corrigida pelo supervisor e histórico
-- do vínculo. Rode no Supabase: SQL Editor -> Run (ou psycopg com a
-- DATABASE_URL). Aditiva e reaplicável: só cria, nada é apagado.
-- =====================================================================
--
-- Pedido de 25/11/2026, em três partes:
--
-- 1. **Presença** (`warroom_presenca`). Na capacidade da War Room, "em
--    campo" é quem fechou ao menos uma OS de cliente no dia. O supervisor
--    passa a poder CORRIGIR isso técnico a técnico: esteve em campo e não
--    fechou nada (só visitas sem baixa), ou fechou uma OS e foi embora.
--    APPEND-ONLY: cada clique é uma linha, a mais nova de (dia, técnico)
--    vale, e "voltar ao automático" é uma linha com `presente` nulo. Nada
--    some, e dá para saber quem mudou o quê e quando.
--
-- 2. **Responsável de técnico novo** (`tecnico_responsavel`). Técnico novo
--    de empresa terceira já cai no supervisor da empresa (vínculo por
--    equipe); o da UNETVALE, que é repartida nome a nome, não tem para onde
--    ir. A War Room mostra um aviso a todos os supervisores e o PRIMEIRO que
--    responde decide — a chave primária é o técnico, então o segundo clique
--    perde e a tela diz quem decidiu. A função grava a decisão e o vínculo
--    na MESMA transação (`tecnico_definir_responsavel`).
--
-- 3. **Histórico do vínculo** (`supervisor_vinculo_eventos`). Desde
--    25/11/2026 o próprio supervisor adiciona e remove técnicos e equipes do
--    time dele em Configurações. `supervisor_equipes` e `supervisor_tecnicos`
--    são caixas de marcar (desvincular apaga a linha), então quem desfez o
--    quê ficava sem rastro. Cada mudança vira uma linha aqui, append-only:
--    é de onde se refaz um vínculo removido por engano.

-- ---------------------------------------------------------------------
-- 1. Presença
-- ---------------------------------------------------------------------
create table if not exists public.warroom_presenca (
  id            bigint      generated always as identity primary key,
  dia           date        not null,
  -- `equipe.chave` do nome como o WVSA entrega (ou o `nome_wvsa` do
  -- cadastro): é por ela que a Produtividade e o cadastro se casam.
  tecnico_chave text        not null,
  -- Nome para a tela, como estava na hora do clique.
  tecnico       text        not null,
  -- true = esteve em campo; false = não esteve; null = volta a valer o
  -- que a Produtividade diz (ter fechado OS de cliente no dia).
  presente      boolean,
  motivo        text,
  usuario_id    uuid        not null references public.usuarios(id) on delete restrict,
  em            timestamptz not null default now(),
  constraint warroom_presenca_textos_ck check (
    char_length(tecnico_chave) between 1 and 120
    and char_length(tecnico) between 1 and 120
    and coalesce(char_length(motivo), 0) <= 300)
);

create index if not exists warroom_presenca_dia_idx
  on public.warroom_presenca (dia, tecnico_chave, em desc);

-- ---------------------------------------------------------------------
-- 2. Responsável decidido pelo aviso de técnico novo
-- ---------------------------------------------------------------------
create table if not exists public.tecnico_responsavel (
  -- `supervisores.chave_tecnico` do rótulo "EMPRESA - Nome": a mesma chave
  -- de `supervisor_tecnicos.tecnico`.
  tecnico       text        primary key,
  rotulo        text        not null,
  -- NULL = "não é técnico de campo" (o supervisor que fechou uma OS, por
  -- exemplo): a pergunta não volta, e nenhum vínculo é criado.
  supervisor_id uuid        references public.usuarios(id) on delete restrict,
  definido_por  uuid        not null references public.usuarios(id) on delete restrict,
  definido_em   timestamptz not null default now(),
  constraint tecnico_responsavel_textos_ck check (
    char_length(tecnico) between 1 and 160 and char_length(rotulo) between 1 and 160)
);

-- ---------------------------------------------------------------------
-- 3. Histórico do vínculo supervisor ↔ equipe/técnico
-- ---------------------------------------------------------------------
create table if not exists public.supervisor_vinculo_eventos (
  id            bigint      generated always as identity primary key,
  em            timestamptz not null default now(),
  -- Quem fez (o admin, o próprio supervisor ou o supervisor que respondeu
  -- o aviso de técnico novo).
  por           uuid        references public.usuarios(id) on delete restrict,
  supervisor_id uuid        not null,
  tipo          text        not null,
  -- A equipe (como em `supervisor_equipes.equipe`) ou a chave do técnico.
  valor         text        not null,
  rotulo        text,
  acao          text        not null,
  origem        text        not null default 'configuracoes',
  constraint supervisor_vinculo_eventos_ck check (
    tipo in ('equipe', 'tecnico')
    and acao in ('vinculou', 'desvinculou')
    and origem in ('configuracoes', 'aviso_tecnico_novo', 'carga')
    and char_length(valor) between 1 and 160)
);

create index if not exists supervisor_vinculo_eventos_em_idx
  on public.supervisor_vinculo_eventos (em desc);

-- ---------------------------------------------------------------------
-- Append-only: presença e histórico do vínculo não se alteram nem somem.
-- ---------------------------------------------------------------------
create or replace function public.append_only_recusar()
returns trigger language plpgsql as $$
begin
  raise exception '% e append-only: % nao e permitido', tg_table_name, tg_op;
end $$;

drop trigger if exists warroom_presenca_imutavel on public.warroom_presenca;
create trigger warroom_presenca_imutavel
  before update or delete on public.warroom_presenca
  for each row execute function public.append_only_recusar();

drop trigger if exists supervisor_vinculo_eventos_imutavel on public.supervisor_vinculo_eventos;
create trigger supervisor_vinculo_eventos_imutavel
  before update or delete on public.supervisor_vinculo_eventos
  for each row execute function public.append_only_recusar();

-- ---------------------------------------------------------------------
-- O primeiro supervisor que responde decide, e o vínculo nasce junto.
-- Devolve {ok: true} ou {ok: false, supervisor_id, definido_por,
-- definido_em} com a decisão que já existia.
-- ---------------------------------------------------------------------
create or replace function public.tecnico_definir_responsavel(
  p_tecnico text, p_rotulo text, p_supervisor uuid, p_por uuid)
returns jsonb language plpgsql as $$
declare
  v_existente public.tecnico_responsavel%rowtype;
begin
  if p_supervisor is not null
     and not exists (select 1 from public.supervisores where usuario_id = p_supervisor) then
    raise exception 'supervisor desconhecido';
  end if;
  insert into public.tecnico_responsavel (tecnico, rotulo, supervisor_id, definido_por)
  values (p_tecnico, p_rotulo, p_supervisor, p_por)
  on conflict (tecnico) do nothing;
  if not found then
    select * into v_existente from public.tecnico_responsavel where tecnico = p_tecnico;
    return jsonb_build_object('ok', false, 'supervisor_id', v_existente.supervisor_id,
                              'definido_por', v_existente.definido_por,
                              'definido_em', v_existente.definido_em);
  end if;
  if p_supervisor is not null then
    insert into public.supervisor_tecnicos (usuario_id, tecnico, rotulo)
    values (p_supervisor, p_tecnico, p_rotulo)
    on conflict (usuario_id, tecnico) do nothing;
    if found then
      insert into public.supervisor_vinculo_eventos
        (por, supervisor_id, tipo, valor, rotulo, acao, origem)
      values (p_por, p_supervisor, 'tecnico', p_tecnico, p_rotulo, 'vinculou', 'aviso_tecnico_novo');
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- Acesso: RLS ligado e sem política; só a service_role (o portal).
-- ---------------------------------------------------------------------
alter table public.warroom_presenca enable row level security;
alter table public.tecnico_responsavel enable row level security;
alter table public.supervisor_vinculo_eventos enable row level security;

revoke all on public.warroom_presenca, public.tecnico_responsavel,
              public.supervisor_vinculo_eventos from anon, authenticated;
revoke update, delete on public.warroom_presenca, public.supervisor_vinculo_eventos,
                         public.tecnico_responsavel from service_role;
grant select, insert on public.warroom_presenca, public.supervisor_vinculo_eventos,
                        public.tecnico_responsavel to service_role;

revoke all on function public.tecnico_definir_responsavel(text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.tecnico_definir_responsavel(text, text, uuid, uuid) to service_role;
