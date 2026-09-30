-- =====================================================================
-- Ações em quadro: etiquetas e checklist.
-- Rode no Supabase: SQL Editor -> cole -> Run.
--
-- O quadro Kanban em si não precisa de banco — as colunas são os status
-- fixos de `acoes.STATUS`. O que entra aqui são as duas coisas que a ação
-- não tinha onde guardar:
--
-- `acoes.etiquetas` — rótulos livres ("Cliente VIP", "Processo"). `text[]`
--   e não tabela de vínculo: etiqueta não tem dono, cor nem ciclo de vida, é
--   só um jeito de achar a ação depois. Uma tabela pediria tela de cadastro
--   para uma lista que a própria digitação já monta.
--
-- `acao_checklist` — subtarefas. Com UM item ou mais, o progresso da ação
--   deixa de ser digitado e passa a ser feitos ÷ total. O valor é GRAVADO em
--   `acoes.progresso`, e não calculado na leitura: a lista, a pauta da
--   reunião, os eventos e o Painel já leem aquela coluna e continuam sem
--   saber que checklist existe.
--
-- Por isso o checklist só se altera pela função `acao_checklist_aplicar`:
-- marcar o item e regravar o % são um fato só. Em duas requisições do
-- PostgREST, uma queda entre elas deixaria a barra discordando da lista.
--
-- Item de checklist SE APAGA (ao contrário de `acao_eventos`): é plano de
-- trabalho, não registro do que foi dito. O que foi feito aparece na
-- atividade da ação pelo `feito_em` enquanto o item existir.
--
-- Aditiva: nada de drop, nada de alter destrutivo.
-- =====================================================================

alter table public.acoes
  add column if not exists etiquetas text[] not null default '{}';

-- GIN porque o filtro é "tem esta etiqueta" (`etiquetas @> '{X}'`), que o
-- índice b-tree não atende.
create index if not exists acoes_etiquetas_idx on public.acoes using gin (etiquetas);

create table if not exists public.acao_checklist (
  id          uuid primary key default gen_random_uuid(),
  acao_id     uuid not null references public.acoes(id) on delete cascade,
  texto       text not null check (char_length(btrim(texto)) between 1 and 200),
  feito       boolean not null default false,
  feito_por   uuid references public.usuarios(id) on delete set null,
  feito_em    timestamptz,
  ordem       integer not null default 0,
  criado_por  uuid references public.usuarios(id) on delete set null,
  criado_em   timestamptz not null default now()
);

create index if not exists acao_checklist_acao_idx on public.acao_checklist (acao_id, ordem);

-- Mesmo padrão das demais: RLS ligado e sem policy. O acesso é só pelo Flask
-- com a service_role.
alter table public.acao_checklist enable row level security;


-- ---------------------------------------------------------------------
-- acao_checklist_aplicar — a única porta de escrita do checklist.
--
-- p_op: 'criar' (usa p_texto), 'marcar', 'desmarcar', 'renomear' (p_item +
-- p_texto) e 'apagar' (p_item). Devolve {total, feitos, progresso}.
-- ---------------------------------------------------------------------
create or replace function public.acao_checklist_aplicar(
  p_acao    uuid,
  p_op      text,
  p_item    uuid default null,
  p_texto   text default null,
  p_usuario uuid default null
) returns jsonb
language plpgsql
as $$
declare
  v_status text;
  v_total  integer;
  v_feitos integer;
  v_prog   smallint;
begin
  -- `for update` trava a linha da ação: duas pessoas marcando itens ao mesmo
  -- tempo contariam, cada uma, sem o item da outra, e o último a gravar
  -- deixaria o % errado.
  select status into v_status from public.acoes where id = p_acao for update;
  if not found then
    raise exception 'ação inexistente';
  end if;

  if p_op = 'criar' then
    if coalesce(btrim(p_texto), '') = '' then
      raise exception 'escreva o item do checklist';
    end if;
    insert into public.acao_checklist (acao_id, texto, ordem, criado_por)
    values (p_acao, left(btrim(p_texto), 200),
            coalesce((select max(ordem) + 1 from public.acao_checklist
                      where acao_id = p_acao), 0),
            p_usuario);

  elsif p_op in ('marcar', 'desmarcar', 'renomear', 'apagar') then
    -- O item tem de ser DESTA ação. Sem a conferência, quem pode mexer numa
    -- ação marcaria item de outra só trocando o id na requisição.
    perform 1 from public.acao_checklist where id = p_item and acao_id = p_acao;
    if not found then
      raise exception 'item não pertence a esta ação';
    end if;

    if p_op = 'marcar' then
      -- `and not feito`: marcar duas vezes não reescreve quem fez e quando.
      update public.acao_checklist
         set feito = true, feito_por = p_usuario, feito_em = now()
       where id = p_item and not feito;
    elsif p_op = 'desmarcar' then
      update public.acao_checklist
         set feito = false, feito_por = null, feito_em = null
       where id = p_item;
    elsif p_op = 'renomear' then
      if coalesce(btrim(p_texto), '') = '' then
        raise exception 'escreva o item do checklist';
      end if;
      update public.acao_checklist set texto = left(btrim(p_texto), 200)
       where id = p_item;
    else
      delete from public.acao_checklist where id = p_item;
    end if;

  else
    raise exception 'operação inválida: %', p_op;
  end if;

  select count(*), count(*) filter (where feito)
    into v_total, v_feitos
    from public.acao_checklist where acao_id = p_acao;

  -- Sem item nenhum o % volta a ser manual e fica onde estava — zerar
  -- apagaria o que a pessoa tinha reportado antes de criar o checklist.
  -- Concluída fica em 100 (regra de `acoes.atualizar`) e Cancelada fica como
  -- parou: o checklist não reabre nem desfaz decisão de status.
  if v_total > 0 and v_status not in ('Concluída', 'Cancelada') then
    v_prog := round(v_feitos * 100.0 / v_total);
    update public.acoes
       set progresso = v_prog, atualizado_em = now()
     where id = p_acao and progresso is distinct from v_prog;
  end if;

  return jsonb_build_object(
    'total', v_total,
    'feitos', v_feitos,
    'progresso', (select progresso from public.acoes where id = p_acao));
end;
$$;

comment on function public.acao_checklist_aplicar is
  'Única porta de escrita do checklist: altera o item e regrava acoes.progresso (feitos ÷ total) na mesma transação.';

-- Função em `public` fica exposta pelo PostgREST a quem tiver EXECUTE. O
-- portal chama com a service_role; anon e authenticated não têm o que fazer
-- aqui.
revoke execute on function public.acao_checklist_aplicar(uuid, text, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.acao_checklist_aplicar(uuid, text, uuid, text, uuid)
  to service_role;
