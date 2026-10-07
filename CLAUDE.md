# Portal Operacional Unetvale — guia do projeto

Leia isto antes de mexer em qualquer coisa. O objetivo deste arquivo é que você
acerte de primeira, sem redescobrir na tentativa e erro o que já custou caro.

> **Mantenha este arquivo vivo.** Toda implementação que mudar arquitetura,
> convenção, esquema do banco ou alguma das armadilhas abaixo deve atualizar a
> seção correspondente **no mesmo commit**. Documentação que descreve o projeto
> de duas semanas atrás é pior que nenhuma: ela é confiada.

---

## 1. Antes de tudo: existem DOIS projetos parecidos

| Caminho | O que é | Está em produção? |
|---|---|---|
| `~/Documents/Portal-Operacional-Unetvale` | **Este.** Flask + Jinja2, na Vercel | ✅ **sim** — `unetvale.tallpa.com.br` |
| `~/Documents/Dashboard Operacional` | Monorepo Next.js/Express/Prisma, reescrita que ficou pelo caminho | ❌ não |

Os dois falam com o **mesmo** projeto Supabase (`aorlhtnionfcpqrpmtsr`). Se o
pedido for sobre o portal que a equipe usa, é **aqui**. Nunca migre código para
o monorepo sem o usuário pedir explicitamente.

---

## 2. Arquitetura

```
WVSA (10.170.74.79, só na VPN/rede Unetvale)
   │  scraping HTML
   ▼
Coletor  (coletor/, roda em ~/unetvale-coletor via launchd, 08/10/12/14/16/18h)
   │  upsert
   ▼
Supabase (Postgres)  ◄──── escrita direta do app (Ações, Troca de Poste)
   │  leitura (PostgREST)
   ▼
App Flask (app/ + api/) na Vercel
```

**O app NUNCA fala com o WVSA.** A Vercel não alcança um IP privado. Qualquer
coisa que precise do WVSA vive em `coletor/` e roda na máquina do Jhoni.

### A Troca de Poste tem OUTRO pipeline, em OUTRO repositório

O diagrama acima cobre o WVSA. O schema `troca_poste` é alimentado por um
segundo caminho, que **não** está neste repositório:

```
Celesc (avisodesligamento.celesc.com.br — site PÚBLICO, não precisa de VPN)
   │  ~/Documents/Dashboard Operacional  →  apps/api/src/jobs/troca-poste/
   │  pnpm --filter @portal/api  tp:coletar → tp:geocodificar → tp:match
   ▼
Supabase, schema troca_poste  →  o app só LÊ
```

Sim: é o monorepo que "ficou pelo caminho" (§1). Ele não está em produção como
aplicação, **mas é a única fonte da Troca de Poste** — não o desative nem o
mova sem substituir esse job.

O agendamento mora aqui, em `coletor/net.unetvale.troca-poste.plist` +
`coletor/coletar_celesc.sh` (grade 07h e 13h, conferida a cada 15 min — §6).
É um LaunchAgent **separado** do
`com.unetvale.coletor` de propósito: a Celesc é pública, então esta coleta não
tem por que parar quando a rede da Unetvale cai.

`sync-rede` (espelho do Geogrid) **entrou na rodada** em 29/09/2026, entre
geocodificar e match — só as células de desligamento de hoje em diante, as de
data mais próxima primeiro (§6). A varredura do passado segue manual:
`pnpm --filter @portal/api tp:sync-rede 500 --com-passado`.

### Dois tipos de módulo, e a diferença importa

| Tipo | Módulos | Se o dado sumir |
|---|---|---|
| **Espelho** do WVSA | Produtividade, IQI/IQM, Massivas | recoleta-se |
| **Dado nasce aqui** | **Ações**, Troca de Poste (OS/revisão) | **não há de onde recoletar** |

Nos módulos do segundo tipo: histórico append-only, recorte de permissão no
servidor, e cuidado redobrado com migration destrutiva.

---

## 3. Pilha

- **Flask 3.0.3** + Jinja2 + `requests` + `python-dotenv`. Sem ORM.
- **Supabase via PostgREST**, encapsulado em `app/supa.py`. Usa a chave
  `service_role`, que **ignora RLS** — a autorização é toda do Flask.
  Atenção: `select`, `select_one`, `insert`, `update`, `upsert` e `rpc` aceitam
  `schema=`; **`delete` não** — só funciona no `public`. Precisa apagar em
  `troca_poste`? Acrescente o parâmetro lá (o PostgREST endereça schema pelos
  cabeçalhos `Accept-Profile`/`Content-Profile`, já tratados em `_headers`).
  `supa.rpc()` chama função no Postgres: é como se faz o que precisa ser
  **atômico**, já que não há transação entre requisições do PostgREST.
  Toda ida passa por `_pedir`: **sessão HTTP persistente** (a conexão fica
  aberta entre consultas) e contagem para o `Server-Timing`. Consultas
  independentes vão juntas com **`supa.paralelo(f1, f2, …)`**, que preserva o
  `flask.g` da requisição dentro das threads (§6). Tabela filha com FK vem
  **embutida** na mesma leitura (`acao_apoio(usuario_id)`,
  `reuniao_participantes(usuario_id)`), não numa segunda ida.
- **Chart.js 4** vendorizado (`app/static/vendor/`), configurado em
  `app/static/js/chart-setup.js`. **Não** troque por outra biblioteca.
- **Leaflet 1.9.4** vendorizado, só no mapa da Troca de Poste.
- Deploy: Vercel (`@vercel/python`, entrypoint `api/index.py`). A função
  roda em **`pdx1`** (Oregon, junto do Supabase) e o **estático sai pela CDN**
  (`@vercel/static`, cache de um ano), nunca pelo Python — ver §6.
- **Sem framework de teste.** Verificação é por script e pelo navegador (§8).

---

## 4. Os seis módulos

| Rota | Módulo | Origem do dado | Quem vê |
|---|---|---|---|
| `/dashboard` | **Dashboard** | `dados_modulo` (6 coletas `ger_*`) | todos |
| `/produtividade` | Produtividade | `dados_modulo` (coletor) | todos; supervisor só o time dele |
| `/iqi` | IQI / IQM | `dados_modulo` (coletor) | todos |
| `/massivas` | Massivas | `dados_modulo` (coletor) | todos |
| `/troca-poste` | Troca de Poste | schema `troca_poste` | todos menos supervisor |
| `/acoes` | **Ações** | `public.acoes` e cia. | cada um as suas; gestor a área dele |

Mais `/usuarios`, `/monitoramento` (admin) e `/configuracoes` (todos).

### Dashboard (visão gerencial)

Responde "como o negócio está indo", não "como o time está executando": por que
o cliente reincide, por que ele cancela, o que a fila de agendamento acumula e
como o cliente avalia o atendimento.

**É a tela de entrada do portal.** A raiz `/` e o pós-login caem aqui (antes
era Produtividade) — a visão gerencial é a primeira leitura do dia. O `next`
continua ganhando: quem clicou num link direto e caiu no login volta para onde
queria ir.

**Página única, sem sub-abas** — ao contrário de Ações e Troca de Poste. A
leitura gerencial é a soma dos blocos; separá-los obrigaria a trocar de tela
para relacionar reincidência com cancelamento, que é justamente a relação que
interessa. A ordem desce do indicador para a causa: qualidade → causa raiz →
churn → fila → atendimento.

Seis coletas, todas no coletor (`coletor/gerencial.py`), gravando em
`dados_modulo` como os módulos antigos:

| Módulo | Relatório do WVSA | Sessão | Cadência |
|---|---|---|---|
| `ger_categorias` | `operacional31` — causa raiz (Cat 1..6) | padrão | rodada |
| `ger_cancelamentos` | `indicadores13` (IGC) + `operacional19` (CMT) | padrão | rodada |
| `ger_esteira` | `/operacional/os/query` — fila de agendamento | padrão | rodada |
| `ger_idf` | `indicadores9` — painel, lista de feedbacks, drill setor/cidade | **gestor** | rodada; drill 1x/dia |
| `ger_salas` | `operacional15` — Rocketchat | **gestor** | rodada |
| `ger_atendimento` | `indicadores14` (RRO) — TMA/TMF do chat | **gestor** | **1x/dia** |

**Duas sessões do WVSA, uma rodada.** O relatório é recortado por usuário:
`w8_client.login()` usa `W8_USER`, `login_gestor()` usa `W8_USER_GESTOR`. As
duas vivem na mesma execução do `enviar.py`, então tudo atualiza junto.

**As categorias vêm registro a registro, não somadas.** `ger_categorias` guarda
uma linha por reincidência — com o **técnico** dentro —, no mesmo formato
compacto da Produtividade (índices para listas de texto). Não é economia de
espaço: é que a visualização "Causa raiz" do `/iqi` cruza empresa, supervisor e
mês ao mesmo tempo, e contagem já agregada não se recorta depois. O Dashboard,
que mostra o consolidado, também conta no browser desde 29/09/2026 (filtro
global e cross-filter — ver adiante); `gerencial.agregar_categorias` ficou para
o servidor.

**A Categoria 6 é MÚLTIPLA** (`<select multiple>` no WVSA; são os ajustes de
Wi-Fi — BAND STEERING, Atualizado Firmware, IPV6…). No registro compacto ela é
uma **lista de índices** e mora na posição 7, **no fim**: os meses não
recoletados continuam com registros de 7 posições, e um campo novo no meio
deslocaria `cidade` em todos eles. `multiplos` no payload diz quais campos são
lista. Registro sem a posição 7 = "não coletada", que a tela distingue de `[]`
("nenhum ajuste") — os meses anteriores a 29/09/2026 só ganham Cat 6 com
`enviar.py --so ger_categorias --full`.

⚠️ As listas de texto (`tec`, `c1`…`c6`, `cid`) são **carregadas do payload
anterior e só crescem**. Os meses que não foram recoletados na rodada guardam
índices que apontam para elas; reconstruí-las do zero deslocaria todo índice
antigo e trocaria em silêncio a categoria de cada registro do histórico.

**O período coletado é o ANO, a exibição são 2 meses.** `--full` vai de janeiro
do ano corrente até hoje (`DASH_BACKFILL_DESDE` puxa mais para trás); a rodada
normal refaz só o mês corrente e o anterior, porque a janela de reincidência de
30 dias ainda fecha depois da virada. Quantos meses os cards comparam é
preferência do gestor, em `dashboard_config.meses_visiveis` (Configurações).

**A esteira tem tabela própria** (`dashboard_esteira_snapshot`), e não é
capricho: `dados_modulo` tem `modulo` como chave primária e guarda só a foto
mais recente. "Quantas OS entraram e quantas saíram desde a abertura do dia" é
diferença entre DUAS fotos. O snapshot guarda o **conjunto de números de OS**,
não o total — "5 entraram e 5 saíram" e "nada aconteceu" deixam o total igual,
e é o primeiro caso que a operação quer ver. Uma abertura por dia é garantida
por índice único parcial, para que um retry às 08h não vire segunda base de
comparação.

**As metas são configuráveis** (`dashboard_metas`, editadas em Configurações).
Meta sem valor é estado legítimo: o card mostra o número e **omite** a
comparação, em vez de medir contra um alvo que ninguém combinou. Cada meta tem
`direcao` (`menor`/`maior`) porque as duas famílias convivem — IQI, IQM, CMT,
esteira e salas Disk são "quanto menor, melhor".

⚠️ **"GPON apagado" no Dashboard é CAUSA, não produção.** O que os cinco
relatórios entregam é a Categoria 2 do AII: o N1 encerrou o protocolo de
reincidência como "ONU - Gpon apagado". Quanto menos, melhor. A razão
"GPON realizadas ÷ abertas" — essa sim, quanto maior melhor — **não existe em
nenhuma das fontes coletadas**; se for pedida, precisa de relatório novo.

**A causa raiz aparece em duas telas, com propósitos diferentes.** No
`/dashboard` é o mês, em ranking. No `/iqi` é uma tabela mensal (Cat 4, 5 e 6
nas linhas, meses nas colunas), dentro da visualização Tabela mensal. As duas
contam com **`Dash.contarCategorias`** (`dashboard_rank.js`), uma função só;
Categorias 1 e 2 só aparecem no Dashboard, porque dizem como o cliente pediu e
como o N1 encerrou, não a causa.

**Cross-filter: clicar numa categoria filtra as OUTRAS pelos protocolos dela.**
Nas duas telas. Ao contar um campo, aplica-se a seleção de todos os outros,
menos a dele — o cartão clicado fica inteiro, com a linha marcada, e os demais
recortam. ⚠️ O filtro é sobre **registros**, não uma árvore Cat 4 → Cat 5:
medido em 08/2026, "Trocado Conector ONU" aparece sob Conector (6) **e** sob
Equipamento (1). Uma árvore fixa esconderia um dos dois. O clique é **delegado
no contêiner** (`Dash.rank` com `aoClicar`), porque a lista é redesenhada a
cada filtro e ouvinte preso à linha morreria com ela.

**Filtro global** (`dashboard_filtro.js`, dono do estado): Empresa, Supervisor,
Técnico e "Só ofensores". Publica **`dashfiltro`** no `DOMContentLoaded` e
responde `DashFiltro.passa(nome, {ind, mes})`. Empresa, apelido e alcance do
supervisor vêm de `iqi_supervisor.js`; a regra de ofensor, de
**`iqi_regras.js`** (`ofensoresDoMes`, usada também pelo bloco Ofensores do
`/iqi`); o recorte operacional, de **`supervisores.so_operacional`** (saiu de
`routes.py`). Uma definição de cada.

| Bloco | O que o filtro global faz |
|---|---|
| IQI/IQM | vira **soma dos técnicos do recorte** (só operacional), rotulada — o consolidado do WVSA volta ao limpar |
| Causa raiz | recorta os registros pelo técnico |
| Cancelamentos | recorta **só** o técnico do último atendimento |
| IDF | recorta **só** o canal OS (técnico); ligação/chat têm filtro próprio |
| Esteira, salas, TMA/TMF | nada — e a seção mostra a etiqueta `.nao-recorta` |

"Só ofensores" é por indicador e mês; sem indicador (cancelamento, OS do IDF),
vale ser ofensor em IQI **ou** IQM naquele mês.

**Cancelamentos: técnico do último atendimento.** Sai do CMT
(`operacional19`), que lista por contrato cancelado as OS e o técnico de cada
uma; o último atendimento é a **OS de maior número** (conferido: a `#579421`
abriu em 11/08, o contrato cancelou em 20/08). A cidade e o motivo vêm do IGC,
cuja resposta já trazia um `pivotUI([...])` **contrato a contrato** que ninguém
lia — o cruzamento é pelo número do contrato (45 de 45 casaram em 08/2026).
⚠️ Cobre **só o grupo PROBLEMA TECNICO e só quem teve OS**: 45 de 64 em
08/2026. E o rótulo do motivo NÃO diz se houve OS — 7 "SEM HISTORICO" têm OS no
CMT, e 5 "HISTORICO DE OS" não aparecem lá. A tela mostra a cobertura
calculada, nunca promete 100%. A coluna "Usuário" do CMT é o **atendente** que
registrou o cancelamento, não o cliente.

Filtro por grupo/motivo reconta cidade, tempo de casa e grupos a partir do
contrato a contrato; a **receita perdida vira "—"**, porque o pivot não traz o
valor por contrato. A faixa de ticket saiu da tela em 29/09/2026 (o coletor
não a guarda mais por contrato).

**IDF: alerta, subsetor, cidade, atendente.** Alerta abaixo do limiar
(`dashboard_metas.idf_alerta`, padrão 3; **3 exato não alerta**) na média do
canal, na linha do atendente e numa lista das avaliações. Três fontes, porque
nenhum endpoint entrega tudo: painel (números oficiais), `lista/{canal}`
(feedback a feedback, **sem setor nem cidade**) e `detalhes` (drill por setor
ou cidade → atendente, com qtd e média). Com cidade, os números vêm do drill —
média ponderada, **sem % resolvido** (o WVSA não publica por cidade), e a lista
de alertas some com o porquê.

| Recorte | Ligação | Chat | OS |
|---|---|---|---|
| Subsetor (setor do IDF) | sim | sim | não (o "setor" de OS é a empresa) |
| Cidade | **não** (vem tudo "Indefinido") | sim | sim |
| Atendente | sim | sim | não — é o filtro global |

Conferido em 08/2026: lista recontada = painel (4,61/88,84%, 4,48/91,15%,
4,51/78,76%), subsetor N1 chats = 4,33 com 420 e Tijucas OS = 4,50 com 115,
iguais ao drill do WVSA. Nome e telefone do cliente **não** são guardados; a
observação só quando a nota é ≤ 3 (`IDF_OBS_ATE`).

**TMA/TMF: do chat, pelo RRO.** O WVSA não tem relatório com esses nomes
(ITA, `ligacoes6`, Ranking N1 e MRP conferidos). TMA = última mensagem −
início, só conversa fechada com atendente humano; TMF = primeira resposta
humana em "Tempos de resposta" (o bot não conta). O coletor agrega por
(departamento, atendente) em **somas e faixas de duração** — a tela soma as
partes e mostra a **mediana aproximada** ao lado da média, porque a média
mente: em 09/2026, TMA médio de 200 min contra mediana ≤ 120 min.

⚠️ A visualização do `/iqi` conta **todo protocolo de reincidência, inclusive
de equipes de infra**, que não entram no cálculo do `%`. O total dela não fecha
com o das outras visualizações da mesma tela — é intencional, está escrito na
tela, e o filtro de empresa separa.

O que o módulo **não** faz, de propósito: TMA/TMF de **ligação** — nenhuma
fonte com duração de chamada foi encontrada (o `ligacoes6` só conta por ramal e
hora). O card "Massivas em aberto" do
material de referência (a lista de `#7403` com previsão) ficou de fora. Falha
Massiva como *causa de reincidência* está dentro, nas Categorias 4 e 5 — e é a
segunda maior.

### Ações: quadro Kanban, painel lateral e cronograma

A aba **Ações** (`/acoes?aba=acoes`) tem três visões — **Quadro**, **Lista** e
**Cronograma** (`?visao=`) — debaixo de UMA barra de filtro (busca, pessoa,
área, prioridade, etiqueta, agrupar e os atalhos Minhas/Atrasadas/Vencem em 7
dias/Críticas e altas). Tudo desenhado pelo `acoes_quadro.js` a partir de
`window.__ACOES__`; o estado inteiro fica na URL.

**Filtro no cliente, recorte no servidor.** `acoes.listar` continua mandando só
o que a pessoa pode ver; daí para baixo o filtro é de leitura. Recarregar a
página a cada chip fecharia o painel lateral aberto. Links antigos com
`?situacao=Atrasada` viram o atalho.

**As colunas são `acoes.STATUS`, fixas.** Nenhuma coluna configurável, pelo
mesmo motivo de o status ser fixo no código. A ordem dentro da coluna é a de
urgência do servidor (atrasada → vence em breve → prioridade → prazo), sem
ordenação manual: é a ordem em que a pauta é lida. Cancelada fica recolhida
numa faixa fina (continua alvo de arrasto); Concluída mostra só os últimos 30
dias, com o resto a um clique.

**Arrastar = `acoes.atualizar`, com o comentário OPCIONAL** (decisão de
29/09/2026). Em branco, o evento grava "Movida de X para Y." — quem e quando
ficam, só o porquê não. As duas travas continuam: concluir exige evidência
(constraint) e atrasada exige próximo passo. Texto só é opcional quando o
status MUDA; atualização sem mudança e sem texto é recusada. O cartão muda de
coluna na hora e o diálogo (`_acao_mover.html`, um só para arrasto e seletor)
abre; cancelar ou o servidor recusar devolve o cartão. No celular não há
arrasto: o quadro vira carrossel e o status muda pelo seletor do painel.

**Painel lateral** (`/acoes/<id>/painel`) no lugar da troca de página. É um
fragmento renderizado pelo SERVIDOR, com o mesmo parcial da página cheia
(`_acao_painel.html`, incluído por `acao_detalhe.html`): uma definição só da
tela da ação. `?acao=AC-007` abre direto (link copiável); abrir faz
`pushState`, então "voltar" fecha. Depois de cada gravação o parcial volta do
servidor inteiro — por isso todo ouvinte do `acao_painel.js` é delegado no
contêiner. Texto longo editado no lugar NÃO recarrega (roubaria o foco do
campo seguinte); select, data, apoio e etiquetas recarregam.

As rotas JSON (`/mover`, `/campo`, `/checklist`, e `/atualizar` e `/comentar`
quando o pedido é JSON) devolvem o cartão no formato do quadro (`_item_quadro`),
e o evento `acaoatualizada` redesenha o quadro sem recarregar a página.

**Checklist calcula o progresso** (migration `0017`, decisão de 29/09/2026).
Com 1+ item, `progresso = feitos ÷ total`, GRAVADO em `acoes.progresso` pela
função `acao_checklist_aplicar` — assim lista, pauta, eventos e Painel leem a
mesma coluna sem conhecer checklist. O controle deslizante some. Concluir
continua forçando 100% (o diálogo avisa os itens em aberto); reabrir volta ao
que o checklist diz e apaga a `data_conclusao`. Apagar o último item deixa o %
onde estava. Item se apaga de verdade (é plano, não registro); o concluído
aparece na atividade pelo `feito_em`, lido junto dos eventos, sem gravar nada
em `acao_eventos`.

**Etiquetas** são `acoes.etiquetas text[]` (sem tabela: rótulo não tem dono nem
cor). Comparação sem caixa, grafia da primeira vez, até 8 de 30 caracteres.

O **Painel** ganhou "Fluxo semanal" (abertas × concluídas por `data_abertura` e
`data_conclusao`, 12 semanas) e "Carga por pessoa" (só o responsável, não o
apoio — senão a mesma ação pesaria duas vezes; atrasadas numa pilha ao lado,
não empilhadas no status).

### Reuniões (dentro de Ações, aba `?aba=reunioes`)

A reunião grava áudio pelo navegador, transcreve durante a própria reunião e
gera a ata. **Não é módulo à parte**: mora em `/acoes?aba=reunioes` e
`/reunioes/<id>`; a camada de dados é `app/reuniao_ia.py` e o cliente da Groq é
`app/ia.py`.

Quem orquestra é o **navegador**, e isso não é escolha estética: a Vercel é
serverless, não tem processo em background e limita o corpo da requisição. Então
o JS corta o áudio em trechos de ~2 min, sobe cada um direto para o Storage com
URL assinada e chama o Flask uma vez por trecho. Cada requisição fecha em
segundos, e ao clicar em "Encerrar" só falta o último trecho.

O que expira e o que fica: **o áudio some em 30 dias**; `transcricao`,
`ata_markdown` e `reuniao_ata_itens` ficam para sempre. Depois dos 30 dias a ata
não pode mais ser regerada — a fonte foi apagada.

O que **não** é feito por IA, de propósito: contar em quantas reuniões uma ação
apareceu, decidir o que é recorrente e formatar a ata. Os três são código em
`reuniao_ia.py`. O modelo transcreve e redige; todo número na tela veio do
Postgres.

**A pauta automática é alternável por reunião** (`reunioes.puxar_pauta`,
migration `0015`). Ela é montada com toda ação em aberto de qualquer
participante, e isso aparece em dois lugares: o card "Pauta" da tela e o bloco
"Ações que estavam na pauta" **dentro do prompt da ata** — que empurra o modelo a
amarrar a conversa nesses códigos. Numa reunião de orçamento de 08/09/2026
entraram `AC-003` e `AC-004`, que nada tinham a ver com o assunto.

O botão fica no cabeçalho do card, e não na criação da reunião, porque o assunto
real nem sempre é conhecido no agendamento — e porque a escolha precisa valer
também **depois** de gravar, na hora de gerar a ata. Desligar tira os dois de uma
vez: é `acoes.pauta()` quem devolve `[]`, e `montar_ata` lê dela.

⚠️ `default true` no banco e `is False` no Python: ausência da coluna (reunião
lida antes da migration) significa **puxa**, que é o comportamento de sempre.
`not reuniao.get("puxar_pauta")` faria a pauta sumir de todas as reuniões
enquanto a migration não subisse.

**A ata é o RELATO; os itens são sugestões à parte** (migration `0016`). O
texto traz resumo e pontos discutidos; decisões, encaminhamentos, pendências e
riscos vivem só como linhas em `reuniao_ata_itens`, no card abaixo. Antes eles
apareciam nos dois lugares: medido em 08/09/2026, a seção ENCAMINHAMENTOS da
ata repetia palavra por palavra as 10 sugestões do card — e o PDF levava as
duas. `reunioes.itens_na_ata` traz as listas de volta para dentro do texto, por
botão, quando alguém quiser.

Quem alterna não chama a IA: `reunioes.ata_dados` guarda a estrutura que o
modelo devolveu, e `_markdown` remonta o texto na hora — determinístico, sem
cota e sem devolver uma ata diferente da que já foi conferida. Ata gerada antes
da 0016 não tem essa estrutura: aí a escolha fica registrada, vale na próxima
geração, e a tela **diz isso** em vez de fingir que aplicou. ⚠️ `ata_dados` fica
FORA do select padrão de reunião (são ~8 KB de JSON que só interessam a quem vai
remontar).

**Regerar a ata tem botão** ("Gerar de novo", no rodapé da ata), com `<dialog>`
de confirmação. A rota sempre permitiu regerar — inclusive depois de encerrada,
porque o que "ata congelada" protege são os comentários do dia, não o texto
derivado do áudio —, mas o botão só existia enquanto NÃO houvesse ata. Sem ele,
"Incluir na ata" não tinha como aplicar em nenhuma ata anterior à `0016`, que é
onde `ata_dados` passou a ser guardado. ⚠️ Regerar chama a IA e a saída varia:
medido em 09/09/2026, a mesma reunião saiu com 13 pontos discutidos onde antes
tinha 20. A ata anterior não volta — o modal diz isso antes.

**Remover uma sugestão MARCA, não apaga** (`descartado_em`/`descartado_por`).
Reunião é dado que nasce aqui e não tem de onde recoletar (§2) — mas o motivo
principal é outro: é a marca que faz a regeração não trazer de volta o que
alguém já recusou (`_textos_descartados` + `_norma`, que compara sem caixa nem
espaço dobrado, porque o modelo devolve um texto PARECIDO, não idêntico). Item
já aplicado não se descarta: ele virou comentário em `acao_eventos`, e sumir com
a origem deixaria o registro órfão.

⚠️ **O filtro do que foi recusado precisa valer no TEXTO e nas LINHAS, e é um
só** (`_sem_recusados`, aplicado em `montar_ata` e na remontagem). A primeira
versão filtrava só em `_gravar_itens`: medido em 09/09/2026, a sugestão removida
não voltava ao card e VOLTAVA ao texto da ata na regeração seguinte — pior que
não ter filtro, porque some justamente do lugar onde há botão para removê-la de
novo e reaparece no documento. `ata_dados` continua guardando a estrutura
íntegra: filtrar é decisão de montagem, e uma recusa desfeita precisa ter de
onde voltar.

Item de ata só vira comentário na ação por **clique humano** — `acao_eventos` é
append-only por trigger, e texto de IA que entrasse lá sozinho seria
irreversível.

O item da ata tem **duas** saídas, e as duas por clique humano: virar **ação
nova** (formulário já preenchido com o texto e o prazo do item) ou **anexar a
uma ação existente**. Antes o vínculo só acontecia quando a IA reconhecia um
código `AC-000` na fala — e assunto que ainda não é ação, que é a maioria, não
tinha para onde ir.

A ata é **editável no próprio texto** enquanto a reunião está aberta
(`contenteditable`): clica e escreve, sem botão para abrir edição e sem botão
para salvar — sai sozinha 1,2s depois de parar de digitar. A IA erra nome
próprio e sigla, e corrigir não pode custar três cliques.

O HTML volta para Markdown num serializador de ~40 linhas no template, que
cobre exatamente o dialeto que `reuniao_ia.para_html` produz — o Markdown segue
sendo a verdade no banco. Ele compara com o texto do carregamento antes de
gravar: sem isso, um clique sem edição reescreveria o documento (o serializador
põe linha em branco onde o gerador não punha) e a ata apareceria como "editada
à mão" sem ninguém ter editado.

O **PDF é da reunião inteira** (ficha, ata, itens e os comentários registrados
nela), não só da ata, e o botão fica na **lista** — que é onde se procura por
ele depois. Sai por `reuniao_pdf.html`, uma página solta que imprime sozinha ao
abrir: não estende `base.html` porque o PDF não leva sidebar nem topbar, e
escondê-las com `@media print` seria carregar o que se pretende esconder. Quem
gera o arquivo é o navegador — sem biblioteca de PDF na função serverless.

**Convidado** é quem participou e não tem conta: nome em
`reunioes.convidados` (text[]), não linha em `reuniao_participantes`. Aquela
tabela é de quem tem login — é dela que sai a pauta, e pauta exige ação, que
exige usuário. Convidado só aparece na lista de quem estava, na ata e no PDF.

### IQI/IQM: duas visualizações, um filtro cada

O `.view-switch` do `/iqi` tem **duas** entradas, e cada uma empilha os blocos
que respondem à mesma pergunta com o mesmo recorte:

| Visualização | Blocos, nesta ordem | Filtro |
|---|---|---|
| **Gráfico** | gráfico por técnico → Ofensores → Por empresa | a `.toolbar` do topo: mês, meta, supervisor, ordenação |
| **Tabela mensal** | tabela mensal por técnico → Causa raiz (Cat 4 e Cat 5) | os `.filtros-multi`: supervisor, empresa, período |

Antes eram cinco visualizações, cada uma com seletor de mês e de supervisor
próprios. O problema não era o número de abas: era ler o ofensor de julho ao
lado do gráfico de agosto sem perceber.

**Como o filtro chega aos blocos de baixo.** Quem é dono do estado publica um
evento no `document`, e os blocos escutam:

* `iqi.js` → **`iqifiltro`** `{ind, mesIdx, mes, alcanceSup}` — consumido por
  `iqi_ofensores.js` e `iqi_empresas.js`;
* `iqi_tabela.js` → **`iqifiltrotabela`** `{ind, alcanceSup, empresas, meses,
  fechados}` — consumido por `iqi_causaraiz.js`.

`fechados` viaja junto de propósito: sem ele a Causa raiz marcaria só o último
mês como parcial, e **julho apareceria fechado no dia 29 de agosto** — quando
ainda faltavam dois dias da janela de auditoria. A regra é uma só (fim do mês +
30 dias) e mora em `iqi_tabela.mesFechado`.

⚠️ **Publique no `DOMContentLoaded`, não em `setTimeout(…, 0)`.** Os blocos de
baixo são `<script>` que carregam DEPOIS do dono do estado, então a primeira
publicação cai no vazio e as tabelas nascem vazias até o primeiro clique. O
timer de 0 ms **não** resolve: ele pode ser atendido entre dois `<script>` da
mesma página, que foi exatamente o que aconteceu aqui.

O único filtro que sobrou dentro de um bloco são os chips de empresa do
"Por empresa" — refinam só aquele bloco e não têm equivalente no topo.

O KPI **"do mês (WVSA)"**, na `.toolbar` e no topo do "Por empresa", é o
consolidado do `indicadores4` — o número que se confere contra o relatório.
Ele some quando há recorte (supervisor ou chips de empresa): o número da
operação inteira não fala do que está na tela. Tudo mais naqueles blocos é a
soma dos técnicos, rotulada como **soma**, e ela não fecha com o KPI de
propósito (§6).

### Troca de Poste: quatro abas, e a revisão é a que alimenta o resto

`/troca-poste` é leitura do schema `troca_poste` (§2) com **duas** escritas
próprias, ambas por clique humano: a revisão de endereço e a abertura de OS.

| Aba (`?aba=`) | O que é |
|---|---|
| `desligamentos` | inventário: filtros, KPIs, dois gráficos, tabela **agrupada por bairro/dia** (o trecho abre no clique) |
| `revisao` | fila + mapa com pino arrastável — confirmar, corrigir, reprovar |
| `ordens` | **todos** os grupos do recorte, script da OS e o botão que monta a OS (executor, tipo de técnico, **equipe**, período) |
| `mapa` | todos os desligamentos, agrupados por bairro/dia, com a malha óptica sob demanda |

**O bairro/dia é a unidade do módulo inteiro, não só da OS.** A Celesc publica
o mesmo bairro fatiado em várias ruas para o mesmo desligamento, e a equipe vai
uma vez: em 04/09/2026, 273 desligamentos ativos eram 58 grupos. A tabela de
Desligamentos agrupa pela mesma chave (191 trechos do recorte de 7 dias em 39
grupos) e abre os trechos no clique — 191 linhas soltas escondem que são ~39
lugares. A chave vem **carimbada do servidor** em `linha["grupo_chave"]`:
recalculá-la no JS exigiria um terceiro normalizador de bairro (Python, SQL e
JS), e é assim que dois grupos "Centro" aparecem sem ninguém entender por quê.

No cabeçalho do grupo, `dist_cabo` é o **menor** (é o que decide o risco do
lugar) e `qtd_postes` é o **máximo, não a soma**: os mesmos postes aparecem em
trechos vizinhos, e somar inventaria rede que não existe. O `geo_score` é o
menor — o elo fraco é o que manda o grupo para a revisão. O CSV continua saindo
linha a linha, que é o formato de quem vai cruzar em planilha. O agrupamento é o
`criterio='bairro_dia'` que o schema modela desde a migration 09 e que nenhum
código gravava. Quem monta o grupo de verdade é o banco
(`troca_poste.criar_os_bairro_dia`) — a tela agrupa só para exibir, e o servidor
não confia nos ids que o browser manda.

**O mapa NÃO colapsa o grupo num pino, e isso é medido.** Em 09/09/2026, dos
39 grupos com dois ou mais trechos posicionados, a dispersão MEDIANA era
**916 m** e a máxima **12,6 km** — só 6 cabiam em 200 m. Um pino no centro
mandaria a equipe para onde não há obra. Os trechos continuam desenhados um a
um; o grupo entra como contorno tracejado em volta do NÚCLEO.

⚠️ **E a dispersão virou detector de geocodificação errada — melhor que o
score.** Em Navegantes · PRTO DAS BALSAS, 13 dos 14 trechos estavam a ~300 m
uns dos outros e UM, `validacao='revisar'` e score 28, a 7 km: sozinho ele
criava os 9,2 km de dispersão do grupo. Nos 12 grupos com mais de 2 km, os
pontos fora do lugar eram **sempre** os `revisar`. Medido no recorte inteiro:
dos 18 acusados, **15 já estavam marcados para revisão**. "Este endereço está a
7 km dos outros 13 do mesmo bairro no mesmo dia" é evidência; "score 28" é
desconfiança.

Três decisões que o desenho carrega, e o porquê de cada uma:

* **o centro é a MEDIANA das coordenadas, não a média.** Com um ponto a 7 km a
  média é puxada para o meio do nada, e o cluster inteiro passa a parecer longe
  do centro — a mediana ignora o outlier, que é justamente o que se quer
  isolar;
* **o contorno cerca o núcleo, não todos os trechos.** Incluir o suspeito
  esticaria o círculo até ele e o faria parecer dentro do bairro, apagando o
  sinal;
* **com apenas DOIS pontos afastados não se acusa ninguém** a menos que a
  própria geocodificação já não avalize um deles. Chutar marcaria o certo
  metade das vezes.

⚠️ O detector diz "não fecha", **não** "está errado". Num grupo em que a
maioria dos pontos está mal geocodificada, o centro sai errado e o ponto BOM é
que aparece fora do lugar — foi o caso de `PEDRO ROMAO` (score 92, aceita) em
Alto Pereque. Por isso o aviso do popup muda de texto quando a posição tinha
sido aceita: ali ele pede conferência, não denuncia.

**Os gráficos e KPIs contam DESLOCAMENTO** (bairro·dia), com o total de trechos
ao lado. Antes contavam trecho, e o dia 04/09 aparecia como 17 eventos onde há
uma viagem só a Areias do Meio: o pico dizia mais sobre como a Celesc redigiu o
aviso do que sobre o que vem pela frente. No ranking de cidades o efeito era
pior — a cidade cujo aviso foi escrito rua a rua subia sobre a que descreveu o
bairro numa linha, sem diferença nenhuma de trabalho.

**O filtro alcança o passado — a janela é do SERVIDOR.** O pacote padrão traz
só de hoje em diante; até 29/09/2026 o De/Até filtrava no cliente em cima
disso, e qualquer data passada dava tabela vazia com o histórico inteiro no
banco. Hoje, se o período sai do que veio (`pacote.carregado`), a página
recarrega com `?de=&ate=` (teto de 93 dias, cortado no COMEÇO), e há o atalho
"Últimos 30 dias". No passado entram os `desapareceu` que sumiram da Celesc no
dia do desligamento ou depois — a Celesc tira o aviso quando ele acontece, e
esconder esse status apagava do histórico justamente o que foi realizado. Os
que sumiram ANTES da data (cancelamento ou aviso republicado; 86 de 283) ficam
fora (`troca_poste._aconteceu`). Grupo passado não é candidato a OS, não leva
script no pacote, e o servidor recusa a OS com 400.

**Grupo que já tem OS sai dos candidatos.** A `chave_idempotencia` sempre
impediu a duplicata no banco, mas o risco nunca foi o banco: era o botão
continuar convidando ao clique num lugar já resolvido — e a pessoa clicar de
novo achando que a primeira vez não pegou, ou ir conferir no WVSA se abriu
duas. Eles não somem: viram chip acima da tabela, com o número da OS, e a
tabela de Ordens passou a mostrar o rótulo do agrupamento
("DOM JOAQUIM — 10/09/2026") em vez de só executor e número.

⚠️ A ligação grupo → OS é pela tabela `agrupamento_itens`, **não** por
recalcular a `chave_idempotencia`: a chave depende de `normalizar_texto`, que é
do banco, e reimplementá-la no Python só para comparar traria de volta a
armadilha dos dois normalizadores. O vínculo real já está gravado.

E o grupo sai da lista **na hora do clique**, sem esperar recarregar
(`marcarAberto`): é exatamente na janela entre o clique e o próximo
carregamento que alguém clica de novo.

**Clicar na linha abre "onde é" e "o que vai".** Um mini-mapa com os trechos
daquele grupo, de perto, e o script ao lado — em dois blocos ROTULADOS. O mapa
não tem como entrar no texto da OS (o envio manda `g.script_os`, do pacote do
servidor; o JS nunca lê o `<pre>`), mas empilhados sem rótulo eles parecem uma
coisa só, e quem olha fica sem saber o que exatamente vai para o WVSA.

É acordeão: abrir um fecha o outro. O mini-mapa é **uma instância de Leaflet**
movida para a linha aberta — criar e destruir um mapa por linha vazaria
listeners e refaria o download dos tiles a cada clique.

⚠️ A célula do detalhe é tão larga quanto a TABELA, que no celular já rola de
lado. Sem `max-width` pelo viewport o mapa nascia com 597px numa tela de 375, e
os pontos ficavam atrás da borda até alguém arrastar a tabela.

**`grupos[].itens` NÃO vai no pacote.** Ele repetia `linhas` inteiro dentro dos
grupos: 209 kB de 719 kB, **29% da página**, para um dado que o cliente já
tinha. O grupo carrega os `ids` e a tela procura os trechos no `linhas` que já
está lá (`trechosDo`). Medido em 10/09/2026: o pacote caiu para 509 kB.

A aba de Ordens mostrava **só os críticos** até 04/09/2026. Passou a mostrar
todos: a classificação continua ordenando e aparece no badge de cada linha, mas
esconder o resto tirava da tela desligamento que a operação quer abrir —
inclusive os `indeterminado`, que são exatamente os que esperam revisão.

**O filtro de tipo de serviço** usa `causa_categoria`, não o texto de `causa`.
São 5 tipos (ampliação, melhoria, preventiva, corretiva e serviço comercial);
o texto cru vem com pontuação variável ("- PROG. - ALTERAÇÃO PARA AMPLIAÇÃO") e
filtrar por ele perderia linha sem erro na tela. O select lista só os tipos
PRESENTES no recorte, com a contagem: oferecer um tipo que não existe ali leva
a pessoa a filtrar e ver tabela vazia sem entender por quê.

**A revisão é o que faz a fila encolher.** Confirmar um endereço grava três
coisas na mesma transação: a posição como `manual`, o **alias** em
`enderecos_alias` e o recálculo do match. O alias tem prioridade máxima sobre
qualquer geocodificador (ADR-0005): na próxima coleta aquele texto da Celesc
nasce resolvido. Sem o segundo passo, revisar conserta uma linha; com ele,
conserta o endereço. Reprovar existe para o endereço que não dá para
posicionar — sai da fila **sem** coordenada e sem alias, em vez de virar
palpite com score 100.

**Os campos da OS vêm do formulário do WVSA, copiados pelo coletor.** Dos 22
campos do `/relatorios/infra10`, o contrato marca cinco como escolha do painel
(§3.1) — e até 04/09/2026 iam todos vazios, com `executor='infra'` cravado no
JS. As opções vivem dentro do formulário, num IP privado: quem as copia para
`troca_poste.wvsa_catalogos` é o `enviar_os.py`, a cada `OS_CATALOGO_HORAS`.
O portal só lê.

Medido em 04/09/2026: `tecnico_id[]` é multi-select **estático** no HTML, com
34 opções, e não depende do `tipo_tecnico` nem vem por AJAX — o `catalogos()`
do monorepo não o incluía, era omissão. O rótulo traz a empresa como prefixo
("INFRA UNET - Fulano") e a tela agrupa por ela; o rótulo vai **inteiro**,
porque há nome repetido em empresas diferentes (Ueliton Patriqui Nicoletti é
`522` na INFRA WAVE e `661` na WAVE) e cortar o prefixo viraria adivinhação.

**`agendamento` tem cadência PRÓPRIA — 15 min, contra 12 h dos demais.** Ele
não é catálogo, é a AGENDA: muda ao longo do dia conforme a operação marca.
Medido em 10/09/2026, uma sincronização trocou **21 slots vencidos por 35
novos**, cobrindo três dias. Copiado de 12 em 12 h, o portal ofereceria um
horário que já foi ocupado.

O rótulo (`149140-M1` → "10/09/2026 - M1 - INFRA UNET - Alexandre de Oliveira")
é quebrado em `metadados {data, turno, tecnico}` no coletor. ⚠️ Divida em no
MÁXIMO três pedaços: o nome do técnico contém " - " quando ele tem empresa no
cadastro, e um split cego corta o nome ao meio.

A tela só oferece os slots **do dia daquele grupo** — mostrar o de outro dia
faria o operador marcar um horário que não existe para aquela obra. Como o
desligamento costuma estar semanas à frente, o normal é não haver slot: aí o
select fica desabilitado e a nota explica, em vez de a tela parecer quebrada.

⚠️ A trava de "catálogo vazio é sessão expirada" **não** vale para a agenda:
ela pode estar legitimamente vazia (ninguém agendou nada), e recusar isso
deixaria slots cancelados vivos no portal para sempre.

⚠️ **`DATA` e `DATAFIM` vão em ISO, não em DD/MM/AAAA.** São
`<input type="date">` no formulário — conferido no HTML em 09/09/2026, com o
servidor renderizando `value="2026-09-09"` —, e campo assim só submete ISO: o
navegador não tem como mandar outra coisa, e não há JS na página reformatando
antes do envio. O `montar_payload` convertia para BR, o que faria a OS nascer
com data errada em vez de dar erro. A versão TypeScript do monorepo sempre
mandou ISO; era o Python que divergia.

**O contrato do formulário foi conferido campo a campo** em 09/09/2026, pelo
HTML do `<form action="/relatorios/infra10/save">`: os 22 nomes batem com o que
o `montar_payload` envia, e `SOLICITACAO` é o único `required` do form. As 11
cidades monitoradas têm `ibge_codigo` idêntico ao que o autocomplete devolve —
zero divergência.

O `bairro` é autocomplete, não select, e por isso é resolvido no **momento do
envio**, pelo coletor (é o único ponto que alcança o WVSA).

⚠️ **O parâmetro é `query`, não `term`, e os cabeçalhos `X-Requested-With:
XMLHttpRequest` + `Accept: application/json` são obrigatórios.** Sem eles o
WVSA devolve o HTML da tela com HTTP 200, e o código lê "nenhuma sugestão" —
ou seja, a resposta *parece* "esse bairro não existe" quando é a requisição que
está errada. Custou uma rodada de teste em 04/09/2026: `AREIAS DO MEIO`,
`CENTRO` e `BOMBAS` voltaram todos vazios até os cabeçalhos entrarem; com eles,
ids reais (`64d11040188881a70f09e902` e cia.), e só o bairro inventado volta
vazio.

⚠️ E ele rate-limita, falhando em silêncio do mesmo jeito: HTTP 200 com lista
vazia. Lista vazia é "tente de novo", NUNCA "não existe" — aceitar o vazio
mandaria a OS com bairro em branco justamente quando o WVSA está ocupado.

Medido em 09/09/2026 contra as 11 cidades: com intervalo FIXO de ~0,95 s, 4
delas voltaram vazias; com espera CRESCENTE, todas responderam, duas só na
terceira tentativa. Por isso são 4 tentativas com `0,95 s × tentativa`. E o
sintoma engana: rodando duas vezes, cidades diferentes falham — foi o que quase
me fez concluir que 6 das 11 não existiam no cadastro do WVSA.

A correção humana é durável: `marcar_coordenadas_colapsadas` tem
`and g.validacao <> 'manual'` e o upsert da geocodificação preserva `manual`.
Nenhuma rodada posterior rebaixa o que uma pessoa apontou no mapa.

### Papéis

Três, independentes — a pessoa pode ser um, vários ou nenhum:

- **admin** — `email == ADMIN_EMAIL` (variável de ambiente, **não** coluna).
- **supervisor** — linha em `supervisores`; vê só o time dele em Produtividade
  e IQI.
- **gestor de ações** — linha em `acao_gestores`; manda nas ações das áreas dele.

### Quais módulos cada um enxerga

Configuração, não código, desde 04/09/2026 (migration `0014`). O admin marca em
*Configurações → Acesso aos módulos* o que cada pessoa vê; `auth.MODULOS` lista
os seis configuráveis.

⚠️ A tabela `usuario_modulos_bloqueados` guarda o que foi **TIRADO**, não o que
foi liberado. Sem linha = vê — que é como o portal sempre funcionou, e por isso
subir a mudança não tirou nada de ninguém. Guardar liberações exigiria semear os
12 usuários na migration e deixaria usuário novo nascendo cego.

Três regras que não se negociam:

* **o admin nunca perde módulo.** É ele quem edita a lista; trancá-lo exigiria
  um UPDATE no banco para destravar;
* **esconder no menu não é permissão.** `modulo_obrigatorio()` fecha a rota com
  **404** — a URL é adivinhável, e 403 confirmaria que a tela existe (mesma
  razão do módulo Ações);
* **Configurações nunca entra na lista.** É onde cada um troca a própria senha,
  e é para onde a raiz manda quem ficou sem módulo nenhum (`_primeira_tela`) —
  sem isso, o login terminaria num 404.

Antes disso, a única regra era `ve_troca_poste = not eh_sup or eh_admin`:
supervisor nunca via Troca de Poste e mudar isso exigia deploy. Agora essa
decisão é da tela. **O recorte de DADO do supervisor continua no código** —
ver só o próprio time em Produtividade e IQI é sobre quais linhas ele lê, não
sobre qual tela ele abre, e liberar o módulo não amplia o que ele enxerga
dentro dele.

Tudo isso é montado em `usuario_atual()` (`app/auth.py`), com cache por
requisição em `flask.g`.

---

## 5. Convenções

### Estrutura de um módulo

```
app/<modulo>.py              camada de dados: fala com supa.py, sem Flask
app/routes.py                rotas (blueprint `dash`), finas
app/templates/<modulo>.html  estende base.html
app/static/js/<modulo>.js    IIFE, sem framework, sem build
```

`app/acoes.py` é a referência mais recente e mais completa. `app/supervisores.py`
é a referência para "tabela de vínculo".

### Abas dentro de um módulo

A sidebar é **plana**. O segundo nível é um `.view-switch` dentro da página, com
o estado na URL (`?aba=`), como em `acoes.html` e `troca-poste.html`.

### Recorte de permissão é no SERVIDOR

Dado que a pessoa não pode ver **não chega ao browser**. Esconder no CSS ou no JS
não conta. Veja `acoes.listar()` e o recorte de supervisor em
`routes.py:produtividade()`.

Ação alheia acessada por URL devolve **404, não 403** — 403 confirmaria que
existe, e códigos como `AC-001` são fáceis de adivinhar.

### Migrations

`supabase/migrations/NNNN_nome.sql`, numeradas em sequência, aplicadas à mão no
SQL Editor do Supabase (ou por `psycopg` com a `DATABASE_URL`). São **aditivas**:
nada de `drop`/`alter` destrutivo em tabela com dado de produção.

⚠️ O schema `troca_poste` é a exceção: o DDL dele nasceu e continua no monorepo
(`*_tp_*.sql`, §2). A partir da `0012` há migrations de `troca_poste` **aqui**
também, e o critério é de quem consome: função que só o portal chama
(`aplicar_revisao`, `criar_os_bairro_dia`) mora neste repositório, porque
deixá-la no monorepo faria a tela depender de DDL num repositório que ninguém
abre para mexer nesta funcionalidade. Tabela e coluna do pipeline continuam lá.

### Git: confira se o commit chegou na main

**Antes de dizer que algo está corrigido, rode:**

```bash
git fetch origin && git log --oneline origin/main..HEAD
```

Se listar alguma coisa, **não está na main** — e portanto não está em produção.

Isto virou regra porque aconteceu duas vezes seguidas no módulo Reuniões: o PR
foi mergeado enquanto a correção seguinte ainda estava sendo escrita. O commit
ficou órfão na branch, o PR fechou, e a `main` saiu com o defeito que todo mundo
achava resolvido. Nos dois casos o erro só apareceu porque alguém foi usar a
tela — não porque o Git avisou.

Duas consequências práticas:

* Depois de mergear, **confira se a branch ainda está à frente**
  (`gh pr view <n> --json state,mergedAt` e o `log` acima). Se estiver, abra
  outro PR: a mesma branch serve, ela fica zerada depois do merge.
* Enquanto uma correção estiver sendo escrita, **segure o merge**. Push não
  reabre PR fechado.

### Comentários

Explique **por quê**, não o quê. Registre a decisão e o que aconteceria se fosse
diferente. Os arquivos deste projeto seguem esse padrão — mantenha-o.

### Visual

`app/static/css/style.css` é a fonte da verdade. Reaproveite as classes que já
existem (`.kpi`, `.card`, `.tbl`, `.badge-*`, `.chip`, `.toolbar`, `.view-switch`,
`.vazio`, `.subnote`, `.lista-marcar`, `.linha-tempo`, `.barra`). Cores por
token (`--brand`, `--success`, `--danger`, `--warning`, `--ouro`).
**Nunca invente um componente que já existe.**

Os que nasceram nas Reuniões e servem em qualquer tela:

| Classe | O que é |
|---|---|
| `.dropdown` | `<details>` que abre um painel; o resumo diz o que foi escolhido |
| `.modal` | `<dialog>` de confirmação |
| `.ata` | corpo de texto para leitura, com medida limitada (74ch). `.ata.larga` tira o limite — é o que a ata da reunião usa, porque numa ata de 20 pontos a medida deixava metade do cartão vazia (576px de texto num cartão de 1155px, medido em 09/09/2026). O resumo executivo do módulo Ações segue com a medida |
| `.grav-pill` | controle único de gravação (Gravar/Pausar/Concluir) |
| `.btn-pdf` | ação discreta dentro de célula de tabela |

Os que nasceram no Dashboard:

| Classe | O que é |
|---|---|
| `.rank` / `.rank-linha` | ranking horizontal: rótulo · barra · valor. **Não** confundir com `.barra`, que é progresso de 70px dentro de célula |
| `.par-mes` | par "mês fechado × mês corrente" numa moldura só |
| `.regua` | contraste de duas partes numa barra (resolvido × não resolvido) |

Os que nasceram no quadro de Ações:

| Classe | O que é |
|---|---|
| `.avatar` (`.av-0`…`.av-5`) | iniciais da pessoa. A cor é a POSIÇÃO dela na lista de usuários por nome — a mesma regra no Jinja e no JS |
| `.etiqueta` | rótulo curto, com `×` opcional |
| `.gaveta` + `.gaveta-fundo` | painel lateral por cima da tela. Animado por `transform`, e sem `rAF` (§6) |
| `.modal.modal-largo` | `<dialog>` com formulário. Escreva as DUAS classes: `.modal` vem depois no arquivo e o max-width de 400px dele venceria a classe solta |
| `.editavel` | textarea que parece texto até o hover — campo que se lê mais do que se edita |
| `.cartao-k` | cartão do quadro, com a faixa de prioridade à esquerda |

**Cartão recolhido** (`.card.recolhido` + `hidden` no `.card-b`, com o botão no
`.card-h`): o cartão vira uma linha só até alguém clicar. É para formulário que
existe mas não é o motivo de a pessoa ter aberto a tela (nasceu com o
"Comentário do gestor" e a "Definição" da ação, que o painel lateral substituiu
em 29/09/2026 pela caixa única de atividade e pelos campos editáveis no lugar). A regra do CSS tira a borda de
baixo do cabeçalho enquanto está fechado; sem ela sobra um risco separando o
nada. O estado **não** é guardado: depois de enviar, a página recarrega fechada,
que é o estado de leitura. Quem abre uma ação vem ver o que ela é e o que foi
feito, não editar.

**Nada de `confirm()` do navegador.** Ele abre uma caixa do sistema, com o
domínio no topo, que não pertence à tela — use `.modal` com `<dialog>`. As
telas antigas ainda usam `confirm()`; ao mexer numa delas, troque — foi
assim que o de apagar ação, no `acao_detalhe.html`, virou `#dlg-excluir`.

---

## 6. Armadilhas — cada uma custou tempo

**Flask serve template velho.** Fora do modo debug o Jinja não recarrega. Ao
testar local, ligue `app.jinja_env.auto_reload = True`, ou reinicie
(`pkill -f create_app`) depois de editar `.html`. Sintoma: sua mudança "não faz
nada".

**PostgREST corta em 1000 linhas.** `db-max-rows` é 1000 e um `limit` maior é
**ignorado em silêncio**. Precisa de mais? Pagine com `Range`/`offset` e ordem
estável — veja `troca_poste._select_paginado()`.

**Especificidade do CSS.** `.field label{display:block}` e
`.field input{width:100%}` vencem uma classe solta. Aninhe
(`.lista-marcar .linha-marcar`) em vez de brigar com `!important`.

**`hidden` perde para `display:flex`.** Em elementos com display explícito, use
`style.display`, não o atributo `hidden`.

**Chips que se reconstroem roubam o clique.** Recriar o HTML dos chips a cada
clique troca o nó sob o cursor e o clique seguinte cai num nó já removido.
Rerenderize só a classe (`render(comChips=false)`).

**Coletor: `empresa=todas` é obrigatório.** O relatório `operacional8` tem um
campo `empresa` que, se omitido, faz o WVSA devolver **só a Unetvale**. Isso
apagou 70% dos dados por dois meses sem ninguém notar. Está documentado em
`coletor/extrator.py:buscar_intervalo`. `infra=S` é armadilha: **restringe** a
infra, não inclui.

**O coletor apaga antes de gravar.** `limpar_intervalo()` deleta o intervalo e
regrava. Existe uma trava (`conferir_encolhimento`) que aborta com código 2 se a
resposta vier com menos da metade das empresas. **Nunca rode `--full` sem
backup do `dados.db`.**

**`acao_eventos` é append-only por trigger.** Nem a `service_role` faz UPDATE ou
DELETE. Para limpar dado de teste é preciso
`alter table ... disable trigger acao_eventos_imutavel`, apagar, e **reativar**.

**`ADMIN_EMAIL` é `teste@local`**, não o e-mail do Jhoni na tabela `usuarios`.
Um teste que monta sessão com o e-mail do banco **não** é admin.

**IQI/IQM exclui infraestrutura.** O regex `_INFRA` em `routes.py` tira
`INFRA *` e `FANDARUFF` — é regra de negócio, não bug. Supervisor de infra
legitimamente vê zero no IQI (a tela explica).

**`WAVE SUPERVISOR` é apelido de `WAVE`.** O mapa vive em
`supervisores.APELIDOS_EMPRESA` e é servido ao JS pelo template. **Uma
definição só** — duas cópias divergem e o filtro perde técnico sem erro na tela.

**`MediaRecorder.start(timeslice)` não serve para cortar áudio.** Só o primeiro
pedaço carrega o cabeçalho do container; os seguintes não são arquivo válido
sozinhos e o Whisper os recusa. `app/static/js/reuniao.js` **rotaciona** o
gravador (`stop()` + `start()`) para que cada trecho seja um arquivo completo.

**Safari grava `audio/mp4`, não `webm`.** Sem escolher o formato por
`MediaRecorder.isTypeSupported`, a gravação no iPhone falha calada — e é do
celular que a reunião costuma ser gravada.

**A Vercel limita o corpo da requisição (~4,5 MB).** Por isso o áudio sobe
direto para o Storage com URL assinada (`supa.storage_assinar_upload`) e nunca
passa pelo Flask. Mandar o arquivo para uma rota funciona no teste com 30
segundos e quebra na reunião de verdade.

**Tokens de raciocínio saem do `max_tokens`.** O `gpt-oss` é modelo de
raciocínio: com `max_tokens=400` ele gastou 398 pensando e devolveu `content`
**vazio**, com `finish_reason="length"` e HTTP 200 — nenhum erro. `app/ia.py`
manda `reasoning_effort` (env `GROQ_REASONING_EFFORT=low`, que derruba o
raciocínio de ~400 para ~14 tokens) e **levanta** quando a resposta vem vazia.
Devolver `""` em silêncio produzia ata com seção em branco.

**O modelo inventa o ano de uma data sem ano.** "dia dez de setembro" virou
`2023-09-10` — prazo três anos no passado, que entra numa coluna `date` sem
ninguém reclamar. `ia.gerar_ata` recebe a **data da reunião** como âncora (e não
"hoje", para regerar a ata meses depois não mudar prazos), e `_data_iso` descarta
o que cai fora da janela de 1 ano atrás a 3 à frente.

**Storage do Supabase: três recusas com a mesma cara.** Todas dão 400 e nenhuma
diz o motivo óbvio. (a) Assinar upload para um caminho que **já tem objeto**
exige `x-upsert: true` no **cabeçalho** — no corpo não vale, e sem isso o
reenvio de um trecho após queda de rede volta 409. (b) `POST`/`DELETE` com
`Content-Type: application/json` e corpo vazio são recusados: o sign manda
`json={}`, e o delete **remove** o cabeçalho. (c) `DELETE` de objeto inexistente
devolve **HTTP 400 com `"statusCode":"404"` no corpo** — conferir só o status
deixa o expurgo travado para sempre no mesmo registro.

**GET no Storage serve do cache depois do expurgo.** Apagar funciona, mas a
leitura autenticada ainda devolve o arquivo por um tempo. Para conferir se um
objeto sumiu, use o endpoint de listagem, não o GET.

**O limite que morde na Groq é TPM, e a tabela do site mente sobre ele.** A
página de modelos mostra os limites do *Developer Plan*; a conta gratuita
(`on_demand`) tem **8.000 tokens por minuto**, 31x menos. O número verdadeiro
está no header `x-ratelimit-limit-tokens` de qualquer resposta — **meça, não
leia**. Pior: o `max_tokens` reservado para a RESPOSTA conta nesse teto, então
reservar 8.000 estoura a cota sozinho, antes de mandar uma linha (HTTP 413
"Request too large"). Vive em `GROQ_TPM` no `.env`, e `ia.cabe()` recusa cedo
com mensagem explicando, em vez de deixar o 413 aparecer no meio da ata.

**Com 8.000 TPM, a ata NÃO sai da transcrição crua.** Uma reunião de 60 min tem
~15.700 tokens e nunca cabe numa chamada. O caminho normal é pelas notas por
trecho — que é justamente por que elas são calculadas durante a reunião, com o
trecho ainda na mão. Reunião muito longa nem com notas cabe: aí a ata sai
**carimbada como parcial**, nunca cortada em silêncio.

⚠️ Os 8.000 são teto de conta, não de plano mal configurado. Medido nos headers
em 08/09/2026: `openai/gpt-oss-120b` e `qwen/qwen3.8-27b` dão 8.000 TPM e 1.000
req/dia; só `groq/compound` e `compound-mini` dão 70.000 — e esses são
**agênticos**. Forçando, o compound visitou `g1.globo.com`, e
`compound_custom.tools.enabled_tools: []` é **ignorado em silêncio** (o schema é
validado, um nome inválido dá 400 listando as ferramentas, mas lista vazia não
desliga nada). O que desliga a web é restringir a lista a uma ferramenta que não
navega (`wolfram_alpha`). Enquanto isso não for necessário, transcrição de
reunião interna não vai para modelo que pode navegar.

**Quem ORÇA e quem COBRA tokens tem de medir a MESMA string.** `_texto_para_ata`
escolhia o texto medindo só o corpo; `ia._conversar` cobrava sistema + contexto +
texto. A diferença — 709 tokens só do `ESQUEMA_ATA`, mais data, participantes e
pauta — reprovava a ata **depois** de a reunião acabar: em 08/09/2026, 13 trechos
transcritos, notas com 3.794 tokens ("cabem" nos 6.800) e a requisição saindo com
4.581. Pior, o degrau de corte cortava em exatamente `ORCAMENTO - MAX_TOKENS_ATA`,
sem espaço para o esquema — ou seja **nunca passava**, e reunião longa jamais
produziu ata, nem carimbada como parcial.

Hoje a conta é uma só: `ia.plano_ata` mede o prompt inteiro (`_sistema_ata` +
`_contexto_ata`, as mesmas funções que `gerar_ata` envia) e devolve
`(chars_que_cabem, max_tokens_da_resposta)`. A ordem das concessões importa:
encolhe primeiro a **resposta**, até `MIN_TOKENS_ATA` (1.600), e só então corta a
**entrada** — ata mais enxuta ainda cobre a reunião toda, entrada cortada perde o
fim da conversa, que é onde se combina o que fazer. Com isso o teto prático subiu
para ~26 min de reunião no plano gratuito.

⚠️ Dois arredondamentos moram aí, e os dois já morderam. O orçamento fixo é
medido na string **concatenada** (somar `tokens_aprox` de cada pedaço trunca duas
vezes e a conta fechou em 6.801 contra 6.800: reprovada por UM token), e a
reserva do texto usa `math.ceil` (arredondar para baixo devolvia um espaço três
caracteres menor que o próprio texto, e a ata saía carimbada como "parcial" por
causa de um caractere).

**`datetime.now()` grava 3 horas no passado.** Ele devolve hora local
ingênua; numa coluna `timestamptz` o Postgres lê o valor sem fuso como se já
fosse UTC. `ata_gerada_em`, `encerrada_em` e `atualizado_em` nasciam antes do
fato que registram. Use `datetime.now(timezone.utc)` — é o `_agora()` de
`acoes.py` e de `reuniao_ia.py`. As colunas com `default now()` sempre
estiveram certas: o erro só aparece no que o Python escreve.

**Ids de modelo da Groq mudam.** Ficam em `GROQ_MODELO_*` no ambiente. Cravados
no código, viram um HTTP 400 sem explicação no dia em que a Groq aposentar o id.

**Campo novo de formulário sai sem estilo.** A regra do `style.css` lista os
tipos um a um (`text`, `number`, `password`, `email`, `date`, `time`,
`datetime-local`, `search`). Um tipo fora da lista cai no visual nativo do
navegador — borda quadrada, fonte do sistema, altura diferente — no meio de
campos arredondados. Foi o que deixou o filtro das Reuniões e o De/Até da Troca
de Poste com cara de outro site. Ao usar um tipo novo, acrescente-o à regra.

**Coluna nova vai no conjunto ESTENDIDO, nunca no base — e o recuo é em
DEGRAUS.** `acoes.py` lê as reuniões com `_select_reunioes(filtro, extras)`, que
tenta três conjuntos, do mais novo para o mais antigo: `_COLS_OPCIONAIS`
(`puxar_pauta`, migration 0015), `extras` (as colunas de gravação, 0006) e o
base. Esse recuo existe porque o deploy e a migration não acontecem no mesmo
segundo. Pôr a coluna nova no conjunto **base** quebra o recuo junto — e aí, sem
a migration, a reunião não abre. Já aconteceu com `convidados`.

⚠️ E ele era tudo-ou-nada até 08/09/2026: bastava a coluna mais nova faltar para
o estendido INTEIRO cair, e `gravacao_status`/`ata_markdown` sumirem da tela de
todas as reuniões — a coluna estava no lugar certo, mas levava a ata junto.
Medido antes de a `0015` subir. Ao acrescentar a próxima coluna opcional, some
um degrau em `_DEGRAUS_OPCIONAIS`; não a enfie no `extras`.

**Recuo de migration só pode disparar em erro de COLUNA — use
`supa.coluna_faltando(e)`.** Todos esses recuos tratavam QUALQUER exceção como
"a migration ainda não subiu". Bastava alguém abrir `/reunioes/xx` — um id que
não é uuid — para o `except` concluir que a coluna não existia e desligar o
conjunto estendido do processo INTEIRO: dali até o próximo cold start, todas as
reuniões eram servidas sem ata, sem gravação e sem itens, para todo mundo. Uma
URL adivinhada degradava o container.

Medido em 09/09/2026 no corpo do 400 do PostgREST: coluna inexistente devolve
`code 42703`; uuid inválido, `22P02`. `supa.coluna_faltando` lê esse código e
devolve **False** quando o corpo não é JSON — recuar "na dúvida" é justamente o
que causou o problema. Qualquer recuo novo por migration passa por ela.

Tabela que a migration ainda não criou dá outro erro: **HTTP 404 com `code
PGRST205`** (medido em 29/09/2026 com `acao_checklist`). Para esse caso existe
`supa.tabela_faltando(e)`, pela mesma razão.

**Recuo sem nenhuma leitura ainda é "não sei", não "não existe".**
`acoes.tem_etiquetas()` só sabia a resposta depois de alguma leitura de ação no
processo; um cold start da Vercel caindo direto no `POST /acoes/nova` descartaria
as etiquetas da primeira ação em silêncio. Hoje, sem saber, ela sonda uma linha.

**Campo travado durante a gravação engole o que se digita.** O checklist
desabilitava o campo enquanto o item ia ao servidor; medido no ensaio de
29/09/2026, de três itens digitados em seguida entrou UM. Hoje o item aparece
na hora (esmaecido), as gravações vão em FILA, o painel só recarrega quando a
fila esvazia, e o recarregamento devolve o que estiver escrito no campo de
novo item e na caixa de atividade.

**Data de `timestamptz` cortada do texto ISO está em UTC.** `criado_em[:10]`
põe o que foi feito às 21h de 29/09 em 30/09. Converta com o fuso fixo
(`timezone(timedelta(hours=-3))`, como `dados.BR_TZ`) — é o `acoes._hora_local`.

**O feed "Últimas atualizações" do Painel de Ações não tinha recorte** até
29/09/2026: `ultimos_eventos()` trazia o texto dos eventos de TODAS as ações, e
quem só enxerga as próprias lia os dos outros no Painel. Hoje recebe os ids que
a pessoa vê.

**Servidor de ensaio que bloqueia só tabela não bloqueia o Storage.** O
`expurgar_audio` APAGA o arquivo antes de marcar a tabela. Em 29/09/2026 um
servidor de verificação que recusava escrita em tabela real abriu a aba
Reuniões, e dois trechos de áudio já vencidos (`81dc1245…/0000` e `0001`) foram
apagados do Storage de produção, com a marcação na tabela recusada. Sem dano
duradouro — o próximo expurgo trata "não existe" como sucesso e marca —, mas
servidor de ensaio tem de recusar `storage_*` também.

**`ignorarMassivas=S` é o padrão do `operacional31` e apaga a segunda maior
causa.** Medido em 29/08/2026, IQI de 07/2026: com `S` vêm 156 linhas e 2 de
Falha Massiva; com `N`, **212 linhas e 58**. Os 56 da diferença são exatamente
os de Falha Massiva. Com `S` o ranking de causa raiz sai com a segunda causa
zerada e o total continua parecendo plausível — ninguém repara. Mesma família
do `empresa=todas`. `apenas_pendentes` é irmã dela: vem **marcada** no
formulário e reduz a resposta às OS ainda não classificadas (13 linhas em vez
de 212). Não envie o campo.

**Somar os técnicos NÃO dá o indicador.** O IQI/IQM das telas saía da soma das
séries por técnico e não batia com o `indicadores4` do WVSA — medido em
01/09/2026, IQM de 07/2026: **8,78% na tela contra 7,49% no relatório**. São
dois motivos, e eles andam em sentidos opostos, então não se cancelam:

* **técnico que sai desaparece do `select`** e leva a história dele junto. Em
  01/2026 o total de OS do IQI caía de 757 (WVSA) para 493 (soma) — 35% a
  menos; a "RW Telecom" inteira sumiu, com 15 reincidências só naquele mês.
  Como o payload é regravado inteiro a cada rodada, isso **piora sozinho**:
  cada saída reescreve o passado;
* **OS com dois técnicos conta duas vezes** na soma. No IQM de 07/2026, 19 dos
  134 contratos reincidentes tinham 2+ técnicos distintos.

Hoje o coletor traz a série consolidada em `payload["geral"]`
(`w8_client._serie_geral`), pedindo a **mesma URL que a página do WVSA carrega
sozinha** — sem os segmentos de técnico/empresa/massivas.
`gerencial._consolidado_mensal` lê dela e só recua para a soma enquanto a
primeira coleta não roda, dizendo `fonte: "soma"` para a tela não afirmar
"WVSA" sobre número que não é.

⚠️ O consolidado **inclui infraestrutura e inclui quem já saiu**; o ranking por
técnico do `/iqi` exclui infra e exige o mínimo de OSs. Os dois estão certos e
não fecham entre si — as duas telas dizem isso, e é por isso que o `/iqi` tem
um KPI "do mês (WVSA)" ao lado dos contadores do ranking.

E não, **`ignorarMassivas` não era o problema aqui**: medido no mesmo dia, a URL
sem o segmento devolve exatamente o mesmo que `/0/0/S`. O padrão do servidor é
`S`, e o coletor sempre esteve certo nesse ponto — ao contrário do
`operacional31` logo acima.

**A aba "Indicadores" do `operacional31` ignora o filtro `tipo`.** `tipo=iqi` e
`tipo=iqm` devolvem Cat 4/Cat 5 idênticos (Total 3548 nos dois, medido em
29/08/2026). A aba é agregada e tentadora, mas o split IQI/IQM que a tela
precisa só existe na **tabela de detalhe**, que respeita o filtro — daí a
agregação ser feita em `gerencial.parse_categorias`, e não lida pronta.

**O IDF (`indicadores9`) devolve HTTP 200 com tudo ZERADO para quem não tem o
recorte** — não 403. Medido em 29/08/2026, mesmo endpoint e mesmo período:
`jhoni.santos` recebeu "Sem dados" nos três canais; `matheus.vieira`, 211
ligações (4,58), 1087 chats (4,48) e 297 OS (4,51). Um coletor com a
credencial errada gravaria zeros e reportaria sucesso.
`gerencial.conferir_idf_vazio` recusa gravar zero por cima de número bom.
(`operacional15`, esse, dá 403 limpo.)

**Cat 4 tem rótulos duplicados no cadastro do WVSA.** Convivem
`OS de Suporte em aberto` (38) e `OS de suporte em aberto` (27), e
`Cancelou visita` aparece duas vezes. Sem juntar, a mesma causa vira duas
barras e nenhuma alcança o topo. O mapa `_CAT4_SINONIMOS` é **explícito** de
propósito: um `.lower()` cego esconderia que o cadastro tem duplicata.

**Filtrar motivo de cancelamento por texto traz o que não é do grupo.**
"PROBLEMA TECNICO" casa com seis motivos, mas o grupo PROBLEMA TECNICO tem
quatro — `PROBLEMA TECNICO/MASSIVA` e
`INADIMPLENTE SEM USO / PROBLEMA TECNICO/...` ficam de fora dele. Os quatro
somam 66 (o total do grupo); os seis somam 70, e a soma da lista deixaria de
bater com o percentual do CMT logo acima, na mesma tela. Peça o recorte AO
relatório (`motivos_grupos : problema tecnico`), como faz
`_motivos_do_grupo_tecnico`.

**`.charts-2` tinha mínimo de 380px, maior que um iPhone de 375.** A coluna
estourava a página em ~27px e o corpo inteiro rolava de lado, em todos os
módulos que usam a classe. Agora é `minmax(min(380px,100%),1fr)`. E
`.view-switch` era `overflow:hidden`: com quatro abas cabia, com cinco as
últimas ficavam **escondidas e inalcançáveis** no celular. Ao acrescentar aba,
confira no preset mobile.

**"Mês fechado" é conta de calendário, não posição na lista.** O Dashboard
decidia o selo pela posição ("o último exibido é o parcial"), e com isso
**julho apareceu FECHADO no dia 29/08** — faltava um dia para a janela de
auditoria vencer — enquanto o `/iqi`, na mesma hora, dizia "Julho (Parcial)".
Duas telas, o mesmo mês, respostas diferentes. A regra agora é
`gerencial.mes_fechado` (fim do mês + `JANELA_AUDITORIA_DIAS`), espelhando o
`mesFechado` do JS. **São 30 dias para IQI e IQM**, e não a janela real de cada
um (IQI 30, IQM 15), porque é o que as três telas do `/iqi` usam — corrigir
isso exige mexer nos quatro lugares juntos, senão troca uma divergência por
outra.

⚠️ Churn e IDF **não** têm janela: cancelamento é fato do dia, feedback é do
mês. Para eles vale `gerencial._mes_em_curso` (o mês acabou, fechou). Aplicar
os 30 dias ali marcaria julho como parcial em pleno setembro.

**O botão "Atualizar" mora no `/monitoramento`, não na topbar.** Forçar coleta
é ação de operação, e o Monitoramento é `admin_obrigatorio` — logo, **quem não
é admin não força mais coleta**, só lê o estado. Foi decisão consciente ao
tirar o botão da barra. O `app.js` já saía cedo quando o botão não existia
(`if (!btn) return`), então mover o mesmo `id` para outra tela bastou.

**Falha de um módulo apagava o dado bom dele.** `marcar_erro` chamava
`supa_upsert`, que manda `payload`, `status` e `atualizado_em` juntos: o
histórico do módulo era substituído por `{"erro": ...}` e o carimbo era
renovado — o card do Monitoramento voltava a dizer "Atualizado há 2 min" com o
dado destruído. Aconteceu em 29/08/2026 com a Produtividade, o maior payload de
todos. Hoje existe `supa_marcar_status`, que faz PATCH só de `status`. A
mensagem do erro nunca dependeu disso: ela vai para `coletor_log`. Efeito
colateral: `atualizado_em` voltou a significar "quando o dado ficou bom", então
"Erro" e "Desatualizado" agora podem coincidir — é o estado real de um módulo
quebrado há dias.

**A coleta é SEQUENCIAL e leva ~8 min — metade dos cards com data velha no meio
da rodada é normal.** Cada módulo só ganha carimbo novo quando termina, nesta
ordem: produtividade, iqi, iqm, massivas, e os cinco `ger_*`. Em 31/08/2026 a
tela foi aberta às 09:15, entre a gravação do `iqm` (09:14:27) e a do `massivas`
(09:16:56) — e os seis módulos que faltavam, exibindo o carimbo de 29/08,
passaram por quebrados. Por isso `enviar.py` grava `log_evento("geral",
"inicio", ...)` e `dados.rodada_em_andamento()` existe: quem ainda não foi
coletado recebe o selo **Na fila**, não "Desatualizado". O teto de 30 min para
considerar a rodada viva é o mesmo `timeout=1800` com que o watcher mata o
`enviar.py` — sem teto, um coletor morto deixaria a tela "coletando" para
sempre.

**"Desatualizado" sem causa treina a equipe a ignorar o selo.** Máquina
desligada, máquina de pé fora da VPN e coleta em andamento produzem a mesma
idade nos cards. O `coletor_heartbeat` (migration 0011, uma linha só, `check
(id = 1)`) separa os três: o watcher pulsa de 2 em 2 min gravando `visto_em` e
o `wvsa_ok` que ele **já calcula**. O pulso vem ANTES do `if ok` no laço — é
justamente quando o WVSA está fora que a tela precisa saber que a máquina está
viva.

**O teto do botão "Atualizar" era menor que a rodada.** `app.js` alertava
"coletor offline" depois de 5 min, e a rodada leva ~8 — ou seja, toda
atualização manual terminava em alerta falso com a coleta ainda rodando. Hoje
são 15 min, e o botão mostra o progresso (`3/9`).

**`dados.MODULOS` não é a lista de cards — é o whitelist do `/api/ingest`** e a
chave de `dados_modulo`. A Troca de Poste não mora naquela tabela, então entra
na grade do Monitoramento por fora, via `troca_poste.resumo_coleta()`, com
limiar próprio (26 h, porque a Celesc roda 2x/dia). Enfiá-la em `MODULOS`
abriria a rota de ingestão para um módulo que ninguém ingere.

**Coleta parada com badge verde.** A Celesc ficou de 26/08 a 31/08/2026 sem
coletar e o Monitoramento não avisou: o histórico mostrava as linhas antigas com
`ok`, e não havia card de frescor. Nenhum histórico substitui um selo de idade —
ninguém confere data de linha de tabela.

**A virada do mês esvaziava o Dashboard inteiro.** Causa raiz e cancelamentos
abriam no mês MAIS RECENTE da lista. No dia 1º isso é o mês que começou
ontem à meia-noite: em 01/09/2026, com a coleta recém rodada e agosto inteiro
gravado, nove blocos diziam **"Sem dados ainda. A próxima coleta preencherá
este bloco"** — a coleta já tinha rodado, e a tela mandava conferir o coletor
por um mês que ainda não aconteceu. Agora o servidor escolhe em
`gerencial.mes_padrao` (último mês COM dado), que é o mesmo critério que o
`/iqi` usa desde sempre ("padrão = último homologado"), e o texto de bloco
vazio diz o que é: "Nenhuma reincidência de IQI registrada em setembro/26 até
agora". ⚠️ Mês sem registro **não** é falha de coleta — nenhum texto da tela
pode sugerir que é. Na mesma virada, o IDF mostrava **"0,00"** num canal com
zero avaliações: zero avaliação não é nota zero, e agora sai "—".

**Etapa travada não atrasa a rodada seguinte: ela CANCELA todas.** O launchd
não começa uma segunda cópia de um job que ainda está rodando, e não avisa. Em
31/08/2026 o `tp:coletar` das 13h terminou o trabalho às 13:03 e o processo
node ficou vivo **mais de 20 horas** sem fazer nada; com ele de pé, a coleta
das 07h do dia 01/09 simplesmente não rodou, e o `/monitoramento` seguiu verde
porque o limiar da Celesc é 26 h. Hoje `coletar_celesc.sh` tem prazo por etapa
(`LIMITE_ETAPA`, 20 min) com um cão de guarda que mata o **grupo de processo**
— matar só o `pnpm` deixaria o `tsx`/`node` filho, que é justamente quem
trava, segurando o job do mesmo jeito. Isso exige `set -m`.

**`tp:coletar` sai com código 0 mesmo com TODAS as cidades falhando.** Ele
trata a falha por cidade e segue. Medido em 01/09/2026 12:32 UTC: as 11
cidades deram `fetch failed` (queda passageira — dois minutos depois o mesmo
endereço respondia 200) e a rodada registrou "coleta da Celesc concluída" com
`total: 0`. Sucesso na cara de quem lesse o log. `coletar_celesc.sh` agora lê
o `total` do `coleta_concluida` que o próprio job gravou e recusa a rodada
vazia, em vez de seguir para o geocodificar e o match sem nada nas mãos.

**O launchd dispara o job num DARK WAKE, e a máquina volta a dormir 2 s
depois.** Este é o modo de falha mais caro da Celesc, porque não se parece com
nada: em 02/09/2026 o job das 07h começou às **07:06:57** — exatamente o
`DarkWake` que o `dasd` tinha agendado — e o `pmset -g log` mostra
`Entering Sleep state` às **07:06:59**. Dali em diante a rodada andou só nas
frestas de 2–6 s de dark wake: **58 minutos de relógio para produzir quatro
linhas de log**, numa rodada que leva 2 min, até morrer com
`read EADDRNOTAVAIL` — a interface de rede some no sleep e o socket não
consegue nem fazer `bind` ao acordar. O `/monitoramento` ficou anunciando uma
coleta "executando" que não tinha processo nenhum atrás.

`coletar_celesc.sh` agora se re-executa sob `caffeinate -ims` (`-i` segura o
idle sleep na bateria, `-s` o system sleep na tomada, `-m` o disk sleep). O
re-exec é `exec caffeinate … /bin/bash "$0"`, com `/bin/bash` **explícito**: o
`caffeinate` faz `execvp` e dependeria do bit de execução do arquivo. O
`caffeinate` guarda um filho segurando a asserção e executa o utilitário no pid
original — `ps` mostra `bash` como pai e `caffeinate` como filho, e isso é
`exec` bem-sucedido, não o contrário. ⚠️ Nada disso vence **lid fechado na
bateria**: aí o macOS dorme de qualquer jeito.

**Horário fixo perdia a rodada inteira — e é o caso NORMAL desta máquina.**
De 15/09 a 29/09/2026 a rodada das 07h falhou todos os dias, e a das 13h de 27
e 28/09 também: três dias sem dado novo. O `pmset -g log` mostrou o Mac na
bateria, tampa fechada, nos dois horários — o `caffeinate` criava a asserção e
o sistema dormia 2 s depois. Saía `getaddrinfo ENOTFOUND` do pooler 1 s após
começar (a rede nem tinha voltado), ou a rodada andava aos pedaços até
`Connection terminated`. E a próxima chance era 6 h depois.

Hoje o plist chama a cada **15 min** (`StartInterval`) e o script decide:
(1) a rodada do último horário da grade (`HORARIOS="7 13"`) já saiu? sai
calado; (2) tampa fechada **na bateria**? adia (na tomada é clamshell, fica
acordado); (3) sem rota até a Celesc **e** o pooler? adia. Quem diz que saiu é
`~/unetvale-coletor/celesc.ultima_ok`, gravado só quando as TRÊS etapas
terminam. O horário vira "a partir de": às 07h fechado, a coleta sai no
primeiro tique depois que alguém abre a tampa. ⚠️ Por isso `launchctl
kickstart` sozinho **não** coleta quando o carimbo está em dia — para forçar,
`CELESC_FORCAR=1 /bin/bash ~/unetvale-coletor/coletar_celesc.sh`.

**O espelho do Geogrid rodou UMA vez e continuou valendo como atual.** A
única varredura foi em 27/08/2026 (142 células, 12.382 itens, 2.966 cabos), e
`ponto_coberto` perguntava só se a célula tinha sido varrida, nunca QUANDO:
cabo lançado depois não existia para o match, e o desligamento podia sair
`sem_rede` ou com risco menor que o real. Três coisas que valem saber:

* **Não existe "só o que mudou".** A API do Geogrid que o job usa responde
  "tudo num raio de 600 m", e o `dataCadastro` do item só se lê depois de
  baixar a célula. Atualizar custa o mesmo que baixar da primeira vez (3
  chamadas, ~4,5 s por célula). O que barateia é escolher QUAIS células —
  daí o recorte por desligamento futuro: ~80 células contra 3.233 da malha
  inteira das 11 cidades;
* **o ressync é upsert por `id_geogrid`**: item novo entra, alterado é
  atualizado, **removido nunca sai**. Erra para o lado do alerta a mais;
* **a cobertura expira em 7 dias** (migration 20 do monorepo) e, por isso,
  `calcular_match_todos` passou a recalcular só de hoje em diante (e quem
  nunca teve análise). Sem a segunda metade, a primeira rodada viraria os 196
  `critico` do histórico em `indeterminado` — provado em transação com
  `rollback`: 313 recalculados, passado idêntico linha a linha.

Geocodificar e sincronizar são etapas **moles** do `coletar_celesc.sh`: a
falha delas não impede o match (o que foi gravado vale), mas a rodada sai COM
FALHA e o carimbo não é gravado. Só a coleta para a rodada.

**A fila de geocodificação andava para TRÁS.** `buscarPendentesGeo` (monorepo)
pegava 25 por rodada em `order by data_evento` crescente, sem filtro de data.
Em 29/09/2026 havia 389 na fila, entravam 30–100 avisos por dia, e a cota ia
toda para desligamento que já tinha passado: **os 305 da tela estavam sem
posição, todos "indeterminado"** — o módulo inteiro sem classificação de risco,
com coleta verde. Hoje a ordem põe hoje-em-diante primeiro, e o script passa
`GEO_LIMITE` (150; ~3 s por endereço, ~8 min) em vez dos 25 do job. Sintoma a
reconhecer: KPI "Indeterminado" perto do total de trechos.

**O cão de guarda por `sleep` não anda enquanto a máquina dorme.** Corolário do
anterior, e a razão de ele não ter latido: o prazo de 20 min existia desde
31/08/2026, a etapa arrastou 58 min, e o log saiu `FALHOU (código 1)` — nunca
`DERRUBADO`. O `sleep 1200` dormia junto com o Mac. Hoje o prazo é por
**relógio de parede** (`date +%s` num laço que cochila 30 s por vez), então
tempo dormido conta e a rodada morre com diagnóstico em vez de arrastar por
horas.

**Coleta que morre no meio fica `executando` PARA SEMPRE.** `abrirColeta`
insere a linha com `status='executando'` e quem a fecha é o `gravarColeta`, no
fim — uma exceção no laço das cidades nunca chega lá. São **duas** defesas, e
elas não são redundantes:

* `cli.ts` (monorepo) marca a coleta como `erro` no `catch` do `main()`;
* `troca_poste._status_exibicao` (portal) mostra `executando` com mais de
  `COLETA_EXECUTANDO_MAX_MIN` (30 min) como **interrompida**.

A segunda existe porque a primeira não cobre o caso que gerou o problema:
quando **a rede é o que falhou**, o UPDATE de socorro falha junto. O status cru
do banco não é reescrito pelo portal — `status` segue o que está lá e a tela lê
`status_exibicao`.

⚠️ O card de frescor **nunca** foi enganado por isso: `resumo_coleta` e
`ultima_coleta` filtram `status in.(ok,parcial)`. Quem mentia era só o
histórico.

**`L.marker` do Leaflet vendorizado nasce quebrado.** O ícone padrão busca
`vendor/images/marker-icon.png`, `-2x` e `-shadow` — três PNGs que a
vendorização não trouxe. Dá 404 e o pino vira retângulo. O mapa de
desligamentos nunca esbarrou nisso porque desenha `circleMarker` (SVG). O pino
arrastável da revisão usa `L.divIcon` com SVG inline e os tokens de cor da casa
(`troca_poste_revisao.js`): resolve sem acrescentar binário ao repositório.

**`desligamentos.bairro_norm` NÃO serve para agrupar por bairro.** Ela é
`generated always as (normalizar_texto(bairro_raw))` — do bairro **bruto**, que
vem com o código da cidade grudado ("CALHEIROS - GCR", "ESCALVADOS (NAVEG)").
O bairro limpo é a coluna `bairro`, criada depois (migration 14 do monorepo).
Agrupar pelo `bairro_norm` separaria o mesmo bairro em dois grupos conforme a
Celesc tenha ou não posto o sufixo naquele aviso. A chave de agrupamento sai de
`normalizar_texto(bairro)`, calculado **no banco**, dentro de
`troca_poste.criar_os_bairro_dia`.

**Chave de idempotência derivada de linha recém-criada nunca colide.** A
`chave_idempotencia` das OS era `os:{agrupamento_id}:{data}`, e o
`agrupamento_id` nascia a cada clique — então o `unique` da coluna existia no
papel e valia **zero**: dois cliques criavam duas OS para o mesmo lugar. Hoje a
chave é `os:bairro_dia:{cidade}:{bairro_norm}:{data}`, que é estável, e o banco
recusa a segunda. Chave de idempotência tem que sair do FATO, não do registro.

**Coluna de controle que ninguém lê é pior que coluna inexistente.**
`ordens_servico.dry_run` existia desde a migration 09 e o `enviar_os.py`
mandava o POST do mesmo jeito — não havia como conferir o payload sem criar OS
de verdade num sistema de produção. Hoje ele para em `status='ensaio'`, e o
ensaio nem precisa de VPN: termina antes da requisição. São **dois**
interruptores, de propósito: `OS_ENVIO_HABILITADO` mostra o botão,
`OS_DRY_RUN=false` faz a OS sair.

⚠️ E os dois são variáveis **do app**, na Vercel. O `enviar_os.py` obedece à
COLUNA `dry_run` da ordem, nunca à variável — pôr `OS_DRY_RUN` no `.env` do
coletor não muda nada. A ordem carrega a decisão tomada quando foi criada:
virar a chave não transforma em envio real o que já está gravado como ensaio.

**Fora da VPN, o envio marcava `erro` no que ninguém tentou enviar.** O login
no WVSA falhava e a ordem ia para `erro`, obrigando um clique novo — quando a
causa era só a máquina não estar na rede. `enviar_os.alcancavel()` sonda antes e
deixa a ordem em `pronta`, que é o que a mensagem "Aguardando o coletor" da tela
já pressupunha.

**Lista longa empurra o painel vizinho para fora da tela.** A fila de revisão
tem 178 endereços; sem `max-height` ela jogava o mapa ao lado para **15.000px**
abaixo do topo, e no celular (coluna única) clicar numa linha não mostrava nada
— nem `scrollIntoView` chegava lá a tempo. `.tp-fila` limita a 420px, a mesma
altura do mapa, com `thead` grudado. O precedente é o `.lista-marcar`.

**O texto da OS existe DUAS vezes, e quem envia é o Python.**
`app/solicitacao.py` (Flask) e `packages/utils/src/troca-poste/solicitacao.ts`
(monorepo) implementam o mesmo contrato. O caminho real de envio passa pelo
Python; o TypeScript não tem caller de envio. Em 04/09/2026 o bloco
"NOSSA REDE NO LOCAL" (classificação, distância do cabo, poste de terceiro,
contagem de postes e siglas `CB_*`) saiu **só do Python**, a pedido: é
vocabulário do Geogrid, e quem está no poste não identifica ativo por sigla. A
classificação continua escolhendo os candidatos — ela só não é impressa. Ao
mexer num dos dois arquivos, saiba que o outro não acompanha.

**`invalidateSize` do Leaflet NÃO reenquadra.** Ele avisa o mapa do novo
tamanho e para por aí: o `fitBounds` que rodou com o container menor continua
valendo, e os pontos ficam apertados num canto do mapa já redimensionado. Quem
redimensiona depois precisa guardar os limites e reaplicá-los — é o
`reenquadrar()` do `troca_poste_mapa.js`.

Corolário que custou tempo: **observar o CONTAINER para saber quando remedir
não funciona**. Se a altura errada já foi escrita, ele não muda mais de tamanho
e o `ResizeObserver` nunca dispara — a medida errada se protege. Quem muda é a
página em volta (a legenda da malha só ganha altura quando o `rede.json`
responde), e é `document.body` que se observa.

⚠️ E há uma armadilha de MEDIÇÃO em cima dessa: com o painel do navegador
oculto, `requestAnimationFrame` não roda e o layout fica adiado, então o mapa
parece travado num estado que se resolve sozinho assim que a página é pintada.
Ao investigar layout pelo preview, force a pintura (um screenshot serve) antes
de concluir que há defeito.

**Formato novo no payload derruba o app VELHO — deploy do app ANTES do
coletor.** A Cat 6 virou lista dentro do registro, e o `agregar_categorias`
anterior a 29/09/2026 fazia `reg[i] >= 0` em todo campo: com o coletor novo
gravando antes de o app novo subir, `list >= int` é `TypeError` e o Dashboard
de produção cai. A ordem é: mergear → Vercel publicar → só então copiar
`coletor/*.py` para `~/unetvale-coletor` e rodar o backfill. Vale para
qualquer mudança de formato em `dados_modulo`: o app tem de aceitar o formato
novo E o antigo antes de o coletor começar a escrever.

**O RRO devolve SEMPRE as conversas em aberto**, qualquer que seja o período.
Pedindo só 01/09/2026 vieram 872 conversas de 01/09 e mais 69 abertas de
28-29/09. O `fim` é respeitado; é o "aberto" que escapa. O corte é refeito
por "Iniciado em" e a sala (id do link `/live/<id>`) deduplica entre janelas.

**`data-order` da célula de tempo do RRO não é o tempo.** "30 minutos 19
segundos" (1819 s) vinha com `data-order=654394`. Lê-se o texto.

**A página do AII (`operacional31`) GRAVA ao trocar um select.** Cada Cat 4/5/6
tem `onchange → POST /relatorios/operacional31/trocar-categoria`. O coletor
usa `requests` e nunca dispara isso — mas **nenhum teste pode automatizar essa
tela num navegador**: um `change` num select reclassifica o protocolo no WVSA
de produção.

**O drill do IDF é lento: ~5 s por chamada, ~45 chamadas por mês.** Medido em
29/09/2026: 501 s para dois meses com drill, contra segundos sem ele. Por isso
o drill sai 1x/dia e só no mês corrente (o anterior, só se nunca teve); a
lista de feedbacks vai em toda rodada.

**Módulo de cadência diária precisa ser ensinado ao Monitoramento.**
`dados.CADENCIA_DIARIA`: o limiar de "desatualizado" é 26 h, não 3 h; e numa
rodada em que ele já saiu hoje ele não conta no progresso nem fica "Na fila" —
sem isso o botão mostraria "9/10" a rodada inteira. Quem encerra a rodada é o
log `geral`, não o contador. O `enviar.py` registra "Já coletado hoje" no
`coletor_log` em vez de "Atualizado".

**Servidor local sem reloader não recarrega Python.** `use_reloader=False` +
`jinja_env.auto_reload` recarrega TEMPLATE, não `gerencial.py`: a chave nova
do pacote simplesmente não aparece no `window.__DASH__`. Reinicie o servidor
depois de mexer em `.py`.

**Pooler do Supabase: `aws-1-us-west-2`.** A região está no hostname; a errada
dá "tenant not found".

**A função rodava do outro lado dos EUA, e o estático passava pelo Python.**
Medido em 07/10/2026: `x-vercel-id: gru1::iad1::…` — a borda em São Paulo e a
FUNÇÃO em Washington (`iad1`, o padrão da Vercel), com o Supabase em Oregon.
Cada consulta atravessava o continente, sem reaproveitar conexão (cada
`requests.get` solto fazia TCP + TLS do zero), em série: `/acoes` fazia 15
idas e levava ~5,6 s; o painel lateral, ~3,5 s; arrastar um cartão, ~4,4 s
(medidos daqui, ~250 ms por ida). E o `vercel.json` mandava `/(.*)` para o
Python — todo CSS e JS invocava o Flask, com `no-cache`.

Hoje: `"regions": ["pdx1"]`, sessão persistente, `supa.paralelo` e leituras
embutidas, e o estático pela CDN com `immutable`. Medido no mesmo dia, mesma
máquina: `/acoes` 0,83 s, painel 0,80 s, mover 1,08 s, `/dashboard` de 5,35 s
para 0,99 s — e o HTML das 22 páginas comparadas (admin e usuário comum) saiu
IGUAL ao da `main`. Três consequências:

* **todo arquivo estático passa por `url_for('static', …)`.** O
  `@app.url_defaults` do `create_app` acrescenta `?v=<commit>`; é isso que faz
  o navegador buscar o JS novo depois de um deploy. Um caminho `/static/…`
  escrito à mão ficaria preso no cache de quem já abriu o portal por um ano;
* **`supa.paralelo` roda cada função numa cópia do contexto (`contextvars`).**
  É o que mantém o `flask.g` — os caches por requisição do `auth.py` e a
  contagem do `Server-Timing` — visível dentro das threads. Uma
  `ThreadPoolExecutor` crua perderia o `g` e cada thread refaria as consultas
  do usuário;
* **o `Chart.js` mora no fim do `<body>`, não no `<head>`.** Ali ele travava a
  pintura de toda página (205 KB antes do primeiro pixel). E não pode ser
  `defer`: os scripts de página logo abaixo rodariam antes dele.

**O `Server-Timing` é a régua.** Toda resposta traz
`supa;desc="N idas";dur=X, total;dur=Y` (aba Network → Timing) e uma linha
`[tempo]` no log da Vercel. `supa` é a SOMA das idas: passar do `total` é o
paralelo funcionando. Ao mexer numa rota, compare as idas antes e depois.

⚠️ **A Produtividade baixa 6,3 MB do banco a cada abertura** (o payload inteiro
de `dados_modulo`, 53.992 OS) e manda tudo para o navegador. É hoje a tela
mais lenta (~1,7 s só no download do Supabase, daqui) e não foi mexida em
07/10/2026: emagrecer o payload muda o contrato com o coletor.

---

## 7. Ambiente

O coletor precisa de **duas** credenciais do WVSA: `W8_USER`/`W8_PASS` e
`W8_USER_GESTOR`/`W8_PASS_GESTOR` (esta com acesso a Intranet > IDF e a
Rocketchat > Solicitações em aberto). Sem a segunda, `ger_idf` e `ger_salas`
falham — e o `ger_idf` falha *de propósito*, pela trava do §6, em vez de
gravar zero.

Variáveis em `.env.example` — todas as que o código lê estão lá. As do app
também precisam estar na Vercel; as do coletor, só na máquina dele.

O coletor **em execução** vive em `~/unetvale-coletor` (cópia do `coletor/`).
Editar aqui não muda o que roda: copie o arquivo e confira com `diff`.
Log em `~/unetvale-coletor/coletor.log`, banco em `dados.db`.

São **três** LaunchAgents, com propósitos diferentes:

| Agente | Roda | Quando | Log |
|---|---|---|---|
| `com.unetvale.coletor` | `watcher.py` → `enviar.py` (WVSA) | contínuo, grade 08–18h | `coletor.log` |
| `net.unetvale.troca-poste` | `coletar_celesc.sh` (Celesc) | a cada 15 min; coleta se a rodada de 07h/13h não saiu | `celesc.log` |
| `net.unetvale.enviar-os` | `enviar_os.py --daemon` (OS no WVSA) | **residente** | `enviar_os.log` |

O terceiro não tem grade porque a fila dele não se enche por relógio: ela se
enche quando alguém clica em "Abrir OS" no portal. Uma OS que esperasse o
próximo horário chegaria depois do desligamento que ela existe para acompanhar.
`KeepAlive` porque é um laço infinito e ninguém está olhando para reiniciá-lo.
**Sem este agente, ligar `OS_ENVIO_HABILITADO` não adianta nada**: a ordem fica
em `pronta` para sempre e a tela diz "aguardando o coletor".

⚠️ Ele pesquisa a fila a cada `OS_POLL_SEGUNDOS` (5). Ao mexer nesse número,
lembre que agora é um processo residente: a 2s eram ~43 mil consultas por dia
ao PostgREST para uma fila que enche algumas vezes por semana. O teto é a tela,
que espera o desfecho por 90 s. Ele não escreve log quando a fila está vazia,
então `enviar_os.log` só cresce com atividade.

O segundo precisa do `pnpm` por **caminho absoluto**: o launchd roda com
`PATH=/usr/bin:/bin:/usr/sbin:/sbin` e um `pnpm` solto sai com "command not
found" — falha calada. O script exporta o PATH no topo.

(Há um terceiro agente na máquina, `net.unetvale.celesc-sync`, de outro projeto
— `~/Documents/Cancelamento-Projetos-Celesc`, Zimbra → planilha do Google. Não
tem relação com o portal.)

---

## 8. Como verificar

Não existe suíte de testes. O padrão é:

1. **Sintaxe** — `python -c "import ast; ast.parse(open('arquivo.py').read())"`
   e `node --check arquivo.js`.
2. **Regra de negócio** — script que exercita a função direto, cobrindo o limite
   (o dia exato do prazo, o Set vazio versus `None`).
3. **Trava do banco** — `psycopg` numa transação com `rollback` no fim, tentando
   o que deve ser recusado.
4. **Permissão** — `app.test_client()` com sessão forjada, conferindo o **HTML
   servido**, não a tela.
5. **Rota** — **toda rota nova respondida de verdade pelo `test_client`**,
   inclusive com entrada ruim. `4xx` é resposta; `5xx` é bug.

   Isto é passo próprio porque template que compila **não** prova que a rota
   roda: a rota do PDF das reuniões compilava, renderizava no preview e
   quebrava em produção num `datetime` que não estava importado no topo do
   arquivo — havia um `from datetime import` dentro de outra função, que
   enganou até a checagem. Renderizar o template isolado não passa pela
   função da rota.
6. **Navegador** — `preview_start` em `localhost:5001`, exercitar o fluxo real,
   `read_console_messages` limpo. **Mudança de layout exige screenshot.**
7. **Celular** — `resize_window` no preset mobile e refazer o fluxo.
8. **Velocidade** — mudança em rota compara o `Server-Timing` (idas e ms)
   antes e depois. Mudança "só de desempenho" compara também o HTML servido
   contra a `main` (worktree + `test_client`, escritas trocadas por falsos):
   foi o que pegou a ordem do `apoio_ids` mudando ao embutir a leitura.

Módulo cujo dado **nasce aqui** (Ações) não se testa gravando em produção.
O padrão que funcionou em 29/09/2026: um servidor de ensaio que COPIA as tabelas
do módulo para a memória na partida e troca `supa.select/insert/update/delete/
upsert/rpc` por versões em memória para elas (o resto continua lendo produção),
recusando escrita em qualquer tabela real **e no Storage** (§6). A função SQL
é provada à parte, contra o banco, com `rollback`.

Subir local:

```bash
cd ~/Documents/Portal-Operacional-Unetvale && .venv/bin/python -c "
from app import create_app
a = create_app(); a.jinja_env.auto_reload = True
a.run(port=5001, use_reloader=False)"
```

---

## 9. Estado atual e pendências

- **Ações** entrou vazio: zero ação, zero gestor, 10 áreas. Em 29/09/2026
  eram 11 ações e 3 gestores (Matheus Dias, Patricia Schveitzer, Renato Barreto).
- **Ações em quadro Kanban** entrou em 29/09/2026, migration `0017`
  (`acoes.etiquetas`, `acao_checklist`, `acao_checklist_aplicar`), aplicada em
  produção no mesmo dia e conferida (coluna, tabela vazia com RLS, dois
  índices, função executável só pela `service_role`). O porquê está no §4.

  A função foi provada contra produção em transação com `rollback`: 3 de 5
  itens = 60%, marcar de novo não reescreve `feito_em`, Concluída fica em 100,
  item de outra ação, texto vazio e operação inventada recusados, e a
  migration reaplicada sem erro.

  Pelo `test_client`, sobre a cópia em memória das 11 ações de produção: 64
  casos — o recorte (Renan recebe só as 5 dele e 404 nas seis rotas de ação
  alheia), 20 entradas ruins todas `4xx`, o texto automático do arrasto, as
  duas travas, o checklist governando o %, reabrir voltando ao checklist,
  etiquetas limpas, apoio sem o dono. E 8 casos com a 0017 AUSENTE (deploy
  antes da migration): a tela funciona sem etiquetas nem checklist.

  No navegador, desktop e mobile, console limpo: arrasto com cancelar e com
  concluir, painel por clique e por `?acao=`, Esc e "voltar" fechando, três
  itens digitados em seguida, raias, lista ordenada, cronograma, gráficos
  novos, modal de nova ação pela raia (dono já preenchido) e a página cheia.

  **Ainda não exercitado:**
  * **em produção** — tudo acima rodou no servidor de ensaio (§8);
  * **arrastar com mouse de verdade** — o arrasto foi exercitado disparando os
    `DragEvent` nos cartões, que passa pelos mesmos ouvintes, mas não pelo
    gesto do navegador;
  * **supervisor ou pessoa sem nenhuma ação** abrindo o quadro vazio.

  ⚠️ `/acoes/<id>` (página cheia) continua **sem** `modulo_obrigatorio` —
  era assim antes, e as rotas novas têm. Quem teve o módulo escondido ainda
  abre uma ação sua pelo link direto.
- **Troca de Poste: agrupamento por bairro, revisão com mapa e ensaio de OS**
  entrou em 04/09/2026, migration `0012` (`aplicar_revisao`,
  `criar_os_bairro_dia`, `status='ensaio'`, índice `agrupamentos_bairro_dia_uk`).
  Três coisas que estavam modeladas no schema desde o início e nunca tinham
  código: `criterio='bairro_dia'`, a tabela `enderecos_alias` e a coluna
  `dry_run`.

  **A OS passou a ser do bairro/dia.** Medido em 04/09/2026 contra produção:
  273 desligamentos ativos viram **58 grupos** — e os 29 grupos críticos cobrem
  **165 trechos**, que antes seriam 165 OS. O maior deles (Governador Celso
  Ramos · AREIAS DO MEIO · 04/09) tem **15 trechos** num deslocamento só.

  **A tela de revisão virou ferramenta**: fila à esquerda, mapa com pino
  arrastável à direita, e três ações (confirmar, corrigir, reprovar). Confirmar
  e corrigir gravam o alias — é o que faz a fila encolher em vez de o mesmo
  endereço voltar toda coleta. A fila de produção tinha **178** endereços, 16
  deles com coordenada colapsada.

  Exercitado no navegador contra o Supabase de produção (leitura), no desktop e
  no preset mobile, console limpo: agrupamento, script do grupo de 15 trechos,
  `?aba=` na URL, seleção na fila, mapa com pino, os dois modais, e a recusa do
  servidor com o envio desligado. As rotas novas foram respondidas pelo
  `test_client`, inclusive com entrada ruim (coordenada fora de SC, lat não
  numérica, id inexistente): todas `4xx`, nenhuma `5xx`.

  Migration `0012` aplicada em 04/09/2026, e as duas funções provadas contra
  produção em transação com `rollback`:

  * **a revisão**: `R EULALIO TRINDADE` saiu de `validacao='revisar'`/`score 68`
    para `manual`/`100`, a coordenada gravada bateu com a enviada (erro 0,00 m),
    o alias nasceu com a observação certa, o match recalculou de
    **`indeterminado` para `alto`** e a linha de `auditoria` (`geo.revisar`) foi
    escrita. Chamar duas vezes continua dando **um** alias. Rodar
    `marcar_coordenadas_colapsadas()` depois **não** rebaixou o `manual`.
    Reprovar gravou `reprovado` e **zero** alias;
  * **a OS do bairro/dia**: `AREIAS DO MEIO · 04/09` com **15 trechos** virou um
    agrupamento `bairro_dia` com 15 itens e uma ordem `rascunho`/`dry_run=true`.
    A segunda chamada devolveu `ja_existia` com o MESMO `ordem_id` e **não**
    criou segundo agrupamento. O `CHECK` aceitou `ensaio`. As três travas
    recusaram: `criada` sem clique humano, status inventado e segunda OS com a
    mesma `chave_idempotencia`. Com `origem='clique_usuario'` e `enviado_por`,
    `criada` passa.

  O ramo de ensaio do `enviar_os.py` foi provado com `atualizar` e `Wvsa`
  substituídos: grava `status='ensaio'` com `payload_enviado`, **não** abre
  sessão no WVSA, e fora da VPN a ordem real fica em `pronta` em vez de virar
  `erro`.

  **Ainda não exercitado:**
  * **o LaunchAgent `net.unetvale.enviar-os`** — não foi instalado, e o
    `enviar_os.py` não foi copiado para `~/unetvale-coletor`;
  * **o envio REAL** (`OS_DRY_RUN=false`), que segue sem nunca ter acontecido;
  * **a revisão pela tela contra o banco** — a função foi provada por script; o
    caminho do botão até ela foi provado só com a função ainda inexistente.

  ⚠️ **`bairro_wvsa_id` é NULL nos 515 desligamentos** e nada no pipeline
  preenche essa coluna. Resolvido por outro caminho na migration `0013`: o
  nome do bairro viaja com a ordem (`ordens_servico.bairro_nome`) e o coletor
  resolve o id pelo autocomplete do WVSA no momento do envio — é o único ponto
  do sistema que alcança aquele endpoint. Falha na resolução não impede a OS:
  o campo é opcional (contrato §3.1).

- **Escolha de equipe e dos campos da OS** entrou em 04/09/2026, migration
  `0013` (coluna `bairro_nome`, e `criar_os_bairro_dia` recriada com
  `p_tecnico_ids`). Antes toda OS saía com `executor='infra'` cravado no JS e
  os outros quatro campos "de painel" vazios — inclusive a **equipe**.

  O modal de Abrir OS passou a montar a OS: quem executa, tipo de técnico,
  período e os técnicos em `.lista-marcar` agrupada por empresa. As opções são
  copiadas do formulário do WVSA para `troca_poste.wvsa_catalogos` pelo
  `enviar_os.py` — 53 opções na primeira sincronização (executor 3,
  tipo_tecnico 2, período 3, técnico 34, finalidade 11).

  Provado contra produção em transação com `rollback`: a função grava
  `tecnico_ids`, `periodo`, `tipo_tecnico` e `bairro_nome`; lista de técnicos
  vazia vira **NULL**, não `{}` (array vazio diria que houve escolha quando não
  houve); e o `drop`+`create` deixou **uma** versão viva da função, sem
  sobrecarga. No navegador, o POST interceptado levava os 17 ids do grupo mais
  `executor`, `periodo`, `tipo_tecnico` e os dois `tecnico_ids` escolhidos.

  **A inativação de técnico foi exercitada em 10/09/2026**: o formulário passou
  de 34 para 33 opções e a sincronização marcou `661 WAVE - Ueliton Patriqui
  Nicoletti` como inativo — justamente o duplicado (ele também é `522` na INFRA
  WAVE). O rodízio de slots também: 21 vencidos saíram, 35 entraram.

  **Ainda não exercitado:** a resolução do bairro por autocomplete — ela só roda
  no envio, e nenhum aconteceu.

- **Agendamento no modal e data em ISO** entrou em 10/09/2026, sem migration.
  Fecha o contrato do formulário do WVSA, conferido campo a campo pelo HTML do
  `<form action="/relatorios/infra10/save">`: os 22 nomes batem, `SOLICITACAO` é
  o único `required`, e as 11 cidades têm `ibge_codigo` idêntico ao do
  autocomplete (zero divergência).

  Duas correções que só apareceram nessa conferência: **`DATA`/`DATAFIM` iam em
  DD/MM/AAAA para um `<input type="date">`**, que só aceita ISO; e o
  autocomplete precisava de espera CRESCENTE, não fixa (§6).

  Exercitado no navegador contra produção, desktop e mobile, console limpo: o
  grupo de 10/09 abre com 27 horários e a nota certa; o de 12/09 tem o select
  desabilitado e a explicação; e o POST interceptado levava
  `agendamento: "149140-M1"`, o slot escolhido, sem nenhuma requisição real.

  **Ainda não exercitado:** o envio REAL — que é o próximo passo.

- **Agrupamento por bairro no mapa e nos gráficos** entrou em 09/09/2026, sem
  migration — é tudo cliente, a partir do `grupo_chave` que o servidor já
  carimbava. Fecha o que faltava do agrupamento: a tabela e a aba de OS já
  agrupavam desde 04/09; mapa, gráficos e KPIs ainda contavam trecho.

  O achado do dia foi a **dispersão como detector de geocodificação errada**
  (§4 e §6): 15 dos 18 acusados já estavam na fila de revisão, e os 3 restantes
  tinham score alto — casos que o score sozinho nunca levantaria.

  Exercitado no navegador contra produção, desktop e mobile, console limpo:
  36 bairros/dia, 15 fora do lugar e 6 sem posição no recorte de 7 dias; 183
  marcadores, 26 contornos, 15 anéis e 15 raios tracejados no DOM; e o filtro
  por Navegantes mostrando o raio saindo do aglomerado até o ponto a 7 km.

  **Ainda não exercitado:** o comportamento com o painel do navegador visível
  em tela real — a verificação correu com o painel oculto, onde o layout é
  adiado (§6).

- **Anexar ao WVSA uma foto do mapa da troca** foi pedido em 10/09/2026 e
  ficou para depois. O que já se sabe, para a próxima tentativa não repetir a
  sondagem:

  * o botão é *Fotos/Anexos → Incluir Fotos/Anexos*, um `<a class="abrir-form"
    data-u-botao-id="anexos" data-u-url="anexos">`;
  * **o padrão de rota é `/os/{acao}`, não `/os/{id}/{acao}`**: `/os/anexos`
    responde **500** (a rota existe, falta parâmetro) enquanto
    `/os/586420/anexos` responde **404** (rota inexistente). `/os/editar` se
    comporta igual, então vale para todos os botões daquele menu;
  * `os`, `id`, `os_id` e `OS` na query string: todos 500;
  * o JS que monta a requisição **não está** em nenhum dos 60 scripts da
    página nem no `app.js` (1,4 MB) — procurei por `abrir-form`, `u-url` e
    `anexo`, zero ocorrências.

  O caminho barato é capturar UM envio real pelo DevTools (aba Network →
  Payload) em vez de adivinhar parâmetro contra produção.

  A outra metade é gerar a imagem: precisa de **Pillow**, que não está em
  nenhum dos dois venvs, para costurar tiles do OpenStreetMap em zoom 17-18
  (onde o nome da rua fica legível). Enquanto isso não existe, o técnico tem o
  link do Google Maps que já vai no script.

- ✅ **A primeira OS real saiu em 10/09/2026: `#586420` no WVSA.**
  Governador Celso Ramos · GANCHOS DO MEIO · 14/09, 1 trecho, crítico. HTTP 200,
  resposta `{"actions":[{"action":"location","value":"/os/586420"}]}` — o WVSA
  redirecionando para a OS nova. O caminho inteiro fechou: clique no portal →
  `criar_os_bairro_dia` → fila → coletor dentro da VPN → POST em
  `/relatorios/infra10/save` → número de volta.

  **Conferido na tela da OS e na listagem**, campo a campo:

  | Onde | O que apareceu |
  |---|---|
  | título | `OS: #586420 - Troca de Poste` |
  | listagem | `Governador Celso Ramos` · `Ganchos do Meio` · `Infra` |
  | agendamento | `14/09/2026 no Período da Tarde` |
  | técnico | `INFRA UNET - Carlos Henrique de Souza Vargas` |
  | descrição | o script completo, com endereço e coordenada |

  ⚠️ **Cidade e bairro NÃO aparecem na ficha da OS** (`/os/<n>`) — só na
  listagem do `/relatorios/infra10/dados`. Foram gravados: é a listagem que
  prova. Conferir pela ficha levaria a concluir, errado, que não foram.

  **Liberado em produção no mesmo dia**, e usado: em poucos minutos saíram mais
  duas — `#586438` (DOM JOAQUIM, 10 trechos) e `#586440` (PEREQUE, 14 trechos).

  ⚠️ **Todos os 12 usuários enxergam Troca de Poste** e, portanto, podem abrir
  OS. Os 4 supervisores incluídos — eles NÃO viam o módulo antes do `#30`, e
  passaram a ver porque a regra saiu do código e o padrão da configuração é
  "vê tudo". Restringir é em *Configurações → Acesso aos módulos*.

  ⚠️ **A ordem carrega o `dry_run` de quando foi criada.** As duas ordens de
  ensaio no banco (AZAMBUJA 10/09 e AREIAS DO MEIO 04/09) continuarão sendo
  ensaio para sempre, mesmo com a variável virada — e, pela
  `chave_idempotencia`, um clique novo naqueles bairros/dias devolve a ordem
  antiga em vez de criar uma real. Para enviar aqueles dois de verdade seria
  preciso virar o `dry_run` daquelas linhas no banco.
- **Reuniões com gravação** está em produção desde 29/08/2026. Migrations
  `0006` (gravação e ata), `0007` (ata editável) e `0008` (convidados). Bucket
  privado `reuniao-audio`; chave e modelos no `.env`
  (`whisper-large-v3-turbo` + `openai/gpt-oss-120b`).

  Exercitado numa reunião de verdade: gravar pelo navegador, transcrever,
  gerar a ata, editar a ata e o PDF.

  **A rotação de trecho passou no uso real** em 08/09/2026: a reunião
  "Orçamento - Operações" gravou **13 trechos** de 2 min (~25 min), todos
  transcritos com sucesso. O que falhou naquele dia foi a montagem da ata, por
  contabilidade de tokens (§6) — corrigido, e a ata foi gerada dos mesmos 13
  trechos, com 20 pontos discutidos, sem carimbo de parcial.

  **Pauta alternável por reunião** entrou em 08/09/2026, migration `0015`
  (`reunioes.puxar_pauta`). O porquê está no §4.

  **Ata como relato, itens à parte** — migration `0016` (`itens_na_ata`,
  `ata_dados`, `descartado_em`/`descartado_por`). A ata passou a ocupar o
  cartão inteiro (`.ata.larga`), as listas saíram do texto e cada sugestão
  ganhou "Remover". O porquê está no §4; a armadilha do recuo que isso
  revelou, no §6.

  Migration `0016` aplicada em 09/09/2026 e exercitada contra produção, pela
  tela: descartar tirou a sugestão do card (10 → 9), com o `<dialog>` levando o
  texto certo; a regeração gravou `ata_dados` e **não** trouxe de volta o que
  fora recusado; e o botão alternou o texto três vezes seguidas sem chamar a
  IA (seções somem, voltam sem o item recusado, somem de novo). A ata daquela
  reunião ficou como relato (`itens_na_ata=false`), e o item usado no teste
  foi restaurado.

  Foi nessa passagem que apareceram o furo do filtro em um lugar só (§4) e a
  falta do botão de regerar.

  **Ainda não exercitado**, e são justamente os caminhos mais delicados:
  * **`aplicar_item` e `criar_acao_do_item`** — escrevem em `acao_eventos`, que
    é append-only, e por isso não foram testados contra produção;
  * **o expurgo dos 30 dias** — nenhum áudio venceu ainda.
- **Dashboard (visão gerencial)** entrou em 29/08/2026, migrations `0009`
  (`dashboard_esteira_snapshot`, `dashboard_metas`) e `0010`
  (`dashboard_config`).

  Exercitado contra o WVSA de verdade, com os números conferidos:
  IQI 07/2026 = **212** reincidências (58 de Falha Massiva) e IQM = **219**;
  cancelamentos 07/2026 = **475** válidos com **52** do grupo técnico
  (**10,95%**, R$ 63.170,82); a diferença de conjuntos da esteira provada com
  fila de total constante (4 → 4) e 2 entradas / 2 saídas.

  Histórico de janeiro a agosto/2026 coletado (payload de 88 KB, 71 técnicos).

  Os cinco módulos coletaram contra o WVSA de verdade, incluindo os dois que
  dependem da sessão do gestor: IDF de 08/2026 (ligações 212 nota 4,58; chats
  1096 nota 4,49; OS 297 nota 4,51) e salas do Rocketchat (1121 solicitações,
  35 em aberto).

  Corrigido depois de entrar: o selo "fechado/parcial" saía da posição na
  lista, e julho aparecia FECHADO no dia 29/08 enquanto o `/iqi` dizia
  "Julho (Parcial)". Agora é `gerencial.mes_fechado` (ver §6).

  **Ainda não exercitado:**
  * **a trava do IDF zerado** — agora existe payload bom, então ela passa a
    valer de verdade na próxima rodada com credencial errada. Nunca disparou.
  * **o expurgo dos snapshots** da esteira (90 dias) — nenhum venceu ainda.

- **Monitoramento honesto** entrou em 31/08/2026, migration `0011`
  (`coletor_heartbeat`). O que mudou e por quê está no §6; o resumo é que a
  tela passou a distinguir quatro coisas que antes tinham a mesma cara:
  módulo na fila da rodada em curso, coletor mudo, coletor sem rota até o WVSA
  e módulo de fato parado.

  Exercitado contra produção: a rodada disparada pelo botão às 09:55 apareceu
  como "Coleta em andamento", o contador subiu 3→4→5→7 e o aviso sumiu ao
  fechar (8/8 módulos OK); os três estados do banner conferidos pelo HTML
  servido; e a prova de que `marcar_erro` preserva payload e carimbo foi feita
  numa linha descartável no banco de produção.

- **Coleta da Celesc agendada** em 31/08/2026
  (`net.unetvale.troca-poste`, 07h e 13h). Antes disso ela **nunca teve
  agendamento** — as 356 linhas de `troca_poste.desligamentos` vinham de uma
  execução manual de 26/08. A primeira rodada agendada, disparada por
  `launchctl kickstart`, trouxe **70 desligamentos novos**, 226 confirmados e 5
  desaparecidos, e passou por `tp:geocodificar` e `tp:match` (426 analisados).

  **O agendamento sozinho falhou na primeira tentativa**, em 01/09/2026: às 07h
  nada rodou, porque a rodada das 13h do dia anterior nunca terminou (§6). O
  processo pendurado foi derrubado à mão, `coletar_celesc.sh` ganhou prazo por
  etapa e recusa de rodada vazia, e três rodadas seguidas passaram inteiras
  pelas três etapas e **encerraram o processo** (`state = not running`), a
  última trazendo 42 desligamentos novos, 257 confirmados e 8 desaparecidos.
  `sync-rede` ficou manual até 29/09/2026 (ver adiante).

  **O horário disparou sozinho pela primeira vez em 02/09/2026, às 07:06:57 —
  e a rodada morreu mesmo assim.** O agendamento estava certo; a máquina é que
  dormiu 2 s depois do dark wake que o disparou (§6). A rodada arrastou 58 min,
  morreu com `read EADDRNOTAVAIL` e deixou a linha `executando` órfã.

  Corrigido no mesmo dia, em três lugares: `coletar_celesc.sh` se re-executa
  sob `caffeinate -ims` e passou a medir o prazo por relógio de parede; o
  `cli.ts` do monorepo marca a coleta como `erro` ao morrer; e o portal mostra
  `executando` velho como **interrompida**.

  Exercitado de verdade, pelo caminho do launchd (`launchctl kickstart`), às
  09:11 de 02/09/2026: rodada inteira em **2 min 45 s** (`tp:coletar` →
  `geocodificar` → `match`), **306 desligamentos, 23 novos**, 283 confirmados,
  2 desaparecidos, 491 analisados no match; `last exit code = 0`,
  `state = not running`, as três asserções de energia de pé durante a rodada
  (`pmset -g assertions`) e **nenhum `caffeinate` vivo depois** — assertion
  vazada seria pior que o problema original, porque impediria o Mac de dormir
  para sempre.

  **Ainda não exercitado:** o `marcarColetaErro` de verdade (o SQL foi provado
  contra a linha órfã numa transação com `rollback` — marca `erro`, é
  idempotente pela guarda `status='executando'` e não toca em coleta `ok` —
  mas nenhuma rodada morreu desde que ele existe); e o `caffeinate` segurando
  a máquina num horário em que ela de fato tentaria dormir, que é o teste que
  só o relógio dá.

- **Troca de Poste parada e sem posição, corrigido em 29/09/2026.** Duas
  causas independentes (§6): o horário fixo perdia a rodada com o Mac fechado
  (última coleta boa: 26/09 13h) e a fila de geocodificação atendia o passado
  primeiro (305 de 305 na tela sem posição). Junto entrou o histórico no filtro
  (§4) e a busca de OS por id — o `listar(incluir_passados=True)` usado ali
  pedia `limit=2000`, levava o corte de 1000 do PostgREST e, com a tabela a
  ~55 linhas de passar disso, ia deixar de achar os desligamentos MAIS NOVOS.

  Exercitado: a rodada forçada de 08:30 trouxe 305 desligamentos (101 novos,
  11 cidades); as seis decisões do agendador provadas com `HOME` falso (em dia,
  atrasado, sem carimbo, tampa fechada na bateria, clamshell na tomada,
  forçado) e um tique real do launchd saiu com código 0 sem escrever no log;
  o histórico conferido contra o banco (197 `desapareceu` que aconteceram
  entram, 80 que sumiram antes não, nenhum `confirmado` perdido); paginação
  com 1241 linhas; rotas pelo `test_client` com entrada ruim, todas `2xx/4xx`;
  navegador no desktop e no mobile, console limpo.

  No mesmo dia entraram os itens da **rede** (§6): `sync-rede` na rodada,
  priorizando o futuro, e a migration 20 do monorepo (cobertura expira em 7
  dias; o match congela o passado), aplicada em produção depois da prova com
  `rollback`. O fluxo das quatro etapas foi provado com `pnpm` falso nos cinco
  desfechos (tudo certo, geocodificar falha, sync falha, coleta falha, coleta
  vazia).

  ⚠️ O `DATABASE_URL` do `.env` DESTE repositório está com a senha velha
  (autenticação recusada em 29/09/2026); o do monorepo funciona.

  **Ainda não exercitado:** o adiamento por falta de rede (a sonda usa
  caminhos absolutos e não foi simulada) e a grade antes das 07h (vale o 13h
  de ontem) — só o relógio dá esses dois. O monorepo continua sendo a fonte
  (§2); a mudança lá é uma linha em `repository-geocodificacao.ts`.

- **IQI/IQM consolidado do WVSA** entrou em 01/09/2026, sem migration — o
  campo `geral` viaja dentro do payload de `dados_modulo`. Antes disso as duas
  telas somavam os técnicos e mostravam três números diferentes para o mesmo
  mês (Dashboard 8,78%, "Por empresa" 8,52%, WVSA 7,49% no IQM de 07/2026).
  O porquê está no §6.

  Exercitado contra o WVSA de verdade: a coleta rodou (`enviar.py --so iqi`) e
  os oito meses de 2026 saíram idênticos ao relatório nos dois indicadores;
  `/dashboard` e `/iqi` conferidos no navegador, no desktop e no preset mobile,
  console limpo; o recuo (`fonte: "soma"`) e o mês sem OS exercitados por
  script.

  **Ainda não exercitado:** o recorte por supervisor no KPI novo — não há
  supervisor cadastrado em produção, então o caminho que **esconde** o KPI só
  foi provado disparando o evento `iqifiltro` à mão.

  Sobrou em aberto, e é da mesma família: `w8_client.coletar` engole exceção
  por técnico (`except Exception: raw[nome] = None`) e o técnico simplesmente
  não aparece no ranking, sem erro em lugar nenhum. Na medição de 01/09/2026
  foram 0 falhas em 132, mas nada avisaria se não fosse.

- **Dashboard: filtro global, cross-filter, Cat 6, IDF detalhado, TMA/TMF e
  técnico ofensor do cancelamento** entrou em 29/09/2026, sem migration (tudo
  em `dados_modulo`; metas novas `idf_alerta`, `tma_chat`, `tmf_chat` pela lista
  de Configurações). O porquê de cada decisão está no §4; as armadilhas, no §6.

  Exercitado contra o WVSA de verdade com as coletas gravando em ARQUIVO local
  (nada no Supabase, pela ordem de deploy do §6): categorias 08-09/2026 (Cat 6
  em 25 de 144 linhas, BAND STEERING 11), cancelamentos (527 contratos no
  detalhe = 527 válidos; 45 e 30 com última OS), IDF (224/1.152/339 feedbacks,
  médias iguais ao painel) e RRO de setembro (23.562 conversas em 106 s,
  payload de 50 KB). No navegador, com esses payloads sobrepostos em memória,
  desktop e mobile, console limpo: filtro por empresa, "Só ofensores",
  técnico, cross-filter nas duas telas, filtros de motivo e de IDF. Rotas pelo
  `test_client` com payload de produção, vazio, novo e malformado: todas 200.
  A página do Dashboard vai de ~106 KB para ~244 KB com os dados novos.

  **Ainda não exercitado:**
  * **a coleta nova gravando em produção** — espera o deploy do app (§6);
    depois, copiar o `coletor/` para `~/unetvale-coletor` e rodar
    `enviar.py --so ger_categorias --full` (Cat 6 do ano) e `--so ger_atendimento --full`;
  * **o supervisor no filtro global** com vínculos reais — o select aparece
    para o admin, mas não foi exercitado com um alcance escolhido;
  * **a cadência diária pelo launchd** — a decisão foi provada com Supabase e
    WVSA substituídos, não num dia real.

  ⚠️ Em aberto: por que 5 contratos "HISTORICO DE OS" de 08/2026 não aparecem
  no CMT (232658, 236239, 236279, 232797, 230690). Olhar um deles no WVSA antes
  de afirmar que o ranking de técnico cobre todo cancelamento com OS.

- **Velocidade** (07/10/2026, sem migration): região `pdx1`, estático pela
  CDN, sessão persistente, consultas em paralelo e leituras embutidas. O
  porquê e os números estão no §6. Primeiro passo do plano que segue com Ações
  em tempo real, avisos e Safari.

  Exercitado: as sete rotas medidas antes/depois pelo `test_client`; o HTML de
  22 páginas (admin e usuário comum) igual ao da `main`; entrada ruim nas
  rotas de ação (`4xx`); navegador com Dashboard, IQI, Produtividade,
  Massivas, quadro e painel lateral, console limpo.

  **Ainda não exercitado:** o `vercel.json` novo (região e build estático) só
  se prova no deploy — conferir `x-vercel-id: …::pdx1::…` e, no CSS,
  `cache-control: …immutable`.

- **Backup do Supabase não foi confirmado.** Ações e Troca de Poste não têm de
  onde ser recoletados. Confirme antes de qualquer operação destrutiva.
