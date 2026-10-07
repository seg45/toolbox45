// Redesenho das Configurações (out/2026): menu lateral agrupado, cabeçalho de
// página por aba, rodapé do menu com usuário/role, rodapé do modal só em User
// preferences e a correção da aba Users (nada de "0" solto; Microsoft rotulada).
// /api/* mockado.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FALHOU:', msg); } else { console.log('ok:', msg); }
}
async function assertEventually(fn, msg, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return assert(true, msg); } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 50));
  }
  assert(false, msg);
}

const CATALOGS = { vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [] };
const USERS = [
  { username: 'admin', role: 'super_admin', is_local: 1, disabled: 0, created_at: '2026-10-01T10:00:00Z', created_by: 'setup', auth_provider: 'local', approved_at: '2026-10-01T10:00:00Z' },
  { username: 'ana@x.com', role: 'admin', is_local: 0, disabled: 0, created_at: '2026-10-02T10:00:00Z', created_by: 'google-oauth', auth_provider: 'google', approved_at: '2026-10-02T10:00:00Z' },
  { username: 'joao@x.com', role: 'user', is_local: 0, disabled: 1, created_at: '2026-10-03T10:00:00Z', created_by: 'microsoft-oauth', auth_provider: 'microsoft', approved_at: null },
  { username: 'eva@x.com', role: 'user', is_local: 1, disabled: 0, created_at: '2026-10-03T10:00:00Z', created_by: 'admin', auth_provider: 'local', approved_at: '2026-10-03T10:00:00Z' },
];

async function withRole(browser, role, fn) {
  const isSuper = role === 'super', isAdmin = role !== 'user';
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, timezoneId: 'UTC', locale: 'en-US' });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('cpa-authenticated', '1'));
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname;
    const json = d => route.fulfill({ json: d });
    if (p === '/api/me') return json({ username: 'rodrigo@seg45.com.br', upn: 'rodrigo@seg45.com.br', role: isSuper ? 'super_admin' : isAdmin ? 'admin' : 'user', isAdmin, isSuperAdmin: isSuper, authMethod: 'local' });
    if (p === '/api/catalogs') return json(CATALOGS);
    if (p === '/api/users') return json(USERS);
    if (p === '/api/shares') return json({ given: [], received: [] });
    if (route.request().method() !== 'GET') return json({ ok: true });
    if (p === '/api/system/logo') return json({ imageData: null, imageDataDark: null });
    return json(p.endsWith('s') ? [] : {});
  });
  try { await fn(page); } finally { await ctx.close(); }
}

const browser = await chromium.launch();

// 1) super admin: grupos do menu, ordem, cabeçalho de página, rodapé do menu
await withRole(browser, 'super', async page => {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle[title="Settings"]');
  await page.click('.theme-toggle[title="Settings"]');
  await page.waitForSelector('.settings-modal-box');
  const groups = (await page.locator('.settings-nav-group').allTextContents()).map(t => t.trim());
  assert(groups.join('|') === 'Content|Access control|Platform', `grupos do menu (lido: ${groups.join('|')})`);
  const items = (await page.locator('.settings-nav-btn').allTextContents()).map(t => t.trim());
  assert(items.join(',') === 'Database,Register,Groups,Users,System', `ordem dos itens (lido: ${items.join(',')})`);
  assert((await page.locator('.settings-page-title').innerText()) === 'Database', 'cabeçalho da página = Database ao abrir');
  assert((await page.locator('.settings-page-desc').innerText()).length > 20, 'cabeçalho tem descrição');
  assert((await page.locator('.settings-nav-btn.on').getAttribute('aria-current')) === 'page', 'item ativo marcado com aria-current');
  assert((await page.locator('.settings-nav-user-name').innerText()) === 'rodrigo@seg45.com.br', 'rodapé do menu mostra o usuário');
  assert((await page.locator('.settings-nav-user-role').innerText()) === 'Super Admin', 'rodapé do menu mostra a role');
  assert((await page.locator('.settings-modal-box .modal-foot').count()) === 0, 'sem rodapé do modal fora de User preferences');
  assert((await page.locator('.settings-pane .set-hint').count()) >= 3, 'cartões de Database têm descrição');
  for (const [label, title] of [['Register', 'Register'], ['Groups', 'Groups'], ['Users', 'Users'], ['System', 'System']]) {
    await page.locator('.settings-nav-btn', { hasText: label }).click();
    await assertEventually(async () => (await page.locator('.settings-page-title').innerText()) === title, `aba ${label}: cabeçalho de página = ${title}`);
  }
});

// 2) Users: sem "0" solto nas contas OAuth; Microsoft rotulada; botões certos
await withRole(browser, 'super', async page => {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle[title="Settings"]');
  await page.click('.theme-toggle[title="Settings"]');
  await page.locator('.settings-nav-btn', { hasText: 'Users' }).click();
  await assertEventually(async () => (await page.locator('.settings-pane[data-pane="users"] .audit-log-table tbody tr').count()) === USERS.length, 'tabela de usuários carregada');
  const rows = page.locator('.settings-pane[data-pane="users"] .audit-log-table tbody tr');
  const row = async name => rows.filter({ hasText: name }).first();
  const txt = async name => (await (await row(name)).locator('td').allTextContents()).map(t => t.trim());
  const joao = await txt('joao@x.com');
  assert(joao[1] === 'Microsoft', `conta Microsoft rotulada "Microsoft" (lido: ${joao[1]})`);
  const ana = await txt('ana@x.com');
  assert(ana[1] === 'Google', 'conta Google rotulada "Google"');
  const actions = async name => {
    const r = await row(name);
    const cell = (await r.locator('td').last().innerText()).replace(/\s+/g, ' ').trim();
    await r.locator('.row-menu-btn').click();
    const items = (await page.locator('.row-menu .row-menu-item').allInnerTexts()).join(' ');
    await page.keyboard.press('Escape');
    await page.locator('.row-menu').waitFor({ state: 'detached' });
    return `${cell} ${items}`.trim();
  };
  assert(!/(^|\s)0(\s|$)/.test(await actions('ana@x.com')), `conta Google sem "0" solto nas ações (lido: "${await actions('ana@x.com')}")`);
  assert(!/(^|\s)0(\s|$)/.test(await actions('joao@x.com')), 'conta Microsoft sem "0" solto nas ações');
  assert(!(await actions('ana@x.com')).includes('Reset password'), 'conta OAuth não tem Reset password');
  assert((await actions('eva@x.com')).includes('Reset password'), 'conta local tem Reset password');
  assert((await page.locator('.settings-pane[data-pane="users"] .set-group > .set-label').first().isVisible()) === false, 'título duplicado do cartão Users escondido');
});

// 3) escopo da conta: menu só com Account; rodapé do modal em User preferences
await withRole(browser, 'user', async page => {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.hdr-user');
  await page.click('.hdr-user');
  await page.locator('#hdrUserPanel .sb-row', { hasText: 'User preferences' }).click();
  await page.waitForSelector('.settings-modal-box');
  const groups = (await page.locator('.settings-nav-group').allTextContents()).map(t => t.trim());
  assert(groups.join('|') === 'Account', `escopo da conta: um grupo "Account" (lido: ${groups.join('|')})`);
  assert((await page.locator('.settings-page-title').innerText()) === 'User preferences', 'cabeçalho = User preferences');
  assert((await page.locator('.set-card').count()) === 4, 'preferências em 4 cartões');
  assert((await page.locator('.settings-nav-user-role').innerText()) === 'User', 'role User no rodapé do menu');
  assert((await page.locator('.settings-modal-box .modal-foot').count()) === 1, 'rodapé do modal presente em User preferences');
  await page.locator('.settings-nav-btn', { hasText: 'User account' }).click();
  await assertEventually(async () => (await page.locator('.settings-modal-box .modal-foot').count()) === 0, 'rodapé do modal some em User account');
});

await browser.close();
console.log(failures ? `${failures} FALHA(S)` : 'TODOS OS CENÁRIOS PASSARAM');
process.exit(failures ? 1 : 0);
