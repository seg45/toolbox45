// Suíte de validação manual (Playwright) da Fase 3, fatia 9 (parte B: Export/
// Import de COMANDOS em CSV, Settings -> Database -> grupo "Commands") — mesmo
// padrão de mocking de /api/* de test/fatia8.spec.mjs (page.route por
// endpoint, sem backend; fixtures em memória mutáveis com contadores em
// `state.calls`; helpers assert/assertEventually/withPage idênticos).
//
// As expectativas são derivadas do app ORIGINAL (js/csv-export.js,
// js/csv-import.js, index.html: #exportColumnsOverlay/#importCommandsOverlay),
// não do código React. Quando o React diverge do original em algo observável o
// teste continua afirmando o comportamento ORIGINAL e a falha é marcada com o
// prefixo "[ACHADO]" na mensagem.
//
//   A. Export (colunas, escopo, persistência em localStorage, conteúdo do .csv,
//      nome do arquivo, falha, fechamento).
//   B. Import (template, dica, arquivo vazio, checkbox "as System", caminho
//      feliz, casamento de catálogo, parsing de células, validações por linha,
//      erros do servidor, avisos).
//   C. Painel "Resolve unmatched values" (criar/mapear/parâmetros/falhas/skip/
//      reset) e round-trip export -> import.
//
// Porta própria (4176) — a suíte 9a roda em paralelo na 4175.
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { isDeepStrictEqual } from 'util';

const BASE = 'http://localhost:4173';

let failures = 0;
let passes = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('FALHOU:', msg);
  } else {
    passes++;
    console.log('ok:', msg);
  }
}

// Igual ao de fatia8, mas engole exceções do predicado (ex.: elemento
// desanexado no meio de um re-render) e tenta de novo até o timeout.
async function assertEventually(fn, msg, timeoutMs = 4000) {
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

async function withPage(browser, fn) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const eq = (a, b) => isDeepStrictEqual(a, b);

// ════════════════════════════════════════════════
// FIXTURES / MOCKS BASE (mesmo mockBase de fatia8)
// ════════════════════════════════════════════════
const EMPTY_CATALOGS = { vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [] };

async function mockBase(page, { isAdmin = false, isSuperAdmin = false, meOverrides = {}, catalogsJson = EMPTY_CATALOGS } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
  });
  await page.route('**/api/me', route =>
    route.fulfill({
      json: {
        username: 'tester', upn: 'tester',
        role: isSuperAdmin ? 'super_admin' : isAdmin ? 'admin' : 'user',
        isAdmin, isSuperAdmin, authMethod: 'local',
        ...meOverrides,
      },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: catalogsJson }));
  await page.route('**/api/system/logo', route => (route.request().method() === 'GET' ? route.fulfill({ json: { imageData: null, imageDataDark: null } }) : route.continue()));
  await page.route('**/api/commands', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  await page.route('**/api/folders', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  await page.route('**/api/user-data', route => (route.request().method() === 'GET' ? route.fulfill({ json: {} }) : route.continue()));
}

// Catálogo base. Versions/Environments têm key DIFERENTE do label de propósito
// (o export de Versions/Environments sai pelas KEYS; Vendor/System/Topics pelos
// RÓTULOS).
const makeCatalogs = () => ({
  vendors: [
    { key: 'checkpoint', label: 'Check Point', color: '#E8590C', sort_order: 0 },
    { key: 'fortinet', label: 'Fortinet', color: '#EE3124', sort_order: 1 },
  ],
  systems: [
    { key: 'gaia', label: 'Gaia', color: '#58A6FF', sort_order: 0, vendor: 'checkpoint' },
    { key: 'fortios', label: 'FortiOS', color: '#F85149', sort_order: 1, vendor: 'fortinet' },
  ],
  versions: [
    { key: 'ver_r82', label: 'R82', color: '#34D399', sort_order: 0, system: 'gaia', vendor: 'checkpoint' },
    { key: 'ver_r8110', label: 'R81.10', color: '#34D399', sort_order: 1, system: 'gaia', vendor: 'checkpoint' },
    { key: 'ver_fos7', label: '7.0', color: '#34D399', sort_order: 2, system: 'fortios', vendor: 'fortinet' },
  ],
  environments: [
    { key: 'env_standalone', label: 'Standalone', color: '#FBBF24', sort_order: 0, system: 'gaia', vendor: 'checkpoint' },
    { key: 'env_cluster', label: 'Cluster', color: '#FBBF24', sort_order: 1, system: 'gaia', vendor: 'checkpoint' },
    { key: 'env_fos', label: 'FG-Single', color: '#FBBF24', sort_order: 2, system: 'fortios', vendor: 'fortinet' },
  ],
  topics: [
    { key: 'sysmon', label: 'System Monitoring', color: '#34D399', sort_order: 0, is_protected: 0 },
    { key: 'status', label: 'Status', color: '#58A6FF', sort_order: 1, is_protected: 0 },
    { key: 'environment', label: 'Environment', color: '#8B949E', sort_order: 99, is_protected: 1 },
  ],
  parameters: [{ key: 'src_ip', label: 'Source IP', sort_order: 0 }],
  prompts: [],
  exports: [],
});

function cmdLine(o) {
  return { line_type: 'cmd', prompt: null, content: '', export_template: null, image_data: null, ...o };
}

function mkCmd(id, o = {}) {
  return {
    id, topic: 'sysmon', topics: ['sysmon'], folder_ids: [], icon: null, sort_order: id,
    requires_ip_port: false, placeholder_resolver: null,
    name: `Cmd ${id}`, name_empty: null, desc: '', desc_empty: null, details: null,
    vendors: ['checkpoint'], systems: ['gaia'], versions: ['ver_r82'], environments: ['env_standalone'],
    lines: { default: [cmdLine({ prompt: '[Expert@FW]#', content: `echo ${id}` })], empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    created_by: 'tester', modified_by: 'tester', is_system: false,
    ...o,
  };
}

const slugKey = label => 'srv_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '');

// Estado mutável em memória + contadores. `commandPost(body, idx)` pode
// devolver { status, json|body } para simular erro de servidor numa linha;
// `createFail(kind, body)` idem para POST de itens de catálogo (ou 'abort').
function makeState(o = {}) {
  return {
    catalogs: o.catalogs || makeCatalogs(),
    commands: o.commands || [],
    failCommandsGet: !!o.failCommandsGet,
    commandPost: o.commandPost || null,
    createFail: o.createFail || null,
    nextCmdId: 1000,
    calls: { commandsGet: 0, catalogsGet: 0, commandPosts: [], catalogPosts: [] },
  };
}

const CATALOG_KINDS = ['vendors', 'systems', 'versions', 'environments', 'topics', 'parameters'];

// Registrada DEPOIS de mockBase() (o último route() registrado vence).
async function mockApp(page, state, { isAdmin = false, isSuperAdmin = false, seed = null } = {}) {
  await mockBase(page, { isAdmin, isSuperAdmin });
  if (seed) {
    await page.addInitScript(entries => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, seed);
  }
  await page.route('**/api/catalogs', route => {
    state.calls.catalogsGet++;
    return route.fulfill({ json: state.catalogs });
  });
  await page.route('**/api/commands', route => {
    const req = route.request();
    if (req.method() === 'GET') {
      state.calls.commandsGet++;
      if (state.failCommandsGet) return route.fulfill({ status: 500, json: { error: 'internal_error', message: 'boom' } });
      return route.fulfill({ json: state.commands });
    }
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      const idx = state.calls.commandPosts.length;
      state.calls.commandPosts.push({ body, headers: req.headers() });
      const custom = state.commandPost && state.commandPost(body, idx);
      if (custom) return route.fulfill(custom);
      return route.fulfill({ status: 201, json: { id: state.nextCmdId++ } });
    }
    return route.continue();
  });
  for (const kind of CATALOG_KINDS) {
    await page.route(`**/api/${kind}`, route => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      const body = req.postDataJSON();
      state.calls.catalogPosts.push({ kind, body });
      const fail = state.createFail && state.createFail(kind, body);
      if (fail === 'abort') return route.abort('failed');
      if (fail) return route.fulfill(fail);
      const list = state.catalogs[kind];
      let key = kind === 'parameters' ? body.key : slugKey(body.label);
      if (list.some(it => it.key === key)) return route.fulfill({ status: 409, json: { error: 'conflict', message: `'${key}' already exists` } });
      const item = { key, label: body.label, color: body.color || '#8B949E', sort_order: list.length };
      if (kind === 'parameters') delete item.color;
      if (kind === 'systems') item.vendor = body.vendor;
      if (kind === 'versions' || kind === 'environments') {
        item.system = body.system;
        const sys = state.catalogs.systems.find(s => s.key === body.system);
        item.vendor = sys ? sys.vendor : null;
      }
      if (kind === 'topics') item.is_protected = 0;
      list.push(item);
      return route.fulfill({ status: 201, json: item });
    });
  }
}

// ════════════════════════════════════════════════
// HELPERS DE UI
// ════════════════════════════════════════════════
async function goToApp(page) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle[title="Settings"]');
}

// Abre Configurações (se ainda não estiver aberta) e a aba "Database".
async function openDatabasePane(page) {
  if ((await page.locator('.settings-modal-box').count()) === 0) {
    await page.click('.theme-toggle[title="Settings"]');
    await page.waitForSelector('.settings-modal-box');
  }
  await page.locator('.settings-nav-btn', { hasText: 'Database' }).click();
  await page.locator('.settings-content .set-label', { hasText: 'Commands' }).waitFor();
}

const exportModalLoc = page => page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Export commands' }) });
const importModalLoc = page => page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Import commands' }) });

async function openExportModal(page) {
  await openDatabasePane(page);
  await page.locator('.settings-content button', { hasText: 'Export commands' }).click();
  const modal = exportModalLoc(page);
  await modal.waitFor();
  return modal;
}

async function openImportModal(page) {
  await openDatabasePane(page);
  await page.locator('.settings-content button', { hasText: 'Import commands' }).click();
  const modal = importModalLoc(page);
  await modal.waitFor();
  return modal;
}

const COLS = ['Name', 'Description', 'Details', 'Vendor', 'System', 'Topics', 'Versions', 'Environments', 'Prompt', 'Exportable', 'Command'];
const COL_KEYS = ['name', 'desc', 'details', 'vendors', 'systems', 'topic', 'versions', 'environments', 'prompt', 'exportable', 'command'];

const colRow = (modal, header) => modal.locator('.exp-col-row', { hasText: new RegExp(`^${header}$`) });
const exportBtn = modal => modal.locator('.modal-foot .btn-primary');
const selectAllBtn = modal => modal.locator('button', { hasText: /^Select all$/ });
const deselectAllBtn = modal => modal.locator('button', { hasText: /^Deselect all$/ });
const scopeBtn = (modal, label) => modal.locator('.seg-btn', { hasText: new RegExp(`^${label}$`) });
async function checkedHeaders(modal) {
  return modal.locator('.exp-col-row').evaluateAll(rows => rows.filter(r => r.querySelector('input').checked).map(r => r.textContent.trim()));
}
async function activeScopeLabels(modal) {
  return modal.locator('.seg-btn.on').allTextContents();
}
const ls = (page, key) => page.evaluate(k => localStorage.getItem(k), key);

// Clica "Export" e devolve o download lido: { name, buf, text }.
async function exportAndRead(page, modal) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 6000 }), exportBtn(modal).click()]);
  const buf = readFileSync(await dl.path());
  return { name: dl.suggestedFilename(), buf, text: buf.toString('utf8') };
}

// Seleciona só as colunas pedidas (Deselect all + marcar uma a uma, na ordem dada).
async function chooseColumns(modal, headers) {
  await deselectAllBtn(modal).click();
  for (const h of headers) await colRow(modal, h).locator('input').check();
}

const today = () => new Date().toISOString().slice(0, 10);

// ── CSV de teste (escape independente do código do app) ──
const H = COLS;
function mkRow(o = {}) {
  return {
    Name: 'Cmd A', Description: 'desc A', Details: '', Vendor: 'Check Point', System: 'Gaia', Topics: 'System Monitoring',
    Versions: 'R82', Environments: 'Standalone', Prompt: '', Exportable: '', Command: 'cpwd_admin list', ...o,
  };
}
function toCsv(rows, { headers = H, bom = true, eol = '\r\n', trailingEol = false } = {}) {
  const esc = v => (/[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const lines = [headers.join(';'), ...rows.map(r => headers.map(h => esc(r[h] === undefined ? '' : r[h])).join(';'))];
  return (bom ? '﻿' : '') + lines.join(eol) + (trailingEol ? eol : '');
}
const csvFile = (name, rows, opts) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(toCsv(rows, opts), 'utf8') });
const rawFile = (name, text) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });

async function upload(imp, file) {
  await imp.locator('input[type="file"]').setInputFiles(file);
}
const importBtn = imp => imp.locator('.modal-foot .btn-primary');
const readyHint = imp => imp.locator('.set-hint', { hasText: /rows? ready\. Click Import/ });
async function waitReady(imp, expectedText, msg) {
  await assertEventually(async () => (await readyHint(imp).count()) === 1 && (await readyHint(imp).textContent()) === expectedText, msg);
}
async function readReport(imp) {
  return imp.locator('.imp-report-row').evaluateAll(els =>
    els.map(e => ({
      line: e.querySelector('.imp-report-line').textContent,
      name: e.querySelector('.imp-report-name').textContent,
      msg: e.querySelector('.imp-report-msg').textContent,
      err: e.classList.contains('imp-report-row-err'),
    }))
  );
}
const reportTitle = imp => imp.locator('.set-group:has(.imp-report-list) > .set-label').textContent();

async function clickImportAndWaitReport(imp) {
  await importBtn(imp).click();
  await imp.locator('.imp-report-row').first().waitFor({ timeout: 6000 });
}

// Painel de resolução
const panelLoc = imp => imp.locator('.imp-res-panel');
const sectionTitles = imp => imp.locator('.imp-res-section > .set-label').allTextContents();
function resRow(page, imp, raw) {
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return imp.locator('.imp-res-row').filter({ has: page.locator('.imp-res-raw', { hasText: new RegExp(`^"${esc}" —`) }) });
}
const applyBtn = imp => imp.locator('.imp-res-actions button', { hasText: /Apply|Applying/ });
const skipBtn = imp => imp.locator('.imp-res-actions button', { hasText: 'Import anyway (skip unresolved)' });
const optionTexts = sel => sel.locator('option').allTextContents();

// Linhas de comando no formato do POST /api/commands
const L = (i, content, o = {}) => ({ sort_order: i, line_type: 'cmd', prompt: '[Expert@FW]#', content, export_template: null, image_data: null, variant: 'default', ...o });
// Compara só o subconjunto do payload que existe no original (+ checa os 3 campos extras do React = null).
function payloadCore(b) {
  return { name: b.name, desc: b.desc, details: b.details, topics: b.topics, vendors: b.vendors, systems: b.systems, versions: b.versions, environments: b.environments, lines: b.lines };
}
const noExtras = b => (b.placeholder_resolver ?? null) === null && (b.name_empty ?? null) === null && (b.desc_empty ?? null) === null;

const browser = await chromium.launch();

// ════════════════════════════════════════════════
// A — EXPORT
// ════════════════════════════════════════════════

// ── Cenário 1: grupo Commands visível pra usuário comum; modal abre com 11 colunas marcadas e escopo All ──
await withPage(browser, async page => {
  await mockApp(page, makeState(), { isAdmin: false });
  await goToApp(page);
  await openDatabasePane(page);
  const content = page.locator('.settings-content');
  assert((await content.locator('button', { hasText: 'Export commands' }).count()) === 1, 'cenário 1: usuário comum vê o botão "Export commands"');
  assert((await content.locator('button', { hasText: 'Import commands' }).count()) === 1, 'cenário 1: usuário comum vê o botão "Import commands"');
  assert((await content.locator('#sysGroupDatabase').count()) === 0, 'cenário 1: o grupo admin-only "Database" (Backup) NÃO aparece pra usuário comum');

  const modal = await openExportModal(page);
  const headers = (await modal.locator('.exp-col-row span').allTextContents()).map(s => s.trim());
  assert(eq(headers, COLS), `cenário 1: as 11 colunas na ordem canônica (lido: ${J(headers)})`);
  assert((await checkedHeaders(modal)).length === 11, 'cenário 1: todas as 11 colunas vêm marcadas por padrão');
  assert(eq(await activeScopeLabels(modal), ['All commands']), 'cenário 1: escopo "All commands" ativo por padrão (e só ele)');
  assert(eq((await modal.locator('.seg-btn').allTextContents()), ['All commands', 'System only', 'User only']), 'cenário 1: os 3 botões de escopo');
  assert((await modal.locator('.set-hint', { hasText: 'Which commands do you want to export?' }).count()) === 1, 'cenário 1: texto "Which commands do you want to export?"');
  assert((await modal.locator('.set-hint', { hasText: 'Choose which columns to include in the .csv file.' }).count()) === 1, 'cenário 1: texto "Choose which columns to include in the .csv file."');
});

// ── Cenário 2: Select all / Deselect all; nenhuma coluna -> alert e modal continua ──
await withPage(browser, async page => {
  await mockApp(page, makeState({ commands: [mkCmd(1)] }), { isAdmin: false });
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  let downloads = 0;
  page.on('download', () => downloads++);
  await goToApp(page);
  const modal = await openExportModal(page);

  await deselectAllBtn(modal).click();
  assert((await checkedHeaders(modal)).length === 0, 'cenário 2: "Deselect all" desmarca todas as colunas');
  await selectAllBtn(modal).click();
  assert((await checkedHeaders(modal)).length === 11, 'cenário 2: "Select all" marca as 11 colunas');
  await deselectAllBtn(modal).click();

  await exportBtn(modal).click();
  await assertEventually(() => dialogs.length === 1, 'cenário 2: nenhuma coluna + Export dispara um alert');
  assert(dialogs[0] === 'Check at least one column to export.', `cenário 2: mensagem exata do alert (lida: ${J(dialogs[0])})`);
  assert((await modal.count()) === 1, 'cenário 2: o modal continua aberto depois do alert');
  assert((await ls(page, 'cpa-export-columns')) === null, 'cenário 2: a seleção vazia NÃO é gravada em localStorage');
  await sleep(300);
  assert(downloads === 0, 'cenário 2: nenhum download disparado');

  await colRow(modal, 'Name').locator('input').check();
  const out = await exportAndRead(page, modal);
  assert(out.text === '﻿Name\r\nCmd 1', `cenário 2: com 1 coluna marcada o export segue normalmente (lido: ${J(out.text)})`);
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 2: o modal fecha ao exportar');
});

// ── Cenário 3: seleção e escopo lembrados em localStorage e restaurados ──
await withPage(browser, async page => {
  await mockApp(page, makeState({ commands: [mkCmd(1)] }), { isAdmin: false });
  await goToApp(page);
  let modal = await openExportModal(page);

  await chooseColumns(modal, ['Command', 'Vendor', 'Name']); // ordem de clique != ordem canônica
  await scopeBtn(modal, 'User only').click();
  assert((await ls(page, 'cpa-export-scope')) === 'user', 'cenário 3: o escopo é gravado NA HORA do clique (como o setExportScopeSeg do original)');
  await exportAndRead(page, modal);
  assert((await ls(page, 'cpa-export-columns')) === J(['name', 'vendors', 'command']), `cenário 3: cpa-export-columns grava as keys na ordem canônica (lido: ${await ls(page, 'cpa-export-columns')})`);
  assert((await ls(page, 'cpa-export-scope')) === 'user', 'cenário 3: cpa-export-scope = "user" após exportar');

  modal = await openExportModal(page);
  assert(eq(await checkedHeaders(modal), ['Name', 'Vendor', 'Command']), 'cenário 3: ao reabrir só Name/Vendor/Command seguem marcadas');
  assert(eq(await activeScopeLabels(modal), ['User only']), 'cenário 3: ao reabrir "User only" segue ativo');

  await scopeBtn(modal, 'System only').click();
  await modal.locator('.modal-close').click();
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 3: ✕ fecha o modal');
  assert((await ls(page, 'cpa-export-scope')) === 'system', 'cenário 3: trocar o escopo e fechar sem exportar ainda lembra o último escopo');
  modal = await openExportModal(page);
  assert(eq(await activeScopeLabels(modal), ['System only']), 'cenário 3: reabrir mostra "System only"');
});

// ── Cenário 4: valores inválidos/desconhecidos em localStorage são ignorados ──
await withPage(browser, async page => {
  await mockApp(page, makeState(), { isAdmin: false });
  await goToApp(page);
  const seedAndOpen = async (cols, scope) => {
    await page.evaluate(([c, s]) => {
      if (c === null) localStorage.removeItem('cpa-export-columns'); else localStorage.setItem('cpa-export-columns', c);
      if (s === null) localStorage.removeItem('cpa-export-scope'); else localStorage.setItem('cpa-export-scope', s);
    }, [cols, scope]);
    const modal = await openExportModal(page);
    const res = { checked: await checkedHeaders(modal), scope: await activeScopeLabels(modal) };
    await modal.locator('.modal-close').click();
    await modal.waitFor({ state: 'detached' });
    return res;
  };
  let r = await seedAndOpen('{not json', 'bogus');
  assert(r.checked.length === 11 && eq(r.scope, ['All commands']), 'cenário 4: JSON inválido + escopo inválido ("bogus") -> todas as colunas e escopo All');
  r = await seedAndOpen('["name","zzz","command"]', 'system');
  assert(eq(r.checked, ['Name', 'Command']), `cenário 4: keys desconhecidas são ignoradas (marcadas: ${J(r.checked)})`);
  assert(eq(r.scope, ['System only']), 'cenário 4: escopo "system" válido é restaurado');
  r = await seedAndOpen('{"a":1}', 'user');
  assert(r.checked.length === 11, 'cenário 4: JSON que não é array cai no padrão (todas marcadas)');
  assert(eq(r.scope, ['User only']), 'cenário 4: escopo "user" válido é restaurado');
  r = await seedAndOpen('[]', null);
  assert(r.checked.length === 0, 'cenário 4: array vazio salvo = nenhuma coluna marcada (igual ao original)');
  assert(eq(r.scope, ['All commands']), 'cenário 4: sem escopo salvo -> All');
});

// ── Cenário 5: conteúdo exato do .csv (BOM, ';', CRLF, escape, rótulos x keys, Prompt/Exportable/Command) ──
await withPage(browser, async page => {
  const c1 = mkCmd(1, {
    name: 'Show; "quoted" name', desc: 'line1\nline2', details: '<p>Use <b>fw</b>; carefully</p>',
    vendors: ['checkpoint'], systems: ['gaia'], topics: ['sysmon', 'unknown_topic'],
    versions: ['ver_r82', 'ver_r8110'], environments: ['env_standalone', 'env_cluster'],
    lines: {
      default: [
        cmdLine({ prompt: '[Expert@FW]#', content: ' fw ctl zdebug ', export_template: '> {{logFile}}' }),
        cmdLine({ line_type: 'warn', content: 'careful' }),
        cmdLine({ prompt: '[Expert@FW]#', content: 'cpwd_admin list', export_template: '> {{logFile}}' }),
      ],
      empty: [cmdLine({ prompt: 'X#', content: 'ignored-empty-variant', export_template: null })],
    },
  });
  const c2 = mkCmd(2, {
    name: 'Plain two', desc: 'd2', details: null, vendors: ['fortinet'], systems: ['fortios'], topics: ['status'],
    versions: ['ver_fos7'], environments: ['env_fos'],
    lines: { default: [cmdLine({ prompt: 'A#', content: 'c1', export_template: null }), cmdLine({ prompt: 'B#', content: 'c2', export_template: '> {{logFile}}' })], empty: [] },
  });
  const c3 = mkCmd(3, {
    name: 'Only info', desc: 'd3', topics: ['status'], vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [cmdLine({ line_type: 'info', content: 'just text' })], empty: [] },
  });
  const c4 = mkCmd(4, {
    name: 'Ws export', desc: '', lines: { default: [cmdLine({ prompt: '#', content: 'ls', export_template: '   ' })], empty: [] },
  });
  await mockApp(page, makeState({ commands: [c1, c2, c3, c4] }), { isAdmin: false });
  await goToApp(page);
  const modal = await openExportModal(page);
  const out = await exportAndRead(page, modal);

  const expected =
    '﻿' +
    [
      'Name;Description;Details;Vendor;System;Topics;Versions;Environments;Prompt;Exportable;Command',
      '"Show; ""quoted"" name";"line1\nline2";"<p>Use <b>fw</b>; carefully</p>";Check Point;Gaia;System Monitoring, unknown_topic;ver_r82, ver_r8110;env_standalone, env_cluster;[Expert@FW]#;Yes;"fw ctl zdebug\ncpwd_admin list"',
      'Plain two;d2;;Fortinet;FortiOS;Status;ver_fos7;env_fos;A#, B#;No;"c1\nc2"',
      'Only info;d3;;;;Status;;;;No;',
      'Ws export;;;Check Point;Gaia;System Monitoring;ver_r82;env_standalone;#;No;ls',
    ].join('\r\n');
  assert(out.buf[0] === 0xef && out.buf[1] === 0xbb && out.buf[2] === 0xbf, 'cenário 5: o arquivo começa com o BOM UTF-8 (EF BB BF)');
  assert(out.text === expected, `cenário 5: conteúdo EXATO do .csv.\n  esperado: ${J(expected)}\n  lido:     ${J(out.text)}`);
  assert(!out.text.endsWith('\r\n'), 'cenário 5: sem CRLF sobrando no fim do arquivo');
  assert(out.text.includes('"Show; ""quoted"" name"'), 'cenário 5: célula com ";" e aspas -> entre aspas, aspas dobradas');
  assert(out.text.includes('Check Point;Gaia;System Monitoring, unknown_topic;ver_r82, ver_r8110;env_standalone, env_cluster'), 'cenário 5: Vendor/System/Topics por RÓTULO (key de tópico desconhecido como fallback); Versions/Environments pelas KEYS');
  assert(out.text.includes(';[Expert@FW]#;Yes;"fw ctl zdebug\ncpwd_admin list"'), 'cenário 5: Prompt = valor único, Exportable "Yes" (todas as linhas cmd), Command só linhas cmd (trim)');
  assert(out.text.includes(';A#, B#;No;"c1\nc2"'), 'cenário 5: prompts distintos unidos por ", " e Exportable "No" quando só parte tem template');
  assert(!out.text.includes('careful;') && !out.text.includes('just text') && !out.text.includes('ignored-empty-variant'), 'cenário 5: linhas warn/info e a variante "empty" ficam fora do Command');
  assert(out.name === `toolbox45-commands-${today()}.csv`, `cenário 5: nome do arquivo sem sufixo pra "All" (lido: ${out.name})`);
  // Exportable: sem linhas cmd -> No
  assert(out.text.includes('Only info;d3;;;;Status;;;;No;'), 'cenário 5: comando sem linhas "cmd" -> Exportable "No"');
});

// ── Cenário 6: escopos System/User filtram por is_system e mudam o nome; subconjunto sai em ordem canônica ──
await withPage(browser, async page => {
  const cmds = [
    mkCmd(1, { name: 'Sys One', is_system: true }),
    mkCmd(2, { name: 'User One', is_system: false }),
    mkCmd(3, { name: 'Sys Two', is_system: true }),
    mkCmd(4, { name: 'User Two', is_system: false }),
    mkCmd(5, { name: 'User Three', is_system: false }),
  ];
  await mockApp(page, makeState({ commands: cmds }), { isAdmin: false });
  await goToApp(page);

  let modal = await openExportModal(page);
  await chooseColumns(modal, ['Name']);
  let out = await exportAndRead(page, modal);
  assert(out.text === '﻿Name\r\nSys One\r\nUser One\r\nSys Two\r\nUser Two\r\nUser Three', `cenário 6: escopo All exporta os 5 comandos (lido: ${J(out.text)})`);
  assert(out.name === `toolbox45-commands-${today()}.csv`, 'cenário 6: nome sem sufixo pra All');

  modal = await openExportModal(page);
  await scopeBtn(modal, 'System only').click();
  out = await exportAndRead(page, modal);
  assert(out.text === '﻿Name\r\nSys One\r\nSys Two', `cenário 6: "System only" exporta só is_system (lido: ${J(out.text)})`);
  assert(out.name === `toolbox45-commands-system-${today()}.csv`, `cenário 6: nome com sufixo -system- (lido: ${out.name})`);

  modal = await openExportModal(page);
  await scopeBtn(modal, 'User only').click();
  out = await exportAndRead(page, modal);
  assert(out.text === '﻿Name\r\nUser One\r\nUser Two\r\nUser Three', `cenário 6: "User only" exporta só !is_system (lido: ${J(out.text)})`);
  assert(out.name === `toolbox45-commands-user-${today()}.csv`, `cenário 6: nome com sufixo -user- (lido: ${out.name})`);

  modal = await openExportModal(page);
  await scopeBtn(modal, 'All commands').click();
  await chooseColumns(modal, ['Command', 'Name']); // clicadas na ordem inversa
  out = await exportAndRead(page, modal);
  assert(out.text.split('\r\n')[0] === '﻿Name;Command', `cenário 6: subconjunto de colunas sai na ordem canônica (cabeçalho lido: ${J(out.text.split('\r\n')[0])})`);
  assert(out.text.split('\r\n')[1] === 'Sys One;echo 1', 'cenário 6: a linha de dados acompanha as colunas escolhidas');
});

// ── Cenário 7: falha ao buscar comandos (500) -> alert; depois um novo export funciona ──
await withPage(browser, async page => {
  const state = makeState({ commands: [mkCmd(1)], failCommandsGet: true });
  await mockApp(page, state, { isAdmin: false });
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  let downloads = 0;
  page.on('download', () => downloads++);
  await goToApp(page);
  const modal = await openExportModal(page);
  await exportBtn(modal).click();
  await assertEventually(() => dialogs.length === 1, 'cenário 7: GET /api/commands 500 dispara um alert');
  assert(dialogs[0] === 'Failed to export the CSV. Please try again.', `cenário 7: mensagem exata (lida: ${J(dialogs[0])})`);
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 7: o modal já tinha fechado antes da falha (igual ao original)');
  assert(downloads === 0, 'cenário 7: nenhum download disparado na falha');

  state.failCommandsGet = false;
  const modal2 = await openExportModal(page);
  const out = await exportAndRead(page, modal2);
  assert(out.text.startsWith('﻿Name;Description;'), 'cenário 7: o servidor se recupera -> novo export baixa normalmente (falha não ficou em cache)');
  assert(dialogs.length === 1, 'cenário 7: nenhum alert novo no segundo export');
});

// ── Cenário 8: fechar por ✕, clique no fundo e Escape não baixa nada ──
await withPage(browser, async page => {
  await mockApp(page, makeState({ commands: [mkCmd(1)] }), { isAdmin: false });
  let downloads = 0;
  page.on('download', () => downloads++);
  await goToApp(page);

  let modal = await openExportModal(page);
  await modal.locator('.modal-close').click();
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 8: ✕ fecha o modal de export');

  modal = await openExportModal(page);
  await page.locator('.modal-overlay', { has: modal }).click({ position: { x: 4, y: 4 } });
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 8: clique no fundo fecha o modal de export');
  assert((await page.locator('.settings-modal-box').count()) === 1, 'cenário 8: o clique no fundo do export NÃO fecha as Configurações por trás');

  modal = await openExportModal(page);
  await page.keyboard.press('Escape');
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 8: Escape fecha o modal de export');
  await sleep(300);
  assert(downloads === 0, 'cenário 8: nenhum download disparado ao fechar por ✕/fundo/Escape');
});

// ════════════════════════════════════════════════
// B — IMPORT: base
// ════════════════════════════════════════════════

// ── Cenário 9: template (.csv) ──
await withPage(browser, async page => {
  await mockApp(page, makeState(), { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 6000 }), imp.locator('button', { hasText: 'Download template (.csv)' }).click()]);
  const buf = readFileSync(await dl.path());
  const text = buf.toString('utf8');
  const expected =
    '﻿' + COLS.join(';') + '\r\n' +
    'Check WatchDog process status;Shows whether a monitored WatchDog process is alive;Confirms a critical process (fwd, cpd, etc.) is being watched and running. After a restart, or when troubleshooting a service that keeps failing.;Check Point;Gaia;System Monitoring;R82;Standalone;[Expert@FW]#;No;cpwd_admin list';
  assert(dl.suggestedFilename() === 'toolbox45-template.csv', `cenário 9: nome do template (lido: ${dl.suggestedFilename()})`);
  assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'cenário 9: o template começa com BOM UTF-8');
  assert(text.split('\r\n')[0] === '﻿' + COLS.join(';'), 'cenário 9: cabeçalho de 11 colunas separado por ";" (sem coluna Note)');
  assert(text === expected, `cenário 9: conteúdo exato do template (cabeçalho + linha de exemplo, separados por CRLF).\n  lido: ${J(text)}`);
  assert(!text.split('\r\n')[0].includes('Note'), 'cenário 9: o template não inclui mais a coluna legada "Note"');
});

// ── Cenário 10: estado inicial do modal de import (dica, Import desabilitado, sem checkbox pra usuário comum) ──
await withPage(browser, async page => {
  await mockApp(page, makeState(), { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  const HINT =
    "Bulk-create commands from a .csv file. Not sure how to fill it in? Download the template below — it has the exact columns expected, with a filled-in example row. If Vendor/System/Version/Environment/Topics don't match anything registered yet, you'll be able to create them or map them to an existing item right here before importing. Imported commands are created as your own by default and can be edited/deleted normally afterwards.";
  const hint = (await imp.locator('.modal-body > .set-hint').first().textContent()).trim();
  assert(hint === HINT, `cenário 10: texto de dica exato (o curto de csv-import.js) — lido: ${J(hint)}`);
  assert(await importBtn(imp).isDisabled(), 'cenário 10: botão Import nasce desabilitado');
  assert((await imp.locator('input[type="file"]').getAttribute('accept')) === '.csv,text/csv', 'cenário 10: input de arquivo aceita .csv,text/csv');
  assert((await imp.locator('.set-label', { hasText: 'CSV file' }).count()) === 1, 'cenário 10: rótulo "CSV file"');
  assert((await imp.locator('.set-check-row').count()) === 0, 'cenário 10: usuário comum NUNCA vê o checkbox "Import as System commands"');
  assert((await imp.locator('.imp-res-panel').count()) === 0 && (await imp.locator('.imp-report-row').count()) === 0, 'cenário 10: sem painel de resolução nem relatório ao abrir');
  await imp.locator('.modal-foot button', { hasText: 'Close' }).click();
  await assertEventually(async () => (await imp.count()) === 0, 'cenário 10: botão "Close" fecha o modal');
});

// ── Cenário 11: arquivo sem linhas / vazio / limpar o arquivo ──
await withPage(browser, async page => {
  await mockApp(page, makeState(), { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  const msg = () => imp.locator('.set-hint[style*="orange"], .set-hint[style*="--orange"]');

  await upload(imp, csvFile('empty.csv', []));
  await assertEventually(async () => (await imp.locator('.set-hint', { hasText: 'No rows found in "empty.csv".' }).count()) === 1, 'cenário 11: só cabeçalho -> \'No rows found in "empty.csv".\'');
  assert(await importBtn(imp).isDisabled(), 'cenário 11: Import segue desabilitado sem linhas');

  await upload(imp, rawFile('zero.csv', ''));
  await assertEventually(async () => (await imp.locator('.set-hint', { hasText: 'No rows found in "zero.csv".' }).count()) === 1, 'cenário 11: arquivo de 0 bytes -> \'No rows found in "zero.csv".\'');
  assert((await imp.locator('.set-hint', { hasText: 'No rows found in "empty.csv".' }).count()) === 0, 'cenário 11: a mensagem do arquivo anterior some');
  void msg;

  await upload(imp, csvFile('one.csv', [mkRow()]));
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 11: arquivo válido libera o estado "1 row ready"');
  await imp.locator('input[type="file"]').setInputFiles([]);
  await assertEventually(async () => (await readyHint(imp).count()) === 0, 'cenário 11: limpar a escolha do arquivo apaga o resumo');
  assert(await importBtn(imp).isDisabled(), 'cenário 11: ... e desabilita Import de novo');
});

// ── Cenário 12: checkbox "Import as System commands" só pra admin; reabre desmarcado; header X-Save-As-System ──
for (const role of [{ isAdmin: true, isSuperAdmin: false, label: 'admin' }, { isAdmin: true, isSuperAdmin: true, label: 'super_admin' }]) {
  await withPage(browser, async page => {
    const state = makeState();
    await mockApp(page, state, role);
    await goToApp(page);
    let imp = await openImportModal(page);
    const chk = () => imp.locator('.set-check-row input[type="checkbox"]');
    await assertEventually(async () => (await chk().count()) === 1, `cenário 12 (${role.label}): o checkbox "Import as System commands" aparece`);
    assert((await imp.locator('.set-check-row').textContent()).trim() === 'Import as System commands', `cenário 12 (${role.label}): rótulo exato do checkbox`);
    assert(!(await chk().isChecked()), `cenário 12 (${role.label}): nasce desmarcado`);

    await upload(imp, csvFile('a.csv', [mkRow({ Name: 'Sys1' })]));
    await waitReady(imp, '1 row ready. Click Import to create it.', `cenário 12 (${role.label}): arquivo pronto`);
    await chk().check();
    await clickImportAndWaitReport(imp);
    assert(state.calls.commandPosts.length === 1 && state.calls.commandPosts[0].headers['x-save-as-system'] === '1', `cenário 12 (${role.label}): marcado -> POST leva X-Save-As-System: 1`);

    await imp.locator('.modal-close').click();
    await imp.waitFor({ state: 'detached' });
    imp = await openImportModal(page);
    assert(!(await chk().isChecked()), `cenário 12 (${role.label}): reabrir o modal -> checkbox volta desmarcado`);
    await upload(imp, csvFile('b.csv', [mkRow({ Name: 'Mine1' })]));
    await waitReady(imp, '1 row ready. Click Import to create it.', `cenário 12 (${role.label}): segundo arquivo pronto`);
    await clickImportAndWaitReport(imp);
    assert(state.calls.commandPosts.length === 2 && !('x-save-as-system' in state.calls.commandPosts[1].headers), `cenário 12 (${role.label}): desmarcado -> POST NÃO leva X-Save-As-System`);
  });
}
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('u.csv', [mkRow({ Name: 'User1' })]));
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 12 (user): arquivo pronto');
  await clickImportAndWaitReport(imp);
  assert((await imp.locator('.set-check-row').count()) === 0, 'cenário 12 (user): usuário comum não vê o checkbox em nenhum momento');
  assert(state.calls.commandPosts.length === 1 && !('x-save-as-system' in state.calls.commandPosts[0].headers), 'cenário 12 (user): POST nunca leva X-Save-As-System');
});

// ── Cenário 13: caminho feliz (3 linhas) — um POST por linha, em ordem, payload exato, relatório, refetch ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  const rows = [
    mkRow({ Name: 'Cmd A', Description: 'desc A', Details: '<p>det A</p>', Prompt: '', Exportable: 'Yes', Command: 'cpwd_admin list' }),
    mkRow({
      Name: 'Cmd B', Description: 'desc B', Vendor: 'fortinet', System: 'FORTIOS', Topics: 'Status', Versions: '7.0', Environments: 'FG-Single',
      Prompt: 'FGT # ', Exportable: 'no', Command: 'get system status\r\n\r\n  diag sys top  \r\n',
    }),
    mkRow({ Name: 'Cmd C', Topics: 'sysmon, status', Versions: 'R82, R81.10', Environments: 'Standalone, Cluster', Command: 'uptime' }),
  ];
  await upload(imp, csvFile('happy.csv', rows));
  await waitReady(imp, '3 rows ready. Click Import to create them.', 'cenário 13: "3 rows ready. Click Import to create them."');
  assert(!(await importBtn(imp).isDisabled()), 'cenário 13: Import habilitado no estado "ready"');
  assert((await panelLoc(imp).count()) === 0, 'cenário 13: tudo já existe no catálogo -> sem painel de resolução');
  assert(state.calls.commandPosts.length === 0, 'cenário 13: nada é enviado antes de clicar em Import');

  const getsBefore = state.calls.commandsGet;
  await clickImportAndWaitReport(imp);
  const posts = state.calls.commandPosts.map(p => p.body);
  assert(posts.length === 3, `cenário 13: um POST /api/commands por linha (houve ${posts.length})`);
  assert(eq(posts.map(p => p.name), ['Cmd A', 'Cmd B', 'Cmd C']), 'cenário 13: POSTs na ordem das linhas');
  assert(
    eq(payloadCore(posts[0]), {
      name: 'Cmd A', desc: 'desc A', details: '<p>det A</p>', topics: ['sysmon'], vendors: ['checkpoint'], systems: ['gaia'], versions: ['ver_r82'], environments: ['env_standalone'],
      lines: [L(0, 'cpwd_admin list', { export_template: '> {{logFile}}' })],
    }),
    `cenário 13: payload exato da linha 1 (keys do catálogo; Exportable=Yes -> '> {{logFile}}'; prompt vazio -> '[Expert@FW]#') — lido: ${J(payloadCore(posts[0]))}`
  );
  assert(
    eq(payloadCore(posts[1]), {
      name: 'Cmd B', desc: 'desc B', details: '', topics: ['status'], vendors: ['fortinet'], systems: ['fortios'], versions: ['ver_fos7'], environments: ['env_fos'],
      lines: [L(0, 'get system status', { prompt: 'FGT #' }), L(1, 'diag sys top', { prompt: 'FGT #' })],
    }),
    `cenário 13: linha 2 — casamento por key/label sem diferenciar caixa, célula Command multilinha -> linhas cmd sort_order 0..1 (CRLF e vazias descartadas), Exportable=no -> null — lido: ${J(payloadCore(posts[1]))}`
  );
  assert(
    eq(payloadCore(posts[2]), {
      name: 'Cmd C', desc: 'desc A', details: '', topics: ['sysmon', 'status'], vendors: ['checkpoint'], systems: ['gaia'], versions: ['ver_r82', 'ver_r8110'], environments: ['env_standalone', 'env_cluster'],
      lines: [L(0, 'uptime')],
    }),
    `cenário 13: linha 3 — múltiplos valores separados por vírgula viram arrays de keys — lido: ${J(payloadCore(posts[2]))}`
  );
  assert(posts.every(noExtras), 'cenário 13: placeholder_resolver/name_empty/desc_empty saem nulos');

  const report = await readReport(imp);
  assert(eq(report.map(r => r.line), ['Row 2', 'Row 3', 'Row 4']), `cenário 13: relatório numera "Row <n+2>" (lido: ${J(report.map(r => r.line))})`);
  assert(eq(report.map(r => r.name), ['Cmd A', 'Cmd B', 'Cmd C']) && report.every(r => r.msg === 'Imported' && !r.err), 'cenário 13: cada linha do relatório mostra o nome e "Imported"');
  assert((await reportTitle(imp)) === '3 imported', `cenário 13: título do relatório "3 imported" (sem ", N failed") — lido: ${J(await reportTitle(imp))}`);
  assert(await importBtn(imp).isDisabled(), 'cenário 13: ao fim o botão Import fica desabilitado');
  await assertEventually(() => state.calls.commandsGet > getsBefore, `cenário 13: a lista de comandos é recarregada (GET /api/commands: ${getsBefore} -> ${state.calls.commandsGet})`);
});

// ── Cenário 14: singular/plural do resumo ──
await withPage(browser, async page => {
  await mockApp(page, makeState(), { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('one.csv', [mkRow()]));
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 14: 1 linha -> "1 row ready. Click Import to create it."');
  await upload(imp, csvFile('two.csv', [mkRow({ Name: 'X1' }), mkRow({ Name: 'X2' })]));
  await waitReady(imp, '2 rows ready. Click Import to create them.', 'cenário 14: 2 linhas -> "2 rows ready. Click Import to create them."');
});

// ── Cenário 15: casamento de catálogo por key OU label, sem diferenciar caixa; Tópico por label; dedupe; tópico protegido ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('match.csv', [
    mkRow({ Name: 'ByKeyUpper', Vendor: 'CHECKPOINT', System: 'GAIA', Topics: 'SYSMON', Versions: 'VER_R82', Environments: 'ENV_STANDALONE' }),
    mkRow({ Name: 'ByLabelLower', Vendor: 'check point', System: 'gaia', Topics: 'system monitoring', Versions: 'r82', Environments: 'standalone' }),
    mkRow({ Name: 'TopicsDedupe', Topics: 'sysmon, STATUS, System Monitoring' }),
    mkRow({ Name: 'WithAllVersion', Versions: 'R82, all' }),
  ]));
  await waitReady(imp, '4 rows ready. Click Import to create them.', 'cenário 15: key ou label (qualquer caixa) resolvem direto, sem painel');
  await clickImportAndWaitReport(imp);
  const p = state.calls.commandPosts.map(x => x.body);
  const ids = b => [b.vendors, b.systems, b.topics, b.versions, b.environments];
  assert(eq(ids(p[0]), [['checkpoint'], ['gaia'], ['sysmon'], ['ver_r82'], ['env_standalone']]), `cenário 15: keys em MAIÚSCULAS casam (lido: ${J(ids(p[0]))})`);
  assert(eq(ids(p[1]), [['checkpoint'], ['gaia'], ['sysmon'], ['ver_r82'], ['env_standalone']]), `cenário 15: labels em minúsculas casam (lido: ${J(ids(p[1]))})`);
  assert(eq(p[2].topics, ['sysmon', 'status']), `cenário 15: tópicos repetidos (key e label do mesmo tópico) são deduplicados (lido: ${J(p[2].topics)})`);
  assert(eq(p[3].versions, ['ver_r82']), 'cenário 15: "all" dentro de uma lista de versões é descartado do payload (sem painel: o painel ignora "all")');
  const rep15 = await readReport(imp);
  assert(rep15.slice(0, 3).every(r => r.msg === 'Imported'), 'cenário 15: as 3 primeiras linhas importam sem aviso');
  assert(rep15[3].msg === 'Imported — Version "all" not found — ignored', `cenário 15: "all" no meio de uma lista (célula != "all") vira aviso "not found — ignored", como no original (lido: ${J(rep15[3].msg)})`);
});
await withPage(browser, async page => {
  await mockApp(page, makeState(), { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('protected.csv', [mkRow({ Topics: 'environment' }), mkRow({ Name: 'Other', Topics: 'Environment' })]));
  await assertEventually(async () => (await panelLoc(imp).count()) === 1, 'cenário 15b: o tópico protegido "environment" não é aceito -> abre o painel');
  assert(eq(await sectionTitles(imp), ['Topic not found (1)']), `cenário 15b: só a seção de tópico, com 1 valor (case-insensitive agrupa "environment"/"Environment") — lido: ${J(await sectionTitles(imp))}`);
  assert((await optionTexts(imp.locator('select.imp-res-choice').first())).join('|').includes('Environment') === false, 'cenário 15b: tópicos protegidos não aparecem nas opções de mapeamento');
});

// ── Cenário 16: Exportable (yes/true/1/x), prompt vazio, coluna legada Note ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  const headers = [...H, 'Note'];
  const exp = [['E1', 'YES'], ['E2', 'true'], ['E3', '1'], ['E4', 'x'], ['E5', 'X'], ['N1', 'No'], ['N2', ''], ['N3', 'false'], ['N4', '0'], ['N5', 'maybe'], ['N6', 'y']];
  const rows = [
    ...exp.map(([Name, Exportable]) => mkRow({ Name, Exportable })),
    mkRow({ Name: 'P1', Prompt: '' }),
    mkRow({ Name: 'P2', Prompt: 'FW>' }),
    mkRow({ Name: 'Nt', Command: 'a\nb', Note: '  legacy note  ' }),
  ].map(r => ({ ...r, Note: r.Note || '' }));
  await upload(imp, csvFile('flags.csv', rows, { headers }));
  await waitReady(imp, '14 rows ready. Click Import to create them.', 'cenário 16: 14 linhas prontas (coluna Note legada aceita)');
  await clickImportAndWaitReport(imp);
  const byName = n => state.calls.commandPosts.map(x => x.body).find(b => b.name === n);
  const T = '> {{logFile}}';
  for (const [n, v] of exp) {
    const want = ['E1', 'E2', 'E3', 'E4', 'E5'].includes(n) ? T : null;
    assert(byName(n).lines[0].export_template === want, `cenário 16: Exportable "${v}" -> export_template ${J(want)} (lido: ${J(byName(n).lines[0].export_template)})`);
  }
  assert(byName('P1').lines[0].prompt === '[Expert@FW]#', 'cenário 16: Prompt vazio -> "[Expert@FW]#"');
  assert(byName('P2').lines[0].prompt === 'FW>', 'cenário 16: Prompt informado é mantido');
  const nt = byName('Nt');
  assert(nt.lines.length === 3 && nt.lines[0].content === 'a' && nt.lines[1].content === 'b' && nt.lines[0].sort_order === 0 && nt.lines[1].sort_order === 1, 'cenário 16: Command de 2 linhas -> 2 linhas cmd com sort_order 0..1');
  const info = nt.lines[2];
  assert(info.line_type === 'info' && info.content === 'legacy note' && info.sort_order === 2 && (info.prompt ?? null) === null && (info.export_template ?? null) === null && (info.image_data ?? null) === null, `cenário 16: coluna Note vira linha extra "info" (trim, sort_order 2, sem prompt/export) — lido: ${J(info)}`);
  assert(nt.lines.slice(0, 2).every(l => l.variant === 'default' && l.image_data === null && l.line_type === 'cmd'), 'cenário 16: linhas cmd com variant "default" e image_data null');
});

// ── Cenário 17: validação por linha — mensagens exatas do original; linhas inválidas NÃO geram POST ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  const rows = [
    mkRow({ Name: '' }), // Row 2
    mkRow({ Name: 'NoTopic', Topics: '' }), // 3
    mkRow({ Name: 'NoVendor', Vendor: '' }), // 4
    mkRow({ Name: 'NoSystemAll', System: 'All' }), // 5
    mkRow({ Name: 'NoVersion', Versions: '' }), // 6
    mkRow({ Name: 'NoEnv', Environments: '' }), // 7
    mkRow({ Name: 'TwoVendors', Vendor: 'Check Point, Fortinet' }), // 8
    mkRow({ Name: 'TwoSystems', System: 'Gaia, FortiOS' }), // 9
    mkRow({ Name: 'NoCommand', Command: '' }), // 10
    mkRow({ Name: 'BlankCommand', Command: '  \n \n  ' }), // 11
    mkRow({ Name: 'Precedence', Topics: '', Vendor: '' }), // 12
    mkRow({ Name: '', Topics: '' }), // 13
    mkRow({ Name: 'VendorAll', Vendor: 'ALL' }), // 14
    mkRow({ Name: 'GoodRow' }), // 15
  ];
  await upload(imp, csvFile('invalid.csv', rows));
  await waitReady(imp, '14 rows ready. Click Import to create them.', 'cenário 17: "all"/vazios não geram painel -> 14 linhas prontas');
  await clickImportAndWaitReport(imp);
  const rep = await readReport(imp);
  const msgOf = line => (rep.find(r => r.line === line) || {}).msg;
  const nameOf = line => (rep.find(r => r.line === line) || {}).name;
  const V = {
    name: 'Missing "Name"',
    topics: 'No valid "Topics" (must match an existing topic)',
    vendor: 'No valid "Vendor" (exactly one is required — must match an existing vendor)',
    system: 'No valid "System" (exactly one is required — must match an existing system)',
    version: 'No valid "Version" (at least one is required — must match an existing version)',
    env: 'No valid "Environment" (at least one is required — must match an existing environment)',
    v2: '"Vendor" must have exactly one value, found 2 (checkpoint, fortinet) — a command belongs to a single vendor',
    s2: '"System" must have exactly one value, found 2 (gaia, fortios) — a command belongs to a single system',
    cmd: 'Missing "Command"',
  };
  assert(msgOf('Row 2') === V.name && nameOf('Row 2') === '(no name)', `cenário 17: Row 2 — ${V.name} / "(no name)" (lido: ${J(msgOf('Row 2'))} / ${J(nameOf('Row 2'))})`);
  assert(msgOf('Row 3') === V.topics, `cenário 17: Row 3 — Topics vazio (lido: ${J(msgOf('Row 3'))})`);
  assert(msgOf('Row 4') === V.vendor, `cenário 17: Row 4 — Vendor vazio (lido: ${J(msgOf('Row 4'))})`);
  assert(msgOf('Row 5') === V.system, `cenário 17: Row 5 — System "All" (lido: ${J(msgOf('Row 5'))})`);
  assert(msgOf('Row 6') === V.version, `cenário 17: Row 6 — Version vazio (lido: ${J(msgOf('Row 6'))})`);
  assert(msgOf('Row 7') === V.env, `cenário 17: Row 7 — Environment vazio (lido: ${J(msgOf('Row 7'))})`);
  assert(msgOf('Row 8') === V.v2, `cenário 17: Row 8 — mais de um Vendor (lido: ${J(msgOf('Row 8'))})`);
  assert(msgOf('Row 9') === V.s2, `cenário 17: Row 9 — mais de um System (lido: ${J(msgOf('Row 9'))})`);
  assert(msgOf('Row 10') === V.cmd, `cenário 17: Row 10 — Command vazio (lido: ${J(msgOf('Row 10'))})`);
  assert(msgOf('Row 11') === V.cmd, `cenário 17: Row 11 — Command só com espaços/quebras (lido: ${J(msgOf('Row 11'))})`);
  assert(msgOf('Row 12') === V.topics, `cenário 17: Row 12 — Topics é validado ANTES de Vendor (lido: ${J(msgOf('Row 12'))})`);
  assert(msgOf('Row 13') === V.name, `cenário 17: Row 13 — Name é validado ANTES de Topics (lido: ${J(msgOf('Row 13'))})`);
  assert(msgOf('Row 14') === V.vendor, `cenário 17: Row 14 — Vendor "ALL" (lido: ${J(msgOf('Row 14'))})`);
  assert(msgOf('Row 15') === 'Imported' && nameOf('Row 15') === 'GoodRow', 'cenário 17: Row 15 (válida) importa');
  assert(rep.filter(r => r.err).length === 13 && rep.filter(r => !r.err).length === 1, 'cenário 17: 13 linhas de erro (classe imp-report-row-err) e 1 ok');
  assert(state.calls.commandPosts.length === 1 && state.calls.commandPosts[0].body.name === 'GoodRow', `cenário 17: SÓ a linha válida gerou POST (houve ${state.calls.commandPosts.length})`);
  assert((await reportTitle(imp)) === '1 imported, 13 failed', `cenário 17: título "1 imported, 13 failed" (lido: ${J(await reportTitle(imp))})`);
});

// ── Cenário 18: erro do servidor (400/409/500) numa linha -> ok:false; as demais seguem ──
await withPage(browser, async page => {
  const state = makeState({
    commandPost: body => {
      if (body.name === 'Dup') return { status: 409, json: { error: 'conflict', message: 'Command "Dup" already exists' } };
      if (body.name === 'Bad') return { status: 400, json: { error: 'validation_error', message: '"name" is invalid' } };
      if (body.name === 'Boom') return { status: 500, body: 'oops' };
      return null;
    },
  });
  await mockApp(page, state, { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('srv.csv', [mkRow({ Name: 'Dup' }), mkRow({ Name: 'Bad' }), mkRow({ Name: 'Boom' }), mkRow({ Name: 'Fine' })]));
  await waitReady(imp, '4 rows ready. Click Import to create them.', 'cenário 18: 4 linhas prontas');
  await clickImportAndWaitReport(imp);
  const rep = await readReport(imp);
  assert(state.calls.commandPosts.length === 4, 'cenário 18: as 4 linhas foram enviadas (erro numa não interrompe as seguintes)');
  assert(rep[0].err && rep[0].msg.includes('Command "Dup" already exists'), `cenário 18: 409 -> ok:false com a mensagem do servidor (lido: ${J(rep[0].msg)})`);
  assert(rep[1].err && rep[1].msg.includes('"name" is invalid'), `cenário 18: 400 -> ok:false com a mensagem do servidor (lido: ${J(rep[1].msg)})`);
  assert(rep[2].err && rep[2].msg.trim().length > 0, `cenário 18: 500 sem message -> ok:false com alguma mensagem (lido: ${J(rep[2].msg)})`);
  assert(!rep[3].err && rep[3].msg === 'Imported', 'cenário 18: a linha seguinte ao erro importa normalmente');
  assert((await reportTitle(imp)) === '1 imported, 3 failed', `cenário 18: título "1 imported, 3 failed" (lido: ${J(await reportTitle(imp))})`);
  // DIVERGÊNCIA DELIBERADA (decidida na revisão da fatia 9): o original mostra
  // err.message com o prefixo interno `createCommand: HTTP 409 — ` (vazamento do
  // nome da função do cliente de API); o React usa o ApiError do cliente (mesmo
  // padrão do CommandEditorModal), que traz só a mensagem do servidor. Afirma a
  // versão limpa, sem o prefixo técnico.
  assert(rep[0].msg === 'Command "Dup" already exists', `cenário 18: 409 -> relatório mostra só a mensagem do servidor, sem o prefixo técnico do original (lido ${J(rep[0].msg)})`);
});

// ── Cenário 19: parser CSV — aspas, ';' e quebras em células, CRLF/LF, com/sem BOM, cabeçalhos em outra caixa, linhas em branco ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: false });
  await goToApp(page);
  const imp = await openImportModal(page);
  const text1 =
    '﻿ name ;DESCRIPTION;details;vendor;system;topics;versions;environments;prompt;exportable;command\r\n' +
    '"Show; ""it""";"line1\r\nline2";"<b>x;y</b>";Check Point;Gaia;System Monitoring;R82;Standalone;;;"cmd one\r\ncmd two"\r\n' +
    '\r\n' +
    'Plain;;;Check Point;Gaia;System Monitoring;R82;Standalone;;;ls';
  await upload(imp, rawFile('crlf-bom.csv', text1));
  await waitReady(imp, '2 rows ready. Click Import to create them.', 'cenário 19: BOM + CRLF + cabeçalhos em outra caixa/com espaços + linha em branco + sem quebra final -> 2 linhas');
  await clickImportAndWaitReport(imp);
  const p1 = state.calls.commandPosts.map(x => x.body);
  assert(p1.length === 2 && p1[0].name === 'Show; "it"', `cenário 19: nome com ";" e aspas dobradas -> 'Show; "it"' (lido: ${J(p1[0] && p1[0].name)})`);
  assert(p1[0].desc === 'line1\r\nline2', `cenário 19: quebra de linha dentro de célula entre aspas é preservada (lido: ${J(p1[0].desc)})`);
  assert(p1[0].details === '<b>x;y</b>', 'cenário 19: ";" dentro de aspas não separa colunas (Details intacto)');
  assert(eq(p1[0].lines.map(l => l.content), ['cmd one', 'cmd two']), 'cenário 19: célula Command com CRLF -> 2 linhas cmd sem "\\r"');
  assert(p1[1].name === 'Plain' && p1[1].desc === '', 'cenário 19: última linha sem quebra final é lida');

  const text2 = [H.join(';'), '"A ""quoted""; name";d;;Check Point;Gaia;System Monitoring;R82;Standalone;;;"x;y"', 'B;;;Check Point;Gaia;System Monitoring;R82;Standalone;;;pwd', ''].join('\n');
  await upload(imp, rawFile('lf-nobom.csv', text2));
  await waitReady(imp, '2 rows ready. Click Import to create them.', 'cenário 19: LF sem BOM, com quebra final -> 2 linhas');
  assert((await imp.locator('.imp-report-row').count()) === 0, 'cenário 19: escolher outro arquivo limpa o relatório anterior');
  await clickImportAndWaitReport(imp);
  const p2 = state.calls.commandPosts.slice(2).map(x => x.body);
  assert(p2[0].name === 'A "quoted"; name' && p2[0].lines[0].content === 'x;y', `cenário 19: aspas dobradas e ";" na célula Command (lido: ${J(p2[0].name)} / ${J(p2[0].lines[0].content)})`);
  assert(p2[1].name === 'B' && p2[1].lines[0].content === 'pwd', 'cenário 19: segunda linha do arquivo LF');
});

// ── Cenário 20: round-trip — o CSV gerado pelo export é aceito pelo import sem painel ──
await withPage(browser, async page => {
  const a = mkCmd(1, {
    name: 'RT; "one"', desc: 'multi\nline', details: '<p>a;b "c"</p>', topics: ['sysmon', 'status'],
    versions: ['ver_r82', 'ver_r8110'], environments: ['env_standalone', 'env_cluster'],
    lines: { default: [cmdLine({ prompt: '[Expert@FW]#', content: 'one', export_template: '> {{logFile}}' }), cmdLine({ prompt: '[Expert@FW]#', content: 'two', export_template: '> {{logFile}}' })], empty: [] },
  });
  const b = mkCmd(2, {
    name: 'RT two', desc: '', details: null, vendors: ['fortinet'], systems: ['fortios'], topics: ['status'], versions: ['ver_fos7'], environments: ['env_fos'],
    lines: { default: [cmdLine({ prompt: '[Expert@FW]#', content: 'get system status', export_template: null })], empty: [] },
  });
  const state = makeState({ commands: [a, b] });
  await mockApp(page, state, { isAdmin: false });
  await goToApp(page);
  const em = await openExportModal(page);
  const out = await exportAndRead(page, em);
  const imp = await openImportModal(page);
  await upload(imp, { name: out.name, mimeType: 'text/csv', buffer: out.buf });
  await waitReady(imp, '2 rows ready. Click Import to create them.', 'cenário 20: o .csv exportado (com BOM, CRLF, células entre aspas) é aceito pelo import: "2 rows ready"');
  assert((await panelLoc(imp).count()) === 0, 'cenário 20: sem painel de resolução (catálogo cobre rótulos e keys)');
  await clickImportAndWaitReport(imp);
  const p = state.calls.commandPosts.map(x => x.body);
  assert(
    eq(payloadCore(p[0]), {
      name: 'RT; "one"', desc: 'multi\nline', details: '<p>a;b "c"</p>', topics: ['sysmon', 'status'], vendors: ['checkpoint'], systems: ['gaia'], versions: ['ver_r82', 'ver_r8110'], environments: ['env_standalone', 'env_cluster'],
      lines: [L(0, 'one', { export_template: '> {{logFile}}' }), L(1, 'two', { export_template: '> {{logFile}}' })],
    }),
    `cenário 20: comando A reimportado idêntico (rótulos/keys/Exportable Yes) — lido: ${J(payloadCore(p[0]))}`
  );
  assert(
    eq(payloadCore(p[1]), {
      name: 'RT two', desc: '', details: '', topics: ['status'], vendors: ['fortinet'], systems: ['fortios'], versions: ['ver_fos7'], environments: ['env_fos'],
      lines: [L(0, 'get system status')],
    }),
    `cenário 20: comando B reimportado idêntico (Exportable No -> null) — lido: ${J(payloadCore(p[1]))}`
  );
  assert((await reportTitle(imp)) === '2 imported', 'cenário 20: "2 imported"');
});

// ════════════════════════════════════════════════
// C — PAINEL "Resolve unmatched values"
// ════════════════════════════════════════════════
const UNKNOWN_ROWS = () => [
  mkRow({ Name: 'N1', Vendor: 'Acme', System: 'Zeta', Topics: 'Network', Versions: '9.9', Environments: 'Lab', Command: 'show {{newparam}} {{other}}' }),
  mkRow({ Name: 'N2', Vendor: 'acme', System: 'Zeta', Topics: 'Network, System Monitoring', Versions: '9.9', Environments: 'Lab', Command: 'ping {{newparam}}' }),
  mkRow({ Name: 'N3', Vendor: 'Globex', System: 'Gaia', Topics: 'Status', Versions: 'R82', Environments: 'Standalone', Command: 'ls' }),
];

// ── Cenário 21: valores desconhecidos abrem o painel (seções, títulos, contagens, opções) ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('unknown.csv', UNKNOWN_ROWS()));
  await panelLoc(imp).waitFor();
  assert(await importBtn(imp).isDisabled(), 'cenário 21: com pendências o Import fica desabilitado');
  assert((await readyHint(imp).count()) === 0, 'cenário 21: não aparece "N row(s) ready" enquanto há pendências');
  assert(
    eq(await sectionTitles(imp), ['Vendors not found (2)', 'System not found (1)', 'Version not found (1)', 'Environment not found (1)', 'Topic not found (1)', 'Parameters not registered (2)']),
    `cenário 21: uma seção por tipo com pendência, na ordem vendor/system/version/environment/topic/parameter, com título no plural/singular correto — lido: ${J(await sectionTitles(imp))}`
  );
  assert(
    (await panelLoc(imp).locator('> .set-hint').first().textContent()).startsWith("Some values in this file don't match anything registered yet."),
    'cenário 21: texto de apresentação do painel'
  );
  const rawText = async (raw) => (await resRow(page, imp, raw).locator('.imp-res-raw').textContent()).trim();
  assert((await rawText('Acme')) === '"Acme" — used in 2 commands', `cenário 21: contagem plural "used in 2 commands" (valor de "Acme" e "acme" agrupados) — lido: ${J(await rawText('Acme'))}`);
  assert((await rawText('Globex')) === '"Globex" — used in 1 command', 'cenário 21: contagem singular "used in 1 command"');
  assert((await rawText('Network')) === '"Network" — used in 2 commands', 'cenário 21: tópico "Network" usado em 2 comandos');
  assert((await rawText('{{newparam}}')) === '"{{newparam}}" — used in 2 commands', 'cenário 21: parâmetro {{newparam}} usado em 2 comandos (conta por linha)');
  assert((await rawText('{{other}}')) === '"{{other}}" — used in 1 command', 'cenário 21: parâmetro {{other}} usado em 1 comando');
  assert((await resRow(page, imp, 'Zeta').count()) === 1, 'cenário 21: valor repetido em 2 linhas aparece uma vez só');

  const acme = resRow(page, imp, 'Acme');
  const choice = acme.locator('select.imp-res-choice');
  assert((await choice.inputValue()) === '__new__', 'cenário 21: opção padrão é "criar novo"');
  assert(eq(await optionTexts(choice), ['➕ Create new vendor: "Acme"', '──────────', 'Check Point', 'Fortinet']), `cenário 21: opções de vendor — lido: ${J(await optionTexts(choice))}`);
  assert((await acme.locator('.imp-res-extra input.set-input').inputValue()) === 'Acme', 'cenário 21: rótulo editável começa com o valor digitado');
  assert((await acme.locator('.imp-res-extra input.set-input').getAttribute('placeholder')) === 'Vendor name', 'cenário 21: placeholder "Vendor name"');
  assert((await acme.locator('input[type="color"]').inputValue()).toLowerCase() === '#8b949e', 'cenário 21: cor padrão #8B949E');

  const zeta = resRow(page, imp, 'Zeta');
  assert(eq(await optionTexts(zeta.locator('select.imp-res-choice')), ['➕ Create new system: "Zeta"', '──────────', 'Gaia (Check Point)', 'FortiOS (Fortinet)']), 'cenário 21: opções de system mostram o pai entre parênteses');
  assert(eq(await optionTexts(zeta.locator('select.imp-res-parent')), ['— choose Vendor —', 'Check Point', 'Fortinet', 'Acme (new, from this file)', 'Globex (new, from this file)']), `cenário 21: select de pai do system lista existentes + novos "(new, from this file)" — lido: ${J(await optionTexts(zeta.locator('select.imp-res-parent')))}`);
  const ver = resRow(page, imp, '9.9');
  assert(eq(await optionTexts(ver.locator('select.imp-res-choice')), ['➕ Create new version: "9.9"', '──────────', 'R82 (Gaia)', 'R81.10 (Gaia)', '7.0 (FortiOS)']), 'cenário 21: opções de version com o system entre parênteses');
  assert(eq(await optionTexts(ver.locator('select.imp-res-parent')), ['— choose System —', 'Gaia (Check Point)', 'FortiOS (Fortinet)', 'Zeta (new, from this file)']), 'cenário 21: pai da version = system (existentes + pendente)');
  const env = resRow(page, imp, 'Lab');
  assert(eq(await optionTexts(env.locator('select.imp-res-parent')), ['— choose System —', 'Gaia (Check Point)', 'FortiOS (Fortinet)', 'Zeta (new, from this file)']), 'cenário 21: pai do environment também é system');
  assert(eq(await optionTexts(env.locator('select.imp-res-choice')), ['➕ Create new environment: "Lab"', '──────────', 'Standalone', 'Cluster', 'FG-Single']), 'cenário 21: opções de environment');
  const topic = resRow(page, imp, 'Network');
  assert(eq(await optionTexts(topic.locator('select.imp-res-choice')), ['➕ Create new topic: "Network"', '──────────', 'System Monitoring', 'Status']), 'cenário 21: opções de topic (sem o protegido)');
  assert((await topic.locator('select.imp-res-parent').count()) === 0, 'cenário 21: tópico não tem pai');

  const par = resRow(page, imp, '{{newparam}}');
  assert(eq(await optionTexts(par.locator('select.imp-res-choice')), ['➕ Create new parameter: {{newparam}}', '──────────', 'Source IP ({{src_ip}})']), `cenário 21: opções de parâmetro — lido: ${J(await optionTexts(par.locator('select.imp-res-choice')))}`);
  assert((await par.locator('.imp-res-param-key').textContent()).replace(/\s+/g, ' ').trim() === 'Key: {{newparam}} (fixed — matches the token used in this file)', 'cenário 21: a key do parâmetro é fixa (texto "Key: {{token}} (fixed — ...)")');
  assert((await par.locator('.imp-res-extra input.set-input').inputValue()) === '' && (await par.locator('.imp-res-extra input.set-input').getAttribute('placeholder')) === 'Parameter description (e.g. Source IP)', 'cenário 21: rótulo do parâmetro começa vazio, com placeholder');
  assert((await par.locator('.imp-res-extra input').count()) === 1, 'cenário 21: parâmetro tem só 1 input (a key não é editável)');
  assert((await applyBtn(imp).textContent()).trim() === 'Apply & continue' && (await skipBtn(imp).count()) === 1, 'cenário 21: botões "Apply & continue" e "Import anyway (skip unresolved)"');
  assert(state.calls.catalogPosts.length === 0, 'cenário 21: abrir o painel não cria nada');
});
await withPage(browser, async page => {
  await mockApp(page, makeState(), { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('onlytopic.csv', [mkRow({ Topics: 'Network' })]));
  await panelLoc(imp).waitFor();
  assert(eq(await sectionTitles(imp), ['Topic not found (1)']), `cenário 21b: só a seção com pendência aparece (lido: ${J(await sectionTitles(imp))})`);
});
await withPage(browser, async page => {
  await mockApp(page, makeState(), { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('case.csv', [mkRow({ Command: 'show {{SRC_IP}} {{src_ip}}' })]));
  await panelLoc(imp).waitFor();
  assert(eq(await sectionTitles(imp), ['Parameter not registered (1)']), 'cenário 21c: parâmetro é case-sensitive — {{SRC_IP}} não casa com src_ip, {{src_ip}} sim');
  assert((await resRow(page, imp, '{{SRC_IP}}').count()) === 1, 'cenário 21c: só {{SRC_IP}} aparece como pendente');
});

// ── Cenário 22: criar vendor + system novos (ordem das chamadas, key do servidor, edição de rótulo/cor) + import ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('newvs.csv', [mkRow({ Name: 'NV1', Vendor: 'Acme', System: 'Acme OS' }), mkRow({ Name: 'NV2', Vendor: 'Acme', System: 'Acme OS' })]));
  await panelLoc(imp).waitFor();
  assert(eq(await sectionTitles(imp), ['Vendor not found (1)', 'System not found (1)']), 'cenário 22: seções Vendor e System');
  const v = resRow(page, imp, 'Acme');
  await v.locator('.imp-res-extra input.set-input').fill('Acme Inc');
  await v.locator('input[type="color"]').fill('#ff0000');
  const s = resRow(page, imp, 'Acme OS');
  await s.locator('select.imp-res-parent').selectOption({ label: 'Acme (new, from this file)' });

  const catsBefore = state.calls.catalogsGet;
  await applyBtn(imp).click();
  await waitReady(imp, '2 rows ready. Click Import to create them.', 'cenário 22: depois de "Apply & continue" -> "2 rows ready"');
  assert(eq(state.calls.catalogPosts.map(p => p.kind), ['vendors', 'systems']), `cenário 22: POST /api/vendors ANTES de POST /api/systems (ordem: ${J(state.calls.catalogPosts.map(p => p.kind))})`);
  assert(eq(state.calls.catalogPosts[0].body, { label: 'Acme Inc', color: '#ff0000' }), `cenário 22: corpo do vendor {label, color} editados (lido: ${J(state.calls.catalogPosts[0].body)})`);
  const sysBody = state.calls.catalogPosts[1].body;
  assert(sysBody.label === 'Acme OS' && sysBody.vendor === 'srv_acmeinc' && Object.keys(sysBody).sort().join() === 'color,label,vendor', `cenário 22: corpo do system {label, color, vendor} com vendor = key devolvida pelo servidor "srv_acmeinc" (lido: ${J(sysBody)})`);
  // No original a cor padrão vem de <input type=color>.value, que o navegador devolve em minúsculas.
  assert(sysBody.color === '#8b949e', `[ACHADO] cenário 22: cor padrão enviada pelo painel deve ser a do <input type="color"> do original ("#8b949e", minúsculas) — lido ${J(sysBody.color)}`);
  assert(state.calls.catalogsGet > catsBefore, `cenário 22: o catálogo é recarregado depois do Apply (GET /api/catalogs: ${catsBefore} -> ${state.calls.catalogsGet})`);
  assert((await panelLoc(imp).count()) === 0 && !(await importBtn(imp).isDisabled()), 'cenário 22: sem pendências restantes -> painel some e Import habilitado');
  assert((await imp.locator('.imp-res-errors').count()) === 0, 'cenário 22: sem erros');

  await clickImportAndWaitReport(imp);
  const p = state.calls.commandPosts.map(x => x.body);
  assert(p.length === 2 && eq(p.map(b => [b.vendors, b.systems]), [[['srv_acmeinc'], ['srv_acmeos']], [['srv_acmeinc'], ['srv_acmeos']]]), `cenário 22: o import usa as keys criadas pelo servidor (lido: ${J(p.map(b => [b.vendors, b.systems]))})`);
  assert((await readReport(imp)).every(r => r.msg === 'Imported'), 'cenário 22: todas as linhas importadas sem aviso');
});

// ── Cenário 23: cadeia vendor -> system -> version -> environment -> topic (+ rótulo vazio cai no valor em minúsculas) ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('chain.csv', [mkRow({ Name: 'Chain', Vendor: 'Acme', System: 'Acme OS', Versions: '1.0', Environments: 'Lab', Topics: 'Network' })]));
  await panelLoc(imp).waitFor();
  await resRow(page, imp, 'Acme').locator('.imp-res-extra input.set-input').fill('');
  await resRow(page, imp, 'Acme OS').locator('select.imp-res-parent').selectOption({ label: 'Acme (new, from this file)' });
  await resRow(page, imp, '1.0').locator('select.imp-res-parent').selectOption({ label: 'Acme OS (new, from this file)' });
  await resRow(page, imp, 'Lab').locator('select.imp-res-parent').selectOption({ label: 'Acme OS (new, from this file)' });
  await applyBtn(imp).click();
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 23: cadeia completa criada -> "1 row ready"');
  assert(eq(state.calls.catalogPosts.map(p => p.kind), ['vendors', 'systems', 'versions', 'environments', 'topics']), `cenário 23: ordem das criações vendor, system, version, environment, topic (lido: ${J(state.calls.catalogPosts.map(p => p.kind))})`);
  const b = state.calls.catalogPosts.map(p => p.body);
  assert(b[0].label === 'acme', `cenário 23: rótulo vazio cai no valor (normalizado em minúsculas, como o data-raw do original) — lido: ${J(b[0])}`);
  assert(b[1].vendor === 'srv_acme' && b[1].label === 'Acme OS', `cenário 23: system aponta pro vendor recém-criado (lido: ${J(b[1])})`);
  assert(b[2].system === 'srv_acmeos' && b[2].label === '1.0', `cenário 23: version aponta pro system recém-criado (lido: ${J(b[2])})`);
  assert(b[3].system === 'srv_acmeos' && b[3].label === 'Lab', `cenário 23: environment aponta pro system recém-criado (lido: ${J(b[3])})`);
  assert(b[4].label === 'Network' && Object.keys(b[4]).sort().join() === 'color,label', `cenário 23: topic {label, color} sem pai (lido: ${J(b[4])})`);
  assert(b[4].color === '#8b949e', `[ACHADO] cenário 23: cor padrão do topic deve ser a do <input type="color"> do original ("#8b949e", minúsculas) — lido ${J(b[4].color)}`);
  await clickImportAndWaitReport(imp);
  const p = state.calls.commandPosts[0].body;
  assert(eq([p.vendors, p.systems, p.versions, p.environments, p.topics], [['srv_acme'], ['srv_acmeos'], ['srv_10'], ['srv_lab'], ['srv_network']]), `cenário 23: o comando usa todas as keys criadas (lido: ${J([p.vendors, p.systems, p.versions, p.environments, p.topics])})`);
});

// ── Cenário 24: system/version sem pai -> erro 'Choose a ...', nada criado pra ele; segunda tentativa com pai existente ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('noparent.csv', [mkRow({ Name: 'NP', Vendor: 'Acme', System: 'Acme OS' })]));
  await panelLoc(imp).waitFor();
  // vendor novo (padrão), system novo SEM escolher o pai
  await applyBtn(imp).click();
  await assertEventually(async () => (await imp.locator('.imp-res-errors').count()) === 1, 'cenário 24: aparece o bloco de erros (.imp-res-errors)');
  const errs = await imp.locator('.imp-res-errors > div').allTextContents();
  assert(eq(errs, ['Choose a Vendor for "Acme OS"']), `cenário 24: erro 'Choose a Vendor for "Acme OS"' (lido: ${J(errs)})`);
  assert(eq(state.calls.catalogPosts.map(p => p.kind), ['vendors']), `cenário 24: só o vendor foi criado; nada para o system sem pai (lido: ${J(state.calls.catalogPosts.map(p => p.kind))})`);
  assert(eq(await sectionTitles(imp), ['System not found (1)']), `cenário 24: o painel reaparece só com o que sobrou (system) — lido: ${J(await sectionTitles(imp))}`);
  assert(await importBtn(imp).isDisabled(), 'cenário 24: Import continua desabilitado');
  const order = await imp.locator('.imp-res-errors').evaluate(el => !!(el.compareDocumentPosition(document.querySelector('.imp-res-panel')) & Node.DOCUMENT_POSITION_FOLLOWING));
  assert(order, 'cenário 24: os erros aparecem ACIMA do painel');

  // 2ª tentativa: pai = vendor existente
  await resRow(page, imp, 'Acme OS').locator('select.imp-res-parent').selectOption({ label: 'Check Point' });
  await applyBtn(imp).click();
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 24: 2ª tentativa com pai existente -> "1 row ready"');
  assert((await imp.locator('.imp-res-errors').count()) === 0, 'cenário 24: os erros anteriores somem');
  const sysPost = state.calls.catalogPosts.find(p => p.kind === 'systems');
  assert(sysPost && sysPost.body.vendor === 'checkpoint', `cenário 24: system criado sob "key:checkpoint" -> vendor = "checkpoint" (lido: ${J(sysPost && sysPost.body)})`);
  assert(eq(state.calls.catalogPosts.map(p => p.kind), ['vendors', 'systems']), 'cenário 24: total: 1 POST de vendor (1ª tentativa) + 1 de system (2ª)');
});
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('nover.csv', [mkRow({ Name: 'NVer', Versions: '9.9', Environments: 'Lab' })]));
  await panelLoc(imp).waitFor();
  await applyBtn(imp).click();
  await assertEventually(async () => (await imp.locator('.imp-res-errors').count()) === 1, 'cenário 24b: erros de version/environment sem pai');
  const errs = await imp.locator('.imp-res-errors > div').allTextContents();
  assert(eq(errs, ['Choose a System for "9.9"', 'Choose a System for "Lab"']), `cenário 24b: version e environment pedem um System (lido: ${J(errs)})`);
  assert(state.calls.catalogPosts.length === 0, 'cenário 24b: nada criado');
});

// ── Cenário 25: mapear pra item EXISTENTE grava o mapeamento sem POST; import usa a key mapeada ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('map.csv', [mkRow({ Name: 'M1', Vendor: 'CP', System: 'Gaia', Topics: 'Mon', Versions: '8110', Environments: 'Lab' })]));
  await panelLoc(imp).waitFor();
  assert(eq(await sectionTitles(imp), ['Vendor not found (1)', 'Version not found (1)', 'Environment not found (1)', 'Topic not found (1)']), `cenário 25: 4 seções (system "Gaia" já existe) — lido: ${J(await sectionTitles(imp))}`);
  const vRow = resRow(page, imp, 'CP');
  await vRow.locator('select.imp-res-choice').selectOption({ value: 'checkpoint' });
  await assertEventually(async () => (await vRow.locator('.imp-res-extra').count()) === 0 || !(await vRow.locator('.imp-res-extra').isVisible()), 'cenário 25: ao escolher item existente, rótulo/cor/pai ficam ocultos');
  await resRow(page, imp, '8110').locator('select.imp-res-choice').selectOption({ value: 'ver_r8110' });
  await resRow(page, imp, 'Lab').locator('select.imp-res-choice').selectOption({ value: 'env_cluster' });
  await resRow(page, imp, 'Mon').locator('select.imp-res-choice').selectOption({ value: 'sysmon' });
  await applyBtn(imp).click();
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 25: mapeamentos aplicados -> "1 row ready"');
  assert(state.calls.catalogPosts.length === 0, `cenário 25: mapear NÃO faz POST de catálogo (houve ${state.calls.catalogPosts.length})`);
  await clickImportAndWaitReport(imp);
  const p = state.calls.commandPosts[0].body;
  assert(eq([p.vendors, p.systems, p.topics, p.versions, p.environments], [['checkpoint'], ['gaia'], ['sysmon'], ['ver_r8110'], ['env_cluster']]), `cenário 25: o import usa as keys mapeadas (lido: ${J([p.vendors, p.systems, p.topics, p.versions, p.environments])})`);
  assert((await readReport(imp))[0].msg === 'Imported', 'cenário 25: importa sem avisos (valores mapeados contam como resolvidos)');
});

// ── Cenário 26: system novo cujo pai é um vendor MAPEADO pra existente ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('mapparent.csv', [mkRow({ Name: 'MP', Vendor: 'CP', System: 'Zeta' })]));
  await panelLoc(imp).waitFor();
  await resRow(page, imp, 'CP').locator('select.imp-res-choice').selectOption({ value: 'checkpoint' });
  await resRow(page, imp, 'Zeta').locator('select.imp-res-parent').selectOption({ label: 'CP (new, from this file)' });
  await applyBtn(imp).click();
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 26: system novo sob vendor mapeado -> "1 row ready"');
  assert(eq(state.calls.catalogPosts.map(p => [p.kind, p.body.vendor]), [['systems', 'checkpoint']]), `cenário 26: system criado com vendor = key mapeada, sem criar vendor (lido: ${J(state.calls.catalogPosts)})`);
});

// ── Cenário 27: parâmetros — criar (key fixa, label vazio cai no token) e mapear (reescreve o texto) ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('params.csv', [
    mkRow({ Name: 'Par1', Description: 'use {{srcip}} here', Details: '<p>{{srcip}}</p>', Command: 'show {{srcip}} {{newp}}\nls {{emptyp}}' }),
  ]));
  await panelLoc(imp).waitFor();
  assert(eq(await sectionTitles(imp), ['Parameters not registered (3)']), `cenário 27: só a seção de parâmetros, com 3 tokens (lido: ${J(await sectionTitles(imp))})`);
  assert((await resRow(page, imp, '{{srcip}}').locator('.imp-res-raw').textContent()).trim() === '"{{srcip}}" — used in 1 command', 'cenário 27: token usado em várias células da mesma linha conta 1 comando');
  await resRow(page, imp, '{{srcip}}').locator('select.imp-res-choice').selectOption({ value: 'src_ip' });
  await resRow(page, imp, '{{newp}}').locator('.imp-res-extra input.set-input').fill('New P');
  // {{emptyp}}: rótulo deixado vazio
  await applyBtn(imp).click();
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 27: parâmetros resolvidos -> "1 row ready"');
  assert(eq(state.calls.catalogPosts.map(p => [p.kind, p.body]), [['parameters', { key: 'newp', label: 'New P' }], ['parameters', { key: 'emptyp', label: 'emptyp' }]]), `cenário 27: POST /api/parameters {key: <token>, label}; label vazio cai no token; o mapeado não gera POST (lido: ${J(state.calls.catalogPosts)})`);
  await clickImportAndWaitReport(imp);
  const p = state.calls.commandPosts[0].body;
  assert(p.desc === 'use {{src_ip}} here' && p.details === '<p>{{src_ip}}</p>', `cenário 27: {{srcip}} -> {{src_ip}} reescrito em Description/Details (lido: ${J([p.desc, p.details])})`);
  assert(eq(p.lines.map(l => l.content), ['show {{src_ip}} {{newp}}', 'ls {{emptyp}}']), `cenário 27: ... e nas linhas de Command; tokens criados ficam como estão (lido: ${J(p.lines.map(l => l.content))})`);
  assert((await readReport(imp))[0].msg === 'Imported', 'cenário 27: sem avisos de parâmetro não cadastrado');
});

// ── Cenário 28: falha na criação (409 com message / rede / 500 sem JSON) -> erro acima do painel; painel só com o que sobrou ──
await withPage(browser, async page => {
  const state = makeState({
    createFail: (kind, body) => (kind === 'vendors' && body.label === 'Acme' ? { status: 409, json: { error: 'conflict', message: 'Vendor already exists' } } : null),
  });
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('fail.csv', [mkRow({ Name: 'F1', Vendor: 'Acme' }), mkRow({ Name: 'F2', Vendor: 'Globex' })]));
  await panelLoc(imp).waitFor();
  assert(eq(await sectionTitles(imp), ['Vendors not found (2)']), 'cenário 28: 2 vendors pendentes');
  const catsBefore = state.calls.catalogsGet;
  await applyBtn(imp).click();
  await assertEventually(async () => (await imp.locator('.imp-res-errors').count()) === 1, 'cenário 28: o erro aparece em .imp-res-errors');
  assert(eq(await imp.locator('.imp-res-errors > div').allTextContents(), ['"Acme": Vendor already exists']), `cenário 28: mensagem do servidor ao lado do item (lido: ${J(await imp.locator('.imp-res-errors > div').allTextContents())})`);
  assert(eq(await sectionTitles(imp), ['Vendor not found (1)']), `cenário 28: o painel reaparece só com o que sobrou — título singular (lido: ${J(await sectionTitles(imp))})`);
  assert((await resRow(page, imp, 'Acme').count()) === 1 && (await resRow(page, imp, 'Globex').count()) === 0, 'cenário 28: sobrou "Acme"; "Globex" (criado) saiu da lista');
  assert(state.calls.catalogsGet > catsBefore, 'cenário 28: o catálogo foi recarregado mesmo com falha parcial');
  assert(await importBtn(imp).isDisabled(), 'cenário 28: Import desabilitado enquanto sobra pendência');
  assert((await resRow(page, imp, 'Acme').locator('select.imp-res-choice').inputValue()) === '__new__', 'cenário 28: o painel remontado volta ao padrão "criar novo"');

  await resRow(page, imp, 'Acme').locator('select.imp-res-choice').selectOption({ value: 'checkpoint' });
  await applyBtn(imp).click();
  await waitReady(imp, '2 rows ready. Click Import to create them.', 'cenário 28: mapear o que falhou -> "2 rows ready"');
  assert((await imp.locator('.imp-res-errors').count()) === 0, 'cenário 28: o bloco de erro antigo some');
  await clickImportAndWaitReport(imp);
  const p = state.calls.commandPosts.map(x => x.body);
  assert(eq(p.map(b => b.vendors), [['checkpoint'], ['srv_globex']]), `cenário 28: F1 usa a key mapeada, F2 a key criada (lido: ${J(p.map(b => b.vendors))})`);
});
await withPage(browser, async page => {
  const state = makeState({ createFail: kind => (kind === 'topics' ? 'abort' : null) });
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('net.csv', [mkRow({ Topics: 'Network' })]));
  await panelLoc(imp).waitFor();
  await applyBtn(imp).click();
  await assertEventually(async () => (await imp.locator('.imp-res-errors').count()) === 1, 'cenário 28b: falha de rede -> bloco de erros');
  assert(eq(await imp.locator('.imp-res-errors > div').allTextContents(), ['"Network": something went wrong — check your connection and try again']), `cenário 28b: mensagem de rede (lido: ${J(await imp.locator('.imp-res-errors > div').allTextContents())})`);
  assert(eq(await sectionTitles(imp), ['Topic not found (1)']), 'cenário 28b: o tópico segue pendente');
});
await withPage(browser, async page => {
  const state = makeState({ createFail: kind => (kind === 'vendors' ? { status: 500, body: 'oops' } : null) });
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('f500.csv', [mkRow({ Vendor: 'Acme' })]));
  await panelLoc(imp).waitFor();
  await applyBtn(imp).click();
  await assertEventually(async () => (await imp.locator('.imp-res-errors').count()) === 1, 'cenário 28c: 500 sem JSON -> bloco de erros');
  assert(eq(await imp.locator('.imp-res-errors > div').allTextContents(), ['"Acme": failed to create']), `cenário 28c: sem message cai em "failed to create" (lido: ${J(await imp.locator('.imp-res-errors > div').allTextContents())})`);
});

// ── Cenário 29: "Import anyway (skip unresolved)" mantém o comportamento antigo ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  const imp = await openImportModal(page);
  await upload(imp, csvFile('skip.csv', [
    mkRow({ Name: 'SkipA', Vendor: 'Acme' }),
    mkRow({ Name: 'SkipB', Topics: 'System Monitoring, Bogus', Versions: 'R82, 9.9', Environments: 'Standalone, Lab', Command: 'echo {{zz}}' }),
  ]));
  await panelLoc(imp).waitFor();
  assert(eq(await sectionTitles(imp), ['Vendor not found (1)', 'Version not found (1)', 'Environment not found (1)', 'Topic not found (1)', 'Parameter not registered (1)']), `cenário 29: pendências de vendor/version/environment/topic/parameter — lido: ${J(await sectionTitles(imp))}`);
  await skipBtn(imp).click();
  await waitReady(imp, '2 rows ready. Click Import to create them.', 'cenário 29: "Import anyway" -> "2 rows ready"');
  assert((await panelLoc(imp).count()) === 0 && !(await importBtn(imp).isDisabled()), 'cenário 29: painel some e Import habilitado');
  assert(state.calls.catalogPosts.length === 0, 'cenário 29: nada é criado ao pular');
  await clickImportAndWaitReport(imp);
  const rep = await readReport(imp);
  assert(rep[0].err && rep[0].msg === 'No valid "Vendor" (exactly one is required — must match an existing vendor)', `cenário 29: linha com campo obrigatório vazio é rejeitada (lido: ${J(rep[0].msg)})`);
  const expectedMsg = 'Imported — Topic "Bogus" not found — ignored; Version "9.9" not found — ignored; Environment "Lab" not found — ignored; Parameter "{{zz}}" not registered — will show as a literal placeholder until you add it via Manage Parameters';
  assert(!rep[1].err && rep[1].msg === expectedMsg, `cenário 29: avisos por linha 'Imported — <aviso>; <aviso>' na ordem topic/version/environment/parameter (lido: ${J(rep[1].msg)})`);
  const p = state.calls.commandPosts[0].body;
  assert(state.calls.commandPosts.length === 1 && eq([p.topics, p.versions, p.environments], [['sysmon'], ['ver_r82'], ['env_standalone']]), `cenário 29: só a linha válida gera POST; valores não reconhecidos são descartados do payload (lido: ${J([p.topics, p.versions, p.environments])})`);
  assert((await reportTitle(imp)) === '1 imported, 1 failed', 'cenário 29: título "1 imported, 1 failed"');
});

// ── Cenário 30: escolher outro arquivo zera painel/relatório/mapeamentos; reabrir o modal começa limpo ──
await withPage(browser, async page => {
  const state = makeState();
  await mockApp(page, state, { isAdmin: true });
  await goToApp(page);
  let imp = await openImportModal(page);

  await upload(imp, csvFile('unk1.csv', [mkRow({ Vendor: 'CP' })]));
  await panelLoc(imp).waitFor();
  await upload(imp, csvFile('clean.csv', [mkRow({ Name: 'Clean' })]));
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 30: trocar por um arquivo limpo -> painel some e aparece "1 row ready"');
  assert((await panelLoc(imp).count()) === 0, 'cenário 30: o painel do arquivo anterior some');
  await clickImportAndWaitReport(imp);
  assert((await imp.locator('.imp-report-row').count()) === 1, 'cenário 30: relatório do import aparece');

  await upload(imp, csvFile('unk2.csv', [mkRow({ Vendor: 'CP' })]));
  await panelLoc(imp).waitFor();
  assert((await imp.locator('.imp-report-row').count()) === 0, 'cenário 30: escolher outro arquivo zera o relatório');
  assert(await importBtn(imp).isDisabled(), 'cenário 30: Import desabilitado com o novo painel');

  // mapeamento anterior não vaza: mapeia CP -> checkpoint, aplica, e depois escolhe de novo um arquivo com "CP"
  await resRow(page, imp, 'CP').locator('select.imp-res-choice').selectOption({ value: 'checkpoint' });
  await applyBtn(imp).click();
  await waitReady(imp, '1 row ready. Click Import to create it.', 'cenário 30: mapeamento aplicado');
  await upload(imp, csvFile('unk3.csv', [mkRow({ Vendor: 'CP' })]));
  await assertEventually(async () => (await panelLoc(imp).count()) === 1 && (await resRow(page, imp, 'CP').count()) === 1, 'cenário 30: o mapeamento é zerado ao escolher outro arquivo ("CP" volta a ser pendente)');
  assert((await resRow(page, imp, 'CP').locator('select.imp-res-choice').inputValue()) === '__new__', 'cenário 30: ... com a opção padrão "criar novo"');
  assert((await readyHint(imp).count()) === 0, 'cenário 30: "ready" do arquivo anterior some');

  // reabrir o modal: começa limpo
  await imp.locator('.modal-close').click();
  await imp.waitFor({ state: 'detached' });
  imp = await openImportModal(page);
  assert((await panelLoc(imp).count()) === 0 && (await readyHint(imp).count()) === 0 && (await imp.locator('.imp-report-row').count()) === 0, 'cenário 30: reabrir o modal -> sem painel, sem "ready", sem relatório');
  assert(await importBtn(imp).isDisabled(), 'cenário 30: reabrir -> Import desabilitado');
  assert((await imp.locator('input[type="file"]').inputValue()) === '', 'cenário 30: reabrir -> input de arquivo vazio');
});

await browser.close();

console.log(`\n${passes} asserts passaram, ${failures} falharam`);
console.log(`${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} ASSERT(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
