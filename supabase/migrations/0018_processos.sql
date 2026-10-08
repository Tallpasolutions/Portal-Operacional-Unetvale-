-- =====================================================================
-- Módulo Processos — mapa de processos, fluxogramas e instruções de
-- trabalho (IT).
-- Rode no Supabase: SQL Editor -> cole -> Run.
--
-- Nasceu para a Infraestrutura, que tem dois times com trabalho muito
-- diferente: o INTERNO (projeto, abertura de OS, atendimento ao técnico) e o
-- de CAMPO (o técnico que executa). Os dois processos não estavam escritos em
-- lugar nenhum; aqui eles ganham fluxo desenhado e IT com revisão aprovada,
-- que vai para o técnico em PDF.
--
-- 🚨 Como em Ações, o dado NASCE AQUI — não há de onde recoletar. Por isso:
--   * nada se apaga: processo se arquiva, IT se obsoleta (`on delete restrict`);
--   * revisão APROVADA é imutável por trigger: a Rev. 02 impressa no poste
--     tem de continuar sendo a Rev. 02 daqui a um ano;
--   * eventos e fotos do fluxo são append-only por trigger.
--
-- O que precisa ser atômico mora em funções (`supa.rpc`): o PostgREST não tem
-- transação entre requisições, e "aprovar" é meia dúzia de escritas que não
-- podem parar no meio.
--
-- Aditiva: nada de drop de tabela, nada de alter destrutivo.
-- =====================================================================


-- ------------------------------------------------------- sigla da área
-- O código do processo leva a área ("PR-INF-003"): é assim que ele é citado
-- em conversa e em OS. `text` nulo e único só entre os preenchidos — área nova
-- sem sigla cai em GER, em vez de travar a criação do processo.
alter table public.acao_areas add column if not exists sigla text;
create unique index if not exists acao_areas_sigla_uk
  on public.acao_areas (sigla) where sigla is not null;

-- As dez áreas semeadas na 0005. `and sigla is null`: reaplicar a migration
-- não desfaz uma sigla que alguém tenha trocado depois.
update public.acao_areas a set sigla = v.sigla
  from (values ('Infraestrutura', 'INF'), ('Operacional', 'OPE'),
               ('Projetos', 'PRJ'), ('NOC', 'NOC'), ('Auditoria', 'AUD'),
               ('Financeiro', 'FIN'), ('Comercial', 'COM'),
               ('Administrativo', 'ADM'), ('Pessoas', 'PES'),
               ('Melhoria contínua', 'MCO')) as v(nome, sigla)
 where a.nome = v.nome and a.sigla is null;


-- ------------------------------------------------------------ contadores
-- Um contador por prefixo ("PR-INF", "IT-INF"). Sequence do Postgres não
-- serve: seria uma por área, criada dinamicamente. O `on conflict do update`
-- trava a linha, então duas criações simultâneas nunca pegam o mesmo número.
create table if not exists public.processo_contadores (
  prefixo text primary key,
  ultimo  integer not null default 0
);


-- -------------------------------------------------------------- processos
create table if not exists public.processos (
  id            uuid primary key default gen_random_uuid(),
  -- ESTÁVEL: trocar a área depois não renumera. O código é citado em IT
  -- impressa e não pode mudar de dono.
  codigo        text not null unique,
  titulo        text not null check (char_length(btrim(titulo)) between 3 and 160),
  area_id       uuid not null references public.acao_areas(id) on delete restrict,
  -- Quem executa o processo. 'ambos' é o caso de fronteira — o que começa no
  -- interno e termina no campo, como a troca de poste.
  publico       text not null default 'interno'
                check (publico in ('interno', 'campo', 'ambos')),
  dono_id       uuid references public.usuarios(id) on delete set null,
  objetivo      text,
  escopo        text,
  entradas      text,
  saidas        text,
  status        text not null default 'ativo' check (status in ('ativo', 'arquivado')),
  criado_por    uuid references public.usuarios(id) on delete set null,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index if not exists processos_area_idx on public.processos (area_id, status);


-- -------------------------------------------------------------- fluxos
-- O desenho inteiro é UM documento jsonb (formas, ligações, raias, traços).
-- Tabela por forma faria cada arrasto virar dezenas de UPDATE, e o desenho só
-- tem sentido inteiro: o editor carrega e grava o documento todo.
create table if not exists public.processo_fluxos (
  id             uuid primary key default gen_random_uuid(),
  processo_id    uuid not null references public.processos(id) on delete restrict,
  titulo         text not null default 'Fluxo principal'
                 check (char_length(btrim(titulo)) between 1 and 120),
  documento      jsonb not null
                 default '{"v":1,"raias":[],"nos":[],"ligacoes":[],"livres":[]}'::jsonb,
  -- Concorrência otimista: quem grava diz qual versão leu. "Todos editam"
  -- (decisão de 08/10/2026) faz duas pessoas no mesmo fluxo ser questão de
  -- tempo, e a segunda gravação não pode apagar a primeira em silêncio.
  versao         integer not null default 1,
  arquivado      boolean not null default false,
  atualizado_por uuid references public.usuarios(id) on delete set null,
  atualizado_em  timestamptz not null default now(),
  -- Presença: "Renato está editando". Avisa ANTES do conflito.
  editando_por   uuid references public.usuarios(id) on delete set null,
  editando_desde timestamptz,
  criado_por     uuid references public.usuarios(id) on delete set null,
  criado_em      timestamptz not null default now(),
  -- 1 MB de texto, bem abaixo dos ~4,5 MB de corpo que a Vercel aceita: o
  -- documento vai e volta inteiro a cada salvamento.
  constraint processo_fluxos_tamanho check (octet_length(documento::text) < 1048576)
);

create index if not exists processo_fluxos_processo_idx
  on public.processo_fluxos (processo_id, criado_em);


-- Fotos do documento: "Salvar versão" manual, a que a aprovação de uma IT
-- tira sozinha e a de antes de restaurar uma foto antiga. Append-only.
create table if not exists public.processo_fluxo_versoes (
  id         uuid primary key default gen_random_uuid(),
  fluxo_id   uuid not null references public.processo_fluxos(id) on delete restrict,
  versao     integer not null,
  nome       text,
  motivo     text not null default 'manual'
             check (motivo in ('manual', 'aprovacao_it', 'antes_de_restaurar')),
  documento  jsonb not null,
  criado_por uuid references public.usuarios(id) on delete set null,
  criado_em  timestamptz not null default now()
);

create index if not exists processo_fluxo_versoes_idx
  on public.processo_fluxo_versoes (fluxo_id, criado_em desc);


-- ------------------------------------------------------------ instruções
create table if not exists public.instrucoes (
  id              uuid primary key default gen_random_uuid(),
  codigo          text not null unique,
  processo_id     uuid not null references public.processos(id) on delete restrict,
  -- De qual fluxo a IT é gerada e qual vai congelado no anexo. `set null`
  -- seria inócuo (fluxo não se apaga), mas deixa explícito que a IT vale
  -- sem fluxo.
  fluxo_id        uuid references public.processo_fluxos(id) on delete set null,
  titulo          text not null check (char_length(btrim(titulo)) between 3 and 160),
  executa         text not null default 'campo' check (executa in ('interno', 'campo')),
  -- Número da revisão aprovada em vigor. Nulo = nunca aprovada.
  revisao_vigente integer,
  status          text not null default 'ativa' check (status in ('ativa', 'obsoleta')),
  criado_por      uuid references public.usuarios(id) on delete set null,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);

create index if not exists instrucoes_processo_idx on public.instrucoes (processo_id);


create table if not exists public.instrucao_revisoes (
  id               uuid primary key default gen_random_uuid(),
  instrucao_id     uuid not null references public.instrucoes(id) on delete restrict,
  numero           integer not null check (numero >= 0),
  -- Seções da IT (objetivo, EPIs, passos…). jsonb pelo mesmo motivo do
  -- documento do fluxo: é lido e gravado inteiro, e a forma das seções vai
  -- evoluir sem migration.
  conteudo         jsonb not null default '{}'::jsonb,
  -- O fluxo como era quando esta revisão foi aprovada. É o que o anexo do
  -- PDF desenha — nunca o fluxo de hoje.
  fluxo_snapshot   jsonb,
  motivo_revisao   text,
  status           text not null default 'rascunho'
                   check (status in ('rascunho', 'em_aprovacao', 'devolvida',
                                     'aprovada', 'substituida')),
  versao           integer not null default 1,
  elaborado_por    uuid references public.usuarios(id) on delete set null,
  elaborado_em     timestamptz not null default now(),
  enviado_por      uuid references public.usuarios(id) on delete set null,
  enviado_em       timestamptz,
  aprovado_por     uuid references public.usuarios(id) on delete set null,
  aprovado_em      timestamptz,
  vigente_desde    date,
  devolvido_motivo text,
  atualizado_por   uuid references public.usuarios(id) on delete set null,
  atualizado_em    timestamptz not null default now(),
  unique (instrucao_id, numero),
  constraint instrucao_revisoes_tamanho check (octet_length(conteudo::text) < 1048576)
);

-- Uma revisão ABERTA por IT. Duas em paralelo obrigariam a decidir qual vira
-- a Rev. 03 — e a outra seria trabalho jogado fora sem ninguém avisar.
create unique index if not exists instrucao_revisoes_aberta_uk
  on public.instrucao_revisoes (instrucao_id)
  where status in ('rascunho', 'em_aprovacao', 'devolvida');


-- Revisão aprovada (ou substituída) não muda mais. A única transição aceita
-- depois de aprovar é aprovada -> substituida, que a próxima aprovação faz.
create or replace function public.instrucao_revisao_protegida()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('aprovada', 'substituida') then
      raise exception 'revisão aprovada não se apaga';
    end if;
    return old;
  end if;

  if old.status in ('aprovada', 'substituida') then
    if new.conteudo        is distinct from old.conteudo
    or new.fluxo_snapshot  is distinct from old.fluxo_snapshot
    or new.numero          is distinct from old.numero
    or new.instrucao_id    is distinct from old.instrucao_id
    or new.elaborado_por   is distinct from old.elaborado_por
    or new.aprovado_por    is distinct from old.aprovado_por
    or new.aprovado_em     is distinct from old.aprovado_em
    or new.vigente_desde   is distinct from old.vigente_desde then
      raise exception 'revisão aprovada é imutável: abra uma nova revisão';
    end if;
    if new.status is distinct from old.status
       and not (old.status = 'aprovada' and new.status = 'substituida') then
      raise exception 'revisão aprovada não volta para %', new.status;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists instrucao_revisoes_protegida on public.instrucao_revisoes;
create trigger instrucao_revisoes_protegida
  before update or delete on public.instrucao_revisoes
  for each row execute function public.instrucao_revisao_protegida();


-- Histórico da IT: criada, enviada, devolvida (com o porquê), aprovada…
-- Alimenta o "Histórico de revisões" do PDF.
create table if not exists public.instrucao_eventos (
  id              uuid primary key default gen_random_uuid(),
  instrucao_id    uuid not null references public.instrucoes(id) on delete restrict,
  revisao_numero  integer,
  tipo            text not null
                  check (tipo in ('criada', 'enviada', 'devolvida', 'aprovada',
                                  'nova_revisao', 'obsoleta', 'reativada')),
  texto           text,
  autor_id        uuid references public.usuarios(id) on delete set null,
  criado_em       timestamptz not null default now()
);

create index if not exists instrucao_eventos_idx
  on public.instrucao_eventos (instrucao_id, criado_em);


-- Mesma função para as duas tabelas append-only deste módulo.
create or replace function public.processos_somente_insercao()
returns trigger language plpgsql as $$
begin
  raise exception '% é append-only: % não é permitido', tg_table_name, tg_op;
end;
$$;

drop trigger if exists instrucao_eventos_imutavel on public.instrucao_eventos;
create trigger instrucao_eventos_imutavel
  before update or delete on public.instrucao_eventos
  for each row execute function public.processos_somente_insercao();

drop trigger if exists processo_fluxo_versoes_imutavel on public.processo_fluxo_versoes;
create trigger processo_fluxo_versoes_imutavel
  before update or delete on public.processo_fluxo_versoes
  for each row execute function public.processos_somente_insercao();


-- ------------------------------------------------------------------- RLS
-- Ligado e sem policy: o acesso é só pelo Flask, com a service_role.
alter table public.processo_contadores    enable row level security;
alter table public.processos              enable row level security;
alter table public.processo_fluxos        enable row level security;
alter table public.processo_fluxo_versoes enable row level security;
alter table public.instrucoes             enable row level security;
alter table public.instrucao_revisoes     enable row level security;
alter table public.instrucao_eventos      enable row level security;


-- =====================================================================
-- Funções
-- =====================================================================

-- processo_proximo_codigo — 'PR' ou 'IT' + sigla da área + número.
create or replace function public.processo_proximo_codigo(p_tipo text, p_area uuid)
returns text language plpgsql as $$
declare
  v_sigla   text;
  v_prefixo text;
  v_n       integer;
begin
  if p_tipo not in ('PR', 'IT') then
    raise exception 'tipo de código inválido: %', p_tipo;
  end if;
  select sigla into v_sigla from public.acao_areas where id = p_area;
  v_prefixo := p_tipo || '-' || coalesce(v_sigla, 'GER');
  insert into public.processo_contadores (prefixo, ultimo) values (v_prefixo, 1)
  on conflict (prefixo) do update set ultimo = public.processo_contadores.ultimo + 1
  returning ultimo into v_n;
  return v_prefixo || '-' || lpad(v_n::text, 3, '0');
end;
$$;


-- processo_criar — código, processo e o primeiro fluxo num fato só. Sem a
-- transação, uma queda entre as escritas deixaria processo sem fluxo e número
-- consumido.
create or replace function public.processo_criar(
  p_titulo   text,
  p_area     uuid,
  p_publico  text,
  p_dono     uuid,
  p_objetivo text,
  p_documento jsonb,
  p_autor    uuid
) returns jsonb language plpgsql as $$
declare
  v_codigo text;
  v_id     uuid;
  v_fluxo  uuid;
begin
  perform 1 from public.acao_areas where id = p_area;
  if not found then
    raise exception 'área inexistente';
  end if;
  v_codigo := public.processo_proximo_codigo('PR', p_area);
  insert into public.processos (codigo, titulo, area_id, publico, dono_id, objetivo,
                                criado_por)
  values (v_codigo, btrim(p_titulo), p_area, coalesce(p_publico, 'interno'), p_dono,
          nullif(btrim(coalesce(p_objetivo, '')), ''), p_autor)
  returning id into v_id;
  insert into public.processo_fluxos (processo_id, documento, criado_por, atualizado_por)
  values (v_id, coalesce(p_documento,
                         '{"v":1,"raias":[],"nos":[],"ligacoes":[],"livres":[]}'::jsonb),
          p_autor, p_autor)
  returning id into v_fluxo;
  return jsonb_build_object('id', v_id, 'codigo', v_codigo, 'fluxo_id', v_fluxo);
end;
$$;


-- processo_fluxo_salvar — grava SÓ se ninguém gravou depois da leitura.
-- Conflito não é erro: devolve quem salvou e quando, e a tela oferece
-- recarregar ou salvar como cópia. Nunca sobrescreve em silêncio.
create or replace function public.processo_fluxo_salvar(
  p_fluxo  uuid,
  p_doc    jsonb,
  p_versao integer,
  p_autor  uuid
) returns jsonb language plpgsql as $$
declare
  v record;
begin
  update public.processo_fluxos
     set documento = p_doc, versao = versao + 1,
         atualizado_por = p_autor, atualizado_em = now(),
         editando_por = p_autor,
         editando_desde = case when editando_por = p_autor
                               then coalesce(editando_desde, now()) else now() end
   where id = p_fluxo and versao = p_versao and not arquivado
  returning versao, atualizado_em into v;
  if found then
    return jsonb_build_object('ok', true, 'versao', v.versao, 'em', v.atualizado_em);
  end if;

  select versao, atualizado_por, atualizado_em, arquivado
    into v from public.processo_fluxos where id = p_fluxo;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'inexistente');
  end if;
  if v.arquivado then
    return jsonb_build_object('ok', false, 'erro', 'arquivado');
  end if;
  return jsonb_build_object('ok', false, 'erro', 'conflito', 'versao', v.versao,
                            'por', v.atualizado_por, 'em', v.atualizado_em);
end;
$$;


-- processo_fluxo_fotografar — "Salvar versão": copia o documento atual para o
-- histórico numa instrução só (ler e inserir em duas idas poderia fotografar
-- uma versão que já mudou).
create or replace function public.processo_fluxo_fotografar(
  p_fluxo  uuid,
  p_nome   text,
  p_motivo text,
  p_autor  uuid
) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.processo_fluxo_versoes (fluxo_id, versao, nome, motivo, documento,
                                             criado_por)
  select id, versao, nullif(btrim(coalesce(p_nome, '')), ''),
         coalesce(p_motivo, 'manual'), documento, p_autor
    from public.processo_fluxos where id = p_fluxo
  returning id into v_id;
  if v_id is null then
    raise exception 'fluxo inexistente';
  end if;
  return v_id;
end;
$$;


-- instrucao_criar — código, IT, revisão 00 e o evento num fato só.
create or replace function public.instrucao_criar(
  p_processo uuid,
  p_fluxo    uuid,
  p_titulo   text,
  p_executa  text,
  p_conteudo jsonb,
  p_autor    uuid
) returns jsonb language plpgsql as $$
declare
  v_area   uuid;
  v_codigo text;
  v_id     uuid;
begin
  select area_id into v_area from public.processos where id = p_processo;
  if not found then
    raise exception 'processo inexistente';
  end if;
  if p_fluxo is not null then
    perform 1 from public.processo_fluxos where id = p_fluxo and processo_id = p_processo;
    if not found then
      raise exception 'o fluxo não é deste processo';
    end if;
  end if;
  v_codigo := public.processo_proximo_codigo('IT', v_area);
  insert into public.instrucoes (codigo, processo_id, fluxo_id, titulo, executa, criado_por)
  values (v_codigo, p_processo, p_fluxo, btrim(p_titulo), coalesce(p_executa, 'campo'),
          p_autor)
  returning id into v_id;
  insert into public.instrucao_revisoes (instrucao_id, numero, conteudo, elaborado_por,
                                         atualizado_por, motivo_revisao)
  values (v_id, 0, coalesce(p_conteudo, '{}'::jsonb), p_autor, p_autor, 'Emissão inicial');
  insert into public.instrucao_eventos (instrucao_id, revisao_numero, tipo, autor_id)
  values (v_id, 0, 'criada', p_autor);
  return jsonb_build_object('id', v_id, 'codigo', v_codigo);
end;
$$;


-- instrucao_salvar — rascunho com concorrência otimista, igual ao fluxo.
-- Em aprovação NÃO se edita: o aprovador estaria aprovando um texto que muda
-- enquanto ele lê.
create or replace function public.instrucao_salvar(
  p_rev      uuid,
  p_conteudo jsonb,
  p_versao   integer,
  p_autor    uuid
) returns jsonb language plpgsql as $$
declare
  v record;
begin
  update public.instrucao_revisoes
     set conteudo = p_conteudo, versao = versao + 1,
         atualizado_por = p_autor, atualizado_em = now()
   where id = p_rev and versao = p_versao and status in ('rascunho', 'devolvida')
  returning versao, atualizado_em into v;
  if found then
    return jsonb_build_object('ok', true, 'versao', v.versao, 'em', v.atualizado_em);
  end if;
  select versao, status, atualizado_por, atualizado_em
    into v from public.instrucao_revisoes where id = p_rev;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'inexistente');
  end if;
  if v.status not in ('rascunho', 'devolvida') then
    return jsonb_build_object('ok', false, 'erro', 'bloqueada', 'status', v.status);
  end if;
  return jsonb_build_object('ok', false, 'erro', 'conflito', 'versao', v.versao,
                            'por', v.atualizado_por, 'em', v.atualizado_em);
end;
$$;


-- instrucao_enviar — rascunho/devolvida -> em aprovação.
create or replace function public.instrucao_enviar(p_rev uuid, p_autor uuid)
returns void language plpgsql as $$
declare
  r public.instrucao_revisoes%rowtype;
begin
  select * into r from public.instrucao_revisoes where id = p_rev for update;
  if not found then
    raise exception 'revisão inexistente';
  end if;
  if r.status not in ('rascunho', 'devolvida') then
    raise exception 'só rascunho ou revisão devolvida pode ser enviada';
  end if;
  -- IT sem passo não instrui ninguém. O resto das seções é opcional.
  if jsonb_typeof(r.conteudo -> 'passos') is distinct from 'array'
     or jsonb_array_length(r.conteudo -> 'passos') = 0 then
    raise exception 'a instrução precisa de pelo menos um passo';
  end if;
  update public.instrucao_revisoes
     set status = 'em_aprovacao', enviado_por = p_autor, enviado_em = now(),
         devolvido_motivo = null
   where id = p_rev;
  insert into public.instrucao_eventos (instrucao_id, revisao_numero, tipo, autor_id)
  values (r.instrucao_id, r.numero, 'enviada', p_autor);
end;
$$;


-- instrucao_aprovar — o fato inteiro da aprovação.
-- QUEM pode aprovar (gestor da área ou admin) é decidido no Flask. Aqui fica a
-- trava que não pode depender de a rota lembrar: quem elaborou ou enviou não
-- aprova a própria revisão.
create or replace function public.instrucao_aprovar(p_rev uuid, p_aprovador uuid)
returns void language plpgsql as $$
declare
  r     public.instrucao_revisoes%rowtype;
  v_it  public.instrucoes%rowtype;
  v_doc jsonb;
begin
  select * into r from public.instrucao_revisoes where id = p_rev for update;
  if not found then
    raise exception 'revisão inexistente';
  end if;
  if r.status <> 'em_aprovacao' then
    raise exception 'só revisão em aprovação pode ser aprovada';
  end if;
  if p_aprovador is null
     or p_aprovador = r.elaborado_por or p_aprovador = r.enviado_por then
    raise exception 'quem elaborou ou enviou a revisão não pode aprová-la';
  end if;

  select * into v_it from public.instrucoes where id = r.instrucao_id for update;
  if v_it.fluxo_id is not null then
    select documento into v_doc from public.processo_fluxos where id = v_it.fluxo_id;
  end if;

  update public.instrucao_revisoes set status = 'substituida'
   where instrucao_id = r.instrucao_id and status = 'aprovada';

  update public.instrucao_revisoes
     set status = 'aprovada', aprovado_por = p_aprovador, aprovado_em = now(),
         vigente_desde = (now() at time zone 'America/Sao_Paulo')::date,
         fluxo_snapshot = v_doc
   where id = p_rev;

  if v_doc is not null then
    insert into public.processo_fluxo_versoes (fluxo_id, versao, nome, motivo, documento,
                                               criado_por)
    select f.id, f.versao, v_it.codigo || ' Rev. ' || lpad(r.numero::text, 2, '0'),
           'aprovacao_it', v_doc, p_aprovador
      from public.processo_fluxos f where f.id = v_it.fluxo_id;
  end if;

  update public.instrucoes
     set revisao_vigente = r.numero, status = 'ativa', atualizado_em = now()
   where id = r.instrucao_id;

  insert into public.instrucao_eventos (instrucao_id, revisao_numero, tipo, autor_id)
  values (r.instrucao_id, r.numero, 'aprovada', p_aprovador);
end;
$$;


-- instrucao_devolver — volta para quem escreveu, com o porquê.
create or replace function public.instrucao_devolver(p_rev uuid, p_autor uuid, p_motivo text)
returns void language plpgsql as $$
declare
  r public.instrucao_revisoes%rowtype;
begin
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'diga o que precisa mudar';
  end if;
  select * into r from public.instrucao_revisoes where id = p_rev for update;
  if not found then
    raise exception 'revisão inexistente';
  end if;
  if r.status <> 'em_aprovacao' then
    raise exception 'só revisão em aprovação pode ser devolvida';
  end if;
  update public.instrucao_revisoes
     set status = 'devolvida', devolvido_motivo = left(btrim(p_motivo), 1000)
   where id = p_rev;
  insert into public.instrucao_eventos (instrucao_id, revisao_numero, tipo, texto, autor_id)
  values (r.instrucao_id, r.numero, 'devolvida', left(btrim(p_motivo), 1000), p_autor);
end;
$$;


-- instrucao_nova_revisao — abre a Rev. N+1 a partir da vigente.
create or replace function public.instrucao_nova_revisao(
  p_instrucao uuid,
  p_autor     uuid,
  p_motivo    text
) returns integer language plpgsql as $$
declare
  v_it     public.instrucoes%rowtype;
  v_base   jsonb;
  v_numero integer;
begin
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'diga o motivo da revisão';
  end if;
  select * into v_it from public.instrucoes where id = p_instrucao for update;
  if not found then
    raise exception 'instrução inexistente';
  end if;
  if v_it.revisao_vigente is null then
    raise exception 'a instrução ainda não tem revisão aprovada';
  end if;
  select conteudo into v_base from public.instrucao_revisoes
   where instrucao_id = p_instrucao and numero = v_it.revisao_vigente;
  select coalesce(max(numero), -1) + 1 into v_numero
    from public.instrucao_revisoes where instrucao_id = p_instrucao;
  -- Se já houver revisão aberta, o índice único parcial recusa aqui.
  insert into public.instrucao_revisoes (instrucao_id, numero, conteudo, elaborado_por,
                                         atualizado_por, motivo_revisao)
  values (p_instrucao, v_numero, coalesce(v_base, '{}'::jsonb), p_autor, p_autor,
          left(btrim(p_motivo), 500));
  insert into public.instrucao_eventos (instrucao_id, revisao_numero, tipo, texto, autor_id)
  values (p_instrucao, v_numero, 'nova_revisao', left(btrim(p_motivo), 500), p_autor);
  return v_numero;
end;
$$;


-- instrucao_obsoletar / reativar — a IT sai (ou volta) das listas; os PDFs
-- de todas as revisões continuam disponíveis.
create or replace function public.instrucao_definir_status(
  p_instrucao uuid,
  p_status    text,
  p_autor     uuid,
  p_motivo    text
) returns void language plpgsql as $$
begin
  if p_status not in ('ativa', 'obsoleta') then
    raise exception 'status inválido: %', p_status;
  end if;
  update public.instrucoes set status = p_status, atualizado_em = now()
   where id = p_instrucao and status <> p_status;
  if not found then
    raise exception 'nada a mudar';
  end if;
  insert into public.instrucao_eventos (instrucao_id, tipo, texto, autor_id)
  values (p_instrucao, case when p_status = 'obsoleta' then 'obsoleta' else 'reativada' end,
          nullif(left(btrim(coalesce(p_motivo, '')), 500), ''), p_autor);
end;
$$;


-- Só a service_role executa: funções em `public` ficam expostas pelo
-- PostgREST a quem tiver EXECUTE.
do $$
declare
  f text;
begin
  foreach f in array array[
    'processo_proximo_codigo(text, uuid)',
    'processo_criar(text, uuid, text, uuid, text, jsonb, uuid)',
    'processo_fluxo_salvar(uuid, jsonb, integer, uuid)',
    'processo_fluxo_fotografar(uuid, text, text, uuid)',
    'instrucao_criar(uuid, uuid, text, text, jsonb, uuid)',
    'instrucao_salvar(uuid, jsonb, integer, uuid)',
    'instrucao_enviar(uuid, uuid)',
    'instrucao_aprovar(uuid, uuid)',
    'instrucao_devolver(uuid, uuid, text)',
    'instrucao_nova_revisao(uuid, uuid, text)',
    'instrucao_definir_status(uuid, text, uuid, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
