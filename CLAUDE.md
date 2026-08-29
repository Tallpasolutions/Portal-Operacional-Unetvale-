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

## 4. Os cinco módulos

| Rota | Módulo | Origem do dado | Quem vê |
|---|---|---|---|
| `/produtividade` | Produtividade | `dados_modulo` (coletor) | todos; supervisor só o time dele |
| `/iqi` | IQI / IQM | `dados_modulo` (coletor) | todos |
| `/massivas` | Massivas | `dados_modulo` (coletor) | todos |
| `/troca-poste` | Troca de Poste | schema `troca_poste` | todos menos supervisor |
| `/acoes` | **Ações** | `public.acoes` e cia. | cada um as suas; gestor a área dele |

Mais `/usuarios`, `/monitoramento` (admin) e `/configuracoes` (todos).

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

### Comentários

Explique **por quê**, não o quê. Registre a decisão e o que aconteceria se fosse
diferente. Os arquivos deste projeto seguem esse padrão — mantenha-o.

### Visual

`app/static/css/style.css` é a fonte da verdade. Reaproveite as classes que já
existem (`.kpi`, `.card`, `.tbl`, `.badge-*`, `.chip`, `.toolbar`, `.view-switch`,
`.vazio`, `.subnote`, `.lista-marcar`, `.linha-tempo`, `.barra`). Cores por
token (`--brand`, `--success`, `--danger`, `--warning`, `--ouro`).
**Nunca invente um componente que já existe.**

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

**Ids de modelo da Groq mudam.** Ficam em `GROQ_MODELO_*` no ambiente. Cravados
no código, viram um HTTP 400 sem explicação no dia em que a Groq aposentar o id.

**Pooler do Supabase: `aws-1-us-west-2`.** A região está no hostname; a errada
dá "tenant not found".

---

## 7. Ambiente

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
5. **Navegador** — `preview_start` em `localhost:5001`, exercitar o fluxo real,
   `read_console_messages` limpo. **Mudança de layout exige screenshot.**
6. **Celular** — `resize_window` no preset mobile e refazer o fluxo.

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
- **Reuniões com gravação**: migration `0006` aplicada, bucket privado
  `reuniao-audio` criado, chave e modelos no `.env`
  (`whisper-large-v3-turbo` + `openai/gpt-oss-120b`). O ciclo do servidor foi
  verificado ponta a ponta em 28/08/2026 — URL assinada, upload direto,
  transcrição, ata e expurgo. **Falta exercitar a captura pelo navegador**
  (`MediaRecorder`) numa reunião de verdade, e o `aplicar_item`, que escreve em
  `acao_eventos` e por isso não foi testado contra produção.
- **Backup do Supabase não foi confirmado.** Ações e Troca de Poste não têm de
  onde ser recoletados. Confirme antes de qualquer operação destrutiva.
