// db.js — abre um pool de conexões PostgreSQL (toolbox45-db, container
// próprio — ver docker-compose.yml) e aplica schema.sql (idempotente —
// CREATE TABLE IF NOT EXISTS, então reexecutar é seguro).
//
// Antes (SQLite/better-sqlite3) isto era síncrono e abria um arquivo local;
// agora é assíncrono e conecta por rede/socket a um servidor Postgres
// separado. `initDb()` precisa ser aguardado (await) antes do servidor HTTP
// começar a aceitar requisições — ver server/index.js.
//
// Parâmetros de conexão: o driver `pg` já lê PGHOST/PGPORT/PGDATABASE/
// PGUSER/PGPASSWORD do ambiente automaticamente (mesma convenção do
// libpq/psql), então normalmente não é preciso passar nada explícito aqui —
// só DATABASE_URL como alternativa de conveniência (ex.: um único env var).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { hashPassword } = require('./auth');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const CONN = {
  host: process.env.PGHOST || process.env.DB_HOST || 'toolbox45-db',
  port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
  database: process.env.PGDATABASE || process.env.DB_NAME || 'toolbox45',
  user: process.env.PGUSER || process.env.DB_USER || 'toolbox45',
  password: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'toolbox45',
};

const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : CONN);

// Monta uma connection string a partir dos MESMOS parâmetros usados pelo pool
// acima — usada por server/index.js para invocar `pg_dump`/`pg_restore` (CLI
// externa, ver seção de Backup/Restore) com a garantia de apontar para
// exatamente o mesmo banco, mesmo se DATABASE_URL (e não as variáveis PG*
// individuais) tiver sido a forma usada para configurar a conexão.
function getConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { host, port, database, user, password } = CONN;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

pool.on('error', err => {
  // Erros em conexões OCIOSAS do pool (ex.: o servidor Postgres derrubou a
  // conexão) não devem derrubar o processo Node inteiro — só logar. Erros de
  // uma query em andamento continuam sendo relançados normalmente para quem
  // chamou pool.query()/client.query().
  console.error('[db] Erro inesperado numa conexão ociosa do pool:', err.message);
});

// Tenta conectar/aplicar o schema a cada 2s até o Postgres responder — no
// docker-compose, o container toolbox45-db pode ainda estar inicializando
// quando toolbox45-backend sobe (mesmo com `depends_on` + healthcheck, é uma
// rede real, não um arquivo local — vale ter uma margem de segurança aqui).
async function initDb({ retries = 30, delayMs = 2000 } = {}) {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(schemaSql);
      console.log('[db] Conectado ao PostgreSQL e schema aplicado.');
      await runMigrations();
      await seedDefaultAdmin();
      await seedDefaultFolders();
      // Ordem importa: vendors -> systems (FK vendor) -> versions/environments
      // (FK system) -> parameters/prompts (independentes). Cada função só
      // semeia se a PRÓPRIA tabela estiver totalmente vazia (mesmo padrão já
      // usado por seedDefaultPrompts abaixo) — não mexe em nada numa
      // instalação que já tem QUALQUER vendor/system/version/environment/
      // parameter/prompt cadastrado, seja pelo Register, seja por um import.
      await seedDefaultVendors();
      await seedDefaultSystems();
      await seedDefaultVersions();
      await seedDefaultEnvironments();
      await seedDefaultParameters();
      await seedDefaultPrompts();
      await seedDefaultExports();
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`[db] Falha ao conectar/aplicar schema (tentativa ${attempt}/${retries}): ${err.message} — tentando de novo em ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// Converte commands.id de TEXT (slug estável, ex.: 'cplic-print') para
// INTEGER sequencial (SERIAL) — pedido do usuário: "implementar ID
// sequencial de verdade". Só existe DADO A MIGRAR numa instalação que já
// tinha comandos cadastrados com o esquema antigo; uma instalação nova já
// nasce com `id SERIAL` direto do CREATE TABLE em schema.sql, então o guard
// abaixo (consulta a information_schema) faz esta função não fazer nada
// nesse caso — só entra no corpo da função quando encontra o tipo antigo.
//
// 8 tabelas dependem de commands.id via FK (command_vendors/systems/
// versions/environments/topics/lines, folder_commands, user_favorites —
// esta última legada, ver comentário em schema.sql, mas ainda com FK
// formal). A troca de tipo de uma coluna referenciada por FK em várias
// tabelas não é uma operação single-statement no Postgres — o caminho
// seguro é: (1) criar uma coluna nova SERIAL em `commands`; (2) para cada
// dependente, criar uma coluna INTEGER nova e preenchê-la via JOIN pelo id
// de texto antigo; (3) remover a FK/PK antiga e a coluna de texto antiga de
// cada dependente, e renomear a nova pro lugar; (4) só então trocar a PK de
// `commands` para a coluna sequencial; (5) recriar FK/PK dos dependentes,
// agora apontando pra commands(id) já inteiro; (6) recriar os índices que
// dependiam da coluna antiga (dropados junto com ela). Tudo dentro de uma
// única transação (withTransaction) — se qualquer passo falhar, o Postgres
// desfaz tudo e o banco volta exatamente ao estado anterior (id ainda TEXT),
// então o guard vai tentar de novo no próximo boot em vez de deixar o banco
// pela metade.
async function migrateCommandsIdToSerial() {
  try {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'commands' AND column_name = 'id'`
    );
    if (!rows.length || rows[0].data_type !== 'text') return; // já migrado, ou instalação nova (schema.sql já cria como integer)

    console.log('[db] commands.id ainda é TEXT (slug) — migrando para INTEGER sequencial (isso preserva todos os comandos e vínculos já cadastrados)...');

    // Nome da tabela É controlado por nós mesmos aqui (lista fixa abaixo,
    // nunca vem de input externo), então interpolar no SQL é seguro — não há
    // como parametrizar um identificador de tabela/coluna via $1 no driver `pg`.
    const DEPENDENTS = [
      'command_vendors', 'command_systems', 'command_versions',
      'command_environments', 'command_topics', 'command_lines',
      'folder_commands', 'user_favorites',
    ];
    // Só estas têm uma PK COMPOSTA que inclui command_id (precisa ser
    // recriada) — command_lines tem PK própria em `id` (SERIAL), que não é
    // tocada em nenhum passo desta migração.
    const COMPOSITE_PK_COLS = {
      command_vendors: ['command_id', 'vendor'],
      command_systems: ['command_id', 'system'],
      command_versions: ['command_id', 'version'],
      command_environments: ['command_id', 'environment'],
      command_topics: ['command_id', 'topic'],
      folder_commands: ['folder_id', 'command_id'],
      user_favorites: ['username', 'command_id'],
    };

    await withTransaction(async client => {
      // 1) Coluna sequencial nova em commands (convive com a antiga por
      //    enquanto — só vira a PK de fato no passo 4).
      await client.query(`ALTER TABLE commands ADD COLUMN IF NOT EXISTS id_seq SERIAL`);

      // 2) Cada dependente ganha uma coluna INTEGER nova, preenchida a
      //    partir do mapeamento commands.id (texto antigo) -> commands.id_seq.
      for (const table of DEPENDENTS) {
        await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS command_id_seq INTEGER`);
        await client.query(`UPDATE ${table} t SET command_id_seq = c.id_seq FROM commands c WHERE t.command_id = c.id`);
      }

      // 3) Em cada dependente: derruba a FK antiga (nome default do
      //    Postgres: <tabela>_command_id_fkey) e, só nas tabelas com PK
      //    composta, a PK antiga também (ela inclui a coluna de texto que
      //    está prestes a ser removida) — depois remove a coluna de texto e
      //    põe a nova no lugar dela.
      for (const table of DEPENDENTS) {
        await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_command_id_fkey`);
        if (COMPOSITE_PK_COLS[table]) {
          await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`);
        }
        await client.query(`ALTER TABLE ${table} DROP COLUMN command_id`);
        await client.query(`ALTER TABLE ${table} RENAME COLUMN command_id_seq TO command_id`);
        await client.query(`ALTER TABLE ${table} ALTER COLUMN command_id SET NOT NULL`);
      }

      // 4) Só agora troca a PK de `commands` — todas as FKs que apontavam
      //    pra ela já foram removidas no passo 3, então isto não esbarra em
      //    nenhuma dependência pendente.
      await client.query(`ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_pkey`);
      await client.query(`ALTER TABLE commands DROP COLUMN id`);
      await client.query(`ALTER TABLE commands RENAME COLUMN id_seq TO id`);
      await client.query(`ALTER TABLE commands ADD PRIMARY KEY (id)`);

      // 5) Recria PK composta (onde havia) + FK de cada dependente, agora
      //    apontando pra commands(id) já inteiro.
      for (const table of DEPENDENTS) {
        await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_command_id_fkey FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE CASCADE`);
        if (COMPOSITE_PK_COLS[table]) {
          await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (${COMPOSITE_PK_COLS[table].join(', ')})`);
        }
      }

      // 6) Índices que existiam sobre a coluna antiga (dropados junto com
      //    ela no passo 3/4) — recria todos.
      await client.query(`CREATE INDEX IF NOT EXISTS idx_command_topics_topic ON command_topics(topic)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_user_favorites_command ON user_favorites(command_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_folder_commands_command ON folder_commands(command_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_command_lines_command ON command_lines(command_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_commands_topic ON commands(topic)`);
    });

    // Cosmético — fora da transação de propósito: o nome da sequência criada
    // pelo `SERIAL` no passo 1 fica `commands_id_seq_seq` (porque a coluna se
    // chamava "id_seq" no momento da criação), diferente do nome que uma
    // instalação NOVA teria (`commands_id_seq`, convenção padrão do Postgres
    // pra SERIAL numa coluna chamada "id"). Renomear deixa as duas
    // instalações idênticas por baixo dos panos; uma falha aqui é só
    // estética (a sequência funciona de qualquer forma com o nome antigo) —
    // não deve desfazer a migração de dados, que já foi commitada acima.
    try {
      await pool.query(`ALTER SEQUENCE IF EXISTS commands_id_seq_seq RENAME TO commands_id_seq`);
    } catch (e) { /* cosmético — ver comentário acima */ }

    console.log('[db] commands.id migrado para INTEGER sequencial — todos os comandos e vínculos (pastas, linhas, catálogos) foram preservados.');
  } catch (err) {
    console.error('[db] Falha ao migrar commands.id para INTEGER sequencial — nada foi alterado (a migração roda inteira dentro de uma transação):', err.message);
  }
}

// Pequenos ajustes idempotentes em bancos que já existiam ANTES de uma coluna
// nova ser adicionada ao schema — `CREATE TABLE IF NOT EXISTS` (acima) não
// altera uma tabela que já existe de um deploy anterior, então uma coluna
// adicionada depois da criação inicial de uma tabela precisa de um
// `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` explícito aqui. Seguro rodar em
// todo boot, inclusive numa instalação nova onde a coluna já veio do CREATE
// TABLE (o IF NOT EXISTS simplesmente não faz nada nesse caso).
// Handles — apelido único usado para compartilhamento entre usuários (ver
// users.handle e a tabela `shares` em schema.sql, e PUT /api/me/handle
// /POST /api/shares em server/index.js). `slugifyHandle()` deriva um
// candidato "limpo" a partir de um texto qualquer (normalmente a parte
// local do username/e-mail: "rodrigo.silva@empresa.com" -> "rodrigo.silva")
// — minúsculas, só [a-z0-9._-], sem repetir separador, sem começar/terminar
// em separador. `generateUniqueHandle()` tenta esse candidato e, se já
// estiver em uso, vai acrescentando um sufixo numérico (-2, -3, ...) até
// achar um livre — usada tanto no backfill de instalações já existentes
// (runMigrations() abaixo) quanto toda vez que uma conta nova é criada
// (POST /api/users, login com Google — ver server/index.js).
function slugifyHandle(raw) {
  let s = String(raw || '').trim().toLowerCase();
  const at = s.indexOf('@');
  if (at > 0) s = s.slice(0, at); // e-mail -> só a parte local
  s = s.replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').replace(/[._-]{2,}/g, '-');
  if (s.length < 2) s = `user-${s}`.replace(/-+$/, '') || 'user';
  return s.slice(0, 28);
}
async function generateUniqueHandle(dbPool, rawBase) {
  const base = slugifyHandle(rawBase);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const { rows } = await dbPool.query('SELECT 1 FROM users WHERE handle = $1', [candidate]);
    if (!rows.length) return candidate;
  }
  // Praticamente inatingível (1000 colisões seguidas) — sufixo aleatório
  // como último recurso, só para nunca travar a criação de uma conta.
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

async function runMigrations() {
  // Roda ANTES de qualquer outra migração/seed — várias delas tocam em
  // command_lines/folder_commands/etc., então é mais simples garantir que
  // commands.id já está no formato final (INTEGER) antes de mexer em mais
  // nada. Ver migrateCommandsIdToSerial() acima.
  await migrateCommandsIdToSerial();
  try {
    // users.auth_provider ('ntlm'|'local'|'google') — ver comentário em
    // schema.sql e o login com Google em server/index.js. DEFAULT 'ntlm'
    // preserva o comportamento das contas NTLM já existentes (nunca tinham
    // essa coluna); o UPDATE abaixo faz o backfill das contas LOCAIS
    // (is_local=1) que também já existiam antes desta coluna existir — sem
    // isso ficariam incorretamente marcadas 'ntlm'. Contas Google nunca
    // existiam antes desta coluna, então não precisam de backfill.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'ntlm'`);
    await pool.query(`UPDATE users SET auth_provider = 'local' WHERE is_local = 1 AND auth_provider = 'ntlm'`);
    // api_keys.role (admin|user) — ver comentário em schema.sql. DEFAULT
    // 'admin' preserva o acesso total das keys criadas antes deste campo
    // existir.
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'`);
    // api_keys.expires_at — ver comentário em schema.sql. Sem DEFAULT (NULL =
    // nunca expira), preservando o comportamento das keys criadas antes deste
    // campo existir.
    await pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    // folder_commands.sort_order (task #458) — ordena os comandos DENTRO de
    // uma pasta (ver comentário em schema.sql). DEFAULT 0 sozinho deixaria
    // todo membership já existente empatado numa única posição — o UPDATE
    // abaixo faz o backfill inicial usando a MESMA ordem que já era exibida
    // antes desta feature existir (created_at, ou seja, a ordem em que cada
    // comando foi adicionado à pasta), então nenhuma pasta muda de aparência
    // ao aplicar esta migração; só passa a ser reordenável a partir daqui.
    // row_number() é 1-based; window function particionada por pasta.
    await pool.query(`ALTER TABLE folder_commands ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
    // folders.parent_id (subpastas) — ver comentário em schema.sql. NULL por
    // padrão (toda pasta já existente vira pasta de topo, comportamento
    // idêntico ao de antes desta coluna existir).
    await pool.query(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)`);
    // audit_log: generalizado de "só comandos" (command_id/command_name)
    // para qualquer entidade organizacional (pastas, notas, catálogos,
    // usuários, API keys — ver comentário em schema.sql e logAudit() em
    // server/index.js). RENAME COLUMN não aceita "IF EXISTS" na coluna (só
    // na tabela) — por isso o DO $$ ... $$ abaixo confere via
    // information_schema antes de renomear, tornando isso seguro de rodar
    // em todo boot: na 2ª vez em diante, entity_id/entity_name já existem e
    // o bloco não faz nada. Instalações novas já nascem com os nomes certos
    // (ver CREATE TABLE em schema.sql), então aqui só entram bancos de
    // antes desta mudança.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'command_id')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'entity_id') THEN
          ALTER TABLE audit_log RENAME COLUMN command_id TO entity_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'command_name')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'entity_name') THEN
          ALTER TABLE audit_log RENAME COLUMN command_name TO entity_name;
        END IF;
      END $$;
    `);
    await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'command'`);
    await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS details TEXT`);
    // Remoção da feature Tags/badges (pedido do usuário: "no arquivo de
    // template existe a coluna Tags que não deveria existir na aplicação" —
    // decisão confirmada de remover Tags de toda a aplicação, não só do CSV).
    // command_tags saiu de CREATE TABLE IF NOT EXISTS em schema.sql (instalações
    // novas nunca a criam); aqui é só o DROP para quem já tinha a tabela de um
    // deploy anterior — apaga os dados de tags já cadastrados, mas nada mais no
    // app volta a lê-los depois desta mudança (badge some do card, campo some
    // do editor, coluna some do CSV/template).
    await pool.query(`DROP TABLE IF EXISTS command_tags`);
    // command_lines.export_template -- substitui o antigo checkbox unico
    // "Exportable" (supports_export INTEGER 0/1) por um catalogo de
    // templates (Exports, ver schema.sql) escolhido por linha (pedido do
    // usuario: "substitua o botao estilo flag de Exportable por uma lista
    // suspensa"). ADD COLUMN nullable + backfill roda so numa instalacao que
    // ja tinha `supports_export` (instalacoes novas ja nascem sem essa
    // coluna, direto com `export_template` -- ver CREATE TABLE em
    // schema.sql). O texto do backfill ('> {{logFile}}') e EXATAMENTE o
    // redirecionamento fixo que supports_export=1 produzia antes (ver
    // db-render-engine.js), entao nenhum comando existente muda de saida --
    // e casa com o item padrao semeado em seedDefaultExports() (server/db.js),
    // entao o dropdown do editor ja abre com a opcao certa pre-selecionada.
    await pool.query(`ALTER TABLE command_lines ADD COLUMN IF NOT EXISTS export_template TEXT`);
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'command_lines' AND column_name = 'supports_export') THEN
          UPDATE command_lines SET export_template = '> {{logFile}}' WHERE supports_export = 1 AND (export_template IS NULL OR export_template = '');
          ALTER TABLE command_lines DROP COLUMN supports_export;
        END IF;
      END $$;
    `);
    // users.role: 3 niveis (user|admin|super_admin) + users.approved_at
    // (pedido do usuario: "tres perfis de acesso: User, Admin e Super
    // Admin" + registro pendente de aprovacao) -- ver comentario grande
    // acima de CREATE TABLE users em schema.sql para a semantica completa.
    // ADD COLUMN nullable (sem backfill de valor "aprovado" automatico
    // aqui -- isso e feito explicitamente abaixo): instalacoes novas ja
    // nascem com a coluna via CREATE TABLE em schema.sql.
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
    // Toda conta que ja existia ANTES deste recurso (criada por um admin,
    // ou auto-provisionada no 1o login Google -- os 2 unicos jeitos de uma
    // conta existir antes de POST /api/auth/register/self-registro Google
    // pendente passarem a existir) ja era, na pratica, uma conta aprovada
    // -- nunca passou por um fluxo de "pendente". So marca approved_at pra
    // quem ainda esta NULL (nunca sobrescreve uma aprovacao/rejeicao real
    // que o fluxo novo ja tenha gravado depois do deploy).
    await pool.query(`UPDATE users SET approved_at = COALESCE(approved_at, created_at, NOW()) WHERE approved_at IS NULL`);
    // A conta local 'admin' semeada por seedDefaultAdmin() abaixo e SEMPRE
    // Super Admin, e isto e reforcado aqui a cada boot (idempotente) alem
    // do INSERT em si -- cobre instalacoes que ja tinham essa conta ANTES
    // deste recurso existir (quando role='admin' era o nivel maximo).
    // Defesa em profundidade: o guard de verdade que impede qualquer um
    // (inclusive outro super_admin) de mudar isto fica em
    // PUT/DELETE /api/users/:username (server/index.js).
    await pool.query(`UPDATE users SET role = 'super_admin' WHERE username = 'admin' AND role != 'super_admin'`);
    await pool.query(`
      UPDATE folder_commands fc SET sort_order = ranked.rn
      FROM (
        SELECT folder_id, command_id,
               row_number() OVER (PARTITION BY folder_id ORDER BY created_at, command_id) - 1 AS rn
        FROM folder_commands
      ) ranked
      WHERE fc.folder_id = ranked.folder_id AND fc.command_id = ranked.command_id AND fc.sort_order = 0
    `);
  } catch (err) {
    console.error('[db] Falha ao rodar migrações:', err.message);
  }

  // users.handle + tabela `shares` (compartilhamento entre usuários — ver
  // comentário em schema.sql). ADD COLUMN nullable de propósito: instalações
  // já existentes ganham a coluna sem handle nenhum ainda; o backfill abaixo
  // gera um handle único para cada usuário que ainda não tem um (derivado do
  // username/e-mail — ver generateUniqueHandle() acima) ANTES do índice
  // único ser criado, senão CREATE UNIQUE INDEX falharia com vários NULLs...
  // na prática não falharia (NULL não colide com NULL num índice único
  // padrão do Postgres), mas deixaríamos contas sem handle utilizável para
  // compartilhamento — o backfill evita isso. Instalações novas já criam a
  // tabela/coluna direto de schema.sql; rodar de novo aqui não faz nada
  // (ADD COLUMN/CREATE ... IF NOT EXISTS são idempotentes).
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT`);
    const { rows: noHandle } = await pool.query('SELECT username FROM users WHERE handle IS NULL');
    for (const { username } of noHandle) {
      const handle = await generateUniqueHandle(pool, username);
      await pool.query('UPDATE users SET handle = $1 WHERE username = $2', [handle, username]);
    }
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle)`);
    await pool.query(`
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
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares(grantee_username)`);
  } catch (err) {
    console.error('[db] Falha ao migrar users.handle / criar tabela shares:', err.message);
  }

  // environments.system/vendor (pedido do usuário: "Environment deve ter um
  // sistema relacionado") — ver comentário em schema.sql. Nullable no ADD
  // COLUMN de propósito (uma instalação já existente pode ter linhas em
  // `environments` de antes desta FK existir); o backfill abaixo tenta
  // resolver o Sistema de cada uma a partir do que já está cadastrado, e só
  // então a coluna vira NOT NULL — se sobrar alguma linha sem Sistema
  // resolvido (ex.: múltiplos Sistemas cadastrados e nenhum vínculo em
  // version_environments para desambiguar), a constraint fica pendente até um
  // administrador corrigir manualmente via PUT /api/environments/:key (Register
  // → Environments), e o log abaixo avisa quais chaves precisam de atenção.
  try {
    await pool.query(`ALTER TABLE environments ADD COLUMN IF NOT EXISTS system TEXT REFERENCES systems(key) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE environments ADD COLUMN IF NOT EXISTS vendor TEXT REFERENCES vendors(key) ON DELETE CASCADE`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environments_system ON environments(system)`);

    // 1) Quando o Ambiente já tem exatamente 1 Sistema "descobrível" através
    //    dos vínculos version_environments -> versions.system, usa esse.
    await pool.query(`
      UPDATE environments e SET system = resolved.system, vendor = s.vendor
      FROM (
        SELECT ve.environment, v.system
        FROM version_environments ve
        JOIN versions v ON v.key = ve.version
        GROUP BY ve.environment, v.system
        HAVING COUNT(DISTINCT v.system) = 1
      ) resolved
      JOIN systems s ON s.key = resolved.system
      WHERE e.key = resolved.environment AND e.system IS NULL
    `);
    // Nota: a subquery acima já garante 1 system por ambiente (HAVING COUNT
    // DISTINCT = 1) considerando TODOS os vínculos daquele ambiente — se um
    // ambiente estiver ligado a versões de mais de um Sistema diferente,
    // nenhuma linha é gerada para ele aqui (cai no fallback abaixo).

    // 2) Ainda sem Sistema (sem vínculo nenhum, ou vínculo ambíguo) e existe
    //    exatamente 1 Sistema cadastrado no total: assume que é esse (caso
    //    comum de uma instalação single-vendor/single-system, ex.: só
    //    "Check Point" / "Gaia").
    const { rows: sysCountRows } = await pool.query('SELECT COUNT(*) AS n FROM systems');
    if (Number(sysCountRows[0].n) === 1) {
      await pool.query(`
        UPDATE environments e SET system = s.key, vendor = s.vendor
        FROM systems s
        WHERE e.system IS NULL
      `);
    } else if (Number(sysCountRows[0].n) > 1) {
      // 3) Mais de um Sistema cadastrado e ainda restam ambientes sem Sistema
      //    resolvido: cai no primeiro Sistema por sort_order só para não
      //    deixar a coluna NOT NULL impossível de aplicar — é uma suposição
      //    (fica registrada no console para o administrador revisar e
      //    corrigir depois pela tela de Register → Environments).
      const { rows: unresolved } = await pool.query('SELECT key FROM environments WHERE system IS NULL');
      if (unresolved.length) {
        const { rows: firstSys } = await pool.query('SELECT key, vendor FROM systems ORDER BY sort_order, key LIMIT 1');
        if (firstSys[0]) {
          await pool.query('UPDATE environments SET system = $1, vendor = $2 WHERE system IS NULL', [firstSys[0].key, firstSys[0].vendor]);
          console.warn(`[db] Ambiente(s) sem Sistema determinável de forma inequívoca (${unresolved.map(r => r.key).join(', ')}) foram atribuídos a '${firstSys[0].key}' como suposição — revise em Register → Environments.`);
        }
      }
    }

    // Só promove a NOT NULL se toda linha já tem um Sistema (nenhum ambiente
    // cadastrado ainda, ou nenhum Sistema cadastrado ainda, também contam como
    // "nada pendente" — o próximo Ambiente criado já vem com system exigido
    // pela API). Reaplicar SET NOT NULL numa coluna que já é NOT NULL não dá
    // erro no Postgres, então isto é seguro rodar em todo boot.
    const { rows: pending } = await pool.query('SELECT COUNT(*) AS n FROM environments WHERE system IS NULL');
    if (Number(pending[0].n) === 0) {
      await pool.query(`ALTER TABLE environments ALTER COLUMN system SET NOT NULL`);
      await pool.query(`ALTER TABLE environments ALTER COLUMN vendor SET NOT NULL`);
    } else {
      console.warn(`[db] ${pending[0].n} ambiente(s) ainda sem Sistema após a migração automática — corrija manualmente em Register → Environments antes de contar com a obrigatoriedade desse campo.`);
    }
  } catch (err) {
    console.error('[db] Falha ao migrar environments.system/vendor:', err.message);
  }

  // Garante que os 8 parâmetros "fixos" da linha única do campo de busca
  // (ver ccBuildQueryChipsFixedRow em js/catalogs.js) sempre EXISTAM no
  // catálogo — relatado pelo usuário: alguns não apareciam na linha fixa.
  // Causa: seedDefaultParameters() só semeia numa tabela vazia (instalação
  // nova); numa instalação que já tinha `parameters` parcialmente
  // preenchida de antes desta convenção (ex.: faltando dst_port/host/
  // license), o seed nunca roda de novo e essas chaves nunca são criadas.
  // ON CONFLICT (key) DO NOTHING: só cria o que estiver faltando, nunca
  // sobrescreve um parâmetro (fixo ou não) já cadastrado.
  try {
    const FIXED_PARAM_DEFAULTS = [
      { key: 'src_ip', label: 'Source' },
      { key: 'dst_ip', label: 'Destination' },
      { key: 'src_port', label: 'Source Port' },
      { key: 'dst_port', label: 'Destination Port' },
      { key: 'user', label: 'User' },
      { key: 'host', label: 'Host' },
      { key: 'license', label: 'License' },
      { key: 'signature', label: 'Signature' },
    ];
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM parameters');
    let nextSort = Number(maxRows[0].m) + 1;
    for (const { key, label } of FIXED_PARAM_DEFAULTS) {
      const { rowCount } = await pool.query(
        'INSERT INTO parameters (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
        [key, label, nextSort]
      );
      if (rowCount) nextSort++;
    }
  } catch (err) {
    console.error('[db] Falha ao garantir parâmetros fixos padrão:', err.message);
  }

  // Migração de dados (não de schema, mas mesmo lugar/mesma filosofia de
  // idempotência): feature "Favorites" (tabela legada user_favorites) virou
  // "Folders" — cada usuário que tinha favoritos ganha uma pasta chamada
  // "Favorites" com os mesmos comandos. to_regclass() confirma que a tabela
  // legada ainda existe antes de tentar ler dela (numa instalação nova ela
  // vem vazia do CREATE TABLE IF NOT EXISTS, então o loop simplesmente não
  // encontra nenhum username e não faz nada). O upsert com
  // "DO UPDATE ... RETURNING id" garante idempotência mesmo re-rodando em
  // todo boot: se a pasta "Favorites" já existir para o usuário, ainda
  // conseguimos o id dela (um DO NOTHING puro não devolve linha nenhuma) para
  // o INSERT de folder_commands, que por sua vez tem sua própria PK composta
  // como proteção contra duplicar membership numa segunda execução.
  try {
    const { rows: legacyCheck } = await pool.query(`SELECT to_regclass('public.user_favorites') AS t`);
    if (legacyCheck[0] && legacyCheck[0].t) {
      const { rows: users } = await pool.query('SELECT DISTINCT username FROM user_favorites');
      for (const { username } of users) {
        const { rows: folderRows } = await pool.query(
          `INSERT INTO folders (username, name) VALUES ($1, 'Favorites')
           ON CONFLICT (username, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [username]
        );
        const folderId = folderRows[0].id;
        await pool.query(
          `INSERT INTO folder_commands (folder_id, command_id)
           SELECT $1, command_id FROM user_favorites WHERE username = $2
           ON CONFLICT DO NOTHING`,
          [folderId, username]
        );
      }
    }
  } catch (err) {
    console.error('[db] Falha ao migrar favoritos legados para folders:', err.message);
  }

  // Migração de dados: categoria de texto 'note' (roxa) foi removida do
  // editor (js/command-editor.js, CMD_EDITOR_TEXT_CATEGORIES) por conflitar
  // com o conceito de "Notes" (post-its dentro das pastas) — pedido do
  // usuário: "existem notas no campo text em alguns comandos. todas notas
  // que existirem nesse campo mova para nota do comando e apague essa
  // coluna do banco de dados". "Nota do comando" = campo about_obs (rótulo
  // "Note" na aba Advanced do editor, junto de Purpose/When to use). Cada
  // linha line_type='note' de um comando vira um parágrafo anexado ao
  // about_obs JÁ EXISTENTE daquele comando (preserva o que já estava
  // escrito lá, separado por uma linha em branco — nunca sobrescreve).
  // Depois de migrado o conteúdo, as linhas 'note' são apagadas (não dá
  // pra remover a COLUNA line_type em si — ela é compartilhada com cmd/
  // info/ok/warn/image — então "apagar essa coluna" aqui significa apagar
  // as LINHAS dessa categoria). Idempotente: depois da 1ª execução não
  // sobra nenhuma linha line_type='note', então o UPDATE (que depende de
  // encontrar essas linhas) e o DELETE seguinte não afetam mais nada nas
  // próximas vezes que o backend subir.
  //
  // (A parte equivalente para command_diffs/command_diff_lines que existia
  // aqui foi removida junto com a própria feature "Differences by version"
  // — ver DROP TABLE logo abaixo — não fazia mais sentido migrar notas de
  // diff para uma tabela que está sendo apagada.)
  // Guarda: `about_obs` só existe em bancos ainda não migrados para `details`
  // (ver migração about_purpose/about_when/about_obs -> details logo abaixo,
  // que roda DEPOIS desta e depende do conteúdo já estar consolidado aqui).
  // Numa instalação nova (schema.sql sem about_obs) ou num banco que já
  // passou por aquela migração, esta coluna não existe mais — sem esta
  // checagem a query sempre falharia com "column does not exist" (capturado
  // pelo catch, mas gerando um erro de log em todo boot, para sempre).
  try {
    const { rows: obsCol } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'commands' AND column_name = 'about_obs'`
    );
    if (obsCol.length) {
      const { rowCount: movedCmdNotes } = await pool.query(`
        UPDATE commands c SET about_obs = trim(both chr(10) from
          c.about_obs || CASE WHEN c.about_obs <> '' THEN chr(10) || chr(10) ELSE '' END || agg.combined
        )
        FROM (
          SELECT command_id, string_agg(content, chr(10) ORDER BY sort_order, id) AS combined
          FROM command_lines
          WHERE line_type = 'note' AND trim(content) <> ''
          GROUP BY command_id
        ) agg
        WHERE c.id = agg.command_id
      `);
      const { rowCount: deletedCmdNotes } = await pool.query(`DELETE FROM command_lines WHERE line_type = 'note'`);

      if (deletedCmdNotes) {
        console.log(`[db] Categoria de texto 'note' migrada e removida: ${movedCmdNotes} comando(s) tiveram o texto movido para o campo Note; ${deletedCmdNotes} linha(s) de command_lines apagadas.`);
      }
    }
  } catch (err) {
    console.error(`[db] Falha ao migrar linhas 'note' para about_obs:`, err.message);
  }

  // Remoção completa de 3 recursos, a pedido do usuário — "remover as opções
  // e campos Differences by version (advanced) e This command changes
  // content when SRC/DST are empty" + "remover Raw template (copy button)
  // também":
  //   1) raw_template — já não tinha nenhum efeito visível: o valor calculado
  //      era passado para card() (js/terminal-renderer.js), mas essa função
  //      nunca lê esse parâmetro — dado morto de ponta a ponta.
  //   2) command_diffs/command_diff_lines — bloco "Differences by version",
  //      removido junto com todo o conteúdo já cadastrado (schema.sql não
  //      cria mais essas tabelas numa instalação nova; aqui é o DROP para
  //      quem já tinha uma instalação existente).
  //   3) commands.requires_ips — toggle "This command changes content when
  //      SRC/DST are empty", removido junto com o conteúdo (name_empty/
  //      desc_empty/linhas variant='empty' continuam existindo no schema
  //      porque são COMPARTILHADOS com requires_ip_port, que não foi pedido
  //      para remover — só a flag requires_ips em si e o que dependia dela
  //      são apagados).
  // DROP COLUMN/TABLE IF EXISTS: seguro rodar em toda instalação, inclusive
  // uma nova (onde essas colunas/tabelas nunca existiram, então o IF EXISTS
  // simplesmente não faz nada).
  try {
    await pool.query(`ALTER TABLE commands DROP COLUMN IF EXISTS raw_template`);
    await pool.query(`ALTER TABLE commands DROP COLUMN IF EXISTS requires_ips`);
    await pool.query(`DROP TABLE IF EXISTS command_diff_lines`);
    await pool.query(`DROP TABLE IF EXISTS command_diffs`);
  } catch (err) {
    console.error('[db] Falha ao remover raw_template/requires_ips/command_diffs:', err.message);
  }

  // Simplificação dos campos de informação do comando — pedido do usuário:
  // "criar um campo Details e migrar o conteúdo dos campos Purpose/When to
  // use/Note para esse campo... remover os campos Purpose/When to use/Note".
  // 1) Garante a coluna nova (idempotente, ADD COLUMN IF NOT EXISTS).
  // 2) Backfill: só roda se as colunas ANTIGAS ainda existirem (guard via
  //    information_schema) — depois do 1º boot bem-sucedido elas já foram
  //    apagadas (passo 3 abaixo), então em todo boot seguinte esse SELECT
  //    nem tentaria rodar (evita um erro "column does not exist" tentado a
  //    cada subida do backend numa instalação já migrada). Só migra
  //    comandos cujo `details` ainda esteja vazio (idempotente mesmo que o
  //    guard acima não existisse) e que tenham pelo menos um dos 3 campos
  //    antigos preenchido — nunca sobrescreve um `details` já escrito por um
  //    usuário. O texto antigo era sempre PLAIN TEXT (nunca HTML) — por isso
  //    é escapado (&/</>) antes de virar HTML, e quebras de linha viram
  //    parágrafos/<br>, uma seção por campo (só as não-vazias), com um
  //    cabeçalho em negrito igual ao rótulo antigo do campo — assim o
  //    conteúdo já cadastrado não se perde nem fica ilegível dentro do novo
  //    editor rico.
  // 3) Remove as 4 colunas antigas (about_icon incluído — nunca teve campo
  //    próprio no editor, era só um valor morto default 'ℹ️', ver comentário
  //    em js/terminal-renderer.js: card() nunca lê about.icon).
  try {
    const { rows: oldCols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'commands' AND column_name IN ('about_purpose', 'about_when', 'about_obs')`
    );
    if (oldCols.length === 3) {
      await pool.query(`ALTER TABLE commands ADD COLUMN IF NOT EXISTS details TEXT NOT NULL DEFAULT ''`);
      const { rows: toMigrate } = await pool.query(`
        SELECT id, about_purpose, about_when, about_obs FROM commands
        WHERE trim(coalesce(details, '')) = ''
          AND (trim(coalesce(about_purpose, '')) <> '' OR trim(coalesce(about_when, '')) <> '' OR trim(coalesce(about_obs, '')) <> '')
      `);
      const escapeHtml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const toParagraphs = s => escapeHtml(s).split(/\n{2,}/).map(block => `<p>${block.replace(/\n/g, '<br>')}</p>`).join('');
      const buildDetailsHtml = (purpose, when, obs) => {
        const sections = [];
        if (purpose && purpose.trim()) sections.push(`<p><strong>Purpose</strong></p>${toParagraphs(purpose)}`);
        if (when && when.trim()) sections.push(`<p><strong>When to use</strong></p>${toParagraphs(when)}`);
        if (obs && obs.trim()) sections.push(`<p><strong>Note</strong></p>${toParagraphs(obs)}`);
        return sections.join('');
      };
      for (const row of toMigrate) {
        await pool.query('UPDATE commands SET details = $1 WHERE id = $2', [
          buildDetailsHtml(row.about_purpose, row.about_when, row.about_obs), row.id,
        ]);
      }
      if (toMigrate.length) {
        console.log(`[db] Purpose/When to use/Note migrados para o novo campo Details (rich text) em ${toMigrate.length} comando(s).`);
      }
      await pool.query(`ALTER TABLE commands DROP COLUMN IF EXISTS about_purpose`);
      await pool.query(`ALTER TABLE commands DROP COLUMN IF EXISTS about_when`);
      await pool.query(`ALTER TABLE commands DROP COLUMN IF EXISTS about_obs`);
      await pool.query(`ALTER TABLE commands DROP COLUMN IF EXISTS about_icon`);
    } else {
      // Instalação nova, ou já migrada — só garante que `details` existe
      // (schema.sql já cria com CREATE TABLE IF NOT EXISTS, então isto é
      // redundante numa instalação 100% nova, mas inofensivo).
      await pool.query(`ALTER TABLE commands ADD COLUMN IF NOT EXISTS details TEXT NOT NULL DEFAULT ''`);
    }
  } catch (err) {
    console.error('[db] Falha ao migrar about_purpose/about_when/about_obs para details:', err.message);
  }
}

// Garante que sempre existe pelo menos uma conta local com role='super_admin'
// — sem isso, uma instalação nova ficaria sem ninguém que pudesse acessar
// Manage users/Backup/Audit log/API keys/Register. ON CONFLICT DO NOTHING:
// só roda na primeira vez (se alguém já trocou a senha, isto não mexe em
// nada depois — o role, porém, é sempre reforçado como super_admin, ver o
// UPDATE em runMigrations() acima e o guard em PUT/DELETE
// /api/users/:username em server/index.js: "Usuário admin terá o perfil de
// Super Admin que não pode ser alterado por outro usuário", pedido do
// usuário).
async function seedDefaultAdmin() {
  try {
    // handle='admin' explícito (runMigrations(), que faz o backfill
    // automático de handle para linhas já existentes, roda ANTES desta
    // função — ver initDb() acima — então esta conta ainda não existia
    // quando o backfill rodou; sem isso ficaria sem handle). approved_at
    // já nasce preenchido — a conta semente nunca passa por "pendente".
    await pool.query(
      `INSERT INTO users (username, password_hash, role, is_local, created_by, auth_provider, handle, approved_at)
       VALUES ('admin', $1, 'super_admin', 1, 'system', 'local', 'admin', NOW())
       ON CONFLICT (username) DO NOTHING`,
      [hashPassword('admin')]
    );
  } catch (err) {
    console.error('[db] Falha ao semear usuário admin padrão:', err.message);
  }
}

// Garante que TODO usuário já cadastrado tenha uma pasta "Favorites" —
// pedido do usuário: "definir como padrão que todos usuários tenham as
// pastas Favoritos". Cobre quem já existia ANTES deste recurso (usuários
// novos, criados depois, já ganham a pasta na hora — ver
// ensureDefaultFolder() em server/index.js, chamada por getOrCreateUserRole
// e por POST /api/users). Roda depois de seedDefaultAdmin() (acima) de
// propósito, pra também cobrir o admin padrão numa instalação nova, no
// mesmo boot. Um único INSERT ... SELECT, idempotente (ON CONFLICT
// (username, name) DO NOTHING — mesma constraint única usada pela migração
// legada de favoritos, ver runMigrations()) — seguro rodar em todo boot,
// nunca duplica nem sobrescreve uma pasta "Favorites" que o usuário já
// tenha (inclusive uma renomeada/customizada por ele).
async function seedDefaultFolders() {
  try {
    await pool.query(
      `INSERT INTO folders (username, name) SELECT username, 'Favorites' FROM users
       ON CONFLICT (username, name) DO NOTHING`
    );
  } catch (err) {
    console.error('[db] Falha ao semear pasta Favorites padrão para usuários existentes:', err.message);
  }
}

// Semeia o catálogo de Prompts (task: "crie a variável Prompt para ser
// utilizada nos comandos que atualmente é um texto livre") — pedido do
// usuário (definição dos valores padrão de uma instalação nova): um prompt
// Check Point (Expert/Clish) + dois Fortinet (CLI padrão / modo config). Só
// roda numa instalação nova (tabela vazia): se o usuário já cadastrou/editou/
// excluiu prompts pelo Register, isto nunca mexe de novo — diferente de
// seedDefaultFolders acima (que é ON CONFLICT DO NOTHING e sempre "reafirma"
// a mesma coisa), aqui um `DELETE` intencional do usuário não pode "voltar" a
// cada boot (exceto se ele apagar TODOS os prompts, esvaziando a tabela de
// novo — mesma ressalva de sempre para este padrão de seed "só se vazio").
// Keys fixas (não geradas por slugifyCatalogKey, que vive em server/index.js)
// — evita depender de outro módulo só para isto.
async function seedDefaultPrompts() {
  const DEFAULTS = [
    { key: 'expert-fw', label: '[Expert@FW]#' },
    { key: 'clish', label: 'clish>' },
    { key: 'fgt', label: 'FGT#' },
    { key: 'fgt-config', label: 'FGT(config)#' },
  ];
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM prompts');
    if (Number(rows[0].n) > 0) return; // instalação já tem prompts (seed anterior ou cadastrados manualmente)
    for (let i = 0; i < DEFAULTS.length; i++) {
      const { key, label } = DEFAULTS[i];
      await pool.query('INSERT INTO prompts (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [key, label, i]);
    }
  } catch (err) {
    console.error('[db] Falha ao semear catálogo de Prompts padrão:', err.message);
  }
}

// Semeia o catalogo de Exports (task: "crie um registro com nome Exports" +
// "substitua o botao estilo flag de Exportable por uma lista suspensa") --
// mesmo principio de seedDefaultPrompts acima (so roda numa instalacao nova,
// tabela vazia). O unico item padrao reproduz EXATAMENTE o comportamento
// fixo que existia antes desta feature (redirecionamento "> {{logFile}}"),
// para que nenhum comando existente mude de aparencia ao atualizar -- ver
// tambem o backfill de command_lines.export_template em runMigrations()
// (mesmo texto usado ali).
async function seedDefaultExports() {
  const DEFAULTS = [
    { key: 'redirect-logfile', label: '> {{logFile}}' },
  ];
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM exports');
    if (Number(rows[0].n) > 0) return; // instalacao ja tem exports (seed anterior ou cadastrados manualmente)
    for (let i = 0; i < DEFAULTS.length; i++) {
      const { key, label } = DEFAULTS[i];
      await pool.query('INSERT INTO exports (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [key, label, i]);
    }
  } catch (err) {
    console.error('[db] Falha ao semear catalogo de Exports padrao:', err.message);
  }
}

// ── Catálogos padrão de uma instalação nova (Vendor/System/Version/
// Environment/Parameter) — pedido do usuário: "definir os seguintes valores
// como padrão em uma instalação nova". Mesmo princípio de seedDefaultPrompts
// acima (só semeia se a PRÓPRIA tabela estiver totalmente vazia; nunca
// sobrescreve nem "reafirma" o que o administrador já tenha cadastrado,
// editado ou excluído pelo Register). Keys fixas e já em minúsculas/
// hifenizadas no mesmo estilo que slugifyCatalogKey (server/index.js) geraria
// a partir do label — evita depender daquele módulo só para isto, e mantém a
// key estável mesmo que o label venha a ser editado depois.
async function seedDefaultVendors() {
  const DEFAULTS = [
    { key: 'check-point', label: 'Check Point' },
    { key: 'fortinet', label: 'Fortinet' },
  ];
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM vendors');
    if (Number(rows[0].n) > 0) return;
    for (let i = 0; i < DEFAULTS.length; i++) {
      const { key, label } = DEFAULTS[i];
      await pool.query('INSERT INTO vendors (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [key, label, i]);
    }
  } catch (err) {
    console.error('[db] Falha ao semear catálogo de Vendors padrão:', err.message);
  }
}

// Depende de vendors já semeado (FK obrigatória systems.vendor) — chamada
// DEPOIS de seedDefaultVendors() em initDb().
async function seedDefaultSystems() {
  const DEFAULTS = [
    { key: 'gaia', vendor: 'check-point', label: 'Gaia' },
    { key: 'fortios', vendor: 'fortinet', label: 'FortiOS' },
  ];
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM systems');
    if (Number(rows[0].n) > 0) return;
    for (let i = 0; i < DEFAULTS.length; i++) {
      const { key, vendor, label } = DEFAULTS[i];
      await pool.query('INSERT INTO systems (key, vendor, label, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING', [key, vendor, label, i]);
    }
  } catch (err) {
    console.error('[db] Falha ao semear catálogo de Systems padrão:', err.message);
  }
}

// Depende de systems já semeado (FK obrigatória versions.system/vendor).
async function seedDefaultVersions() {
  const DEFAULTS = [
    { system: 'gaia', vendor: 'check-point', key: 'r81.10', label: 'R81.10' },
    { system: 'gaia', vendor: 'check-point', key: 'r81.20', label: 'R81.20' },
    { system: 'gaia', vendor: 'check-point', key: 'r82', label: 'R82' },
    { system: 'gaia', vendor: 'check-point', key: 'r82.10', label: 'R82.10' },
    { system: 'fortios', vendor: 'fortinet', key: '7.2', label: '7.2' },
    { system: 'fortios', vendor: 'fortinet', key: '7.4', label: '7.4' },
    { system: 'fortios', vendor: 'fortinet', key: '7.6', label: '7.6' },
    { system: 'fortios', vendor: 'fortinet', key: '8.0', label: '8.0' },
  ];
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM versions');
    if (Number(rows[0].n) > 0) return;
    for (let i = 0; i < DEFAULTS.length; i++) {
      const { system, vendor, key, label } = DEFAULTS[i];
      await pool.query(
        'INSERT INTO versions (system, vendor, key, label, sort_order) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (system, key) DO NOTHING',
        [system, vendor, key, label, i]
      );
    }
  } catch (err) {
    console.error('[db] Falha ao semear catálogo de Versions padrão:', err.message);
  }
}

// Depende de systems já semeado (FK obrigatória environments.system/vendor,
// ver comentário em server/schema.sql). Roda DEPOIS de runMigrations() (que
// cuida do backfill de instalações já existentes) — numa instalação nova a
// tabela chega vazia em ambos os casos, então não há conflito entre os dois.
async function seedDefaultEnvironments() {
  const DEFAULTS = [
    { system: 'gaia', vendor: 'check-point', key: 'firewall', label: 'Firewall' },
    { system: 'gaia', vendor: 'check-point', key: 'management', label: 'Management' },
    { system: 'gaia', vendor: 'check-point', key: 'maestro', label: 'Maestro' },
    { system: 'gaia', vendor: 'check-point', key: 'multi-domain', label: 'Multi-Domain' },
    { system: 'gaia', vendor: 'check-point', key: 'vsx', label: 'VSX' },
    { system: 'fortios', vendor: 'fortinet', key: 'fortigate', label: 'FortiGate' },
    { system: 'fortios', vendor: 'fortinet', key: 'forticlient', label: 'FortiClient' },
    { system: 'fortios', vendor: 'fortinet', key: 'fortianalyzer', label: 'FortiAnalyzer' },
    { system: 'fortios', vendor: 'fortinet', key: 'fortimanager', label: 'FortiManager' },
    { system: 'fortios', vendor: 'fortinet', key: 'fortisase', label: 'FortiSASE' },
  ];
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM environments');
    if (Number(rows[0].n) > 0) return;
    for (let i = 0; i < DEFAULTS.length; i++) {
      const { system, vendor, key, label } = DEFAULTS[i];
      await pool.query(
        'INSERT INTO environments (key, system, vendor, label, sort_order) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING',
        [key, system, vendor, label, i]
      );
    }
  } catch (err) {
    console.error('[db] Falha ao semear catálogo de Environments padrão:', err.message);
  }
}

// Sem dependência de FK — independente da ordem em relação aos 4 acima.
async function seedDefaultParameters() {
  const DEFAULTS = [
    { key: 'src_ip', label: 'Source' },
    { key: 'dst_ip', label: 'Destination' },
    { key: 'src_port', label: 'Source Port' },
    { key: 'dst_port', label: 'Destination Port' },
    { key: 'user', label: 'User' },
    { key: 'host', label: 'Host' },
    { key: 'license', label: 'License' },
    { key: 'signature', label: 'Signature' },
  ];
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM parameters');
    if (Number(rows[0].n) > 0) return;
    for (let i = 0; i < DEFAULTS.length; i++) {
      const { key, label } = DEFAULTS[i];
      await pool.query('INSERT INTO parameters (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [key, label, i]);
    }
  } catch (err) {
    console.error('[db] Falha ao semear catálogo de Parameters padrão:', err.message);
  }
}

// Executa `fn(client)` dentro de uma transação (BEGIN/COMMIT/ROLLBACK) usando
// um único client dedicado do pool — equivalente ao antigo `db.transaction()`
// síncrono do better-sqlite3, só que explícito e assíncrono.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* conexão já pode ter caído */ }
    throw err;
  } finally {
    client.release();
  }
}

// runMigrations exportado além de initDb (que já o chama no boot normal) só
// para permitir testes automatizados aplicarem o schema base e popularem
// dados de catálogo ANTES de rodar as migrações — ex.: o teste de backfill de
// environments.system precisa inserir vendors/systems/version_environments
// "pré-existentes" entre a aplicação do schema.sql e o backfill em si, coisa
// que initDb() (que roda os dois passos em sequência, sem pausa) não permite.
module.exports = { pool, initDb, runMigrations, withTransaction, getConnectionString, generateUniqueHandle };
