-- =====================================================================
-- Troca de Poste: revisão humana de endereço + ensaio do envio de OS.
-- Rode no Supabase: SQL Editor -> Run. Aditiva: cria função e índice,
-- e só recria um CHECK (nenhuma linha é tocada).
-- =====================================================================
--
-- ⚠️ Esta é a PRIMEIRA migration deste repositório a mexer no schema
-- `troca_poste`. Todo o DDL daquele schema nasceu no monorepo
-- (~/Documents/Dashboard Operacional/supabase/migrations/*_tp_*.sql), que
-- continua sendo o dono do pipeline da Celesc.
--
-- O que justifica a exceção: as duas coisas aqui existem para o PORTAL, e
-- só para ele. `aplicar_revisao` é chamada pela tela de revisão do Flask
-- (a API Express do monorepo, que tinha a versão TypeScript disso, nunca
-- entrou no ar); `status='ensaio'` existe para o botão de OS do Flask.
-- Deixá-las no monorepo faria a tela depender de DDL de um repositório
-- que ninguém abre para mexer nesta funcionalidade.
-- =====================================================================

set search_path to public, extensions;

-- ---------------------------------------------------------------------
-- (a) A revisão humana, nos três passos que ela SEMPRE tem que ter.
-- ---------------------------------------------------------------------
--
-- Porte da `aplicarRevisao` do monorepo
-- (apps/api/src/modules/troca-poste/repository-revisao.ts), que já estava
-- escrita e testada e nunca teve como rodar.
--
-- Por que uma função e não três chamadas do Flask: os três passos são um
-- fato só. Gravar a coordenada sem gravar o alias faz a MESMA linha voltar
-- para a fila na próxima coleta — o revisor confirmaria o mesmo endereço
-- para sempre. Gravar os dois sem recalcular o match deixa a classificação
-- em `indeterminado` apesar de a posição já estar confirmada: a tela diria
-- "não sabemos" sobre um ponto que uma pessoa acabou de apontar no mapa.
-- Via PostgREST são três requisições sem transação; aqui é uma.
create or replace function troca_poste.aplicar_revisao(
  p_desligamento_id uuid,
  p_lat             double precision default null,
  p_lng             double precision default null,
  p_usuario         uuid             default null,
  p_reprovar        boolean          default false
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  v_antes    jsonb;
  v_depois   jsonb;
  v_cidade   uuid;
  v_texto    text;
  v_classif  text;
begin
  select d.cidade_id, d.endereco_raw into v_cidade, v_texto
    from troca_poste.desligamentos d
   where d.id = p_desligamento_id;

  if v_cidade is null then
    raise exception 'desligamento % não encontrado', p_desligamento_id
      using errcode = 'no_data_found';
  end if;

  if not p_reprovar and (p_lat is null or p_lng is null) then
    raise exception 'confirmar exige coordenada' using errcode = 'invalid_parameter_value';
  end if;

  select to_jsonb(g) - 'geom' into v_antes
    from troca_poste.desligamento_geo g
   where g.desligamento_id = p_desligamento_id;

  if p_reprovar then
    -- Reprovar é "não dá para posicionar este endereço". NÃO grava alias e
    -- NÃO inventa coordenada: a linha sai da fila sem virar palpite. A
    -- geometria antiga fica onde está, para auditoria.
    insert into troca_poste.desligamento_geo
      (desligamento_id, validacao, metodo, revisado_por, revisado_em)
    values
      (p_desligamento_id, 'reprovado', 'nao_resolvido', p_usuario, now())
    on conflict (desligamento_id) do update set
      validacao    = 'reprovado',
      revisado_por = p_usuario,
      revisado_em  = now();
  else
    insert into troca_poste.desligamento_geo
      (desligamento_id, geom, metodo, score, validacao,
       revisado_por, revisado_em, evidencias)
    values
      (p_desligamento_id,
       st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
       'manual', 100, 'manual', p_usuario, now(),
       jsonb_build_object('revisao_humana', true))
    on conflict (desligamento_id) do update set
      geom         = st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
      metodo       = 'manual',
      score        = 100,
      validacao    = 'manual',
      revisado_por = p_usuario,
      revisado_em  = now(),
      evidencias   = coalesce(troca_poste.desligamento_geo.evidencias, '{}'::jsonb)
                     || jsonb_build_object('revisao_humana', true);

    -- O alias é o que faz a fila ENCOLHER: na próxima coleta, o mesmo texto
    -- da Celesc nasce resolvido e nem chega a consultar geocodificador
    -- (tem prioridade máxima, ADR-0005). Sem este passo a revisão só
    -- conserta uma linha; com ele, conserta o endereço.
    insert into troca_poste.enderecos_alias
      (cidade_id, texto_celesc, geom, observacao, criado_por)
    values
      (v_cidade, v_texto,
       st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
       'confirmado na fila de revisão', p_usuario)
    on conflict (cidade_id, texto_celesc) do update set
      geom          = excluded.geom,
      observacao    = excluded.observacao,
      criado_por    = excluded.criado_por,
      atualizado_em = now();
  end if;

  -- Agora existe posição confiável (ou a certeza de que não há): o veredito
  -- de rede precisa ser refeito. `calcular_match` respeita `validacao` —
  -- só 'ok' e 'manual' saem de `indeterminado` (migration 19 do monorepo).
  perform troca_poste.calcular_match(p_desligamento_id);

  select a.classificacao into v_classif
    from troca_poste.analise_rede a
   where a.desligamento_id = p_desligamento_id;

  select to_jsonb(g) - 'geom' into v_depois
    from troca_poste.desligamento_geo g
   where g.desligamento_id = p_desligamento_id;

  insert into troca_poste.auditoria
    (usuario_id, acao, entidade, entidade_id, antes, depois)
  values
    (p_usuario, 'geo.revisar', 'desligamento', p_desligamento_id::text,
     v_antes, v_depois);

  return jsonb_build_object(
    'desligamento_id', p_desligamento_id,
    'validacao', case when p_reprovar then 'reprovado' else 'manual' end,
    'classificacao', coalesce(v_classif, 'indeterminado')
  );
end;
$$;

comment on function troca_poste.aplicar_revisao is
  'Revisão humana de endereço: grava a posição (ou reprova), aprende o alias e recalcula o match. Os três são um fato só — ver ADR-0005.';

grant execute on function troca_poste.aplicar_revisao(uuid, double precision, double precision, uuid, boolean)
  to service_role;

-- ---------------------------------------------------------------------
-- (b) `status='ensaio'` nas ordens de serviço.
-- ---------------------------------------------------------------------
--
-- O envio ao WVSA nunca rodou ponta a ponta, e um POST em
-- /relatorios/infra10/save cria OS de verdade e desloca equipe. O ensaio é
-- o clique completo — fila, payload, tudo — parando antes da requisição.
--
-- Por que um estado próprio, e não devolver para 'rascunho': o ensaio
-- precisa aparecer na tabela de OS como o que é ("payload conferido,
-- nenhuma OS criada"). Em 'rascunho' ele fica indistinguível de uma OS que
-- ninguém tentou enviar, e o poll da tela esperaria 90 s por um 'criada'
-- que não vem.
--
-- A trava `os_envio_exige_clique_humano` não é afetada: ela fala de
-- 'enviando' e 'criada', e 'ensaio' não é nenhum dos dois.
do $$
declare v_nome text;
begin
  -- O CHECK original é inline (migration 09 do monorepo), então o nome é
  -- gerado pelo Postgres. Descobrir em vez de adivinhar.
  select con.conname into v_nome
    from pg_constraint con
    join pg_class c     on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'troca_poste'
     and c.relname = 'ordens_servico'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%rascunho%';

  if v_nome is not null then
    execute format('alter table troca_poste.ordens_servico drop constraint %I', v_nome);
  end if;
end $$;

alter table troca_poste.ordens_servico
  add constraint ordens_servico_status_check
  check (status in ('rascunho','pronta','enviando','ensaio','criada','erro','cancelada'));

-- ---------------------------------------------------------------------
-- (c) Um agrupamento por bairro/dia, não um por clique.
-- ---------------------------------------------------------------------
--
-- `criterio='bairro_dia'` está modelado desde a migration 09 e nunca foi
-- gravado: todo agrupamento saía 'manual' com um item só. Agora que a OS é
-- do bairro, dois cliques no mesmo bairro/dia têm que cair no MESMO
-- agrupamento — senão sobra agrupamento órfão toda vez que a OS bate no
-- unique de `chave_idempotencia`.
--
-- `coalesce(bairro_norm,'')` em vez de `nulls not distinct`: desligamento
-- sem bairro existe, e com NULL cru o unique não pegaria nenhum deles.
create unique index if not exists agrupamentos_bairro_dia_uk
  on troca_poste.agrupamentos (cidade_id, coalesce(bairro_norm, ''), data_evento)
  where criterio = 'bairro_dia';

-- ---------------------------------------------------------------------
-- (d) Abrir a OS do bairro/dia — validação, agrupamento e ordem, de uma vez.
-- ---------------------------------------------------------------------
--
-- Por que isto é uma função e não três chamadas do Flask:
--
-- 1. **A chave do grupo tem que sair do banco.** O agrupamento é por
--    `normalizar_texto(bairro)` — o bairro LIMPO. A coluna
--    `desligamentos.bairro_norm` NÃO serve: ela é gerada de `bairro_raw`,
--    que vem com o código da cidade grudado ("CALHEIROS - GCR"). E
--    reimplementar `normalizar_texto` em Python cria duas definições da
--    mesma regra: quando divergirem, o grupo perde trecho sem erro na tela
--    — a mesma armadilha do `APELIDOS_EMPRESA` (CLAUDE.md §6).
-- 2. **Sem transação sobra lixo.** Agrupamento criado + OS recusada pelo
--    unique de `chave_idempotencia` deixa agrupamento órfão a cada clique.
-- 3. **O cliente manda ids; o servidor não confia neles.** Aqui se prova
--    que os ids são mesmo do mesmo bairro, mesma cidade e mesmo dia.
--
-- Reabrir o mesmo bairro/dia devolve a OS que já existe (`ja_existia`), em
-- vez de estourar: dois operadores olhando a mesma tela é o caso normal, e
-- OS duplicada no WVSA desloca equipe duas vezes.
create or replace function troca_poste.criar_os_bairro_dia(
  p_desligamento_ids uuid[],
  p_usuario          uuid,
  p_solicitacao      text,
  p_executor         text,
  p_periodo          text    default null,
  p_tipo_tecnico     text    default null,
  p_agendamento      text    default null,
  p_dry_run          boolean default true
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  v_n           integer;
  v_cidade      uuid;
  v_bairro_norm text;
  v_data        date;
  v_ibge        integer;
  v_bairro_wvsa text;
  v_agrup       uuid;
  v_chave       text;
  v_ordem       troca_poste.ordens_servico%rowtype;
  v_qt_cidades  bigint;
  v_qt_bairros  bigint;
  v_qt_datas    bigint;
begin
  if p_desligamento_ids is null or array_length(p_desligamento_ids, 1) is null then
    raise exception 'nenhum desligamento informado' using errcode = 'invalid_parameter_value';
  end if;

  -- Um grupo só. `count(distinct ...)` acusa ids de bairros ou dias
  -- diferentes chegando juntos — que seria uma OS mentindo sobre onde a
  -- equipe precisa estar.
  select count(*),
         min(troca_poste.normalizar_texto(d.bairro)),
         min(d.data_evento),
         count(distinct d.cidade_id),
         count(distinct coalesce(troca_poste.normalizar_texto(d.bairro), '')),
         count(distinct d.data_evento)
    into v_n, v_bairro_norm, v_data,
         v_qt_cidades, v_qt_bairros, v_qt_datas
    from troca_poste.desligamentos d
   where d.id = any(p_desligamento_ids);

  -- `min(uuid)` não é agregado universal; e não precisa ser, porque logo
  -- abaixo se prova que há uma cidade só.
  select d.cidade_id into v_cidade
    from troca_poste.desligamentos d
   where d.id = any(p_desligamento_ids)
   limit 1;

  -- Menos linhas que ids significa id inexistente no meio. Seguir daria uma
  -- OS com menos trechos do que o operador viu na tela.
  if v_n <> array_length(p_desligamento_ids, 1) then
    raise exception 'desligamento não encontrado' using errcode = 'no_data_found';
  end if;
  if v_qt_cidades > 1 or v_qt_bairros > 1 or v_qt_datas > 1 then
    raise exception 'os desligamentos não são do mesmo bairro, cidade e dia'
      using errcode = 'invalid_parameter_value';
  end if;

  select c.ibge_codigo into v_ibge
    from troca_poste.cidades c where c.id = v_cidade;

  -- Qualquer um dos trechos serve: o id do bairro no WVSA é do bairro, e o
  -- grupo é de um bairro só. `min` só torna a escolha determinística.
  select min(d.bairro_wvsa_id) into v_bairro_wvsa
    from troca_poste.desligamentos d
   where d.id = any(p_desligamento_ids) and d.bairro_wvsa_id is not null;

  -- Encontra ou cria. O índice parcial agrupamentos_bairro_dia_uk garante
  -- que dois cliques simultâneos não criem dois agrupamentos.
  select a.id into v_agrup
    from troca_poste.agrupamentos a
   where a.criterio = 'bairro_dia'
     and a.cidade_id = v_cidade
     and coalesce(a.bairro_norm, '') = coalesce(v_bairro_norm, '')
     and a.data_evento = v_data;

  if v_agrup is null then
    insert into troca_poste.agrupamentos
      (cidade_id, bairro_norm, data_evento, criterio, rotulo, criado_por)
    values
      (v_cidade, v_bairro_norm, v_data, 'bairro_dia',
       coalesce(v_bairro_norm, 'SEM BAIRRO') || ' — ' || to_char(v_data, 'DD/MM/YYYY'),
       p_usuario)
    returning id into v_agrup;
  end if;

  insert into troca_poste.agrupamento_itens (agrupamento_id, desligamento_id)
  select v_agrup, unnest(p_desligamento_ids)
  on conflict do nothing;

  -- A chave é do BAIRRO/DIA, não do agrupamento. Antes ela nascia de um
  -- `agrupamento_id` recém-gerado a cada clique e por isso nunca colidia:
  -- a proteção contra duplicata existia no papel e valia zero.
  v_chave := 'os:bairro_dia:' || v_cidade || ':' || coalesce(v_bairro_norm, '') || ':' || v_data;

  select * into v_ordem
    from troca_poste.ordens_servico o
   where o.chave_idempotencia = v_chave;

  if found then
    return jsonb_build_object(
      'ordem_id', v_ordem.id, 'status', v_ordem.status, 'chave', v_chave,
      'agrupamento_id', v_agrup, 'trechos', v_n, 'ja_existia', true);
  end if;

  insert into troca_poste.ordens_servico
    (agrupamento_id, chave_idempotencia, finalidade, cid_codigo, bairro_id,
     tipo_tecnico, agendamento, categoria_interna, agendar_os,
     data_inicio, data_fim, periodo, executor, solicitacao,
     status, origem, dry_run, criado_por)
  values
    (v_agrup, v_chave, 'POST', v_ibge, coalesce(v_bairro_wvsa, ''),
     p_tipo_tecnico, p_agendamento, 'N', 'N',
     v_data, v_data, p_periodo, p_executor, p_solicitacao,
     'rascunho', 'sistema', p_dry_run, p_usuario)
  returning * into v_ordem;

  return jsonb_build_object(
    'ordem_id', v_ordem.id, 'status', v_ordem.status, 'chave', v_chave,
    'agrupamento_id', v_agrup, 'trechos', v_n, 'ja_existia', false);
end;
$$;

comment on function troca_poste.criar_os_bairro_dia is
  'Abre o rascunho da OS de um bairro/dia: valida o grupo, encontra ou cria o agrupamento bairro_dia e grava a ordem. Não envia nada.';

grant execute on function troca_poste.criar_os_bairro_dia(uuid[], uuid, text, text, text, text, text, boolean)
  to service_role;
