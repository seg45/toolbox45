-- ════════════════════════════════════════════════
-- Check Point Commands — schema relacional (PostgreSQL)
-- ════════════════════════════════════════════════
-- Convertido de SQLite para PostgreSQL (toolbox45-db, container próprio —
-- ver docker-compose.yml) como parte da separação em 3 containers
-- (toolbox45-db / toolbox45-backend / toolbox45-frontend). O backend
-- (server/db.js) aplica este arquivo por inteiro a cada boot — todo comando
-- é CREATE TABLE IF NOT EXISTS, então reexecutar é seguro (idempotente).
--
-- Este banco não é semeado automaticamente (ver server/db.js) — todas as
-- tabelas começam vazias e continuam vazias até serem populadas manualmente
-- (tela de administração de catálogo / editor de comandos / importação CSV),
-- exceto se `node seed.js` for rodado explicitamente (ver server/seed.js).
--
-- Um comando (fw monitor, tcpdump, cplic print, ...) é um registro em `commands`,
-- com uma ou mais linhas de terminal associadas (`command_lines`).
--
-- (Removidos: campo `raw_template`, feature "Differences by version"
-- (`command_diffs`/`command_diff_lines`) e flag `requires_ips` — pedido do
-- usuário. `raw_template` já não tinha nenhum efeito visível (o botão de
-- copiar real é por linha, não usa esse campo); "Differences by version"
-- e `requires_ips` eram funcionalidades reais, removidas junto com todo o
-- conteúdo já cadastrado nelas.)
--
-- Todo o texto da aplicação (banco + UI) é em inglês, sem bilinguismo.
--
-- Templates de conteúdo podem conter placeholders {{src_ip}}, {{dst_ip}}, {{src_port}}, {{dst_port}},
-- {{proto}}, {{iface}}, {{vsid}}, {{capFile}}, {{dbgFile}}, {{logFile}} — resolvidos
-- em tempo de render pelo front-end. Um pequeno subconjunto de comandos avançados
-- (que hoje calculam CIDR/listas/faixas de IP e regex de filtro — fw monitor,
-- tcpdump, fw ctl zdebug, fw tab, ip route get, fwaccel conns, fw fetchlogs,
-- fwm logexport) mantém esse cálculo em JS (net-utils.js) e é referenciado via
-- `placeholder_resolver` — o valor calculado substitui o placeholder correspondente
-- em vez de ser puro texto estático.
--
-- Notas de conversão SQLite → PostgreSQL:
--   * INTEGER PRIMARY KEY AUTOINCREMENT  -> SERIAL PRIMARY KEY / BIGSERIAL
--   * datetime('now')                    -> NOW() (colunas viram TIMESTAMPTZ)
--   * Flags booleanas (requires_ip_port, ...) continuam INTEGER 0/1 (não BOOLEAN)
--     de propósito — o backend já trata como `!!row.requires_ip_port` e o driver
--     `pg` devolve INTEGER como Number, então nenhuma mudança de código era
--     necessária além da própria query.
--   * PRAGMA foreign_keys = ON não existe no Postgres — FKs já são sempre
--     aplicadas.

CREATE TABLE IF NOT EXISTS commands (
  -- ID numérico sequencial (1, 2, 3, ...) — pedido do usuário: "implementar
  -- ID sequencial de verdade". Antes era um slug de texto estável (ex.:
  -- 'fwmonitor', 'cplic-print'), gerado a partir do Name; agora é sempre
  -- atribuído pelo próprio Postgres na criação (INSERT ... RETURNING id, ver
  -- POST /api/commands em server/index.js) — nunca digitado nem calculado
  -- por ninguém, e nunca muda depois de criado. Instalações que já tinham o
  -- id antigo (TEXT) são convertidas automaticamente no boot — ver
  -- migrateCommandsIdToSerial() em server/db.js — preservando todos os
  -- vínculos (command_vendors/systems/versions/environments/topics/lines,
  -- folder_commands) na mesma migração.
  id                  SERIAL PRIMARY KEY,
  topic               TEXT NOT NULL,        -- tópico primário (= topics[0]), ver command_topics abaixo
  icon                TEXT NOT NULL DEFAULT '📄',
  sort_order          INTEGER NOT NULL DEFAULT 0,
  requires_ip_port    INTEGER NOT NULL DEFAULT 0,   -- 1 = card muda de conteúdo quando IP/Porta (genéricos, sem direção) não preenchidos
  placeholder_resolver TEXT,                -- nome da função JS usada p/ resolver placeholders avançados (nullable)

  name                TEXT NOT NULL,
  name_empty          TEXT,                 -- variante do nome quando requires_ip_port=1 (IP/Porta vazios) (opcional)

  "desc"              TEXT NOT NULL DEFAULT '', -- nome entre aspas: "desc" é palavra reservada no PostgreSQL (rótulo na UI: "Description")
  desc_empty          TEXT,

  -- `details` — pedido do usuário: "vamos simplificar os campos de
  -- informações do comando... criar um campo Details e migrar o conteúdo
  -- dos campos Purpose/When to use/Note para esse campo... remover os
  -- campos Purpose/When to use/Note... no campo Details permitir a
  -- formatação igual em notes da pasta folders". Substitui os 4 campos
  -- antigos about_icon/about_purpose/about_when/about_obs (removidos, ver
  -- migração em server/db.js) por um único campo de texto RICO (HTML), no
  -- mesmo modelo da feature Notes: editado num <div contenteditable> com
  -- negrito/itálico/sublinhado/tamanho de fonte/cor/alinhamento (ver
  -- neExec-equivalentes cdExec/cdSetFontSize/cdSetColor em
  -- js/command-editor.js) e sanitizado no servidor antes de gravar
  -- (sanitizeNoteHtml em server/index.js, a mesma função usada pelas notas).
  -- Ainda passa por resolveTokens() no render (js/db-render-engine.js) —
  -- {{ip}}/{{port}}/etc. continuam sendo substituídos dentro do HTML, exatamente
  -- como já acontecia nos 3 campos antigos.
  details             TEXT NOT NULL DEFAULT '',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Autoria/auditoria. `created_by = 'System'` marca um comando de referência
  -- (rebuild a partir dos Admin Guides oficiais). PUT (editar) só é permitido
  -- para o próprio dono (created_by = usuário autenticado) ou para um admin
  -- (task #455/#456) — um usuário comum que queira alterar o comando de
  -- outro (ou um comando System) precisa duplicá-lo primeiro (POST normal).
  -- DELETE continua exigindo role='admin' independente de quem seja o dono
  -- (requireAdmin, sem checagem de created_by). `modified_by` registra quem
  -- fez a última alteração (cai em created_by antes da 1ª edição).
  created_by          TEXT,
  modified_by         TEXT
);

-- Aplicabilidade por vendor/OS/versão/ambiente. Ausência de linhas = "aplica a
-- todos" (default) — mesma semântica para as quatro tabelas abaixo.
CREATE TABLE IF NOT EXISTS command_vendors (
  command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  vendor     TEXT NOT NULL,   -- ex.: 'check-point'
  PRIMARY KEY (command_id, vendor)
);
CREATE TABLE IF NOT EXISTS command_systems (
  command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  system     TEXT NOT NULL,   -- ex.: 'gaia'
  PRIMARY KEY (command_id, system)
);
CREATE TABLE IF NOT EXISTS command_versions (
  command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  version    TEXT NOT NULL,   -- 'R81.10' | 'R81.20' | 'R82' | 'R82.10'
  PRIMARY KEY (command_id, version)
);
CREATE TABLE IF NOT EXISTS command_environments (
  command_id  INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,  -- 'standalone' | 'cluster' | 'vsx' | 'maestro' | 'mds' | 'gaia'
  PRIMARY KEY (command_id, environment)
);

-- Tópicos aos quais um comando pertence — ao contrário de versão/ambiente, aqui a
-- ausência de linhas NÃO significa "todos": todo comando tem sempre pelo menos 1
-- linha aqui. `commands.topic` é mantido em paralelo como "tópico primário"
-- (topics[0]) só por compatibilidade — a lista completa em command_topics é a
-- fonte de verdade para agrupamento/filtro.
CREATE TABLE IF NOT EXISTS command_topics (
  command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  topic      TEXT NOT NULL,
  PRIMARY KEY (command_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_command_topics_topic ON command_topics(topic);

-- ════════════════════════════════════════════════
-- Catálogos administráveis (Vendor / Sistema / Versão / Ambiente / Tópico /
-- Parâmetro) — cadastráveis pela tela de administração de catálogo. `key` é
-- o identificador estável usado nas tabelas de vínculo acima — por isso NUNCA
-- é editável depois de criado (só label/cor/ordem). Exclusão é bloqueada em
-- server/index.js quando o valor estiver em uso por pelo menos um comando.
-- ════════════════════════════════════════════════

-- Vendor → Sistema → Versão é uma hierarquia ESTRITA (1:N): um Sistema
-- pertence a exatamente um Vendor (`systems.vendor`, FK obrigatória) e uma
-- Versão pertence a exatamente um Sistema (`versions.system`, FK obrigatória).
CREATE TABLE IF NOT EXISTS vendors (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#8B949E',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS systems (
  key        TEXT PRIMARY KEY,
  vendor     TEXT NOT NULL REFERENCES vendors(key) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#8B949E',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_systems_vendor ON systems(vendor);

-- Versões (ex.: R81.10, R82). Chave primária composta (system, key) porque o
-- mesmo nome de versão pode se repetir em Sistemas diferentes; UNIQUE(vendor,
-- key) impede repetição dentro do MESMO Vendor mesmo entre Sistemas dele
-- (`vendor` é denormalizado a partir de systems.vendor, mantido em sincronia
-- pelo backend).
CREATE TABLE IF NOT EXISTS versions (
  system     TEXT NOT NULL REFERENCES systems(key) ON DELETE CASCADE,
  vendor     TEXT NOT NULL REFERENCES vendors(key) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#8B949E',
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (system, key),
  UNIQUE (vendor, key)
);

-- Ambiente agora tem um Sistema relacionado (FK obrigatória, mesmo padrão de
-- versions.system/vendor acima) — pedido do usuário: "Environment deve ter um
-- sistema relacionado". Diferente de Versão, o `key` de Ambiente continua uma
-- PK simples (não composta): não há necessidade de repetir o mesmo nome de
-- ambiente sob Sistemas diferentes, e manter a PK simples evita ter que tocar
-- em version_environments/environment_topics/command_environments (que
-- guardam `environment` como TEXT solto, sem FK formal — ver comentários
-- abaixo). `vendor` é denormalizado a partir de systems.vendor (mesmo padrão
-- de versions.vendor), mantido em sincronia pelo backend. Numa instalação já
-- existente (de antes desta coluna existir) o backfill destes valores é feito
-- em runMigrations() (server/db.js), inferindo o Sistema a partir dos vínculos
-- em version_environments quando possível.
-- system/vendor NOT NULL só se aplica a instalações NOVAS (CREATE TABLE só
-- roda se a tabela ainda não existir) — toda criação de Ambiente passa pela
-- API (POST /api/environments), que sempre exige `system` no body, então
-- nunca há como um ambiente novo nascer sem essa FK. Numa instalação que já
-- tinha `environments` de antes desta coluna existir, as colunas chegam via
-- ALTER TABLE ADD COLUMN (nullable) + backfill em runMigrations() (server/
-- db.js), só virando NOT NULL ali depois que nenhuma linha ficar sem Sistema.
-- idx_environments_system NÃO fica aqui de propósito — mesmo motivo do
-- comentário sobre idx_folders_parent mais abaixo (CREATE TABLE IF NOT EXISTS
-- é pulado inteiro numa instalação que já tinha `environments` de antes desta
-- coluna existir, e um CREATE INDEX sobre uma coluna que ainda não existe
-- falharia com "column system does not exist"). O índice só é criado em
-- runMigrations() (server/db.js), depois do ALTER TABLE ADD COLUMN.
CREATE TABLE IF NOT EXISTS environments (
  key        TEXT PRIMARY KEY,
  system     TEXT NOT NULL REFERENCES systems(key) ON DELETE CASCADE,
  vendor     TEXT NOT NULL REFERENCES vendors(key) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#8B949E',
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ── Vínculo N:N Versão ↔ Ambiente ── `version` é guardado só como TEXT (sem
-- FK formal), mesmo padrão "soft" de command_versions, já que o mesmo `key`
-- de versão pode existir em mais de um Sistema.
CREATE TABLE IF NOT EXISTS version_environments (
  version     TEXT NOT NULL,
  environment TEXT NOT NULL REFERENCES environments(key) ON DELETE CASCADE,
  PRIMARY KEY (version, environment)
);

-- Tópicos (ex.: capture, vpn). `is_protected` = 1 marca o tópico especial
-- 'environment' (usado internamente para os cards de "Ambiente específico"):
-- não pode ser excluído e fica fora dos filtros de Tópico.
CREATE TABLE IF NOT EXISTS topics (
  key           TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#8B949E',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_protected  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS environment_topics (
  environment TEXT NOT NULL REFERENCES environments(key) ON DELETE CASCADE,
  topic       TEXT NOT NULL REFERENCES topics(key) ON DELETE CASCADE,
  PRIMARY KEY (environment, topic)
);

-- Parâmetros administráveis usados nos comandos (campo de busca unificado da
-- barra superior e botão "Inserir variável" do editor de comandos). `key` é
-- o nome do placeholder {{key}} usado nos templates. NUNCA editável depois de
-- criado. Exclusão é bloqueada em server/index.js quando: (a) é 'ip'/'port'
-- e algum comando tem requires_ip_port=1; (b) {{key}} aparece em algum
-- template.
CREATE TABLE IF NOT EXISTS parameters (
  key            TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

-- Prompts reutilizáveis (ex.: "[Expert@FW]#", "[Clish]>") usados no campo
-- "Prompt" de cada linha de comando tipo 'cmd' no editor (js/command-editor.js,
-- .ln-prompt) — pedido do usuário: "crie a variável Prompt para ser utilizada
-- nos comandos que atualmente é um texto livre". Mesmo formato de `parameters`
-- acima (key auto-gerada a partir do label — ver slugifyCatalogKey em
-- server/index.js — em vez de digitada, como em vendors/environments/topics),
-- só que sem `color`: o prompt nunca é exibido como badge/tag em lugar
-- nenhum, só popula um <select>. Sem contagem de uso no DELETE: diferente de
-- vendors/versions/etc., command_lines.prompt é só texto solto (não uma FK),
-- então excluir um prompt do catálogo nunca altera comandos já salvos — só
-- tira a opção da lista de sugestões dali em diante. Seed inicial (valores já
-- em uso pelos ~1300 comandos importados via CSV) em seedDefaultPrompts()
-- (server/db.js).
CREATE TABLE IF NOT EXISTS prompts (
  key            TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

-- Linhas de terminal do card. `variant` distingue o bloco normal do bloco
-- "placeholder" mostrado quando requires_ip_port=1 e IP/Porta ainda não
-- foram preenchidos.
CREATE TABLE IF NOT EXISTS command_lines (
  id             SERIAL PRIMARY KEY,
  command_id     INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  variant        TEXT NOT NULL DEFAULT 'default',  -- 'default' | 'empty'
  sort_order     INTEGER NOT NULL DEFAULT 0,
  line_type      TEXT NOT NULL DEFAULT 'cmd',      -- cmd | note | warn | info | ok | image
  prompt         TEXT,                              -- ex.: '[Expert@FW]#' (NULL para note/warn/info/ok/image)
  content        TEXT NOT NULL DEFAULT '',          -- para line_type='image', guarda o NOME exibido no lugar do comando
  supports_export INTEGER NOT NULL DEFAULT 0,       -- 1 = linha 'cmd' de leitura cujo output pode ser
                                                     -- redirecionado a um arquivo (ver db-render-engine.js)
  image_data     TEXT                               -- só para line_type='image': a imagem em si, como
                                                     -- data URI base64, enviada por upload/paste no editor
);

-- (command_diffs/command_diff_lines — bloco "Differences by version" —
-- removidas: pedido do usuário para tirar de vez a feature junto com todo o
-- conteúdo já cadastrado. Ver migração DROP TABLE em server/db.js.)

-- ════════════════════════════════════════════════
-- Multiusuário — servidor central compartilhado, um usuário por login do
-- Windows (identificado via NTLM na camada HTTP) ou por API key (acesso
-- programático externo — ver api_keys abaixo). `username` é sempre
-- "DOMÍNIO\usuario", só "usuario", ou "api:<nome da key>" (texto livre, sem
-- FK — não há uma tabela de usuários).
-- ════════════════════════════════════════════════

-- LEGACY — feature "Favorites" substituída por "Folders" (ver folders/
-- folder_commands abaixo). Mantida só para a migração de dados em
-- server/db.js::runMigrations() (copia cada usuário com favoritos para uma
-- pasta "Favorites"); o app não lê nem escreve mais nesta tabela.
CREATE TABLE IF NOT EXISTS user_favorites (
  username   TEXT NOT NULL,
  command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (username, command_id)
);
CREATE INDEX IF NOT EXISTS idx_user_favorites_command ON user_favorites(command_id);

-- Folders — substitui "Favorites": cada usuário organiza comandos em pastas
-- próprias (nome livre, ex.: "Favorites", "VPN troubleshooting"), e um mesmo
-- comando pode estar em várias pastas ao mesmo tempo (tabela de junção
-- folder_commands, N:N). Renomear/excluir uma pasta e adicionar/remover
-- comandos dela continua sendo só do dono; a ORGANIZAÇÃO das pastas (não o
-- conteúdo dos comandos, que já era cross-user) hoje é visível entre todos os
-- usuários (GET /api/folders/all, Group by "User folders") e pode ser
-- copiada por qualquer um para a própria lista (POST /api/folders/:id/copy —
-- task #459), mesmo espírito do "Created by".
-- UNIQUE(username, name) evita duas pastas com o mesmo nome para o mesmo
-- usuário (mensagem amigável no 409, ver POST /api/folders).
-- parent_id (subpastas, aninhamento ilimitado): auto-referência opcional —
-- NULL = pasta de topo (comportamento de sempre). Só é possível apontar para
-- outra pasta do MESMO usuário (checado em POST /api/folders, não aqui — uma
-- FK simples não consegue expressar "mesmo dono"). ON DELETE CASCADE: apagar
-- uma pasta apaga sozinho toda a árvore de subpastas abaixo dela (o Postgres
-- resolve o cascade em múltiplos níveis numa única instrução DELETE), que por
-- sua vez já cascateia para folder_commands/notes de cada uma (ver abaixo) —
-- nenhum passo manual extra é necessário em DELETE /api/folders/:id.
CREATE TABLE IF NOT EXISTS folders (
  id         SERIAL PRIMARY KEY,
  username   TEXT NOT NULL,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (username, name)
);
CREATE INDEX IF NOT EXISTS idx_folders_username ON folders(username);
-- idx_folders_parent NÃO fica aqui de propósito: numa instalação que já
-- tinha `folders` de antes desta coluna existir, o CREATE TABLE IF NOT
-- EXISTS acima é pulado inteiro (a tabela já existe) e a coluna parent_id só
-- passa a existir depois, via ALTER TABLE em runMigrations() (server/db.js)
-- — colocar o CREATE INDEX aqui faria essa linha rodar ANTES da migração
-- adicionar a coluna, e falhar com "column parent_id does not exist" (erro
-- real reportado ao aplicar esta mudança numa instalação existente). O
-- índice é criado só em runMigrations(), depois do ALTER TABLE ADD COLUMN.

-- command_id com ON DELETE CASCADE (igual user_favorites antes) — apagar um
-- comando limpa sozinho a sua presença em qualquer pasta. folder_id com ON
-- DELETE CASCADE — apagar uma pasta limpa sozinha suas linhas de membership,
-- sem precisar de um passo manual em DELETE /api/folders/:id.
-- sort_order (task #458) ordena os comandos DENTRO de uma pasta — separado
-- do sort_order global de `commands` (ordem curatorial geral) e do
-- sort_order de `folders` acima (ordem das pastas entre si). Preenchido
-- sequencialmente a cada novo membership (ver POST /api/folders/:id/commands
-- em server/index.js) e reescrito por completo pelo endpoint de reorder
-- (PUT /api/folders/:id/reorder).
CREATE TABLE IF NOT EXISTS folder_commands (
  folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (folder_id, command_id)
);
CREATE INDEX IF NOT EXISTS idx_folder_commands_command ON folder_commands(command_id);

-- Notes — anotações livres (título + descrição em HTML sanitizado, podendo
-- conter imagens coladas pelo usuário como data URI base64, redimensionadas
-- no próprio editor) que só existem DENTRO de uma pasta (task Notes) — não
-- há uma lista de notas independente de pastas, então ON DELETE CASCADE em
-- folder_id: apagar a pasta apaga as notas dela (diferente de comandos, que
-- sobrevivem à exclusão de uma pasta — eles só "saem" dela).
-- `username` é o dono/autor (sempre o mesmo dono da pasta — só é possível
-- criar uma nota dentro de uma pasta que já é sua, mesma regra de
-- rename/delete/reorder de pasta) e é quem exclusivamente pode editar,
-- clonar ou excluir a nota (ver PUT/DELETE/POST .../clone em
-- server/index.js) — outro usuário só VÊ a nota (Group by "User folders",
-- ou o novo seletor de escopo de pastas dentro de Folders), sem nenhuma
-- ação disponível.
-- `sort_order` compartilha a MESMA escala numérica de folder_commands.
-- sort_order DENTRO da mesma pasta (não uma sequência própria) — é assim
-- que notas e comandos podem ser intercalados numa única ordem por pasta
-- (ver GET /api/folders[/all] em server/index.js, que junta as duas tabelas
-- num único array `order` com {type, id}).
CREATE TABLE IF NOT EXISTS notes (
  id          SERIAL PRIMARY KEY,
  folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  username    TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', -- HTML sanitizado no servidor (ver sanitizeNoteHtml em server/index.js) — texto + <img> com width/height
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);

-- Armazenamento genérico chave/valor por usuário — tema, idioma, configurações,
-- históricos de busca (ver js/user-sync.js). `data_key` reaproveita as MESMAS
-- chaves usadas no front-end e `value` guarda o valor bruto (string ou JSON
-- serializado).
CREATE TABLE IF NOT EXISTS user_data (
  username   TEXT NOT NULL,
  data_key   TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (username, data_key)
);

-- Log de auditoria — uma linha por criação/edição/exclusão feita por um
-- usuário, em QUALQUER tipo de dado organizacional (comandos, pastas, notas,
-- catálogos, usuários, API keys — ver logAudit() em server/index.js, chamada
-- em cada rota POST/PUT/DELETE relevante). `entity_type` distingue o tipo
-- ('command' | 'folder' | 'note' | 'vendor' | 'system' | 'version' |
-- 'environment' | 'topic' | 'parameter' | 'user' | 'api_key'); `entity_name`
-- fica DENORMALIZADO (copiado no momento do registro) porque um 'delete'
-- apaga a linha original — sem isso, a entrada do log ficaria sem nome
-- depois de excluído. `details` é um resumo em texto livre de O QUE mudou
-- (ex.: "Changed: name, description" numa edição, ou "Renamed from X to Y"),
-- fica NULL quando a ação já é autoexplicativa (create/delete simples).
-- Retenção de 30 dias, aplicada inline a cada gravação — sem job/cron
-- separado. Colunas antigas (command_id/command_name, de quando este log só
-- cobria comandos) são migradas para entity_id/entity_name em runMigrations()
-- (server/db.js) — ver comentário lá.
CREATE TABLE IF NOT EXISTS audit_log (
  id           SERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  username     TEXT,
  action       TEXT NOT NULL,      -- 'create' | 'update' | 'delete'
  entity_type  TEXT NOT NULL DEFAULT 'command',
  entity_id    TEXT,
  entity_name  TEXT,
  details      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);

-- ════════════════════════════════════════════════
-- API keys — acesso programático externo ao backend (ex.: integrações,
-- scripts), gerenciável pela UI (Settings → System → API access). Cada key só
-- é exibida em texto puro NO MOMENTO da criação (POST /api/api-keys) — depois
-- disso só o hash (SHA-256) fica guardado, então perder a key mostrada
-- significa ter que revogar e criar uma nova (mesmo modelo de qualquer
-- provedor de API key). `revoked_at` é soft-delete (mantém histórico/rastro
-- em vez de apagar a linha) — uma key revogada nunca mais autentica.
--
-- `role` (admin|user) — mesmo modelo de permissões de users.role (ver
-- getCurrentRole/requireAdmin em server/index.js): uma key 'user' passa pelos
-- mesmos gates que um usuário comum (sem acesso a excluir comandos, backup &
-- restore, audit log, gerenciar chaves/usuários). DEFAULT 'admin' aqui é só
-- para preservar, sem quebrar nada, o comportamento das keys já existentes
-- antes deste campo existir (acesso total) — toda key NOVA criada pela UI
-- escolhe o role explicitamente (padrão 'user', ver #apiKeyRoleSelect em
-- index.html), seguindo o mesmo princípio de menor privilégio dos usuários
-- locais/NTLM.
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS api_keys (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,        -- primeiros caracteres da key, só para identificação visual na lista
  key_hash      TEXT NOT NULL UNIQUE, -- SHA-256 (hex) da key completa
  role          TEXT NOT NULL DEFAULT 'admin',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,          -- NULL = nunca expira ("Never" na criação); calculado a
                                      -- partir da validade escolhida (1 day/1 week/1 month/1
                                      -- year/Never) — ver POST /api/api-keys em server/index.js.
                                      -- Uma key com expires_at no passado para de autenticar
                                      -- (ver authenticateApiKey), mas a linha continua existindo
                                      -- até ser excluída manualmente.
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ           -- legado: soft-delete usado antes da ação "Delete" virar
                                      -- exclusão real (DELETE FROM). Mantido só para não quebrar
                                      -- linhas antigas já revogadas antes desta mudança — chaves
                                      -- excluídas a partir de agora são removidas da tabela.
);

-- ════════════════════════════════════════════════
-- Usuários e permissões — todo `username` que a aplicação já viu (login do
-- Windows via NTLM, ou conta local) tem uma linha aqui, com um `role`
-- ('user' | 'admin'). Contas NTLM são provisionadas automaticamente na
-- primeira vez que são vistas (is_local=0, role='user', sem password_hash —
-- nunca fazem login por senha, só são "vistas" para poder ter um role
-- atribuído). Contas locais (is_local=1) fazem login por usuário/senha (ver
-- POST /api/auth/login em server/index.js) e são criadas/gerenciadas só por
-- administradores em Settings → System → Manage users. A conta local
-- 'admin'/'admin' é semeada automaticamente pelo backend (ver server/db.js)
-- logo após este schema ser aplicado — TROQUE A SENHA em produção.
--
-- role='admin' é exigido para: excluir comandos, Backup & Restore, ver o
-- audit log, gerenciar API keys e gerenciar usuários (ver requireAdmin() em
-- server/index.js). Toda outra operação (criar/editar comando, favoritos,
-- preferências) continua liberada para qualquer usuário identificado.
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  username      TEXT PRIMARY KEY,
  password_hash TEXT,                          -- scrypt "salt:hash" (hex) — NULL para contas NTLM (is_local=0)
  role          TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  is_local      INTEGER NOT NULL DEFAULT 0,     -- 1 = conta local (login usuário/senha); 0 = identificada via Windows/NTLM ou Google
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'ntlm',   -- 'ntlm' | 'local' | 'google' — só identifica a ORIGEM da conta (ver login com Google em server/index.js); não decide permissão (isso é role)
  -- handle: apelido único e ESCOLHIDO PELO USUÁRIO (gerado automaticamente
  -- na criação da conta, trocável depois em PUT /api/me/handle — ver
  -- server/index.js) usado para compartilhar pastas/comandos com outra
  -- pessoa (ver `shares` abaixo) e para identificar o dono de algo de OUTRO
  -- usuário na interface, SEM nunca expor o username real (que é o e-mail,
  -- no caso de contas Google) — pedido do usuário: "cada usuário deverá ter
  -- um nome de usuário no sistema... e o e-mail fique restrito". Único via
  -- idx_users_handle (índice, não constraint inline — ver runMigrations()
  -- em server/db.js, que faz o backfill de instalações já existentes antes
  -- de criar o índice único).
  handle        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle);

-- ════════════════════════════════════════════════
-- Shares — concessão de visibilidade de pastas e/ou comandos de UM usuário
-- (grantor) para OUTRO (grantee), identificado pelo HANDLE que o grantor
-- digitou (resolvido para grantee_username na hora de criar a linha — ver
-- POST /api/shares em server/index.js). Pedido do usuário (compartilhamento
-- entre usuários):
--   1) por padrão a aplicação agora é PRIVADA: um usuário só vê pastas/
--      comandos de outro se existir uma linha aqui autorizando (ver o filtro
--      de visibilidade em GET /api/commands e GET /api/folders/all).
--   2) "tudo ou nada, por tipo" — dois toggles independentes (share_folders/
--      share_commands), sem seleção de pasta/comando específico.
--   3) vale IMEDIATAMENTE, sem fluxo de aceite da outra pessoa.
--   4) admins continuam vendo tudo de todo mundo sempre — este mecanismo só
--      é consultado para usuários comuns (ver isAdmin no código acima).
-- UNIQUE(grantor,grantee): no máximo uma linha por par — compartilhar de
-- novo com o mesmo handle faz UPSERT (ON CONFLICT ... DO UPDATE) em vez de
-- duplicar. CHECK impede um usuário "compartilhar consigo mesmo".
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shares (
  id               SERIAL PRIMARY KEY,
  grantor_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  grantee_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  share_folders    BOOLEAN NOT NULL DEFAULT false,
  share_commands   BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (grantor_username, grantee_username),
  CHECK (grantor_username <> grantee_username)
);
CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares(grantee_username);

-- Sessões de login local — o cookie `tb45_session` guarda só o token (chave
-- primária desta tabela); nenhum dado sensível viaja no cookie em si. Uma
-- sessão local tem prioridade sobre a identificação NTLM enquanto for válida
-- (permite "logout" do usuário do Windows e login com outra credencial sem
-- precisar fechar o navegador) — ver o middleware de sessão em
-- server/index.js, logo depois do middleware de API key.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_commands_topic ON commands(topic);
CREATE INDEX IF NOT EXISTS idx_command_lines_command ON command_lines(command_id);
