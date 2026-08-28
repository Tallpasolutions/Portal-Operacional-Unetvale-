-- =====================================================================
-- Módulo Ações — acompanhamento, reuniões e histórico.
-- Rode no Supabase: SQL Editor -> cole -> Run.
--
-- Porta para o portal o método que hoje vive numa planilha
-- (Acompanhamento_de_Acoes.xlsx). A planilha acertou o método; o que ela
-- não consegue é dar a cada pessoa a visão das AÇÕES DELA, ser atualizada
-- do celular, e guardar o que o gestor decidiu na reunião.
--
-- 🚨 DIFERENÇA IMPORTANTE PARA OS OUTROS MÓDULOS: Produtividade, IQI e
-- Massivas são espelho do WVSA — se sumirem, recoleta-se. Aqui o dado só
-- existe aqui. Por isso `acao_eventos` é append-only e o vínculo do
-- responsável é `on delete restrict`.
-- =====================================================================

-- ---------------------------------------------------------------- áreas
-- A única lista que continua configurável pela tela. Status e Prioridade
-- ficam no código de propósito: "Concluída" e "Cancelada" decidem o cálculo
-- da situação do prazo, e deixar renomear pela tela quebraria o Painel em
-- silêncio.
create table if not exists public.acao_areas (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null unique,
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);

-- Área não se apaga, se desativa: ação antiga precisa continuar dizendo de
-- que área ela era.
insert into public.acao_areas (nome) values
  ('Operacional'), ('Infraestrutura'), ('Projetos'), ('NOC'), ('Auditoria'),
  ('Financeiro'), ('Comercial'), ('Administrativo'), ('Pessoas'),
  ('Melhoria contínua')
on conflict (nome) do nothing;

-- ------------------------------------------------------------- gestores
-- Quem manda em quais áreas. Mesma mecânica de `supervisor_equipes`: papel
-- por vínculo, não por coluna em `usuarios`.
create table if not exists public.acao_gestores (
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  area_id    uuid not null references public.acao_areas(id) on delete cascade,
  criado_em  timestamptz not null default now(),
  primary key (usuario_id, area_id)
);

-- ---------------------------------------------------------------- ações
-- O código é sequencial e ESTÁVEL. A planilha usava ROW()-5, que renumera
-- tudo abaixo quando se apaga uma linha; aqui o código é citado em ata e
-- não pode mudar de dono.
create sequence if not exists public.acao_codigo_seq;

create table if not exists public.acoes (
  id                uuid primary key default gen_random_uuid(),
  codigo            text not null unique
                    default 'AC-' || lpad(nextval('public.acao_codigo_seq')::text, 3, '0'),

  titulo            text not null,
  entrega_esperada  text,
  area_id           uuid references public.acao_areas(id) on delete set null,

  -- `restrict` e não `cascade`: apagar uma conta não pode fazer a ação
  -- sumir da pauta sem ninguém notar. Force a reatribuição antes.
  responsavel_id    uuid not null references public.usuarios(id) on delete restrict,

  data_abertura     date not null default current_date,
  prazo             date,
  prioridade        text not null default 'Média'
                    check (prioridade in ('Crítica', 'Alta', 'Média', 'Baixa')),
  status            text not null default 'Não iniciada'
                    check (status in ('Não iniciada', 'Em andamento', 'Aguardando',
                                      'Concluída', 'Cancelada')),
  progresso         smallint not null default 0 check (progresso between 0 and 100),
  proximo_passo     text,
  data_conclusao    date,
  evidencia         text,
  observacoes       text,

  criado_por        uuid references public.usuarios(id) on delete set null,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),

  -- Regra da planilha: "concluída precisa de data e evidência verificável".
  -- Fica no banco porque é a regra que mais tenta ser burlada na pressa.
  constraint concluida_exige_data_e_evidencia check (
    status <> 'Concluída'
    or (data_conclusao is not null and coalesce(evidencia, '') <> '')
  )
);

-- NÃO existem colunas "dias p/ prazo" e "situação do prazo". As duas
-- dependem de hoje e estariam erradas amanhã. São calculadas em
-- app/acoes.py, com as fórmulas da planilha copiadas no docstring.

create index if not exists acoes_responsavel_idx on public.acoes (responsavel_id);
create index if not exists acoes_prazo_idx       on public.acoes (prazo);
create index if not exists acoes_status_idx      on public.acoes (status);

-- ---------------------------------------------------------------- apoio
-- O "Apoio" da planilha era texto livre. Aqui são usuários de verdade, e
-- vários: apoio não substitui o dono, mas conta para "as minhas ações".
create table if not exists public.acao_apoio (
  acao_id    uuid not null references public.acoes(id) on delete cascade,
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  primary key (acao_id, usuario_id)
);

-- -------------------------------------------------------------- reuniões
create table if not exists public.reunioes (
  id           uuid primary key default gen_random_uuid(),
  titulo       text not null,
  tipo         text not null check (tipo in ('individual', 'grupo')),
  data         date not null default current_date,
  notas        text,
  criada_por   uuid references public.usuarios(id) on delete set null,
  criado_em    timestamptz not null default now(),
  -- Encerrada = ata congelada. Depois disso não se comenta mais nela.
  encerrada_em timestamptz
);

create table if not exists public.reuniao_participantes (
  reuniao_id uuid not null references public.reunioes(id) on delete cascade,
  usuario_id uuid not null references public.usuarios(id) on delete cascade,
  primary key (reuniao_id, usuario_id)
);

-- --------------------------------------------------------------- eventos
-- Atualização (o dono reportando) e comentário (a consideração do gestor)
-- na MESMA tabela, porque a tela mostra uma linha do tempo única. O
-- comentário quase sempre responde a uma atualização específica; separados
-- em dois registros, o leitor teria de casar as datas na mão.
--
-- Append-only: é o registro do que foi dito e quando. Não há update nem
-- delete no código, e uma trigger garante isso mesmo por SQL direto.
create table if not exists public.acao_eventos (
  id              uuid primary key default gen_random_uuid(),
  acao_id         uuid not null references public.acoes(id) on delete cascade,
  tipo            text not null check (tipo in ('atualizacao', 'comentario')),
  autor_id        uuid references public.usuarios(id) on delete set null,
  texto           text not null,

  -- Só em 'atualizacao': o estado no momento do registro. Guardar aqui é o
  -- que permite ler a evolução sem recompor a partir da ação.
  status_novo     text,
  progresso_novo  smallint,
  evidencia       text,

  -- Só em 'comentario' vindo de reunião. Nulo = comentário avulso.
  reuniao_id      uuid references public.reunioes(id) on delete set null,

  criado_em       timestamptz not null default now()
);

create index if not exists acao_eventos_acao_idx    on public.acao_eventos (acao_id, criado_em desc);
create index if not exists acao_eventos_reuniao_idx on public.acao_eventos (reuniao_id);

create or replace function public.acao_eventos_somente_insercao()
returns trigger language plpgsql as $$
begin
  raise exception 'acao_eventos e append-only: % nao e permitido', tg_op;
end;
$$;

drop trigger if exists acao_eventos_imutavel on public.acao_eventos;
create trigger acao_eventos_imutavel
  before update or delete on public.acao_eventos
  for each row execute function public.acao_eventos_somente_insercao();

-- ------------------------------------------------------------------ RLS
-- Mesmo padrão das demais: ligado e sem policy pública. O acesso é só pelo
-- Flask com a service_role, que ignora RLS. Nada exposto ao browser.
alter table public.acao_areas            enable row level security;
alter table public.acao_gestores         enable row level security;
alter table public.acoes                 enable row level security;
alter table public.acao_apoio            enable row level security;
alter table public.reunioes              enable row level security;
alter table public.reuniao_participantes enable row level security;
alter table public.acao_eventos          enable row level security;
