// Suíte de validação manual (Playwright) da Fase 3, fatia 7 (Users +
// Catalog admin/"Register") — mesmo padrão de mocking de /api/* usado em
// test/fatia6.spec.mjs (route() por endpoint, sem backend real rodando;
// fixtures em memória mutáveis com contadores `calls` pra verificar quantas
// vezes um endpoint foi chamado; helpers assert/withPage/assertEventually
// idênticos). Cobre dois domínios:
//
//   A. Users (aba "Users", super_admin-only, ver UsersPane.tsx) — CRUD de
//      usuários locais + promover/rebaixar/habilitar-desabilitar/excluir
//      QUALQUER usuário, conta protegida "admin" sem select/Disable/Delete.
//
//   B. Catalog admin / "Register" (aba "Register", admin-rank — admin OU
//      super_admin, ver CatalogPane.tsx/CatalogAdminModal.tsx) — as 8
//      janelas de catálogo compartilhado (Vendors/Systems/Versions/
//      Environments/Topics/Parameters/Prompts/Exports), busca client-side +
//      edição inline com dirty-tracking (Cancel/Save changes) + "+ Add" +
//      delete com confirmação, e o refresh de /api/catalogs que mantém a
//      sidebar/editor de comando sincronizados depois de qualquer mutação.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/fase3-fatia7-shots';
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function assert(cond, msg) {
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
    if (await fn()) {
      assert(true, msg);
      return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert(false, msg);
}

async function withPage(browser, fn) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}

// ════════════════════════════════════════════════
// FIXTURES / MOCKS BASE
// ════════════════════════════════════════════════

const EMPTY_CATALOGS = { vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [] };

// Mocka só o necessário pro AppShell montar sem travar (fetchCatalogs/
// fetchCommands/fetchFolders chamados no mount) — mesmo padrão de
// mockBase() em test/fatia6.spec.mjs. `catalogsJson` é estático aqui; os
// cenários do domínio B sobrescrevem a rota de /api/catalogs chamando
// mockCatalogAdmin() DEPOIS desta função (Playwright invoca o route()
// registrado por último primeiro quando mais de um bate no mesmo padrão).
async function mockBase(page, { isAdmin = false, isSuperAdmin = false, meOverrides = {}, catalogsJson = EMPTY_CATALOGS } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
  });
  await page.route('**/api/me', route =>
    route.fulfill({
      json: {
        username: 'tester', upn: 'tester', handle: 'tester',
        role: isSuperAdmin ? 'super_admin' : isAdmin ? 'admin' : 'user',
        isAdmin, isSuperAdmin, authMethod: 'local',
        ...meOverrides,
      },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: catalogsJson }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
  await page.route('**/api/commands', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  await page.route('**/api/folders', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
}

async function goToApp(page) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle[title="Settings"]');
}

async function openSettings(page) {
  await page.click('.theme-toggle[title="Settings"]');
  await page.waitForSelector('.settings-modal-box');
}

async function openUsersPane(page) {
  await openSettings(page);
  await page.locator('.settings-nav-btn', { hasText: 'Users' }).click();
  await page.waitForSelector('.settings-pane[data-pane="users"]');
}

async function openCatalogPane(page) {
  await openSettings(page);
  await page.locator('.settings-nav-btn', { hasText: 'Register' }).click();
  await page.waitForSelector('.settings-pane[data-pane="catalog"]');
}

async function openCatalogModal(page, tileLabel) {
  await openCatalogPane(page);
  await page.locator('.settings-tile', { hasText: tileLabel }).click();
  await page.waitForSelector('.modal-overlay.show .modal-wide');
}

function catalogModal(page, titleSubstr) {
  return page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: titleSubstr }) });
}

// Encontra a linha existente (dentro de .list-editor) cujo campo de label
// (sempre um <input class="set-input">, nunca um <select>) tem o valor
// dado — lido via inputValue() (propriedade .value do DOM), não via
// seletor CSS [value=...] (React não mantém o atributo HTML sincronizado
// em inputs controlados, só a propriedade).
async function catRowByLabel(modal, labelValue) {
  const rows = modal.locator('.list-editor .cat-row');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const val = await rows.nth(i).locator('input.set-input').first().inputValue();
    if (val === labelValue) return rows.nth(i);
  }
  throw new Error(`catRowByLabel: nenhuma linha com label "${labelValue}" encontrada (${count} linhas)`);
}

// A linha "+ Add" é o único .cat-row FILHO DIRETO de .cat-panel — as linhas
// existentes moram dentro de .list-editor (um nível a mais), então o
// combinador ">" isola a linha de adição sem precisar de texto/posição.
function addRow(modal) {
  return modal.locator('.cat-panel > .cat-row');
}
function searchInput(modal) {
  return modal.locator('.cat-panel > input[type="text"]');
}
function cancelBtn(modal) {
  return modal.locator('.modal-foot button', { hasText: 'Cancel' });
}
function saveBtn(modal) {
  return modal.locator('.modal-foot button', { hasText: 'Save changes' });
}
function adminMsg(modal) {
  return modal.locator('.cat-admin-msg');
}

// ════════════════════════════════════════════════
// CATALOG ADMIN — estado mutável em memória pros 8 kinds
// ════════════════════════════════════════════════
function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const CATALOG_KINDS = ['vendors', 'systems', 'versions', 'environments', 'topics', 'parameters', 'prompts', 'exports'];

function makeCatalogsState(initial) {
  const data = {};
  for (const k of CATALOG_KINDS) data[k] = initial[k].map(x => ({ ...x }));
  const calls = { catalogs: 0, create: {}, update: {}, delete: {} };
  for (const k of CATALOG_KINDS) {
    calls.create[k] = [];
    calls.update[k] = [];
    calls.delete[k] = [];
  }

  function snapshotCatalogs() {
    calls.catalogs++;
    const out = {};
    for (const k of CATALOG_KINDS) out[k] = data[k].map(x => ({ ...x }));
    return out;
  }

  function findIndex(kind, key, system) {
    if (kind === 'versions') return data.versions.findIndex(v => v.system === system && v.key === key);
    return data[kind].findIndex(x => x.key === key);
  }

  function create(kind, payload) {
    calls.create[kind].push({ ...payload });
    const key = kind === 'parameters' ? payload.key : slug(payload.label);
    let item;
    if (kind === 'vendors' || kind === 'topics' || kind === 'prompts' || kind === 'exports' || kind === 'parameters') {
      item = { key, label: payload.label, sort_order: data[kind].length };
      if (payload.color !== undefined) item.color = payload.color;
      if (kind === 'topics') item.is_protected = 0;
    } else if (kind === 'systems') {
      item = { key, vendor: payload.vendor, label: payload.label, color: payload.color, sort_order: data.systems.length };
    } else {
      // versions / environments
      item = { key, system: payload.system, vendor: '', label: payload.label, color: payload.color, sort_order: data[kind].length };
    }
    data[kind].push(item);
    return item;
  }

  function update(kind, key, payload, system) {
    calls.update[kind].push({ key, system, payload: { ...payload } });
    const idx = findIndex(kind, key, system);
    if (idx < 0) return null;
    Object.assign(data[kind][idx], payload);
    return data[kind][idx];
  }

  function remove(kind, key, system) {
    calls.delete[kind].push({ key, system });
    const idx = findIndex(kind, key, system);
    if (idx >= 0) data[kind].splice(idx, 1);
  }

  return { calls, snapshotCatalogs, create, update, remove, data };
}

// Registra as rotas das 24 combinações create/update/delete dos 8 kinds +
// GET /api/catalogs servindo o estado atual — ver comentário em
// src/lib/catalogAdmin.ts (mesma forma de URL: /api/{kind} pro POST,
// /api/{kind}/:key pro PUT/DELETE, exceto `versions`, cuja chave composta
// usa /api/versions/:system/:key).
async function mockCatalogAdmin(page, state) {
  await page.route('**/api/catalogs', route => (route.request().method() === 'GET' ? route.fulfill({ json: state.snapshotCatalogs() }) : route.continue()));

  for (const kind of CATALOG_KINDS) {
    await page.route(`**/api/${kind}`, route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        return route.fulfill({ status: 201, json: state.create(kind, body) });
      }
      return route.continue();
    });
  }

  for (const kind of CATALOG_KINDS.filter(k => k !== 'versions')) {
    await page.route(`**/api/${kind}/*`, route => {
      const key = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
      const method = route.request().method();
      if (method === 'PUT') {
        const body = route.request().postDataJSON();
        const item = state.update(kind, key, body);
        return route.fulfill({ json: item || {} });
      }
      if (method === 'DELETE') {
        state.remove(kind, key);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.continue();
    });
  }

  await page.route('**/api/versions/*/*', route => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const system = decodeURIComponent(parts[3]);
    const key = decodeURIComponent(parts[4]);
    const method = route.request().method();
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      const item = state.update('versions', key, body, system);
      return route.fulfill({ json: item || {} });
    }
    if (method === 'DELETE') {
      state.remove('versions', key, system);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
}

// Catálogo rico o bastante pra cobrir todos os cenários do domínio B,
// incluindo o caso de key duplicada ('v1') em dois systems diferentes
// (gaia e vsx) nas versions — ver cenário 18.
function freshCatalogsFixture() {
  return {
    vendors: [
      { key: 'check-point', label: 'Check Point', color: '#DA1572', sort_order: 0 },
      { key: 'fortinet', label: 'Fortinet', color: '#EE3124', sort_order: 1 },
    ],
    systems: [
      { key: 'gaia', vendor: 'check-point', label: 'Gaia', color: '#2DD4BF', sort_order: 0 },
      { key: 'vsx', vendor: 'check-point', label: 'VSX', color: '#60A5FA', sort_order: 1 },
      { key: 'fortios', vendor: 'fortinet', label: 'FortiOS', color: '#A3E635', sort_order: 2 },
    ],
    versions: [
      { key: 'v1', system: 'gaia', vendor: 'check-point', label: 'R81.10', color: '#FF4FA0', sort_order: 0 },
      { key: 'v1', system: 'vsx', vendor: 'check-point', label: 'R81.20', color: '#FBBF24', sort_order: 1 },
      { key: 'R82', system: 'gaia', vendor: 'check-point', label: 'R82', color: '#34D399', sort_order: 2 },
    ],
    environments: [
      { key: 'standalone', system: 'gaia', vendor: 'check-point', label: 'Standalone', color: '#FB923C', sort_order: 0 },
      { key: 'cluster', system: 'gaia', vendor: 'check-point', label: 'Cluster HA', color: '#F87171', sort_order: 1 },
    ],
    topics: [
      { key: 'vpn', label: 'VPN', color: '#22D3EE', sort_order: 0, is_protected: 0 },
      { key: 'environment', label: 'Environment', color: '#8B949E', sort_order: 1, is_protected: 1 },
    ],
    parameters: [{ key: 'src-ip', label: 'Source IP', sort_order: 0 }],
    prompts: [{ key: 'confirm-prompt', label: 'Confirm', sort_order: 0 }],
    exports: [{ key: 'log-export', label: '> {{logFile}}', sort_order: 0 }],
  };
}

// ════════════════════════════════════════════════
// USERS — estado mutável em memória
// ════════════════════════════════════════════════
function makeUsersState(initial) {
  let users = initial.map(u => ({ ...u }));
  const calls = { list: 0, create: [], update: [], delete: [] };
  return {
    calls,
    list() {
      calls.list++;
      return users.map(u => ({ ...u }));
    },
    create(payload) {
      calls.create.push({ ...payload });
      const u = { username: payload.username, role: payload.role, is_local: true, disabled: false, auth_provider: 'local', approved_at: '2026-01-01T00:00:00Z' };
      users.push(u);
      return u;
    },
    update(username, body) {
      calls.update.push({ username, body: { ...body } });
      const u = users.find(x => x.username === username);
      if (!u) return null;
      Object.assign(u, body);
      return u;
    },
    remove(username) {
      calls.delete.push(username);
      users = users.filter(u => u.username !== username);
    },
  };
}

async function mockUsers(page, state) {
  await page.route('**/api/users', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: state.list() });
    if (method === 'POST') {
      const body = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: state.create(body) });
    }
    return route.continue();
  });
  await page.route('**/api/users/*', route => {
    const username = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    const method = route.request().method();
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      const u = state.update(username, body);
      if (!u) return route.fulfill({ status: 404, json: { message: 'Not found.' } });
      return route.fulfill({ json: u });
    }
    if (method === 'DELETE') {
      state.remove(username);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
}

const USERS_FIXTURE = [
  { username: 'admin', role: 'super_admin', is_local: true, disabled: false, auth_provider: 'local', approved_at: '2024-01-01T00:00:00Z' },
  { username: 'bob@example.com', role: 'user', is_local: true, disabled: false, auth_provider: 'local', approved_at: '2024-01-02T00:00:00Z' },
  { username: 'carol@example.com', role: 'admin', is_local: false, disabled: true, approved_at: null },
  { username: 'dave@example.com', role: 'user', is_local: true, disabled: true, approved_at: '2024-02-01T00:00:00Z', auth_provider: 'local' },
  { username: 'erin@example.com', role: 'user', is_local: false, disabled: false, auth_provider: 'google' },
];

// Match exato na célula de Email (1ª <td>) — não um hasText genérico na
// linha inteira: o <select> de role sempre tem as 3 <option> no DOM
// ("User"/"Admin"/"Super Admin"), então QUALQUER linha "contém" a
// substring "admin" (case-insensitive) por causa das opções não
// selecionadas do próprio <select>, não só a linha do usuário "admin".
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function userRow(page, username) {
  return page.locator('.settings-pane[data-pane="users"] .audit-log-table tbody tr').filter({
    has: page.locator('td:first-child', { hasText: new RegExp(`^${escapeRegex(username)}$`) }),
  });
}

const browser = await chromium.launch();

// ════════════════════════════════════════════════
// DOMÍNIO A — USERS (super_admin-only)
// ════════════════════════════════════════════════

// ── Cenário 1: usuário comum não vê "Users" nem "Register" ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: false, isSuperAdmin: false });
  await goToApp(page);
  await openSettings(page);
  assert((await page.locator('.settings-nav-btn', { hasText: 'Users' }).count()) === 0, 'cenário 1: botão "Users" não aparece pra usuário comum');
  assert((await page.locator('.settings-nav-btn', { hasText: 'Register' }).count()) === 0, 'cenário 1: botão "Register" não aparece pra usuário comum');
});

// ── Cenário 2: admin comum vê "Register" mas não "Users" ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: false });
  await goToApp(page);
  await openSettings(page);
  assert((await page.locator('.settings-nav-btn', { hasText: 'Register' }).count()) === 1, 'cenário 2: botão "Register" aparece pra admin comum');
  assert((await page.locator('.settings-nav-btn', { hasText: 'Users' }).count()) === 0, 'cenário 2: botão "Users" NÃO aparece pra admin comum (só super_admin)');
});

// ── Cenário 3: super admin — abrir "Users" dispara GET e renderiza a tabela ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true, isAdmin: true });
  const state = makeUsersState(USERS_FIXTURE);
  await mockUsers(page, state);
  await goToApp(page);

  await openUsersPane(page);
  await assertEventually(() => state.calls.list === 1, 'cenário 3: GET /api/users foi chamado ao abrir a aba');
  const rows = page.locator('.settings-pane[data-pane="users"] tbody tr');
  await assertEventually(async () => (await rows.count()) === 5, 'cenário 3: os 5 usuários do mock aparecem na tabela');
  const bobRow = userRow(page, 'bob@example.com');
  assert((await bobRow.locator('td').nth(0).innerText()) === 'bob@example.com', 'cenário 3: Email de bob correto');
  assert((await bobRow.locator('td').nth(1).innerText()) === 'Local', 'cenário 3: Type de bob (Local)');
  await page.screenshot({ path: `${SHOTS}/3-users-table.png` });
});

// ── Cenário 4: conta protegida "admin" — sem select, sem Disable/Delete, com Reset password ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true, isAdmin: true });
  const state = makeUsersState(USERS_FIXTURE);
  await mockUsers(page, state);
  await goToApp(page);
  await openUsersPane(page);

  const adminRow = userRow(page, 'admin');
  await assertEventually(async () => (await adminRow.count()) === 1, 'cenário 4: linha do usuário "admin" aparece');
  assert((await adminRow.locator('select').count()) === 0, 'cenário 4: "admin" não tem <select> de role (texto puro)');
  assert((await adminRow.locator('td').nth(2).innerText()) === 'Super Admin', 'cenário 4: role de "admin" mostrado como texto "Super Admin"');
  assert((await adminRow.locator('button', { hasText: 'Disable' }).count()) === 0, 'cenário 4: "admin" não tem botão Disable/Enable/Approve');
  assert((await adminRow.locator('button', { hasText: 'Delete' }).count()) === 0, 'cenário 4: "admin" não tem botão Delete');
  assert((await adminRow.locator('button', { hasText: 'Reset password' }).count()) === 1, 'cenário 4: "admin" tem botão "Reset password" (is_local)');
});

// ── Cenário 6 (+7 combinado): status Pending/Disabled/Active e labels Approve/Disable/Enable ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true, isAdmin: true });
  const state = makeUsersState(USERS_FIXTURE);
  await mockUsers(page, state);
  await goToApp(page);
  await openUsersPane(page);

  const bobRow = userRow(page, 'bob@example.com'); // disabled:false → Active
  const carolRow = userRow(page, 'carol@example.com'); // disabled:true, approved_at:null → Pending
  const daveRow = userRow(page, 'dave@example.com'); // disabled:true, approved_at preenchido → Disabled
  await assertEventually(async () => (await bobRow.count()) === 1, 'cenário 6/7: linhas carregadas');

  assert((await bobRow.locator('td').nth(3).innerText()) === 'Active', 'cenário 6: bob (disabled:false) mostra "Active"');
  assert((await carolRow.locator('td').nth(3).innerText()) === 'Pending approval', 'cenário 6: carol (disabled:true, approved_at:null) mostra "Pending approval"');
  assert((await daveRow.locator('td').nth(3).innerText()) === 'Disabled', 'cenário 6: dave (disabled:true, approved_at preenchido) mostra "Disabled"');

  assert((await bobRow.locator('button', { hasText: 'Disable' }).count()) === 1, 'cenário 7: botão de bob (Active) é "Disable"');
  assert((await carolRow.locator('button', { hasText: 'Approve' }).count()) === 1, 'cenário 7: botão de carol (Pending) é "Approve"');
  assert((await daveRow.locator('button', { hasText: 'Enable' }).count()) === 1, 'cenário 7: botão de dave (Disabled não-pending) é "Enable"');

  // Clicar em "Disable" (bob) → PUT {disabled:true} + reload.
  await bobRow.locator('button', { hasText: 'Disable' }).click();
  await assertEventually(() => state.calls.update.some(c => c.username === 'bob@example.com' && c.body.disabled === true), 'cenário 7: clicar "Disable" chama PUT /api/users/bob@example.com {disabled:true}');
  await assertEventually(async () => (await userRow(page, 'bob@example.com').locator('button', { hasText: 'Enable' }).count()) === 1, 'cenário 7: botão de bob vira "Enable" após desabilitar e recarregar');

  // Clicar em "Enable" (dave) → PUT {disabled:false}.
  await daveRow.locator('button', { hasText: 'Enable' }).click();
  await assertEventually(() => state.calls.update.some(c => c.username === 'dave@example.com' && c.body.disabled === false), 'cenário 7: clicar "Enable" chama PUT /api/users/dave@example.com {disabled:false}');

  // Clicar em "Approve" (carol) → PUT {disabled:false} (aprovar = habilitar).
  await carolRow.locator('button', { hasText: 'Approve' }).click();
  await assertEventually(() => state.calls.update.some(c => c.username === 'carol@example.com' && c.body.disabled === false), 'cenário 7: clicar "Approve" chama PUT /api/users/carol@example.com {disabled:false}');
  await assertEventually(async () => (await userRow(page, 'carol@example.com').locator('td').nth(3).innerText()) === 'Active', 'cenário 7: carol vira "Active" depois de aprovada');
});

// ── Cenário 5: trocar o <select> de role dispara PUT e recarrega a lista ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true, isAdmin: true });
  const state = makeUsersState(USERS_FIXTURE);
  await mockUsers(page, state);
  await goToApp(page);
  await openUsersPane(page);

  const bobRow = userRow(page, 'bob@example.com');
  await assertEventually(async () => (await bobRow.locator('select').count()) === 1, 'cenário 5: select de role de bob carregado');
  const listCallsBefore = state.calls.list;
  await bobRow.locator('select').selectOption('admin');

  await assertEventually(() => state.calls.update.some(c => c.username === 'bob@example.com' && c.body.role === 'admin'), 'cenário 5: PUT /api/users/bob@example.com {role:"admin"} foi chamado');
  await assertEventually(() => state.calls.list === listCallsBefore + 1, 'cenário 5: a lista recarrega (novo GET /api/users) após trocar a role');
});

// ── Cenário 8: busca por username filtra client-side (sem nova chamada) ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true, isAdmin: true });
  const state = makeUsersState(USERS_FIXTURE);
  await mockUsers(page, state);
  await goToApp(page);
  await openUsersPane(page);

  const rows = page.locator('.settings-pane[data-pane="users"] tbody tr');
  await assertEventually(async () => (await rows.count()) === 5, 'cenário 8: lista inicial com 5 usuários');
  const listCallsBefore = state.calls.list;

  await page.locator('.settings-pane[data-pane="users"] input.set-input').fill('bob');
  await assertEventually(async () => (await rows.count()) === 1, 'cenário 8: busca "bob" filtra pra 1 usuário');
  assert(await userRow(page, 'bob@example.com').isVisible(), 'cenário 8: o usuário que sobrou é "bob@example.com"');
  assert(state.calls.list === listCallsBefore, 'cenário 8: a busca não disparou um novo GET /api/users');
});

// ── Cenário 9: "New local user" — validação e criação ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true, isAdmin: true });
  const state = makeUsersState(USERS_FIXTURE);
  await mockUsers(page, state);
  await goToApp(page);
  await openUsersPane(page);

  await page.locator('.settings-pane[data-pane="users"] button', { hasText: 'New local user' }).click();
  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'New local user' }) });
  await modal.waitFor();

  // E-mail inválido + senha válida → erro combinado, sem POST.
  await modal.locator('input[type="email"]').fill('not-an-email');
  await modal.locator('input[type="password"]').fill('senha123');
  await modal.locator('button', { hasText: 'Create' }).click();
  await assertEventually(
    async () => (await modal.locator('.set-hint', { hasText: 'A valid e-mail address is required, and the password must be at least 8 characters.' }).count()) === 1,
    'cenário 9: e-mail inválido mostra a mensagem de erro combinada'
  );
  assert(state.calls.create.length === 0, 'cenário 9: nenhum POST /api/users disparado com e-mail inválido');

  // E-mail válido + senha curta → mesmo erro, sem POST.
  await modal.locator('input[type="email"]').fill('novo@example.com');
  await modal.locator('input[type="password"]').fill('ab');
  await modal.locator('button', { hasText: 'Create' }).click();
  await assertEventually(
    async () => (await modal.locator('.set-hint', { hasText: 'A valid e-mail address is required, and the password must be at least 8 characters.' }).count()) === 1,
    'cenário 9: senha curta (<8) também mostra o erro combinado'
  );
  assert(state.calls.create.length === 0, 'cenário 9: nenhum POST /api/users disparado com senha curta');

  // Dados válidos → POST, fecha modal, recarrega lista.
  const listCallsBefore = state.calls.list;
  await modal.locator('input[type="password"]').fill('senha123');
  await modal.locator('select').selectOption('admin');
  await modal.locator('button', { hasText: 'Create' }).click();

  await assertEventually(() => state.calls.create.length === 1, 'cenário 9: POST /api/users foi chamado com dados válidos');
  assert(
    JSON.stringify(state.calls.create[0]) === JSON.stringify({ username: 'novo@example.com', password: 'senha123', role: 'admin' }),
    `cenário 9: payload correto (lido: ${JSON.stringify(state.calls.create[0])})`
  );
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 9: o modal fecha após criar');
  await assertEventually(() => state.calls.list === listCallsBefore + 1, 'cenário 9: a lista recarrega após criar');
  await assertEventually(async () => (await userRow(page, 'novo@example.com').count()) === 1, 'cenário 9: "novo@example.com" aparece na lista');
});

// ── Cenário 10: "Reset password" — validação, sucesso, NÃO recarrega a lista ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true, isAdmin: true });
  const state = makeUsersState(USERS_FIXTURE);
  await mockUsers(page, state);
  await goToApp(page);
  await openUsersPane(page);

  const bobRow = userRow(page, 'bob@example.com');
  await assertEventually(async () => (await bobRow.locator('button', { hasText: 'Reset password' }).count()) === 1, 'cenário 10: bob (is_local) tem botão "Reset password"');
  const erinRow = userRow(page, 'erin@example.com');
  assert((await erinRow.locator('button', { hasText: 'Reset password' }).count()) === 0, 'cenário 10: erin (Google, não local) NÃO tem botão "Reset password"');

  await bobRow.locator('button', { hasText: 'Reset password' }).click();
  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Reset password' }) });
  await modal.waitFor();

  await modal.locator('input[type="password"]').fill('ab');
  await modal.locator('button', { hasText: 'Save' }).click();
  await assertEventually(
    async () => (await modal.locator('.set-hint', { hasText: 'Password must be at least 8 characters.' }).count()) === 1,
    'cenário 10: senha curta mostra "Password must be at least 8 characters."'
  );

  const listCallsBefore = state.calls.list;
  await modal.locator('input[type="password"]').fill('novaSenha123');
  await modal.locator('button', { hasText: 'Save' }).click();

  await assertEventually(() => state.calls.update.some(c => c.username === 'bob@example.com' && c.body.password === 'novaSenha123'), 'cenário 10: PUT /api/users/bob@example.com {password:...} foi chamado');
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 10: o modal fecha após salvar');
  await new Promise(r => setTimeout(r, 300));
  assert(state.calls.list === listCallsBefore, 'cenário 10: reset de senha NÃO disparou um novo GET /api/users');
});

// ── Cenário 11: "Delete" — confirmação com mensagem exata, cancelar/confirmar ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true, isAdmin: true });
  const state = makeUsersState(USERS_FIXTURE);
  await mockUsers(page, state);
  await goToApp(page);
  await openUsersPane(page);

  const erinRow = userRow(page, 'erin@example.com');
  await assertEventually(async () => (await erinRow.count()) === 1, 'cenário 11: linha de erin carregada');
  await erinRow.locator('button', { hasText: 'Delete' }).click();

  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  const expected = 'Delete the user "erin@example.com"? Windows-identified users are recreated automatically (with the default "User" role) the next time they\'re seen. This cannot be undone.';
  assert(msg === expected, `cenário 11: mensagem de confirmação exata (lida: "${msg}")`);

  // Cancelar não chama DELETE.
  await page.locator('#confirmOverlay button', { hasText: 'Cancel' }).click();
  await assertEventually(async () => (await page.locator('#confirmOverlay.show').count()) === 0, 'cenário 11: overlay de confirmação fecha ao cancelar');
  assert(state.calls.delete.length === 0, 'cenário 11: cancelar NÃO chama DELETE /api/users/:username');
  assert(await userRow(page, 'erin@example.com').isVisible(), 'cenário 11: "erin@example.com" continua na lista após cancelar');

  // Confirmar chama DELETE e recarrega a lista.
  const listCallsBefore = state.calls.list;
  await erinRow.locator('button', { hasText: 'Delete' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();

  await assertEventually(() => state.calls.delete.includes('erin@example.com'), 'cenário 11: confirmar chama DELETE /api/users/erin@example.com');
  await assertEventually(() => state.calls.list === listCallsBefore + 1, 'cenário 11: a lista recarrega (novo GET) após excluir');
  await assertEventually(async () => (await userRow(page, 'erin@example.com').count()) === 0, 'cenário 11: "erin@example.com" some da lista');
});

// ════════════════════════════════════════════════
// DOMÍNIO B — CATALOG ADMIN / "REGISTER" (admin-rank)
// ════════════════════════════════════════════════

// ── Cenário 12: "Register" mostra 8 tiles em 2 grupos ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, catalogsJson: freshCatalogsFixture() });
  await goToApp(page);
  await openCatalogPane(page);

  const groups = page.locator('.settings-catalog-group');
  assert((await groups.count()) === 2, 'cenário 12: existem 2 grupos de tiles');
  const group1Labels = await groups.nth(0).locator('.settings-tile span').allInnerTexts();
  const group2Labels = await groups.nth(1).locator('.settings-tile span').allInnerTexts();
  assert(JSON.stringify(group1Labels) === JSON.stringify(['Vendors', 'Systems', 'Versions', 'Environments', 'Topics']), `cenário 12: grupo 1 (lido: ${JSON.stringify(group1Labels)})`);
  assert(JSON.stringify(group2Labels) === JSON.stringify(['Exports', 'Parameters', 'Prompts']), `cenário 12: grupo 2 (lido: ${JSON.stringify(group2Labels)})`);
});

// ── Cenário 13: tile "Vendors" abre "Manage Vendors" com a lista do catálogo ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);

  await openCatalogModal(page, 'Vendors');
  const modal = catalogModal(page, 'Manage Vendors');
  await modal.waitFor();
  const rows = modal.locator('.list-editor .cat-row');
  await assertEventually(async () => (await rows.count()) === 2, 'cenário 13: as 2 vendors do mock aparecem na lista');
  assert((await rows.nth(0).locator('input.set-input').inputValue()) === 'Check Point', 'cenário 13: primeira linha é "Check Point"');
  assert((await rows.nth(1).locator('input.set-input').inputValue()) === 'Fortinet', 'cenário 13: segunda linha é "Fortinet"');
  await page.screenshot({ path: `${SHOTS}/13-manage-vendors.png` });
});

// ── Cenário 14: busca dentro do modal filtra as linhas (Systems) ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);

  await openCatalogModal(page, 'Systems');
  const modal = catalogModal(page, 'Manage Systems');
  const rows = modal.locator('.list-editor .cat-row');
  await assertEventually(async () => (await rows.count()) === 3, 'cenário 14: as 3 systems do mock aparecem');

  await searchInput(modal).fill('fort');
  await assertEventually(async () => (await rows.count()) === 1, 'cenário 14: busca "fort" filtra pra 1 system');
  assert((await rows.nth(0).locator('input.set-input').inputValue()) === 'FortiOS', 'cenário 14: o system que sobrou é "FortiOS"');
});

// ── Cenário 15: editar label habilita Cancel/Save; Cancel reverte; Save envia só o campo mudado ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);

  await openCatalogModal(page, 'Vendors');
  const modal = catalogModal(page, 'Manage Vendors');
  await modal.waitFor();

  assert(await cancelBtn(modal).isDisabled(), 'cenário 15: "Cancel" começa desabilitado (sem edição)');
  assert(await saveBtn(modal).isDisabled(), 'cenário 15: "Save changes" começa desabilitado (sem edição)');

  const row = await catRowByLabel(modal, 'Check Point');
  await row.locator('input.set-input').fill('Check Point X');
  assert(!(await cancelBtn(modal).isDisabled()), 'cenário 15: editar o label habilita "Cancel"');
  assert(!(await saveBtn(modal).isDisabled()), 'cenário 15: editar o label habilita "Save changes"');

  await cancelBtn(modal).click();
  assert((await (await catRowByLabel(modal, 'Check Point')).locator('input.set-input').inputValue()) === 'Check Point', 'cenário 15: "Cancel" reverte o valor exibido');
  assert(await cancelBtn(modal).isDisabled(), 'cenário 15: "Cancel" volta a ficar desabilitado após reverter');
  assert(await saveBtn(modal).isDisabled(), 'cenário 15: "Save changes" volta a ficar desabilitado após reverter');
  assert(state.calls.update.vendors.length === 0, 'cenário 15: "Cancel" não chama a API');

  const row2 = await catRowByLabel(modal, 'Check Point');
  await row2.locator('input.set-input').fill('Check Point EU');
  await saveBtn(modal).click();

  await assertEventually(() => state.calls.update.vendors.length === 1, 'cenário 15: "Save changes" chama PUT /api/vendors/:key');
  const call = state.calls.update.vendors[0];
  assert(call.key === 'check-point' && JSON.stringify(call.payload) === JSON.stringify({ label: 'Check Point EU' }), `cenário 15: PUT envia só o campo mudado (lido: ${JSON.stringify(call)})`);
  await assertEventually(async () => (await adminMsg(modal).innerText()) === 'Changes saved.', 'cenário 15: mensagem "Changes saved." aparece após o sucesso');
});

// ── Cenário 16: "+ Add vendor" cria um vendor, limpa campos, "Added.", refresh ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);

  await openCatalogModal(page, 'Vendors');
  const modal = catalogModal(page, 'Manage Vendors');
  await modal.waitFor();
  const catalogsCallsBefore = state.calls.catalogs;

  await addRow(modal).locator('input.set-input').fill('Palo Alto');
  await modal.locator('button', { hasText: '+ Add vendor' }).click();

  await assertEventually(() => state.calls.create.vendors.length === 1, 'cenário 16: POST /api/vendors foi chamado');
  const payload = state.calls.create.vendors[0];
  assert(payload.label === 'Palo Alto' && typeof payload.color === 'string' && Object.keys(payload).sort().join(',') === 'color,label', `cenário 16: payload {label,color} (lido: ${JSON.stringify(payload)})`);
  await assertEventually(async () => (await addRow(modal).locator('input.set-input').inputValue()) === '', 'cenário 16: o campo de label é limpo após adicionar');
  await assertEventually(async () => (await adminMsg(modal).innerText()) === 'Added.', 'cenário 16: mensagem "Added." aparece');
  await assertEventually(() => state.calls.catalogs === catalogsCallsBefore + 1, 'cenário 16: GET /api/catalogs é chamado de novo (refresh)');
});

// ── Cenário 17: Systems — select de Vendor começa vazio; "Choose a vendor." bloqueia; fluxo válido funciona ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);

  await openCatalogModal(page, 'Systems');
  const modal = catalogModal(page, 'Manage Systems');
  await modal.waitFor();

  assert((await addRow(modal).locator('select').inputValue()) === '', 'cenário 17: o select de Vendor da linha "+ Add" começa sem nada selecionado');

  await addRow(modal).locator('input.set-input').fill('NGX');
  await modal.locator('button', { hasText: '+ Add system' }).click();
  await assertEventually(async () => (await adminMsg(modal).innerText()) === 'Choose a vendor.', 'cenário 17: sem escolher vendor mostra "Choose a vendor."');
  assert(state.calls.create.systems.length === 0, 'cenário 17: nenhum POST /api/systems foi disparado sem vendor');

  await addRow(modal).locator('select').selectOption('check-point');
  await modal.locator('button', { hasText: '+ Add system' }).click();
  await assertEventually(() => state.calls.create.systems.length === 1, 'cenário 17: escolhendo um vendor e clicando de novo chama POST /api/systems');
  assert(
    JSON.stringify(state.calls.create.systems[0]) === JSON.stringify({ label: 'NGX', color: '#8B949E', vendor: 'check-point' }),
    `cenário 17: payload {label,color,vendor} correto (lido: ${JSON.stringify(state.calls.create.systems[0])})`
  );
});

// ── Cenário 18: Versions — key duplicada ('v1') em systems diferentes não colide ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);

  await openCatalogModal(page, 'Versions');
  const modal = catalogModal(page, 'Manage Versions');
  await modal.waitFor();
  const rows = modal.locator('.list-editor .cat-row');
  await assertEventually(async () => (await rows.count()) === 3, 'cenário 18: as 3 versions do mock aparecem (2 com key "v1")');

  // 18a: editar só o label da versão v1/gaia (R81.10) e salvar não afeta a v1/vsx (R81.20).
  const gaiaRow = await catRowByLabel(modal, 'R81.10');
  await gaiaRow.locator('input.set-input').fill('R81.10 GA');
  await saveBtn(modal).click();

  await assertEventually(() => state.calls.update.versions.length === 1, 'cenário 18a: PUT de versions foi chamado');
  const call1 = state.calls.update.versions[0];
  assert(
    call1.key === 'v1' && call1.system === 'gaia' && JSON.stringify(call1.payload) === JSON.stringify({ label: 'R81.10 GA' }),
    `cenário 18a: PUT vai para /api/versions/gaia/v1 com só {label} mudado (lido: ${JSON.stringify(call1)})`
  );
  assert(state.data.versions.find(v => v.system === 'vsx' && v.key === 'v1').label === 'R81.20', 'cenário 18a: a versão v1/vsx (R81.20) continua intacta no backend mockado');
  await assertEventually(async () => (await catRowByLabel(modal, 'R81.20')).locator('input.set-input').inputValue().then(v => v === 'R81.20'), 'cenário 18a: a linha R81.20 continua mostrando seu label original após o refresh');

  // 18b: trocar o SYSTEM (select) da versão v1/vsx (R81.20) para FortiOS — o PUT
  // deve usar o system ORIGINAL da linha (vsx) na URL, com o novo valor só no corpo.
  const vsxRow = await catRowByLabel(modal, 'R81.20');
  await vsxRow.locator('select').selectOption('fortios');
  await saveBtn(modal).click();

  await assertEventually(() => state.calls.update.versions.length === 2, 'cenário 18b: um segundo PUT de versions foi chamado');
  const call2 = state.calls.update.versions[1];
  assert(
    call2.key === 'v1' && call2.system === 'vsx' && JSON.stringify(call2.payload) === JSON.stringify({ system: 'fortios' }),
    `cenário 18b: PUT vai para /api/versions/vsx/v1 (system ORIGINAL) com {system:"fortios"} no corpo (lido: ${JSON.stringify(call2)})`
  );
});

// ── Cenário 19: Topics — protegido sem botão de excluir; normal exclui com sucesso ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);

  await openCatalogModal(page, 'Topics');
  const modal = catalogModal(page, 'Manage Topics');
  await modal.waitFor();

  const protectedRow = await catRowByLabel(modal, 'Environment');
  assert(await protectedRow.locator('.cat-protected-badge', { hasText: 'protected' }).isVisible(), 'cenário 19: "Environment" (is_protected) mostra o badge "protected"');
  assert((await protectedRow.locator('.cat-delete-btn').count()) === 0, 'cenário 19: "Environment" não tem botão de excluir');

  const normalRow = await catRowByLabel(modal, 'VPN');
  assert((await normalRow.locator('.cat-protected-badge').count()) === 0, 'cenário 19: "VPN" não mostra o badge "protected"');
  assert((await normalRow.locator('.cat-delete-btn').count()) === 1, 'cenário 19: "VPN" tem botão de excluir');

  const catalogsCallsBefore = state.calls.catalogs;
  await normalRow.locator('.cat-delete-btn').click();
  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  assert(msg === 'Delete "vpn"? This action cannot be undone.', `cenário 19: mensagem de confirmação exata (lida: "${msg}")`);
  await page.locator('#confirmOkBtn').click();

  await assertEventually(() => state.calls.delete.topics.some(c => c.key === 'vpn'), 'cenário 19: DELETE /api/topics/vpn foi chamado');
  await assertEventually(async () => (await adminMsg(modal).innerText()) === 'Deleted.', 'cenário 19: mensagem "Deleted." aparece');
  await assertEventually(() => state.calls.catalogs === catalogsCallsBefore + 1, 'cenário 19: GET /api/catalogs é chamado de novo após excluir');
});

// ── Cenário 20: Parameters — key como badge somente leitura; validação de key; add válido ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);

  await openCatalogModal(page, 'Parameters');
  const modal = catalogModal(page, 'Manage Parameters');
  await modal.waitFor();

  const row = await catRowByLabel(modal, 'Source IP');
  assert((await row.locator('.cat-key-badge').innerText()) === 'src-ip', 'cenário 20: a key "src-ip" aparece como badge somente leitura');
  assert((await row.locator('input.cat-key-badge, input[value="src-ip"]').count()) === 0, 'cenário 20: a key NÃO é um input editável');

  await addRow(modal).locator('input.set-input').first().fill('bad key'); // key com espaço — inválida
  await addRow(modal).locator('input.set-input').nth(1).fill('Bad Param');
  await modal.locator('button', { hasText: '+ Add parameter' }).click();
  await assertEventually(async () => (await adminMsg(modal).innerText()) === 'Enter a valid key (letters, numbers, dot, hyphen).', 'cenário 20: key inválida mostra a mensagem de erro');
  assert(state.calls.create.parameters.length === 0, 'cenário 20: nenhum POST /api/parameters com key inválida');

  await addRow(modal).locator('input.set-input').first().fill('dst-ip');
  await addRow(modal).locator('input.set-input').nth(1).fill('Destination IP');
  await modal.locator('button', { hasText: '+ Add parameter' }).click();
  await assertEventually(() => state.calls.create.parameters.length === 1, 'cenário 20: key válida chama POST /api/parameters');
  assert(
    JSON.stringify(state.calls.create.parameters[0]) === JSON.stringify({ key: 'dst-ip', label: 'Destination IP' }),
    `cenário 20: payload {key,label} correto (lido: ${JSON.stringify(state.calls.create.parameters[0])})`
  );
});

// ── Cenário 21: Prompts/Exports — "+ Add" só tem label, payload sem "color" ──
for (const [tileLabel, modalTitle, btnLabel, kind] of [
  ['Prompts', 'Manage Prompts', '+ Add prompt', 'prompts'],
  ['Exports', 'Manage Exports', '+ Add export', 'exports'],
]) {
  await withPage(browser, async page => {
    const state = makeCatalogsState(freshCatalogsFixture());
    await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
    await mockCatalogAdmin(page, state);
    await goToApp(page);

    await openCatalogModal(page, tileLabel);
    const modal = catalogModal(page, modalTitle);
    await modal.waitFor();

    assert((await addRow(modal).locator('.cat-color-input').count()) === 0, `cenário 21 (${tileLabel}): a linha "+ Add" não tem campo de cor`);
    await addRow(modal).locator('input.set-input').fill(`Novo ${tileLabel}`);
    await modal.locator('button', { hasText: btnLabel }).click();

    await assertEventually(() => state.calls.create[kind].length === 1, `cenário 21 (${tileLabel}): POST /api/${kind} foi chamado`);
    const payload = state.calls.create[kind][0];
    assert(!('color' in payload), `cenário 21 (${tileLabel}): o payload NÃO inclui "color" (lido: ${JSON.stringify(payload)})`);
    assert(payload.label === `Novo ${tileLabel}`, `cenário 21 (${tileLabel}): o payload inclui o label certo`);
  });
}

// ── Cenário 22: delete bloqueado (409 in_use) mostra mensagem específica, não genérica ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  // Registrado DEPOIS de mockCatalogAdmin — Playwright tenta o route()
  // mais recente primeiro, então esta rota mais específica intercepta
  // SÓ o DELETE de "fortinet" antes do handler genérico de vendors.
  await page.route('**/api/vendors/fortinet', route => {
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 409, json: { error: 'in_use', count: 3 } });
    return route.continue();
  });
  await goToApp(page);

  await openCatalogModal(page, 'Vendors');
  const modal = catalogModal(page, 'Manage Vendors');
  await modal.waitFor();
  const catalogsCallsBefore = state.calls.catalogs;

  const row = await catRowByLabel(modal, 'Fortinet');
  await row.locator('.cat-delete-btn').click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();

  await assertEventually(async () => (await adminMsg(modal).innerText()) === 'Cannot delete: in use by 3 command(s).', 'cenário 22: mensagem específica "Cannot delete: in use by 3 command(s)." (não genérica)');
  assert(state.calls.catalogs === catalogsCallsBefore, 'cenário 22: delete bloqueado NÃO dispara um novo GET /api/catalogs (onCatalogsChanged só roda em sucesso)');
});

// ── Cenário 23: o modal fecha das 3 formas — "✕", overlay, Escape ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);

  // openCatalogModal() abre o modal de Configurações + navega pra "Register"
  // + clica no tile — só precisa rodar uma vez: fechar só a CatalogAdminModal
  // (✕ / overlay) deixa o modal de Configurações (e a aba Register) abertos
  // por trás, então as reaberturas seguintes só precisam clicar no tile de
  // novo (clicar na engrenagem de novo bateria no overlay do modal de
  // Configurações, que ainda está show).
  await openCatalogModal(page, 'Vendors');
  let modal = catalogModal(page, 'Manage Vendors');
  await modal.waitFor();
  await modal.locator('.modal-close').click();
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 23: "✕" fecha o modal');

  await page.locator('.settings-tile', { hasText: 'Vendors' }).click();
  modal = catalogModal(page, 'Manage Vendors');
  await modal.waitFor();
  await page.mouse.click(5, 5); // fora da caixa, dentro do overlay
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 23: clicar no overlay (fora da caixa) fecha o modal — diferente do IpCalcModal da fatia 6 (que só fecha pelo "✕")');

  await page.locator('.settings-tile', { hasText: 'Vendors' }).click();
  modal = catalogModal(page, 'Manage Vendors');
  await modal.waitFor();
  await page.keyboard.press('Escape');
  // Escape é um listener global (document.addEventListener) tanto na
  // CatalogAdminModal quanto no SettingsModal por trás dela — os dois
  // fecham com a mesma tecla, o que não invalida o que este cenário
  // verifica (a CatalogAdminModal fecha com Escape).
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 23: a tecla Escape fecha o modal');
});

// ── Cenário 24: toda mutação bem-sucedida (create/update/delete) refaz GET /api/catalogs ──
await withPage(browser, async page => {
  const state = makeCatalogsState(freshCatalogsFixture());
  await mockBase(page, { isAdmin: true, catalogsJson: EMPTY_CATALOGS });
  await mockCatalogAdmin(page, state);
  await goToApp(page);
  // 1 GET já ocorreu no mount do AppShell (refreshCatalogs inicial).
  await assertEventually(() => state.calls.catalogs === 1, 'cenário 24: 1 GET /api/catalogs ocorre no carregamento inicial do app');

  await openCatalogModal(page, 'Vendors');
  const modal = catalogModal(page, 'Manage Vendors');
  await modal.waitFor();

  // create
  await addRow(modal).locator('input.set-input').fill('Palo Alto');
  await modal.locator('button', { hasText: '+ Add vendor' }).click();
  await assertEventually(() => state.calls.catalogs === 2, 'cenário 24: criar um vendor refaz o GET /api/catalogs (onCatalogsChanged → refreshCatalogs)');

  // update
  const row = await catRowByLabel(modal, 'Check Point');
  await row.locator('input.set-input').fill('Check Point BR');
  await saveBtn(modal).click();
  await assertEventually(() => state.calls.catalogs === 3, 'cenário 24: editar e salvar um vendor refaz o GET /api/catalogs');

  // delete
  const row2 = await catRowByLabel(modal, 'Fortinet');
  await row2.locator('.cat-delete-btn').click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(() => state.calls.catalogs === 4, 'cenário 24: excluir um vendor refaz o GET /api/catalogs');
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
