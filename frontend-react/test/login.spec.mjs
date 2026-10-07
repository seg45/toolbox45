// Suite de validação manual (Playwright) da Fase 3, fatia 1 (Login) —
// mesma ideia do fake_db usado nos testes do backend Python: intercepta
// /api/* e simula as respostas do backend Python real (já validado nas
// fatias 1-10), sem precisar de um backend de verdade rodando aqui.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/fase3-fatia1-shots';
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

async function mockDefaultApis(page, overrides = {}) {
  await page.route('**/api/auth/providers', route =>
    route.fulfill({ json: overrides.providers ?? { google: true, microsoft: true } })
  );
  await page.route('**/api/system/appearance', route =>
    route.fulfill({ json: overrides.appearance ?? { theme: 'light', accentColor: 'teal' } })
  );
  await page.route('**/api/system/logo', route =>
    route.fulfill({ json: overrides.logo ?? { imageData: null, imageDataDark: null } })
  );
}

const browser = await chromium.launch();

// ── Cenário 1: estado default (sem cache local, providers ligados) ──
await withPage(browser, async page => {
  await mockDefaultApis(page);
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('.login-card');
  assert(await page.isVisible('text=Sign in with Google'), 'cenário 1: botão Google visível quando provider habilitado');
  assert(await page.isVisible('text=Sign in with Microsoft'), 'cenário 1: botão Microsoft visível quando provider habilitado');
  assert((await page.getAttribute('html', 'data-theme')) === 'light', 'cenário 1: tema default = light');
  await page.screenshot({ path: `${SHOTS}/1-default-login.png` });
});

// ── Cenário 2: providers desligados — botões CONTINUAM na página (fixos, sem piscar), desabilitados, com aviso ──
await withPage(browser, async page => {
  await mockDefaultApis(page, { providers: { google: false, microsoft: false } });
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('.login-card');
  await page.waitForTimeout(200);
  assert(await page.isVisible('text=Sign in with Google'), 'cenário 2: botão Google continua visível quando provider desabilitado');
  assert(await page.isDisabled('button:has-text("Sign in with Google")'), 'cenário 2: botão Google desabilitado quando provider desabilitado');
  assert(await page.isDisabled('button:has-text("Sign in with Microsoft")'), 'cenário 2: botão Microsoft desabilitado quando provider desabilitado');
  assert((await page.locator('.login-provider-note').count()) === 2, 'cenário 2: um aviso "não configurado" por provider');
  assert(await page.isVisible('.login-divider'), 'cenário 2: divider "or" continua visível');
  await page.screenshot({ path: `${SHOTS}/2-no-providers.png` });
});

// ── Cenário 3: cache local de tema escuro + accent roxo aplicado ANTES do paint (sem flash) ──
await withPage(browser, async page => {
  await page.addInitScript(() => {
    localStorage.setItem('cpa-org-theme', 'dark');
    localStorage.setItem('cpa-org-accent', 'purple');
  });
  await mockDefaultApis(page, { appearance: { theme: 'dark', accentColor: 'purple' } });
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('.login-card');
  assert((await page.getAttribute('html', 'data-theme')) === 'dark', 'cenário 3: tema dark aplicado a partir do cache');
  const teal = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--teal').trim());
  assert(teal.toLowerCase() === '#c084fc', `cenário 3: accent purple aplicado (--teal=${teal})`);
  await page.screenshot({ path: `${SHOTS}/3-dark-purple.png` });
});

// ── Cenário 4: login local bem-sucedido → navega pra index.html (placeholder) ──
await withPage(browser, async page => {
  await mockDefaultApis(page);
  let loginCalled = false;
  await page.route('**/api/auth/login', route => {
    loginCalled = true;
    route.fulfill({ json: { username: 'admin', role: 'super_admin' } });
  });
  await page.route('**/api/me', route => route.fulfill({ json: { authMethod: 'local', isAdmin: true, isSuperAdmin: true } }));
  await page.goto(`${BASE}/login.html`);
  await page.fill('input[autocomplete="username"]', 'admin');
  await page.fill('input[autocomplete="current-password"]', 'senha-teste');
  await page.click('text=Log in');
  await page.waitForURL('**/index.html', { timeout: 5000 });
  assert(loginCalled, 'cenário 4: POST /api/auth/login foi chamado');
  await page.waitForSelector('.app');
  const localFlag = await page.evaluate(() => localStorage.getItem('cpa-authenticated'));
  assert(localFlag === '1', 'cenário 4: flag cpa-authenticated gravada após login');
  await page.screenshot({ path: `${SHOTS}/4-login-success-placeholder.png` });
});

// ── Cenário 5: login com senha errada → mostra erro, NÃO navega ──
await withPage(browser, async page => {
  await mockDefaultApis(page);
  await page.route('**/api/auth/login', route =>
    route.fulfill({ status: 401, json: { error: 'invalid_credentials', message: 'Invalid username or password.' } })
  );
  await page.goto(`${BASE}/login.html`);
  await page.fill('input[autocomplete="username"]', 'admin');
  await page.fill('input[autocomplete="current-password"]', 'errada');
  await page.click('text=Log in');
  await page.waitForSelector('text=Invalid username or password.');
  assert(page.url().endsWith('/login.html'), 'cenário 5: continua em login.html após falha');
  await page.screenshot({ path: `${SHOTS}/5-login-error.png` });
});

// ── Cenário 6: registro novo → vai pra view "pending" ──
await withPage(browser, async page => {
  await mockDefaultApis(page);
  await page.route('**/api/auth/register', route =>
    route.fulfill({ json: { message: 'Your account was created and is pending administrator approval.' } })
  );
  await page.goto(`${BASE}/login.html`);
  await page.click('text=Register');
  await page.fill('input[type="email"]', 'novo@seg45.com.br');
  await page.fill('input[autocomplete="new-password"]', 'senha123');
  await page.click('text=Create account');
  await page.waitForSelector('text=Your account was created and is pending administrator approval.');
  assert(!(await page.isVisible('text=Sign in with Google')), 'cenário 6: OAuth some na view pending');
  await page.screenshot({ path: `${SHOTS}/6-register-pending.png` });
});

// ── Cenário 7: registro com e-mail já pendente (409 pending_approval) → mesma view de sucesso ──
await withPage(browser, async page => {
  await mockDefaultApis(page);
  await page.route('**/api/auth/register', route =>
    route.fulfill({ status: 409, json: { error: 'pending_approval', message: 'This e-mail is already registered and is pending administrator approval.' } })
  );
  await page.goto(`${BASE}/login.html`);
  await page.click('text=Register');
  await page.fill('input[type="email"]', 'ja-existe@seg45.com.br');
  await page.fill('input[autocomplete="new-password"]', 'senha123');
  await page.click('text=Create account');
  await page.waitForSelector('text=This e-mail is already registered and is pending administrator approval.');
  await page.screenshot({ path: `${SHOTS}/7-register-already-pending.png` });
});

// ── Cenário 8: retorno de redirect OAuth (?google=pending) ──
await withPage(browser, async page => {
  await mockDefaultApis(page);
  await page.goto(`${BASE}/login.html?google=pending`);
  await page.waitForSelector('text=Your account was created with Google sign-in and is pending administrator approval.');
  assert(page.url().endsWith('/login.html'), 'cenário 8: querystring limpa da URL (history.replaceState)');
  await page.screenshot({ path: `${SHOTS}/8-google-pending.png` });
});

// ── Cenário 9: retorno de redirect OAuth com erro (?google=error&reason=access_denied) ──
await withPage(browser, async page => {
  await mockDefaultApis(page);
  await page.goto(`${BASE}/login.html?google=error&reason=access_denied`);
  await page.waitForSelector('text=Google sign-in was cancelled.');
  await page.screenshot({ path: `${SHOTS}/9-google-error.png` });
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
