// Suite de validação manual (Playwright) da Fase 3, fatia 4 (Editor de
// comando: criar/editar/duplicar) — mesmo padrão de mocking de /api/* usado
// em test/commands.spec.mjs e test/querybar.spec.mjs.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/fase3-fatia4-shots';
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
        username: 'admin', upn: 'admin', handle: 'admin', role: 'super_admin',
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

const browser = await chromium.launch();

// ── Cenário 1: abrir "Add command" e ver o passo 1 ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await openAddCommand(page);
  assert(await page.isVisible('#cmdEditorTitle:has-text("New command")'), 'cenário 1: título "New command" visível');
  assert(await page.isVisible('.wiz-panel[data-step="1"] input#cmdName'), 'cenário 1: campo Name do passo 1 visível');
  assert(!(await page.isVisible('.wiz-panel[data-step="2"] .set-hint')), 'cenário 1: passo 2 não está visível ainda');
  assert(await page.isVisible('.wiz-step[data-step="1"].on'), 'cenário 1: indicador do passo 1 marcado como ativo');
  await page.screenshot({ path: `${SHOTS}/1-add-command-step1.png` });
});

// ── Cenário 2: validação bloqueia Next sem Name ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await openAddCommand(page);
  await page.locator('#cmdWizNextBtn').click();
  assert(await page.isVisible('.cmd-editor-error.show'), 'cenário 2: banner de erro aparece ao clicar Next sem Name');
  const errText = await page.locator('.cmd-editor-error').innerText();
  assert(errText.includes('Fill in the command Name'), 'cenário 2: mensagem de erro menciona o campo Name');
  assert(await page.isVisible('.wiz-panel[data-step="1"] input#cmdName'), 'cenário 2: continua no passo 1 (não avançou)');
});

// ── Cenário 3: navegar os 3 passos ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await openAddCommand(page);
  await page.fill('#cmdName', 'My new command');
  await page.locator('#cmdWizNextBtn').click();
  assert(await page.isVisible('.wiz-step[data-step="2"].on'), 'cenário 3: passo 2 (Scope) ativo depois do primeiro Next');
  await fillStep2(page);
  await page.locator('#cmdWizNextBtn').click();
  assert(await page.isVisible('.wiz-step[data-step="3"].on'), 'cenário 3: passo 3 (Command lines) ativo depois do segundo Next');
  assert(await page.isVisible('.list-editor#cmdLinesDefaultList'), 'cenário 3: editor de linhas visível no passo 3');
  // Back volta pro passo 2 sem perder o que já foi preenchido.
  await page.locator('#cmdWizBackBtn').click();
  assert(await page.isVisible('.wiz-step[data-step="2"].on'), 'cenário 3: Back volta para o passo 2');
});

// ── Cenário 4: cascata Vendor→System filtrando Versions/Environments ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await openAddCommand(page);
  await page.fill('#cmdName', 'Cascade test');
  await page.locator('#cmdWizNextBtn').click();
  const groups = page.locator('.wiz-panel[data-step="2"] .set-group');
  const systemsGroup = groups.nth(1);
  const versionsGroup = groups.nth(2);
  const environmentsGroup = groups.nth(3);

  // Sem vendor selecionado, System mostra as opções de AMBOS os vendors.
  // (Systems é single-select — SegSingle — sem rodapé "Close": clicar numa
  // opção já fecha o painel sozinho, diferente de Versions/Environments.)
  await systemsGroup.locator('.dd-btn').click();
  assert(await systemsGroup.locator('.dd-panel .seg-btn', { hasText: 'Gaia' }).isVisible(), 'cenário 4: "Gaia" visível em System antes de escolher Vendor');
  assert(await systemsGroup.locator('.dd-panel .seg-btn', { hasText: 'FortiOS' }).isVisible(), 'cenário 4: "FortiOS" visível em System antes de escolher Vendor');
  await systemsGroup.locator('.dd-btn').click(); // fecha sem escolher

  await pickSegSingle(groups.nth(0), 'Fortinet');
  await systemsGroup.locator('.dd-btn').click();
  assert(!(await systemsGroup.locator('.dd-panel .seg-btn', { hasText: 'Gaia' }).isVisible()), 'cenário 4: "Gaia" some de System depois de escolher Vendor=Fortinet');
  await systemsGroup.locator('.dd-panel .seg-btn', { hasText: 'FortiOS' }).click();

  await versionsGroup.locator('.dd-btn').click();
  assert(!(await versionsGroup.locator('.dd-panel .seg-btn', { hasText: 'R81.10' }).isVisible()), 'cenário 4: "R81.10" (Gaia) não aparece em Versions depois de System=FortiOS');
  assert(await versionsGroup.locator('.dd-panel .seg-btn', { hasText: '7.4' }).isVisible(), 'cenário 4: "7.4" (FortiOS) aparece em Versions');
  await versionsGroup.locator('.dd-panel .seg-btn', { hasText: '7.4' }).click();
  await versionsGroup.locator('.dd-panel .dd-panel-foot .btn', { hasText: 'Close' }).click();

  await environmentsGroup.locator('.dd-btn').click();
  assert(!(await environmentsGroup.locator('.dd-panel .seg-btn', { hasText: 'Standalone' }).isVisible()), 'cenário 4: "Standalone" (Gaia) não aparece em Environments depois de System=FortiOS');
  assert(await environmentsGroup.locator('.dd-panel .seg-btn', { hasText: 'HA Cluster' }).isVisible(), 'cenário 4: "HA Cluster" (FortiOS) aparece em Environments');
  await page.screenshot({ path: `${SHOTS}/4-cascade.png` });
});

// ── Cenário 5: adicionar/remover linha ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await openAddCommand(page);
  await page.fill('#cmdName', 'Line test');
  await page.locator('#cmdWizNextBtn').click();
  await fillStep2(page);
  await page.locator('#cmdWizNextBtn').click();
  const rows = page.locator('.list-editor#cmdLinesDefaultList .line-row');
  assert((await rows.count()) === 1, 'cenário 5: uma linha padrão já presente ao entrar no passo 3 (modo create)');
  await page.locator('.wiz-panel[data-step="3"] >> text=+ Add line').click();
  assert((await rows.count()) === 2, 'cenário 5: "+ Add line" acrescenta uma segunda linha');
  await rows.nth(1).locator('.row-remove-btn').click();
  assert((await rows.count()) === 1, 'cenário 5: "✕ Remove" tira a linha de volta a 1');
});

// ── Cenário 6: inserir variável no textarea ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await openAddCommand(page);
  await page.fill('#cmdName', 'Var test');
  await page.locator('#cmdWizNextBtn').click();
  await fillStep2(page);
  await page.locator('#cmdWizNextBtn').click();
  const row = page.locator('.list-editor#cmdLinesDefaultList .line-row').first();
  const textarea = row.locator('textarea.set-input');
  await textarea.click();
  await textarea.fill('ping ');
  await row.locator('.ln-var-dd .dd-btn').click();
  await row.locator('.ln-var-dd .dd-panel .seg-btn', { hasText: 'Source IP' }).click();
  await assertEventually(async () => (await textarea.inputValue()) === 'ping {{src_ip}}', 'cenário 6: "{{src_ip}}" inserido no textarea na posição do cursor');
});

// ── Cenário 7: salvar um comando novo (mock POST 201) fecha o modal ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await openAddCommand(page);
  await page.fill('#cmdName', 'Brand new command');
  await page.locator('#cmdWizNextBtn').click();
  await fillStep2(page);
  await page.locator('#cmdWizNextBtn').click();
  await page.locator('#cmdWizSaveBtn').click();
  await assertEventually(async () => !(await page.isVisible('#cmdEditorOverlay.show')), 'cenário 7: modal fecha depois de salvar com sucesso');
});

// ── Cenário 8: abrir "Edit" num comando existente — campos pré-preenchidos ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.card[data-cmd-id="1"] .edit-btn[title="Edit command"]').click();
  await page.waitForSelector('#cmdEditorOverlay.show');
  assert(await page.isVisible('#cmdEditorTitle:has-text("Edit command")'), 'cenário 8: título "Edit command"');
  assert((await page.inputValue('#cmdName')) === 'Cluster status', 'cenário 8: campo Name pré-preenchido com "Cluster status"');
  assert((await page.inputValue('#cmdDesc')) === 'Show HA state', 'cenário 8: campo Description pré-preenchido');
  // Em modo edit todos os passos já vêm desbloqueados.
  await page.locator('.wiz-step[data-step="3"]').click();
  const contentTextarea = page.locator('.list-editor#cmdLinesDefaultList .line-row').first().locator('textarea.set-input');
  assert((await contentTextarea.inputValue()) === 'cphaprob stat', 'cenário 8: conteúdo da linha existente pré-preenchido');
  await page.screenshot({ path: `${SHOTS}/8-edit-prefilled.png` });
});

// ── Cenário 9: "Duplicate" não tem Delete, e não herda o resolver ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="2"]');
  await page.locator('.card[data-cmd-id="2"] .edit-btn[title="Duplicate command"]').click();
  await page.waitForSelector('#cmdEditorOverlay.show');
  assert(await page.isVisible('#cmdEditorTitle:has-text("Duplicate command")'), 'cenário 9: título "Duplicate command"');
  assert(!(await page.isVisible('.resolver-warning.show')), 'cenário 9: banner de resolver NÃO aparece ao duplicar (resolver não herdado)');
  await page.locator('.wiz-step[data-step="3"]').click();
  assert(!(await page.isVisible('#cmdEditorDeleteBtn')), 'cenário 9: botão "Delete command" não existe em modo duplicate');
});

// ── Cenário 10: excluir um comando (mock DELETE) via modal de confirmação ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.card[data-cmd-id="1"] .edit-btn[title="Edit command"]').click();
  await page.waitForSelector('#cmdEditorOverlay.show');
  await page.locator('.wiz-step[data-step="3"]').click();
  await page.locator('#cmdEditorDeleteBtn').click();
  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  assert(msg.includes('Delete command "Cluster status" (1)?'), 'cenário 10: mensagem de confirmação menciona nome e id do comando');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(async () => !(await page.isVisible('#cmdEditorOverlay.show')), 'cenário 10: modal do editor fecha depois de confirmar a exclusão');
});

// ── Cenário 11: fechar com alterações não salvas mostra o modal de confirmação ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await openAddCommand(page);
  await page.fill('#cmdName', 'Dirty form');
  await page.locator('#cmdEditorOverlay .modal-close').click();
  await page.waitForSelector('#confirmOverlay.show');
  assert((await page.locator('#confirmMessage').innerText()).includes('unsaved changes'), 'cenário 11: confirmação de "unsaved changes" aparece ao fechar com o form sujo');
  // Cancel mantém o editor aberto.
  await page.locator('.modal-foot .btn', { hasText: 'Cancel' }).first().click();
  assert(await page.isVisible('#cmdEditorOverlay.show'), 'cenário 11: editor continua aberto depois de "Cancel" na confirmação');
  // Confirmar desta vez fecha de fato.
  await page.locator('#cmdEditorOverlay .modal-close').click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(async () => !(await page.isVisible('#cmdEditorOverlay.show')), 'cenário 11: confirmar "Close without saving" fecha o editor');
});

// ── Cenário 12: comando com placeholder_resolver mostra o banner de aviso ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="2"]');
  await page.locator('.card[data-cmd-id="2"] .edit-btn[title="Edit command"]').click();
  await page.waitForSelector('#cmdEditorOverlay.show');
  assert(await page.isVisible('.resolver-warning.show'), 'cenário 12: banner de resolver avançado visível ao editar um comando com placeholder_resolver');
  const warningText = await page.locator('.resolver-warning').innerText();
  assert(warningText.includes('advanced code-driven logic'), 'cenário 12: texto do banner menciona "advanced code-driven logic"');
  await page.screenshot({ path: `${SHOTS}/12-resolver-warning.png` });
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
