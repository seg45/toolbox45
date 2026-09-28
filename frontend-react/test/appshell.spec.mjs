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

// ── Cenário 4: modal de Configurações abre pela engrenagem, fecha com Escape ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle');
  await page.click('.theme-toggle');
  await page.waitForSelector('.settings-modal-box');
  assert(await page.isVisible('text=User preferences'), 'cenário 4: modal abre com a aba Preferences');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.settings-modal-box', { state: 'detached', timeout: 3000 });
  assert(true, 'cenário 4: Escape fecha o modal');
});

// ── Cenário 5: modal — Dark mode toggle muda data-theme + persiste ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle');
  await page.click('.theme-toggle');
  await page.waitForSelector('.settings-modal-box');
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
  await page.click('.theme-toggle');
  await page.waitForSelector('.settings-modal-box');
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
