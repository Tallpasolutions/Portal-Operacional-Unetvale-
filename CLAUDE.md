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
  Atenção: `select`, `select_one`, `insert` e `update` aceitam `schema=`;
  **`delete` e `upsert` não** — só funcionam no `public`. Precisa apagar em
  `troca_poste`? Acrescente o parâmetro lá (o PostgREST endereça schema pelos
  cabeçalhos `Accept-Profile`/`Content-Profile`, já tratados em `_headers`).
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

**Nada de `confirm()` do navegador.** Ele abre uma caixa do sistema, com o
domínio no topo, que não pertence à tela — use `.modal` com `<dialog>`. As
telas antigas ainda usam `confirm()`; ao mexer numa delas, troque.

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
- **Envio de OS ao WVSA** (Troca de Poste) está atrás de
  `OS_ENVIO_HABILITADO=false` e **nunca rodou ponta a ponta**.
- **Tela de revisão com inserção de localização** (Troca de Poste) nunca foi
  feita — é o item mais antigo em aberto.
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

  **Ainda não exercitado:**
  * **a trava do IDF zerado** — agora existe payload bom, então ela passa a
    valer de verdade na próxima rodada com credencial errada. Nunca disparou.
  * **o expurgo dos snapshots** da esteira (90 dias) — nenhum venceu ainda.

- **Backup do Supabase não foi confirmado.** Ações e Troca de Poste não têm de
  onde ser recoletados. Confirme antes de qualquer operação destrutiva.
