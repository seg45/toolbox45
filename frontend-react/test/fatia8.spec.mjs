// Suíte de validação manual (Playwright) da Fase 3, fatia 8 (aba "System"
// do modal de Configurações + sincronização de dados do usuário entre
// navegadores) — mesmo padrão de mocking de /api/* usado em
// test/fatia6.spec.mjs/test/fatia7.spec.mjs (route() por endpoint, sem
// backend real rodando; fixtures em memória mutáveis com contadores `calls`
// pra verificar quantas vezes um endpoint foi chamado; helpers
// assert/withPage/assertEventually idênticos). Cobre dois domínios:
//
//   A-F. SystemPane.tsx e os 5 widgets admin (Logo/Appearance/SSL/OAuth/API
//        access) — gating por role, fluxos de cada modal.
//   G.   lib/userDataSync.ts — sincronização de 'cpa-theme'/'cpa-settings'/
//        histórico de busca entre navegadores do mesmo usuário via
//        GET/PUT /api/user-data.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/fase3-fatia8-shots';
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
// FIXTURES / MOCKS BASE (idêntico a fatia6/fatia7)
// ════════════════════════════════════════════════

const EMPTY_CATALOGS = { vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [] };

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
  await page.route('**/api/system/logo', route => (route.request().method() === 'GET' ? route.fulfill({ json: { imageData: null, imageDataDark: null } }) : route.continue()));
  await page.route('**/api/commands', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  await page.route('**/api/folders', route => (route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue()));
  // /api/user-data — se nenhum cenário sobrescrever, devolve {} (sem
  // sementes) — necessário pra AppShell montar sem travar (useUserDataSync
  // chama initUserDataSync no mount, que faz GET /api/user-data).
  await page.route('**/api/user-data', route => (route.request().method() === 'GET' ? route.fulfill({ json: {} }) : route.continue()));
}

async function goToApp(page) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.theme-toggle[title="Settings"]');
}

async function openSettings(page) {
  await page.click('.theme-toggle[title="Settings"]');
  await page.waitForSelector('.settings-modal-box');
}

// state:'attached' (não 'visible') — a pane "system" é SEMPRE montada,
// mesmo pra usuário comum (só os .set-group internos é que são gated, ver
// SystemPane.tsx); nesse caso ela fica vazia e colapsa a 0x0 (flex column
// sem filhos), o que o Playwright trata como "hidden" por bounding box
// zero, não por display:none de verdade.
async function openSystemPane(page) {
  await openSettings(page);
  await page.locator('.settings-nav-btn', { hasText: 'System' }).click();
  await page.waitForSelector('.settings-pane[data-pane="system"]', { state: 'attached' });
}

function systemWidgetLabels(page) {
  return page.locator('.settings-pane[data-pane="system"] > .set-group > .set-label');
}

// .set-label tem text-transform:uppercase em CSS — innerText() devolve o
// texto RENDERIZADO (já maiúsculo), não o texto literal do JSX. Comparamos
// em minúsculas pra não acoplar o teste a uma regra puramente visual.
async function labelsTextLower(locator) {
  const texts = await locator.allInnerTexts();
  return texts.map(t => t.toLowerCase());
}

// ════════════════════════════════════════════════
// MOCKS ESPECÍFICOS DA FATIA 8 — estado mutável em memória pros novos
// endpoints de System. Registrada DEPOIS de mockBase() (Playwright usa o
// último route() registrado pro mesmo padrão), do mesmo jeito que
// mockCatalogAdmin()/mockUsers() fazem em fatia6/fatia7.
// ════════════════════════════════════════════════
function makeSystemState(overrides = {}) {
  const state = {
    appearance: { theme: 'light', accentColor: 'teal', ...(overrides.appearance || {}) },
    logo: { imageData: null, imageDataDark: null, ...(overrides.logo || {}) },
    oauth: {
      google: { configured: false, source: null, clientSecretSet: false, ...(overrides.oauth?.google || {}) },
      microsoft: { configured: false, source: null, clientSecretSet: false, ...(overrides.oauth?.microsoft || {}) },
    },
    ssl: {
      subject: 'CN=toolbox45.local', issuer: 'CN=toolbox45.local',
      validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z',
      fingerprint256: 'AA:BB:CC', isSelfSigned: true, isExpired: false,
      ...(overrides.ssl || {}),
    },
    apiKeys: overrides.apiKeys || [],
    userData: overrides.userData || {},
    nextApiKeyId: 100,
    calls: {
      appearanceGet: 0, appearancePut: [],
      logoPut: [], logoDelete: [],
      oauthGet: 0, oauthPut: { google: [], microsoft: [] }, oauthDelete: { google: [], microsoft: [] },
      sslGet: 0, sslPost: [], sslDelete: 0,
      apiKeysGet: 0, apiKeysPost: [], apiKeysDelete: [],
      userDataGet: 0, userDataPut: [],
    },
  };
  return state;
}

async function mockSystemPane(page, state) {
  await page.route('**/api/system/appearance', route => {
    const method = route.request().method();
    if (method === 'GET') {
      state.calls.appearanceGet++;
      return route.fulfill({ json: state.appearance });
    }
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      state.calls.appearancePut.push(body);
      state.appearance = { theme: body.theme, accentColor: body.accentColor };
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });

  // '*' no final (não só '**/api/system/logo') — o DELETE usa querystring
  // ('?theme=light'), que o pattern sem sufixo curinga não bate (o glob do
  // Playwright exige correspondência da URL inteira).
  await page.route('**/api/system/logo*', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: state.logo });
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      state.calls.logoPut.push(body);
      if (body.theme === 'dark') {
        state.logo.imageDataDark = body.imageData;
        state.logo.updatedByDark = 'tester';
        state.logo.updatedAtDark = '2026-02-01T00:00:00Z';
      } else {
        state.logo.imageData = body.imageData;
        state.logo.updatedBy = 'tester';
        state.logo.updatedAt = '2026-02-01T00:00:00Z';
      }
      return route.fulfill({ json: { imageData: body.imageData } });
    }
    if (method === 'DELETE') {
      const theme = new URL(route.request().url()).searchParams.get('theme');
      state.calls.logoDelete.push(theme);
      if (theme === 'dark') {
        state.logo.imageDataDark = null;
        state.logo.updatedByDark = null;
        state.logo.updatedAtDark = null;
      } else {
        state.logo.imageData = null;
        state.logo.updatedBy = null;
        state.logo.updatedAt = null;
      }
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });

  await page.route('**/api/system/oauth', route => {
    if (route.request().method() === 'GET') {
      state.calls.oauthGet++;
      return route.fulfill({ json: state.oauth });
    }
    return route.continue();
  });

  for (const provider of ['google', 'microsoft']) {
    await page.route(`**/api/system/oauth/${provider}`, route => {
      const method = route.request().method();
      if (method === 'PUT') {
        const body = route.request().postDataJSON();
        state.calls.oauthPut[provider].push(body);
        state.oauth[provider] = {
          configured: true,
          source: 'db',
          clientId: body.clientId,
          redirectUri: body.redirectUri,
          tenantId: body.tenantId,
          clientSecretSet: true,
          updatedBy: 'tester',
          updatedAt: '2026-02-01T00:00:00Z',
        };
        return route.fulfill({ json: { ok: true } });
      }
      if (method === 'DELETE') {
        state.calls.oauthDelete[provider].push(true);
        state.oauth[provider] = { configured: false, source: null, clientSecretSet: false };
        return route.fulfill({ status: 204, body: '' });
      }
      return route.continue();
    });
  }

  await page.route('**/api/system/ssl-certificate', route => {
    const method = route.request().method();
    if (method === 'GET') {
      state.calls.sslGet++;
      return route.fulfill({ json: state.ssl });
    }
    if (method === 'POST') {
      const body = route.request().postDataJSON();
      state.calls.sslPost.push(body);
      return route.fulfill({ json: state.ssl });
    }
    if (method === 'DELETE') {
      state.calls.sslDelete++;
      return route.fulfill({ json: state.ssl });
    }
    return route.continue();
  });

  await page.route('**/api/api-keys', route => {
    const method = route.request().method();
    if (method === 'GET') {
      state.calls.apiKeysGet++;
      return route.fulfill({ json: state.apiKeys });
    }
    if (method === 'POST') {
      const body = route.request().postDataJSON();
      state.calls.apiKeysPost.push(body);
      const id = state.nextApiKeyId++;
      state.apiKeys.push({
        id, name: body.name, role: body.role, key_prefix: `tb45_${id}`,
        created_by: 'tester', created_at: '2026-02-01T00:00:00Z',
        expires_at: null, last_used_at: null, revoked_at: null,
      });
      return route.fulfill({ status: 201, json: { key: `tb45_${id}xxxxxxxxxxxx` } });
    }
    return route.continue();
  });

  await page.route('**/api/api-keys/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    if (route.request().method() === 'DELETE') {
      state.calls.apiKeysDelete.push(id);
      state.apiKeys = state.apiKeys.filter(k => k.id !== id);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });

  await page.route('**/api/user-data', route => {
    const method = route.request().method();
    if (method === 'GET') {
      state.calls.userDataGet++;
      return route.fulfill({ json: state.userData });
    }
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      state.calls.userDataPut.push(body);
      Object.assign(state.userData, body);
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });
}

// Fabrica um arquivo PNG 1x1 transparente mínimo em memória (base64) —
// usado no cenário 5 (upload válido de logo).
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const browser = await chromium.launch();

// ════════════════════════════════════════════════
// A — GATING POR ROLE
// ════════════════════════════════════════════════

// ── Cenário 1: usuário comum vê o item de nav "System" mas nenhum widget ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: false, isSuperAdmin: false });
  await goToApp(page);
  await openSettings(page);
  assert((await page.locator('.settings-nav-btn', { hasText: 'System' }).count()) === 1, 'cenário 1: o item de nav "System" aparece mesmo pra usuário comum (não é gated)');
  await page.locator('.settings-nav-btn', { hasText: 'System' }).click();
  await page.waitForSelector('.settings-pane[data-pane="system"]', { state: 'attached' });
  assert((await page.locator('.settings-pane[data-pane="system"] .set-group').count()) === 0, 'cenário 1: nenhum dos 5 widgets (.set-group) aparece pra usuário comum');
});

// ── Cenário 2: admin comum vê 4 widgets (sem "Default theme & colors") ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: false });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);
  await openSystemPane(page);

  const labels = await labelsTextLower(systemWidgetLabels(page));
  assert(
    JSON.stringify(labels) === JSON.stringify(['logo', 'ssl certificate', 'oauth integrations', 'api access']),
    `cenário 2: admin comum vê 4 widgets, sem Appearance (lido: ${JSON.stringify(labels)})`
  );
  await page.screenshot({ path: `${SHOTS}/2-system-admin.png` });
});

// ── Cenário 3: super admin vê os 5 widgets ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);
  await openSystemPane(page);

  const labels = await labelsTextLower(systemWidgetLabels(page));
  assert(
    JSON.stringify(labels) === JSON.stringify(['logo', 'default theme & colors', 'ssl certificate', 'oauth integrations', 'api access']),
    `cenário 3: super admin vê os 5 widgets (lido: ${JSON.stringify(labels)})`
  );
});

// ════════════════════════════════════════════════
// B — LOGO
// ════════════════════════════════════════════════

// ── Cenário 4: tipo de arquivo inválido mostra alert() nativo ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);
  await openSystemPane(page);

  await page.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Logo' }) }).locator('button', { hasText: 'Manage logo' }).click();
  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Logo' }) });
  await modal.waitFor();

  let dialogMsg = null;
  page.once('dialog', async dialog => {
    dialogMsg = dialog.message();
    await dialog.accept();
  });
  const lightSection = modal.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Light theme logo' }) });
  await lightSection.locator('input[type="file"]').setInputFiles({ name: 'bad.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await assertEventually(() => dialogMsg === 'Unsupported image format — use PNG, JPEG or WEBP.', `cenário 4: alert nativo com a mensagem exata (lido: ${JSON.stringify(dialogMsg)})`);
});

// ── Cenário 5: PNG válido habilita Save, salva, aplica no header ao vivo ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);

  const headerImg = page.locator('img.hdr-logo-img.for-light');
  const srcBefore = await headerImg.getAttribute('src');
  assert(!srcBefore || !srcBefore.startsWith('data:'), 'cenário 5: antes do save, o header mostra o logo default (não um data: URL customizado)');

  await openSystemPane(page);
  await page.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Logo' }) }).locator('button', { hasText: 'Manage logo' }).click();
  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Logo' }) });
  await modal.waitFor();

  const lightSection = modal.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Light theme logo' }) });
  const saveBtn = lightSection.locator('button', { hasText: 'Save' });
  assert(await saveBtn.isDisabled(), 'cenário 5: "Save" começa desabilitado (sem arquivo escolhido)');

  await lightSection.locator('input[type="file"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1X1_BASE64, 'base64') });
  await assertEventually(async () => !(await saveBtn.isDisabled()), 'cenário 5: escolher um PNG válido habilita "Save"');

  await saveBtn.click();
  await assertEventually(() => state.calls.logoPut.length === 1, 'cenário 5: PUT /api/system/logo foi chamado');
  assert(state.calls.logoPut[0].theme === 'light' && state.calls.logoPut[0].imageData.startsWith('data:image/png'), 'cenário 5: payload {theme:"light", imageData: data URL} correto');
  await assertEventually(async () => (await lightSection.locator('.set-hint').last().innerText()) === 'Saved.', 'cenário 5: status "Saved." aparece');

  // O ponto mais arriscado: o <img> do HEADER (fora do modal) deve refletir
  // o novo logo, ao vivo, sem reload — via onLogoChanged (logo.refresh)
  // chegando de volta até Header.tsx.
  await assertEventually(async () => {
    const src = await headerImg.getAttribute('src');
    return !!src && src.startsWith('data:image/png');
  }, 'cenário 5: o <img class="hdr-logo-img for-light"> do header reflete a nova imagem após o save (onLogoChanged/refresh)');
});

// ── Cenário 6: "Reset" (delete) do logo com confirmação ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState({ logo: { imageData: `data:image/png;base64,${PNG_1X1_BASE64}`, updatedBy: 'alice', updatedAt: '2026-01-01T00:00:00Z' } });
  await mockSystemPane(page, state);
  await goToApp(page);
  await openSystemPane(page);

  await page.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Logo' }) }).locator('button', { hasText: 'Manage logo' }).click();
  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Logo' }) });
  await modal.waitFor();
  const lightSection = modal.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Light theme logo' }) });

  await assertEventually(async () => (await lightSection.locator('button', { hasText: 'Reset' }).count()) === 1, 'cenário 6: botão "Reset" aparece (há um logo customizado)');
  await lightSection.locator('button', { hasText: 'Reset' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn', { hasText: 'Confirm' }).click();

  await assertEventually(() => state.calls.logoDelete.includes('light'), 'cenário 6: DELETE /api/system/logo?theme=light foi chamado');
  await assertEventually(async () => (await lightSection.locator('.set-hint').last().innerText()) === 'Reverted to the default logo.', 'cenário 6: status "Reverted to the default logo." aparece');
});

// ════════════════════════════════════════════════
// C — APPEARANCE (super_admin-only)
// ════════════════════════════════════════════════

async function openAppearanceModal(page) {
  await openSystemPane(page);
  await page.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Default theme & colors' }) }).locator('button', { hasText: 'Manage appearance' }).click();
  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Default theme & colors' }) });
  await modal.waitFor();
  return modal;
}

// ── Cenário 7: Save nasce desabilitado ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeSystemState({ appearance: { theme: 'light', accentColor: 'teal' } });
  await mockSystemPane(page, state);
  await goToApp(page);
  const modal = await openAppearanceModal(page);

  await assertEventually(() => state.calls.appearanceGet === 1, 'cenário 7: GET /api/system/appearance foi chamado ao abrir');
  const saveBtn = modal.locator('button', { hasText: 'Save' });
  await assertEventually(async () => await saveBtn.isDisabled(), 'cenário 7: "Save" nasce desabilitado logo após carregar');
});

// ── Cenário 8: toggle pra dark habilita Save; swatch "white" ok; voltar pra light reseta accent e esconde "white" ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeSystemState({ appearance: { theme: 'light', accentColor: 'teal' } });
  await mockSystemPane(page, state);
  await goToApp(page);
  const modal = await openAppearanceModal(page);

  const saveBtn = modal.locator('button', { hasText: 'Save' });
  const whiteSwatch = modal.locator('.accent-swatch[title^="White"]');
  assert(!(await whiteSwatch.isVisible()), 'cenário 8: swatch "white" fica oculto no tema claro');

  await modal.locator('.sb-toggle').click();
  await assertEventually(async () => !(await saveBtn.isDisabled()), 'cenário 8: alternar pra "dark" habilita "Save"');
  await assertEventually(async () => await whiteSwatch.isVisible(), 'cenário 8: swatch "white" aparece no tema escuro');

  await whiteSwatch.click();
  assert(await whiteSwatch.evaluate(el => el.classList.contains('on')), 'cenário 8: swatch "white" fica selecionado (válido no escuro)');

  await modal.locator('.sb-toggle').click(); // volta pra light
  await assertEventually(async () => !(await whiteSwatch.isVisible()), 'cenário 8: voltar pra "light" esconde o swatch "white" de novo');
  const tealSwatch = modal.locator('.accent-swatch[title^="Toolbox45 teal"]');
  await assertEventually(async () => tealSwatch.evaluate(el => el.classList.contains('on')), 'cenário 8: o accent pendente volta sozinho pra "teal" ao sair do escuro com "white" selecionado');
});

// ── Cenário 9: salvar com sucesso ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true, isSuperAdmin: true });
  const state = makeSystemState({ appearance: { theme: 'light', accentColor: 'teal' } });
  await mockSystemPane(page, state);
  await goToApp(page);
  const modal = await openAppearanceModal(page);

  const saveBtn = modal.locator('button', { hasText: 'Save' });
  await modal.locator('.sb-toggle').click();
  await assertEventually(async () => !(await saveBtn.isDisabled()), 'cenário 9: dirty após o toggle');
  await saveBtn.click();

  await assertEventually(() => state.calls.appearancePut.length === 1, 'cenário 9: PUT /api/system/appearance foi chamado');
  assert(JSON.stringify(state.calls.appearancePut[0]) === JSON.stringify({ theme: 'dark', accentColor: 'teal' }), `cenário 9: payload correto (lido: ${JSON.stringify(state.calls.appearancePut[0])})`);
  await assertEventually(async () => (await modal.locator('.set-hint').last().innerText()) === 'Saved.', 'cenário 9: status "Saved." aparece');
  assert(await saveBtn.isDisabled(), 'cenário 9: "Save" volta a desabilitar após salvar');
});

// ════════════════════════════════════════════════
// D — OAUTH INTEGRATIONS
// ════════════════════════════════════════════════

// `fresh:false` reaproveita a Settings modal (+ aba System) já aberta por
// trás — mesmo padrão do comentário em fatia7.spec.mjs/cenário 23: fechar
// só o modal do provider (✕/overlay) deixa Configurações aberta por trás,
// então reabrir do zero bateria no overlay dela mesma (que ainda está
// "show") em vez do botão de engrenagem do header.
async function openOauthModal(page, providerLabel, fresh = true) {
  if (fresh) await openSystemPane(page);
  const row = page.locator('.oauth-provider-row', { has: page.locator('.oauth-provider-name', { hasText: providerLabel }) });
  await row.locator('button', { hasText: 'Configure' }).click();
  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: `Configure ${providerLabel} sign-in` }) });
  await modal.waitFor();
  return modal;
}

// ── Cenário 10: status "Not configured" quando configured:false ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);
  await openSystemPane(page);

  const googleRow = page.locator('.oauth-provider-row', { has: page.locator('.oauth-provider-name', { hasText: 'Google' }) });
  const msRow = page.locator('.oauth-provider-row', { has: page.locator('.oauth-provider-name', { hasText: 'Microsoft' }) });
  await assertEventually(async () => (await googleRow.locator('.oauth-provider-status').innerText()) === 'Not configured', 'cenário 10: Google mostra "Not configured"');
  await assertEventually(async () => (await msRow.locator('.oauth-provider-status').innerText()) === 'Not configured', 'cenário 10: Microsoft mostra "Not configured"');
});

// ── Cenário 11: Tenant ID só aparece pro Microsoft ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);

  const googleModal = await openOauthModal(page, 'Google');
  assert((await googleModal.locator('.set-label', { hasText: 'Tenant ID' }).count()) === 0, 'cenário 11: "Tenant ID" NÃO aparece no modal do Google');
  await googleModal.locator('.modal-close').click();
  await assertEventually(async () => (await googleModal.count()) === 0, 'cenário 11: modal do Google fecha');

  const msModal = await openOauthModal(page, 'Microsoft', false);
  assert((await msModal.locator('.set-label', { hasText: 'Tenant ID' }).count()) === 1, 'cenário 11: "Tenant ID" aparece no modal do Microsoft');
});

// ── Cenário 12: salvar sem Client ID mostra mensagem inline (sem alert nativo) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);
  const modal = await openOauthModal(page, 'Google');

  let dialogFired = false;
  page.once('dialog', async d => { dialogFired = true; await d.accept(); });
  await modal.locator('button', { hasText: 'Save' }).click();

  await assertEventually(async () => (await modal.locator('.set-hint', { hasText: 'Client ID and Redirect URI are required.' }).count()) === 1, 'cenário 12: mensagem inline "Client ID and Redirect URI are required."');
  assert(!dialogFired, 'cenário 12: nenhum alert() nativo disparado');
  assert(state.calls.oauthPut.google.length === 0, 'cenário 12: nenhum PUT disparado sem Client ID');
});

// ── Cenário 13: "Danger zone" só aparece com source:"db" ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState({ oauth: { google: { configured: true, source: 'db', clientId: 'abc', clientSecretSet: true } } });
  await mockSystemPane(page, state);
  await goToApp(page);

  const dbModal = await openOauthModal(page, 'Google');
  await assertEventually(async () => (await dbModal.locator('.set-label', { hasText: 'Danger zone' }).count()) === 1, 'cenário 13: "Danger zone" aparece com source:"db"');
  await dbModal.locator('.modal-close').click();
  await assertEventually(async () => (await dbModal.count()) === 0, 'cenário 13: modal do Google fecha');

  const envModal = await openOauthModal(page, 'Microsoft', false); // Microsoft não configurado (source:null) por padrão
  assert((await envModal.locator('.set-label', { hasText: 'Danger zone' }).count()) === 0, 'cenário 13: "Danger zone" NÃO aparece sem config (source:null)');
});

await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState({ oauth: { microsoft: { configured: true, source: 'env', clientId: 'abc', clientSecretSet: true } } });
  await mockSystemPane(page, state);
  await goToApp(page);
  const envModal = await openOauthModal(page, 'Microsoft');
  const statusText = envModal.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Status' }) }).locator('.audit-log-wrap');
  await assertEventually(async () => (await statusText.innerText()).includes("server's environment variables"), 'cenário 13b: nota de status reflete source:"env"');
  assert((await envModal.locator('.set-label', { hasText: 'Danger zone' }).count()) === 0, 'cenário 13b: "Danger zone" NÃO aparece com source:"env"');
});

// ── Cenário 14: salvar com sucesso limpa o Client Secret e mostra status ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);
  const modal = await openOauthModal(page, 'Google');

  await modal.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Client ID' }) }).locator('input').fill('my-client-id');
  await modal.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Client Secret' }) }).locator('input').fill('my-secret');
  await modal.locator('button', { hasText: 'Save' }).click();

  await assertEventually(() => state.calls.oauthPut.google.length === 1, 'cenário 14: PUT /api/system/oauth/google foi chamado');
  assert(state.calls.oauthPut.google[0].clientId === 'my-client-id' && state.calls.oauthPut.google[0].clientSecret === 'my-secret', 'cenário 14: payload com clientId/clientSecret corretos');
  await assertEventually(async () => (await modal.locator('.set-hint').nth(2).innerText()).startsWith('Saved. The sign-in button now appears'), 'cenário 14: status "Saved. The sign-in button now appears on the login page."');
  await assertEventually(async () => (await modal.locator('.set-group', { has: page.locator('.set-label', { hasText: 'Client Secret' }) }).locator('input').inputValue()) === '', 'cenário 14: o campo de Client Secret volta a ficar vazio após salvar');
});

// ════════════════════════════════════════════════
// E — SSL CERTIFICATE
// ════════════════════════════════════════════════

async function openSslModal(page) {
  await openSystemPane(page);
  await page.locator('.set-group', { has: page.locator('.set-label', { hasText: 'SSL Certificate' }) }).locator('button', { hasText: 'Manage certificate' }).click();
  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'SSL Certificate' }) });
  await modal.waitFor();
  return modal;
}

// ── Cenário 15: salvar sem cert/key mostra status inline ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);
  const modal = await openSslModal(page);

  await modal.locator('button', { hasText: 'Save certificate' }).click();
  await assertEventually(async () => (await modal.locator('.set-hint', { hasText: 'Paste (or upload) both the certificate and the private key.' }).count()) === 1, 'cenário 15: status inline sem cert/key');
  assert(state.calls.sslPost.length === 0, 'cenário 15: nenhum POST disparado sem cert/key');
});

// ── Cenário 16: upload de arquivo de certificado cai no textarea (trimmed) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState();
  await mockSystemPane(page, state);
  await goToApp(page);
  const modal = await openSslModal(page);

  // Certificate/Private key/Chain moram DENTRO do mesmo .set-group ("Import
  // / replace certificate") — não são 3 .set-group separados — então
  // Certificate (PEM) é a 1ª textarea/input[type=file] (ordem: cert, key,
  // chain), não algo isolável por um .set-label ancestral.
  const certTextarea = modal.locator('textarea').nth(0);
  const content = '\n  -----BEGIN CERTIFICATE-----\nABC123\n-----END CERTIFICATE-----  \n';
  await modal.locator('input[type="file"]').nth(0).setInputFiles({ name: 'cert.pem', mimeType: 'text/plain', buffer: Buffer.from(content) });

  await assertEventually(async () => (await certTextarea.inputValue()) === content.trim(), 'cenário 16: o textarea de certificado reflete o conteúdo do arquivo (trimmed)');
});

// ── Cenário 17: badges "expired"/"self-signed" ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState({ ssl: { isExpired: true, isSelfSigned: false } });
  await mockSystemPane(page, state);
  await goToApp(page);
  const modal = await openSslModal(page);

  await assertEventually(async () => (await modal.locator('.cat-protected-badge', { hasText: 'expired' }).count()) === 1, 'cenário 17: badge "expired" aparece com isExpired:true');
  assert((await modal.locator('.cat-protected-badge', { hasText: 'self-signed' }).count()) === 0, 'cenário 17: badge "self-signed" NÃO aparece com isSelfSigned:false');
});

await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState({ ssl: { isExpired: false, isSelfSigned: true } });
  await mockSystemPane(page, state);
  await goToApp(page);
  const modal = await openSslModal(page);

  await assertEventually(async () => (await modal.locator('.cat-protected-badge', { hasText: 'self-signed' }).count()) === 1, 'cenário 17b: badge "self-signed" aparece com isSelfSigned:true');
  assert((await modal.locator('.cat-protected-badge', { hasText: 'expired' }).count()) === 0, 'cenário 17b: badge "expired" NÃO aparece com isExpired:false');
});

// ════════════════════════════════════════════════
// F — API ACCESS
// ════════════════════════════════════════════════

// ── Cenário 18: lista vazia mostra mensagem ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState({ apiKeys: [] });
  await mockSystemPane(page, state);
  await goToApp(page);
  await openSystemPane(page);

  await assertEventually(
    async () => (await page.locator('.settings-pane[data-pane="system"] .audit-log-empty').innerText()) === 'No API keys yet — click "New API key" to create the first one.',
    'cenário 18: mensagem de lista vazia aparece'
  );
});

// ── Cenário 19: nome vazio não envia (foca o input) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState({ apiKeys: [] });
  await mockSystemPane(page, state);
  await goToApp(page);
  await openSystemPane(page);

  await page.locator('.settings-pane[data-pane="system"] button', { hasText: 'New API key' }).click();
  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'New API key' }) });
  await modal.waitFor();
  const nameInput = modal.locator('input[type="text"]');

  await modal.locator('button', { hasText: 'Create' }).click();
  await assertEventually(async () => (await modal.count()) === 1, 'cenário 19: o modal continua aberto (não fechou) com nome vazio');
  assert(await nameInput.evaluate(el => el === document.activeElement), 'cenário 19: o campo de nome recebe o foco');
  assert(state.calls.apiKeysPost.length === 0, 'cenário 19: nenhum POST disparado com nome vazio');
});

// ── Cenário 20: criar com sucesso recarrega a lista e abre o reveal ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState({ apiKeys: [] });
  await mockSystemPane(page, state);
  await goToApp(page);
  await openSystemPane(page);

  await page.locator('.settings-pane[data-pane="system"] button', { hasText: 'New API key' }).click();
  const newModal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'New API key' }) });
  await newModal.waitFor();
  await newModal.locator('input[type="text"]').fill('Integration X');
  const apiKeysGetBefore = state.calls.apiKeysGet;
  await newModal.locator('button', { hasText: 'Create' }).click();

  await assertEventually(async () => (await newModal.count()) === 0, 'cenário 20: o modal "New API key" fecha');
  await assertEventually(() => state.calls.apiKeysPost.length === 1, 'cenário 20: POST /api/api-keys foi chamado');
  await assertEventually(() => state.calls.apiKeysGet === apiKeysGetBefore + 1, 'cenário 20: a lista recarrega (novo GET /api/api-keys)');

  const revealModal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'API key created' }) });
  await revealModal.waitFor();
  const revealValue = await revealModal.locator('input[readonly]').inputValue();
  assert(revealValue.startsWith('tb45_'), `cenário 20: o modal de reveal abre automaticamente com a key (lido: ${revealValue})`);
  await assertEventually(async () => (await page.locator('.settings-pane[data-pane="system"] .audit-log-table tbody tr', { hasText: 'Integration X' }).count()) === 1, 'cenário 20: "Integration X" aparece na lista após o reload');
});

// ── Cenário 21: deletar confirma com a mensagem exata e chama DELETE ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: true });
  const state = makeSystemState({
    apiKeys: [{ id: 1, name: 'Old Integration', role: 'user', key_prefix: 'tb45_1', created_by: 'tester', created_at: '2026-01-01T00:00:00Z', expires_at: null, last_used_at: null, revoked_at: null }],
  });
  await mockSystemPane(page, state);
  await goToApp(page);
  await openSystemPane(page);

  const row = page.locator('.settings-pane[data-pane="system"] .audit-log-table tbody tr', { hasText: 'Old Integration' });
  await assertEventually(async () => (await row.count()) === 1, 'cenário 21: a linha "Old Integration" carrega');
  await row.locator('button[title="Delete"]').click();

  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  const expected = 'Delete the API key "Old Integration"? Any integration still using it will stop working immediately, and this cannot be undone.';
  assert(msg === expected, `cenário 21: mensagem de confirmação exata (lida: "${msg}")`);

  const apiKeysGetBefore = state.calls.apiKeysGet;
  await page.locator('#confirmOkBtn', { hasText: 'Confirm' }).click();
  await assertEventually(() => state.calls.apiKeysDelete.includes(1), 'cenário 21: DELETE /api/api-keys/1 foi chamado');
  await assertEventually(() => state.calls.apiKeysGet === apiKeysGetBefore + 1, 'cenário 21: a lista recarrega após excluir');
  await assertEventually(async () => (await row.count()) === 0, 'cenário 21: "Old Integration" some da lista');
});

// ════════════════════════════════════════════════
// G — USER-DATA SYNC (mecanismo cross-browser)
// ════════════════════════════════════════════════

// ── Cenário 22: seed do servidor (GET /api/user-data) aplica o tema ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: false });
  const state = makeSystemState({ userData: { 'cpa-theme': 'dark' } });
  await mockSystemPane(page, state);
  // localStorage limpo nesta "sessão" do Playwright (newContext() já garante
  // isso) — sem 'cpa-theme' prévio.
  await goToApp(page);

  await assertEventually(() => state.calls.userDataGet >= 1, 'cenário 22: GET /api/user-data foi chamado no boot');
  await assertEventually(
    async () => (await page.evaluate(() => localStorage.getItem('cpa-theme'))) === 'dark',
    'cenário 22: o localStorage local é semeado com o valor do servidor ("cpa-theme":"dark")'
  );
  await assertEventually(
    async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark',
    'cenário 22: document.documentElement[data-theme] vira "dark" — o seed do servidor realmente aplicou o tema, não só gravou no localStorage silenciosamente',
    4000
  );
});

// ── Cenário 23: uma mudança feita pelo próprio usuário dispara PUT /api/user-data (debounce 400ms) ──
await withPage(browser, async page => {
  await mockBase(page, { isAdmin: false });
  const state = makeSystemState({ userData: {} });
  await mockSystemPane(page, state);
  await goToApp(page);

  // User preferences vive no escopo "user" do modal — abre pelo menu da conta.
  await page.click('.hdr-user');
  await page.locator('#hdrUserPanel .sb-row', { hasText: 'User preferences' }).click();
  await page.waitForSelector('.settings-pane[data-pane="prefs"]');

  const putsBefore = state.calls.userDataPut.length;
  // `.sb-toggle` também é a classe usada pelos 4 toggles simples (Details/
  // Export/Images/System commands) mais abaixo na pane — o de tema é o
  // único com o texto "Dark mode".
  await page.locator('.settings-pane[data-pane="prefs"] .sb-toggle', { hasText: 'Dark mode' }).click();

  await new Promise(r => setTimeout(r, 600)); // espera o debounce de 400ms disparar com folga
  await assertEventually(
    () => state.calls.userDataPut.length > putsBefore && state.calls.userDataPut.some(body => 'cpa-theme' in body),
    'cenário 23: PUT /api/user-data foi chamado com um corpo contendo "cpa-theme" após o toggle de tema pessoal'
  );
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
