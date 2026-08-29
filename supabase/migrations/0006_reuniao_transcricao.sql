-- =====================================================================
-- Reuniões — gravação, transcrição e ata gerada por IA.
-- Rode no Supabase: SQL Editor -> cole -> Run.
--
-- Estende o que o 0005 já criou. A reunião continua sendo a mesma
-- entidade, com a mesma pauta e os mesmos comentários; o que entra aqui
-- é o áudio, o texto que sai dele e o que a IA extraiu do texto.
--
-- 🚨 TUDO AQUI É ADITIVO. `add column if not exists` e
-- `create table if not exists`, nada de drop e nada de alter destrutivo
-- (CLAUDE.md §5). O aviso do §9 vale: Ações não tem de onde ser
-- recoletado — rodar duas vezes precisa ser inofensivo, e é.
--
-- DUAS DECISÕES QUE EXPLICAM O FORMATO DAS TABELAS:
--
-- 1. O áudio é cortado em TRECHOS, não guardado inteiro. A Vercel é
--    serverless: não há processo em background e o corpo da requisição
--    é limitado. Trecho de ~2 min sobe direto para o Storage e é
--    transcrito numa chamada que fecha em segundos, DURANTE a reunião.
--    Guardar "o áudio da reunião" numa coluna só obrigaria a processar
--    tudo depois, num tempo que a plataforma não dá.
--
-- 2. A ata é gravada DUAS vezes: como prosa (`reunioes.ata_markdown`,
--    que é o que a pessoa lê) e como linhas (`reuniao_ata_itens`, que é
--    o que a máquina agrupa). Sem as linhas não existe "esta ação já foi
--    discutida em 3 reuniões e não saiu do lugar" — cruzar assunto entre
--    reuniões exige registro estruturado, não texto para procurar.
-- =====================================================================

-- ------------------------------------------------------- reunioes (+)
-- O estado da gravação vive na reunião porque é dela que a tela precisa
-- decidir o que mostrar: botão de gravar, barra de progresso ou ata.
alter table public.reunioes
  add column if not exists gravacao_status text not null default 'sem_gravacao'
    check (gravacao_status in ('sem_gravacao', 'gravando', 'transcrevendo', 'pronta', 'erro')),
  -- Quando o gestor clicou em gravar. Junto com `consentimento_em` é o
  -- registro de que a captura começou por ato humano, e não sozinha.
  add column if not exists gravacao_iniciada_em timestamptz,
  add column if not exists consentimento_em     timestamptz,
  -- Transcrição inteira, montada a partir dos trechos na ordem. É
  -- desnormalização deliberada: os trechos podem ter o áudio expurgado
  -- em 30 dias, e o texto tem de sobreviver a isso.
  add column if not exists transcricao          text,
  add column if not exists ata_markdown         text,
  add column if not exists ata_gerada_em        timestamptz,
  add column if not exists ata_modelo           text,
  -- A aba fechou no meio, a bateria acabou, o navegador matou a página.
  -- A ata sai do que existe, mas sai CARIMBADA: parcial apresentado como
  -- completo é o pior desfecho possível para uma ata.
  add column if not exists gravacao_interrompida boolean not null default false,
  add column if not exists gravacao_erro         text;

-- ---------------------------------------------------- trechos de áudio
create table if not exists public.reuniao_audio (
  id          uuid primary key default gen_random_uuid(),
  reuniao_id  uuid not null references public.reunioes(id) on delete cascade,

  -- Ordem do trecho na reunião, começando em 0. É o que reconstrói a
  -- transcrição na sequência certa — carimbo de tempo não serve, porque
  -- dois trechos podem ser transcritos fora de ordem se um falhar e for
  -- repetido depois.
  indice      integer not null,

  caminho     text not null,          -- objeto dentro do bucket privado
  formato     text,                   -- audio/webm no Chrome, audio/mp4 no Safari
  bytes       integer,
  duracao_ms  integer,

  status      text not null default 'pendente'
              check (status in ('pendente', 'ok', 'erro')),
  texto       text,                   -- o que o Whisper devolveu
  -- Resumo curto do trecho, calculado logo após transcrever. Existe para
  -- reunião longa: quando a transcrição inteira não cabe no contexto do
  -- modelo, a ata é montada a partir destas notas. Como já foram feitas
  -- durante a reunião, o caminho longo não custa nada a mais no fim.
  notas       text,
  tentativas  smallint not null default 0,
  erro        text,

  -- Retenção: o áudio é o dado mais sensível e o mais pesado. Some em 30
  -- dias; a transcrição e a ata ficam para sempre. Depois disso a ata não
  -- pode mais ser regerada, e é uma troca consciente.
  audio_expira_em  timestamptz not null default now() + interval '30 days',
  audio_apagado_em timestamptz,

  criado_em   timestamptz not null default now(),

  -- Rede oscilando faz o navegador reenviar o mesmo trecho. Sem esta
  -- restrição a transcrição sairia com parágrafo repetido e ninguém
  -- entenderia por quê.
  constraint reuniao_audio_indice_unico unique (reuniao_id, indice)
);

create index if not exists reuniao_audio_reuniao_idx
  on public.reuniao_audio (reuniao_id, indice);
-- Índice do expurgo: varre só o que já venceu e ainda não foi apagado.
create index if not exists reuniao_audio_expurgo_idx
  on public.reuniao_audio (audio_expira_em)
  where audio_apagado_em is null;

-- ------------------------------------------------- itens extraídos da ata
create table if not exists public.reuniao_ata_itens (
  id          uuid primary key default gen_random_uuid(),
  reuniao_id  uuid not null references public.reunioes(id) on delete cascade,

  tipo        text not null
              check (tipo in ('decisao', 'encaminhamento', 'pendencia', 'risco')),
  texto       text not null,
  responsavel_id uuid references public.usuarios(id) on delete set null,
  prazo       date,

  -- Preenchido quando a ata cita um código de ação (AC-012). É este
  -- vínculo que responde "quantas vezes já falamos disso".
  acao_id     uuid references public.acoes(id) on delete set null,

  -- Um item vira comentário na linha do tempo da ação SÓ por clique
  -- humano. `acao_eventos` é append-only por trigger: texto de IA que
  -- entrasse sozinho lá seria irreversível, e ninguém revisa o que já
  -- está escrito em pedra.
  aplicado_em  timestamptz,
  aplicado_por uuid references public.usuarios(id) on delete set null,

  ordem       smallint not null default 0,
  criado_em   timestamptz not null default now()
);

create index if not exists reuniao_ata_itens_reuniao_idx
  on public.reuniao_ata_itens (reuniao_id, ordem);
-- O índice que sustenta o resumo executivo: "todos os itens desta ação,
-- em todas as reuniões, na ordem do tempo".
create index if not exists reuniao_ata_itens_acao_idx
  on public.reuniao_ata_itens (acao_id, criado_em)
  where acao_id is not null;

-- ------------------------------------------------------ resumo executivo
-- Texto consolidado que atravessa reuniões. Fica gravado, e não é gerado
-- a cada abertura de tela, por dois motivos: chamada a modelo custa cota
-- do plano gratuito, e resumo que muda de redação a cada F5 parece
-- instável mesmo quando os fatos são os mesmos.
create table if not exists public.resumo_executivo (
  id        uuid primary key default gen_random_uuid(),
  escopo    text not null check (escopo in ('acao', 'area', 'geral')),
  ref_id    uuid,                    -- acao_id, area_id, ou nulo em 'geral'
  markdown  text not null,
  modelo    text,
  gerado_em timestamptz not null default now(),

  -- Marca d'água do que o resumo já viu. Item novo depois desta data
  -- significa resumo desatualizado — é o gatilho para regerar, e evita
  -- gastar chamada quando nada mudou.
  base_ate  timestamptz not null default now()
);

-- `unique (escopo, ref_id)` não serviria: no Postgres NULL nunca é igual
-- a NULL, então 'geral' criaria uma linha nova a cada geração.
create unique index if not exists resumo_executivo_chave_idx
  on public.resumo_executivo
     (escopo, coalesce(ref_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ------------------------------------------------------------------ RLS
-- Mesmo padrão de todo o resto: ligado e sem policy nenhuma. O acesso é
-- só pelo Flask com a service_role, que ignora RLS. Nada exposto ao
-- browser — e o bucket de áudio, pelo mesmo motivo, é privado.
alter table public.reuniao_audio     enable row level security;
alter table public.reuniao_ata_itens enable row level security;
alter table public.resumo_executivo  enable row level security;
