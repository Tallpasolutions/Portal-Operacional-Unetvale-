# Portal Operacional Unetvale

Portal interno que consolida os painéis operacionais da Unetvale:
**Produtividade**, **IQI / IQM**, **Massivas**, **Troca de Poste** e **Ações**.

Em produção: **unetvale.tallpa.com.br**

> Vai mexer no código? Leia o **[CLAUDE.md](CLAUDE.md)** antes — ele traz a
> arquitetura, as convenções e as armadilhas que já custaram tempo. Este README
> é sobre instalar e operar.

```
WVSA (10.170.74.79, só na rede Unetvale/VPN)
   │  scraping
   ▼
Coletor (coletor/ → roda em ~/unetvale-coletor, 08/10/12/14/16/18h)
   │  upsert
   ▼
Supabase (Postgres)  ◄── escrita direta do app (Ações, Troca de Poste)
   │  leitura
   ▼
App Flask (app/ + api/) na Vercel
```

**O app nunca fala com o WVSA** — a Vercel não alcança um IP privado. Tudo que
precisa do WVSA vive em `coletor/`.

---

## Os módulos

| Módulo | Origem do dado | Recuperável? |
|---|---|---|
| Produtividade | coletor → `dados_modulo` | ✅ recoleta |
| IQI / IQM | coletor → `dados_modulo` | ✅ recoleta |
| Massivas | coletor → `dados_modulo` | ✅ recoleta |
| Troca de Poste | Celesc + Geogrid → schema `troca_poste` | ⚠️ parcial |
| **Ações** | nasce no portal → `public.acoes` | ❌ **não há de onde** |

A última coluna importa: Ações e as OS da Troca de Poste **só existem aqui**.
Antes de qualquer operação destrutiva, confirme o backup do Supabase.

---

## Instalação

### 1. Banco (Supabase)

No **SQL Editor**, rode as migrations **em ordem**:

```
supabase/migrations/0001_init.sql                  tabelas base + usuários
supabase/migrations/0002_coletor_log.sql           log do coletor
supabase/migrations/0003_supervisores.sql          papel de supervisor
supabase/migrations/0004_supervisor_tecnicos.sql   vínculo por técnico
supabase/migrations/0005_acoes.sql                 módulo Ações
supabase/migrations/0006_reuniao_transcricao.sql   Reuniões: gravação e ata
supabase/migrations/0007_ata_editada.sql           ata editável no texto
supabase/migrations/0008_reuniao_convidados.sql    convidados sem conta
supabase/migrations/0009_dashboard.sql             esteira + metas do Dashboard
supabase/migrations/0010_dashboard_config.sql      preferências do Dashboard
supabase/migrations/0011_coletor_heartbeat.sql     sinal de vida do coletor
```

Em **Project Settings → API**, copie a **Project URL** e a chave
**`service_role`**.

O schema `troca_poste` tem migrations próprias e precisa estar em
**Exposed schemas** (Settings → API) para o PostgREST enxergá-lo.

### 2. App (Vercel)

Importe o repositório. A Vercel detecta o `vercel.json` (runtime Python) — não
há build. Em **Settings → Environment Variables**, preencha as variáveis da
seção **APP** do [`.env.example`](.env.example).

`ADMIN_EMAIL` é o que define o administrador. Não existe coluna de admin na
tabela `usuarios`: quem tiver esse e-mail é quem manda.

### 3. Domínio

Na Vercel, **Settings → Domains** → `unetvale.tallpa.com.br`. No Cloudflare,
crie o CNAME indicado, com proxy em **DNS only** para o TLS validar.

### 4. Usuários

Não há cadastro público. O admin cria as contas em **Usuários**, e cada pessoa
troca a própria senha em **Configurações**.

Papéis (independentes — a pessoa pode ter vários ou nenhum):

- **admin** — o `ADMIN_EMAIL`;
- **supervisor** — vinculado a equipes/técnicos em Configurações; vê só o time
  dele em Produtividade e IQI;
- **gestor de ações** — vinculado a áreas em Configurações; manda nas ações
  dessas áreas.

### 5. Coletor

Numa máquina dentro da rede Unetvale (hoje, o Mac do Jhoni):

```bash
cd coletor
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp ../.env.example .env       # preencha as seções APP e COLETOR
.venv/bin/python enviar.py    # primeira carga
```

O agendamento é um **LaunchAgent** (`com.unetvale.coletor.plist`) que mantém o
`watcher.py` de pé; ele dispara nos horários e atende ao botão "Atualizar" do
portal. Log em `coletor.log`.

A **Troca de Poste tem coleta própria**, num segundo LaunchAgent
(`net.unetvale.troca-poste.plist` → `coletar_celesc.sh`, 07h e 13h, log em
`celesc.log`). Ela chama o pipeline da Celesc que vive no monorepo
`~/Documents/Dashboard Operacional` — ver §2 do `CLAUDE.md`. É separada porque o
site da Celesc é público: não depende da VPN e não deve parar junto do WVSA.

```bash
.venv/bin/python enviar.py --so iqi                                  # só um módulo
.venv/bin/python extrator.py --inicio 01/07/2026 --fim 31/07/2026    # refaz um período
```

> ⚠️ **`--full` apaga e regrava todo o histórico.** Faça `cp dados.db dados.db.bak`
> antes. Existe uma trava que aborta se a coleta vier muito menor que o banco,
> mas o backup é a rede de segurança de verdade.

---

## Rodar local

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # preencha a seção APP
.venv/bin/python -c "
from app import create_app
a = create_app(); a.jinja_env.auto_reload = True
a.run(port=5001, use_reloader=False)"
```

`jinja_env.auto_reload` não é detalhe: sem ele o Flask serve template em cache e
as mudanças de `.html` parecem não fazer efeito.

---

## Estrutura

```
api/index.py                  entrypoint Vercel (WSGI)
app/
  __init__.py                 app factory
  auth.py                     login, senha, papéis (usuario_atual)
  routes.py                   todas as páginas e endpoints
  supa.py                     acesso ao Supabase via PostgREST
  dados.py                    snapshots dos módulos + status de atualização
  acoes.py                    módulo Ações
  troca_poste.py              módulo Troca de Poste
  supervisores.py             papel de supervisor e vínculos
  solicitacao.py              texto da OS (módulo puro, sem I/O)
  templates/                  base.html + uma por módulo
  static/                     css/, js/, vendor/ (Chart.js, Leaflet)
coletor/                      roda na rede Unetvale — NÃO vai para a Vercel
  watcher.py                  agendamento e botão "Atualizar"
  enviar.py                   orquestra os módulos e faz upsert
  extrator.py                 Produtividade (SQLite local + WVSA)
  w8_client.py                IQI/IQM
  fetch_wvsa.py               Massivas
  enviar_os.py                envio de OS ao WVSA (desligado por padrão)
supabase/migrations/          numeradas, aplicadas à mão
CLAUDE.md                     arquitetura, convenções e armadilhas
```
