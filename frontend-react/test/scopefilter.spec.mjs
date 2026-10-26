// Suite de validação manual (Playwright) da Fase 3, fatia 3a (Comandos
// núcleo) — mesmo padrão de mocking de /api/* usado em test/login.spec.mjs
// e test/appshell.spec.mjs.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/scopefilter-shots';
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
    { key: 'maestro', system: 'gaia', vendor: 'check-point', label: 'Maestro', color: '#A78BFA', sort_order: 2 },
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
  // aplica a todos (sem versão/ambiente cadastrados)
  { id: 1, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 0, requires_ip_port: false, placeholder_resolver: null,
    name: 'Generic', name_empty: null, desc: 'Any version, any environment', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'generic' })], empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'admin', modified_by: 'admin', is_system: false },
  // só Cluster
  { id: 2, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 0, requires_ip_port: false, placeholder_resolver: null,
    name: 'ClusterOnly', name_empty: null, desc: 'Cluster only', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: ['cluster'],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'clusteronly' })], empty: [] },
    created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', created_by: 'admin', modified_by: 'admin', is_system: false },
  // só Maestro
  { id: 3, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 0, requires_ip_port: false, placeholder_resolver: null,
    name: 'MaestroOnly', name_empty: null, desc: 'Maestro only', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: ['maestro'],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'maestroonly' })], empty: [] },
    created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z', created_by: 'admin', modified_by: 'admin', is_system: false },
  // Cluster + Maestro
  { id: 4, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 0, requires_ip_port: false, placeholder_resolver: null,
    name: 'ClusterAndMaestro', name_empty: null, desc: 'Cluster and Maestro', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: ['cluster', 'maestro'],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'both' })], empty: [] },
    created_at: '2026-01-04T00:00:00Z', updated_at: '2026-01-04T00:00:00Z', created_by: 'admin', modified_by: 'admin', is_system: false },
  // só R82
  { id: 5, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 0, requires_ip_port: false, placeholder_resolver: null,
    name: 'R82Only', name_empty: null, desc: 'R82 only', desc_empty: null, details: null,
    vendors: [], systems: [], versions: ['R82'], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'r82only' })], empty: [] },
    created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-05T00:00:00Z', created_by: 'admin', modified_by: 'admin', is_system: false },
  // tópico VPN apenas
  { id: 6, topic: 'vpn', topics: ['vpn'], folder_ids: [], icon: null, sort_order: 0, requires_ip_port: false, placeholder_resolver: null,
    name: 'VpnOnly', name_empty: null, desc: 'VPN only', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'vpnonly' })], empty: [] },
    created_at: '2026-01-06T00:00:00Z', updated_at: '2026-01-06T00:00:00Z', created_by: 'admin', modified_by: 'admin', is_system: false },
  // dois tópicos: Status + VPN
  { id: 7, topic: 'status', topics: ['status', 'vpn'], folder_ids: [], icon: null, sort_order: 0, requires_ip_port: false, placeholder_resolver: null,
    name: 'StatusAndVpn', name_empty: null, desc: 'Two topics', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'twotopics' })], empty: [] },
    created_at: '2026-01-07T00:00:00Z', updated_at: '2026-01-07T00:00:00Z', created_by: 'admin', modified_by: 'admin', is_system: false },
];

// `allCommands`: liga "All commands" de saída (sem isso o app só mostra os
// comandos do próprio usuário — ver cenário 5). `username`: quem está logado.
async function mockLoggedInAdmin(page, { allCommands = true, username = 'admin' } = {}) {
  await page.addInitScript(on => {
    localStorage.setItem('cpa-authenticated', '1');
    if (on && !localStorage.getItem('cpa-settings')) localStorage.setItem('cpa-settings', JSON.stringify({ showSystemCommands: true }));
  }, allCommands);
  await page.route('**/api/me', route =>
    route.fulfill({
      json: {
        username, upn: username, role: 'super_admin',
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
const vis = (page, id) => page.isVisible(`.card[data-cmd-id="${id}"]`);

async function pick(page, block, label) {
  const b = page.locator('.sb-block-filter', { hasText: block });
  await b.locator('.dd-btn').click();
  await b.locator('.sb-row', { hasText: label }).click();
  await page.keyboard.press('Escape');
}

// ── 1: sem filtro (All) todos aparecem ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const all = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(i => vis(page, i)));
  assert(all.every(Boolean), 'cenário 1: Environment/Version = All mostra todos os comandos');
});

// ── 2: Environment = Maestro → só genéricos e os que incluem Maestro ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await pick(page, 'Environment', 'Maestro');
  await assertEventually(async () => !(await vis(page, 2)), 'cenário 2: comando só-Cluster some ao filtrar por Maestro');
  assert(await vis(page, 1), 'cenário 2: comando sem ambiente cadastrado continua (aplica a todos)');
  assert(await vis(page, 3), 'cenário 2: comando Maestro aparece');
  assert(await vis(page, 4), 'cenário 2: comando Cluster+Maestro aparece');
  assert(await vis(page, 5), 'cenário 2: comando sem ambiente (só R82) continua');
});

// ── 3: Version = R82 e Environment = Cluster combinados ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await pick(page, 'Environment', 'Cluster HA');
  await assertEventually(async () => !(await vis(page, 3)), 'cenário 3: comando só-Maestro some ao filtrar por Cluster');
  assert((await vis(page, 2)) && (await vis(page, 4)) && (await vis(page, 1)), 'cenário 3: Cluster, Cluster+Maestro e genérico aparecem');
  await pick(page, 'Version', 'R81.10');
  await assertEventually(async () => !(await vis(page, 5)), 'cenário 3: comando só-R82 some ao filtrar por R81.10');
  assert(await vis(page, 1), 'cenário 3: genérico continua com Version+Environment filtrados');
});

// ── 4: Topic usa a mesma regra (vazio = todos; basta um dos tópicos do comando estar marcado) ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await pick(page, 'Topic', 'VPN');
  await assertEventually(async () => !(await vis(page, 1)), 'cenário 4: comando só-Status some ao filtrar por VPN');
  assert(await vis(page, 6), 'cenário 4: comando VPN aparece');
  assert(await vis(page, 7), 'cenário 4: comando com Status+VPN aparece (um dos tópicos basta)');
  await pick(page, 'Environment', 'Maestro');
  await assertEventually(async () => !(await vis(page, 2)), 'cenário 4: Topic combinado com Environment');
  assert(await vis(page, 6), 'cenário 4: VPN sem ambiente cadastrado continua com os dois filtros');
});

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
