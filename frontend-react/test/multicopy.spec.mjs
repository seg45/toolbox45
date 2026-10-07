// Cópia em lote (duplo clique num botão de copiar -> modo de seleção múltipla
// + barra flutuante Copy/Cancel/Delete). Porta de MULTI_COPY_MODE do original.
// /api/* mockado.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FALHOU:', msg); } else { console.log('ok:', msg); }
}
async function assertEventually(fn, msg, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return assert(true, msg); } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 50));
  }
  assert(false, msg);
}

const CATALOGS = {
  vendors: [], systems: [], versions: [], environments: [], parameters: [], prompts: [], exports: [],
  topics: [{ key: 'status', label: 'Status', color: '#60A5FA', sort_order: 0, is_protected: 0 }],
};
function cmd(id, name, contents) {
  return {
    id, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: id,
    requires_ip_port: false, placeholder_resolver: null,
    name, name_empty: null, desc: name, desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: contents.map(c => ({ line_type: 'cmd', prompt: '[Expert@FW]#', content: c, export_template: null, image_data: null })), empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'alice', modified_by: 'alice', is_system: false,
  };
}
const COMMANDS = [
  cmd(1, 'Cluster status', ['cphaprob stat']),
  cmd(2, 'VPN tunnels', ['vpn tu tlist', 'vpn tu mstats']),
  cmd(3, 'CPU stats', ['cpstat os -f cpu']),
];

async function withPage(browser, isAdmin, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  const deletes = [];
  let commands = COMMANDS.slice();
  await page.addInitScript(() => localStorage.setItem('cpa-authenticated', '1'));
  await page.route('**/api/**', route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = d => route.fulfill({ json: d });
    if (p === '/api/me') return json({ username: 'admin', handle: 'admin', role: isAdmin ? 'super_admin' : 'user', isAdmin, isSuperAdmin: isAdmin, authMethod: 'local' });
    if (p === '/api/catalogs') return json(CATALOGS);
    if (p === '/api/commands') return json(commands);
    const m = p.match(/^\/api\/commands\/(\d+)$/);
    if (m && req.method() === 'DELETE') { deletes.push(Number(m[1])); commands = commands.filter(c => c.id !== Number(m[1])); return json({ ok: true }); }
    if (p === '/api/system/logo') return json({ imageData: null, imageDataDark: null });
    if (req.method() !== 'GET') return json({ ok: true });
    return json(p.endsWith('s') ? [] : {});
  });
  try { await fn(page, deletes); } finally { await ctx.close(); }
}

const btn = (page, i) => page.locator('.copy-btn-inline').nth(i);
const clip = page => page.evaluate(() => navigator.clipboard.readText());

const browser = await chromium.launch();

// 1) clique simples continua copiando só aquela linha; duplo clique NÃO copia na hora
await withPage(browser, true, async page => {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="3"] .copy-btn-inline');
  assert((await page.locator('.copy-btn-inline').count()) === 4, 'quatro linhas de comando com botão de copiar');
  await page.locator('.card[data-cmd-id="3"] .copy-btn-inline').click();
  await page.waitForSelector('.card[data-cmd-id="3"] .copy-btn-inline.ok', { timeout: 2000 });
  assert((await clip(page)) === 'cpstat os -f cpu', 'clique simples copia só a linha clicada');
  assert((await page.locator('.multi-copy-bar.show').count()) === 0, 'clique simples não abre a barra de seleção');
});

// 2) duplo clique entra no modo; marca várias linhas; Copy junta tudo na ordem da página
await withPage(browser, true, async page => {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="3"] .copy-btn-inline');
  await page.evaluate(() => navigator.clipboard.writeText('antes'));
  await btn(page, 3).dblclick(); // última linha (cpstat) primeiro, fora de ordem
  await assertEventually(async () => (await page.locator('.multi-copy-bar.show').count()) === 1, 'duplo clique abre a barra');
  assert((await page.locator('#multiCopyCount').innerText()) === '1 selected', 'linha do duplo clique já fica marcada (1 selected)');
  assert((await clip(page)) === 'antes', 'duplo clique não copia na hora');
  await btn(page, 0).click();
  await btn(page, 1).click();
  assert((await page.locator('#multiCopyCount').innerText()) === '3 selected', 'cliques simples marcam mais linhas (3 selected)');
  assert((await page.locator('.copy-btn-inline.multi-on').count()) === 3, 'três botões com destaque multi-on');
  await btn(page, 1).click();
  assert((await page.locator('#multiCopyCount').innerText()) === '2 selected', 'novo clique desmarca (2 selected)');
  await btn(page, 1).click();
  await page.locator('#multiCopyCopyBtn').click();
  await assertEventually(async () => (await page.locator('.multi-copy-bar.show').count()) === 0, 'Copy fecha a barra');
  assert((await clip(page)) === 'cphaprob stat\nvpn tu tlist\ncpstat os -f cpu', `clipboard = linhas na ordem da página (lido: ${JSON.stringify(await clip(page))})`);
  assert((await page.locator('.copy-btn-inline.multi-on').count()) === 0, 'seleção limpa depois de copiar');
});

// 3) Escape, clique fora e Cancel saem do modo sem copiar
await withPage(browser, true, async page => {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="3"] .copy-btn-inline');
  await page.evaluate(() => navigator.clipboard.writeText('antes'));
  await btn(page, 0).dblclick();
  await page.waitForSelector('.multi-copy-bar.show');
  await page.keyboard.press('Escape');
  await assertEventually(async () => (await page.locator('.multi-copy-bar.show').count()) === 0 && (await page.locator('.multi-on').count()) === 0, 'Escape cancela e limpa a seleção');
  await btn(page, 0).dblclick();
  await page.waitForSelector('.multi-copy-bar.show');
  await page.locator('.card[data-cmd-id="3"] .card-name').click();
  await assertEventually(async () => (await page.locator('.multi-copy-bar.show').count()) === 0, 'clique fora cancela');
  await btn(page, 0).dblclick();
  await page.waitForSelector('.multi-copy-bar.show');
  await page.locator('.multi-copy-bar button', { hasText: 'Cancel' }).click();
  await assertEventually(async () => (await page.locator('.multi-copy-bar.show').count()) === 0, 'Cancel fecha a barra');
  assert((await clip(page)) === 'antes', 'nada foi copiado ao cancelar');
  assert((await page.locator('#multiCopyCopyBtn').isDisabled()) === true, 'Copy desabilitado sem seleção');
});

// 4) admin: Delete apaga os comandos únicos selecionados (2 linhas do mesmo comando = 1 DELETE)
await withPage(browser, true, async (page, deletes) => {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="3"] .copy-btn-inline');
  await btn(page, 1).dblclick();
  await btn(page, 2).click(); // 2 linhas do comando 2
  await btn(page, 3).click(); // comando 3
  assert((await page.locator('#multiCopyDeleteBtn').count()) === 1, 'admin vê o botão Delete na barra');
  await page.locator('#multiCopyDeleteBtn').click();
  await page.locator('#confirmOkBtn').click();
  await assertEventually(async () => deletes.length === 2, `dois DELETEs (um por comando; lido: ${JSON.stringify(deletes)})`);
  assert(JSON.stringify([...deletes].sort()) === '[2,3]', 'DELETE dos comandos 2 e 3');
  await assertEventually(async () => (await page.locator('.card').count()) === 1 && (await page.locator('.multi-copy-bar.show').count()) === 0, 'lista atualiza e a barra fecha');
});

// 5) usuário comum não vê Delete
await withPage(browser, false, async page => {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="3"] .copy-btn-inline');
  await btn(page, 0).dblclick();
  await page.waitForSelector('.multi-copy-bar.show');
  assert((await page.locator('#multiCopyDeleteBtn').count()) === 0, 'usuário comum não vê Delete');
});

await browser.close();
if (failures) { console.error(`multicopy.spec: ${failures} falha(s)`); process.exit(1); }
console.log('multicopy.spec: tudo ok');
