-- =====================================================================
-- Quais módulos cada usuário NÃO vê. Rode no Supabase: SQL Editor -> Run.
-- Aditiva: só cria.
-- =====================================================================
--
-- Até aqui a visibilidade de módulo era código: `ve_troca_poste` em
-- `auth.usuario_atual()` valia `not eh_supervisor or eh_admin`, e mudar quem
-- vê o quê exigia deploy. Os outros cinco módulos não tinham controle nenhum —
-- quem entrava via tudo.
--
-- ⚠️ A LINHA SIGNIFICA BLOQUEIO, não liberação. É contraintuitivo à primeira
-- leitura e foi decidido assim porque o padrão combinado é "vê tudo até ser
-- configurado": com linhas de liberação, os 12 usuários de hoje perderiam o
-- portal no instante do deploy, e usuário novo nasceria cego. Guardando o que
-- foi TIRADO, ausência de configuração é exatamente o comportamento de sempre,
-- e a migration não precisa semear nada.
--
-- O nome da tabela diz "bloqueados" de propósito: `usuario_modulos` seria lido
-- como "os módulos do usuário" em toda query futura, e a inversão passaria
-- despercebida até alguém liberar sem querer o que quis tirar.
create table if not exists public.usuario_modulos_bloqueados (
  usuario_id  uuid not null references public.usuarios(id) on delete cascade,
  modulo      text not null,
  bloqueado_por uuid references public.usuarios(id),
  criado_em   timestamptz not null default now(),
  primary key (usuario_id, modulo)
);

comment on table public.usuario_modulos_bloqueados is
  'Módulos ESCONDIDOS de um usuário. Sem linha = vê. O admin nunca é afetado.';
comment on column public.usuario_modulos_bloqueados.modulo is
  'Chave do módulo: dashboard, produtividade, iqi, massivas, troca-poste, acoes. Sem FK porque a lista vive no código (auth.MODULOS) — tabela de domínio para seis valores estáveis seria cerimônia sem ganho.';

create index if not exists usuario_modulos_bloq_idx
  on public.usuario_modulos_bloqueados (usuario_id);
