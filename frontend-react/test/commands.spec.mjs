// Suite de validação manual (Playwright) da Fase 3, fatia 3a (Comandos
// núcleo) — mesmo padrão de mocking de /api/* usado em test/login.spec.mjs
// e test/appshell.spec.mjs.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/fase3-fatia3a-shots';
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

async function withPage(browser, fn, opts = {}) {
  const ctx = await browser.newContext();
  if (opts.clipboard) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  }
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}

// ════════════════════════════════════════════════
// FIXTURES
// ════════════════════════════════════════════════
const CATALOGS = {
  vendors: [
    { key: 'check-point', label: 'Check Point', color: '#DA1572', sort_order: 0 },
    { key: 'fortinet', label: 'Fortinet', color: '#E4002B', sort_order: 1 },
  ],
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
    { key: 'status', label: 'Status', color: '#60A5FA', sort_order: 0, is_protected: 0 },
    { key: 'vpn', label: 'VPN', color: '#22D3EE', sort_order: 1, is_protected: 0 },
    { key: 'environment', label: 'Environment', color: '#8B949E', sort_order: 2, is_protected: 1 },
  ],
  parameters: [
    { key: 'src_ip', label: 'Source IP', sort_order: 0 },
    { key: 'dst_ip', label: 'Destination IP', sort_order: 1 },
    { key: 'src_port', label: 'Source Port', sort_order: 2 },
    { key: 'dst_port', label: 'Destination Port', sort_order: 3 },
    { key: 'proto', label: 'Protocol', sort_order: 4 },
    { key: 'iface', label: 'Interface', sort_order: 5 },
    { key: 'vsid', label: 'VSID', sort_order: 6 },
    { key: 'ip', label: 'IP', sort_order: 7 },
    { key: 'port', label: 'Port', sort_order: 8 },
  ],
};

function line(overrides) {
  return { line_type: 'cmd', prompt: null, content: '', export_template: null, image_data: null, ...overrides };
}

const COMMANDS = [
  // id 1 — status, vendor/system set, plain literal command, created_by alice
  {
    id: 1, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 0,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'Cluster status', name_empty: null, desc: 'Show HA state', desc_empty: null, details: null,
    vendors: ['check-point'], systems: ['gaia'], versions: [], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'cphaprob stat' })], empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    created_by: 'alice', modified_by: 'alice', is_system: false,
  },
  // id 2 — vpn, no vendor/system (applies to all), created_by bob
  {
    id: 2, topic: 'vpn', topics: ['vpn'], folder_ids: [], icon: null, sort_order: 0,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'VPN tunnels list', name_empty: null, desc: 'List all VPN tunnels', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [line({ content: 'vpn tu tlist' })], empty: [] },
    created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    created_by: 'bob', modified_by: 'bob', is_system: false,
  },
  // id 3 — requires_ip_port, empty-state vs real card, created_by alice
  {
    id: 3, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 1,
    requires_ip_port: true, placeholder_resolver: null,
    name: 'Host state lookup', name_empty: 'Host state lookup (enter IP+Port)',
    desc: 'Check connection state for host', desc_empty: 'Fill IP and Port fields above to see this command',
    details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: {
      default: [line({ prompt: '[Expert@FW]#', content: 'fw ctl conn state | grep "{{ip}}:{{port}}"' })],
      empty: [{ line_type: 'info', prompt: null, content: 'Enter IP and Port above to generate this command', export_template: null, image_data: null }],
    },
    created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z',
    created_by: 'alice', modified_by: 'alice', is_system: false,
  },
  // id 4 — is_system reference command, created_by System
  {
    id: 4, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 2,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'CPU/Memory stats (reference)', name_empty: null, desc: 'System reference command', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'cpstat os -f cpu' })], empty: [] },
    created_at: '2026-01-04T00:00:00Z', updated_at: '2026-01-04T00:00:00Z',
    created_by: 'System', modified_by: 'System', is_system: true,
  },
  // id 5 — environment-specific card (standalone), created_by alice
  {
    id: 5, topic: 'environment', topics: ['environment'], folder_ids: [], icon: null, sort_order: 0,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'Standalone note', name_empty: null, desc: 'Applies only to standalone gateways', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: ['standalone'],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'show configuration' })], empty: [] },
    created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-05T00:00:00Z',
    created_by: 'alice', modified_by: 'alice', is_system: false,
  },
  // id 6 — {{src_ip}}/{{dst_ip}} tokens inside a quoted string, created_by bob
  {
    id: 6, topic: 'vpn', topics: ['vpn'], folder_ids: [], icon: null, sort_order: 1,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'Debug IKE handshake', name_empty: null, desc: 'fw monitor filter for src/dst', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: {
      default: [line({ prompt: '[Expert@FW]#', content: 'fw monitor -e "accept host({{src_ip}}) and host({{dst_ip}});"' })],
      empty: [],
    },
    created_at: '2026-01-06T00:00:00Z', updated_at: '2026-01-06T00:00:00Z',
    created_by: 'bob', modified_by: 'bob', is_system: false,
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
  await page.route('**/api/commands', route => route.fulfill({ json: COMMANDS }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
}

// Fatia 3b substituiu o stopgap SimpleQueryFields.tsx (grade de <input>
// rotulados) pela QueryBar real (campo único "campo:valor" -> tags no
// Enter, ver test/querybar.spec.mjs para a suíte dedicada). Os cenários
// abaixo só precisam preencher parâmetros pra ver o efeito no comando
// renderizado — helper mínimo: digita "key:value ..." no campo único e
// confirma com Enter (mesmo cria mais de uma tag de uma vez, como o
// original permite).
async function setQueryFields(page, pairs) {
  const text = Object.entries(pairs)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  const input = page.locator('.cpq-input');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

const browser = await chromium.launch();

// ── Cenário 1: comandos carregam e renderizam em seções por tópico ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.content#out');
  await assertEventually(async () => (await page.locator('.card').count()) > 0, 'cenário 1: cards carregaram após login');
  assert(await page.isVisible('.card[data-cmd-id="1"]'), 'cenário 1: card do comando 1 (Status) visível');
  assert(await page.isVisible('.card[data-cmd-id="2"]'), 'cenário 1: card do comando 2 (VPN) visível');
  assert(await page.isVisible('text=Status'), 'cenário 1: seção "Status" visível');
  assert(await page.isVisible('text=VPN'), 'cenário 1: seção "VPN" visível');
  // Auditoria visual pós-corte: seções de topo (tópicos) separadas pelo gap de
  // 16px de .content — sem wrappers entre #out e .section — e as barras
  // .inp-bar/.content-toolbar fora de #out com a largura toda da .main.
  const geo = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('#out > .section')].map(e => e.getBoundingClientRect());
    const main = document.querySelector('.main').getBoundingClientRect().width;
    return {
      n: secs.length,
      gaps: secs.slice(1).map((r, i) => Math.round(r.top - secs[i].bottom)),
      main: Math.round(main),
      inp: Math.round(document.querySelector('.inp-bar').getBoundingClientRect().width),
      tb: Math.round(document.querySelector('.content-toolbar').getBoundingClientRect().width),
    };
  });
  assert(geo.n >= 2, `cenário 1: seções de topo são filhas diretas de #out (${geo.n})`);
  assert(geo.gaps.length > 0 && geo.gaps.every(x => x === 16), `cenário 1: seções separadas por 16px (${geo.gaps.join(',')})`);
  assert(geo.inp === geo.main && geo.tb === geo.main, `cenário 1: .inp-bar (${geo.inp}) e .content-toolbar (${geo.tb}) com a largura da .main (${geo.main})`);
  await page.screenshot({ path: `${SHOTS}/1-cards-loaded.png` });
});

// ── Cenário 2: linha literal sem tokens crus / sem caracteres de controle soltos ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="2"]');
  const termText = await page.locator('.card[data-cmd-id="2"] .term').innerText();
  assert(termText.includes('vpn tu tlist'), 'cenário 2: comando literal renderizado corretamente');
  assert(!/\{\{\w+\}\}/.test(termText), 'cenário 2: nenhum {{token}} cru sobrou no texto');
  assert(!/[\x01\x02]/.test(termText), 'cenário 2: nenhum caractere de controle solto (sentinela) no texto');
  // Comando 6 (com tokens ainda vazios) deve cair no hint "<Label>", nunca no {{token}} cru.
  const termText6 = await page.locator('.card[data-cmd-id="6"] .term').innerText();
  assert(!/\{\{\w+\}\}/.test(termText6), 'cenário 2: comando 6 sem {{token}} cru quando campos vazios');
  assert(!/[\x01\x02]/.test(termText6), 'cenário 2: comando 6 sem sentinelas soltas quando campos vazios');
  assert(termText6.includes('Source IP') || termText6.includes('<Source IP>'), 'cenário 2: hint "<Source IP>" mostrado quando token vazio');
});

// ── Cenário 3: digitar IP nos campos simples atualiza o texto renderizado ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="6"]');
  await setQueryFields(page, { src_ip: '10.0.0.1', dst_ip: '10.0.0.2' });
  await assertEventually(
    async () => {
      const t = await page.locator('.card[data-cmd-id="6"] .term').innerText();
      return t.includes('10.0.0.1') && t.includes('10.0.0.2');
    },
    'cenário 3: valores digitados aparecem no comando renderizado (não o hint)'
  );
  const kvars = await page.locator('.card[data-cmd-id="6"] .k-var').allInnerTexts();
  assert(kvars.includes('10.0.0.1') && kvars.includes('10.0.0.2'), 'cenário 3: valores aparecem dentro de spans k-var (destacados como variável)');
  const termText6 = await page.locator('.card[data-cmd-id="6"] .term').innerText();
  assert(!termText6.includes('Source IP') && !termText6.includes('Destination IP'), 'cenário 3: hints não aparecem mais depois de preenchido');
  await page.screenshot({ path: `${SHOTS}/3-src-dst-ip-substitution.png` });
});

// ── Cenário 4: requires_ip_port — empty-state até IP+Porta preenchidos, depois card real ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="3"]');
  let desc3 = await page.locator('.card[data-cmd-id="3"] .card-desc').innerText();
  assert(desc3 === 'Fill IP and Port fields above to see this command', 'cenário 4: variante vazia mostrada quando IP/Porta em branco');
  assert(await page.isVisible('.card[data-cmd-id="3"] .ln-info'), 'cenário 4: linha de aviso "empty" visível');

  await setQueryFields(page, { ip: '192.168.1.10', port: '443' });
  await assertEventually(
    async () => (await page.locator('.card[data-cmd-id="3"] .card-desc').innerText()) === 'Check connection state for host',
    'cenário 4: variante real mostrada assim que IP e Porta são preenchidos'
  );
  const term3 = await page.locator('.card[data-cmd-id="3"] .term').innerText();
  assert(term3.includes('192.168.1.10:443'), 'cenário 4: comando real contém o valor substituído de IP:Porta');
  await page.screenshot({ path: `${SHOTS}/4-requires-ip-port.png` });
});

// ── Cenário 5: toggle "System commands" mostra/esconde comando de sistema ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  assert(!(await page.isVisible('.card[data-cmd-id="4"]')), 'cenário 5: comando de sistema oculto por padrão');
  await page.locator('.sb-toggle', { hasText: 'System commands' }).click();
  await assertEventually(async () => page.isVisible('.card[data-cmd-id="4"]'), 'cenário 5: comando de sistema aparece com o toggle ligado');
  await page.locator('.sb-toggle', { hasText: 'System commands' }).click();
  await assertEventually(async () => !(await page.isVisible('.card[data-cmd-id="4"]')), 'cenário 5: comando de sistema some de novo com o toggle desligado');
});

// ── Cenário 6: filtro de Vendor esconde comandos que não batem; sem vendor cadastrado sempre aparece ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const vendorBlock = page.locator('.sb-block-filter', { hasText: 'Vendor' });
  await vendorBlock.locator('.dd-btn').click();
  await vendorBlock.locator('.sb-row', { hasText: 'Fortinet' }).click();
  await assertEventually(async () => !(await page.isVisible('.card[data-cmd-id="1"]')), 'cenário 6: comando com vendor="check-point" some ao filtrar por Fortinet');
  assert(await page.isVisible('.card[data-cmd-id="2"]'), 'cenário 6: comando sem vendor cadastrado continua aparecendo (aplica a todos)');
  await page.screenshot({ path: `${SHOTS}/6-vendor-filter.png` });
});

// ── Cenário 7: Group by "Created by" agrupa em seções recolhíveis por criador ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.ctb-groupby-dd .dd-btn').click();
  await page.locator('.dd-panel .seg-btn', { hasText: 'Created by' }).click();
  await assertEventually(async () => (await page.locator('.section-creator').count()) >= 2, 'cenário 7: seções de "Created by" renderizadas');
  assert(await page.isVisible('.section-creator', { hasText: 'alice' }), 'cenário 7: grupo do criador "alice" presente');
  assert(await page.isVisible('.section-creator', { hasText: 'bob' }), 'cenário 7: grupo do criador "bob" presente');
  const aliceGroup = page.locator('.section-creator', { hasText: 'alice' }).first();
  assert(await aliceGroup.locator('.card[data-cmd-id="1"]').count() === 1, 'cenário 7: card do comando 1 está sob o grupo de "alice"');
  const bobGroup = page.locator('.section-creator', { hasText: 'bob' }).first();
  assert(await bobGroup.locator('.card[data-cmd-id="2"]').count() === 1, 'cenário 7: card do comando 2 está sob o grupo de "bob"');
  await page.screenshot({ path: `${SHOTS}/7-group-by-creator.png` });
});

// ── Cenário 8: busca filtra cards por substring; "No commands found" quando nada bate; limpar restaura ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  // Fatia 3b acrescentou um debounce de 120ms à caixa de busca da sidebar
  // (CmdSearchBox.tsx, mesmo padrão já usado pela QueryBar — ver
  // instruções da fatia) — a filtragem de verdade só é aplicada depois
  // desse atraso, então as duas checagens abaixo precisam de
  // assertEventually (o comando 2, que já estava visível ANTES da busca,
  // não serve mais como sinal de que o debounce já disparou).
  await page.fill('.cmd-search', 'tlist');
  await assertEventually(async () => !(await page.isVisible('.card[data-cmd-id="1"]')), 'cenário 8: busca por "tlist" esconde o comando 1 (não bate)');
  assert(await page.isVisible('.card[data-cmd-id="2"]'), 'cenário 8: busca por "tlist" mantém o comando 2 visível');
  // Regressão: seções de Tópico sem nenhum resultado não podem ficar na tela com contador 0.
  assert(!(await page.isVisible('.section:has(.sec-count) >> text=/^Status/i')) && (await page.locator('.section', { hasText: 'Status' }).count()) === 0, 'cenário 8: busca esconde a seção "Status" (sem resultado) em vez de mostrá-la com 0');
  assert((await page.locator('.sec-count', { hasText: /^0$/ }).count()) === 0, 'cenário 8: nenhuma seção com contador 0 durante a busca');
  assert((await page.locator('.section', { hasText: 'VPN' }).count()) >= 1, 'cenário 8: a seção com resultado (VPN) continua visível');

  await page.fill('.cmd-search', 'zzz-nao-existe');
  await assertEventually(async () => page.isVisible('text=No commands found'), 'cenário 8: "No commands found" aparece quando nada bate');

  await page.click('.cmd-search-clear');
  // 5, não 6: o comando 4 (is_system) fica oculto por padrão (settings.showSystemCommands=false) —
  // ver cenário 5. Os outros 5 (ids 1,2,3,5,6) devem voltar a aparecer.
  await assertEventually(async () => (await page.locator('.card').count()) === 5, 'cenário 8: limpar a busca restaura todos os cards visíveis (5, com o comando de sistema ainda oculto por padrão)');
  await page.screenshot({ path: `${SHOTS}/8-search-filter.png` });
});

// ── Cenário 9: chevron recolhe/expande uma seção; estado sobrevive a um reload (localStorage) ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const statusSection = page.locator('.section', { hasText: 'Status' }).first();
  await statusSection.locator('.sec-chevron').click();
  await assertEventually(async () => (await statusSection.getAttribute('class'))?.includes('collapsed'), 'cenário 9: clicar no chevron recolhe a seção');
  assert(!(await page.isVisible('.card[data-cmd-id="1"]')), 'cenário 9: card fica escondido quando a seção está recolhida');

  await page.reload();
  await page.waitForSelector('.section', { state: 'attached' });
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('cpa-collapsed-sections') || '[]'));
  assert(Array.isArray(persisted) && persisted.length > 0, 'cenário 9: cpa-collapsed-sections persistido no localStorage');
  const statusSectionAfterReload = page.locator('.section', { hasText: 'Status' }).first();
  await assertEventually(
    async () => (await statusSectionAfterReload.getAttribute('class'))?.includes('collapsed'),
    'cenário 9: seção continua recolhida depois do reload'
  );
  await page.screenshot({ path: `${SHOTS}/9-collapsed-section-persists.png` });
});

// ── Cenário 10: botão de copiar não lança erro e copia o texto com tokens substituídos, sem sentinelas ──
await withPage(
  browser,
  async page => {
    await mockLoggedInAdmin(page);
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.card[data-cmd-id="6"]');
    await setQueryFields(page, { src_ip: '10.9.9.1', dst_ip: '10.9.9.2' });
    await assertEventually(async () => (await page.locator('.card[data-cmd-id="6"] .term').innerText()).includes('10.9.9.1'), 'cenário 10: pré-condição — IPs substituídos antes de copiar');

    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e));
    await page.locator('.card[data-cmd-id="6"] .copy-btn-inline').click();
    await page.waitForSelector('.card[data-cmd-id="6"] .copy-btn-inline.ok', { timeout: 2000 });
    assert(pageErrors.length === 0, 'cenário 10: clicar em copiar não lança erro no console');

    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    assert(clipText.includes('10.9.9.1') && clipText.includes('10.9.9.2'), 'cenário 10: clipboard contém os valores de IP substituídos');
    assert(!/[\x01\x02]/.test(clipText), 'cenário 10: clipboard não contém caracteres de sentinela (\\x01/\\x02)');
    assert(!/\{\{\w+\}\}/.test(clipText), 'cenário 10: clipboard não contém {{token}} cru');
  },
  { clipboard: true }
);

// ── Cenário 11: filtros AO VIVO da sidebar persistem independente do default de Settings, e sobrevivem a um reload ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const vendorBlock = page.locator('.sb-block-filter', { hasText: 'Vendor' });
  await vendorBlock.locator('.dd-btn').click();
  await vendorBlock.locator('.sb-row', { hasText: 'Check Point' }).click();
  await assertEventually(async () => (await vendorBlock.locator('.dd-label').first().textContent())?.trim() === 'Check Point', 'cenário 11: seleção de Vendor aplicada antes do reload');

  // 'cpa-settings' nem chega a existir no localStorage até a primeira vez que
  // alguém MEXE numa preferência (useSettings() só persiste dentro de
  // update() — ver settingsStore.ts) — então o valor esperado aqui é
  // "ausente ou vazio", nunca ['check-point'] (o que indicaria que a seleção
  // ao vivo vazou pro default de Preferences, o bug que esta fatia corrigiu).
  const settingsVendorBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('cpa-settings') || '{}').vendor);
  assert(
    settingsVendorBefore === undefined || (Array.isArray(settingsVendorBefore) && settingsVendorBefore.length === 0),
    'cenário 11: default de Preferences (cpa-settings.vendor) NÃO foi tocado pela seleção ao vivo'
  );

  await page.reload();
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const vendorBlockAfter = page.locator('.sb-block-filter', { hasText: 'Vendor' });
  await assertEventually(
    async () => (await vendorBlockAfter.locator('.dd-label').first().textContent())?.trim() === 'Check Point',
    'cenário 11: filtro de Vendor continua selecionado depois do reload (persistido em cpa-sidebar-filters)'
  );
  const sidebarFiltersAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('cpa-sidebar-filters') || '{}'));
  assert(Array.isArray(sidebarFiltersAfter.vd) && sidebarFiltersAfter.vd.includes('check-point'), 'cenário 11: cpa-sidebar-filters contém o vendor selecionado');
  await page.screenshot({ path: `${SHOTS}/11-live-filters-persist.png` });
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
