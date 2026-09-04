-- =====================================================================
-- Troca de Poste: a OS passa a levar equipe e os campos do formulário.
-- Rode no Supabase: SQL Editor -> Run.
-- =====================================================================
--
-- Até aqui toda OS saía com `executor='infra'` cravado no JS e os outros
-- quatro campos "de painel" vazios: tipo de técnico, TÉCNICOS, período e
-- agendamento. O contrato do WVSA (docs/contratos/wvsa.md §3.1) marca esses
-- campos como escolha do painel — só que painel nenhum os oferecia.
--
-- `agendamento` continua fora, e é decisão: medido em 04/09/2026, o select tem
-- 23 slots cobrindo apenas 04, 05 e 08/09, e muda ao longo do dia. A OS de
-- troca de poste é aberta para a data do desligamento, normalmente semanas à
-- frente — o slot ainda não existe. Campo opcional no WVSA; quem quiser
-- encaixar numa agenda faz isso lá, onde a lista está viva. O parâmetro segue
-- existindo para quando houver um caso.
--
-- `drop` + `create` em vez de `create or replace`: acrescentar parâmetro muda
-- a assinatura e o `replace` criaria uma SOBRECARGA. Com duas versões vivas o
-- PostgREST escolhe pela forma do JSON, e um dia a chamada cairia calada na
-- versão velha — que ignora os técnicos.
drop function if exists troca_poste.criar_os_bairro_dia(
  uuid[], uuid, text, text, text, text, text, boolean);

-- O nome do bairro viaja com a ordem para o coletor poder resolver o
-- `bairro_wvsa_id` por autocomplete no momento do envio. `bairro_norm` do
-- agrupamento não serve: é MAIÚSCULO e sem acento, e o autocomplete do WVSA
-- casa contra o texto como as pessoas escrevem. E `bairro_wvsa_id` continua
-- NULL em todos os 515 desligamentos — nada no pipeline o preenche —, então
-- sem isto o campo Bairro da OS ia vazio para sempre.
alter table troca_poste.ordens_servico
  add column if not exists bairro_nome text;

comment on column troca_poste.ordens_servico.bairro_nome is
  'Nome do bairro como a Celesc escreve. Só para o coletor resolver o id no autocomplete do WVSA; não vai no payload.';

create or replace function troca_poste.criar_os_bairro_dia(
  p_desligamento_ids uuid[],
  p_usuario          uuid,
  p_solicitacao      text,
  p_executor         text,
  p_periodo          text    default null,
  p_tipo_tecnico     text    default null,
  p_agendamento      text    default null,
  p_tecnico_ids      text[]  default null,
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
  v_tecnicos    text[];
  v_bairro_nome text;
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

  select min(d.bairro) into v_bairro_nome
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
  -- Array vazio e NULL viram a mesma coisa: "sem equipe designada". O
  -- formulário do WVSA aceita `tecnico_id[]` vazio, e mandar `{}` ou nada dá
  -- no mesmo lá — mas na tabela um deles mentiria dizendo que houve escolha.
  v_tecnicos := nullif(p_tecnico_ids, '{}');

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
     tipo_tecnico, tecnico_ids, agendamento, categoria_interna, agendar_os,
     bairro_nome,
     data_inicio, data_fim, periodo, executor, solicitacao,
     status, origem, dry_run, criado_por)
  values
    (v_agrup, v_chave, 'POST', v_ibge, coalesce(v_bairro_wvsa, ''),
     p_tipo_tecnico, v_tecnicos, p_agendamento, 'N', 'N',
     v_bairro_nome,
     v_data, v_data, p_periodo, p_executor, p_solicitacao,
     'rascunho', 'sistema', p_dry_run, p_usuario)
  returning * into v_ordem;

  return jsonb_build_object(
    'ordem_id', v_ordem.id, 'status', v_ordem.status, 'chave', v_chave,
    'agrupamento_id', v_agrup, 'trechos', v_n, 'ja_existia', false);
end;
$$;

comment on function troca_poste.criar_os_bairro_dia is
  'Abre o rascunho da OS de um bairro/dia: valida o grupo, encontra ou cria o agrupamento bairro_dia e grava a ordem com executor, tipo de técnico, técnicos e período. Não envia nada.';

grant execute on function troca_poste.criar_os_bairro_dia(uuid[], uuid, text, text, text, text, text, text[], boolean)
  to service_role;
