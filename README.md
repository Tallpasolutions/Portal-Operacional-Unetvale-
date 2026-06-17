# Dashboard Unetvale

Aplicação web única que consolida os três painéis operacionais da Unetvale —
**Produtividade**, **IQI / IQM** e **Massivas** — com login simples, layout
corporativo (header + menu lateral retrátil) e gráficos reativos com
**cross-filter** (clicar num gráfico filtra os demais).

```
Coletor (dentro da VPN)  ──upsert──►  Supabase (Postgres)  ──leitura──►  Vercel (app Flask)
 extrator/w8_client/fetch_wvsa        usuarios + dados_modulo            unetvale.tallpa.com.br
```

- **App** (`app/`, `api/`): Flask na Vercel. Só lê o Supabase — **nunca** acessa o WVSA.
- **Coletor** (`coletor/`): roda numa máquina com VPN, executa os scripts originais
  (lógica de negócio intacta) e envia os dados ao Supabase nos horários **08/10/12/14/16/18h**.
- **Banco**: Supabase. Migration em `supabase/migrations/0001_init.sql`.

---

## Passo 1 — Supabase (banco)

1. No painel do Supabase, abra **SQL Editor**.
2. Cole o conteúdo de [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) e clique **Run**.
3. Em **Project Settings → API**, copie:
   - **Project URL** → `SUPABASE_URL`
   - chave **`service_role`** (secreta) → `SUPABASE_SERVICE_KEY`

## Passo 2 — GitHub

```bash
cd dashboard-unetvale
git init && git add . && git commit -m "Dashboard Unetvale"
git remote add origin git@github.com:SEU_USUARIO/dashboard-unetvale.git
git push -u origin main
```
> O `.gitignore` já protege `.env`, `config.json`, `dados.db` e `model.json`.

## Passo 3 — Vercel (deploy do app)

1. **Add New → Project** e importe o repositório do GitHub.
2. A Vercel detecta o `vercel.json` (runtime Python). Não precisa configurar build.
3. Em **Settings → Environment Variables**, adicione (veja `.env.example`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `FLASK_SECRET_KEY` → gere com `python -c "import secrets; print(secrets.token_hex(32))"`
   - `INGEST_TOKEN` (opcional — só se for usar o endpoint `/api/ingest`)
4. **Deploy**.

## Passo 4 — Cloudflare (domínio)

1. Na Vercel, em **Settings → Domains**, adicione `unetvale.tallpa.com.br`.
2. No Cloudflare (DNS de `tallpa.com.br`), crie o registro indicado pela Vercel
   (normalmente um **CNAME** `unetvale` → `cname.vercel-dns.com`).
   - Deixe o proxy do Cloudflare em **DNS only** (nuvem cinza) para o TLS da Vercel validar.

## Passo 5 — Primeiro usuário

Acesse `https://unetvale.tallpa.com.br/cadastro`, crie sua conta e faça login.
(Todos os usuários têm o mesmo acesso.)

## Passo 6 — Coletor (dentro da VPN)

Numa máquina com acesso à VPN da empresa (o Mac atual ou um mini-PC):

```bash
cd dashboard-unetvale/coletor
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env        # preencha W8_USER, W8_PASS, SUPABASE_URL, SUPABASE_SERVICE_KEY
.venv/bin/python enviar.py  # primeira carga (testa os 3 módulos)
```

Agende com **cron** (08/10/12/14/16/18h):

```cron
0 8,10,12,14,16,18 * * * cd /CAMINHO/dashboard-unetvale/coletor && ./.venv/bin/python enviar.py >> cron.log 2>&1
```

> macOS: `crontab -e` (ou um LaunchAgent, como no projeto original de Produtividade).
> A Produtividade mantém um SQLite local (`dados.db`) só na máquina coletora,
> para o histórico incremental; só o resultado consolidado vai ao Supabase.

Comandos úteis:
```bash
.venv/bin/python enviar.py --so iqi     # roda só um módulo
.venv/bin/python enviar.py --full       # reconstrói o histórico da Produtividade
```

---

## Rodar o app localmente (opcional)

```bash
cd dashboard-unetvale
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env        # preencha SUPABASE_URL, SUPABASE_SERVICE_KEY, FLASK_SECRET_KEY
.venv/bin/python -c "from app import create_app; create_app().run(debug=True, port=5000)"
# abra http://127.0.0.1:5000
```

## Estrutura

```
dashboard-unetvale/
├── api/index.py            # entrypoint Vercel (WSGI)
├── vercel.json
├── app/
│   ├── __init__.py         # app factory
│   ├── auth.py             # login / cadastro / troca de senha
│   ├── routes.py           # páginas + /api/ingest
│   ├── dados.py            # leitura dos snapshots + status de atualização
│   ├── supa.py             # acesso ao Supabase (REST)
│   ├── templates/          # base (header+sidebar) + páginas
│   └── static/             # css, js (cross-filter), chart.umd.min.js
├── coletor/                # roda dentro da VPN (NÃO vai p/ a Vercel)
│   ├── enviar.py           # orquestra os 3 scripts e faz upsert no Supabase
│   ├── extrator.py  w8_client.py  fetch_wvsa.py   # scripts originais (reaproveitados)
│   └── requirements.txt  .env.example
└── supabase/migrations/0001_init.sql
```
