-- =====================================================================
-- Troca de Poste: atualizar a agenda do WVSA sob demanda, pelo modal da OS.
-- Rode no Supabase: SQL Editor -> Run. Aditiva: só cria.
-- =====================================================================
--
-- O caso que motivou (13/10/2026): o operador libera no WVSA a agenda de
-- alguns técnicos, volta ao portal para abrir a OS e os horários não estão
-- lá — a cópia da agenda roda de 15 em 15 min (`OS_AGENDAMENTO_MINUTOS`), e
-- até a próxima o modal mostra a lista velha. Esperar 15 min com a obra na
-- frente é o que manda a pessoa abrir a OS direto no WVSA.
--
-- O portal NÃO alcança o WVSA (IP privado, §2 do CLAUDE.md). Então o botão
-- "Atualizar do WVSA" deixa um PEDIDO aqui, e quem atende é o
-- `coletor/enviar_os.py`, que já roda residente dentro da rede e já confere
-- a fila de OS a cada 5 s. A tela espera o pedido ser atendido e recarrega a
-- lista.
--
-- Uma linha só (`check (id = 1)`), como o `coletor_heartbeat`: é ESTADO, não
-- histórico. Dois cliques — da mesma pessoa ou de duas — são o mesmo pedido,
-- e uma cópia da agenda atende os dois. Uma tabela de pedidos empilharia
-- linhas para um trabalho que não tem identidade própria.
--
-- ⚠️ Atendido é comparado por `atendido_pedido_em`, e não por relógio: o
-- `pedido_em` é escrito pela Vercel e a cópia acontece no Mac do coletor.
-- Comparar o relógio de uma máquina com o da outra faria uma cópia iniciada
-- ANTES do clique parecer posterior a ele, com uns segundos de diferença — e
-- a tela diria "atualizado" sobre uma agenda de antes da liberação. O coletor
-- copia para `atendido_pedido_em` o `pedido_em` que LEU ao começar: atendeu
-- tudo o que foi pedido até ali, e nada depois.
create table if not exists troca_poste.agenda_sincronizacao (
  id                 int primary key default 1 check (id = 1),
  -- Escritos pelo portal, no clique.
  pedido_em          timestamptz,
  pedido_por         uuid,
  -- Escritos pelo coletor, a cada cópia (sob demanda ou na cadência de 15 min).
  atendido_pedido_em timestamptz,
  sincronizado_em    timestamptz,       -- início da última tentativa
  ultimo_ok_em       timestamptz,       -- início da última que deu certo
  ok                 boolean,
  erro               text,
  contagem           jsonb              -- {tipo: n} da última que deu certo
);

comment on table troca_poste.agenda_sincronizacao is
  'Pedido de cópia da agenda do WVSA feito pelo modal da OS, e o desfecho da última cópia. Uma linha só. Quem atende é coletor/enviar_os.py.';
comment on column troca_poste.agenda_sincronizacao.atendido_pedido_em is
  'O pedido_em que o coletor leu ao começar a cópia. Atendido = atendido_pedido_em >= pedido_em. Nunca compare com sincronizado_em: são relógios de máquinas diferentes.';

insert into troca_poste.agenda_sincronizacao (id) values (1)
  on conflict (id) do nothing;

-- O `grant all on all tables in schema troca_poste` do monorepo (10_tp_rls)
-- valeu para as tabelas que existiam NAQUELE dia; tabela nova não herda.
-- RLS ligado e sem policy: só a service_role (portal e coletor) enxerga.
alter table troca_poste.agenda_sincronizacao enable row level security;
grant select, insert, update on troca_poste.agenda_sincronizacao to service_role;
