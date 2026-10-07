// Primeiro acesso: login.html mostra o formulario de configuracao inicial
// (e-mail + senha do administrador) quando GET /api/auth/setup-status diz que e
// necessario, e o login normal em qualquer outro caso. /api/* mockado.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
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

async function mockApis(page, setupStatus) {
  await page.route('**/api/auth/providers', route => route.fulfill({ json: { google: true, microsoft: true } }));
  await page.route('**/api/system/appearance', route => route.fulfill({ json: { theme: 'light', accentColor: 'teal' } }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
  if (setupStatus === 'fail') {
    await page.route('**/api/auth/setup-status', route => route.fulfill({ status: 500, body: 'erro' }));
  } else if (setupStatus) {
    await page.route('**/api/auth/setup-status', route => route.fulfill({ json: setupStatus }));
  }
}

const SETUP_FORM = 'text=Create administrator';
const browser = await chromium.launch();

// 1) instalacao nova: formulario de setup no lugar do login (sem Google/Microsoft/Register)
await withPage(browser, async page => {
  await mockApis(page, { required: true, mode: 'fresh' });
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector(SETUP_FORM);
  assert(await page.isVisible('text=Create the administrator account to get started'), 'fresh: texto de boas-vindas');
  assert(!(await page.isVisible('text=Log in')), 'fresh: botao Log in nao aparece');
  assert(!(await page.isVisible('text=Sign in with Google')), 'fresh: botao Google nao aparece');
  assert(!(await page.isVisible('text=Register')), 'fresh: link Register nao aparece');
  assert(await page.isVisible('text=Administrator e-mail'), 'fresh: campo de e-mail do administrador');
});

// 2) instalacao antiga (admin/admin): texto explica que a conta padrao sera substituida
await withPage(browser, async page => {
  await mockApis(page, { required: true, mode: 'migrate' });
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector(SETUP_FORM);
  assert(await page.isVisible('text=default account will be replaced'), 'migrate: texto sobre substituir a conta padrao');
});

// 3) validacoes do formulario (nenhuma chamada ao servidor)
await withPage(browser, async page => {
  await mockApis(page, { required: true, mode: 'fresh' });
  let posted = 0;
  await page.route('**/api/auth/setup', route => { posted++; route.fulfill({ json: {} }); });
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector(SETUP_FORM);
  await page.click(SETUP_FORM);
  assert(await page.isVisible('text=Enter both e-mail and password.'), 'validacao: campos vazios');
  await page.fill('input[autocomplete="email"]', 'sem-arroba');
  const senhas = page.locator('input[autocomplete="new-password"]');
  await senhas.nth(0).fill('senha-longa-1');
  await senhas.nth(1).fill('senha-longa-1');
  await page.click(SETUP_FORM);
  assert(await page.isVisible('text=Enter a valid e-mail address.'), 'validacao: e-mail invalido');
  await page.fill('input[autocomplete="email"]', 'dono@empresa.com');
  await senhas.nth(0).fill('curta');
  await senhas.nth(1).fill('curta');
  await page.click(SETUP_FORM);
  assert(await page.isVisible('text=Password must be at least 8 characters.'), 'validacao: senha curta');
  await senhas.nth(0).fill('senha-longa-1');
  await senhas.nth(1).fill('senha-longa-2');
  await page.click(SETUP_FORM);
  assert(await page.isVisible('text=The passwords do not match.'), 'validacao: confirmacao diferente');
  assert(posted === 0, 'validacao: nada foi enviado ao servidor');
});

// 4) sucesso: envia e-mail/senha, entra no app
await withPage(browser, async page => {
  await mockApis(page, { required: true, mode: 'fresh' });
  let body = null;
  await page.route('**/api/auth/setup', route => {
    body = route.request().postDataJSON();
    route.fulfill({ json: { username: 'dono@empresa.com', role: 'super_admin', mode: 'fresh' } });
  });
  await page.route('**/api/me', route => route.fulfill({ json: { authMethod: 'local', isAdmin: true, isSuperAdmin: true } }));
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector(SETUP_FORM);
  await page.fill('input[autocomplete="email"]', 'dono@empresa.com');
  const senhas = page.locator('input[autocomplete="new-password"]');
  await senhas.nth(0).fill('senha-longa-1');
  await senhas.nth(1).fill('senha-longa-1');
  await page.click(SETUP_FORM);
  await page.waitForURL('**/index.html', { timeout: 5000 });
  assert(body && body.email === 'dono@empresa.com' && body.password === 'senha-longa-1', 'sucesso: POST /api/auth/setup com e-mail e senha');
  assert((await page.evaluate(() => localStorage.getItem('cpa-authenticated'))) === '1', 'sucesso: flag cpa-authenticated gravada');
});

// 5) erro do servidor aparece no formulario
await withPage(browser, async page => {
  await mockApis(page, { required: true, mode: 'fresh' });
  await page.route('**/api/auth/setup', route => route.fulfill({ status: 409, json: { error: 'conflict', message: 'An account with this e-mail already exists.' } }));
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector(SETUP_FORM);
  await page.fill('input[autocomplete="email"]', 'dono@empresa.com');
  const senhas = page.locator('input[autocomplete="new-password"]');
  await senhas.nth(0).fill('senha-longa-1');
  await senhas.nth(1).fill('senha-longa-1');
  await page.click(SETUP_FORM);
  await page.waitForSelector('text=An account with this e-mail already exists.');
  assert(await page.isVisible(SETUP_FORM), 'erro: continua no formulario de setup');
});

// 6) alguem concluiu a configuracao antes: volta ao login com aviso
await withPage(browser, async page => {
  await mockApis(page, { required: true, mode: 'fresh' });
  await page.route('**/api/auth/setup', route => route.fulfill({ status: 409, json: { error: 'setup_not_required', message: 'The initial setup has already been completed.' } }));
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector(SETUP_FORM);
  await page.fill('input[autocomplete="email"]', 'dono@empresa.com');
  const senhas = page.locator('input[autocomplete="new-password"]');
  await senhas.nth(0).fill('senha-longa-1');
  await senhas.nth(1).fill('senha-longa-1');
  await page.click(SETUP_FORM);
  await page.waitForSelector('text=The initial setup was already completed.');
  assert(await page.isVisible('text=Log in'), 'ja concluido: volta ao login');
});

// 7) setup nao necessario ou consulta falhou: login normal
for (const [rotulo, status] of [['nao necessario', { required: false, mode: null }], ['consulta falhou', 'fail']]) {
  await withPage(browser, async page => {
    await mockApis(page, status);
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('text=Log in');
    await page.waitForTimeout(400);
    assert(!(await page.isVisible(SETUP_FORM)), `${rotulo}: sem formulario de setup`);
    assert(await page.isVisible('text=Sign in with Google'), `${rotulo}: login normal com botoes de provedor`);
  });
}

// 8) login recusado com setup_required (admin padrao) leva ao formulario de setup
await withPage(browser, async page => {
  let consultas = 0;
  await mockApis(page, null);
  await page.route('**/api/auth/setup-status', route => {
    consultas++;
    route.fulfill({ json: consultas === 1 ? { required: false, mode: null } : { required: true, mode: 'migrate' } });
  });
  await page.route('**/api/auth/login', route =>
    route.fulfill({ status: 403, json: { error: 'setup_required', message: 'The default admin account is disabled.' } }));
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('text=Log in');
  await page.fill('input[autocomplete="username"]', 'admin');
  await page.fill('input[autocomplete="current-password"]', 'admin');
  await page.click('text=Log in');
  await page.waitForSelector(SETUP_FORM);
  assert(await page.isVisible('text=default account will be replaced'), 'setup_required: abre o formulario de migracao');
});

await browser.close();
console.log(`\n${failures === 0 ? 'setup.spec: tudo ok' : `${failures} CENARIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
