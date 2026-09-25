# Toolbox45 — Referência da API

API REST exposta pelo container `toolbox45-backend` (ver `server/index.js`), acessada
pelo navegador através do proxy reverso do `toolbox45-frontend` (`/api/*`) ou
diretamente por integrações externas via API key. Todas as respostas são JSON; corpos
de requisição em `POST`/`PUT` também devem ser JSON (`Content-Type: application/json`).

## Autenticação

Toda a API usa uma identificação de "usuário atual" (`username`) para favoritos,
auditoria (`created_by`/`modified_by`) e preferências. Duas formas, nessa ordem de
prioridade — sem uma das duas, a chamada é recusada (`401 unauthorized`; algumas rotas
são públicas por necessidade, ver **Login local e usuários**/**Login com Google**
abaixo):

1. **API key** (integrações externas, scripts) — header `X-API-Key: <key>`. Pula a
   sessão inteiramente. O usuário efetivo aparece como `api:<nome da key>`
   (ex.: `api:Zabbix`). Chaves são criadas/excluídas em **Settings → System → API
   access** na própria aplicação, ou via `/api/api-keys` (abaixo) — a key em texto puro
   só existe na resposta do `POST`, nunca mais depois disso. Assim como usuários, toda
   API key tem um `role` (`admin` ou `user`), escolhido na criação e usado como o `role`
   efetivo de qualquer requisição autenticada com aquela key — segue exatamente as
   mesmas regras de **Permissões (role)** abaixo. Keys criadas antes deste campo existir
   mantêm `role: "admin"` (acesso total, comportamento anterior preservado). Toda key
   também tem uma validade escolhida na criação — 1 day / 1 week / 1 month / 1 year /
   Never — gravada como `expires_at` (`null` = nunca expira); passado esse prazo a key
   para de autenticar (`401 invalid_api_key`) mas continua listada até ser excluída
   manualmente. Excluir uma key (`DELETE /api/api-keys/:id`) é permanente — não existe
   mais "revogar" (soft-delete): a linha é removida da tabela e não pode ser recuperada.
2. **Sessão** (cookie `tb45_session`, `HttpOnly`, 12h) — login com usuário/senha via
   `POST /api/auth/login` (ver **Login local e usuários** abaixo) OU login com Google
   (ver **Login com Google** abaixo); os dois usam exatamente o mesmo cookie/sessão — só
   muda a FORMA de chegar até ele. `authMethod` reporta `"local"` ou `"google"`
   separadamente para essas contas.

Não existe mais identificação automática por login do Windows (NTLM) nem um fallback
"anônimo" (dev/usuário do SO) — removidos a pedido do usuário ("deixar somente
autenticação local e com Google"): sem API key nem sessão válida, toda rota que não seja
pública (login/health) recebe `401 { "error": "unauthorized" }`.

### Permissões (role)

Todo `username` identificado (por sessão local/Google) tem um `role` — `user` ou
`admin` — guardado na tabela `users` e provisionado automaticamente (`role: "user"`) na
primeira vez que é visto. `role: "admin"` é exigido para: excluir comando (`DELETE
/api/commands/:id`), Backup & Restore (todos os endpoints `/api/backups*`), gerenciar o
certificado SSL (`/api/system/ssl-certificate*`), ver o audit log (`GET
/api/audit-log`), gerenciar API keys (`/api/api-keys*`) e gerenciar usuários
(`/api/users*`) — endpoints marcados **(admin)** abaixo. Toda outra operação (criar/
editar comando, favoritos, preferências, catálogos) continua liberada para qualquer
usuário identificado. Uma chamada sem `role: admin` para um endpoint **(admin)** recebe
`403 { "error": "forbidden" }`.

**Exemplo (curl, API key):**
```bash
curl https://toolbox45.metalab.tec.br/api/commands \
  -H "X-API-Key: tb45_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

## Formato de erro

Respostas de erro (4xx/5xx) sempre têm o formato:
```json
{ "error": "validation_error", "message": "\"name\" is required" }
```
Códigos de `error` usados: `validation_error` (400), `not_found` (404), `conflict` (409),
`in_use` (409 — item de catálogo em uso por comandos), `protected` (409 — tópico
protegido), `structural_dependency` (409 — parâmetro estrutural, ver Parâmetros),
`invalid_api_key` (401), `invalid_credentials` (401 — login local), `forbidden` (403 —
endpoint exige `role: admin`), `internal_error` (500). Alguns erros `in_use`/
`structural_dependency` também trazem `"count": <n>`.

---

## Comandos (`/api/commands`)

O recurso central da aplicação — cada comando de terminal (fw monitor, cplic print,
etc.) com suas linhas, variações por versão e escopo (vendor/sistema/versão/ambiente/
tópico).

### `GET /api/commands`
**Privado por padrão** (ver seção **Compartilhamento entre usuários** abaixo): um
usuário comum só recebe comandos de referência (`created_by` nulo ou `"System"`), os
PRÓPRIOS comandos, e os de quem compartilhou comandos com ele (`share_commands: true`
numa concessão em `/api/shares`). Admins continuam recebendo todos, sem exceção. O
`created_by`/`modified_by` de um comando de OUTRA pessoa vem trocado pelo **handle**
dela, nunca o username real (ver `GET /api/me`/`/api/shares` abaixo) — exceto para
admins, que continuam vendo o username real de qualquer um.

Filtros opcionais via query string — todos combináveis (AND):

| Parâmetro     | Efeito                                                                 |
|---------------|-------------------------------------------------------------------------|
| `topic`       | Só comandos com esse tópico entre os `topics[]` (topic é obrigatório, então isto SEMPRE restringe) |
| `vendor`      | Comandos sem vendor definido OU com esse vendor entre os `vendors[]`   |
| `system`      | Idem, para `systems[]`                                                 |
| `version`     | Idem, para `versions[]`                                                |
| `environment` | Idem, para `environments[]`                                            |
| `sort`        | `creator` ordena por `created_by` (desempate: `sort_order`, `id`); padrão é `sort_order, id` |

Retorna um array de objetos **Command** (formato completo, ver abaixo).

### `GET /api/commands/:id`
Um único **Command**. `404 not_found` se não existir.

### `POST /api/commands`
Cria um comando. Corpo (campos obrigatórios em **negrito**):

```json
{
  "id": "fwmonitor",
  "name": "fw monitor",
  "desc": "Captures traffic at kernel level",
  "name_empty": "fw monitor (fill SRC/DST)",
  "desc_empty": null,
  "icon": "📄",
  "sort_order": 0,
  "vendors": ["check-point"],
  "systems": ["gaia"],
  "versions": ["r8110"],
  "environments": ["standalone"],
  "topics": ["troubleshooting"],
  "requires_ip_port": false,
  "placeholder_resolver": null,
  "details": "<p><strong>Purpose</strong></p><p>...</p>",
  "lines": [
    { "variant": "default", "sort_order": 0, "line_type": "cmd", "prompt": "[Expert@FW]#", "content": "fw monitor -e \"...\"", "supports_export": true }
  ]
}
```

Campos obrigatórios: **`id`**, **`name`**, **`vendors`** (exatamente 1 item — um
comando pertence a um único vendor), **`systems`** (≥1), **`versions`** (≥1),
**`environments`** (≥1), **`topics`** (≥1 — ou o campo legado `topic`, string única).

`details` (opcional, substitui os antigos `about_icon`/`about_purpose`/
`about_when`/`about_obs`) é um único campo de rich text HTML — o mesmo editor
de formatação usado nas Notes da pasta Folders (negrito/itálico/sublinhado,
tamanho de fonte, 5 cores, alinhamento). O HTML enviado é sanitizado no
servidor (mesma allow-list de tags/estilo usada em Notes) antes de gravar.

`created_by`/`modified_by` são preenchidos automaticamente com o usuário atual —
não são aceitos no corpo. **Exceção**: se o header `X-Save-As-System: 1` for enviado
E o chamador for admin (checado no servidor via role efetiva, não confia no header
sozinho), o comando é gravado como `created_by`/`modified_by = "System"` em vez do
usuário atual — usado hoje só pelo checkbox admin-only "Import as System commands"
no import de CSV. O header é ignorado silenciosamente (sem erro) para não-admins;
o comando é criado normalmente como próprio do usuário.

**Guarda importante**: `requires_ip_port` só é persistido como `true` se `lines`
contiver pelo menos uma linha com `"variant": "empty"` e `content` não vazio — essas
linhas são o que aparece no card quando IP/Porta ainda não foram preenchidos. Sem isso,
a flag é rebaixada para `false` no servidor (em vez de deixar o comando entrar num
estado "invisível" na UI — ver histórico do bug em `server/index.js`,
`buildCommandColumns`). Não há mais controle de UI para essa flag no editor de
comandos — ela só é definida via dados diretos no banco (ex.: o comando
`tcpdumpipport`); as linhas `variant: "empty"` continuam sendo lidas/gravadas
normalmente para não perder os dados desses comandos ao salvar uma edição.

Retorna `201` com o **Command** criado. `400 validation_error` se faltar campo
obrigatório. `409 conflict` se `id` já existir.

### `PUT /api/commands/:id`
Mesmo corpo do `POST` (substitui TODOS os filhos — linhas/escopo). Se `id`
vier no corpo, precisa bater com o da URL. Sem restrição de dono entre usuários comuns
— qualquer um edita qualquer comando de qualquer outro usuário. **Exceção**: comandos
de referência (`created_by: "System"`) só podem ser editados por admins — usuário
comum recebe `403 forbidden` (a UI já esconde o botão Edit nesse caso e oferece
"Duplicate" para criar uma cópia própria editável). `modified_by` é atualizado para o
usuário atual. `404 not_found` / `400 validation_error` / `403 forbidden`.

### `DELETE /api/commands/:id` — **(admin)**
Remove o comando e (via `ON DELETE CASCADE`) todas as suas linhas/escopo/
membership em pastas. `204` no sucesso, `404 not_found`, `403 forbidden` se o chamador
não for admin.

### Formato do objeto **Command** (resposta)
```json
{
  "id": "fwmonitor",
  "topic": "troubleshooting",
  "topics": ["troubleshooting"],
  "folder_ids": [3, 7],
  "icon": "📄",
  "sort_order": 0,
  "requires_ip_port": false,
  "placeholder_resolver": null,
  "name": "fw monitor",
  "name_empty": "fw monitor (fill SRC/DST)",
  "desc": "Captures traffic at kernel level",
  "desc_empty": null,
  "details": "<p><strong>Purpose</strong></p><p>...</p>",
  "vendors": ["check-point"],
  "systems": ["gaia"],
  "versions": ["r8110"],
  "environments": ["standalone"],
  "lines": {
    "default": [{ "line_type": "cmd", "prompt": "[Expert@FW]#", "content": "...", "supports_export": true, "image_data": null }],
    "empty": [{ "line_type": "note", "prompt": null, "content": "Fill SRC/DST to see the full command", "supports_export": false, "image_data": null }]
  },
  "created_at": "2026-08-04T12:00:00.000Z",
  "updated_at": "2026-08-04T12:00:00.000Z",
  "created_by": "rsilva",
  "modified_by": "rsilva",
  "is_system": false
}
```

---

## Pastas (`/api/folders`)
Substituiu a antiga feature "Favorites" — em vez de um único booleano marcado/
desmarcado por comando, cada usuário cria suas próprias pastas (nome livre) e organiza
comandos e **notes** (ver seção própria abaixo) nelas, podendo colocar o mesmo comando
em várias pastas ao mesmo tempo. Tudo aqui é por usuário atual (sessão ou API key) e
**privado**: o campo `folder_ids` no **Command** só reflete as pastas do
usuário que está fazendo a requisição.

- `GET /api/folders` → array de pastas do usuário atual:
  ```json
  [{
    "id": 3,
    "name": "VPN troubleshooting",
    "sort_order": 0,
    "command_ids": ["fwmonitor", "vpnshell"],
    "notes": [{ "id": 10, "folder_id": 3, "username": "rsilva", "title": "IP do site B", "description": "<p>...</p>", "sort_order": 1, "created_at": "...", "updated_at": "..." }],
    "order": [{ "type": "command", "id": "fwmonitor" }, { "type": "note", "id": 10 }, { "type": "command", "id": "vpnshell" }]
  }]
  ```
  `order` é a lista combinada (comandos + notes) na ordem em que o usuário arrastou os
  cards dentro da pasta — cada item é `{ "type": "command"|"note", "id": ... }`. Itens
  de `command_ids`/`notes` que por algum motivo não apareçam em `order` (nunca deveria
  acontecer, mas o front-end trata defensivamente) são exibidos ao final, comandos antes
  de notes.
- `GET /api/folders/all` → mesmo formato, para as pastas de **outros usuários que
  também são visíveis** a quem pediu — **privado por padrão** (ver seção
  **Compartilhamento entre usuários** abaixo): as PRÓPRIAS pastas, mais as de quem
  compartilhou pastas (`share_folders: true`) com quem pediu; admins continuam
  recebendo as de todo mundo, sem exceção. Cada pasta ganha um campo extra
  `"username"` — para uma pasta de outra pessoa, esse campo vem trocado pelo
  **handle** dela (nunca o username real), exceto para admins. Usado pelo seletor de
  escopo de pastas "All"/usuário específico dentro de Folders — ver `docs/README.md`/
  comentários em `js/render.js`.
- `POST /api/folders` — corpo `{ "name": "..." }`. `201` com a pasta criada
  (`command_ids: []`, `notes: []`, `order: []`). `400 validation_error` se faltar
  `name`. `409 conflict` se o usuário já tiver uma pasta com esse nome (nomes são
  únicos por usuário, não globalmente).
- `PUT /api/folders/:id` — corpo `{ "name": "..." }`, renomeia. `404 not_found` se o id
  não existir ou pertencer a outro usuário (não distinguimos os dois casos). `409
  conflict` em caso de colisão de nome.
- `DELETE /api/folders/:id` → `204`. Apaga a pasta; os comandos nela não são afetados,
  só deixam de estar naquela pasta (`ON DELETE CASCADE` em `folder_commands`). **As
  notes da pasta SÃO apagadas junto** (`ON DELETE CASCADE` em `notes` — notes só existem
  dentro de uma pasta, diferente de comandos). `404 not_found`.
- `POST /api/folders/:id/commands/:commandId` → `204`. Adiciona o comando à pasta,
  posicionando-o após o último item existente (comando OU note, o que tiver o maior
  `sort_order`). Idempotente. `404 not_found` se a pasta (do usuário atual) ou o comando
  não existirem.
- `DELETE /api/folders/:id/commands/:commandId` → `204`. Remove o comando da pasta
  (idempotente, mesmo se não estava nela). `404 not_found` se a pasta não existir/não
  for do usuário atual.
- `POST /api/folders/:id/copy` — clona a pasta de outro usuário (corpo
  `{ "name"?: "..." }`, opcional, senão reusa o nome original) para dentro das pastas do
  usuário atual, copiando os `command_ids` **e duplicando as notes** (linhas novas em
  `notes`, preservando título/descrição/posição relativa) — as notas copiadas passam a
  pertencer a quem copiou (`username` = usuário atual, nunca o autor original), então já
  são totalmente editáveis/clonáveis/excluíveis por essa pessoa como qualquer outra nota
  própria. Resposta já vem no mesmo formato de `GET /api/folders` (`notes`/`order`
  incluídos, sem precisar de uma segunda chamada). `404 not_found` se a pasta de origem
  não existir **ou não for visível** para quem pediu (própria, compartilhada com
  `share_folders: true`, ou quem pediu é admin — mesma regra de visibilidade de
  `GET /api/folders/all` acima).
- `PUT /api/folders/:id/reorder` — corpo `{ "order": [{ "type": "command"|"note", "id": ... }, ...] }`
  com a nova ordem completa (mistura comandos e notes livremente). `204`. Aceita também
  o formato antigo `{ "command_ids": [...] }` por compatibilidade (equivalente a
  `order` só com itens `type: "command"`, sem nenhuma note). `404 not_found` se a pasta
  não for do usuário atual. Itens de `order` com `type: "note"` só têm seu `sort_order`
  atualizado se a note pertencer ao usuário atual (proteção extra, além do check de
  dono da pasta).

---

## Notes (`/api/notes` e `/api/folders/:id/notes`)
Anotações de texto livre (título + descrição em HTML) que o usuário cria **dentro de
uma pasta sua** para misturar com os comandos — por exemplo, para deixar lembretes,
IPs de referência ou capturas de tela ao lado dos comandos relacionados. Compartilham a
mesma escala de `sort_order` dos comandos da pasta (ver `order` em `GET /api/folders`
acima), então podem ser arrastadas/intercaladas livremente entre eles.

Regra de permissão: **uma note só existe dentro de uma pasta, e uma pasta só tem um
dono** — logo dono da note == dono da pasta, sempre. Só esse usuário pode editar,
clonar ou excluir a note; outros usuários só a veem (somente leitura) através do
`GET /api/folders/all`, quando o Group By "User folders" ou o seletor de escopo "All"/
usuário específico estiverem selecionados.

A descrição (`description`) é HTML vindo do editor rich-text do front-end
(`contenteditable`, com suporte a colar/redimensionar imagens como `data:image/...`) e
passa por um sanitizador próprio no backend antes de gravar
(`sanitizeNoteHtml()` em `server/index.js`) — tags fora de uma lista pequena permitida
(`b,strong,i,em,u,br,p,div,span,ul,ol,li,a,img`) são removidas mantendo o texto interno;
`<script>`/`<style>` são removidos por completo; `src` de `<img>` só é aceito se
`data:image/...` ou `http(s)://`; `href` de `<a>` só se `http(s)://` (senão vira `#`),
sempre forçando `target="_blank" rel="noopener noreferrer"`.

- `POST /api/folders/:id/notes` — corpo `{ "title"?: "...", "description"?: "<p>...</p>" }`
  (ambos opcionais, default `""`). `201` com a note criada, posicionada após o último
  item existente na pasta (comando ou note). `404 not_found` se a pasta não for do
  usuário atual.
- `PUT /api/notes/:id` — corpo `{ "title"?, "description"? }`. `200` com a note
  atualizada. `404 not_found` se a note não existir ou não pertencer ao usuário atual.
- `DELETE /api/notes/:id` → `204`. `404 not_found` se a note não existir ou não
  pertencer ao usuário atual.
- `POST /api/notes/:id/clone` → `201` com uma nova note na **mesma pasta**, título
  original + `" (copy)"`, posicionada ao final. `404 not_found` se a note de origem não
  existir ou não pertencer ao usuário atual.

---

## `GET /api/me`
Identifica o chamador atual, seu papel e como foi autenticado. Exige sessão ou API key
(ver **Autenticação** acima) — sem uma das duas, `401 unauthorized`.
```json
{
  "username": "rsilva@seg45.com.br",
  "upn": "rsilva@seg45.com.br",
  "role": "admin",
  "isAdmin": true,
  "authMethod": "google",
  "handle": "rsilva"
}
```
`upn` espelha `username` (mantido só por compatibilidade com respostas antigas — quando
a identificação vinha do Windows/NTLM, `upn` era resolvido separadamente via Active
Directory). `authMethod` é `"local"` | `"google"` | `"api_key"`. Para chamadas com API
key, `username` é `api:<nome da key>`, `upn` espelha o mesmo valor e `role`/`isAdmin`
sempre vêm como admin (ver seção Permissões acima). `handle` é o apelido de
compartilhamento do usuário (ver seção **Compartilhamento entre usuários** abaixo);
`null` para chamadas via API key.

---

## Compartilhamento entre usuários (`/api/me/handle`, `/api/shares`)

Por padrão, pastas e comandos de um usuário são **privados**: os demais só os veem se
o dono compartilhar explicitamente. Cada usuário tem um **handle** — um apelido único,
gerado automaticamente na criação da conta e trocável livremente depois — usado para
identificá-lo nesse compartilhamento **sem expor o username real** (que é o e-mail, no
caso de contas Google). Admins continuam vendo as pastas/comandos de todo mundo sempre,
independente de qualquer concessão aqui (ver **Permissões** acima).

### `PUT /api/me/handle`
Troca o próprio handle. Corpo `{ "handle": "novo-handle" }` — minúsculas, 2 a 32
caracteres, `[a-z0-9._-]`, começando/terminando em letra ou número (o servidor já
normaliza para minúsculas antes de validar). `200` com `{ "handle": "novo-handle" }`.
`400 validation_error` se o formato for inválido. `409 conflict` se já estiver em uso
por outra conta (handles são únicos globalmente).

### `GET /api/shares`
Lista as concessões do usuário atual, nos dois sentidos:
```json
{
  "given": [
    { "id": 1, "share_folders": true, "share_commands": false, "created_at": "...", "updated_at": "...", "grantee_handle": "jsilva" }
  ],
  "received": [
    { "id": 4, "share_folders": true, "share_commands": true, "created_at": "...", "updated_at": "...", "grantor_handle": "mcosta" }
  ]
}
```
`given` = concessões que EU dei (posso revogar); `received` = concessões que ME deram
(só leitura aqui — quem revoga é sempre o grantor).

### `POST /api/shares`
Cria ou atualiza (UPSERT) uma concessão para o handle informado. Corpo:
```json
{ "handle": "jsilva", "share_folders": true, "share_commands": false }
```
Pelo menos um de `share_folders`/`share_commands` precisa ser `true`. Vale
IMEDIATAMENTE — não há fluxo de aceite do outro lado. Chamar de novo com o mesmo
`handle` só atualiza os toggles da concessão já existente (não duplica). `201` com a
concessão criada/atualizada (inclui `grantee_handle`). `400 validation_error` se faltar
`handle`, se os dois toggles vierem `false`, ou se `handle` for o do próprio usuário
(não dá para compartilhar consigo mesmo). `404 not_found` se não existir ninguém com
esse handle.

### `DELETE /api/shares/:id`
Revoga uma concessão que EU dei (só o grantor pode revogar a própria). `204`. `404
not_found` se o id não existir ou pertencer a outro grantor (não distinguimos os dois
casos).

---

## Links (`/api/links`)

Favoritos pessoais — pedido do usuário: "crie ao lado do IP Calc uma estrutura igual
dos favoritos dos browsers, onde o usuário pode inserir links e nomear". Puramente
PESSOAL: cada usuário só vê/gerencia os PRÓPRIOS links, sem nenhum conceito de
compartilhamento/grupo/admin aqui (diferente de comandos/pastas) — igual a um
favoritos de navegador de verdade. Ver `links` em `server/schema.sql` e o dropdown
"Links" no header (`js/links.js`).

### `GET /api/links`
Lista os links do usuário atual, em ordem de criação. `200` `[{ "id": 5, "name": "Wiki
interna", "url": "https://wiki.seg45.com.br", "created_at": "..." }, ...]`.

### `POST /api/links`
Cria um link — corpo `{ "name", "url" }` → `201` com o objeto criado. `url` aceita um
domínio "nu" sem esquema (ex.: `google.com`) — `https://` é prefixado automaticamente
antes de validar. `400 validation_error` se `name` estiver vazio ou `url` não for uma
URL válida mesmo depois de normalizada.

### `PUT /api/links/:id`
Corpo `{ "name", "url" }` (mesmas regras do POST). `404 not_found` se o id não existir
ou pertencer a outro usuário (não distinguimos os dois casos).

### `DELETE /api/links/:id`
`204`. `404 not_found` nas mesmas condições do PUT.

---

## Login local e usuários

### `POST /api/auth/login`
Loga com uma conta local (usuário/senha). Corpo: `{ "username": "admin", "password":
"admin" }`. Sucesso: `200` `{ "username": "admin", "role": "admin" }` + `Set-Cookie:
tb45_session=...` (`HttpOnly`, 12h). Falha: `401 invalid_credentials` (usuário local
inexistente, senha errada, ou conta desabilitada). Rota pública (não exige sessão
prévia — senão ninguém conseguiria logar).

### `POST /api/auth/logout`
Encerra a sessão ativa, local ou Google (limpa a linha em `sessions` e o cookie).
`204`, idempotente (funciona mesmo sem sessão ativa). Rota pública.

### Usuário local padrão
Toda instalação nova já vem com uma conta local `admin` / senha `admin`, role `admin`
(semeada automaticamente por `server/db.js` assim que o schema é aplicado — ver
`seedDefaultAdmin()`). **Troque essa senha assim que possível** (`PUT
/api/users/admin`, veja abaixo, ou pela tela Settings → System → Users).

---

## Login com Google

OAuth 2.0 (Authorization Code) contra o Google — habilitado só quando o backend tem as
3 variáveis de ambiente `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e
`GOOGLE_REDIRECT_URI` configuradas (ver comentário no topo desta seção em
`server/index.js` e o bloco comentado em `docker-compose.yml`). Sem restrição de
domínio Google Workspace — qualquer conta Google pode entrar. Login com o `code` de
outro provedor/flow não é aceito; o fluxo inteiro é feito de navegações de página
inteira (não `fetch`), já que precisa passar por `accounts.google.com`.

### `GET /api/auth/providers`
Público (sem auth). `{ "google": true|false }` — `login.html` usa isto para decidir se
mostra o botão "Sign in with Google".

### `GET /api/auth/google`
Redireciona (`302`) para a tela de consentimento do Google. `503` se as 3 variáveis de
ambiente acima não estiverem configuradas. Rota pública.

### `GET /api/auth/google/callback`
Destino do redirect de volta do Google (`redirect_uri` registrado no Google Cloud
Console — precisa ser EXATAMENTE `GOOGLE_REDIRECT_URI`). Troca o `code` pelos tokens do
Google, confirma o e-mail (`email_verified`) via `GET
https://openidconnect.googleapis.com/v1/userinfo`, e:
- Se o e-mail já existe como usuário local (não como conta Google) → recusa (evita
  account takeover) e redireciona para `login.html?google=error&reason=account_exists_other_method`.
- Se é a primeira vez que esse e-mail aparece → cria a conta automaticamente, mas
  **desabilitada** (pendente de aprovação por um admin, igual ao auto-cadastro local —
  ver `POST /api/auth/register` abaixo) e redireciona para `login.html?google=pending`.
- Se o e-mail já existe como conta Google mas ainda pendente de aprovação → mesmo
  redirect `login.html?google=pending`. Se já existe mas foi desabilitada DEPOIS de
  aprovada → `login.html?google=error&reason=account_disabled`.
- Em qualquer sucesso (conta já aprovada), cria uma sessão (mesmo mecanismo de
  `POST /api/auth/login`, cookie `tb45_session`) e redireciona para
  `login.html?google=success`.
- Em qualquer falha, redireciona para `login.html?google=error&reason=<motivo>`
  (`access_denied`, `invalid_state`, `account_exists_other_method`, `account_disabled`,
  `not_configured`, entre outros) — `login.html` mostra a mensagem correspondente.

---

## Login com Microsoft

OAuth 2.0 (Authorization Code) contra a Microsoft identity platform v2.0 — habilitado só
quando o backend tem as 3 variáveis de ambiente `MICROSOFT_CLIENT_ID`,
`MICROSOFT_CLIENT_SECRET` e `MICROSOFT_REDIRECT_URI` configuradas (ver comentário no
topo desta seção em `server/index.js`, o bloco comentado em `docker-compose.yml` e o
passo a passo completo em `docs/server-overview.md`). `MICROSOFT_TENANT_ID` é opcional
(default `common` — qualquer conta Microsoft, pessoal ou de qualquer organização; um
tenant ID/domínio específico restringe o login só àquela organização). Mesmo mecanismo
de sessão/cookie do Google — o fluxo inteiro é feito de navegações de página inteira
(não `fetch`), já que precisa passar por `login.microsoftonline.com`.

### `GET /api/auth/providers`
Mesma rota do Google acima — devolve `{ "google": true|false, "microsoft": true|false }`.
`login.html` usa isto para decidir se mostra o botão "Sign in with Microsoft".

### `GET /api/auth/microsoft`
Redireciona (`302`) para a tela de consentimento da Microsoft
(`login.microsoftonline.com/<MICROSOFT_TENANT_ID>/oauth2/v2.0/authorize`). `503` se as 3
variáveis de ambiente obrigatórias acima não estiverem configuradas. Rota pública.

### `GET /api/auth/microsoft/callback`
Destino do redirect de volta da Microsoft (`redirect_uri` registrado no Azure Portal —
precisa ser EXATAMENTE `MICROSOFT_REDIRECT_URI`). Troca o `code` pelos tokens, confirma
o e-mail via `GET https://graph.microsoft.com/oidc/userinfo` (diferente do Google, o
provedor Microsoft não expõe um campo `email_verified` — só exige o e-mail presente), e:
- Se o e-mail já existe como usuário local/Google/NTLM (não como conta Microsoft) →
  recusa (evita account takeover) e redireciona para
  `login.html?microsoft=error&reason=account_exists_other_method`.
- Se é a primeira vez que esse e-mail aparece → cria a conta automaticamente, mas
  **desabilitada** (pendente de aprovação por um admin, igual ao Google/auto-cadastro
  local) e redireciona para `login.html?microsoft=pending`.
- Se o e-mail já existe como conta Microsoft mas ainda pendente de aprovação → mesmo
  redirect `login.html?microsoft=pending`. Se já existe mas foi desabilitada DEPOIS de
  aprovada → `login.html?microsoft=error&reason=account_disabled`.
- Em qualquer sucesso (conta já aprovada), cria uma sessão (mesmo mecanismo de
  `POST /api/auth/login`, cookie `tb45_session`) e redireciona para
  `login.html?microsoft=success`.
- Em qualquer falha, redireciona para `login.html?microsoft=error&reason=<motivo>`
  (`access_denied`, `invalid_state`, `account_exists_other_method`, `account_disabled`,
  `not_configured`, entre outros) — `login.html` mostra a mensagem correspondente.

### `GET /api/users` — **(admin)**
Lista todo usuário já visto pela aplicação (contas locais, Google ou Microsoft — `auth_provider`
distingue). Nunca devolve `password_hash`.
```json
[{ "username": "admin", "role": "admin", "is_local": 1, "disabled": 0, "created_at": "...", "created_by": "system", "auth_provider": "local", "handle": "admin" },
 { "username": "jsilva@gmail.com", "role": "user", "is_local": 0, "disabled": 0, "created_at": "...", "created_by": "google-oauth", "auth_provider": "google", "handle": "jsilva" }]
```
Instalações antigas (de antes do login do Windows/NTLM ser removido) podem ainda listar
contas com `auth_provider: "ntlm"` — nunca fazem login (não têm senha nem vínculo com
Google); um admin pode desabilitá-las/excluí-las quando não forem mais necessárias.
`handle` é o apelido de compartilhamento da conta (ver **Compartilhamento entre
usuários** acima) — aqui, como em toda esta seção admin-only, vem sempre como o
handle de verdade (nunca mascarado).

### `POST /api/users` — **(admin)**
Cria uma conta **local** — corpo `{ "username", "password" (≥4 caracteres), "role"? }`
(`role` é `"user"` por padrão) → `201`. `400 validation_error` se `username` não for um
e-mail válido (pedido do usuário: "remova o nome de usuário e trate tudo pelo email" —
mesmo `EMAIL_RE`/normalização `.toLowerCase()` do auto-cadastro em `POST
/api/auth/register`; contas locais já existentes sem formato de e-mail, como a `admin`
semeada, não são migradas). `409 conflict` se o e-mail já existir.

### `PUT /api/users/:username` — **(admin)**
Corpo parcial — qualquer combinação de `{ "role": "admin"|"user", "disabled": bool,
"password": "..." }`. `password` só é aceito para contas locais (`400
validation_error` para conta Google). Recusa com `409 conflict` qualquer mudança que
deixaria a aplicação **sem nenhum admin habilitado** (trava de segurança contra
lockout).

### `DELETE /api/users/:username` — **(admin)**
Remove a linha de usuário (e suas sessões, via `ON DELETE CASCADE`). Uma conta Google
excluída é recriada automaticamente (role `user`) no próximo login com aquele e-mail.
Mesma trava contra remover o último admin habilitado (`409 conflict`).

---

## Log de auditoria (`GET /api/audit-log`) — **(admin)**
Histórico de criação/edição/exclusão de comandos, últimos 30 dias (retenção automática),
mais recente primeiro, limite de 1000 linhas.
```json
[{ "id": 42, "ts": "2026-08-04T12:00:00.000Z", "username": "rsilva", "action": "update", "command_id": "fwmonitor", "command_name": "fw monitor" }]
```
`action` é `create` | `update` | `delete`.

---

## Dados por usuário (`/api/user-data`, `/api/global-settings`)
Armazenamento genérico chave/valor (tema, idioma, filtros, históricos de busca — o que
antes vivia só no `localStorage` do navegador).

- `GET /api/user-data` → `{ "cpa-theme": "dark", "cpa-settings": "{...}", ... }` (tudo do
  usuário atual).
- `PUT /api/user-data` → corpo `{ chave: valor, ... }`, upsert parcial (só as chaves
  enviadas; `null`/`undefined` são ignorados, não apagam a chave). `204`.
- `GET`/`PUT /api/global-settings` → mesmo formato, mas grava sob um usuário sentinela
  compartilhado (`__global_defaults__`) — são os **defaults** herdados por quem ainda
  não tem preferência própria salva (não afeta quem já personalizou algo).

---

## API keys (`/api/api-keys`) — **(admin)**
Ver também a seção Autenticação acima e `api_keys` em `server/schema.sql`.

- `GET /api/api-keys` → lista (sem o valor da key, só metadados):
  ```json
  [{ "id": 3, "name": "Zabbix", "role": "user", "key_prefix": "tb45_a1b2c3d4", "created_by": "rsilva", "created_at": "...", "expires_at": null, "last_used_at": "...", "revoked_at": null }]
  ```
- `POST /api/api-keys` — corpo `{ "name": "Zabbix", "role": "user", "validity": "1m" }` →
  `201`, **a única vez** que a key completa aparece. `role` é opcional (`admin` ou
  `user`, default `"user"`) — define o `role` efetivo de todas as requisições
  autenticadas com essa key, igual ao `role` de um usuário (ver **Permissões (role)**
  acima). `validity` é opcional (`"1d"` | `"1w"` | `"1m"` | `"1y"` | `"never"`, default
  `"never"`) e é convertida em `expires_at` (data absoluta, `null` quando `"never"`):
  ```json
  { "id": 3, "name": "Zabbix", "role": "user", "key_prefix": "tb45_a1b2c3d4", "created_by": "rsilva", "created_at": "...", "expires_at": "2026-09-05T00:00:00.000Z", "key": "tb45_a1b2c3d4e5f6...(64 hex)" }
  ```
- `DELETE /api/api-keys/:id` → exclusão permanente (remove a linha da tabela — não é
  mais um soft-delete). Uma key excluída nunca mais autentica e não pode ser
  recuperada. `204`, `404 not_found`.

---

## Catálogos administráveis

Hierarquia estrita **Vendor → Sistema → Versão** (1:N reais, FK obrigatória) e N:N
livre **Versão ↔ Ambiente** / **Ambiente ↔ Tópico**. `key` de cada item é gerado no
servidor a partir do `label` (slug) e nunca é editável depois de criado — exclusão é
bloqueada (`409 in_use`) enquanto algum comando referenciar aquele valor.

### `GET /api/catalogs`
Todos os catálogos de uma vez (usado no boot do front-end):
```json
{
  "vendors": [{ "key": "check-point", "label": "Check Point", "color": "#e2231a", "sort_order": 0 }],
  "systems": [{ "key": "gaia", "vendor": "check-point", "label": "Gaia", "color": "...", "sort_order": 0 }],
  "versions": [{ "system": "gaia", "vendor": "check-point", "key": "r8110", "label": "R81.10", "color": "...", "sort_order": 0 }],
  "environments": [{ "key": "standalone", "label": "Standalone", "color": "...", "sort_order": 0 }],
  "topics": [{ "key": "troubleshooting", "label": "Troubleshooting", "color": "...", "sort_order": 0, "is_protected": 0 }],
  "parameters": [{ "key": "src_ip", "label": "Source", "sort_order": 0 }],
  "version_environments": [{ "version": "r8110", "environment": "standalone" }],
  "environment_topics": [{ "environment": "standalone", "topic": "troubleshooting" }]
}
```

### Vendors — `/api/vendors`
- `POST` — corpo `{ "label", "color"? }` → `201` (key gerada a partir do label).
- `PUT /api/vendors/:key` — corpo `{ "label"?, "color"?, "sort_order"? }` → `200`.
- `DELETE /api/vendors/:key` — `204`; `409 in_use` se algum comando usa; cascata apaga
  os `systems`/`versions` filhos.

### Sistemas — `/api/systems`
Igual a Vendors, mas exige `vendor` (key de um vendor existente) na criação/edição —
`400 validation_error` se o vendor não existir. Trocar o `vendor` de um sistema também
realinha `versions.vendor` dos filhos automaticamente.

### Versões — `/api/versions`
Chave primária composta (`system`, `key`) — o mesmo `key` pode existir em sistemas
diferentes, mas não duas vezes no MESMO vendor (`UNIQUE(vendor, key)`).
- `POST` — corpo `{ "label", "system", "color"? }` (system obrigatório) → `201`.
- `PUT /api/versions/:system/:key` — pode inclusive mover a versão para outro `system`
  no corpo (`{ "system": "novo-sistema" }`) — valida conflito antes de mover.
- `DELETE /api/versions/:system/:key` — `409 in_use` se algum comando usa.

### Ambientes — `/api/environments`
CRUD simples (`POST` / `PUT /:key` / `DELETE /:key`), igual a Vendors.

- `PUT /api/environments/:key/versions` — corpo `{ "versions": ["r8110", "r8210"] }`
  substitui TODO o conjunto de versões vinculadas a esse ambiente (N:N).

### Tópicos — `/api/topics`
Igual a Ambientes, mas com `is_protected` (só o tópico interno `environment` tem
`is_protected=1` — usado nos cards de "Ambiente específico"; não pode ser excluído e
fica fora dos filtros de Tópico da UI).

- `PUT /api/topics/:key/environments` — corpo `{ "environments": [...] }`, mesmo padrão
  N:N do endpoint de versões acima.

### Parâmetros — `/api/parameters`
Os tokens `{{key}}` usados nos templates de comando (`src_ip`, `dst_ip`, `ip`, `port`,
etc.), administrados na aba Parâmetros da tela de catálogo.
- `POST` — corpo `{ "key", "label", "sort_order"? }` — **`key` é digitado pelo usuário**
  (diferente dos outros catálogos, que geram slug automaticamente), validado contra
  `^[A-Za-z0-9._-]{1,40}$`. `409 conflict` se já existir.
- `PUT /api/parameters/:key` — só `label`/`sort_order` (key imutável).
- `DELETE /api/parameters/:key` — bloqueado com `409` se: (a) `{{key}}` aparece em
  alguma linha de algum comando (`error: "in_use"`); ou (b) é `ip`/`port` e algum
  comando tem `requires_ip_port=true` (`error: "structural_dependency"` — esses 2 são
  lidos diretamente pela lógica de estado vazio do card, não só por substituição de
  template).

---

## Backup & Restore (`/api/backups`, `/api/backup-schedule`) — **(admin)**
Dumps do PostgreSQL via `pg_dump`/`pg_restore` (formato "custom"), guardados no volume
`toolbox45-backups` do container backend.

- `GET /api/backups` → `[{ "filename": "backup-20260804-020000.dump", "sizeBytes": 123456, "createdAt": "..." }]`.
- `POST /api/backups` → cria um dump agora → `201 { "filename": "..." }`.
- `GET /api/backups/:filename/download` → baixa o arquivo `.dump`.
- `DELETE /api/backups/:filename` → apaga o arquivo → `204`.
- `POST /api/backups/:filename/restore` → tira um snapshot de segurança do estado
  atual (prefixo `pre-restore-`) e então restaura (`pg_restore --clean --if-exists`) →
  `200 { "ok": true, "message": "..." }`.
- `GET`/`PUT /api/backup-schedule` → agendamento diário/semanal/mensal, ex.:
  ```json
  { "enabled": true, "frequency": "daily", "weeklyDays": [], "monthlyDay": 1, "time": "02:00" }
  ```
  Checado a cada minuto pelo backend (`checkScheduledBackup`); `backupScheduleLastRunDate`
  evita rodar duas vezes no mesmo dia.

---

## SSL Certificate (`/api/system/ssl-certificate`) — **(admin)**
Certificado/chave usados pelo nginx do `toolbox45-frontend` para servir HTTPS (porta
443) — guardados no volume `toolbox45-tls`, compartilhado (rw aqui, ro no frontend). No
primeiro boot (e sempre que não houver certificado customizado), o backend gera um
autoassinado sozinho (`ensureTlsBootstrap()`/`generateSelfSignedCert()` em
`server/index.js`, via `openssl req`) — estes endpoints só entram em cena para
importar/remover um certificado próprio. Alterar o volume não exige reiniciar o
frontend: um watcher com `inotifywait` dentro do container dele (ver
`frontend/docker-entrypoint.sh`) dá `nginx -s reload` sozinho assim que os arquivos
mudam.

- `GET /api/system/ssl-certificate` → informações do certificado atual (nunca expõe a
  chave privada):
  ```json
  {
    "subject": "CN=toolbox45", "issuer": "CN=toolbox45",
    "validFrom": "...", "validTo": "...",
    "fingerprint256": "AA:BB:...", "serialNumber": "...",
    "isSelfSigned": true, "isExpired": false
  }
  ```
- `POST /api/system/ssl-certificate` — corpo `{ "cert": "-----BEGIN CERTIFICATE-----...", "key": "-----BEGIN PRIVATE KEY-----...", "chain": "..." }`
  (`chain` opcional, anexada após `cert`). Valida que `cert` é um X.509 parseável, que
  `key` é uma chave privada PEM sem senha, que a chave realmente corresponde ao
  certificado, e que o certificado não está expirado — rejeita com `400` caso
  contrário. Faz backup dos arquivos anteriores antes de sobrescrever
  (`TLS_BACKUP_DIR`) → `200` com o mesmo formato do `GET` acima.
- `DELETE /api/system/ssl-certificate` → remove o certificado customizado e gera um
  novo autoassinado (mesmo backup automático antes) → `200` com o novo status.

---

## Referências

- Schema completo do banco: `server/schema.sql`.
- Implementação de cada rota: `server/index.js`.
- Modelo de containers/deploy: `docs/install-instructions.txt`.
