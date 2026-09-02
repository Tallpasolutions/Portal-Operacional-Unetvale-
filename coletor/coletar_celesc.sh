#!/bin/bash
# =====================================================================
# Coleta da Celesc (módulo Troca de Poste), agendada pelo LaunchAgent
# `net.unetvale.troca-poste.plist`.
#
# Por que este script mora aqui e chama outro repositório: quem coleta os
# desligamentos da Celesc é o job `tp:coletar` do monorepo
# ~/Documents/Dashboard Operacional. Ele funciona e é a ÚNICA fonte do schema
# `troca_poste` — mas nunca teve agendamento (o `CRON_COLETA_CELESC` existe no
# config.ts do monorepo e nunca foi ligado a nada). Resultado: entre a carga
# manual de 26/08/2026 e 31/08/2026 a Troca de Poste ficou parada, exibindo
# badge verde no /monitoramento.
#
# O agendamento fica documentado aqui, junto do coletor do WVSA, porque é aqui
# que se procura por ele.
#
# Este agendamento é SEPARADO do watcher do WVSA de propósito: o site da Celesc
# (avisodesligamento.celesc.com.br) é público, então esta coleta funciona fora
# da VPN — amarrá-la ao watcher a faria parar junto toda vez que a rede da
# Unetvale caísse, sem necessidade nenhuma.
# =====================================================================
set -uo pipefail

# O launchd dispara o job num DARK WAKE e a maquina volta a dormir logo depois.
# Sem segurar uma assercao de energia, a rodada anda so nas frestas de 2-6 s de
# dark wake: em 02/09/2026 o job das 07h comecou as 07:06:57, o Mac voltou a
# dormir as 07:06:59, e 58 min de relogio produziram QUATRO linhas de log antes
# de morrer com `read EADDRNOTAVAIL` — a interface de rede some no sleep e o
# socket nao consegue nem fazer bind ao acordar.
#
# `caffeinate` envolve o script INTEIRO (por isso o re-exec, e nao um caffeinate
# por etapa): o cao de guarda tambem precisa de tempo correndo. `-i` impede o
# idle sleep na bateria, `-s` o system sleep na tomada, `-m` o disk sleep.
# A guarda evita recursao infinita se o exec falhar.
if [ -z "${CELESC_ACORDADO:-}" ]; then
  export CELESC_ACORDADO=1
  # `/bin/bash "$0"` explicito, e nao `"$0"` sozinho: o caffeinate faz execvp e
  # dependeria do bit de execucao do arquivo. O plist tambem chama
  # `/bin/bash <script>` — uma copia sem o bit falharia com "No such file or
  # directory", que e a mensagem menos util possivel para o que de fato houve.
  exec /usr/bin/caffeinate -ims /bin/bash "$0" "$@"
fi

# Limite por etapa, em segundos. NAO e paranoia: o launchd nao comeca uma
# segunda copia de um job que ainda esta rodando, entao uma etapa travada nao
# atrasa a rodada — ela CANCELA todas as seguintes, e sem erro em lugar nenhum.
#
# Foi exatamente o que aconteceu em 31/08/2026: o `tp:coletar` das 13h terminou
# o trabalho as 13:03 (o log tem o "coleta_concluida") e o processo node ficou
# vivo, sem fazer nada, por mais de 20 horas. Com ele de pe, a coleta das 07h
# do dia 01/09 simplesmente nao rodou, e o /monitoramento seguiu verde porque
# o limiar de la e 26 h.
#
# A rodada inteira leva ~4 min. 20 min por etapa e folga larga e continua bem
# abaixo das 6 h entre 07h e 13h.
LIMITE_ETAPA=${LIMITE_ETAPA:-1200}

# Cada etapa em seu proprio grupo de processo. Sem isto o cao de guarda mataria
# so o `pnpm`, e o `tsx`/`node` filho — que e justamente quem trava — ficaria
# vivo segurando o job do mesmo jeito.
set -m

# O launchd roda com PATH=/usr/bin:/bin:/usr/sbin:/sbin. Sem isto, `pnpm` sai
# com "command not found" e o job nunca roda — falha silenciosa clássica.
export PATH="/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO="$HOME/Documents/Dashboard Operacional"
LOG="$HOME/unetvale-coletor/celesc.log"

carimbo() { date "+[%d/%m %H:%M:%S]"; }
registrar() { echo "$(carimbo) $*" >> "$LOG"; }

mkdir -p "$(dirname "$LOG")"

if [ ! -d "$REPO" ]; then
  registrar "ABORTADO: repositório não encontrado em $REPO"
  exit 1
fi
cd "$REPO" || exit 1

registrar "coleta da Celesc iniciada"
falhas=0

# A ordem importa e é a cadeia mínima para um desligamento novo chegar ao mapa:
#   coletar      -> traz os avisos da Celesc para troca_poste.coletas/desligamentos
#   geocodificar -> resolve o endereço em coordenada (sem isto o ponto não existe)
#   match        -> cruza com a rede e classifica o risco
# `sync-rede` (espelho da malha) fica de fora: é semanal e pesado, e no monorepo
# tem cron próprio (CRON_SYNC_REDE, domingo 03h). Continua manual por ora.
# Roda uma etapa com prazo. Devolve o codigo dela; >= 128 quer dizer que foi
# derrubada por sinal, que aqui e sempre o cao de guarda.
executar_com_limite() {
  pnpm --filter @portal/api "$1" >> "$LOG" 2>&1 &
  local pid=$!
  # O prazo e por RELOGIO DE PAREDE, nao por `sleep "$LIMITE_ETAPA"`: `sleep`
  # nao anda enquanto a maquina dorme. Em 02/09/2026 a etapa arrastou 58 min e
  # o cao, que dormia junto, nunca latiu — o log saiu "FALHOU (codigo 1)", nunca
  # "DERRUBADO". Cochilos de 30 s deixam o cao no maximo 30 s atrasado ao
  # acordar, e ai a rodada morre com diagnostico em vez de arrastar por horas.
  local prazo=$(( $(date +%s) + LIMITE_ETAPA ))
  ( while [ "$(date +%s)" -lt "$prazo" ]; do sleep 30; done
    kill -TERM -"$pid" 2>/dev/null
    sleep 10
    kill -KILL -"$pid" 2>/dev/null ) &
  local cao=$!
  local st=0
  wait "$pid" || st=$?
  kill "$cao" 2>/dev/null   # terminou dentro do prazo: o cao nao late
  wait "$cao" 2>/dev/null
  return "$st"
}

for etapa in tp:coletar tp:geocodificar tp:match; do
  registrar "-> $etapa"
  st=0
  executar_com_limite "$etapa" || st=$?
  if [ "$st" -eq 0 ]; then
    # O `tp:coletar` sai com 0 mesmo quando TODAS as cidades falham: ele trata
    # a falha por cidade e segue. Em 01/09/2026, 12:32 UTC, as 11 cidades
    # deram "fetch failed" e a rodada registrou "coleta da Celesc concluída"
    # com total 0 — sucesso na cara de quem lesse o log. Aqui o desfecho da
    # coleta é conferido pelo que ela própria gravou.
    if [ "$etapa" = "tp:coletar" ]; then
      total=$(grep '"msg":"coleta_concluida"' "$LOG" | tail -1 |
              sed -n 's/.*"total":\([0-9]*\).*/\1/p')
      if [ "${total:-0}" -eq 0 ]; then
        registrar "   $etapa VOLTOU VAZIO (0 desligamentos) — a Celesc não respondeu"
        falhas=$((falhas + 1))
        break
      fi
      registrar "   $etapa ok ($total desligamentos)"
      continue
    fi
    registrar "   $etapa ok"
    continue
  fi
  if [ "$st" -ge 128 ]; then
    registrar "   $etapa DERRUBADO apos $((LIMITE_ETAPA / 60)) min sem terminar (sinal $((st - 128)))"
  else
    registrar "   $etapa FALHOU (código $st)"
  fi
  falhas=$((falhas + 1))
  # Não segue adiante: geocodificar sem ter coletado, ou casar sem ter
  # geocodificado, só produz uma rodada vazia que parece sucesso.
  break
done

if [ "$falhas" -eq 0 ]; then
  registrar "coleta da Celesc concluída"
else
  registrar "coleta da Celesc terminou COM FALHA"
fi
exit "$falhas"
