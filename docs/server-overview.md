# Toolbox45 — Backend

Backend (Node.js + Express + PostgreSQL, via `pg`) for Toolbox45, the multi-vendor network
support tool. This is a **pure REST API** under `/api` — it does not serve the static frontend
anymore (see `../frontend/` for the nginx image that does that + reverse-proxies `/api/*` here).
The whole app runs as 3 Docker containers (see `../docker-compose.yml`):
`toolbox45-db` (PostgreSQL), `toolbox45-backend` (this), `toolbox45-frontend` (nginx).

## Install & run (standalone, without Docker)

```
cd server
npm install
# point at your own Postgres instance:
export PGHOST=localhost PGPORT=5432 PGDATABASE=toolbox45 PGUSER=toolbox45 PGPASSWORD=toolbox45
npm start
```

The server listens on `PORT` (env var, default `3000`) and exposes the REST API at
`/api/*` only — no static files. On startup it connects to Postgres and applies
`schema.sql` automatically (safe to re-run — uses `CREATE TABLE IF NOT EXISTS`). To
(re)populate the ~30 built-in commands, run `node seed.js` once after `npm install`.

In the normal Docker deployment (see `../docker-compose.yml`), none of this needs to be
done manually — `docker compose up -d --build` builds and starts all 3 containers, and the
backend waits for `toolbox45-db` to become healthy before applying the schema.

## API keys (programmatic access)

External scripts/integrations can call the API by sending a `X-API-Key` header — this skips
the session/login gate entirely and is authenticated against the `api_keys` table (hash
only; the raw key is shown once, at creation time). Manage keys in the app under
**Settings → System → API access**, or directly via `GET/POST /api/api-keys` and
`DELETE /api/api-keys/:id`.

## Multiusuário (login obrigatório)

Este servidor é pensado para rodar em UMA máquina central que toda a equipe acessa pelo
navegador (ex.: `http://nome-do-servidor:3000`). Cada pessoa loga com uma conta local
(usuário/senha) ou com a própria conta Google (ver seção abaixo) — não existe mais
identificação automática por login do Windows (NTLM, removido a pedido do usuário:
"deixar somente autenticação local e com Google") nem um fallback anônimo/dev. Toda
chamada à API exige sessão (local ou Google) ou API key — sem uma das duas, `401
unauthorized` (ver o gate de login obrigatório em `server/index.js`). Isso possibilita
favoritos, tema, idioma e históricos por usuário, sem depender de domínio Windows.

A conta local `admin`/`admin` já vem semeada em toda instalação nova (troque a senha
assim que possível — ver `docs/api.md`, seção **Usuário local padrão**); um admin cria
outras contas locais em **Settings → System → Users**, e contas Google se
auto-provisionam no primeiro login (ver abaixo).

### Login com Google (opcional)

Além do login local (usuário/senha), a página de login (`login.html`) pode mostrar um
botão "Sign in with Google" (OAuth 2.0) — ver `GET /api/auth/google*` em
`server/index.js` e a seção **Login com Google** em `docs/api.md`. Desligado por
padrão; sem restrição de domínio Google Workspace (qualquer conta Google pode entrar).
Primeiro login de um e-mail cria a conta automaticamente com `role: "user"`.

1. No [Google Cloud Console](https://console.cloud.google.com/), crie (ou reaproveite)
   um projeto e vá em **APIs & Services → OAuth consent screen** — configure um app
   básico (nome, e-mail de suporte); "External" funciona mesmo para uso interno.
2. Em **APIs & Services → Credentials → Create Credentials → OAuth client ID**, tipo
   **Web application**.
3. Em **Authorized redirect URIs**, adicione a URL pública EXATA de
   `GET /api/auth/google/callback` (ex.: `https://toolbox45.seg45.com.br/api/auth/google/callback`)
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
GOOGLE_REDIRECT_URI=https://toolbox45.seg45.com.br/api/auth/google/callback
```

6. Recrie o container (`docker compose up -d --build`) — o botão "Sign in with Google"
   aparece automaticamente em `login.html` assim que as 3 variáveis estiverem presentes
   (`GET /api/auth/providers`).

### Login com Microsoft (opcional)

Igual ao login com Google acima, só troca o provedor: um botão "Sign in with Microsoft"
em `login.html` (OAuth 2.0 contra a Microsoft identity platform v2.0) — ver
`GET /api/auth/microsoft*` em `server/index.js` e a seção **Login com Microsoft** em
`docs/api.md`. Desligado por padrão; por padrão aceita qualquer conta Microsoft
(pessoal ou de qualquer organização — ver `MICROSOFT_TENANT_ID` no passo 6 abaixo).
Primeiro login de um e-mail cria a conta automaticamente, mas **desabilitada** —
pendente de aprovação por um admin em **Settings → System → Users**, igual ao
auto-cadastro local e ao login com Google.

1. Entre no [Azure Portal](https://portal.azure.com/) → **Microsoft Entra ID** →
   **App registrations** → **New registration**.
2. Dê um nome ao app (ex.: "Toolbox45"). Em **Supported account types**, escolha
   **Accounts in any organizational directory and personal Microsoft accounts** (é o
   que combina com `MICROSOFT_TENANT_ID=common`, o padrão — restrinja aqui só se quiser
   travar o login a uma organização específica, ver passo 6).
3. Em **Redirect URI**, escolha o tipo **Web** e cole a URL pública EXATA de
   `GET /api/auth/microsoft/callback` (ex.:
   `https://toolbox45.seg45.com.br/api/auth/microsoft/callback`) — precisa bater
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
MICROSOFT_REDIRECT_URI=https://toolbox45.seg45.com.br/api/auth/microsoft/callback
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
(apelido único, gerado automaticamente na criação da conta — ver `generateUniqueHandle()`
em `server/db.js` — e trocável livremente depois em **Settings → System → Sharing**)
usado para esse compartilhamento **sem nunca expor o username real** (que é o e-mail,
no caso de contas Google). Para outro usuário, você digita o handle dele e escolhe o
que compartilhar — pastas e/ou comandos, "tudo ou nada" (não dá para escolher uma
pasta/comando específico) — e vale imediatamente, sem a outra pessoa precisar aceitar
nada. Você também pode revogar a qualquer momento. Admins continuam vendo as pastas/
comandos de todo mundo sempre, sem depender de nenhuma concessão aqui — este mecanismo
só regula a visibilidade entre usuários comuns. Ver `users.handle`/tabela `shares` em
`server/schema.sql`, `PUT /api/me/handle`/`/api/shares` em `server/index.js` e a seção
**Compartilhamento entre usuários** em `docs/api.md`.

## Catálogos administráveis (Versão / Ambiente / Tópico)

Versão, Ambiente e Tópico (antes listas fixas no código) agora ficam nas tabelas
`versions`/`environments`/`topics` (criadas e populadas automaticamente no primeiro
`npm start`, com os mesmos valores que já existiam). Quem tiver o "Modo administrador"
ativado (Configurações → Modo administrador) vê um botão **🗂️ Gerenciar
Versões/Ambientes/Tópicos** na barra lateral, que abre um modal para cadastrar, editar
e excluir esses itens.

- O identificador (`key`) de cada item nunca pode ser alterado depois de criado — é o
  valor gravado nos comandos que usam aquela versão/ambiente/tópico.
- Exclusão é bloqueada (erro 409) quando o item está em uso por pelo menos um comando,
  ou quando é o tópico protegido `environment` (usado internamente para os cards de
  "Ambiente específico" — não aparece no filtro de Tópico, só no editor de comandos).
- API: `GET /api/catalogs` (os 3 de uma vez) e `POST`/`PUT /:key`/`DELETE /:key` em
  `/api/versions`, `/api/environments` e `/api/topics`.
- Assim como o resto da API hoje, não há autorização própria além de exigir login
  (sessão local/Google) ou API key — qualquer pessoa autenticada pode chamar esses
  endpoints diretamente (não só quem ativou o Modo administrador na própria tela).

## Catálogo administrável (Parâmetros)

Os campos da barra de busca unificada (`src:`, `dst:`, `sport:`, `dport:`, `proto:`,
`iface:`, `vsid:`, IP e Porta genéricos, e qualquer parâmetro novo) agora vêm da tabela
`parameters` (criada e populada automaticamente no primeiro `npm start`, com os 9 valores
que já existiam). A aba **Parâmetros** do modal **🗂️ Gerenciar...** (Modo administrador)
permite cadastrar, editar e excluir esses itens.

- Cada parâmetro tem três nomes distintos: `key` (usado em `{{key}}` dentro dos templates
  de comando — imutável depois de criado), `query_key` (a palavra digitada antes de `:` na
  busca — esta SIM pode ser editada) e `input_id` (o `<input type="hidden">` que guarda o
  valor atual; para os 9 parâmetros originais é um id fixo do HTML, para parâmetros novos
  é criado dinamicamente com o mesmo nome da `key`).
- `aliases` é uma lista de apelidos (separados por vírgula) também aceitos antes do `:`
  na busca, além do `query_key` e da `key`.
- `list_mode` (`none`/`list`/`list_range`) hoje só ajusta o texto de dica (tooltip) — não
  existe expansão automática de lista/faixa para parâmetros novos; isso só está implementado
  como lógica própria para os ~10 comandos "avançados" que já tratavam IP/Porta como
  lista/faixa (ver `RESOLVERS` em `server/db-render-engine.js`). Um parâmetro novo com
  `list_mode = 'list_range'` funciona como substituição simples de texto — o valor digitado
  entra literalmente no lugar de `{{key}}`.
- Exclusão é bloqueada (409) quando o parâmetro está em uso — via texto genérico (`{{key}}`
  aparece em algum comando) OU, especificamente para `ip` e `port`, quando algum comando
  depende deles de forma estrutural (flag `requires_ip_port`, usada pelo motor de
  renderização para decidir o estado vazio "informe IP/Porta"). Essa segunda checagem é
  fixa no código (não é uma opção do admin) porque esses 2 parâmetros são lidos pelo nome
  diretamente na lógica do front-end, e não apenas via substituição de template — um
  simples "está em uso" no texto não bastaria para detectar o risco de quebra.
- API: `GET /api/catalogs` (inclui `parameters`) e `POST`/`PUT /:key`/`DELETE /:key` em
  `/api/parameters`.
