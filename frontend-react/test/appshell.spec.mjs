// Suite de validação manual (Playwright) da Fase 3, fatia 2 (App shell) —
// mesmo padrão de mocking de /api/* usado em test/login.spec.mjs.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/fase3-fatia2-shots';
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

async function withPage(browser, fn) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}

const CATALOGS = {
  vendors: [{ key: 'check-point', label: 'Check Point', color: '#DA1572', sort_order: 0 }],
  systems: [{ key: 'gaia', vendor: 'check-point', label: 'Gaia', color: '#2DD4BF', sort_order: 0 }],
  versions: [
    { key: 'R81.10', system: 'gaia', vendor: 'check-point', label: 'R81.10', color: '#FF4FA0', sort_order: 0 },
    { key: 'R82', system: 'gaia', vendor: 'check-point', label: 'R82', color: '#FBBF24', sort_order: 1 },
  ],
  environments: [
    { key: 'standalone', system: 'gaia', vendor: 'check-point', label: 'Standalone', color: '#FB923C', sort_order: 0 },
    { key: 'cluster', system: 'gaia', vendor: 'check-point', label: 'Cluster HA', color: '#F87171', sort_order: 1 },
  ],
  topics: [
    { key: 'vpn', label: 'VPN', color: '#22D3EE', sort_order: 0, is_protected: 0 },
    { key: 'environment', label: 'Environment', color: '#8B949E', sort_order: 1, is_protected: 1 },
  ],
};

async function mockLoggedInAdmin(page, meOverrides = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
  });
  await page.route('**/api/me', route =>
    route.fulfill({
      json: {
        username: 'admin',
        upn: 'admin',
        handle: 'admin',
        role: 'super_admin',
        isAdmin: true,
        isSuperAdmin: true,
        authMethod: 'local',
        ...meOverrides,
      },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: CATALOGS }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
}

const browser = await chromium.launch();

// ── Cenário 1: sem 'cpa-authenticated' → gate redireciona pra login.html ──
await withPage(browser, async page => {
  await page.route('**/api/me', route => route.fulfill({ status: 401, json: {} }));
  await page.goto(`${BASE}/index.html`);
  await page.waitForURL('**/login.html', { timeout: 5000 });
  assert(page.url().endsWith('/login.html'), 'cenário 1: gate redireciona pra login.html sem sessão');
});

// ── Cenário 2: sessão válida → header mostra handle + role, sidebar com filtros reais ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.hdr-user-dd');
  assert((await page.textContent('#currentUserLabel, .hdr-user-dd span')) !== null, 'cenário 2: header renderizou');
  await page.click('.hdr-user');
  await page.waitForSelector('text=Log out');
  assert(await page.isVisible('text=Super Admin — signed in via local account'), 'cenário 2: role/authMethod corretos no dropdown de conta');
  await page.screenshot({ path: `${SHOTS}/2-header-account-menu.png` });
});

// ── Cenário 3: sidebar filtros carregam do catálogo real (Vendor = Check Point ao selecionar) ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.sidebar');
  const vendorBlock = page.locator('.sb-block-filter', { hasText: 'Vendor' });
  await vendorBlock.locator('.dd-btn').click();
  await vendorBlock.locator('.sb-row', { hasText: 'Check Point' }).click();
  await assertEventually(async () => (await vendorBlock.locator('.dd-label').first().textContent())?.trim() === 'Check Point', 'cenário 3: seleção de Vendor reflete no label do dropdown');
  await page.screenshot({ path: `${SHOTS}/3-sidebar-vendor-filter.png` });
});

// Abre "Account settings" (escopo user) pelo menu da conta, direto na aba pedida.
async function openAccountSettings(page, itemText) {
  await page.waitForSelector('.hdr-user');
  await page.click('.hdr-user');
  await page.locator('#hdrUserPanel .sb-row', { hasText: itemText }).click();
  await page.waitForSelector('.settings-modal-box');
}

// ── Cenário 4: dois escopos do modal (igual ao original) — engrenagem = "Settings", menu da conta = "Account settings" ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle');
  // Engrenagem: título "Settings", nav só com as abas de sistema, rodapé vazio, abre em Database
  await page.click('.theme-toggle');
  await page.waitForSelector('.settings-modal-box');
  assert((await page.textContent('#settingsModalTitle')) === 'Settings', 'cenário 4: engrenagem abre o modal com título "Settings"');
  const sysNav = (await page.locator('.settings-nav-btn').allTextContents()).map(t => t.trim());
  assert(sysNav.join(',') === 'Database,Register,Groups,Users,System', `cenário 4: nav do escopo system = Database,Register,Groups,Users,System (lido: ${sysNav.join(',')})`);
  assert(await page.locator('.settings-nav-btn.on', { hasText: 'Database' }).count() === 1, 'cenário 4: engrenagem abre na aba Database');
  assert((await page.locator('.settings-modal-box .modal-foot button').count()) === 0, 'cenário 4: rodapé sem botões fora de User preferences');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.settings-modal-box', { state: 'detached', timeout: 3000 });
  assert(true, 'cenário 4: Escape fecha o modal');
  // Menu da conta: "User preferences" => título "Account settings", nav só com User account/User preferences
  await openAccountSettings(page, 'User preferences');
  assert((await page.textContent('#settingsModalTitle')) === 'Account settings', 'cenário 4: menu da conta abre o modal com título "Account settings"');
  const userNav = (await page.locator('.settings-nav-btn').allTextContents()).map(t => t.trim());
  assert(userNav.join(',') === 'User account,User preferences', `cenário 4: nav do escopo user = User account,User preferences (lido: ${userNav.join(',')})`);
  assert(await page.isVisible('.settings-pane[data-pane="prefs"]'), 'cenário 4: abre na aba User preferences');
  const foot = (await page.locator('.settings-modal-box .modal-foot button').allTextContents()).map(t => t.trim());
  assert(foot.join(',') === 'Restore defaults,Cancel,Save', `cenário 4: rodapé de User preferences = Restore defaults,Cancel,Save (lido: ${foot.join(',')})`);
});

// ── Cenário 5: modal — Dark mode toggle muda data-theme + persiste ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await openAccountSettings(page, 'User preferences');
  await page.click('text=Dark mode');
  await assertEventually(async () => (await page.getAttribute('html', 'data-theme')) === 'dark', 'cenário 5: Dark mode aplica data-theme=dark');
  const persisted = await page.evaluate(() => localStorage.getItem('cpa-theme'));
  assert(persisted === 'dark', 'cenário 5: preferência de tema persistida em cpa-theme');
  await page.screenshot({ path: `${SHOTS}/5-dark-mode.png` });
});

// ── Cenário 6: modal — troca de accent color aplica --teal ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await openAccountSettings(page, 'User preferences');
  await page.click('[title="Check Point pink"]');
  const teal = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--teal').trim());
  assert(teal.toLowerCase() === '#da1572', `cenário 6: accent pink aplicado (--teal=${teal})`);
});

// ── Cenário 7: modal — aba "User account" troca senha com sucesso ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  let passwordCalled = false;
  await page.route('**/api/me/password', route => {
    passwordCalled = true;
    route.fulfill({ status: 204, body: '' });
  });
  await page.goto(`${BASE}/index.html`);
  await page.click('.hdr-user');
  await page.click('text=User account');
  await page.waitForSelector('.settings-modal-box');
  await page.fill('input[autocomplete="current-password"]', 'senha-atual');
  await page.fill('input[autocomplete="new-password"]', 'senha-nova-123');
  await page.locator('#acctConfirmPasswordInput, input[autocomplete="new-password"] >> nth=1').fill('senha-nova-123');
  await page.click('text=Change password');
  await page.waitForSelector('text=Password updated.');
  assert(passwordCalled, 'cenário 7: PUT /api/me/password foi chamado');
  await page.screenshot({ path: `${SHOTS}/7-password-change.png` });
});

// ── Cenário 8: modal — troca de handle chama PUT /api/me/handle ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  let handleCalled = false;
  await page.route('**/api/me/handle', route => {
    handleCalled = true;
    route.fulfill({ json: { handle: 'novo-handle' } });
  });
  await page.goto(`${BASE}/index.html`);
  await page.click('.hdr-user');
  await page.click('text=User account');
  await page.waitForSelector('.settings-modal-box');
  await page.click('text="Change"');
  await page.fill('input[placeholder="your-handle"]', 'novo-handle');
  await page.click('text=Save');
  await assertEventually(async () => (await page.textContent('code')) === 'novo-handle', 'cenário 8: handle atualizado na UI após salvar');
  assert(handleCalled, 'cenário 8: PUT /api/me/handle foi chamado');
});

// ── Cenário 9: conta Google não mostra campos de senha ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page, { authMethod: 'google', isAdmin: false, isSuperAdmin: false });
  await page.goto(`${BASE}/index.html`);
  await page.click('.hdr-user');
  await page.click('text=User account');
  await page.waitForSelector('.settings-modal-box');
  assert(await page.isVisible("text=This account signs in with Google"), 'cenário 9: nota de conta Google visível');
  assert(!(await page.isVisible('text=Current password')), 'cenário 9: campos de senha ausentes para conta Google');
});

// ── Cenário 10: sidebar collapse/pin toggle alterna a classe no .app ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.sb-divider-toggle');
  await page.click('.sb-divider-toggle');
  await assertEventually(async () => (await page.getAttribute('.app', 'class'))?.includes('sidebar-collapsed'), 'cenário 10: toggle da sidebar aplica .sidebar-collapsed em .app');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('cpa-settings') || '{}').showSidebar);
  assert(persisted === false, 'cenário 10: showSidebar=false persistido');
});

// Helpers dos cenários 11-14 (rascunho + Save/Cancel/Restore defaults)
// `.set-row-half` (Home page / Group by dividem uma linha) ou `.set-group-row`
// (Vendor/System/...) — .last() pega o mais interno quando os dois casam.
const prefsGroup = (page, label) =>
  page.locator('.settings-pane[data-pane="prefs"] .set-row-half, .settings-pane[data-pane="prefs"] .set-group-row').filter({ has: page.locator('.set-label', { hasText: new RegExp(`^${label}$`) }) }).last();
async function pickInGroup(page, label, optionText) {
  const g = prefsGroup(page, label);
  await g.locator('.dd-btn').click();
  await g.locator('.seg-btn', { hasText: optionText }).click();
}
const readSettings = page => page.evaluate(() => JSON.parse(localStorage.getItem('cpa-settings') || '{}'));

// ── Cenário 11: filtros padrão e Home page ficam em RASCUNHO até o Save ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await openAccountSettings(page, 'User preferences');
  await pickInGroup(page, 'Vendor', 'Check Point');
  await pickInGroup(page, 'Home page', 'Folders');
  let s = await readSettings(page);
  assert(!(s.vendor || []).includes('check-point') && s.home !== 'folders', 'cenário 11: antes do Save, Vendor e Home page NÃO foram gravados em cpa-settings');
  assert((await page.evaluate(() => localStorage.getItem('cpa-last-view'))) !== 'folders', 'cenário 11: antes do Save, a visão atual não muda');
  // trocar de aba e voltar mantém o rascunho
  await page.locator('.settings-nav-btn', { hasText: 'User account' }).click();
  await page.locator('.settings-nav-btn', { hasText: 'User preferences' }).click();
  assert((await prefsGroup(page, 'Vendor').locator('.dd-label').textContent())?.trim() === 'Check Point', 'cenário 11: o rascunho sobrevive à troca de aba dentro do modal');
  await page.click('#settingsSaveBtn');
  await page.waitForSelector('.settings-modal-box', { state: 'detached', timeout: 3000 });
  s = await readSettings(page);
  assert((s.vendor || []).includes('check-point') && s.home === 'folders', 'cenário 11: Save grava Vendor e Home page em cpa-settings');
  const live = await page.evaluate(() => JSON.parse(localStorage.getItem('cpa-sidebar-filters') || '{}'));
  assert((live.vd || []).includes('check-point'), 'cenário 11: Save também aplica o Vendor aos filtros ao vivo da sidebar');
  assert((await page.locator('.sb-block-filter', { hasText: 'Vendor' }).locator('.dd-label').first().textContent())?.trim() === 'Check Point', 'cenário 11: sidebar mostra o Vendor salvo');
  assert((await page.evaluate(() => localStorage.getItem('cpa-last-view'))) === 'folders', 'cenário 11: Save de Home page = Folders atualiza a visão memorizada');
});

// ── Cenário 12: Cancel descarta o rascunho (e o que já foi aplicado na hora continua) ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await openAccountSettings(page, 'User preferences');
  await pickInGroup(page, 'Vendor', 'Check Point');
  await page.click('text=Dark mode'); // aplicado na hora
  await page.click('#settingsCancelBtn');
  await page.waitForSelector('.settings-modal-box', { state: 'detached', timeout: 3000 });
  const s = await readSettings(page);
  assert(!(s.vendor || []).includes('check-point'), 'cenário 12: Cancel descarta o Vendor do rascunho');
  assert((await page.getAttribute('html', 'data-theme')) === 'dark', 'cenário 12: tema aplicado na hora continua depois do Cancel (como no original)');
  await openAccountSettings(page, 'User preferences');
  assert((await prefsGroup(page, 'Vendor').locator('.dd-label').textContent())?.trim() === 'All', 'cenário 12: reabrir o modal começa de novo do valor salvo (All)');
});

// ── Cenário 13: Group by e toggles são aplicados NA HORA (sem Save) ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await openAccountSettings(page, 'User preferences');
  await page.locator('#settingsToggleGroup2 .sb-toggle', { hasText: 'Details' }).click();
  await pickInGroup(page, 'Group by', 'Created by');
  const s = await readSettings(page);
  assert(s.showCardDetails === true && s.groupBy === 'creator', 'cenário 13: Details e Group by gravados na hora, sem clicar em Save');
});

// ── Cenário 14: Restore defaults — rascunho volta ao padrão, o que é imediato volta agora ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await openAccountSettings(page, 'User preferences');
  await pickInGroup(page, 'Vendor', 'Check Point');
  await page.click('text=Dark mode');
  await page.locator('#settingsToggleGroup2 .sb-toggle', { hasText: 'Images' }).click();
  assert((await readSettings(page)).showImages === true, 'cenário 14: pré-condição — Images ligado');
  await page.getByRole('button', { name: 'Restore defaults' }).click();
  await assertEventually(async () => (await page.getAttribute('html', 'data-theme')) === 'light', 'cenário 14: Restore defaults volta o tema pra claro na hora');
  const s = await readSettings(page);
  assert(s.showImages === false && s.showCardDetails === false && s.groupBy === 'topic', 'cenário 14: toggles e Group by voltam ao padrão na hora');
  assert((await prefsGroup(page, 'Vendor').locator('.dd-label').textContent())?.trim() === 'All', 'cenário 14: Vendor do rascunho volta pra All');
  assert(!(s.vendor || []).includes('check-point'), 'cenário 14: nada de filtro foi gravado sem Save');
});

await browser.close();

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

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
