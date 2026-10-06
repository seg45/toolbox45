# Toolbox45 — Backend

Backend (Python 3.12 + FastAPI + PostgreSQL, via `asyncpg`) for Toolbox45, the multi-vendor
network support tool. Code lives in `../server-py/` (`app/main.py` is the entry point,
`app/routers/*.py` hold the routes, one module per domain). This is a **pure REST API** under
`/api` — it does not serve the static frontend (the React/Vite frontend in `../frontend-react/`
is built into an nginx image that serves it and reverse-proxies `/api/*` here).
The whole app runs as 3 Docker containers (see `../docker-compose.yml`):
`toolbox45-db` (PostgreSQL), `toolbox45-backend` (this), `toolbox45-frontend` (nginx + React).

> **History.** The backend used to be Node.js/Express (`server/`) with a vanilla-JS frontend
> (`js/`, `css/`, `index.html`). Both were replaced by this Python backend and the React
> frontend in the Phase 4 cutover (see `README.md` in `../server-py/`). The last commit that
> still contains the old code is tagged `node-final`: `git show node-final:server/index.js`
> reads a file, and `git checkout node-final` restores the whole old stack (rebuild with
> `docker compose build`). Notes in code comments of the form "porta de server/index.js"
> refer to that pre-cutover Node code.

## Install & run (standalone, without Docker)

```
cd server-py
pip install -r requirements.txt
# point at your own Postgres instance (same variable names as before):
export PGHOST=localhost PGPORT=5432 PGDATABASE=toolbox45 PGUSER=toolbox45 PGPASSWORD=toolbox45
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The server listens on the port you pass to `uvicorn` (the Docker image uses `8000`) and
exposes the REST API at `/api/*` only — no static files. Outside Docker you also need the
PostgreSQL 16 client tools (`pg_dump`/`pg_restore`, used by Backup & Restore) and `openssl`
(used to generate the default self-signed certificate) on the `PATH`; set `BACKUP_DIR` and
`TLS_DIR` to writable folders (the Docker image uses `/app/backups` and `/app/tls`, which
are the named volumes `toolbox45-backups` and `toolbox45-tls`).

On startup (`app/db.py`, before the first request is served) the backend connects to
Postgres — retrying for about a minute while the database comes up — and then, in this order:

1. applies `app/schema.sql` (idempotent: `CREATE TABLE IF NOT EXISTS`);
2. runs the idempotent migrations (`app/migrations.py`), safe to repeat on every boot and
   on a database that was created by the old Node backend;
3. seeds first-install defaults (`app/seeds.py`), each one only when its table is empty:
   the `Favorites` folder per user (no default account is created — the first `super_admin`
   comes from the first-access setup screen, see `docs/api.md`),
   vendors, systems, versions, environments, search parameters, prompts and export
   templates. The 8 fixed search parameters (`src_ip`, `dst_ip`, `src_port`, `dst_port`,
   `user`, `host`, `license`, `signature`) are re-created on every boot if missing.

No commands and no topics are pre-loaded: create them in the app, or import commands from
CSV (**Settings → Database → Commands → Import**; see `../import-templates/`). The old
`seed.js` (a one-off loader of ~30 reference commands) and `perf-seed.js` (synthetic data for
load tests) were not ported and were removed in the cutover; `seed.js` had already stopped
working against the current schema (text ids vs. the `SERIAL` `commands.id`, and nothing
seeded `topics`).

In the normal Docker deployment (see `../docker-compose.yml`), none of this needs to be
done manually — `docker compose up -d --build` builds and starts all 3 containers, and the
backend waits for `toolbox45-db` to become healthy before applying the schema.

Tests: `cd server-py && python -m pytest tests` (needs a reachable PostgreSQL — it uses
throwaway databases prefixed `p_`; the module is skipped if none is available).
Frontend: `cd frontend-react && npm install && npm run build` (type-check + Vite build).

## API keys (programmatic access)

External scripts/integrations can call the API by sending a `X-API-Key` header — this skips
the session/login gate entirely and is authenticated against the `api_keys` table (hash
only; the raw key is shown once, at creation time). Manage keys in the app under
**Settings → System → API access**, or directly via `GET/POST /api/api-keys` and
`DELETE /api/api-keys/:id`.

## Multiusuário (login obrigatório)

Este servidor é pensado para rodar em UMA máquina central que toda a equipe acessa pelo
navegador (ex.: `https://nome-do-servidor`). Cada pessoa loga com uma conta local
(usuário/senha) ou com a própria conta Google (ver seção abaixo) — não existe mais
identificação automática por login do Windows (NTLM, removido a pedido do usuário:
"deixar somente autenticação local e com Google") nem um fallback anônimo/dev. Toda
chamada à API exige sessão (local ou Google) ou API key — sem uma das duas, `401
unauthorized` (ver o gate de autenticação em `server-py/app/deps.py`). Isso possibilita
favoritos, tema, idioma e históricos por usuário, sem depender de domínio Windows.

Não existe conta padrão: no primeiro acesso a tela de login pede o e-mail e a senha do
administrador (ver `docs/api.md`, seção **Configuração inicial**); um admin cria
outras contas locais em **Settings → Users**, e contas Google se
auto-provisionam no primeiro login (ver abaixo).

### Login com Google (opcional)

Além do login local (usuário/senha), a página de login (`login.html`) pode mostrar um
botão "Sign in with Google" (OAuth 2.0) — ver `GET /api/auth/google*` em
`server-py/app/routers/oauth.py` e a seção **Login com Google** em `docs/api.md`. Desligado por
padrão; sem restrição de domínio Google Workspace (qualquer conta Google pode entrar).
Primeiro login de um e-mail cria a conta automaticamente com `role: "user"`.

1. No [Google Cloud Console](https://console.cloud.google.com/), crie (ou reaproveite)
   um projeto e vá em **APIs & Services → OAuth consent screen** — configure um app
   básico (nome, e-mail de suporte); "External" funciona mesmo para uso interno.
2. Em **APIs & Services → Credentials → Create Credentials → OAuth client ID**, tipo
   **Web application**.
3. Em **Authorized redirect URIs**, adicione a URL pública EXATA de
   `GET /api/auth/google/callback` (ex.: `https://toolbox.seg45.com.br/api/auth/google/callback`)
   — precisa bater caractere por caractere com `GOOGLE_REDIRECT_URI` abaixo.
4. Copie o **Client ID** e o **Client secret** gerados.
5. **NUNCA cole o Client ID/Secret no `docker-compose.yml`** — este repositório é
   público no GitHub, e qualquer coisa commitada nele fica no histórico do git pra
   sempre, mesmo removendo depois. `docker-compose.yml` já lê essas 3 variáveis de um
   arquivo `.env` (`${GOOGLE_CLIENT_ID}` etc., mesmo padrão do `POSTGRES_PASSWORD`) —
   o `.gitignore` já exclui `.env` do versionamento. Crie/edite esse arquivo **direto no
   servidor**, ao lado do `docker-compose.yml` (ex.: `/opt/toolbox45/.env`):

```
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
GOOGLE_REDIRECT_URI=https://toolbox.seg45.com.br/api/auth/google/callback
```

6. Recrie o container (`docker compose up -d --build`) — o botão "Sign in with Google"
   aparece automaticamente em `login.html` assim que as 3 variáveis estiverem presentes
   (`GET /api/auth/providers`).

### Login com Microsoft (opcional)

Igual ao login com Google acima, só troca o provedor: um botão "Sign in with Microsoft"
em `login.html` (OAuth 2.0 contra a Microsoft identity platform v2.0) — ver
`GET /api/auth/microsoft*` em `server-py/app/routers/oauth.py` e a seção **Login com Microsoft** em
`docs/api.md`. Desligado por padrão; por padrão aceita qualquer conta Microsoft
(pessoal ou de qualquer organização — ver `MICROSOFT_TENANT_ID` no passo 6 abaixo).
Primeiro login de um e-mail cria a conta automaticamente, mas **desabilitada** —
pendente de aprovação por um admin em **Settings → Users**, igual ao
auto-cadastro local e ao login com Google.

1. Entre no [Azure Portal](https://portal.azure.com/) → **Microsoft Entra ID** →
   **App registrations** → **New registration**.
2. Dê um nome ao app (ex.: "Toolbox45"). Em **Supported account types**, escolha
   **Accounts in any organizational directory and personal Microsoft accounts** (é o
   que combina com `MICROSOFT_TENANT_ID=common`, o padrão — restrinja aqui só se quiser
   travar o login a uma organização específica, ver passo 6).
3. Em **Redirect URI**, escolha o tipo **Web** e cole a URL pública EXATA de
   `GET /api/auth/microsoft/callback` (ex.:
   `https://toolbox.seg45.com.br/api/auth/microsoft/callback`) — precisa bater
   caractere por caractere com `MICROSOFT_REDIRECT_URI` abaixo. Clique **Register**.
4. Na página do app recém-criado, copie o **Application (client) ID** (é o
   `MICROSOFT_CLIENT_ID`).
5. Vá em **Certificates & secrets → Client secrets → New client secret**, crie um
   (qualquer descrição/validade) e copie o **Value** assim que aparecer — ele só é
   mostrado uma vez (é o `MICROSOFT_CLIENT_SECRET`).
6. **NUNCA cole o Client ID/Secret no `docker-compose.yml`** — mesmo motivo do Google
   acima (repositório público). Adicione ao mesmo arquivo `.env` no servidor
   (ex.: `/opt/toolbox45/.env`):

```
MICROSOFT_CLIENT_ID=<application (client) id>
MICROSOFT_CLIENT_SECRET=<client secret value>
MICROSOFT_REDIRECT_URI=https://toolbox.seg45.com.br/api/auth/microsoft/callback
# opcional — só se quiser restringir o login a uma organização específica em vez de
# "common" (qualquer conta Microsoft, pessoal ou de qualquer organização):
# MICROSOFT_TENANT_ID=<tenant id ou domínio da organização>
```

7. Recrie o container (`docker compose up -d --build`) — o botão "Sign in with
   Microsoft" aparece automaticamente em `login.html` assim que as variáveis
   obrigatórias estiverem presentes (`GET /api/auth/providers`).

## Compartilhamento entre usuários (handles + shares)

Pastas e comandos de cada usuário são **privados por padrão** — ninguém mais vê o que
você criou, a menos que você compartilhe explicitamente. Todo usuário tem um **handle**
(apelido único, gerado automaticamente na criação da conta — ver `generate_unique_handle()`
em `server-py/app/handles.py` — e trocável livremente depois em **Settings → Account**)
usado para esse compartilhamento **sem nunca expor o username real** (que é o e-mail,
no caso de contas Google). Para outro usuário, você digita o handle dele e escolhe o
que compartilhar — pastas e/ou comandos, "tudo ou nada" (não dá para escolher uma
pasta/comando específico) — e vale imediatamente, sem a outra pessoa precisar aceitar
nada. Você também pode revogar a qualquer momento. Admins continuam vendo as pastas/
comandos de todo mundo sempre, sem depender de nenhuma concessão aqui — este mecanismo
só regula a visibilidade entre usuários comuns. Ver `users.handle`/tabela `shares` em
`server-py/app/schema.sql`, `PUT /api/me/handle` (`app/routers/me.py`)/`/api/shares`
(`app/routers/shares.py`) e a seção
**Compartilhamento entre usuários** em `docs/api.md`.

## Catálogos administráveis

Vendors, Systems, Versions, Environments, Topics, Parameters, Prompts e Exports ficam em
tabelas próprias (`vendors`, `systems`, `versions`, `environments`, `topics`, `parameters`,
`prompts`, `exports` — ver `app/schema.sql`), populadas no primeiro boot com o catálogo
base (ver "Install & run" acima; Topics começa vazio) e administradas em **Settings →
Register** (só admin): uma janela por catálogo, com cadastrar, editar e excluir.
Rotas em `app/routers/catalog.py`.

- **Autorização:** `GET /api/catalogs` (todos os catálogos de uma vez) exige apenas login
  (sessão ou API key). Todas as rotas de escrita — `POST`/`PUT /:key`/`DELETE /:key` em
  `/api/vendors`, `/api/systems`, `/api/versions`, `/api/environments`, `/api/topics`,
  `/api/parameters`, `/api/prompts` e `/api/exports`, mais os vínculos
  `PUT /api/environments/:key/versions` e `PUT /api/topics/:key/environments` — exigem
  `admin` ou `super_admin`.
- **Hierarquia:** Vendor → System → Version (a chave de Version é `system` + `key`).
  Environment também pertence a um System. Mover um System de Vendor propaga o vendor
  para suas Versions/Environments; trocar o System de um Environment desfaz os vínculos
  Version↔Environment que ele tinha.
- O identificador (`key`) de cada item nunca pode ser alterado depois de criado — é o
  valor gravado nos comandos que usam aquele item. Para Vendors/Systems/Versions/
  Environments/Topics/Prompts/Exports ele é gerado a partir do rótulo (slug, com sufixo
  `-2`, `-3`… se já existir); só Parameters têm `key` digitada pelo admin.
- **Exclusão:** bloqueada (409 `in_use`) quando o item está em uso por pelo menos um
  comando; o tópico interno `environment` é protegido (409 `protected`, checado antes do
  uso — ele alimenta os cards de "Ambiente específico" e não aparece no filtro de Tópico).
  Prompts e Exports não têm checagem de uso (são texto solto nas linhas de comando).

### Parâmetros

Os campos da barra de busca unificada (`src_ip`, `dst_ip`, `src_port`, `dst_port`, `user`,
`host`, `license`, `signature` e qualquer parâmetro novo) vêm da tabela `parameters`
(colunas `key`, `label`, `sort_order`). Os 8 acima são recriados a cada boot se faltarem.

- `key` é o nome usado em `{{key}}` dentro dos templates de comando e também a palavra
  digitada antes de `:` na busca (`src_ip:10.0.0.1`); só aceita `[A-Za-z0-9._-]`, até 40
  caracteres, e não pode mudar depois de criado. `label` é o texto exibido.
- Não existe expansão automática de lista/faixa para parâmetros novos: ela só está
  implementada como lógica própria para os comandos "avançados" que já tratavam IP/Porta
  como lista/faixa (os `RESOLVERS` em `frontend-react/src/lib/resolvers.ts`). Um parâmetro
  novo funciona como substituição simples de texto — o valor digitado entra literalmente
  no lugar de `{{key}}`.
- Exclusão bloqueada (409) quando o parâmetro está em uso — via texto (`{{key}}` aparece
  em alguma linha de algum comando) OU, especificamente para `ip` e `port`, quando algum
  comando depende deles de forma estrutural (flag `requires_ip_port`, usada pelo motor de
  renderização para decidir o estado vazio "informe IP/Porta"). Essa segunda checagem é
  fixa no código, não uma opção do admin.
- API: `GET /api/catalogs` (inclui `parameters`) e `POST`/`PUT /:key`/`DELETE /:key` em
  `/api/parameters`.
