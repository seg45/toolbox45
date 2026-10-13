// Protecao contra folha de estilo que falha ao carregar (pagina "sem CSS" apos o
// login, so normaliza com F5): public/boot-css-guard.js busca a folha de novo.
// /api/* mockado.
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
async function assertEventually(fn, msg, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return assert(true, msg);
    await new Promise(r => setTimeout(r, 100));
  }
  assert(false, msg);
}

async function mockApi(page) {
  await page.addInitScript(() => localStorage.setItem('cpa-authenticated', '1'));
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname;
    const json = d => route.fulfill({ json: d });
    if (p === '/api/me') return json({ username: 'admin@x.com', upn: 'admin@x.com', role: 'super_admin', isAdmin: true, isSuperAdmin: true, authMethod: 'local' });
    if (p === '/api/catalogs') return json({ vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [] });
    if (route.request().method() !== 'GET') return json({});
    return json(p.endsWith('s') ? [] : {});
  });
}

const hdrStyled = page =>
  page.evaluate(() => {
    const h = document.querySelector('.hdr');
    return !!h && getComputedStyle(h).position === 'sticky';
  });

const browser = await chromium.launch();

// 1) Sem falha: o guard nao atrapalha (nenhum ?r= extra e pagina estilizada).
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const urls = [];
  page.on('request', r => urls.push(r.url()));
  await mockApi(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.hdr');
  await assertEventually(() => hdrStyled(page), 'sem falha: header estilizado');
  await new Promise(r => setTimeout(r, 800));
  assert(!urls.some(u => /\.css\?r=/.test(u)), 'sem falha: nenhuma folha foi rebuscada');
  await ctx.close();
}

// 2) A 1a requisicao da folha de layout falha (erro de rede): o guard rebusca e a pagina normaliza.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await mockApi(page);
  let aborted = 0;
  await page.route(/\/assets\/main-[^/]+\.css(\?.*)?$/, route => {
    if (aborted < 1) {
      aborted++;
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.hdr');
  assert(aborted === 1, 'falha: a 1a requisicao da folha de layout foi derrubada');
  await assertEventually(() => hdrStyled(page), 'falha: o header ficou estilizado depois da nova tentativa');
  await ctx.close();
}

// 3) Folha responde 200 mas vazia: tambem e rebuscada.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await mockApi(page);
  let served = 0;
  await page.route(/\/assets\/main-[^/]+\.css(\?.*)?$/, route => {
    if (served < 1) {
      served++;
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    return route.continue();
  });
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.hdr');
  await assertEventually(() => hdrStyled(page), 'vazia: o header ficou estilizado depois da nova tentativa');
  await ctx.close();
}

await browser.close();
if (failures) {
  console.error(`${failures} FALHA(S)`);
  process.exit(1);
}
console.log('\ncssguard.spec: tudo ok');
