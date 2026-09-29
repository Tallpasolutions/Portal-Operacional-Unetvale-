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

LOG="$HOME/unetvale-coletor/celesc.log"
# Carimbo (epoch) da última rodada que terminou INTEIRA. É ele, e não o
# relógio, que decide se há coleta a fazer.
ULTIMA_OK="$HOME/unetvale-coletor/celesc.ultima_ok"
HORARIOS="7 13"

carimbo() { date "+[%d/%m %H:%M:%S]"; }
registrar() { echo "$(carimbo) $*" >> "$LOG"; }
# O agendamento tenta a cada 15 min e a maioria das tentativas é adiada:
# registrar a mesma linha a cada dark wake enterraria o log. Só escreve se
# a última linha não for o mesmo aviso.
registrar_uma_vez() {
  tail -1 "$LOG" 2>/dev/null | grep -qF -- "$*" || registrar "$*"
}

# ---------------------------------------------------------------------
# Horário fixo NÃO serve para esta máquina, e isso foi medido.
#
# Até 29/09/2026 o plist disparava às 07h e 13h. De 15/09 a 29/09 a rodada
# das 07h falhou TODOS os dias, e a das 13h de 27 e 28/09 também: três dias
# sem dado novo na Troca de Poste. O `pmset -g log` mostra o porquê — nos
# horários o Mac estava na bateria com a tampa fechada. O launchd dispara num
# dark wake, o `caffeinate` cria a asserção e o macOS dorme assim mesmo (é a
# ressalva do CLAUDE.md §6). Saía `getaddrinfo ENOTFOUND` do pooler do
# Supabase 1 s depois de começar — a rede nem tinha voltado —, ou a rodada
# andava aos pedaços e morria com `Connection terminated`. E o horário
# perdido estava perdido: a próxima chance era 6 h depois.
#
# Agora o launchd chama a cada 15 min (StartInterval) e o script decide:
#   1. já saiu a rodada do último horário da grade? então não há o que fazer;
#   2. tampa fechada na bateria? o Mac vai dormir no meio — adia;
#   3. sem rota até a Celesc e o banco? adia.
# O horário da grade vira "a partir de": se às 07h a máquina está fechada, a
# coleta sai no primeiro tique depois que alguém abre a tampa.
#
# `CELESC_FORCAR=1` pula as três conferências (rodar na mão, para teste).
# ---------------------------------------------------------------------
if [ -z "${CELESC_ACORDADO:-}" ] && [ -z "${CELESC_FORCAR:-}" ]; then
  agora=$(date +%s)
  # Último horário da grade que já passou. Antes do primeiro do dia, vale o
  # último de ONTEM — é o que a madrugada fechada deixou pendente.
  devido=0
  for h in $HORARIOS; do
    t=$(date -j -f "%Y-%m-%d %H:%M:%S" "$(date +%Y-%m-%d) $(printf %02d "$h"):00:00" +%s)
    [ "$t" -le "$agora" ] && devido=$t
  done
  if [ "$devido" -eq 0 ]; then
    ultimo=$(echo $HORARIOS | awk '{print $NF}')
    devido=$(( $(date -j -f "%Y-%m-%d %H:%M:%S" "$(date +%Y-%m-%d) $(printf %02d "$ultimo"):00:00" +%s) - 86400 ))
  fi
  feito=$(cat "$ULTIMA_OK" 2>/dev/null || echo 0)
  # Em dia: sai calado. É o caso de quase todo tique.
  [ "${feito:-0}" -ge "$devido" ] && exit 0

  # Tampa fechada com carregador e monitor externo é o modo "clamshell" e
  # fica acordado de verdade; na bateria, não há asserção que segure.
  if ioreg -r -k AppleClamshellState -d 4 2>/dev/null | grep -q '"AppleClamshellState" = Yes' &&
     pmset -g batt 2>/dev/null | head -1 | grep -q "Battery Power"; then
    registrar_uma_vez "coleta adiada: tampa fechada na bateria (o Mac dormiria no meio)"
    exit 0
  fi

  # Rede de pé para as DUAS pontas. Sem o banco a rodada morre no primeiro
  # INSERT; sem a Celesc ela "conclui" com as cidades falhando.
  if ! /usr/bin/nc -z -G 5 aws-1-us-west-2.pooler.supabase.com 5432 >/dev/null 2>&1 ||
     ! /usr/bin/curl -s -o /dev/null -m 15 https://avisodesligamento.celesc.com.br/; then
    registrar_uma_vez "coleta adiada: sem rota até a Celesc ou o banco"
    exit 0
  fi
fi

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
# A rodada inteira leva ~4 min. 20 min por etapa e folga larga; o tique de
# 15 min que cair com ela rodando simplesmente nao comeca (o launchd nao
# sobrepoe), e o seguinte encontra o carimbo em dia.
LIMITE_ETAPA=${LIMITE_ETAPA:-1200}

# Quantos endereços a geocodificação resolve por rodada. O padrão do job é 25,
# e com ele a fila NUNCA zerava: a Celesc publica de 30 a 100 avisos novos por
# dia, e só rodada que dá certo geocodifica. Em 29/09/2026 havia 389 na fila e
# nenhum dos 305 desligamentos da tela tinha posição — todos "indeterminado".
# A ~3 s por endereço (medido: 25 em 76 s), 150 cabem em ~8 min, bem dentro
# do LIMITE_ETAPA. Endereço repetido sai do cache e custa menos.
GEO_LIMITE=${GEO_LIMITE:-150}

# Teto de células do Geogrid por rodada. São 3 chamadas por célula com 1,5 s
# de intervalo (GEOGRID_RATE_LIMIT_MS): ~4,5 s cada, 150 em ~11 min. Sobra
# para o dia em que a Celesc publica muito de uma vez; o que não couber sai
# na rodada seguinte, e o que fica para trás é o mais distante no calendário.
SYNC_LIMITE=${SYNC_LIMITE:-150}

# Cada etapa em seu proprio grupo de processo. Sem isto o cao de guarda mataria
# so o `pnpm`, e o `tsx`/`node` filho — que e justamente quem trava — ficaria
# vivo segurando o job do mesmo jeito.
set -m

# O launchd roda com PATH=/usr/bin:/bin:/usr/sbin:/sbin. Sem isto, `pnpm` sai
# com "command not found" e o job nunca roda — falha silenciosa clássica.
export PATH="/opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO="$HOME/Documents/Dashboard Operacional"

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
#   sync-rede    -> baixa do Geogrid a rede em volta dos pontos de hoje em diante
#   match        -> cruza com a rede e classifica o risco
#
# `sync-rede` entrou em 29/09/2026. Era manual e rodou UMA vez (27/08): um mês
# depois, as 142 células ainda valiam como cobertas e cabo novo não existia
# para o match. Agora a cobertura expira em 7 dias (migration 20 do monorepo),
# e é esta etapa que a mantém em dia. Ela só varre células de desligamento
# futuro, as mais próximas primeiro (~80 células, ~6 min por dia); a mesma
# célula não é refeita antes de 24 h, então a rodada das 13h quase não paga.
#
# Coletar é a única etapa DURA. Geocodificar e sincronizar dependem de
# serviços externos (três geocodificadores, Geogrid) e a falha delas não pode
# travar o match: em 29/09/2026 a rede caiu no endereço 213 de 320, o match
# não rodou, e 213 posições novas ficaram sem classificação até a rodada
# seguinte. O que já foi gravado vale — o match roda, a rodada sai COM FALHA,
# o carimbo não é gravado e o próximo tique tenta de novo.
# Roda uma etapa com prazo. Devolve o codigo dela; >= 128 quer dizer que foi
# derrubada por sinal, que aqui e sempre o cao de guarda.
executar_com_limite() {
  pnpm --filter @portal/api "$@" >> "$LOG" 2>&1 &
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

for etapa in tp:coletar tp:geocodificar tp:sync-rede tp:match; do
  registrar "-> $etapa"
  st=0
  args=("$etapa")
  [ "$etapa" = "tp:geocodificar" ] && args+=("$GEO_LIMITE")
  [ "$etapa" = "tp:sync-rede" ] && args+=("$SYNC_LIMITE")
  executar_com_limite "${args[@]}" || st=$?
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
  # Coleta que falhou para a rodada: não há o que geocodificar nem casar, e
  # seguir só produziria uma rodada vazia com cara de sucesso. As outras
  # etapas seguem (ver o comentário da ordem, acima).
  [ "$etapa" = "tp:coletar" ] && break
done

if [ "$falhas" -eq 0 ]; then
  # Só a rodada INTEIRA (as quatro etapas) conta como feita.
  # Falhou no meio? O carimbo fica velho e o próximo tique tenta de novo.
  date +%s > "$ULTIMA_OK"
  registrar "coleta da Celesc concluída"
else
  registrar "coleta da Celesc terminou COM FALHA"
fi
exit "$falhas"
