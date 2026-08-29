-- =====================================================================
-- Módulo Dashboard (visão gerencial). Rode no Supabase: SQL Editor -> Run.
--
-- Aditiva: só cria. Nada de drop/alter destrutivo — as duas tabelas nascem
-- vazias e o módulo tolera a ausência delas até esta migration rodar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Histórico da esteira de agendamento.
--
-- Por que NÃO cabe em `dados_modulo`: lá `modulo` é chave primária, então
-- cada coleta apaga a anterior — fica só a foto mais recente. A pergunta do
-- módulo é outra: "quantas OS entraram e quantas saíram desde a abertura do
-- dia?". Isso é diferença entre DUAS fotos, e exige guardar as duas.
--
-- `oss` guarda o CONJUNTO de números de OS, não apenas o total. Contagem
-- sozinha não distingue "5 entraram e 5 saíram" de "nada aconteceu" — os dois
-- casos mantêm o total igual, e é justamente o primeiro que interessa. São
-- ~520 inteiros por captura e ~6 capturas por dia: o custo é irrelevante
-- perto de responder errado.
-- ---------------------------------------------------------------------
create table if not exists public.dashboard_esteira_snapshot (
  id             bigserial   primary key,
  capturado_em   timestamptz not null default now(),
  dia            date        not null,
  -- Primeira captura do dia: é a base de comparação das demais.
  abertura       boolean     not null default false,
  total          integer     not null,
  por_finalidade jsonb       not null default '{}'::jsonb,
  oss            jsonb       not null default '[]'::jsonb
);

-- A leitura é sempre "as capturas de hoje, mais recente primeiro".
create index if not exists dashboard_esteira_dia_idx
  on public.dashboard_esteira_snapshot (dia desc, capturado_em desc);

-- Uma abertura por dia. Sem isto, uma segunda rodada às 08h (retry após queda
-- de rede) criaria uma segunda "abertura" e o entrou/saiu passaria a comparar
-- contra a foto errada, sem erro nenhum na tela.
create unique index if not exists dashboard_esteira_abertura_idx
  on public.dashboard_esteira_snapshot (dia) where abertura;

-- ---------------------------------------------------------------------
-- Metas dos indicadores do Dashboard.
--
-- `valor` nulo é estado legítimo: significa "meta ainda não definida", e a
-- tela mostra o número SEM a comparação. O contrário — cravar um alvo
-- plausível para não deixar o campo vazio — produziria "fora da meta" contra
-- uma meta que ninguém combinou.
--
-- `direcao` existe porque as duas famílias convivem: IQI/IQM são "quanto
-- menor, melhor"; GPON e salas Disk são o oposto.
-- ---------------------------------------------------------------------
create table if not exists public.dashboard_metas (
  chave         text        primary key,
  valor         numeric,
  direcao       text        not null default 'menor',
  rotulo        text,
  atualizado_em timestamptz not null default now(),
  constraint dashboard_metas_direcao_ck check (direcao in ('menor', 'maior'))
);

-- Só as quatro já combinadas. CMT, esteira útil, fila de retirada e IDF ficam
-- de fora de propósito: entram por Configurações quando forem definidas.
insert into public.dashboard_metas (chave, valor, direcao, rotulo) values
  ('iqi',  17, 'menor', 'IQI — instalação (%)'),
  ('iqm',   7, 'menor', 'IQM — manutenção (%)'),
  ('gpon', 10, 'maior', 'GPON apagado'),
  ('disk',  5, 'maior', 'Salas Disk abertas')
on conflict (chave) do nothing;

-- RLS ligado e sem políticas: acesso só pelo Flask e pelo coletor, ambos com
-- a service_role (que ignora RLS). Nada exposto à chave anônima.
alter table public.dashboard_esteira_snapshot enable row level security;
alter table public.dashboard_metas            enable row level security;
