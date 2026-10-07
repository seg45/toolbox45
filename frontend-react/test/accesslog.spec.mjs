// Access log (Settings → Database → View access log): só super admin; lista os
// eventos de GET /api/auth-events, filtra por tipo, escapa texto digitado por
// terceiros e trata erro/vazio. /api/* mockado.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
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
async function assertEventually(fn, msg, ms = 5000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return assert(true, msg);
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 50));
  }
  assert(false, `${msg}${last ? ` (${last.message})` : ''}`);
}

async function withPage(browser, fn) {
  const ctx = await browser.newContext({ timezoneId: 'UTC', locale: 'en-US' });
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}

const EMPTY_CATALOGS = { vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [] };

const EVENTS = [
  { id: 5, ts: '2026-10-06T14:30:00Z', event: 'login_blocked', username: 'alvo@x.com', ip: '203.0.113.7', user_agent: 'Mozilla/5.0 (X11)', detail: 'retry_after=600s' },
  { id: 4, ts: '2026-10-06T14:25:00Z', event: 'login_failed', username: '<b>x</b>@evil.com', ip: '203.0.113.7', user_agent: '<img src=x onerror="window.__pwned=1">', detail: 'bad_password' },
  { id: 3, ts: '2026-10-06T14:20:00Z', event: 'login_success', username: 'rodrigo@seg45.com.br', ip: '198.51.100.9', user_agent: 'Mozilla/5.0 (Windows NT 10.0)', detail: null },
  { id: 2, ts: '2026-10-06T14:10:00Z', event: 'password_changed', username: 'rodrigo@seg45.com.br', ip: '198.51.100.9', user_agent: null, detail: 'other_sessions_revoked=2' },
  { id: 1, ts: '2026-10-06T14:00:00Z', event: 'setup_completed', username: 'rodrigo@seg45.com.br', ip: '198.51.100.9', user_agent: 'Mozilla/5.0', detail: 'mode=fresh' },
];

async function mockBase(page, { isAdmin, isSuperAdmin }, handler) {
  const calls = [];
  await page.addInitScript(() => localStorage.setItem('cpa-authenticated', '1'));
  page.on('request', req => {
    const u = new URL(req.url());
    if (u.pathname === '/api/auth-events') calls.push(u.search);
  });
  await page.route('**/api/me', route =>
    route.fulfill({
      json: { username: 'tester', upn: 'tester', role: isSuperAdmin ? 'super_admin' : isAdmin ? 'admin' : 'user', isAdmin, isSuperAdmin, authMethod: 'local' },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: EMPTY_CATALOGS }));
  await page.route('**/api/system/logo', route => (route.request().method() === 'GET' ? route.fulfill({ json: { imageData: null, imageDataDark: null } }) : route.continue()));
  await page.route('**/api/commands', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  await page.route('**/api/folders', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  await page.route('**/api/user-data', route => (route.request().method() === 'GET' ? route.fulfill({ json: {} }) : route.continue()));
  await page.route('**/api/auth-events**', route => (handler ? handler(route) : route.fulfill({ json: EVENTS })));
  return calls;
}

async function openDatabasePane(page) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle[title="Settings"]');
  await page.click('.theme-toggle[title="Settings"]');
  await page.waitForSelector('.settings-modal-box');
  await page.locator('.settings-nav-btn', { hasText: 'Database' }).click();
  await page.waitForSelector('.settings-content .set-group');
}

const dbPane = page => page.locator('.settings-content');
const accessModal = page => page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Access log' }) });

const browser = await chromium.launch();

// 1) super admin vê o botão e a lista, com rótulos amigáveis
await withPage(browser, async page => {
  const calls = await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  await openDatabasePane(page);
  await dbPane(page).locator('button', { hasText: 'View access log' }).click();
  const m = accessModal(page);
  await m.waitFor();
  await assertEventually(async () => (await m.locator('#accessLogTbody tr').count()) === EVENTS.length, 'super admin: uma linha por evento');
  const txt = await m.locator('#accessLogTbody').innerText();
  assert(txt.includes('Login blocked') && txt.includes('Login failed') && txt.includes('Initial setup') && txt.includes('Password changed'), 'rótulos amigáveis dos eventos');
  assert(txt.includes('203.0.113.7') && txt.includes('retry_after=600s'), 'IP e detalhe aparecem');
  assert(calls.length === 1 && calls[0].includes('limit=500') && !calls[0].includes('event='), `primeira chamada sem filtro (lido: ${JSON.stringify(calls)})`);
  const pill = m.locator('#accessLogTbody tr').nth(0).locator('.audit-action-pill');
  assert((await pill.getAttribute('class')).includes('audit-action-delete'), 'evento de risco (bloqueio) com destaque');
  const pillOk = m.locator('#accessLogTbody tr').nth(2).locator('.audit-action-pill');
  assert((await pillOk.getAttribute('class')).includes('audit-action-create'), 'login normal sem destaque');
  assert(!(await m.locator('#accessLogEmpty').isVisible()), 'texto de vazio oculto');
});

// 2) texto digitado por terceiros aparece como TEXTO (nada de HTML)
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  await openDatabasePane(page);
  await dbPane(page).locator('button', { hasText: 'View access log' }).click();
  const m = accessModal(page);
  await assertEventually(async () => (await m.locator('#accessLogTbody tr').count()) === EVENTS.length, 'linhas carregadas');
  const cells = await m.locator('#accessLogTbody tr').nth(1).locator('td').allTextContents();
  assert(cells[2] === '<b>x</b>@evil.com', `usuário com HTML aparece como texto (lido: "${cells[2]}")`);
  assert(cells[4] === '<img src=x onerror="window.__pwned=1">', 'user-agent com HTML aparece como texto');
  assert((await m.locator('#accessLogTbody b, #accessLogTbody img').count()) === 0, 'nenhum <b>/<img> criado');
  assert((await page.evaluate(() => window.__pwned)) === undefined, 'nenhum script executou');
});

// 3) filtro por tipo refaz a consulta com ?event=
await withPage(browser, async page => {
  const calls = await mockBase(page, { isAdmin: true, isSuperAdmin: true }, route => {
    const ev = new URL(route.request().url()).searchParams.get('event');
    route.fulfill({ json: ev ? EVENTS.filter(e => e.event === ev) : EVENTS });
  });
  await openDatabasePane(page);
  await dbPane(page).locator('button', { hasText: 'View access log' }).click();
  const m = accessModal(page);
  await assertEventually(async () => (await m.locator('#accessLogTbody tr').count()) === EVENTS.length, 'sem filtro: todas as linhas');
  await m.locator('#accessLogFilter').selectOption('login_failed');
  await assertEventually(async () => (await m.locator('#accessLogTbody tr').count()) === 1, 'filtro login_failed: 1 linha');
  await assertEventually(async () => calls.some(c => c.includes('event=login_failed')), 'consulta enviou event=login_failed');
  await m.locator('#accessLogFilter').selectOption('');
  await assertEventually(async () => (await m.locator('#accessLogTbody tr').count()) === EVENTS.length, 'voltar a "All events" lista tudo');
});

// 4) vazio e erro
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true }, route => route.fulfill({ json: [] }));
  await openDatabasePane(page);
  await dbPane(page).locator('button', { hasText: 'View access log' }).click();
  const m = accessModal(page);
  await assertEventually(async () => await m.locator('#accessLogEmpty').isVisible(), 'lista vazia mostra a mensagem');
});
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true }, route => route.fulfill({ status: 500, json: { error: 'internal_error' } }));
  await openDatabasePane(page);
  await dbPane(page).locator('button', { hasText: 'View access log' }).click();
  const m = accessModal(page);
  await assertEventually(async () => (await m.locator('#accessLogTbody').innerText()).includes('Failed to load the access log'), 'erro 500 mostra a mensagem');
});

// 5) admin comum e usuário: sem botão e sem nenhuma chamada
for (const [nome, flags] of [['admin comum', { isAdmin: true, isSuperAdmin: false }], ['usuário', { isAdmin: false, isSuperAdmin: false }]]) {
  await withPage(browser, async page => {
    const calls = await mockBase(page, flags);
    await openDatabasePane(page);
    await page.waitForTimeout(400);
    assert((await dbPane(page).locator('button', { hasText: 'View access log' }).count()) === 0, `${nome}: sem botão "View access log"`);
    assert(calls.length === 0, `${nome}: nenhuma chamada a /api/auth-events`);
  });
}

await browser.close();
console.log(`\n${asserts} asserts executados`);
console.log(failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} ASSERT(S) FALHARAM`);
process.exit(failures === 0 ? 0 : 1);
