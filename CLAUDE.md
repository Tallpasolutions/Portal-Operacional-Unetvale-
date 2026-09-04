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
`coletor/coletar_celesc.sh` (07h e 13h). É um LaunchAgent **separado** do
`com.unetvale.coletor` de propósito: a Celesc é pública, então esta coleta não
tem por que parar quando a rede da Unetvale cai.

`sync-rede` (espelho da malha, semanal e pesado) continua **manual**.

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
- **Chart.js 4** vendorizado (`app/static/vendor/`), configurado em
  `app/static/js/chart-setup.js`. **Não** troque por outra biblioteca.
- **Leaflet 1.9.4** vendorizado, só no mapa da Troca de Poste.
- Deploy: Vercel (`@vercel/python`, entrypoint `api/index.py`).
- **Sem framework de teste.** Verificação é por script e pelo navegador (§8).

---

## 4. Os seis módulos

| Rota | Módulo | Origem do dado | Quem vê |
|---|---|---|---|
| `/dashboard` | **Dashboard** | `dados_modulo` (5 coletas `ger_*`) | todos |
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

Cinco coletas novas, todas no coletor (`coletor/gerencial.py`), gravando em
`dados_modulo` como os módulos antigos:

| Módulo | Relatório do WVSA | Sessão |
|---|---|---|
| `ger_categorias` | `operacional31` — causa raiz (Cat 1..5) | padrão |
| `ger_cancelamentos` | `indicadores13` — churn válido | padrão |
| `ger_esteira` | `/operacional/os/query` — fila de agendamento | padrão |
| `ger_idf` | `indicadores9` — nota dos feedbacks | **gestor** |
| `ger_salas` | `operacional15` — Rocketchat | **gestor** |

**Duas sessões do WVSA, uma rodada.** O relatório é recortado por usuário:
`w8_client.login()` usa `W8_USER`, `login_gestor()` usa `W8_USER_GESTOR`. As
duas vivem na mesma execução do `enviar.py`, então tudo atualiza junto.

**As categorias vêm registro a registro, não somadas.** `ger_categorias` guarda
uma linha por reincidência — com o **técnico** dentro —, no mesmo formato
compacto da Produtividade (índices para listas de texto). Não é economia de
espaço: é que a visualização "Causa raiz" do `/iqi` cruza empresa, supervisor e
mês ao mesmo tempo, e contagem já agregada não se recorta depois. O Dashboard,
que mostra o consolidado, agrega na hora em `gerencial.agregar_categorias`.

⚠️ As listas de texto (`tec`, `c1`…`c5`, `cid`) são **carregadas do payload
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
`/dashboard` é o consolidado do mês, em ranking. No `/iqi` é uma tabela mensal
(Cat 4 e Cat 5 nas linhas, meses nas colunas), dentro da visualização Tabela
mensal. As duas leem `gerencial.causa_raiz()` e compartilham
`dashboard_rank.js`; Categorias 1 e 2 só aparecem no Dashboard, porque dizem
como o cliente pediu e como o N1 encerrou, não a causa.

⚠️ A visualização do `/iqi` conta **todo protocolo de reincidência, inclusive
de equipes de infra**, que não entram no cálculo do `%`. O total dela não fecha
com o das outras visualizações da mesma tela — é intencional, está escrito na
tela, e o filtro de empresa separa.

O que o módulo **não** faz, de propósito: o card "Massivas em aberto" do
material de referência (a lista de `#7403` com previsão) ficou de fora. Falha
Massiva como *causa de reincidência* está dentro, nas Categorias 4 e 5 — e é a
segunda maior.

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
| `desligamentos` | inventário: filtros, KPIs, dois gráficos, tabela linha a linha |
| `revisao` | fila + mapa com pino arrastável — confirmar, corrigir, reprovar |
| `ordens` | candidatos **agrupados por bairro/dia**, script da OS e o botão |
| `mapa` | todos os desligamentos, com a malha óptica sob demanda |

**A OS é do bairro e do dia, não da rua.** A Celesc publica o mesmo bairro
fatiado em várias ruas para o mesmo desligamento, e a equipe vai uma vez: em
04/09/2026, 273 desligamentos ativos eram 58 grupos. O agrupamento é o
`criterio='bairro_dia'` que o schema modela desde a migration 09 e que nenhum
código gravava. Quem monta o grupo de verdade é o banco
(`troca_poste.criar_os_bairro_dia`) — a tela agrupa só para exibir, e o servidor
não confia nos ids que o browser manda.

**A revisão é o que faz a fila encolher.** Confirmar um endereço grava três
coisas na mesma transação: a posição como `manual`, o **alias** em
`enderecos_alias` e o recálculo do match. O alias tem prioridade máxima sobre
qualquer geocodificador (ADR-0005): na próxima coleta aquele texto da Celesc
nasce resolvido. Sem o segundo passo, revisar conserta uma linha; com ele,
conserta o endereço. Reprovar existe para o endereço que não dá para
posicionar — sai da fila **sem** coordenada e sem alias, em vez de virar
palpite com score 100.

A correção humana é durável: `marcar_coordenadas_colapsadas` tem
`and g.validacao <> 'manual'` e o upsert da geocodificação preserva `manual`.
Nenhuma rodada posterior rebaixa o que uma pessoa apontou no mapa.

### Papéis

Três, independentes — a pessoa pode ser um, vários ou nenhum:

- **admin** — `email == ADMIN_EMAIL` (variável de ambiente, **não** coluna).
- **supervisor** — linha em `supervisores`; vê só o time dele em Produtividade
  e IQI. **Não** enxerga Troca de Poste.
- **gestor de ações** — linha em `acao_gestores`; manda nas ações das áreas dele.

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
| `.ata` | corpo de texto para leitura, com medida limitada |
| `.grav-pill` | controle único de gravação (Gravar/Pausar/Concluir) |
| `.btn-pdf` | ação discreta dentro de célula de tabela |

Os que nasceram no Dashboard:

| Classe | O que é |
|---|---|
| `.rank` / `.rank-linha` | ranking horizontal: rótulo · barra · valor. **Não** confundir com `.barra`, que é progresso de 70px dentro de célula |
| `.par-mes` | par "mês fechado × mês corrente" numa moldura só |
| `.regua` | contraste de duas partes numa barra (resolvido × não resolvido) |

**Cartão recolhido** (`.card.recolhido` + `hidden` no `.card-b`, com o botão no
`.card-h`): o cartão vira uma linha só até alguém clicar. É para formulário que
existe mas não é o motivo de a pessoa ter aberto a tela — o "Comentário do
gestor" e a "Definição" do `acao_detalhe.html`. A regra do CSS tira a borda de
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

**Coluna nova vai no conjunto ESTENDIDO, nunca no base.** `acoes.py` lê as
reuniões com `_select_reunioes(filtro, extras)`: tenta `_COLS_REUNIAO + extras`
e, se o PostgREST recusar, recua para `_COLS_REUNIAO` sozinho. Esse recuo existe
porque o deploy e a migration não acontecem no mesmo segundo. Pôr a coluna nova
no conjunto **base** quebra o recuo junto — e aí, sem a migration, a reunião não
abre. Já aconteceu com `convidados`.

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

**Pooler do Supabase: `aws-1-us-west-2`.** A região está no hostname; a errada
dá "tenant not found".

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
| `net.unetvale.troca-poste` | `coletar_celesc.sh` (Celesc) | 07h e 13h | `celesc.log` |
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

Subir local:

```bash
cd ~/Documents/Portal-Operacional-Unetvale && .venv/bin/python -c "
from app import create_app
a = create_app(); a.jinja_env.auto_reload = True
a.run(port=5001, use_reloader=False)"
```

---

## 9. Estado atual e pendências

- **Ações** entrou vazio: zero ação, zero gestor, 10 áreas. Só o admin cria
  ação enquanto ninguém for marcado gestor em Configurações.
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

  ⚠️ **`bairro_wvsa_id` é NULL nos 515 desligamentos.** O código deixou de
  cravar `bairro_id=""` e passou a ler a coluna, mas **nada preenche essa
  coluna** — o `resolverBairro()` do `WvsaClient` está implementado no monorepo
  e não tem caller. Na prática o campo `bairro` do formulário do WVSA continua
  indo vazio, e só se saberá no primeiro envio real se ele é obrigatório. É
  pendência do pipeline, não do portal.

- **Envio REAL de OS ao WVSA** segue sem nunca ter rodado ponta a ponta. São
  dois interruptores: `OS_ENVIO_HABILITADO=true` mostra o botão e
  `OS_DRY_RUN=false` faz a OS sair. Enquanto o segundo não virar, todo clique
  para em `ensaio` — que é como este caminho se prova sem deslocar equipe.
- **Reuniões com gravação** está em produção desde 29/08/2026. Migrations
  `0006` (gravação e ata), `0007` (ata editável) e `0008` (convidados). Bucket
  privado `reuniao-audio`; chave e modelos no `.env`
  (`whisper-large-v3-turbo` + `openai/gpt-oss-120b`).

  Exercitado numa reunião de verdade: gravar pelo navegador, transcrever,
  gerar a ata, editar a ata e o PDF.

  **Ainda não exercitado**, e são justamente os caminhos mais delicados:
  * **a rotação de trecho** — as gravações de teste tiveram menos de 2 min, e
    nenhuma passou pelo `stop()`/`start()` que fecha um trecho e abre o
    seguinte. É a peça de que a ata de reunião longa depende;
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
  `sync-rede` segue manual.

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

- **Backup do Supabase não foi confirmado.** Ações e Troca de Poste não têm de
  onde ser recoletados. Confirme antes de qualquer operação destrutiva.
