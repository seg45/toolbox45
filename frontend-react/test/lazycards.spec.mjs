// Suite de validação (Playwright) da montagem preguiçosa de cards
// (src/components/commands/LazyCard.tsx) — mesma convenção de mocking de
// /api/* das demais suites. Fixture sintética: 600 comandos em 12 tópicos.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FALHOU:', msg); } else { console.log('ok:', msg); }
}
async function assertEventually(fn, msg, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) { assert(true, msg); return; }
    await new Promise(r => setTimeout(r, 50));
  }
  assert(false, msg);
}

const TOPICS = Array.from({ length: 12 }, (_, i) => ({ key: 't' + i, label: 'Topic ' + i, color: '#60A5FA', sort_order: i, is_protected: 0 }));
const CATALOGS = {
  vendors: [{ key: 'check-point', label: 'Check Point', color: '#DA1572', sort_order: 0 }],
  systems: [{ key: 'gaia', vendor: 'check-point', label: 'Gaia', color: '#2DD4BF', sort_order: 0 }],
  versions: [{ key: 'R82', system: 'gaia', vendor: 'check-point', label: 'R82', color: '#FBBF24', sort_order: 0 }],
  environments: [{ key: 'standalone', system: 'gaia', vendor: 'check-point', label: 'Standalone', color: '#FB923C', sort_order: 0 }],
  topics: TOPICS,
  parameters: [{ key: 'src_ip', label: 'Source IP', sort_order: 0 }],
};
const L = o => ({ line_type: 'cmd', prompt: '[Expert@FW]#', content: '', export_template: null, image_data: null, ...o });
function make(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, topic: 't' + (i % 12), topics: ['t' + (i % 12)], folder_ids: [], icon: null, sort_order: i,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'Comando ' + i, name_empty: null, desc: 'Descricao ' + i, desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [L({ content: 'cphaprob stat ' + i })], empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'admin', modified_by: 'admin', is_system: false,
  }));
}

async function openApp(browser, n) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('cpa-authenticated', '1'));
  const cmds = make(n);
  await page.route('**/api/me', r => r.fulfill({ json: { username: 'admin', upn: 'admin', role: 'super_admin', isAdmin: true, isSuperAdmin: true, authMethod: 'local' } }));
  await page.route('**/api/catalogs', r => r.fulfill({ json: CATALOGS }));
  await page.route('**/api/commands', r => r.fulfill({ json: cmds }));
  await page.route('**/api/folders**', r => r.fulfill({ json: [] }));
  await page.route('**/api/user-data', r => (r.request().method() === 'GET' ? r.fulfill({ json: {} }) : r.fulfill({ json: { ok: true } })));
  await page.route('**/api/system/logo', r => r.fulfill({ json: { imageData: null, imageDataDark: null } }));
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card');
  return { ctx, page };
}

const browser = await chromium.launch();

// ── Cenário 1: com 600 cards só uma fração é montada; a rolagem monta os de baixo e o DOM continua enxuto ──
{
  const { ctx, page } = await openApp(browser, 600);
  const live = () => page.locator('.card').count();
  const placeholders = () => page.locator('.card-lazy').count();
  assert((await placeholders()) === 600, 'cenário 1: um placeholder (.card-lazy) por comando — 600');
  const first = await live();
  assert(first > 0 && first < 100, `cenário 1: só uma fração dos cards está montada de início (${first} de 600)`);
  assert(await page.isVisible('.card[data-cmd-id="1"]'), 'cenário 1: o primeiro card está montado e visível');
  // (as seções ordenam por nome, então o "último" da tela não é o id 600)
  const lastId = await page.evaluate(() => { const a = document.querySelectorAll('.card-lazy'); return a[a.length - 1].getAttribute('data-cmd-id'); });
  const firstId = await page.evaluate(() => document.querySelector('.card-lazy').getAttribute('data-cmd-id'));
  assert(!(await page.locator(`.card[data-cmd-id="${lastId}"]`).count()), 'cenário 1: o último card da lista ainda não está montado');

  const h0 = await page.evaluate(() => document.querySelector('.main').scrollHeight);
  await page.evaluate(() => { const m = document.querySelector('.main'); m.scrollTop = m.scrollHeight; });
  await assertEventually(async () => (await page.locator(`.card[data-cmd-id="${lastId}"]`).count()) === 1, 'cenário 1: rolar até o fim monta o último card');
  await assertEventually(async () => (await page.locator(`.card[data-cmd-id="${firstId}"]`).count()) === 0, 'cenário 1: o primeiro card, já longe, volta a ser placeholder (DOM enxuto)');
  assert((await live()) < 150, `cenário 1: DOM vivo continua limitado depois de rolar tudo (${await live()} cards montados)`);
  assert((await placeholders()) === 600, 'cenário 1: os 600 placeholders continuam (a altura é reservada)');
  const h1 = await page.evaluate(() => document.querySelector('.main').scrollHeight);
  assert(Math.abs(h1 - h0) / h0 < 0.35, `cenário 1: altura total da lista estável depois de medir os cards (antes ${h0}, depois ${h1})`);

  await page.evaluate(() => { document.querySelector('.main').scrollTop = 0; });
  await assertEventually(async () => (await page.locator(`.card[data-cmd-id="${firstId}"]`).count()) === 1, 'cenário 1: voltar ao topo monta o primeiro card de novo');
  assert((await page.locator(`.card[data-cmd-id="${firstId}"] .card-name`).innerText()) === 'Comando ' + (Number(firstId) - 1), 'cenário 1: o card remontado tem o conteúdo certo');
  await ctx.close();
}

// ── Cenário 1b: layout — a PÁGINA não rola, quem rola é o .main; a sidebar (com a busca) fica no lugar; cards logo abaixo da dobra já estão montados ──
{
  const { ctx, page } = await openApp(browser, 600);
  const geo = () => page.evaluate(() => {
    const r = s => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.height)]; };
    const m = document.querySelector('.main');
    return { docH: document.documentElement.scrollHeight, winH: innerHeight, scrollY: scrollY, mainScrolls: m.scrollHeight > m.clientHeight + 100, search: r('.sidebar .cmd-search-wrap'), sidebar: r('.sidebar'), hdr: r('.hdr') };
  });
  const g0 = await geo();
  assert(g0.docH <= g0.winH, `cenário 1b: a página não rola (documento ${g0.docH}px, janela ${g0.winH}px)`);
  assert(g0.mainScrolls, 'cenário 1b: o .main é o contêiner que rola');
  assert(g0.sidebar[0] === 48 && g0.search[0] === 48, `cenário 1b: sidebar e busca encostam no cabeçalho (sidebar y=${g0.sidebar[0]}, busca y=${g0.search[0]})`);
  await page.evaluate(() => { document.querySelector('.main').scrollTop = 5000; });
  await page.waitForTimeout(700);
  const g1 = await geo();
  assert(g1.search[0] === g0.search[0] && g1.sidebar[0] === g0.sidebar[0] && g1.hdr[0] === 0, 'cenário 1b: depois de rolar a lista, busca, sidebar e cabeçalho continuam no mesmo lugar');
  const below = await page.evaluate(() => [...document.querySelectorAll('.card-lazy')].filter(e => { const t = e.getBoundingClientRect().top; return t > innerHeight + 50 && t < innerHeight + 700; }).map(e => !!e.querySelector('.card')));
  assert(below.length > 0 && below.every(Boolean), `cenário 1b: cards até ~700px abaixo da dobra já estão montados (${below.filter(Boolean).length}/${below.length}) — a margem de pré-carga funciona dentro do .main`);
  await ctx.close();
}

// ── Cenário 1c: "System commands" ligado (muito mais comandos) não tira a busca da tela ──
{
  const { ctx, page } = await openApp(browser, 600);
  await page.locator('.sidebar').getByText('System commands').click();
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.querySelector('.main').scrollTop = 3000; });
  await page.waitForTimeout(500);
  assert(await page.locator('.sidebar .cmd-search-wrap').isVisible(), 'cenário 1c: a busca da sidebar continua visível depois de rolar a lista');
  const top = await page.locator('.sidebar .cmd-search-wrap').evaluate(e => Math.round(e.getBoundingClientRect().top));
  assert(top === 48, `cenário 1c: a busca fica logo abaixo do cabeçalho (y=${top})`);
  await ctx.close();
}

// ── Cenário 2: o botão Edit de um card montado sob demanda abre o editor ──
{
  const { ctx, page } = await openApp(browser, 600);
  await page.locator('.card[data-cmd-id="1"] button[title="Edit command"]').click();
  await assertEventually(async () => (await page.locator('.modal-overlay').count()) > 0, 'cenário 2: Edit abre o editor num card montado preguiçosamente');
  await page.keyboard.press('Escape');
  await ctx.close();
}

// ── Cenário 3: filtrar até restarem poucos cards desliga o modo preguiçoso (todos reais, sem placeholder) ──
{
  const { ctx, page } = await openApp(browser, 600);
  await page.locator('.sidebar input[placeholder="Search"]').fill('Comando 59');
  await assertEventually(async () => (await page.locator('.card-lazy').count()) === 0, 'cenário 3: com poucos resultados não há placeholders');
  assert((await page.locator('.card').count()) > 0 && (await page.locator('.card').count()) < 20, 'cenário 3: os resultados filtrados são cards reais');
  await ctx.close();
}

// ── Cenário 4: abaixo do limiar (100 comandos) tudo é montado de uma vez, como antes ──
{
  const { ctx, page } = await openApp(browser, 100);
  assert((await page.locator('.card-lazy').count()) === 0, 'cenário 4: 100 comandos não usam placeholders');
  assert((await page.locator('.card').count()) === 100, 'cenário 4: os 100 cards estão montados');
  await ctx.close();
}

await browser.close();
if (failures) { console.error(`\n${failures} CENÁRIO(S) FALHARAM`); process.exit(1); }
console.log('\nTODOS OS CENÁRIOS PASSARAM');
