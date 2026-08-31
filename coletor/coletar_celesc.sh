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
for etapa in tp:coletar tp:geocodificar tp:match; do
  registrar "-> $etapa"
  if pnpm --filter @portal/api "$etapa" >> "$LOG" 2>&1; then
    registrar "   $etapa ok"
  else
    registrar "   $etapa FALHOU (código $?)"
    falhas=$((falhas + 1))
    # Não segue adiante: geocodificar sem ter coletado, ou casar sem ter
    # geocodificado, só produz uma rodada vazia que parece sucesso.
    break
  fi
done

if [ "$falhas" -eq 0 ]; then
  registrar "coleta da Celesc concluída"
else
  registrar "coleta da Celesc terminou COM FALHA"
fi
exit "$falhas"
