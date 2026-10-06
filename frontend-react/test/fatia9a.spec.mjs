// Suíte de validação manual (Playwright) da Fase 3, fatia 9 (parte A: aba
// "Database" do modal de Configurações — gating admin-only, modal "Database
// backup" e modal "Audit log") — mesmo padrão de mocking de /api/* usado em
// test/fatia8.spec.mjs (route() por endpoint, sem backend real; fixtures em
// memória mutáveis com contadores `calls`; helpers assert/withPage/
// assertEventually idênticos). As expectativas derivam do ORIGINAL
// (js/backup.js, js/audit-log.js, index.html #backupManagerOverlay /
// #auditLogOverlay, server-py/app/routers/backup.py), não do código React.
//
//   A. Gating do DatabasePane (user x admin x super_admin).
//   B. Backup modal: abertura, lista (formatos, vazio, falha), backup now,
//      restore (confirm/alert/reload).
//   C. Agendamento (GET popula, opacity/pointer-events, dropdown de
//      frequência, dias da semana em ordem de clique, PUT, clamp, quirk do
//      toggle que reaplica o estado salvo nos inputs).
//   D. Audit log: abertura, formatação, mapa de rótulos, escape, vazio/falha.
//   E. Fechamento dos dois modais (✕, Close, overlay, Escape).
//   F. Defesa em profundidade (usuário comum nunca tem os modais no DOM).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/fase3-fatia9a-shots';
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let asserts = 0;
function assert(cond, msg) {
  asserts++;
  if (!cond) {
    failures++;
    console.error('FALHOU:', msg);
  } else {
    console.log('ok:', msg);
  }
}

async function assertEventually(fn, msg, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let ok = false;
    try {
      ok = await fn();
    } catch {
      ok = false;
    }
    if (ok) {
      assert(true, msg);
      return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert(false, msg);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// UTC fixo: formatBackupDate/formatAuditDate usam o fuso LOCAL do navegador
// (getHours() etc.), então fixamos o fuso do contexto pra ter saída
// determinística.
async function withPage(browser, fn) {
  const ctx = await browser.newContext({ timezoneId: 'UTC', locale: 'en-US' });
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}

function makeGate() {
  let open;
  const promise = new Promise(r => (open = r));
  return { promise, open };
}

// ════════════════════════════════════════════════
// FIXTURES / MOCKS BASE (mesmo esqueleto de fatia6/7/8)
// ════════════════════════════════════════════════
const EMPTY_CATALOGS = { vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [] };

async function mockBase(page, { isAdmin = false, isSuperAdmin = false } = {}) {
  const counters = { me: 0, backupishRequests: [] };
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
  });
  // Registra QUALQUER request a endpoints de backup/audit (inclusive não
  // mockeados), pro cenário de defesa em profundidade.
  page.on('request', req => {
    const p = new URL(req.url()).pathname;
    if (p.startsWith('/api/backups') || p === '/api/backup-schedule' || p === '/api/audit-log') {
      counters.backupishRequests.push(`${req.method()} ${p}`);
    }
  });
  await page.route('**/api/me', route => {
    counters.me++;
    return route.fulfill({
      json: {
        username: 'tester', upn: 'tester', handle: 'tester',
        role: isSuperAdmin ? 'super_admin' : isAdmin ? 'admin' : 'user',
        isAdmin, isSuperAdmin, authMethod: 'local',
      },
    });
  });
  await page.route('**/api/catalogs', route => route.fulfill({ json: EMPTY_CATALOGS }));
  await page.route('**/api/system/logo', route => (route.request().method() === 'GET' ? route.fulfill({ json: { imageData: null, imageDataDark: null } }) : route.continue()));
  await page.route('**/api/commands', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  await page.route('**/api/folders', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  await page.route('**/api/user-data', route => (route.request().method() === 'GET' ? route.fulfill({ json: {} }) : route.continue()));
  return counters;
}

async function goToApp(page) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle[title="Settings"]');
}

async function openSettings(page) {
  await page.click('.theme-toggle[title="Settings"]');
  await page.waitForSelector('.settings-modal-box');
}

async function openDatabasePane(page) {
  await openSettings(page);
  await page.locator('.settings-nav-btn', { hasText: 'Database' }).click();
  await page.waitForSelector('.settings-content .set-group');
}

// DatabasePane.tsx NÃO tem o wrapper .settings-pane[data-pane="database"] que
// o original tem (e que todas as outras panes React têm) — por isso o escopo
// é .settings-content (mesmo seletor usado por folders5c.spec.mjs). A
// ausência do wrapper é verificada explicitamente no cenário 1.
const dbPane = page => page.locator('.settings-content');
const bkModal = page => page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Database backup' }) });
const auditModal = page => page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Audit log' }) });
const bkOverlay = page => page.locator('.modal-overlay').filter({ has: page.locator('.modal-title', { hasText: 'Database backup' }) });
const auditOverlay = page => page.locator('.modal-overlay').filter({ has: page.locator('.modal-title', { hasText: 'Audit log' }) });

async function openBackupModal(page) {
  await dbPane(page).locator('button', { hasText: 'Backup & Restore' }).click();
  const m = bkModal(page);
  await m.waitFor();
  return m;
}

async function openAuditModal(page) {
  await dbPane(page).locator('button', { hasText: 'View audit log' }).click();
  const m = auditModal(page);
  await m.waitFor();
  return m;
}

async function openBackupModalFresh(page) {
  await goToApp(page);
  await openDatabasePane(page);
  return openBackupModal(page);
}

// Texto de cada <td> de cada <tr> do tbody informado (textContent — não
// depende de text-transform de CSS).
async function tableRows(tbodyLocator) {
  return tbodyLocator.locator('tr').evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())));
}

// ════════════════════════════════════════════════
// MOCKS ESPECÍFICOS DA FATIA 9A — estado mutável em memória
// ════════════════════════════════════════════════
function makeBackupState(o = {}) {
  return {
    backups: (o.backups || []).map(b => ({ ...b })), // cópia: o POST /api/backups faz unshift
    listStatus: 200, listGate: null,
    createStatus: 201, createGate: null, createFilename: 'toolbox45-backup-new.dump', createAddsRow: true,
    restoreStatus: 200, restoreGate: null,
    restoreBody: { ok: true, message: 'Restore complete. Reload the page to see the restored data.' },
    schedule: { enabled: false, frequency: 'daily', weeklyDays: [], monthlyDay: 1, time: '02:00', ...(o.schedule || {}) },
    scheduleStatus: 200, putStatus: 204, putGate: null,
    audit: o.audit || [], auditStatus: 200, auditGate: null,
    calls: {
      listGet: 0, createPost: 0, restorePost: [], downloadGet: [],
      scheduleGet: 0, schedulePut: [], schedulePutHeaders: [], schedulePutMethods: [],
      auditGet: 0,
    },
  };
}

async function mockBackupApi(page, state) {
  await page.route(url => url.pathname === '/api/backups', async route => {
    const method = route.request().method();
    if (method === 'GET') {
      state.calls.listGet++;
      const gate = state.listGate;
      if (gate) await gate.promise;
      if (state.listStatus !== 200) return route.fulfill({ status: state.listStatus, json: { error: 'internal_error' } });
      return route.fulfill({ json: state.backups });
    }
    if (method === 'POST') {
      state.calls.createPost++;
      const gate = state.createGate;
      if (gate) await gate.promise;
      if (state.createStatus >= 400) return route.fulfill({ status: state.createStatus, json: { error: 'internal_error', message: 'SERVER-SECRET-MSG' } });
      if (state.createAddsRow) state.backups.unshift({ filename: state.createFilename, createdAt: '2026-04-01T10:00:00Z', sizeBytes: 1000 });
      return route.fulfill({ status: 201, json: { filename: state.createFilename } });
    }
    return route.continue();
  });

  await page.route(url => /^\/api\/backups\/[^/]+\/restore$/.test(url.pathname), async route => {
    const pathname = new URL(route.request().url()).pathname;
    state.calls.restorePost.push({ method: route.request().method(), pathname });
    const gate = state.restoreGate;
    if (gate) await gate.promise;
    if (state.restoreStatus >= 400) return route.fulfill({ status: state.restoreStatus, json: { error: 'internal_error', message: 'SERVER-SECRET-MSG' } });
    return route.fulfill({ json: state.restoreBody });
  });

  await page.route(url => /^\/api\/backups\/[^/]+\/download$/.test(url.pathname), route => {
    state.calls.downloadGet.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'DUMP' });
  });

  await page.route(url => url.pathname === '/api/backup-schedule', async route => {
    const method = route.request().method();
    if (method === 'GET') {
      state.calls.scheduleGet++;
      if (state.scheduleStatus !== 200) return route.fulfill({ status: state.scheduleStatus, json: { error: 'internal_error' } });
      return route.fulfill({ json: state.schedule });
    }
    if (method === 'PUT') {
      const gate = state.putGate;
      state.calls.schedulePutMethods.push(method);
      state.calls.schedulePut.push(route.request().postDataJSON());
      state.calls.schedulePutHeaders.push(route.request().headers()['content-type'] || '');
      if (gate) await gate.promise;
      if (state.putStatus >= 400) return route.fulfill({ status: state.putStatus, json: { error: 'internal_error' } });
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });

  await page.route(url => url.pathname === '/api/audit-log', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    state.calls.auditGet++;
    const gate = state.auditGate;
    if (gate) await gate.promise;
    if (state.auditStatus !== 200) return route.fulfill({ status: state.auditStatus, json: { error: 'internal_error' } });
    return route.fulfill({ json: state.audit });
  });
}

const SAMPLE_BACKUPS = [
  { filename: 'toolbox45-2026-03-05T14-30-00.dump', createdAt: '2026-03-05T14:30:00Z', sizeBytes: 500 },
  { filename: 'toolbox45-2026-03-04T02-00-00.dump', createdAt: '2026-03-04T02:05:09Z', sizeBytes: 2048 },
  { filename: 'toolbox45-2026-03-03T02-00-00.dump', createdAt: '2026-12-31T23:59:00.000Z', sizeBytes: 129924 },
  { filename: 'pre-restore-2026-03-02T02-00-00.dump', createdAt: '2026-01-02T03:04:00Z', sizeBytes: 2 * 1024 * 1024 },
];

const browser = await chromium.launch();

// ════════════════════════════════════════════════
// A — GATING DO DatabasePane
// ════════════════════════════════════════════════

// ── Cenário 1: usuário comum vê Commands + Folders, NÃO vê Database ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: false });
  const state = makeBackupState();
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);

  const labels = (await dbPane(page).locator('.set-group > .set-label').allInnerTexts()).map(t => t.toLowerCase());
  assert(JSON.stringify(labels) === JSON.stringify(['commands', 'folders']), `cenário 1: usuário comum vê só "Commands" e "Folders" (lido: ${JSON.stringify(labels)})`);
  assert((await dbPane(page).locator('button', { hasText: 'Backup & Restore' }).count()) === 0, 'cenário 1: botão "Backup & Restore" não existe para usuário comum');
  assert((await dbPane(page).locator('button', { hasText: 'View audit log' }).count()) === 0, 'cenário 1: botão "View audit log" não existe para usuário comum');
  assert((await page.locator('#sysGroupDatabase').count()) === 0, 'cenário 1: #sysGroupDatabase não está no DOM para usuário comum');
  // ACHADO esperado: o original embrulha os grupos em <div class="settings-pane" data-pane="database">.
  assert((await page.locator('.settings-pane[data-pane="database"]').count()) === 1, 'cenário 1: os grupos da aba Database estão dentro de .settings-pane[data-pane="database"] (wrapper do original; as demais panes React têm)');
  assert((await dbPane(page).locator('button', { hasText: 'Export commands' }).count()) === 1 && (await dbPane(page).locator('button', { hasText: 'Import folder' }).count()) === 1, 'cenário 1: botões de Commands/Folders continuam disponíveis ao usuário comum');
});

// ── Cenário 2: admin vê os 3 grupos (e abrir a aba não dispara requests) ──
await withPage(browser, async page => {
  const counters = await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState();
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);

  const labels = await (async () => {
    // O grupo Database só monta depois que /api/me confirma o cargo.
    let l = [];
    for (let i = 0; i < 60; i++) {
      l = (await dbPane(page).locator('.set-group > .set-label').allInnerTexts()).map(t => t.toLowerCase());
      if (l.length === 3) break;
      await sleep(50);
    }
    return l;
  })();
  assert(JSON.stringify(labels) === JSON.stringify(['commands', 'folders', 'database']), `cenário 2: admin vê Commands, Folders e Database nesta ordem (lido: ${JSON.stringify(labels)})`);
  assert(await dbPane(page).locator('button', { hasText: 'Backup & Restore' }).isVisible(), 'cenário 2: admin vê "Backup & Restore"');
  assert(await dbPane(page).locator('button', { hasText: 'View audit log' }).isVisible(), 'cenário 2: admin vê "View audit log"');
  assert(counters.backupishRequests.length === 0, `cenário 2: só abrir a aba Database não dispara nenhum request de backup/audit (lido: ${JSON.stringify(counters.backupishRequests)})`);
  assert((await bkModal(page).count()) === 0 && (await auditModal(page).count()) === 0, 'cenário 2: nenhum dos dois modais está aberto/montado antes do clique');
  await page.screenshot({ path: `${SHOTS}/2-database-admin.png` });
});

// ── Cenário 3: super_admin também vê os 3 grupos ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState();
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  await assertEventually(async () => (await dbPane(page).locator('.set-group > .set-label').count()) === 3, 'cenário 3: super_admin vê os 3 grupos (Commands/Folders/Database)');
  assert(await dbPane(page).locator('button', { hasText: 'Backup & Restore' }).isVisible() && await dbPane(page).locator('button', { hasText: 'View audit log' }).isVisible(), 'cenário 3: super_admin vê os dois botões do grupo Database');
});

// ════════════════════════════════════════════════
// B — BACKUP MODAL
// ════════════════════════════════════════════════

// ── Cenário 4: abertura dispara GET /api/backups e /api/backup-schedule; título; "Loading…" ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState({ backups: SAMPLE_BACKUPS });
  state.listGate = makeGate();
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  await assertEventually(async () => (await dbPane(page).locator('button', { hasText: 'Backup & Restore' }).count()) === 1, 'cenário 4: botão disponível');
  const m = await openBackupModal(page);

  assert((await m.locator('.modal-title').innerText()).trim() === 'Database backup', 'cenário 4: título do modal é "Database backup"');
  await assertEventually(() => state.calls.listGet === 1, 'cenário 4: GET /api/backups disparado ao abrir');
  await assertEventually(() => state.calls.scheduleGet === 1, 'cenário 4: GET /api/backup-schedule disparado ao abrir');
  await assertEventually(async () => (await m.locator('#backupListTbody').textContent()).trim() === 'Loading…', 'cenário 4: tbody mostra "Loading…" enquanto a lista não chega');
  assert(!(await m.locator('#backupListEmpty').isVisible()), 'cenário 4: texto de lista vazia NÃO aparece durante o "Loading…"');
  const lbls = (await m.locator('.set-label').allInnerTexts()).map(t => t.toLowerCase());
  assert(['manual backup', 'scheduled backup', 'existing backups'].every(l => lbls.includes(l)), `cenário 4: grupos Manual backup/Scheduled backup/Existing backups presentes (lido: ${JSON.stringify(lbls)})`);

  const g = state.listGate;
  state.listGate = null;
  g.open();
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === SAMPLE_BACKUPS.length && !(await m.locator('#backupListTbody').textContent()).includes('Loading'), 'cenário 4: ao chegar a lista, o "Loading…" some e as 4 linhas aparecem');
});

// ── Cenário 5: formato das linhas (filename, data, tamanho, Download, Restore) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const backups = [...SAMPLE_BACKUPS, { filename: 'weird date.dump', createdAt: 'not-a-date', sizeBytes: 0 }, { filename: 'edge.dump', createdAt: '2026-03-05T14:30:00Z', sizeBytes: 1024 * 1024 - 1 }, { filename: 'a b#c&d.dump', createdAt: '2026-03-05T00:00:00Z', sizeBytes: 1023 }];
  const state = makeBackupState({ backups });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === backups.length, 'cenário 5: todas as linhas renderizadas');

  const rows = await tableRows(m.locator('#backupListTbody'));
  assert(rows[0][0] === SAMPLE_BACKUPS[0].filename, 'cenário 5: coluna File mostra o filename');
  assert(rows[0][1] === '05/03/2026 14:30', `cenário 5: data no formato dd/mm/aaaa hh:mm (lido: "${rows[0][1]}")`);
  assert(rows[1][1] === '04/03/2026 02:05', `cenário 5: data com zero à esquerda (lido: "${rows[1][1]}")`);
  assert(rows[2][1] === '31/12/2026 23:59', `cenário 5: data 31/12 23:59 (lido: "${rows[2][1]}")`);
  assert(rows[3][1] === '02/01/2026 03:04', `cenário 5: dia/mês com padStart (lido: "${rows[3][1]}")`);
  assert(rows[0][2] === '500 B', `cenário 5: 500 -> "500 B" (lido: "${rows[0][2]}")`);
  assert(rows[1][2] === '2.0 KB', `cenário 5: 2048 -> "2.0 KB" (lido: "${rows[1][2]}")`);
  assert(rows[2][2] === '126.9 KB', `cenário 5: 129924 -> "126.9 KB" (lido: "${rows[2][2]}")`);
  assert(rows[3][2] === '2.0 MB', `cenário 5: 2*1024*1024 -> "2.0 MB" (lido: "${rows[3][2]}")`);
  assert(rows[4][1] === 'not-a-date' && rows[4][2] === '0 B', `cenário 5: data inválida volta crua e 0 -> "0 B" (lido: ${JSON.stringify(rows[4])})`);
  assert(rows[5][2] === '1024.0 KB', `cenário 5: 1048575 B -> "1024.0 KB" (limiar < 1 MiB; lido: "${rows[5][2]}")`);
  assert(rows[6][2] === '1023 B', `cenário 5: 1023 -> "1023 B" (lido: "${rows[6][2]}")`);

  const link0 = m.locator('#backupListTbody tr').nth(0).locator('a');
  assert((await link0.getAttribute('href')) === `/api/backups/${encodeURIComponent(SAMPLE_BACKUPS[0].filename)}/download`, 'cenário 5: href do Download = /api/backups/<filename>/download');
  assert((await link0.evaluate(a => a.hasAttribute('download'))), 'cenário 5: link Download tem o atributo download');
  assert((await link0.innerText()).includes('Download'), 'cenário 5: rótulo do link contém "Download"');
  const linkSpecial = m.locator('#backupListTbody tr').nth(6).locator('a');
  assert((await linkSpecial.getAttribute('href')) === `/api/backups/${encodeURIComponent('a b#c&d.dump')}/download` && (await linkSpecial.getAttribute('href')).includes('%20') && (await linkSpecial.getAttribute('href')).includes('%23'), 'cenário 5: href codifica caracteres especiais com encodeURIComponent (espaço, #, &)');
  assert((await m.locator('#backupListTbody tr button', { hasText: 'Restore' }).count()) === backups.length, 'cenário 5: cada linha tem um botão "♻️ Restore"');
  assert(!(await m.locator('#backupListEmpty').isVisible()), 'cenário 5: texto de vazio oculto quando há linhas');
  await page.screenshot({ path: `${SHOTS}/5-backup-list.png` });
});

// ── Cenário 6: lista vazia mostra o texto exato do original ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ backups: [] });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => await m.locator('#backupListEmpty').isVisible(), 'cenário 6: texto de lista vazia fica visível');
  assert((await m.locator('#backupListEmpty').innerText()).trim() === 'No backups yet — click "Backup now" to create the first one.', 'cenário 6: texto exato "No backups yet — click \\"Backup now\\" to create the first one."');
  assert((await m.locator('#backupListTbody tr').count()) === 0, 'cenário 6: tbody vazio (sem linha "Loading…")');
});

// ── Cenário 7: falha no GET /api/backups (500) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState({ backups: SAMPLE_BACKUPS });
  state.listStatus = 500;
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody').textContent()).trim() === 'Failed to load the backup list. Please try again.', 'cenário 7: mensagem "Failed to load the backup list. Please try again."');
  assert(!(await m.locator('#backupListEmpty').isVisible()), 'cenário 7: texto de vazio NÃO aparece na falha');
  assert((await m.locator('#backupListTbody tr button').count()) === 0, 'cenário 7: nenhuma linha/botão de restore na falha');
});

// ── Cenário 8: Backup now — sucesso (disabled + "Creating backup…", status, reload da lista) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ backups: SAMPLE_BACKUPS });
  state.createGate = makeGate();
  state.createFilename = 'toolbox45-2026-04-01T10-00-00.dump';
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === 4, 'cenário 8: lista inicial com 4 linhas');
  const btn = m.locator('#backupNowBtn');
  const status = m.locator('#backupNowStatus');
  assert(!(await btn.isDisabled()) && (await status.innerText()) === '', 'cenário 8: antes do clique o botão está habilitado e o status vazio');
  const getsBefore = state.calls.listGet;

  await btn.click();
  await assertEventually(async () => (await btn.isDisabled()) && (await status.innerText()) === 'Creating backup…', 'cenário 8: durante a chamada o botão fica desabilitado e o status é "Creating backup…"');
  assert(state.calls.createPost === 1, 'cenário 8: POST /api/backups disparado uma vez');
  const g = state.createGate;
  state.createGate = null;
  g.open();
  await assertEventually(async () => (await status.innerText()) === 'Backup created: toolbox45-2026-04-01T10-00-00.dump', 'cenário 8: status "Backup created: <filename>"');
  await assertEventually(() => state.calls.listGet === getsBefore + 1, 'cenário 8: a lista é recarregada (GET /api/backups sobe em 1)');
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === 5 && (await m.locator('#backupListTbody tr').first().innerText()).includes('toolbox45-2026-04-01T10-00-00.dump'), 'cenário 8: o novo backup aparece como 1ª linha da lista recarregada');
  assert(!(await btn.isDisabled()), 'cenário 8: o botão volta a ficar habilitado ao final');
});

// ── Cenário 9: Backup now — falha ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ backups: SAMPLE_BACKUPS });
  state.createStatus = 500;
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === 4, 'cenário 9: lista inicial carregada');
  const getsBefore = state.calls.listGet;
  await m.locator('#backupNowBtn').click();
  await assertEventually(async () => (await m.locator('#backupNowStatus').innerText()) === 'Backup failed. Please try again.', 'cenário 9: status "Backup failed. Please try again." (texto fixo, sem a mensagem do servidor)');
  assert(!(await m.locator('#backupNowStatus').innerText()).includes('SERVER-SECRET-MSG'), 'cenário 9: a mensagem do servidor não vaza para o status');
  assert(!(await m.locator('#backupNowBtn').isDisabled()), 'cenário 9: botão reabilitado após a falha');
  await sleep(300);
  assert(state.calls.listGet === getsBefore, 'cenário 9: a lista NÃO é recarregada após falha');
});

// ── Cenário 9b: reabrir o modal limpa o status do "Backup now" (openBackupManagerModal zera os status) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState({ backups: SAMPLE_BACKUPS, schedule: { enabled: true } });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  let m = await openBackupModal(page);
  await m.locator('#backupNowBtn').click();
  await assertEventually(async () => (await m.locator('#backupNowStatus').innerText()).startsWith('Backup created:'), 'cenário 9b: status de sucesso aparece');
  // agendamento: salvar pra deixar "Schedule saved." no status
  await assertEventually(async () => (await m.locator('#backupScheduleToggle.on').count()) === 1, 'cenário 9b: agendamento habilitado carregado');
  await m.locator('button', { hasText: 'Save schedule' }).click();
  await assertEventually(async () => (await m.locator('#backupScheduleStatus').innerText()) === 'Schedule saved.', 'cenário 9b: status do agendamento aparece');
  await m.locator('.modal-close').click();
  await assertEventually(async () => (await bkModal(page).count()) === 0, 'cenário 9b: modal fecha');
  m = await openBackupModal(page);
  assert((await m.locator('#backupNowStatus').innerText()) === '' && (await m.locator('#backupScheduleStatus').innerText()) === '', 'cenário 9b: ao reabrir, os dois status (backup now e agendamento) voltam vazios');
  await assertEventually(() => state.calls.listGet === 3 && state.calls.scheduleGet === 2, 'cenário 9b: reabrir recarrega lista e agendamento (GET /api/backups = 3 incl. o reload do backup; GET schedule = 2)');
});

// ── Cenário 10: Restore — confirmação com texto exato; Cancelar -> nenhum POST ──
const SINGLE = [{ filename: 'toolbox45-2026-03-05T14-30-00.dump', createdAt: '2026-03-05T14:30:00Z', sizeBytes: 500 }];
function restoreConfirmText(fn) {
  return `Restore "${fn}"? This replaces the current database with this backup's contents. A safety copy of the current database is taken automatically first.`;
}
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState({ backups: SINGLE });
  await mockBackupApi(page, state);
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === 1, 'cenário 10: linha carregada');
  assert(!(await page.locator('#confirmOverlay').evaluate(el => el.classList.contains('show'))), 'cenário 10: confirmação fechada antes do clique');
  await m.locator('#backupListTbody tr button', { hasText: 'Restore' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').textContent();
  assert(msg === restoreConfirmText(SINGLE[0].filename), `cenário 10: texto de confirmação exato (lido: "${msg}")`);
  assert(await page.locator('#confirmOkBtn').evaluate(el => el.classList.contains('btn-danger')), 'cenário 10: botão de confirmar é "danger" (danger:true no original)');
  await page.locator('#confirmOverlay button', { hasText: 'Cancel' }).click();
  await assertEventually(async () => !(await page.locator('#confirmOverlay').evaluate(el => el.classList.contains('show'))), 'cenário 10: Cancelar fecha a confirmação');
  await sleep(400);
  assert(state.calls.restorePost.length === 0, 'cenário 10: Cancelar não dispara nenhum POST de restore');
  assert(dialogs.length === 0, 'cenário 10: nenhum alert() após cancelar');
  assert((await bkModal(page).count()) === 1, 'cenário 10: o modal de backup continua aberto após cancelar');
});

// ── Cenário 11: Restore — Escape na confirmação -> nenhum POST ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState({ backups: SINGLE });
  await mockBackupApi(page, state);
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === 1, 'cenário 11: linha carregada');
  await m.locator('#backupListTbody tr button', { hasText: 'Restore' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.keyboard.press('Escape');
  await assertEventually(async () => !(await page.locator('#confirmOverlay').evaluate(el => el.classList.contains('show'))), 'cenário 11: Escape fecha a confirmação');
  await sleep(400);
  assert(state.calls.restorePost.length === 0 && dialogs.length === 0, 'cenário 11: Escape não dispara POST nem alert (equivale a cancelar)');
});

// ── Cenário 11b: clique no fundo da confirmação e ✕ também cancelam ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState({ backups: SINGLE });
  await mockBackupApi(page, state);
  page.on('dialog', d => d.accept());
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === 1, 'cenário 11b: linha carregada');
  await m.locator('#backupListTbody tr button', { hasText: 'Restore' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOverlay').click({ position: { x: 4, y: 4 } });
  await assertEventually(async () => !(await page.locator('#confirmOverlay').evaluate(el => el.classList.contains('show'))), 'cenário 11b: clique no fundo fecha a confirmação');
  await m.locator('#backupListTbody tr button', { hasText: 'Restore' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOverlay .modal-close').click();
  await assertEventually(async () => !(await page.locator('#confirmOverlay').evaluate(el => el.classList.contains('show'))), 'cenário 11b: ✕ da confirmação fecha');
  await sleep(300);
  assert(state.calls.restorePost.length === 0, 'cenário 11b: nenhum POST em ambos os cancelamentos');
});

// ── Cenário 12: Restore — confirmar -> POST codificado, alert com a message do servidor, depois RELOAD ──
await withPage(browser, async page => {
  const counters = await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const fn = "it's a b#c.dump";
  const state = makeBackupState({ backups: [{ filename: fn, createdAt: '2026-03-05T14:30:00Z', sizeBytes: 500 }] });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === 1, 'cenário 12: linha carregada');

  const events = [];
  const dialogs = [];
  page.on('dialog', d => { events.push('dialog'); dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.on('load', () => events.push('load'));
  await page.evaluate(() => { window.__t45marker = 'alive'; });
  const meBefore = counters.me;

  await m.locator('#backupListTbody tr button', { hasText: 'Restore' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  assert((await page.locator('#confirmMessage').textContent()) === restoreConfirmText(fn), 'cenário 12: confirmação inclui o filename (com apóstrofo/#/espaço) entre aspas');
  assert(state.calls.restorePost.length === 0, 'cenário 12: nada é enviado antes de confirmar');
  await page.locator('#confirmOkBtn').click();

  await assertEventually(() => state.calls.restorePost.length === 1, 'cenário 12: POST de restore disparado após confirmar');
  assert(state.calls.restorePost[0].method === 'POST' && state.calls.restorePost[0].pathname === `/api/backups/${encodeURIComponent(fn)}/restore`, `cenário 12: POST /api/backups/<filename codificado>/restore (lido: ${state.calls.restorePost[0].pathname})`);
  await assertEventually(() => dialogs.length === 1, 'cenário 12: um alert() é exibido');
  assert(dialogs[0].type === 'alert', 'cenário 12: o diálogo é do tipo alert (não confirm)');
  assert(dialogs[0].message === 'Restore complete. Reload the page to see the restored data.', `cenário 12: alert mostra a message do servidor (lido: "${dialogs[0].message}")`);
  await assertEventually(async () => (await page.evaluate(() => window.__t45marker === 'alive')) === false, 'cenário 12: a página RECARREGA depois do alert (marcador em window sumiu)', 6000);
  await assertEventually(() => events.includes('load'), 'cenário 12: o evento "load" da nova navegação dispara', 6000);
  assert(events[0] === 'dialog' && events.indexOf('load') > events.indexOf('dialog'), `cenário 12: ordem alert -> reload (eventos: ${JSON.stringify(events)})`);
  await assertEventually(() => counters.me > meBefore, 'cenário 12: o reload refaz GET /api/me');
});

// ── Cenário 13: Restore — resposta sem message -> 'Restore complete.' + reload ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState({ backups: SINGLE });
  state.restoreBody = { ok: true };
  await mockBackupApi(page, state);
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === 1, 'cenário 13: linha carregada');
  await page.evaluate(() => { window.__t45marker = 'alive'; });
  await m.locator('#backupListTbody tr button', { hasText: 'Restore' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(() => dialogs.length === 1, 'cenário 13: alert exibido');
  assert(dialogs[0] === 'Restore complete.', `cenário 13: sem message no servidor -> "Restore complete." (lido: "${dialogs[0]}")`);
  await assertEventually(async () => (await page.evaluate(() => window.__t45marker === 'alive')) === false, 'cenário 13: a página recarrega também neste caso', 6000);
});

// ── Cenário 14: Restore — falha (500) -> alert fixo e SEM reload ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeBackupState({ backups: SINGLE });
  state.restoreStatus = 500;
  await mockBackupApi(page, state);
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === 1, 'cenário 14: linha carregada');
  await page.evaluate(() => { window.__t45marker = 'alive'; });
  await m.locator('#backupListTbody tr button', { hasText: 'Restore' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(() => dialogs.length === 1, 'cenário 14: alert exibido na falha');
  assert(dialogs[0] === 'Restore failed. Please try again.', `cenário 14: texto fixo "Restore failed. Please try again." (lido: "${dialogs[0]}")`);
  await sleep(1200);
  assert((await page.evaluate(() => window.__t45marker === 'alive')) === true, 'cenário 14: SEM reload após falha (marcador em window preservado)');
  assert(dialogs.length === 1, 'cenário 14: só um alert (nenhum alert de sucesso)');
  assert((await bkModal(page).count()) === 1, 'cenário 14: o modal de backup continua aberto após a falha');
});

// ════════════════════════════════════════════════
// C — AGENDAMENTO
// ════════════════════════════════════════════════

const sched = m => ({
  toggle: m.locator('#backupScheduleToggle'),
  options: m.locator('#backupScheduleOptions'),
  freqBtn: m.locator('#backupFreqDDBtn'),
  freqLabel: m.locator('#backupFreqLabel'),
  freqDD: m.locator('#backupFreqDD'),
  freqPanel: m.locator('#backupFreq'),
  weeklyRow: m.locator('#backupWeeklyRow'),
  weeklyBtns: m.locator('#backupWeeklyDays .seg-btn'),
  monthlyRow: m.locator('#backupMonthlyRow'),
  monthly: m.locator('#backupMonthlyDay'),
  time: m.locator('#backupScheduleTime'),
  save: m.locator('button', { hasText: 'Save schedule' }),
  status: m.locator('#backupScheduleStatus'),
});
const optionsStyle = loc => loc.evaluate(el => ({ opacity: getComputedStyle(el).opacity, pe: getComputedStyle(el).pointerEvents }));

// ── Cenário 15: GET popula toggle/frequência/dias/dia do mês/hora (enabled=true) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ schedule: { enabled: true, frequency: 'weekly', weeklyDays: [1, 3], monthlyDay: 15, time: '04:30' } });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(async () => (await s.toggle.evaluate(el => el.classList.contains('on'))) === true, 'cenário 15: toggle de enabled fica "on"');
  assert((await s.freqLabel.innerText()) === 'Weekly', 'cenário 15: rótulo de frequência = "Weekly"');
  assert(await s.weeklyRow.isVisible() && !(await s.monthlyRow.isVisible()), 'cenário 15: weekly mostra "Days of the week" e esconde "Day of the month"');
  const onDays = await s.weeklyBtns.evaluateAll(bs => bs.map(b => b.classList.contains('on')));
  assert(JSON.stringify(onDays) === JSON.stringify([false, true, false, true, false, false, false]), `cenário 15: dias marcados = Mon e Wed (lido: ${JSON.stringify(onDays)})`);
  assert((await s.monthly.inputValue()) === '15', 'cenário 15: dia do mês = 15');
  assert((await s.time.inputValue()) === '04:30', 'cenário 15: hora = 04:30');
  const st = await optionsStyle(s.options);
  assert(st.opacity === '1' && st.pe !== 'none', `cenário 15: enabled=true -> opacity 1 e pointer-events ativo (lido: ${JSON.stringify(st)})`);
  assert(await s.freqPanel.evaluate(el => el.querySelector('.seg-btn[data-val="weekly"]').classList.contains('on')), 'cenário 15: item "Weekly" marcado "on" no painel de frequência');
});

// ── Cenário 16: enabled=false -> opacity .45 + pointer-events none; defaults quando o GET vem vazio ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ schedule: { enabled: false, frequency: 'monthly', weeklyDays: [], monthlyDay: 7, time: '23:05' } });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(async () => (await s.time.inputValue()) === '23:05', 'cenário 16: GET aplicado (hora 23:05)');
  const st = await optionsStyle(s.options);
  assert(st.opacity === '0.45' && st.pe === 'none', `cenário 16: enabled=false -> opacity .45 e pointer-events none (lido: ${JSON.stringify(st)})`);
  assert(!(await s.toggle.evaluate(el => el.classList.contains('on'))), 'cenário 16: toggle sem "on"');
  assert((await s.freqLabel.innerText()) === 'Monthly' && (await s.monthlyRow.isVisible()) && (await s.monthly.inputValue()) === '7', 'cenário 16: Monthly com dia 7 visível');
  assert((await s.options.evaluate(el => el.style.opacity)) === '0.45', 'cenário 16: o estilo inline é opacity .45 (como style.opacity do original)');
});

await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState();
  state.schedule = {}; // GET devolve {} -> defaults do original
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(() => state.calls.scheduleGet === 1, 'cenário 16b: GET do agendamento disparado');
  await assertEventually(async () => (await s.time.inputValue()) === '02:00', 'cenário 16b: GET vazio -> hora default 02:00');
  assert((await s.freqLabel.innerText()) === 'Daily', 'cenário 16b: GET vazio -> frequência "Daily"');
  assert((await s.monthly.inputValue()) === '1', 'cenário 16b: GET vazio -> dia do mês 1');
  assert(!(await s.weeklyRow.isVisible()) && !(await s.monthlyRow.isVisible()), 'cenário 16b: Daily esconde as linhas de dias da semana e dia do mês');
  assert(!(await s.toggle.evaluate(el => el.classList.contains('on'))), 'cenário 16b: GET vazio -> desabilitado');
});

await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState();
  state.scheduleStatus = 500;
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(() => state.calls.scheduleGet === 1, 'cenário 16c: GET do agendamento disparado (500)');
  await sleep(300);
  assert((await s.time.inputValue()) === '02:00' && (await s.freqLabel.innerText()) === 'Daily' && (await optionsStyle(s.options)).opacity === '0.45', 'cenário 16c: falha no GET mantém os defaults (02:00, Daily, desabilitado) — sem quebrar o modal');
});

// ── Cenário 17: dropdown de frequência abre/fecha de 4 formas e o rótulo muda ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ schedule: { enabled: true } });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(async () => (await s.toggle.evaluate(el => el.classList.contains('on'))) === true, 'cenário 17: agendamento habilitado carregado');

  assert(!(await s.freqPanel.isVisible()), 'cenário 17: painel começa fechado');
  await s.freqBtn.click();
  await assertEventually(async () => await s.freqPanel.isVisible(), 'cenário 17: clicar no botão abre o painel');
  assert(await s.freqDD.evaluate(el => el.classList.contains('open')), 'cenário 17: .dd recebe a classe "open"');
  assert((await s.freqPanel.locator('.seg-btn').allInnerTexts()).join(',') === 'Daily,Weekly,Monthly', 'cenário 17: itens do painel: Daily, Weekly, Monthly');
  await s.freqBtn.click();
  await assertEventually(async () => !(await s.freqPanel.isVisible()), 'cenário 17: clicar no botão de novo fecha (toggle)');

  await s.freqBtn.click();
  await s.freqPanel.waitFor({ state: 'visible' });
  await s.freqPanel.locator('button', { hasText: 'Close' }).click();
  await assertEventually(async () => !(await s.freqPanel.isVisible()), 'cenário 17: botão "Close" do painel fecha');

  await s.freqBtn.click();
  await s.freqPanel.waitFor({ state: 'visible' });
  await s.freqPanel.locator('.seg-btn[data-val="weekly"]').click();
  await assertEventually(async () => !(await s.freqPanel.isVisible()), 'cenário 17: escolher um item fecha o painel');
  assert((await s.freqLabel.innerText()) === 'Weekly', 'cenário 17: rótulo muda para "Weekly" ao escolher o item');

  await s.freqBtn.click();
  await s.freqPanel.waitFor({ state: 'visible' });
  await m.locator('.modal-title').click();
  await assertEventually(async () => !(await s.freqPanel.isVisible()), 'cenário 17: clicar fora do dropdown fecha o painel');
  assert((await s.freqLabel.innerText()) === 'Weekly', 'cenário 17: clicar fora não altera a frequência escolhida');
  assert((await bkModal(page).count()) === 1, 'cenário 17: clicar no título não fecha o modal');
});

// ── Cenário 18: Weekly mostra os 7 dias; Monthly mostra "Day of the month"; Daily esconde ambos ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ schedule: { enabled: true } });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(async () => (await s.toggle.evaluate(el => el.classList.contains('on'))) === true, 'cenário 18: carregado');

  async function pick(val) {
    await s.freqBtn.click();
    await s.freqPanel.waitFor({ state: 'visible' });
    await s.freqPanel.locator(`.seg-btn[data-val="${val}"]`).click();
  }
  await pick('weekly');
  await assertEventually(async () => await s.weeklyRow.isVisible(), 'cenário 18: Weekly mostra a linha "Days of the week"');
  assert((await s.weeklyRow.locator('.set-label').innerText()).toLowerCase() === 'days of the week', 'cenário 18: rótulo da linha = "Days of the week"');
  assert((await s.weeklyBtns.allInnerTexts()).join(',') === 'Sun,Mon,Tue,Wed,Thu,Fri,Sat', 'cenário 18: 7 botões Sun..Sat');
  assert((await s.weeklyBtns.evaluateAll(bs => bs.map(b => b.dataset.day)).then(a => a.join(','))) === '0,1,2,3,4,5,6', 'cenário 18: data-day 0..6');
  assert(!(await s.monthlyRow.isVisible()), 'cenário 18: Weekly esconde "Day of the month"');
  await pick('monthly');
  await assertEventually(async () => await s.monthlyRow.isVisible(), 'cenário 18: Monthly mostra "Day of the month"');
  assert((await s.monthlyRow.locator('.set-label').innerText()).toLowerCase() === 'day of the month', 'cenário 18: rótulo da linha = "Day of the month"');
  assert(!(await s.weeklyRow.isVisible()), 'cenário 18: Monthly esconde "Days of the week"');
  await pick('daily');
  await assertEventually(async () => !(await s.monthlyRow.isVisible()) && !(await s.weeklyRow.isVisible()), 'cenário 18: Daily esconde as duas linhas');
  assert((await s.freqLabel.innerText()) === 'Daily', 'cenário 18: rótulo "Daily"');
});

// ── Cenário 19: dias da semana preservam ORDEM DE CLIQUE; PUT com corpo exato; "Saving…"/"Schedule saved." ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ schedule: { enabled: true, frequency: 'daily', weeklyDays: [], monthlyDay: 1, time: '02:00' } });
  state.putGate = makeGate();
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(async () => (await s.toggle.evaluate(el => el.classList.contains('on'))) === true, 'cenário 19: carregado');
  await s.freqBtn.click();
  await s.freqPanel.locator('.seg-btn[data-val="weekly"]').click();
  await s.weeklyRow.waitFor({ state: 'visible' });

  const day = d => s.weeklyBtns.nth(d);
  await day(5).click(); // Fri
  await day(1).click(); // Mon
  await day(3).click(); // Wed
  await day(1).click(); // Mon (remove)
  await day(0).click(); // Sun
  const on = await s.weeklyBtns.evaluateAll(bs => bs.map(b => b.classList.contains('on')));
  assert(JSON.stringify(on) === JSON.stringify([true, false, false, true, false, true, false]), `cenário 19: marcação visual = Sun, Wed, Fri (lido: ${JSON.stringify(on)})`);

  await s.time.fill('06:15');
  await s.save.click();
  await assertEventually(async () => (await s.status.innerText()) === 'Saving…', 'cenário 19: status "Saving…" durante o PUT');
  await assertEventually(() => state.calls.schedulePut.length === 1, 'cenário 19: PUT /api/backup-schedule disparado');
  const body = state.calls.schedulePut[0];
  assert(JSON.stringify(body) === JSON.stringify({ enabled: true, frequency: 'weekly', weeklyDays: [5, 3, 0], monthlyDay: 1, time: '06:15' }), `cenário 19: corpo JSON exato, weeklyDays na ORDEM DE CLIQUE [5,3,0] (lido: ${JSON.stringify(body)})`);
  assert(state.calls.schedulePutMethods[0] === 'PUT' && state.calls.schedulePutHeaders[0].includes('application/json'), 'cenário 19: método PUT com Content-Type application/json');
  const g = state.putGate;
  state.putGate = null;
  g.open();
  await assertEventually(async () => (await s.status.innerText()) === 'Schedule saved.', 'cenário 19: status "Schedule saved." após o sucesso (204 sem corpo)');
  await page.screenshot({ path: `${SHOTS}/19-schedule-saved.png` });
});

// ── Cenário 20: corpo do PUT sem edições = o estado carregado, com a mesma ordem de chaves ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const loaded = { enabled: true, frequency: 'monthly', weeklyDays: [2, 6], monthlyDay: 15, time: '04:30' };
  const state = makeBackupState({ schedule: loaded });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(async () => (await s.time.inputValue()) === '04:30', 'cenário 20: carregado');
  await s.save.click();
  await assertEventually(() => state.calls.schedulePut.length === 1, 'cenário 20: PUT disparado');
  assert(JSON.stringify(state.calls.schedulePut[0]) === JSON.stringify(loaded), `cenário 20: sem edições, o PUT reenvia o estado carregado (weeklyDays [2,6] preservado mesmo em Monthly; lido: ${JSON.stringify(state.calls.schedulePut[0])})`);
  assert(Object.keys(state.calls.schedulePut[0]).join(',') === 'enabled,frequency,weeklyDays,monthlyDay,time', 'cenário 20: ordem de chaves enabled,frequency,weeklyDays,monthlyDay,time (JSON.stringify do estado do original)');
  await assertEventually(async () => (await s.status.innerText()) === 'Schedule saved.', 'cenário 20: "Schedule saved."');
});

// ── Cenário 21: clamp do dia do mês e hora vazia -> '02:00' (+ quirk: input não é reescrito até o toggle) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ schedule: { enabled: true, frequency: 'monthly', weeklyDays: [], monthlyDay: 10, time: '03:00' } });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(async () => (await s.monthly.inputValue()) === '10', 'cenário 21: carregado (monthlyDay 10)');

  async function saveWith(day, time) {
    await s.monthly.fill(day);
    if (time !== undefined) await s.time.fill(time);
    const n = state.calls.schedulePut.length;
    await s.save.click();
    await assertEventually(() => state.calls.schedulePut.length === n + 1, `cenário 21: PUT disparado (dia "${day}")`);
    return state.calls.schedulePut[n];
  }
  let b = await saveWith('40');
  assert(b.monthlyDay === 31, `cenário 21: dia 40 -> 31 (lido: ${b.monthlyDay})`);
  assert((await s.monthly.inputValue()) === '40', 'cenário 21: o input continua mostrando "40" após salvar (original só reescreve o input via _bkApplyScheduleUI)');
  b = await saveWith('0');
  assert(b.monthlyDay === 1, `cenário 21: dia 0 -> 1 (lido: ${b.monthlyDay})`);
  b = await saveWith('');
  assert(b.monthlyDay === 1, `cenário 21: dia vazio -> 1 (lido: ${b.monthlyDay})`);
  b = await saveWith('-5');
  assert(b.monthlyDay === 1, `cenário 21: dia negativo -> 1 (lido: ${b.monthlyDay})`);
  b = await saveWith('15.7');
  assert(b.monthlyDay === 15, `cenário 21: dia 15.7 -> 15 (parseInt; lido: ${b.monthlyDay})`);
  b = await saveWith('31');
  assert(b.monthlyDay === 31, `cenário 21: dia 31 permanece 31 (lido: ${b.monthlyDay})`);
  b = await saveWith('12', '');
  assert(b.time === '02:00' && b.monthlyDay === 12, `cenário 21: hora vazia -> "02:00" (lido: ${JSON.stringify(b)})`);
  assert((await s.time.inputValue()) === '', 'cenário 21: o input de hora continua vazio após salvar (não é reescrito)');
  // Toggle off/on reaplica o estado salvo (dia 12, hora 02:00) nos inputs.
  await s.toggle.click();
  await assertEventually(async () => (await s.time.inputValue()) === '02:00' && (await s.monthly.inputValue()) === '12', 'cenário 21: após o toggle os inputs refletem o último estado salvo (02:00 / 12)');
});

// ── Cenário 22: salvar com falha (500) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ schedule: { enabled: true } });
  state.putStatus = 500;
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(async () => (await s.toggle.evaluate(el => el.classList.contains('on'))) === true, 'cenário 22: carregado');
  await s.save.click();
  await assertEventually(async () => (await s.status.innerText()) === 'Failed to save. Please try again.', 'cenário 22: status "Failed to save. Please try again."');
  assert(state.calls.schedulePut.length === 1, 'cenário 22: o PUT foi tentado uma vez');
  // O usuário pode tentar de novo e ter sucesso.
  state.putStatus = 204;
  await s.save.click();
  await assertEventually(async () => (await s.status.innerText()) === 'Schedule saved.', 'cenário 22: tentar de novo após a falha mostra "Schedule saved."');
});

// ── Cenário 23: toggle de enabled reaplica o último estado nos inputs (quirk _bkApplyScheduleUI) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ schedule: { enabled: true, frequency: 'daily', weeklyDays: [], monthlyDay: 10, time: '03:00' } });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(async () => (await s.time.inputValue()) === '03:00', 'cenário 23: carregado (03:00, dia 10)');

  // Edita (sem salvar): dia 20, hora 05:00, frequência Monthly e dias Mon/Fri.
  await s.freqBtn.click();
  await s.freqPanel.locator('.seg-btn[data-val="monthly"]').click();
  await s.monthly.fill('20');
  await s.time.fill('05:00');
  assert((await s.monthly.inputValue()) === '20' && (await s.time.inputValue()) === '05:00', 'cenário 23: edições pendentes presentes nos inputs');

  await s.toggle.click(); // desabilita
  await assertEventually(async () => (await s.time.inputValue()) === '03:00' && (await s.monthly.inputValue()) === '10', 'cenário 23: alternar o toggle REAPLICA o último estado salvo (03:00 / 10) e descarta as edições pendentes');
  const off = await optionsStyle(s.options);
  assert(off.opacity === '0.45' && off.pe === 'none' && !(await s.toggle.evaluate(el => el.classList.contains('on'))), `cenário 23: desabilitar -> opacity .45, pointer-events none, toggle sem "on" (lido: ${JSON.stringify(off)})`);
  assert((await s.freqLabel.innerText()) === 'Monthly', 'cenário 23: a frequência (estado, não input) NÃO é revertida pelo toggle');
  await s.toggle.click(); // reabilita
  await assertEventually(async () => (await optionsStyle(s.options)).opacity === '1', 'cenário 23: reabilitar -> opacity 1');
  assert((await optionsStyle(s.options)).pe !== 'none', 'cenário 23: reabilitar -> pointer-events volta');
  await s.save.click();
  await assertEventually(() => state.calls.schedulePut.length === 1, 'cenário 23: PUT após o ciclo de toggles');
  assert(state.calls.schedulePut[0].enabled === true && state.calls.schedulePut[0].monthlyDay === 10 && state.calls.schedulePut[0].time === '03:00' && state.calls.schedulePut[0].frequency === 'monthly', `cenário 23: PUT usa o estado reaplicado + frequência escolhida (lido: ${JSON.stringify(state.calls.schedulePut[0])})`);
});

// ── Cenário 24: com o agendamento desabilitado, "Save schedule" é inalcançável (pointer-events none) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ schedule: { enabled: false } });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  const s = sched(m);
  await assertEventually(() => state.calls.scheduleGet === 1, 'cenário 24: carregado');
  await sleep(200);
  const hit = await s.save.evaluate(btn => {
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === btn || btn.contains(top);
  });
  assert(hit === false, 'cenário 24: com enabled=false o botão "Save schedule" não recebe cliques (pointer-events: none no bloco de opções)');
  await s.toggle.click();
  await assertEventually(async () => (await optionsStyle(s.options)).opacity === '1', 'cenário 24: o toggle (fora do bloco de opções) continua clicável e habilita o bloco');
});

// ════════════════════════════════════════════════
// D — AUDIT LOG
// ════════════════════════════════════════════════

// ── Cenário 25: abertura, "Loading…", título e colunas ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ audit: [{ id: 1, ts: '2026-03-05 14:30:00', username: 'alice', action: 'create', entity_type: 'command', entity_name: 'ping', details: 'ok' }] });
  state.auditGate = makeGate();
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  await assertEventually(async () => (await dbPane(page).locator('button', { hasText: 'View audit log' }).count()) === 1, 'cenário 25: botão disponível');
  const m = await openAuditModal(page);
  assert((await m.locator('.modal-title').innerText()).trim() === 'Audit log', 'cenário 25: título "Audit log"');
  await assertEventually(() => state.calls.auditGet === 1, 'cenário 25: GET /api/audit-log disparado ao abrir');
  await assertEventually(async () => (await m.locator('#auditLogTbody').textContent()).trim() === 'Loading…', 'cenário 25: tbody mostra "Loading…" enquanto carrega');
  assert(!(await m.locator('#auditLogEmpty').isVisible()), 'cenário 25: texto de vazio oculto durante o carregamento');
  const heads = (await m.locator('thead th').allTextContents()).map(t => t.trim());
  assert(heads.join('|') === 'Date/Time|User|Action|Type|Item|Details', `cenário 25: colunas Date/Time|User|Action|Type|Item|Details (lido: ${heads.join('|')})`);
  assert((await m.locator('.set-hint').first().innerText()).includes('entries older than 30 days are removed automatically'), 'cenário 25: dica sobre retenção de 30 dias presente');
  const g = state.auditGate;
  state.auditGate = null;
  g.open();
  await assertEventually(async () => (await m.locator('#auditLogTbody tr').count()) === 1 && !(await m.locator('#auditLogTbody').textContent()).includes('Loading'), 'cenário 25: "Loading…" some quando os dados chegam');
  assert(state.calls.scheduleGet === 0 && state.calls.listGet === 0, 'cenário 25: abrir o audit log não toca nos endpoints de backup');
});

// ── Cenário 26: formatação de data, pill de ação, User/Details vazios ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const audit = [
    { id: 1, ts: '2026-03-05 14:30:00', username: 'alice', action: 'create', entity_type: 'command', entity_name: 'ping', details: 'created in X' },
    { id: 2, ts: '2026-03-05T15:45:00Z', username: 'bob', action: 'update', entity_type: 'folder', entity_name: 'Net', details: 'renamed' },
    { id: 3, ts: '2026-03-05T16:30:00+02:00', username: null, action: 'delete', entity_type: 'api_key', entity_name: 'k1', details: '' },
    { id: 4, ts: '2026-12-31 23:59:59', username: '', action: 'purge', entity_type: 'note', entity_name: 'n', details: null },
    { id: 5, ts: '2026-01-02 03:04:05', username: 'zed', action: null, entity_type: 'user', entity_name: 'u', details: 'd' },
  ];
  const state = makeBackupState({ audit });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openAuditModal(page);
  await assertEventually(async () => (await m.locator('#auditLogTbody tr').count()) === 5, 'cenário 26: 5 linhas renderizadas');
  const rows = await tableRows(m.locator('#auditLogTbody'));
  assert(rows[0][0] === '05/03/2026 14:30', `cenário 26: ts sem fuso (SQLite-like) tratado como UTC -> "05/03/2026 14:30" (lido: "${rows[0][0]}")`);
  assert(rows[1][0] === '05/03/2026 15:45', `cenário 26: ts ISO com Z (lido: "${rows[1][0]}")`);
  assert(rows[2][0] === '05/03/2026 14:30', `cenário 26: ts com offset +02:00 convertido (lido: "${rows[2][0]}")`);
  assert(rows[3][0] === '31/12/2026 23:59', `cenário 26: 31/12/2026 23:59 (lido: "${rows[3][0]}")`);
  assert(rows[4][0] === '02/01/2026 03:04', `cenário 26: padStart de dia/mês/hora/minuto (lido: "${rows[4][0]}")`);
  assert(rows[0][1] === 'alice' && rows[1][1] === 'bob', 'cenário 26: coluna User mostra o username');
  assert(rows[2][1] === '—' && rows[3][1] === '—', 'cenário 26: username nulo/vazio -> "—"');
  assert(rows[0][5] === 'created in X' && rows[1][5] === 'renamed', 'cenário 26: coluna Details mostra details');
  assert(rows[2][5] === '—' && rows[3][5] === '—', 'cenário 26: details vazio/nulo -> "—"');

  const pills = await m.locator('#auditLogTbody tr td:nth-child(3) .audit-action-pill').evaluateAll(ps => ps.map(p => ({ text: p.textContent.trim(), cls: [...p.classList].filter(c => c.startsWith('audit-action-') && c !== 'audit-action-pill').join(' ') })));
  assert(pills[0].text === 'Created' && pills[0].cls === 'audit-action-create', `cenário 26: create -> pill "Created" classe audit-action-create (lido: ${JSON.stringify(pills[0])})`);
  assert(pills[1].text === 'Updated' && pills[1].cls === 'audit-action-update', `cenário 26: update -> "Updated" / audit-action-update (lido: ${JSON.stringify(pills[1])})`);
  assert(pills[2].text === 'Deleted' && pills[2].cls === 'audit-action-delete', `cenário 26: delete -> "Deleted" / audit-action-delete (lido: ${JSON.stringify(pills[2])})`);
  assert(pills[3].text === 'purge' && pills[3].cls === 'audit-action-purge', `cenário 26: ação desconhecida -> o próprio valor, classe audit-action-<valor> (lido: ${JSON.stringify(pills[3])})`);
  assert(pills[4].text === '—', `cenário 26: ação nula -> "—" (lido: "${pills[4].text}")`);
  const pillBg = await m.locator('#auditLogTbody tr').nth(0).locator('.audit-action-pill').evaluate(p => getComputedStyle(p).backgroundColor);
  assert(pillBg !== 'rgba(0, 0, 0, 0)', `cenário 26: o pill "create" recebe o fundo do CSS audit-action-create (lido: ${pillBg})`);
  await page.screenshot({ path: `${SHOTS}/26-audit-rows.png` });
});

// ── Cenário 27: mapa de rótulos do Type + fallbacks (null -> Command, desconhecido -> o valor) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const typeMap = {
    command: 'Command', folder: 'Folder', note: 'Note', vendor: 'Vendor', system: 'System', version: 'Version',
    environment: 'Environment', topic: 'Topic', parameter: 'Parameter', prompt: 'Prompt', export: 'Export', user: 'User', api_key: 'API key',
  };
  const audit = Object.keys(typeMap).map((k, i) => ({ id: i + 1, ts: '2026-03-05 14:30:00', username: 'u', action: 'create', entity_type: k, entity_name: `n-${k}`, details: 'd' }));
  audit.push({ id: 100, ts: '2026-03-05 14:30:00', username: 'u', action: 'create', entity_type: null, entity_name: 'null-type', details: 'd' });
  audit.push({ id: 101, ts: '2026-03-05 14:30:00', username: 'u', action: 'create', entity_type: 'widget', entity_name: 'unk-type', details: 'd' });
  audit.push({ id: 102, ts: '2026-03-05 14:30:00', username: 'u', action: 'create', entity_type: '', entity_name: 'empty-type', details: 'd' });
  const state = makeBackupState({ audit });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openAuditModal(page);
  await assertEventually(async () => (await m.locator('#auditLogTbody tr').count()) === audit.length, 'cenário 27: todas as linhas renderizadas');
  const rows = await tableRows(m.locator('#auditLogTbody'));
  for (const [k, label] of Object.entries(typeMap)) {
    const row = rows.find(r => r[4] === `n-${k}`);
    assert(row && row[3] === label, `cenário 27: entity_type "${k}" -> "${label}" (lido: "${row && row[3]}")`);
  }
  assert(rows.find(r => r[4] === 'null-type')[3] === 'Command', 'cenário 27: entity_type nulo -> "Command"');
  assert(rows.find(r => r[4] === 'empty-type')[3] === 'Command', 'cenário 27: entity_type "" -> "Command"');
  assert(rows.find(r => r[4] === 'unk-type')[3] === 'widget', 'cenário 27: entity_type desconhecido -> o próprio valor ("widget")');
});

// ── Cenário 28: Item = entity_name || command_name || entity_id || command_id || '—' ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const base = { ts: '2026-03-05 14:30:00', username: 'u', action: 'update', entity_type: 'command', details: 'd' };
  const audit = [
    { ...base, id: 1, entity_name: 'EN', command_name: 'CN', entity_id: 'EI', command_id: 'CI' },
    { ...base, id: 2, entity_name: null, command_name: 'CN', entity_id: 'EI', command_id: 'CI' },
    { ...base, id: 3, entity_name: '', command_name: null, entity_id: 'EI', command_id: 'CI' },
    { ...base, id: 4, entity_name: null, command_name: '', entity_id: null, command_id: 'CI' },
    { ...base, id: 5, entity_name: null, command_name: null, entity_id: null, command_id: null },
    { ...base, id: 6, entity_name: null, command_name: null, entity_id: 42, command_id: 7 },
    { ...base, id: 7, entity_name: null, command_name: null, entity_id: null, command_id: 99 },
  ];
  const state = makeBackupState({ audit });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openAuditModal(page);
  await assertEventually(async () => (await m.locator('#auditLogTbody tr').count()) === 7, 'cenário 28: 7 linhas renderizadas');
  const items = (await tableRows(m.locator('#auditLogTbody'))).map(r => r[4]);
  assert(items[0] === 'EN', `cenário 28: entity_name tem prioridade (lido: "${items[0]}")`);
  assert(items[1] === 'CN', `cenário 28: sem entity_name -> command_name (lido: "${items[1]}")`);
  assert(items[2] === 'EI', `cenário 28: sem nomes -> entity_id (lido: "${items[2]}")`);
  assert(items[3] === 'CI', `cenário 28: só command_id -> command_id (lido: "${items[3]}")`);
  assert(items[4] === '—', `cenário 28: tudo nulo -> "—" (lido: "${items[4]}")`);
  assert(items[5] === '42', `cenário 28: entity_id numérico 42 -> "42" (lido: "${items[5]}")`);
  assert(items[6] === '99', `cenário 28: command_id numérico 99 -> "99" (lido: "${items[6]}")`);
});

// ── Cenário 29: texto escapado (HTML vira TEXTO, sem criar elementos) — audit log e lista de backups ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const audit = [
    { id: 1, ts: '2026-03-05 14:30:00', username: '<b>x</b>', action: 'create', entity_type: 'command', entity_name: '<img src=x onerror="window.__pwned=1">', details: '<script>window.__pwned=1</script> &amp; "q"' },
  ];
  const backups = [{ filename: '<i>evil</i>.dump', createdAt: '2026-03-05T14:30:00Z', sizeBytes: 5 }];
  const state = makeBackupState({ audit, backups });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const am = await openAuditModal(page);
  await assertEventually(async () => (await am.locator('#auditLogTbody tr').count()) === 1, 'cenário 29: linha do audit carregada');
  const cells = (await tableRows(am.locator('#auditLogTbody')))[0];
  assert(cells[1] === '<b>x</b>', `cenário 29: username "<b>x</b>" aparece como TEXTO (lido: "${cells[1]}")`);
  assert((await am.locator('#auditLogTbody b').count()) === 0, 'cenário 29: nenhum elemento <b> foi criado no audit log');
  assert((await am.locator('#auditLogTbody img').count()) === 0, 'cenário 29: nenhum elemento <img> foi criado (entity_name)');
  assert(cells[4] === '<img src=x onerror="window.__pwned=1">', 'cenário 29: entity_name com <img onerror> aparece como texto');
  assert(cells[5] === '<script>window.__pwned=1</script> &amp; "q"', `cenário 29: details com <script> e "&amp;" literal aparece como texto exato, sem decodificar a entidade (lido: "${cells[5]}")`);
  assert((await page.evaluate(() => window.__pwned)) === undefined, 'cenário 29: nenhum script/handler injetado foi executado');
  await am.locator('.modal-close').click();
  await assertEventually(async () => (await auditModal(page).count()) === 0, 'cenário 29: audit fecha');

  const bm = await openBackupModal(page);
  await assertEventually(async () => (await bm.locator('#backupListTbody tr').count()) === 1, 'cenário 29: linha do backup carregada');
  assert((await tableRows(bm.locator('#backupListTbody')))[0][0] === '<i>evil</i>.dump', 'cenário 29: filename com HTML aparece como texto na lista de backups');
  assert((await bm.locator('#backupListTbody i').count()) === 0, 'cenário 29: nenhum elemento <i> criado na lista de backups');
});

// ── Cenário 30: audit log vazio / falha ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ audit: [] });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openAuditModal(page);
  await assertEventually(async () => await m.locator('#auditLogEmpty').isVisible(), 'cenário 30: texto de vazio visível');
  assert((await m.locator('#auditLogEmpty').innerText()).trim() === 'No audit log entries in the last 30 days.', 'cenário 30: texto exato "No audit log entries in the last 30 days."');
  assert((await m.locator('#auditLogTbody tr').count()) === 0, 'cenário 30: tbody sem linhas');
});

await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ audit: [{ id: 1, ts: '2026-03-05 14:30:00', username: 'a', action: 'create', entity_type: 'command', entity_name: 'x', details: 'd' }] });
  state.auditStatus = 500;
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openAuditModal(page);
  await assertEventually(async () => (await m.locator('#auditLogTbody').textContent()).trim() === 'Failed to load the audit log. Please try again.', 'cenário 30b: falha -> "Failed to load the audit log. Please try again."');
  assert(!(await m.locator('#auditLogEmpty').isVisible()), 'cenário 30b: texto de vazio NÃO aparece na falha');
  // Reabrir recarrega (cada abertura refaz o GET).
  await m.locator('.modal-close').click();
  await assertEventually(async () => (await auditModal(page).count()) === 0, 'cenário 30b: modal fecha');
  state.auditStatus = 200;
  const m2 = await openAuditModal(page);
  await assertEventually(async () => (await m2.locator('#auditLogTbody tr').count()) === 1 && (await m2.locator('#auditLogTbody').textContent()).includes('x'), 'cenário 30b: reabrir refaz o GET e mostra os dados (recupera da falha)');
  assert(state.calls.auditGet === 2, 'cenário 30b: GET /api/audit-log chamado 2 vezes (uma por abertura)');
});

// ════════════════════════════════════════════════
// E — FECHAMENTO DOS DOIS MODAIS
// ════════════════════════════════════════════════

const closers = {
  '✕': async (page, modal, overlay) => modal.locator('.modal-close').click(),
  'botão Close': async (page, modal, overlay) => modal.locator('.modal-foot button', { hasText: 'Close' }).click(),
  'clique no fundo': async (page, modal, overlay) => overlay.click({ position: { x: 4, y: 4 } }),
  Escape: async (page) => page.keyboard.press('Escape'),
};

for (const kind of ['backup', 'audit']) {
  for (const [name, closeFn] of Object.entries(closers)) {
    await withPage(browser, async page => {
      await mockBase(page, { isAdmin: true });
      const state = makeBackupState({ backups: SINGLE, audit: [{ id: 1, ts: '2026-03-05 14:30:00', username: 'a', action: 'create', entity_type: 'command', entity_name: 'x', details: 'd' }] });
      await mockBackupApi(page, state);
      await goToApp(page);
      await openDatabasePane(page);
      const open = kind === 'backup' ? openBackupModal : openAuditModal;
      const getModal = kind === 'backup' ? bkModal : auditModal;
      const getOverlay = kind === 'backup' ? bkOverlay : auditOverlay;
      const label = `cenário 31 (${kind}/${name})`;
      const m = await open(page);
      await m.waitFor();
      // Clique DENTRO da caixa não fecha (só no fundo).
      await m.locator('.modal-title').click();
      assert((await getModal(page).count()) === 1, `${label}: clique dentro da caixa do modal não fecha`);
      await closeFn(page, m, getOverlay(page));
      await assertEventually(async () => (await getModal(page).count()) === 0, `${label}: o modal fecha`);
      assert((await page.locator('.modal-overlay.show .modal-title', { hasText: kind === 'backup' ? 'Database backup' : 'Audit log' }).count()) === 0, `${label}: nenhum overlay "show" remanescente com o título do modal`);
    });
  }
}

// ── Cenário 32: depois de fechar, reabrir faz um novo carregamento ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeBackupState({ backups: SINGLE, audit: [] });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  let m = await openBackupModal(page);
  await assertEventually(() => state.calls.listGet === 1, 'cenário 32: 1º GET /api/backups');
  await m.locator('.modal-close').click();
  await assertEventually(async () => (await bkModal(page).count()) === 0, 'cenário 32: fecha');
  m = await openBackupModal(page);
  await assertEventually(() => state.calls.listGet === 2 && state.calls.scheduleGet === 2, 'cenário 32: reabrir faz um novo GET /api/backups e /api/backup-schedule');
});

// ════════════════════════════════════════════════
// F — ADMIN-ONLY EM PROFUNDIDADE
// ════════════════════════════════════════════════

// ── Cenário 33: usuário comum com a aba Database aberta: nenhum modal de backup/audit no DOM e nenhum request ──
await withPage(browser, async page => {
  const counters = await mockBase(page, { isAdmin: false });
  const state = makeBackupState({ backups: SAMPLE_BACKUPS, audit: [{ id: 1, ts: '2026-03-05 14:30:00', username: 'a', action: 'create', entity_type: 'command', entity_name: 'x', details: 'd' }] });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  await page.waitForSelector('.settings-content .set-group');
  await sleep(500);
  assert((await bkModal(page).count()) === 0, 'cenário 33: nenhum modal "Database backup" no DOM para usuário comum');
  assert((await auditModal(page).count()) === 0, 'cenário 33: nenhum modal "Audit log" no DOM para usuário comum');
  assert((await page.locator('#backupListTbody, #auditLogTbody, #backupNowBtn, #backupScheduleToggle').count()) === 0, 'cenário 33: nenhum elemento interno dos modais (tbody/botões/toggle) no DOM');
  await page.keyboard.press('Escape');
  await sleep(200);
  assert(counters.backupishRequests.length === 0, `cenário 33: nenhum request a /api/backups*, /api/backup-schedule ou /api/audit-log (lido: ${JSON.stringify(counters.backupishRequests)})`);
  assert(state.calls.listGet === 0 && state.calls.auditGet === 0 && state.calls.scheduleGet === 0, 'cenário 33: contadores dos mocks permanecem zerados');
});

// ── Cenário 34: o cargo é decidido por /api/me (sem cache de admin): usuário comum em contexto novo continua sem o grupo ──
await withPage(browser, async page => {
  const counters = await mockBase(page, { isAdmin: false });
  const state = makeBackupState();
  await mockBackupApi(page, state);
  // Simula um estado "residual" de uma sessão admin anterior no localStorage.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cpa-is-admin', '1');
      localStorage.setItem('cpa-admin', '1');
      localStorage.setItem('cpa-settings', JSON.stringify({ isAdmin: true, adminMode: true }));
    } catch {}
  });
  await goToApp(page);
  await openDatabasePane(page);
  await sleep(400);
  assert((await dbPane(page).locator('button', { hasText: 'Backup & Restore' }).count()) === 0 && (await dbPane(page).locator('button', { hasText: 'View audit log' }).count()) === 0, 'cenário 34: flags de admin residuais no localStorage NÃO liberam os botões (gate vem de /api/me)');
  assert(counters.backupishRequests.length === 0, 'cenário 34: nenhum request admin-only disparado');
});

// ── Cenário 35 (auditoria de segurança, item 8): admin COMUM não vê Download/Restore ──
// O backend responde 403 a esses endpoints para o admin comum; a UI não
// deve oferecer os controles (o resto — listar, Backup now — continua).
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: false });
  const state = makeBackupState({ backups: SAMPLE_BACKUPS });
  await mockBackupApi(page, state);
  await goToApp(page);
  await openDatabasePane(page);
  const m = await openBackupModal(page);
  await assertEventually(async () => (await m.locator('#backupListTbody tr').count()) === SAMPLE_BACKUPS.length, 'cenário 35: admin comum vê a lista de backups');
  assert((await m.locator('#backupListTbody tr button', { hasText: 'Restore' }).count()) === 0, 'cenário 35: admin comum NÃO vê botão Restore');
  assert((await m.locator('#backupListTbody tr a').count()) === 0, 'cenário 35: admin comum NÃO vê link Download');
  assert((await m.locator('button', { hasText: 'Backup now' }).count()) === 1, 'cenário 35: admin comum continua vendo "Backup now"');
});

await browser.close();

console.log(`\n${asserts} asserts executados`);
console.log(`${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} ASSERT(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
