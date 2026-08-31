-- =====================================================================
-- Sinal de vida do coletor. Rode no Supabase: SQL Editor -> Run.
-- Aditiva: só cria.
-- =====================================================================

-- Por que existe: a coleta roda num Mac, atrás da VPN. Quando esse Mac está
-- desligado (fim de semana, madrugada) ou sem rota até o WVSA, nada acontece —
-- e o portal não tinha como saber a diferença entre "o coletor está parado" e
-- "o coletor está de pé e o dado é que não chegou". Em 29/08/2026 o dado ficou
-- 37 h velho por isso, e a tela de Monitoramento só sabia dizer
-- "Desatualizado", sem causa.
--
-- Uma linha só, propositalmente: isto é ESTADO ATUAL, não histórico. O
-- histórico de execuções já é `coletor_log`, e misturar um pulso de 2 em 2
-- minutos lá dentro afogaria as linhas que interessam. O `check (id = 1)`
-- impede que um coletor duplicado (uma segunda máquina, um teste) crie uma
-- segunda linha e faça a tela mostrar o pulso do processo errado.
create table if not exists public.coletor_heartbeat (
  id       int primary key default 1 check (id = 1),
  visto_em timestamptz not null default now(),
  -- Resultado do mesmo teste que o watcher já faz para decidir se roda. Serve
  -- para a tela separar "coletor mudo" de "coletor de pé, mas fora da rede".
  wvsa_ok  boolean not null default false
);

insert into public.coletor_heartbeat (id, visto_em, wvsa_ok)
  values (1, now(), false)
  on conflict (id) do nothing;
