// Cadastro rápido de Vendor/System/Version/Environment/Topic/Prompt/Export direto nos seletores do editor de comandos.
// comando: criar/editar/duplicar) — mesmo padrão de mocking de /api/* usado
// em test/commands.spec.mjs e test/querybar.spec.mjs.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/cmdqc-shots';
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

const KINDS = { vendors: 'vendors', systems: 'systems', versions: 'versions', environments: 'environments', topics: 'topics', prompts: 'prompts', exports: 'exports' };

// Catálogo mutável: cada POST /api/<kind> acrescenta a linha e o próximo GET /api/catalogs a devolve.
async function mockCatalogWrites(page, { role = 'admin', failWith = null, topics = null } = {}) {
  const cat = JSON.parse(JSON.stringify(CATALOGS));
  if (topics) cat.topics = topics;
  const st = { posts: [], gets: 0, cat };
  const isAdmin = role === 'admin' || role === 'super_admin';
  await page.route('**/api/me', route =>
    route.fulfill({ json: { username: 'u@example.com', upn: 'u@example.com', role, isAdmin, isSuperAdmin: role === 'super_admin', authMethod: 'local' } })
  );
  await page.route('**/api/catalogs', route => {
    st.gets++;
    return route.fulfill({ json: cat });
  });
  for (const kind of Object.values(KINDS)) {
    await page.route(`**/api/${kind}`, route => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      st.posts.push({ kind, body });
      if (failWith) return route.fulfill({ status: 400, json: { error: 'validation_error', message: failWith } });
      const key = body.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const row = { key, ...body, sort_order: cat[kind].length };
      if (kind === 'versions' || kind === 'environments') row.vendor = cat.systems.find(s => s.key === body.system)?.vendor;
      if (kind === 'topics') row.is_protected = 0;
      cat[kind].push(row);
      return route.fulfill({ status: 201, json: row });
    });
  }
  return st;
}

async function gotoStep2(page) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.ctb-cmd-btn');
  await openAddCommand(page);
  await page.fill('#cmdName', 'QC test');
  await page.locator('#cmdWizNextBtn').click();
  return page.locator('.wiz-panel[data-step="2"] .set-group');
}
async function quickCreate(group, noun, name) {
  await group.locator('.dd-btn').click();
  await group.locator('.dd-panel .qc-new-btn', { hasText: `New ${noun}` }).click();
  await group.locator('.qc-form input.set-input').fill(name);
  await group.locator('.qc-actions .btn-primary').click();
  // Multi-seleção mantém o painel aberto (dá para cadastrar vários em sequência): fecha.
  await group.locator('.qc-form').waitFor({ state: 'detached' });
  const close = group.locator('.dd-panel-foot .btn', { hasText: 'Close' });
  if (await close.count()) await close.click();
}

const browser = await chromium.launch();

// ── Cenário 1: cascata completa criando tudo do zero (vendor → system → versão/ambiente/tópico) ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  const st = await mockCatalogWrites(page);
  const g = await gotoStep2(page);
  await quickCreate(g.nth(0), 'vendor', 'Palo Alto');
  await assertEventually(async () => (await g.nth(0).locator('.dd-label').innerText()) === 'Palo Alto', 'cenário 1: vendor criado já fica selecionado');
  await quickCreate(g.nth(1), 'system', 'PAN-OS');
  await assertEventually(async () => (await g.nth(1).locator('.dd-label').innerText()) === 'PAN-OS', 'cenário 1: system criado (do vendor novo) fica selecionado');
  await quickCreate(g.nth(2), 'version', '11.1');
  await assertEventually(async () => (await g.nth(2).locator('.dd-label').innerText()) === '11.1', 'cenário 1: version criada fica selecionada');
  await quickCreate(g.nth(3), 'environment', 'Panorama');
  await assertEventually(async () => (await g.nth(3).locator('.dd-label').innerText()) === 'Panorama', 'cenário 1: environment criado fica selecionado');
  // Topic já vem com "capture"; criar um novo soma à seleção.
  await g.nth(4).locator('.dd-btn').click();
  await g.nth(4).locator('.dd-panel .qc-new-btn').click();
  await g.nth(4).locator('.qc-form input.set-input').fill('Routing');
  await g.nth(4).locator('.qc-actions .btn-primary').click();
  await g.nth(4).locator('.qc-form').waitFor({ state: 'detached' });
  await g.nth(4).locator('.dd-panel-foot .btn', { hasText: 'Close' }).click();
  await assertEventually(async () => (await g.nth(4).locator('.dd-label').innerText()) === '2 topics', 'cenário 1: topic criado é somado à seleção (2 topics)');
  const kinds = st.posts.map(p => p.kind).join(',');
  assert(kinds === 'vendors,systems,versions,environments,topics', `cenário 1: POSTs na ordem certa (${kinds})`);
  assert(st.posts[1].body.vendor === 'palo-alto' && st.posts[2].body.system === 'pan-os' && st.posts[3].body.system === 'pan-os', 'cenário 1: pai (vendor/system) enviado nos POSTs de system/version/environment');
  assert(/^#[0-9a-fA-F]{6}$/.test(st.posts[0].body.color), 'cenário 1: cor enviada no vendor');
  await page.screenshot({ path: `${SHOTS}/qc1-step2.png` });
});

// ── Cenário 2: sem pai escolhido, system/version/environment mostram aviso em vez do botão ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await mockCatalogWrites(page);
  const g = await gotoStep2(page);
  await g.nth(1).locator('.dd-btn').click();
  assert((await g.nth(1).locator('.qc-blocked').innerText()).includes('Choose a vendor first'), 'cenário 2: System sem vendor mostra "Choose a vendor first"');
  assert(!(await g.nth(1).locator('.qc-new-btn').count()), 'cenário 2: botão de criar system não aparece sem vendor');
  await g.nth(1).locator('.dd-btn').click(); // fecha o painel de System, que cobre o seguinte
  await g.nth(2).locator('.dd-btn').click();
  assert((await g.nth(2).locator('.qc-blocked').innerText()).includes('Choose a system first'), 'cenário 2: Version sem system mostra "Choose a system first"');
});

// ── Cenário 3: nome vazio é barrado; erro do servidor aparece no formulário; Cancel volta à lista ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  const st = await mockCatalogWrites(page, { failWith: 'boom do servidor' });
  const g = await gotoStep2(page);
  await g.nth(0).locator('.dd-btn').click();
  await g.nth(0).locator('.qc-new-btn').click();
  await g.nth(0).locator('.qc-actions .btn-primary').click();
  assert((await g.nth(0).locator('.qc-err').innerText()).includes('Fill in the name'), 'cenário 3: nome vazio barrado localmente');
  assert(st.posts.length === 0, 'cenário 3: nenhum POST com nome vazio');
  await g.nth(0).locator('.qc-form input.set-input').fill('Algum');
  await g.nth(0).locator('.qc-form input.set-input').press('Enter');
  await assertEventually(async () => (await g.nth(0).locator('.qc-err').innerText()).includes('boom do servidor'), 'cenário 3: mensagem do servidor exibida (Enter envia)');
  await g.nth(0).locator('.qc-actions .btn-ghost').click();
  assert(await g.nth(0).locator('.qc-new-btn').isVisible(), 'cenário 3: Cancel volta para a lista');
  assert(await page.isVisible('#cmdEditorOverlay.show'), 'cenário 3: editor segue aberto');
});

// ── Cenário 4: Prompt e Export (passo 3) criados na linha ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  const st = await mockCatalogWrites(page);
  const g = await gotoStep2(page);
  await pickSegSingle(g.nth(0), 'Check Point');
  await pickSegSingle(g.nth(1), 'Gaia');
  await pickSegMulti(g.nth(2), 'R81.10');
  await pickSegMulti(g.nth(3), 'Standalone');
  await page.locator('#cmdWizNextBtn').click();
  const row = page.locator('.list-editor#cmdLinesDefaultList .line-row').first();
  const dds = row.locator('.row-head .dd');
  // 0=Type 1=Prompt 2=Insert variable 3=Export
  await dds.nth(1).locator('.dd-btn').click();
  await dds.nth(1).locator('.qc-new-btn', { hasText: 'New prompt' }).click();
  await dds.nth(1).locator('.qc-form input.set-input').fill('root@host:~#');
  await dds.nth(1).locator('.qc-actions .btn-primary').click();
  await assertEventually(async () => (await dds.nth(1).locator('.dd-label').innerText()) === 'root@host:~#', 'cenário 4: prompt criado fica selecionado na linha');
  await dds.nth(3).locator('.dd-btn').click();
  await dds.nth(3).locator('.qc-new-btn', { hasText: 'New export template' }).click();
  await dds.nth(3).locator('.qc-form input.set-input').fill('> out.txt');
  await dds.nth(3).locator('.qc-actions .btn-primary').click();
  await assertEventually(async () => (await dds.nth(3).locator('.dd-label').innerText()) === '> out.txt', 'cenário 4: export criado fica selecionado na linha');
  assert(st.posts.map(p => p.kind).join(',') === 'prompts,exports', 'cenário 4: POST /api/prompts e /api/exports');
  assert(!('color' in st.posts[0].body), 'cenário 4: prompt/export não enviam cor');
});

// ── Cenário 5: super admin também vê; usuário comum não vê nenhum "New …" ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await mockCatalogWrites(page, { role: 'super_admin' });
  const g = await gotoStep2(page);
  await g.nth(0).locator('.dd-btn').click();
  assert(await g.nth(0).locator('.qc-new-btn').isVisible(), 'cenário 5: super admin vê "New vendor…"');
});
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await mockCatalogWrites(page, { role: 'user' });
  const g = await gotoStep2(page);
  for (let i = 0; i < 5; i++) {
    await g.nth(i).locator('.dd-btn').click();
    assert((await g.nth(i).locator('.qc-new-btn, .qc-blocked').count()) === 0, `cenário 5: usuário comum não vê cadastro rápido no seletor ${i + 1}`);
    await g.nth(i).locator('.dd-btn').click();
  }
});

// ── Cenário 6: catálogo sem o tópico 'capture' (instalação nova) — nada de seleção fantasma ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  const st = await mockCatalogWrites(page, { topics: [] });
  const g = await gotoStep2(page);
  assert((await g.nth(4).locator('.dd-label').innerText()) !== '1 topics', 'cenário 6: sem "capture" no catálogo, nenhum tópico fantasma pré-marcado');
  await g.nth(4).locator('.dd-btn').click();
  await g.nth(4).locator('.qc-new-btn').click();
  await g.nth(4).locator('.qc-form input.set-input').fill('HA');
  await g.nth(4).locator('.qc-actions .btn-primary').click();
  await g.nth(4).locator('.qc-form').waitFor({ state: 'detached' });
  await g.nth(4).locator('.dd-panel-foot .btn', { hasText: 'Close' }).click();
  await assertEventually(async () => (await g.nth(4).locator('.dd-label').innerText()) === 'HA', 'cenário 6: só o tópico criado aparece selecionado (não "2 topics")');
  assert(st.posts.length === 1 && st.posts[0].kind === 'topics', 'cenário 6: um único POST de tópico');
});

await browser.close();
console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
