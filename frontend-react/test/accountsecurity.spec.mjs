// Suíte (Playwright) de "Esqueci a senha", MFA por e-mail, conversão local ⇄ SSO e das telas de
// super admin (SMTP + política de MFA + MFA por usuário). /api/* é simulado (route()), sem
// backend real; os contratos vêm de server-py/app/routers/{auth,me,smtp,mfa_policy,users}.py.
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
async function assertEventually(fn, msg, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return assert(true, msg);
    await new Promise(r => setTimeout(r, 50));
  }
  assert(false, msg);
}
async function withPage(browser, fn) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}

const EMPTY_CATALOGS = { vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [] };

async function mockLoginBase(page, providers = { google: false, microsoft: false, passwordReset: true }) {
  await page.route('**/api/auth/providers', r => r.fulfill({ json: providers }));
  await page.route('**/api/auth/setup-status', r => r.fulfill({ json: { required: false, mode: null } }));
  await page.route('**/api/system/appearance', r => r.fulfill({ json: { theme: 'light', accentColor: 'teal' } }));
  await page.route('**/api/system/logo', r => r.fulfill({ json: { imageData: null, imageDataDark: null } }));
}

async function mockApp(page, { me = {}, isSuperAdmin = false } = {}) {
  await page.addInitScript(() => localStorage.setItem('cpa-authenticated', '1'));
  const meBody = {
    username: 'ana@x.com', upn: 'ana@x.com', role: isSuperAdmin ? 'super_admin' : 'user',
    isAdmin: isSuperAdmin, isSuperAdmin, authMethod: 'local', isLocal: true, authProvider: 'local',
    mfa: { enabled: false, required: false, available: true }, ...me,
  };
  await page.route('**/api/me', r => r.fulfill({ json: meBody }));
  await page.route('**/api/auth/providers', r => r.fulfill({ json: { google: true, microsoft: false, passwordReset: true } }));
  await page.route('**/api/catalogs', r => r.fulfill({ json: EMPTY_CATALOGS }));
  await page.route('**/api/system/logo', r => r.fulfill({ json: { imageData: null, imageDataDark: null } }));
  await page.route('**/api/commands', r => (r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.continue()));
  await page.route('**/api/folders', r => (r.request().method() === 'GET' ? r.fulfill({ json: [] }) : r.continue()));
  await page.route('**/api/shares', r => r.fulfill({ json: { given: [], received: [] } }));
}
async function openPane(page, label, pane) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle[title="Settings"]');
  if (pane === 'account') {
    // "User account" mora no menu da conta (escopo "Account settings"); o resto na engrenagem
    await page.click('.hdr-user');
    await page.click('text=User account');
  } else {
    await page.click('.theme-toggle[title="Settings"]');
    await page.waitForSelector('.settings-modal-box');
    await page.locator('.settings-nav-btn', { hasText: label }).click();
  }
  await page.waitForSelector(`.settings-pane[data-pane="${pane}"]`);
}

const browser = await chromium.launch();

// ── 1: "Forgot password?" só aparece com SMTP (passwordReset) ──
await withPage(browser, async page => {
  await mockLoginBase(page, { google: false, microsoft: false, passwordReset: false });
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('.login-card');
  await page.waitForTimeout(250);
  assert((await page.locator('#forgotLink').count()) === 0, 'cenário 1: sem SMTP, "Forgot password?" não aparece');
});

// ── 2: pedir o link — resposta genérica, e-mail enviado no corpo ──
await withPage(browser, async page => {
  await mockLoginBase(page);
  let body = null;
  await page.route('**/api/auth/forgot-password', r => {
    body = r.request().postDataJSON();
    r.fulfill({ json: { ok: true, message: 'If an account with that e-mail exists and can be reset, we sent a message.' } });
  });
  await page.goto(`${BASE}/login.html`);
  await page.fill('input[autocomplete="username"]', 'ana@x.com');
  await page.click('#forgotLink');
  await page.waitForSelector('#forgotView');
  assert((await page.inputValue('#forgotEmail')) === 'ana@x.com', 'cenário 2: o e-mail digitado é levado para a tela de reset');
  await page.fill('#forgotEmail', 'ruim');
  await page.click('#forgotSendBtn');
  await page.waitForSelector('#forgotError');
  assert(body === null, 'cenário 2: e-mail inválido nem chega ao servidor');
  await page.fill('#forgotEmail', 'ana@x.com');
  await page.click('#forgotSendBtn');
  await page.waitForSelector('#forgotMsg');
  assert(body && body.email === 'ana@x.com', 'cenário 2: POST /api/auth/forgot-password com o e-mail');
  assert((await page.innerText('#forgotMsg')).includes('If an account'), 'cenário 2: mostra a mensagem genérica do servidor');
});

// ── 3: link do e-mail abre a redefinição; token sai da URL; sucesso volta ao login ──
await withPage(browser, async page => {
  await mockLoginBase(page);
  let body = null;
  await page.route('**/api/auth/reset-password', r => {
    body = r.request().postDataJSON();
    r.fulfill({ json: { ok: true, message: 'Your password was changed.' } });
  });
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
  await page.goto(`${BASE}/login.html#reset=${token}`);
  await page.waitForSelector('#resetView');
  assert(!page.url().includes('reset='), 'cenário 3: o token é removido da barra de endereço');
  await page.fill('#resetPw', 'curta');
  await page.fill('#resetPw2', 'curta');
  await page.click('#resetSubmitBtn');
  await page.waitForSelector('#resetError');
  assert(body === null, 'cenário 3: senha curta não é enviada');
  await page.fill('#resetPw', 'senha-nova-123');
  await page.fill('#resetPw2', 'outra-coisa-123');
  await page.click('#resetSubmitBtn');
  assert((await page.innerText('#resetError')).includes('do not match') && body === null, 'cenário 3: confirmação diferente é recusada');
  await page.fill('#resetPw2', 'senha-nova-123');
  await page.click('#resetSubmitBtn');
  await page.waitForSelector('#resetDoneMsg');
  assert(body && body.token === token && body.password === 'senha-nova-123', 'cenário 3: POST com token e nova senha');
  assert(await page.isVisible('input[autocomplete="current-password"]'), 'cenário 3: volta à tela de login com o aviso de sucesso');
});

// ── 3b: token inválido mostra o erro do servidor ──
await withPage(browser, async page => {
  await mockLoginBase(page);
  await page.route('**/api/auth/reset-password', r =>
    r.fulfill({ status: 400, json: { error: 'invalid_token', message: 'This reset link is invalid or has expired. Ask for a new one.' } }));
  await page.goto(`${BASE}/login.html#reset=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF`);
  await page.fill('#resetPw', 'senha-nova-123');
  await page.fill('#resetPw2', 'senha-nova-123');
  await page.click('#resetSubmitBtn');
  await page.waitForSelector('#resetError');
  assert((await page.innerText('#resetError')).includes('expired'), 'cenário 3b: link vencido mostra o erro do servidor');
});

// ── 4: login com MFA — senha certa abre a tela do código; só o código certo entra ──
await withPage(browser, async page => {
  await mockLoginBase(page);
  await page.route('**/api/auth/login', r =>
    r.fulfill({ json: { mfaRequired: true, challenge: 'c'.repeat(40), maskedEmail: 'a***@x***.com', enrolling: false } }));
  let verify = [];
  await page.route('**/api/auth/mfa/verify', r => {
    const b = r.request().postDataJSON();
    verify.push(b);
    if (b.code === '123456') return r.fulfill({ json: { username: 'ana@x.com', role: 'user' } });
    r.fulfill({ status: 400, json: { error: 'invalid_code', message: 'That code is not correct.' } });
  });
  await page.route('**/api/auth/mfa/resend', r => r.fulfill({ json: { ok: true, maskedEmail: 'a***@x***.com' } }));
  await page.route('**/api/me', r => r.fulfill({ json: { authMethod: 'local', isAdmin: false, isSuperAdmin: false } }));
  await page.goto(`${BASE}/login.html`);
  await page.fill('input[autocomplete="username"]', 'ana@x.com');
  await page.fill('input[autocomplete="current-password"]', 'senha-forte-1');
  await page.click('text=Log in');
  await page.waitForSelector('#mfaView');
  assert((await page.innerText('#mfaView')).includes('a***@x***.com'), 'cenário 4: mostra o e-mail mascarado');
  assert(page.url().endsWith('/login.html'), 'cenário 4: ainda em login.html (sem sessão)');
  await page.fill('#mfaCodeInput', '12');
  await page.click('#mfaVerifyBtn');
  await page.waitForSelector('#mfaError');
  assert(verify.length === 0, 'cenário 4: código incompleto não vai ao servidor');
  await page.fill('#mfaCodeInput', '000000');
  await page.click('#mfaVerifyBtn');
  await assertEventually(async () => (await page.innerText('#mfaError')).includes('not correct'), 'cenário 4: código errado mostra o erro');
  await page.click('#mfaResend');
  await page.waitForSelector('#mfaInfo');
  await page.fill('#mfaCodeInput', '123 456');
  await page.click('#mfaVerifyBtn');
  await page.waitForURL('**/index.html', { timeout: 5000 });
  assert(verify.at(-1).code === '123456' && verify.at(-1).challenge === 'c'.repeat(40), 'cenário 4: código certo (sem espaços) + desafio enviados; entra no app');
});

// ── 4b: ativação obrigatória explica o motivo ──
await withPage(browser, async page => {
  await mockLoginBase(page);
  await page.route('**/api/auth/login', r =>
    r.fulfill({ json: { mfaRequired: true, challenge: 'd'.repeat(40), maskedEmail: 'a***@x***.com', enrolling: true } }));
  await page.goto(`${BASE}/login.html`);
  await page.fill('input[autocomplete="username"]', 'ana@x.com');
  await page.fill('input[autocomplete="current-password"]', 'senha-forte-1');
  await page.click('text=Log in');
  await page.waitForSelector('#mfaView');
  assert((await page.innerText('#mfaView')).includes('requires a verification code'), 'cenário 4b: avisa que o administrador exige MFA');
});

// ── 5: conta local — ligar MFA (start + confirm) ──
await withPage(browser, async page => {
  await mockApp(page);
  let state = { enabled: false };
  await page.route('**/api/me', r => r.fulfill({
    json: { username: 'ana@x.com', role: 'user', isAdmin: false, isSuperAdmin: false, authMethod: 'local', isLocal: true, authProvider: 'local',
            mfa: { enabled: state.enabled, required: false, available: true } } }));
  let confirmBody = null;
  await page.route('**/api/me/mfa/start', r => r.fulfill({ json: { ok: true, challenge: 'e'.repeat(40), maskedEmail: 'a***@x***.com' } }));
  await page.route('**/api/me/mfa/confirm', r => {
    confirmBody = r.request().postDataJSON();
    if (confirmBody.code !== '654321') return r.fulfill({ status: 400, json: { error: 'invalid_code', message: 'That code is not correct.' } });
    state.enabled = true;
    r.fulfill({ json: { ok: true } });
  });
  let disableBody = null;
  await page.route('**/api/me/mfa/disable', r => {
    disableBody = r.request().postDataJSON();
    state.enabled = false;
    r.fulfill({ json: { ok: true } });
  });
  await openPane(page, 'User account', 'account');
  assert((await page.innerText('#mfaStatusLine')).includes('MFA is OFF'), 'cenário 5: MFA começa desligado');
  await page.click('#mfaEnableBtn');
  await page.waitForSelector('#mfaConfirmCode');
  await page.fill('#mfaConfirmCode', '111111');
  await page.click('#mfaConfirmBtn');
  await assertEventually(async () => (await page.innerText('#mfaMsg')).includes('not correct'), 'cenário 5: código errado não liga o MFA');
  await page.fill('#mfaConfirmCode', '654321');
  await page.click('#mfaConfirmBtn');
  await assertEventually(async () => (await page.innerText('#mfaStatusLine')).includes('MFA is ON'), 'cenário 5: depois do código certo o status vira ON');
  assert(confirmBody.challenge === 'e'.repeat(40), 'cenário 5: confirm leva o id do desafio');
  await page.fill('#mfaOffPw', 'senha-forte-1');
  await page.click('#mfaDisableBtn');
  await assertEventually(async () => disableBody && disableBody.password === 'senha-forte-1', 'cenário 5: desligar envia a senha');
  await assertEventually(async () => (await page.innerText('#mfaStatusLine')).includes('MFA is OFF'), 'cenário 5: volta a OFF');
});

// ── 5b: MFA exigido pelo admin — sem opção de desligar; sem SMTP — indisponível ──
await withPage(browser, async page => {
  await mockApp(page, { me: { mfa: { enabled: true, required: true, available: true } } });
  await openPane(page, 'User account', 'account');
  assert((await page.innerText('#mfaStatusLine')).includes('An administrator requires MFA'), 'cenário 5b: mostra que o administrador exige');
  assert((await page.locator('#mfaDisableBtn').count()) === 0, 'cenário 5b: exigido → não há botão para desligar');
});
await withPage(browser, async page => {
  await mockApp(page, { me: { mfa: { enabled: false, required: false, available: false } } });
  await openPane(page, 'User account', 'account');
  assert((await page.locator('#mfaUnavailable').count()) === 1 && (await page.locator('#mfaEnableBtn').count()) === 0,
    'cenário 5b: sem SMTP o MFA aparece como indisponível');
});

// ── 6: local → SSO: botão só para provedor ativo; confirma e navega para ?link=1 ──
await withPage(browser, async page => {
  await mockApp(page);
  let linked = null;
  await page.route('**/api/auth/google?link=1', r => { linked = r.request().url(); r.fulfill({ status: 200, body: 'ok', contentType: 'text/plain' }); });
  await openPane(page, 'User account', 'account');
  assert(await page.isEnabled('#switchToGoogle'), 'cenário 6: Google configurado → botão habilitado');
  await assertEventually(async () => await page.isDisabled('#switchToMicrosoft'), 'cenário 6: Microsoft não configurado → botão desabilitado');
  await page.click('#switchToGoogle');
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(async () => !!linked && linked.endsWith('/api/auth/google?link=1'), 'cenário 6: confirmar leva ao fluxo /api/auth/google?link=1');
});

// ── 7: SSO → local ──
await withPage(browser, async page => {
  await mockApp(page, { me: { authMethod: 'google', isLocal: false, authProvider: 'google', mfa: undefined } });
  let body = null;
  await page.route('**/api/me/convert-to-local', r => { body = r.request().postDataJSON(); r.fulfill({ json: { ok: true } }); });
  await openPane(page, 'User account', 'account');
  assert((await page.locator('#acctGroupMfa').count()) === 0, 'cenário 7: conta SSO não mostra MFA por e-mail');
  assert((await page.locator('#switchToGoogle').count()) === 0, 'cenário 7: conta SSO não mostra "Switch to Google"');
  await page.fill('#toLocalPw', 'senha-do-joao-1');
  await page.fill('#toLocalPw2', 'diferente-123');
  await page.click('#switchToLocal');
  await page.waitForSelector('#signInMethodMsg');
  assert(body === null && (await page.innerText('#signInMethodMsg')).includes('do not match'), 'cenário 7: confirmação diferente não envia');
  await page.fill('#toLocalPw2', 'senha-do-joao-1');
  await page.click('#switchToLocal');
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(async () => body && body.password === 'senha-do-joao-1', 'cenário 7: POST /api/me/convert-to-local com a senha');
});

// ── 8: volta do provedor mostra o resultado (e limpa a URL) ──
await withPage(browser, async page => {
  await mockApp(page);
  const msgs = [];
  page.removeAllListeners('dialog');
  page.on('dialog', d => { msgs.push(d.message()); d.accept(); });
  await page.goto(`${BASE}/index.html?convert=error&reason=email_mismatch`);
  await page.waitForSelector('.theme-toggle[title="Settings"]');
  await assertEventually(async () => msgs.some(m => m.includes('different e-mail')), 'cenário 8: erro de e-mail diferente é explicado');
  assert(!page.url().includes('convert='), 'cenário 8: query limpa da URL');
});

// ── 9: super admin — SMTP (salvar sem pré-preencher senha, testar) ──
await withPage(browser, async page => {
  await mockApp(page, { isSuperAdmin: true });
  const smtp = { configured: true, host: 'smtp.example.com', port: 587, security: 'starttls', username: 'robo', hasPassword: true,
                 fromAddress: 'toolbox@example.com', fromName: 'Toolbox45', appUrl: 'https://toolbox.example.com', updatedAt: null, updatedBy: 'ana@x.com', secretKeyConfigured: true };
  let saved = null, tested = null;
  await page.route('**/api/system/smtp', r => {
    if (r.request().method() === 'PUT') { saved = r.request().postDataJSON(); return r.fulfill({ json: { ...smtp, host: saved.host } }); }
    r.fulfill({ json: smtp });
  });
  await page.route('**/api/system/smtp/test', r => { tested = r.request().postDataJSON(); r.fulfill({ json: { ok: true } }); });
  await page.route('**/api/system/mfa', r => r.fulfill({ json: { requireAll: false, smtpAvailable: true, requiredUsers: 0, enabledUsers: 2 } }));
  await page.route('**/api/system/oauth', r => r.fulfill({ json: { google: { configured: false, source: null, clientSecretSet: false }, microsoft: { configured: false, source: null, clientSecretSet: false } } }));
  await page.route('**/api/api-keys', r => r.fulfill({ json: [] }));
  await openPane(page, 'System', 'system');
  await assertEventually(async () => (await page.innerText('#smtpStatus')).includes('smtp.example.com:587'), 'cenário 9: status mostra o servidor configurado');
  await page.click('#smtpConfigureBtn');
  await page.waitForSelector('#smtpSettingsBox');
  await assertEventually(async () => (await page.inputValue('#smtpSettingsBox input[placeholder="smtp.example.com"]')) === 'smtp.example.com', 'cenário 9: campos preenchidos com o que está salvo');
  assert((await page.locator('#smtpSettingsBox input[type="password"]').inputValue()) === '', 'cenário 9: a senha NUNCA vem preenchida');
  await page.fill('#smtpSettingsBox input[placeholder="smtp.example.com"]', 'smtp2.example.com');
  await page.click('#smtpSaveBtn');
  await assertEventually(async () => saved && saved.host === 'smtp2.example.com' && saved.password === '' && saved.port === 587, 'cenário 9: PUT com host novo e senha em branco (mantém)');
  await page.fill('#smtpSettingsBox input[placeholder="you@example.com"]', 'dest@x.com');
  await page.click('#smtpTestBtn');
  await assertEventually(async () => tested && tested.to === 'dest@x.com', 'cenário 9: "Send test" chama /test com o destinatário');
  // porta acompanha o modo de segurança enquanto estava no padrão
  await page.selectOption('#smtpSettingsBox select', 'ssl');
  assert((await page.inputValue('#smtpSettingsBox input[inputmode="numeric"]')) === '465', 'cenário 9: SSL/TLS troca a porta padrão para 465');
});

// ── 10: super admin — política de MFA (precisa de SMTP; confirma antes de exigir) ──
await withPage(browser, async page => {
  await mockApp(page, { isSuperAdmin: true });
  await page.route('**/api/system/smtp', r => r.fulfill({ json: { configured: false, host: '', port: 587, security: 'starttls', username: '', hasPassword: false, fromAddress: '', fromName: '', appUrl: '', updatedAt: null, updatedBy: null, secretKeyConfigured: true } }));
  let policy = { requireAll: false, smtpAvailable: false, requiredUsers: 0, enabledUsers: 0 };
  let put = null;
  await page.route('**/api/system/mfa', r => {
    if (r.request().method() === 'PUT') { put = r.request().postDataJSON(); policy = { ...policy, requireAll: put.requireAll }; }
    r.fulfill({ json: policy });
  });
  await page.route('**/api/system/oauth', r => r.fulfill({ json: { google: { configured: false, source: null, clientSecretSet: false }, microsoft: { configured: false, source: null, clientSecretSet: false } } }));
  await page.route('**/api/api-keys', r => r.fulfill({ json: [] }));
  await openPane(page, 'System', 'system');
  await page.waitForSelector('#mfaSmtpWarn');
  assert(await page.isDisabled('#mfaRequireAll'), 'cenário 10: sem SMTP não dá para exigir MFA (checkbox desabilitado + aviso)');
  policy = { ...policy, smtpAvailable: true };
  await page.locator('.settings-nav-btn', { hasText: 'Database' }).click();
  await page.locator('.settings-nav-btn', { hasText: 'System' }).click();
  await page.waitForSelector('#mfaRequireAll:not([disabled])');
  await page.click('#mfaRequireAll');
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(async () => put && put.requireAll === true, 'cenário 10: confirmar envia PUT {requireAll:true}');
  await assertEventually(async () => await page.isChecked('#mfaRequireAll'), 'cenário 10: checkbox fica marcado');
});

// ── 11: Users — exigir/resetar MFA por usuário ──
await withPage(browser, async page => {
  await mockApp(page, { isSuperAdmin: true });
  const users = [
    { username: 'ana@x.com', role: 'user', is_local: 1, disabled: 0, auth_provider: 'local', approved_at: '2026-01-01', mfa_enabled: 1, mfa_required: 0 },
    { username: 'bia@x.com', role: 'user', is_local: 1, disabled: 0, auth_provider: 'local', approved_at: '2026-01-01', mfa_enabled: 0, mfa_required: 0 },
    { username: 'joao@corp.com', role: 'user', is_local: 0, disabled: 0, auth_provider: 'google', approved_at: '2026-01-01', mfa_enabled: 0, mfa_required: 0 },
  ];
  const puts = [];
  await page.route('**/api/users', r => r.fulfill({ json: users }));
  await page.route('**/api/users/*', r => {
    if (r.request().method() === 'PUT') {
      const b = r.request().postDataJSON();
      const u = users.find(x => r.request().url().endsWith(encodeURIComponent(x.username)));
      puts.push([u.username, b]);
      if (b.mfaRequired !== undefined) u.mfa_required = b.mfaRequired ? 1 : 0;
      if (b.resetMfa) u.mfa_enabled = 0;
      return r.fulfill({ json: u });
    }
    r.continue();
  });
  await openPane(page, 'Users', 'users');
  await page.waitForSelector('text=bia@x.com');
  const rowOf = name => page.locator('tr', { hasText: name });
  async function menuLabels(name) {
    await rowOf(name).locator('.row-actions button').last().click();
    return await page.locator('[role="menu"] [role="menuitem"], .row-menu button').allInnerTexts();
  }
  const bia = await menuLabels('bia@x.com');
  assert(bia.some(t => t.includes('Require MFA')) && !bia.some(t => t.includes('Reset MFA')), 'cenário 11: usuária sem MFA → "Require MFA", sem "Reset MFA"');
  await page.keyboard.press('Escape');
  const joao = await menuLabels('joao@corp.com');
  assert(!joao.some(t => t.includes('MFA')), 'cenário 11: conta SSO não tem opções de MFA');
  await page.keyboard.press('Escape');
  const ana = await menuLabels('ana@x.com');
  assert(ana.some(t => t.includes('Reset MFA')), 'cenário 11: usuária com MFA ligado → "Reset MFA"');
  await page.locator('[role="menuitem"]:has-text("Reset MFA"), .row-menu button:has-text("Reset MFA")').first().click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(async () => puts.some(([u, b]) => u === 'ana@x.com' && b.resetMfa === true), 'cenário 11: Reset MFA envia {resetMfa:true}');
  await menuLabels('bia@x.com');
  await page.locator('[role="menuitem"]:has-text("Require MFA"), .row-menu button:has-text("Require MFA")').first().click();
  await assertEventually(async () => puts.some(([u, b]) => u === 'bia@x.com' && b.mfaRequired === true), 'cenário 11: Require MFA envia {mfaRequired:true}');
  await assertEventually(async () => (await rowOf('bia@x.com').innerText()).includes('required'), 'cenário 11: a linha passa a mostrar o selo "MFA · required…"');
});

await browser.close();
console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
