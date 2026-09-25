// server/perf-seed.js — gerador de dados sintéticos para teste de
// performance. Pedido do usuário: "quero testar a performance da
// aplicação, crie um script para criar 1000 usuário com 500 comandos, 200
// pastas com 30 comandos variados cada usuário".
//
// NÃO é parte do fluxo normal da aplicação (diferente de server/seed.js,
// que semeia os ~30 comandos de referência reais usados em produção) — é
// uma ferramenta avulsa, pra rodar manualmente quando quiser stressar o
// banco/API com um volume grande de dados.
//
// Por padrão gera 1000 usuários locais, cada um com 500 comandos próprios
// e 200 pastas, e cada pasta recebendo 30 comandos sorteados dentre os 500
// do próprio usuário (o mesmo comando pode estar em mais de uma pasta —
// folder_commands é N:N, ver server/schema.sql). Volume aproximado do run
// padrão:
//   - 1.000 usuários
//   - 500.000 comandos (+ 500.000 linhas em command_topics, 1 por comando)
//   - 200.000 pastas
//   - 6.000.000 vínculos pasta↔comando (folder_commands)
// Total ~7,2 milhões de linhas — em máquinas modestas isso pode levar
// vários minutos (o script usa INSERT em lote, não linha a linha, mas o
// volume ainda é grande). Rode um teste pequeno primeiro (ver "Uso"
// abaixo) antes do run completo.
//
// Todos os usuários/comandos/pastas gerados usam o prefixo PREFIX+DOMAIN
// abaixo (ex.: perftest-00001@toolbox45.perf) — isso permite identificar e
// remover TUDO que este script criou, sem tocar em nenhum dado real:
//
//   node server/perf-seed.js              # gera com os tamanhos padrão (1000/500/200/30)
//   node server/perf-seed.js --cleanup    # remove TUDO que este script já criou
//
// Uso com tamanhos menores, para validar antes do run grande (que pode
// levar minutos) — sobrescreva via variável de ambiente:
//   NUM_USERS=20 COMMANDS_PER_USER=50 FOLDERS_PER_USER=10 COMMANDS_PER_FOLDER=5 node server/perf-seed.js
//
// Todos os usuários criados têm a MESMA senha (ver PASSWORD abaixo) — dá
// pra logar como qualquer um deles (ex.: perftest-00001@toolbox45.perf) e
// navegar a UI de verdade com 500 comandos / 200 pastas na conta, não só
// medir a API isoladamente.
//
// ATENÇÃO: grava direto no banco apontado pelas MESMAS variáveis de
// ambiente do backend (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD — ver
// docs/server-overview.md, seção "Install & run standalone"; dentro do
// container Docker elas já vêm do docker-compose.yml). Rode isso numa base
// de TESTE, a menos que "testar com carga real" seja literalmente o
// objetivo em produção.

const { pool, initDb, withTransaction, generateUniqueHandle } = require('./db');
const { hashPassword } = require('./auth');

// ── Marca de identificação de tudo que este script cria/remove — mude aqui
// se quiser rodar mais de um "lote" de teste isolado ao mesmo tempo. ──
const PREFIX = 'perftest-';
const DOMAIN = '@toolbox45.perf';
const PASSWORD = 'perftest123'; // mesma senha p/ todos os usuários gerados

const NUM_USERS = Number(process.env.NUM_USERS || 1000);
const COMMANDS_PER_USER = Number(process.env.COMMANDS_PER_USER || 500);
const FOLDERS_PER_USER = Number(process.env.FOLDERS_PER_USER || 200);
const COMMANDS_PER_FOLDER = Number(process.env.COMMANDS_PER_FOLDER || 30);

// Tópicos variados — não usa os tópicos "reais" da instalação (que podem
// nem existir ainda numa base de teste vazia) para não colidir/depender
// deles; ON CONFLICT DO NOTHING em ensureTopics() abaixo torna seguro rodar
// isto numa base que já tem esses mesmos keys por outro motivo.
const TOPICS = [
  'capture', 'vpn', 'routing', 'nat', 'monitoring', 'licensing',
  'ha-cluster', 'logs', 'tunnels', 'certificates', 'interfaces',
  'policy', 'identity-awareness', 'threat-prevention', 'upgrade',
];
// Vocabulário só pra dar variedade legível ao nome/descrição dos comandos
// sintéticos ("comandos variados") — não é sintaxe real de CLI, o conteúdo
// não importa pra um teste de volume/performance, só o formato/tamanho.
const ACTIONS = ['Show', 'Debug', 'Monitor', 'Configure', 'Reset', 'Export', 'Validate', 'Trace', 'Inspect', 'Sync'];
const OBJECTS = ['interface', 'policy', 'session table', 'VPN tunnel', 'cluster state', 'routing table', 'license', 'certificate', 'log buffer', 'NAT rule'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function padded(n, width) { return String(n).padStart(width, '0'); }

// Fisher-Yates completo — usado UMA vez por usuário (embaralha os 500
// commandIds dele) em vez de sortear 30 a cada uma das 200 pastas, bem mais
// barato no total. Cada pasta depois pega uma "janela" de 30 posições
// consecutivas dessa permutação (com wraparound) — como é uma permutação
// de verdade, qualquer janela de até COMMANDS_PER_FOLDER<=len é
// automaticamente distinta dentro dela mesma (sem risco de duplicar
// command_id na mesma pasta, o que violaria a PK (folder_id, command_id)
// de folder_commands), e cada pasta acaba com uma janela diferente.
function shuffled(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function windowPick(shuffledArr, start, count) {
  const len = shuffledArr.length;
  const take = Math.min(count, len);
  const s = start % len;
  if (s + take <= len) return shuffledArr.slice(s, s + take);
  return shuffledArr.slice(s).concat(shuffledArr.slice(0, (s + take) - len));
}

// ── INSERT em lote — monta um único INSERT multi-linha com $1..$N, em vez
// de uma query por linha (essencial nesta escala: 500 mil/6 milhões de
// linhas uma a uma levaria horas). batchRows respeita o teto de 65535
// parâmetros por query do Postgres (batchRows * columns.length precisa
// ficar bem abaixo disso). withReturningId=true captura os ids gerados, na
// MESMA ordem das linhas enviadas (garantido pelo Postgres pra um único
// INSERT ... VALUES ... RETURNING). ──
async function batchInsert(client, table, columns, rows, { batchRows = 1000, withReturningId = false } = {}) {
  const ids = [];
  for (let i = 0; i < rows.length; i += batchRows) {
    const chunk = rows.slice(i, i + batchRows);
    const values = [];
    const placeholders = chunk.map((row, r) => {
      const base = r * columns.length;
      values.push(...row);
      return '(' + columns.map((_, c) => `$${base + c + 1}`).join(', ') + ')';
    }).join(', ');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}` + (withReturningId ? ' RETURNING id' : '');
    const { rows: result } = await client.query(sql, values);
    if (withReturningId) for (const r of result) ids.push(r.id);
  }
  return ids;
}

async function ensureTopics(client) {
  for (let i = 0; i < TOPICS.length; i++) {
    await client.query('INSERT INTO topics (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [TOPICS[i], TOPICS[i], i]);
  }
}

async function cleanup() {
  console.log(`Removing everything created by this script (username LIKE '${PREFIX}%${DOMAIN}')...`);
  const { rows: users } = await pool.query('SELECT username FROM users WHERE username LIKE $1', [`${PREFIX}%${DOMAIN}`]);
  const usernames = users.map(u => u.username);
  console.log(`  ${usernames.length} test user(s) found.`);
  if (!usernames.length) {
    console.log('Nothing to clean up.');
    await pool.end();
    return;
  }
  await withTransaction(async client => {
    // commands/folders não têm FK pra users (created_by/username são TEXT
    // "soft", sem ON DELETE CASCADE — ver comentários em schema.sql), então
    // precisam ser removidos explicitamente ANTES/independente da linha em
    // `users` (essa sim tem FKs de verdade em sessions/links/shares/
    // group_members, que cascateiam sozinhas ao apagar o usuário).
    await client.query('DELETE FROM folder_commands WHERE folder_id IN (SELECT id FROM folders WHERE username = ANY($1))', [usernames]);
    await client.query('DELETE FROM commands WHERE created_by = ANY($1)', [usernames]);
    await client.query('DELETE FROM folders WHERE username = ANY($1)', [usernames]);
    await client.query('DELETE FROM users WHERE username = ANY($1)', [usernames]);
  });
  console.log('Cleanup complete.');
  await pool.end();
}

async function seed() {
  const totalCommands = NUM_USERS * COMMANDS_PER_USER;
  const totalFolders = NUM_USERS * FOLDERS_PER_USER;
  const totalLinks = NUM_USERS * FOLDERS_PER_USER * COMMANDS_PER_FOLDER;
  console.log(`Generating ${NUM_USERS} users, ${COMMANDS_PER_USER} commands/user (${totalCommands} total), ${FOLDERS_PER_USER} folders/user (${totalFolders} total), ${COMMANDS_PER_FOLDER} commands/folder (${totalLinks} folder_commands rows total).`);
  const t0 = Date.now();

  await initDb();
  await ensureTopics(pool);

  const passwordHash = hashPassword(PASSWORD); // uma vez só — reaproveitado por todos os usuários (dado descartável, não precisa de salt único por conta)

  // ── 1) usuários ──
  console.log('Creating users...');
  const usernames = [];
  await withTransaction(async client => {
    for (let i = 1; i <= NUM_USERS; i++) {
      const username = `${PREFIX}${padded(i, 5)}${DOMAIN}`;
      const handle = await generateUniqueHandle(client, username);
      await client.query(
        `INSERT INTO users (username, password_hash, role, is_local, disabled, created_by, auth_provider, handle, approved_at)
         VALUES ($1, $2, 'user', 1, 0, 'perf-seed', 'local', $3, NOW())
         ON CONFLICT (username) DO NOTHINF`,
        [username, passwordHash, handle]
      );
      usernames.push(username);
      if (i % 200 === 0) console.log(`  ${i}/${NUM_USERS} users`);
    }
  });
  console.log(`Users done (${((Date.now() - t0) / 1000).toFixed(1)}s elapsed).`);

  // ── 2) por usuário: comandos + pastas + folder_commands ──
  let doneCommands = 0, doneFolders = 0, doneLinks = 0;
  for (let ui = 0; ui < usernames.length; ui++) {
    const username = usernames[ui];
    await withTransaction(async client => {
      // Comandos — cols: topic, icon, sort_order, requires_ip_port,
      // placeholder_resolver, name, name_empty, "desc", desc_empty,
      // details, created_by, modified_by (ver commands em schema.sql).
      const cmdRows = [];
      for (let ci = 1; ci <= COMMANDS_PER_USER; ci++) {
        const topic = pick(TOPICS);
        const name = `${pick(ACTIONS)} ${pick(OBJECTS)} #${ci}`;
        cmdRows.push([
          topic, '📄', ci, 0, null,
          name, null,
          'Synthetic command generated for performance testing.', null,
          '<p>Generated by server/perf-seed.js for load testing — content is not real CLI syntax.</p>',
          username, username,
        ]);
      }
      const commandIds = await batchInsert(client, 'commands',
        ['topic', 'icon', 'sort_order', 'requires_ip_port', 'placeholder_resolver', 'name', 'name_empty', '"desc"', 'desc_empty', 'details', 'created_by', 'modified_by'],
        cmdRows, { withReturningId: true });

      // command_topics — 1 linha por comando (topic == commands.topic,
      // mesma convenção de "todo comando tem pelo menos 1 tópico").
      const topicRows = commandIds.map((id, idx) => [id, cmdRows[idx][0]]);
      await batchInsert(client, 'command_topics', ['command_id', 'topic'], topicRows);

      // Pastas — cols: username, name, sort_order, parent_id (tudo no
      // nível raiz, parent_id NULL — "200 pastas" simples, sem aninhar).
      const folderRows = [];
      for (let fi = 1; fi <= FOLDERS_PER_USER; fi++) {
        folderRows.push([username, `Folder ${padded(fi, 3)}`, fi, null]);
      }
      const folderIds = await batchInsert(client, 'folders',
        ['username', 'name', 'sort_order', 'parent_id'],
        folderRows, { withReturningId: true });

      // folder_commands — 30 comandos "variados" por pasta, sorteados
      // dentre os do próprio usuário (ver windowPick()/shuffled() acima).
      const shuffledIds = shuffled(commandIds);
      const linkRows = [];
      for (let fi = 0; fi < folderIds.length; fi++) {
        const picks = windowPick(shuffledIds, fi * COMMANDS_PER_FOLDER, COMMANDS_PER_FOLDER);
        picks.forEach((commandId, idx) => linkRows.push([folderIds[fi], commandId, idx]));
      }
      await batchInsert(client, 'folder_commands', ['folder_id', 'command_id', 'sort_order'], linkRows);

      doneCommands += commandIds.length;
      doneFolders += folderIds.length;
      doneLinks += linkRows.length;
    });

    if ((ui + 1) % 25 === 0 || ui === usernames.length - 1) {
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`  ${ui + 1}/${usernames.length} users — ${doneCommands} commands, ${doneFolders} folders, ${doneLinks} folder_commands (${elapsed.toFixed(1)}s elapsed)`);
    }
  }

  console.log(`Seed complete: ${usernames.length} users, ${doneCommands} commands, ${doneFolders} folders, ${doneLinks} folder_commands rows in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Log in as any of them with password "${PASSWORD}" — e.g. ${usernames[0]}`);
  console.log(`When done testing, run: node server/perf-seed.js --cleanup`);
  await pool.end();
}

const run = process.argv.includes('--cleanup') ? cleanup() : seed();
run.catch(err => {
  console.error('perf-seed failed:', err);
  process.exit(1);
});
