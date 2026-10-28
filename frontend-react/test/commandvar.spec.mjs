// Criação de variável (parâmetro) direto do editor de comandos — botão "+ New variable…" no seletor "Insert variable".
// comando: criar/editar/duplicar) — mesmo padrão de mocking de /api/* usado
// em test/commands.spec.mjs e test/querybar.spec.mjs.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/cmdvar-shots';
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
// FIXTURES — dois vendors/sistemas distintos (pra exercitar a cascata
// Vendor→System→Version/Environment) + um comando com placeholder_resolver
// (banner de aviso) + um comando comum (edit/duplicate/delete).
// ════════════════════════════════════════════════
const CATALOGS = {
  vendors: [
    { key: 'check-point', label: 'Check Point', color: '#DA1572', sort_order: 0 },
    { key: 'fortinet', label: 'Fortinet', color: '#E4002B', sort_order: 1 },
  ],
  systems: [
    { key: 'gaia', vendor: 'check-point', label: 'Gaia', color: '#2DD4BF', sort_order: 0 },
    { key: 'fortios', vendor: 'fortinet', label: 'FortiOS', color: '#F97316', sort_order: 1 },
  ],
  versions: [
    { key: 'R81.10', system: 'gaia', vendor: 'check-point', label: 'R81.10', color: '#FF4FA0', sort_order: 0 },
    { key: 'R82', system: 'gaia', vendor: 'check-point', label: 'R82', color: '#FBBF24', sort_order: 1 },
    { key: '7.4', system: 'fortios', vendor: 'fortinet', label: '7.4', color: '#60A5FA', sort_order: 2 },
  ],
  environments: [
    { key: 'standalone', system: 'gaia', vendor: 'check-point', label: 'Standalone', color: '#FB923C', sort_order: 0 },
    { key: 'cluster', system: 'gaia', vendor: 'check-point', label: 'Cluster HA', color: '#F87171', sort_order: 1 },
    { key: 'ha-cluster', system: 'fortios', vendor: 'fortinet', label: 'HA Cluster', color: '#A78BFA', sort_order: 2 },
  ],
  topics: [
    { key: 'capture', label: 'Capture', color: '#60A5FA', sort_order: 0, is_protected: 0 },
    { key: 'status', label: 'Status', color: '#34D399', sort_order: 1, is_protected: 0 },
  ],
  parameters: [
    { key: 'src_ip', label: 'Source IP', sort_order: 0 },
    { key: 'dst_ip', label: 'Destination IP', sort_order: 1 },
  ],
  prompts: [
    { key: 'expert', label: '[Expert@FW]#', color: '#8B949E', sort_order: 0 },
  ],
  exports: [
    { key: 'export1', label: 'Export template 1', color: '#8B949E', sort_order: 0 },
  ],
};

function line(overrides) {
  return { line_type: 'cmd', prompt: null, content: '', export_template: null, image_data: null, ...overrides };
}

const COMMANDS = [
  {
    id: 1, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 0,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'Cluster status', name_empty: null, desc: 'Show HA state', desc_empty: null, details: '<p>Some details</p>',
    vendors: ['check-point'], systems: ['gaia'], versions: ['R81.10'], environments: ['standalone'],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'cphaprob stat' })], empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    created_by: 'admin', modified_by: 'admin', is_system: false,
  },
  {
    id: 2, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 1,
    requires_ip_port: false, placeholder_resolver: 'net-utils-ip-list',
    name: 'Resolver command', name_empty: null, desc: 'Uses code-driven expansion', desc_empty: null, details: null,
    vendors: ['check-point'], systems: ['gaia'], versions: ['R81.10'], environments: ['standalone'],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'fw monitor -e "..."' })], empty: [] },
    created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    created_by: 'admin', modified_by: 'admin', is_system: false,
  },
];

async function mockLoggedInAdmin(page) {
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
  });
  await page.route('**/api/me', route =>
    route.fulfill({
      json: {
        username: 'admin', upn: 'admin', role: 'super_admin',
        isAdmin: true, isSuperAdmin: true, authMethod: 'local',
      },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: CATALOGS }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
  await page.route('**/api/commands', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: COMMANDS });
    if (method === 'POST') return route.fulfill({ status: 201, json: { ...COMMANDS[0], id: 999 } });
    return route.continue();
  });
  await page.route('**/api/commands/*', route => {
    const method = route.request().method();
    if (method === 'PUT') return route.fulfill({ json: { ...COMMANDS[0] } });
    if (method === 'DELETE') return route.fulfill({ status: 204 });
    return route.continue();
  });
}

// ── Helpers de navegação do wizard ──
async function openAddCommand(page) {
  await page.locator('.ctb-cmd-btn').click();
  await page.locator('#addDDPanel .sb-row', { hasText: 'Command' }).click();
  await page.waitForSelector('#cmdEditorOverlay.show');
}
async function pickSegSingle(group, optionText) {
  await group.locator('.dd-btn').click();
  await group.locator('.dd-panel .seg-btn', { hasText: optionText }).click();
}
async function pickSegMulti(group, optionText) {
  await group.locator('.dd-btn').click();
  await group.locator('.dd-panel .seg-btn', { hasText: optionText }).click();
  await group.locator('.dd-panel .dd-panel-foot .btn', { hasText: 'Close' }).click();
}
// Passo 2 completo com Check Point/Gaia/R81.10/Standalone (Topic já vem
// com 'capture' pré-marcado por padrão em modo create — ver
// CMD_EDITOR_MODE 'create'/_ceResetForm no original).
async function fillStep2(page) {
  const groups = page.locator('.wiz-panel[data-step="2"] .set-group');
  await pickSegSingle(groups.nth(0), 'Check Point'); // Vendor
  await pickSegSingle(groups.nth(1), 'Gaia'); // Systems (single-select)
  await pickSegMulti(groups.nth(2), 'R81.10'); // Versions
  await pickSegMulti(groups.nth(3), 'Standalone'); // Environments
}

// Estado mutável do catálogo, para o refetch depois do POST devolver a nova variável.
async function mockParams(page, { admin = true, params = CATALOGS.parameters.slice(), postStatus = 201 } = {}) {
  const state = { params: params.slice(), posts: [], catalogGets: 0 };
  await page.route('**/api/me', route =>
    route.fulfill({
      json: { username: 'admin', upn: 'admin', role: admin ? 'super_admin' : 'user', isAdmin: admin, isSuperAdmin: admin, authMethod: 'local' },
    })
  );
  await page.route('**/api/catalogs', route => {
    state.catalogGets++;
    return route.fulfill({ json: { ...CATALOGS, parameters: state.params } });
  });
  await page.route('**/api/parameters', route => {
    const body = route.request().postDataJSON();
    state.posts.push(body);
    if (postStatus !== 201) return route.fulfill({ status: postStatus, json: { error: 'conflict', message: 'dup' } });
    const row = { key: body.key, label: body.label, sort_order: state.params.length };
    state.params.push(row);
    return route.fulfill({ status: 201, json: row });
  });
  return state;
}

async function gotoStep3(page) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await openAddCommand(page);
  await page.fill('#cmdName', 'Var create test');
  await page.locator('#cmdWizNextBtn').click();
  await fillStep2(page);
  await page.locator('#cmdWizNextBtn').click();
  const row = page.locator('.list-editor#cmdLinesDefaultList .line-row').first();
  await row.locator('.ln-var-dd .dd-btn').click();
  return row;
}

const browser = await chromium.launch();

// ── Cenário 1 (admin): cria "Hop Count" pelo editor, insere o token e a variável passa a existir no seletor ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  const st = await mockParams(page);
  const row = await gotoStep3(page);
  const panel = row.locator('.ln-var-dd .dd-panel');
  assert(await panel.locator('.seg-btn', { hasText: 'Source IP' }).isVisible(), 'cenário 1: variáveis existentes continuam listadas');
  assert(await panel.locator('.var-new-btn').isVisible(), 'cenário 1: opção "New variable…" visível para admin');
  const textarea = row.locator('textarea.set-input');
  await textarea.fill('ping -c ');
  await panel.locator('.var-new-btn').click();
  await panel.locator('.var-new-form input').first().fill('Hop Count');
  const keyVal = await panel.locator('.var-new-form input').nth(1).inputValue();
  assert(keyVal === 'hop_count', `cenário 1: chave sugerida a partir da descrição ("${keyVal}")`);
  await page.screenshot({ path: `${SHOTS}/v1-form.png` });
  await panel.locator('.var-new-actions .btn-primary').click();
  await assertEventually(async () => (await textarea.inputValue()) === 'ping -c {{hop_count}}', 'cenário 1: token {{hop_count}} inserido no textarea');
  assert(st.posts.length === 1 && st.posts[0].key === 'hop_count' && st.posts[0].label === 'Hop Count', 'cenário 1: POST /api/parameters com {key,label}');
  assert(st.catalogGets >= 2, 'cenário 1: catálogo recarregado depois de criar');
  await row.locator('.ln-var-dd .dd-btn').click();
  await assertEventually(async () => await row.locator('.ln-var-dd .dd-panel .seg-btn', { hasText: 'Hop Count' }).isVisible(), 'cenário 1: nova variável já aparece no seletor');
});

// ── Cenário 2: chave editada manualmente não é sobrescrita pela descrição; Enter envia ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  const st = await mockParams(page);
  const row = await gotoStep3(page);
  const panel = row.locator('.ln-var-dd .dd-panel');
  await panel.locator('.var-new-btn').click();
  const inputs = panel.locator('.var-new-form input');
  await inputs.nth(1).fill('my.key-1');
  await inputs.nth(0).fill('Qualquer Coisa');
  assert((await inputs.nth(1).inputValue()) === 'my.key-1', 'cenário 2: chave digitada não é sobrescrita');
  await inputs.nth(0).press('Enter');
  await assertEventually(async () => st.posts.length === 1 && st.posts[0].key === 'my.key-1', 'cenário 2: Enter envia o formulário');
  assert(await page.isVisible('#cmdEditorOverlay.show'), 'cenário 2: editor continua aberto (Enter não avançou o wizard)');
});

// ── Cenário 3: validações locais (chave repetida / inválida / sem descrição) não chamam a API ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  const st = await mockParams(page);
  const row = await gotoStep3(page);
  const panel = row.locator('.ln-var-dd .dd-panel');
  await panel.locator('.var-new-btn').click();
  const inputs = panel.locator('.var-new-form input');
  await inputs.nth(0).fill('Dup');
  await inputs.nth(1).fill('src_ip');
  await panel.locator('.var-new-actions .btn-primary').click();
  assert((await panel.locator('.var-new-err').innerText()).includes('already exists'), 'cenário 3: chave repetida bloqueada localmente');
  await inputs.nth(1).fill('chave com espaço');
  await panel.locator('.var-new-actions .btn-primary').click();
  assert((await panel.locator('.var-new-err').innerText()).includes('Key:'), 'cenário 3: chave inválida bloqueada');
  await inputs.nth(0).fill('');
  await inputs.nth(1).fill('ok_key');
  await panel.locator('.var-new-actions .btn-primary').click();
  assert((await panel.locator('.var-new-err').innerText()).includes('description'), 'cenário 3: descrição vazia bloqueada');
  assert(st.posts.length === 0, 'cenário 3: nenhum POST enviado');
  await panel.locator('.var-new-actions .btn-ghost').click();
  assert(await panel.locator('.var-new-btn').isVisible(), 'cenário 3: Cancel volta para a lista');
});

// ── Cenário 4: erro do servidor (409) aparece no formulário e não insere token ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await mockParams(page, { postStatus: 409 });
  const row = await gotoStep3(page);
  const panel = row.locator('.ln-var-dd .dd-panel');
  await panel.locator('.var-new-btn').click();
  const inputs = panel.locator('.var-new-form input');
  await inputs.nth(0).fill('Race');
  await panel.locator('.var-new-actions .btn-primary').click();
  await assertEventually(async () => (await panel.locator('.var-new-err').innerText()).includes('already exists'), 'cenário 4: mensagem de conflito do servidor exibida');
  assert((await row.locator('textarea.set-input').inputValue()) === '', 'cenário 4: nada inserido no textarea');
});

// ── Cenário 5 (não-admin): sem botão de criar; lista vazia mostra aviso ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await mockParams(page, { admin: false, params: [] });
  const row = await gotoStep3(page);
  const panel = row.locator('.ln-var-dd .dd-panel');
  assert(!(await panel.locator('.var-new-btn').count()), 'cenário 5: não-admin não vê "New variable…"');
  assert((await panel.locator('.var-empty').innerText()).includes('administrator'), 'cenário 5: aviso orienta pedir a um administrador');
});

// ── Cenário 6 (admin, instalação vazia): lista vazia ainda permite criar ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await mockParams(page, { params: [] });
  const row = await gotoStep3(page);
  const panel = row.locator('.ln-var-dd .dd-panel');
  assert(await panel.locator('.var-empty').isVisible() && await panel.locator('.var-new-btn').isVisible(), 'cenário 6: sem variáveis, admin ainda vê "New variable…"');
});

// ── Cenário 7 (admin, muitas variáveis): "New variable…" fica visível sem precisar rolar o painel ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  const many = Array.from({ length: 30 }, (_, i) => ({ key: `var_${i}`, label: `Variable ${i}`, sort_order: i }));
  await mockParams(page, { params: many });
  const row = await gotoStep3(page);
  const panel = row.locator('.ln-var-dd .dd-panel');
  const inside = async () => {
    const p = await panel.boundingBox();
    const b = await panel.locator('.var-new-btn').boundingBox();
    return !!p && !!b && b.x >= p.x - 1 && b.x + b.width <= p.x + p.width + 1 && b.y >= p.y - 1 && b.y + b.height <= p.y + p.height + 1;
  };
  await page.screenshot({ path: `${SHOTS}/v7-many-vars.png` });
  assert(await inside(), 'cenário 7: com 30 variáveis, "New variable…" aparece dentro da área visível do painel (sem rolar)');
  await panel.evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert(await inside(), 'cenário 7: continua visível com o painel rolado até o fim');
  await panel.evaluate(el => { el.scrollTop = 0; });
  assert(await inside(), 'cenário 7: continua visível com o painel rolado para o topo');
  await panel.locator('.var-new-btn').click();
  assert(await panel.locator('.var-new-form').isVisible(), 'cenário 7: clicar abre o formulário de cadastro');
});

await browser.close();
console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
