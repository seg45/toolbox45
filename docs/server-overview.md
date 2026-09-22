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
NTLM entirely and is authenticated against the `api_keys` table (hash only; the raw key is
shown once, at creation time). Manage keys in the app under **Settings → System → API
access**, or directly via `GET/POST /api/api-keys` and `DELETE /api/api-keys/:id`.

## Multiusuário (identificação do usuário Windows)

Este servidor é pensado para rodar em UMA máquina central que toda a equipe acessa pelo
navegador (ex.: `http://nome-do-servidor:3000`). Cada pessoa é identificada pelo próprio
login do Windows via NTLM (pacote `express-ntlm`), sem prompt de senha — funciona de forma
transparente quando o site está na zona "Intranet local" do navegador (padrão em máquinas
de domínio Windows). Isso possibilita favoritos, tema, idioma e históricos por usuário
(tabelas `user_favorites`/`user_data`), sem precisar de tela de login própria.

- Em produção, nada precisa ser configurado além de rodar `npm start` numa máquina no
  domínio — o handshake NTLM já resolve o usuário sozinho.
- Para desenvolvimento/teste FORA de um domínio Windows (ex.: sua própria máquina, ou
  este ambiente), defina `NTLM_DISABLED=1` antes de rodar o servidor — nesse modo, o
  usuário é lido de um header `x-dev-user` (ou `?__user=` na URL), com fallback para o
  usuário do sistema operacional rodando o Node.
- Variável opcional `NTLM_DOMAIN` define o domínio padrão usado quando o cliente NTLM não
  informar um explicitamente (raro).

```
# desenvolvimento, sem domínio Windows disponível:
NTLM_DISABLED=1 npm start
```

### UPN via Active Directory (opcional)

O NTLM só entrega `DOMÍNIO\usuário` (sAMAccountName). Para exibir o UPN de verdade
(ex.: `rsilva@empresa.com`) no header, configure a consulta LDAP ao Active Directory
com as variáveis abaixo — sem elas, a UI continua funcionando normalmente, só que
mostrando `DOMÍNIO\usuário` em vez do UPN.

- `AD_DOMAIN_CONTROLLER` — ex.: `ldap://dc01.empresa.local` (obrigatório para habilitar)
- `AD_BASE_DN` — ex.: `DC=empresa,DC=local` (obrigatório para habilitar)
- `AD_BIND_DN` — conta de serviço para autenticar a busca (opcional se o AD aceitar bind anônimo)
- `AD_BIND_PASSWORD` — senha da conta de serviço (junto com `AD_BIND_DN`)

### Login com Google (opcional)

Além de NTLM e login local (usuário/senha), a página de login (`login.html`) pode
mostrar um botão "Sign in with Google" (OAuth 2.0) — ver `GET /api/auth/google*` em
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
5. Defina no backend (`toolbox45-backend`, ver bloco comentado em `docker-compose.yml`):

```
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
GOOGLE_REDIRECT_URI=https://toolbox45.seg45.com.br/api/auth/google/callback
```

6. Recrie o container (`docker compose up -d --build`) — o botão "Sign in with Google"
   aparece automaticamente em `login.html` assim que as 3 variáveis estiverem presentes
   (`GET /api/auth/providers`).

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
- Assim como o resto da API hoje, não há autorização própria além da identificação NTLM
  — qualquer pessoa com acesso à rede pode chamar esses endpoints diretamente (não só
  quem ativou o Modo administrador na própria tela).

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
