// Benchmark (NAO faz parte da suite): mede carga/interacao da lista de
// comandos com N comandos sinteticos. Uso: node test/bench.mjs 500 2000 5000
import { chromium } from 'playwright';
const BASE = 'http://localhost:4173';
const TOPICS = Array.from({ length: 12 }, (_, i) => ({ key: 't' + i, label: 'Topic ' + i, color: '#60A5FA', sort_order: i, is_protected: 0 }));
const CATALOGS = {
  vendors: [{ key: 'check-point', label: 'Check Point', color: '#DA1572', sort_order: 0 }, { key: 'fortinet', label: 'Fortinet', color: '#E4002B', sort_order: 1 }],
  systems: [{ key: 'gaia', vendor: 'check-point', label: 'Gaia', color: '#2DD4BF', sort_order: 0 }],
  versions: [{ key: 'R82', system: 'gaia', vendor: 'check-point', label: 'R82', color: '#FBBF24', sort_order: 0 }],
  environments: [{ key: 'standalone', system: 'gaia', vendor: 'check-point', label: 'Standalone', color: '#FB923C', sort_order: 0 }],
  topics: TOPICS,
  parameters: [{ key: 'src_ip', label: 'Source IP', sort_order: 0 }, { key: 'dst_ip', label: 'Destination IP', sort_order: 1 }],
};
const L = (o) => ({ line_type: 'cmd', prompt: '[Expert@FW]#', content: '', export_template: null, image_data: null, ...o });
function make(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, topic: 't' + (i % 12), topics: ['t' + (i % 12)], folder_ids: [], icon: null, sort_order: i,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'Comando ' + i, name_empty: null, desc: 'Descricao do comando numero ' + i, desc_empty: null, details: null,
    vendors: i % 3 === 0 ? ['check-point'] : [], systems: [], versions: [], environments: [],
    lines: { default: [L({ content: 'fw ctl zdebug -m fw + drop host({{src_ip}}) and host({{dst_ip}}) # ' + i }), L({ content: 'cphaprob stat ' + i })], empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'alice', modified_by: 'alice', is_system: false,
  }));
}
const browser = await chromium.launch();
for (const n of process.argv.slice(2).map(Number)) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
    window.__lt = 0; try { new PerformanceObserver(l => l.getEntries().forEach(e => (window.__lt += e.duration))).observe({ entryTypes: ['longtask'] }); } catch {}
  });
  const cmds = make(n);
  await page.route('**/api/me', r => r.fulfill({ json: { username: 'admin', upn: 'admin', handle: 'admin', role: 'super_admin', isAdmin: true, isSuperAdmin: true, authMethod: 'local' } }));
  await page.route('**/api/catalogs', r => r.fulfill({ json: CATALOGS }));
  await page.route('**/api/commands', r => r.fulfill({ json: cmds }));
  await page.route('**/api/folders**', r => r.fulfill({ json: [] }));
  await page.route('**/api/user-data', r => r.request().method() === 'GET' ? r.fulfill({ json: {} }) : r.fulfill({ json: { ok: true } }));
  await page.route('**/api/system/logo', r => r.fulfill({ json: { imageData: null, imageDataDark: null } }));
  await page.route('**/fonts.googleapis.com/**', r => r.abort());
  if (process.env.CV) await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '.card{content-visibility:auto;contain-intrinsic-size:auto 90px}'; document.head.appendChild(st); }); });
  const t0 = Date.now();
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card', { timeout: 120000 });
  const tFirst = Date.now() - t0;
  await page.waitForTimeout(1500);
  const stats = await page.evaluate(() => ({ nodes: document.querySelectorAll('*').length, cards: document.querySelectorAll('.card').length, lt: Math.round(window.__lt), heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1 }));
  const time = async (fn) => { const s = Date.now(); await fn(); return Date.now() - s; };
  const input = page.locator('.cpq-input');
  const tType = await time(async () => { await input.click(); await input.type('zdebug', { delay: 0 }); await page.waitForTimeout(50); });
  await page.waitForTimeout(500);
  const sidebarSearch = page.locator('.sidebar input[type=text], .sidebar input[type=search]').first();
  const tClear = await time(async () => { await input.fill(''); await page.waitForTimeout(50); });
  const sec = page.locator('.sec-header, .section-header, .sec-title').first();
  const tToggle = await time(async () => { await page.keyboard.press('Escape'); await page.mouse.click(800, 600); await sec.scrollIntoViewIfNeeded(); const s2 = Date.now(); await sec.dispatchEvent('click'); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); void s2; });
  console.log(JSON.stringify({ n, tFirstCardMs: tFirst, ...stats, typeMs: tType, clearMs: tClear, toggleMs: tToggle }));
  await ctx.close();
}
await browser.close();
