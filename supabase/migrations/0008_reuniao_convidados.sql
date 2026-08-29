-- =====================================================================
-- Convidados na reunião — gente que participou e não tem conta.
-- Rode no Supabase: SQL Editor -> cole -> Run.
--
-- `reuniao_participantes` continua sendo só quem tem login: é dela que sai
-- a pauta, e pauta exige ação, que exige usuário. Convidado não tem ação,
-- não recebe encaminhamento e não abre a reunião — só precisa aparecer na
-- lista de quem estava e na ata.
--
-- Por isso uma coluna de texto na própria reunião, e não linha naquela
-- tabela: para caber lá seria preciso tornar `usuario_id` anulável e mexer
-- na chave primária de uma tabela com dado de produção. Caro, e por nada.
--
-- Aditiva: `add column if not exists`.
-- =====================================================================
alter table public.reunioes
  add column if not exists convidados text[] not null default '{}';
