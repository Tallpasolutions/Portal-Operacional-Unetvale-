-- =====================================================================
-- Equipe técnica: o cadastro de quem está em campo. Rode no Supabase:
-- SQL Editor -> Run (ou psycopg com a DATABASE_URL). Aditiva e
-- reaplicável: só cria, e a carga inicial não regrava o que já existe.
-- =====================================================================
--
-- Nasceu em 24/11/2026 a partir da planilha "Equipe técnica" (19/11/2026,
-- 40 técnicos, 13 empresas), que até então só existia em papel.
--
-- POR QUE EXISTE: a capacidade da War Room era ADIVINHADA. O portal contava
-- só quem fechou OS no dia e decidia se o técnico era "interno" (6 OS/dia)
-- ou "externo" (4 OS/dia) pela maioria das OS dele em 30 dias. Isso
-- (a) só aparecia depois que o dia acontecia, (b) não tinha "capacidade
-- total" — quem não fechou nada sumia da conta — e (c) errava o perfil: a
-- planilha diz quem é interno, e é ela que manda (decisão de 24/11/2026).
-- Interno = equipe que faz atividade interna E externa (6/dia); externo =
-- só externa (4/dia). Às vezes se põe atividade interna numa equipe
-- externa, mas o cálculo segue o cadastro.
--
-- É dado que NASCE AQUI (§2): não há de onde recoletar. Por isso:
--   * técnico não se apaga, se DESATIVA (sem DELETE nem para a service_role);
--   * toda mudança fica em `equipe_tecnicos_historico`, append-only por
--     trigger. É ele que permite saber a equipe COMO ELA ERA num dia
--     passado: a capacidade de ontem não pode mudar porque alguém editou
--     um técnico hoje (`app/equipe.py`, `equipe_em`).

create table if not exists public.equipe_tecnicos (
  id                 uuid        primary key default gen_random_uuid(),
  -- Nome como a operação escreve (o da planilha).
  nome               text        not null,
  -- Nome como o WVSA entrega, quando difere ("Alex Oliveira" na planilha é
  -- "Alex de Paula Oliveira" no WVSA). É por ele que o técnico é casado
  -- com a Produtividade; vazio = o próprio `nome`.
  nome_wvsa          text,
  -- Chave de casamento: `nome_wvsa` ou `nome`, sem acento, sem caixa e
  -- com espaço colapsado. Calculada no Python (`equipe.chave`), a MESMA
  -- função que normaliza o lado da Produtividade — duas normalizações
  -- divergiriam (a armadilha dos dois normalizadores, §6).
  chave              text        not null,
  -- Empresa como o WVSA escreve no rótulo "EMPRESA - Nome" (MAYRA, NODE
  -- TECH, 3 ELLO…), para bater com a Produtividade e o vínculo do supervisor.
  empresa            text        not null,
  interno            boolean     not null default false,
  agenda_automatica  boolean     not null default false,
  retencao           boolean     not null default false,
  -- Atende SÓ retirada. A War Room é do agendamento de cliente (sem
  -- retirada e sem infra), então este técnico fica fora da capacidade
  -- dela — mas continua na equipe, e a tela de Equipe o mostra.
  retirada           boolean     not null default false,
  supervisor_id      uuid        references public.usuarios(id) on delete restrict,
  -- Texto livre, como na planilha ("São João Batista/Canelinha e Nova
  -- Trento"): são áreas de atuação, não uma lista de municípios do IBGE.
  cidades            text        not null default '',
  ativo              boolean     not null default true,
  criado_em          timestamptz not null default now(),
  atualizado_em      timestamptz not null default now(),
  -- NULL só na carga inicial: é o que o histórico usa para marcar a linha
  -- como "importada da planilha" (vale para trás no tempo).
  atualizado_por     uuid        references public.usuarios(id) on delete restrict,
  constraint equipe_tecnicos_textos_ck check (
    char_length(nome) between 1 and 120
    and coalesce(char_length(nome_wvsa), 0) <= 120
    and char_length(chave) between 1 and 120
    and char_length(empresa) between 1 and 80
    and char_length(cidades) <= 200)
);

create unique index if not exists equipe_tecnicos_chave_uk on public.equipe_tecnicos (chave);

-- ---------------------------------------------------------------------
-- Histórico: uma linha por inclusão ou alteração, com o antes e o depois.
-- ---------------------------------------------------------------------
create table if not exists public.equipe_tecnicos_historico (
  id          bigint      generated always as identity primary key,
  tecnico_id  uuid        not null references public.equipe_tecnicos(id) on delete restrict,
  em          timestamptz not null default now(),
  por         uuid        references public.usuarios(id) on delete restrict,
  -- 'importado' = carga inicial (vale desde sempre); 'criado' = incluído
  -- pela tela (não existia antes deste instante); 'alterado'.
  acao        text        not null,
  antes       jsonb,
  depois      jsonb       not null,
  constraint equipe_hist_acao_ck check (acao in ('importado', 'criado', 'alterado'))
);

create index if not exists equipe_hist_em_idx on public.equipe_tecnicos_historico (em);

create or replace function public.equipe_tecnicos_registrar()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into public.equipe_tecnicos_historico (tecnico_id, por, acao, antes, depois)
    values (new.id, new.atualizado_por,
            case when new.atualizado_por is null then 'importado' else 'criado' end,
            null, to_jsonb(new));
  elsif to_jsonb(new) - 'atualizado_em' - 'atualizado_por'
        is distinct from to_jsonb(old) - 'atualizado_em' - 'atualizado_por' then
    -- Só grava quando um campo de verdade mudou: salvar sem mudar nada
    -- não pode encher o histórico.
    insert into public.equipe_tecnicos_historico (tecnico_id, por, acao, antes, depois)
    values (new.id, new.atualizado_por, 'alterado', to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end $$;

drop trigger if exists equipe_tecnicos_historico_tg on public.equipe_tecnicos;
create trigger equipe_tecnicos_historico_tg
  after insert or update on public.equipe_tecnicos
  for each row execute function public.equipe_tecnicos_registrar();

create or replace function public.equipe_hist_imutavel()
returns trigger language plpgsql as $$
begin
  raise exception 'equipe_tecnicos_historico e append-only: % nao e permitido', tg_op;
end $$;

drop trigger if exists equipe_hist_imutavel on public.equipe_tecnicos_historico;
create trigger equipe_hist_imutavel
  before update or delete on public.equipe_tecnicos_historico
  for each row execute function public.equipe_hist_imutavel();

-- ---------------------------------------------------------------------
-- Acesso: RLS ligado e sem política; só a service_role (o portal).
-- Técnico se desativa (UPDATE); DELETE não existe nem para ela.
-- ---------------------------------------------------------------------
alter table public.equipe_tecnicos enable row level security;
alter table public.equipe_tecnicos_historico enable row level security;

revoke all on public.equipe_tecnicos, public.equipe_tecnicos_historico from anon, authenticated;
revoke delete on public.equipe_tecnicos, public.equipe_tecnicos_historico from service_role;
grant select, insert, update on public.equipe_tecnicos to service_role;
grant select, insert on public.equipe_tecnicos_historico to service_role;

-- ---------------------------------------------------------------------
-- Carga inicial: a planilha de 19/11/2026, linha a linha.
--
-- Empresa com a grafia do WVSA (conferida na Produtividade de produção em
-- 24/11/2026: "Mayra" é MAYRA, "NODE" é NODE TECH, Gabriel André Feliciano
-- aparece sob RETIRADA). `retirada` marca os três cuja área na planilha é
-- "… - Retiradas" — na Produtividade eles têm SÓ OS de retirada.
-- O supervisor é procurado pelo primeiro nome entre quem é supervisor.
--
-- ⚠️ A planilha tem "Lucas Luiz da Silva Rolla" DUAS vezes na WAVE (uma
-- com agenda automática e sem supervisor, outra com Adolar e sem agenda).
-- Entrou UMA linha, juntando as duas; o resto se acerta na tela.
--
-- `chave` aqui tem de ser exatamente o que `equipe.chave` produz: sem
-- acento, minúsculas e espaço simples.
-- ---------------------------------------------------------------------
with sup as (
  select s.usuario_id as id, lower(split_part(u.nome, ' ', 1)) as primeiro
  from public.supervisores s join public.usuarios u on u.id = s.usuario_id
),
planilha (nome, nome_wvsa, chave, empresa, interno, agenda, retencao, retirada, supervisor, cidades) as (
  values
  ('Luis Carlos Krauss', null, 'luis carlos krauss', '3 ELLO', false, true, false, false, 'adolar', 'Piçarras/Navegantes e Penha'),
  ('Jeferson da Silva Braga', null, 'jeferson da silva braga', '3 ELLO', false, false, false, false, 'adolar', 'Tijucas e Sob Demanda'),
  ('Cleiton Pinheiro', null, 'cleiton pinheiro', 'CLEITON TELECOM', false, true, false, false, 'adolar', 'Bombinhas'),
  ('Gabriel André Feliciano', null, 'gabriel andre feliciano', 'RETIRADA', true, false, false, true, 'adolar', 'Tijucas - Retiradas'),
  ('Alysson Campos Fernandes', null, 'alysson campos fernandes', 'INFRASEG', true, true, false, false, 'guilherme', 'Porto Belo/Bombinhas'),
  ('Adair José Weiss', null, 'adair jose weiss', 'INFRASEG', true, true, false, false, 'guilherme', 'Tijucas'),
  ('Joni Cardoso da Anhaia', null, 'joni cardoso da anhaia', 'JONI', true, false, false, true, 'adolar', 'Tijucas - Retiradas'),
  ('Jorge Luiz Silva', null, 'jorge luiz silva', 'JVM', true, true, false, false, 'guilherme', 'São João Batista/Canelinha e Nova Trento'),
  ('Carlos Eduardo de Almeida Carneiro', null, 'carlos eduardo de almeida carneiro', 'JVM', true, false, false, false, 'guilherme', 'Brusque, São João Batista/Canelinha e Nova Trento'),
  ('Joao Vitor Miranda', null, 'joao vitor miranda', 'JVM', true, false, true, false, 'guilherme', 'Tijucas'),
  ('Rafael Alves Antunes', null, 'rafael alves antunes', 'JVM', false, false, false, false, 'guilherme', 'Brusque'),
  ('Elias Laborda Soares Filho', null, 'elias laborda soares filho', 'JVM', true, false, false, false, 'guilherme', 'Tijucas'),
  ('Matheus Martins da Costa', null, 'matheus martins da costa', 'MAYRA', true, true, false, false, 'davi', 'Porto Belo/Bombinhas'),
  ('Pedro Vitor Miquelina Paim', null, 'pedro vitor miquelina paim', 'MAYRA', true, true, false, false, 'davi', 'Porto Belo/Bombinhas'),
  ('André Guilherme Antunes', null, 'andre guilherme antunes', 'MAYRA', true, true, false, false, 'davi', 'Tijucas, Porto Belo e Bombinhas'),
  ('Maurício Fernando Diedrich', null, 'mauricio fernando diedrich', 'MAYRA', true, true, true, false, 'davi', 'Tijucas'),
  ('Lucas Alves Ramos', null, 'lucas alves ramos', 'NODE TECH', true, true, true, false, 'davi', 'Tijucas'),
  ('Anderson Luiz Candido', null, 'anderson luiz candido', 'PC PRIME', true, true, true, false, 'davi', 'Brusque'),
  ('Vanessa Clerici', null, 'vanessa clerici', 'PC PRIME', true, false, false, true, 'davi', 'Brusque - Retiradas'),
  ('Willian de Freitas Pereira', null, 'willian de freitas pereira', 'RM', false, true, false, false, 'guilherme', 'Tijucas'),
  ('Rodrigo Rodrigues de Oliveira', null, 'rodrigo rodrigues de oliveira', 'RM', false, false, false, false, 'guilherme', 'Tijucas'),
  ('Matheus Deiss Silva', null, 'matheus deiss silva', 'RM', false, false, false, false, 'guilherme', 'Porto Belo e Tijucas'),
  ('Luiz Fernando Cavalheiro Siqueira', null, 'luiz fernando cavalheiro siqueira', 'RTM', true, true, false, false, 'davi', 'Porto Belo'),
  ('Everton Luis Vieira Amaral', null, 'everton luis vieira amaral', 'RTM', false, true, false, false, 'davi', 'Porto Belo'),
  ('Alex Oliveira', 'Alex de Paula Oliveira', 'alex de paula oliveira', 'RTM', false, false, false, false, 'davi', 'Porto Belo'),
  ('Alex Sandro Rodrigues Paschoal', null, 'alex sandro rodrigues paschoal', 'UNETVALE', false, false, true, false, 'davi', 'Bombinhas'),
  ('Itamar Rodrigues de Oliveira Junior', null, 'itamar rodrigues de oliveira junior', 'UNETVALE', true, false, false, false, 'adolar', 'Bombinhas'),
  ('Ronivon Oliveira Alves', null, 'ronivon oliveira alves', 'UNETVALE', false, true, true, false, 'davi', 'Bombinhas'),
  ('Luan Guilherme Maciel', null, 'luan guilherme maciel', 'UNETVALE', false, true, true, false, 'davi', 'Brusque'),
  ('Rodrigo Sampaio dos Santos', null, 'rodrigo sampaio dos santos', 'UNETVALE', false, false, false, false, 'adolar', 'Piçarras/Navegantes e Penha'),
  ('Jesiel Geraldo', null, 'jesiel geraldo', 'UNETVALE', false, true, true, false, 'guilherme', 'Governador Celso Ramos'),
  ('Rudnei Wisbecki', null, 'rudnei wisbecki', 'UNETVALE', false, true, true, false, 'guilherme', 'São João Batista/Canelinha e Nova Trento'),
  ('Ian Hames Hinckel', null, 'ian hames hinckel', 'UNETVALE', false, true, true, false, 'davi', 'Tijucas'),
  ('Marcelo Henrique de Morais Fuhr', null, 'marcelo henrique de morais fuhr', 'UNETVALE', false, false, true, false, 'guilherme', 'Tijucas e Sob Demanda'),
  ('Jose Victor Libardoni', null, 'jose victor libardoni', 'UNETVALE', true, true, false, false, 'adolar', 'Tijucas, São João Batista/Canelinha e Nova Trento'),
  ('Eduardo Ribeiro de Souza', null, 'eduardo ribeiro de souza', 'WAVE', false, true, false, false, 'adolar', 'Brusque'),
  ('Lucas Luiz da Silva Rolla', null, 'lucas luiz da silva rolla', 'WAVE', false, true, false, false, 'adolar', 'Tijucas, Porto Belo'),
  ('Alan Francisco de Lima Costa', null, 'alan francisco de lima costa', 'WAVE', false, true, true, false, 'adolar', 'Piçarras/Navegantes e Penha'),
  ('Caua de Oliveira Souza', null, 'caua de oliveira souza', 'WAVE', false, true, false, false, 'adolar', 'Porto Belo/Tijucas')
)
insert into public.equipe_tecnicos
  (nome, nome_wvsa, chave, empresa, interno, agenda_automatica, retencao, retirada, supervisor_id, cidades)
select p.nome, p.nome_wvsa, p.chave, p.empresa, p.interno, p.agenda, p.retencao, p.retirada,
       (select sup.id from sup where sup.primeiro = p.supervisor limit 1), p.cidades
from planilha p
on conflict (chave) do nothing;
