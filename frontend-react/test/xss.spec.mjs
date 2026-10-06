// Suite de validação (Playwright) do endurecimento contra XSS:
//   1) HTML rico malicioso que o servidor devolva (dado legado, gravado antes
//      do sanitizador novo) NÃO executa — src/lib/safeHtml.ts sanitiza na hora
//      de renderizar;
//   2) o Content-Security-Policy REAL de frontend-react/nginx.conf (lido do
//      arquivo, não copiado) não é violado pelo app nem pela tela de login —
//      ou seja, o CSP não quebra nada — e bloqueia <script> inline injetado.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = 'http://localhost:4173';
let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FALHOU:', msg); } else { console.log('ok:', msg); }
}

const nginx = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'nginx.conf'), 'utf8');
const CSP = (/add_header Content-Security-Policy "([^"]+)"/.exec(nginx) || [])[1];
assert(!!CSP && CSP.includes("script-src 'self'") && !CSP.includes("script-src 'self' 'unsafe-inline'"), 'nginx.conf declara um CSP com script-src \'self\' (sem unsafe-inline)');

const CATALOGS = {
  vendors: [{ key: 'check-point', label: 'Check Point', color: '#DA1572', sort_order: 0 }],
  systems: [{ key: 'gaia', vendor: 'check-point', label: 'Gaia', color: '#2DD4BF', sort_order: 0 }],
  versions: [{ key: 'R82', system: 'gaia', vendor: 'check-point', label: 'R82', color: '#FBBF24', sort_order: 0 }],
  environments: [{ key: 'standalone', system: 'gaia', vendor: 'check-point', label: 'Standalone', color: '#FB923C', sort_order: 0 }],
  topics: [{ key: 't0', label: 'Topic 0', color: '#60A5FA', sort_order: 0, is_protected: 0 }],
  parameters: [{ key: 'src_ip', label: 'Source IP', sort_order: 0 }],
};
const L = o => ({ line_type: 'cmd', prompt: '[Expert@FW]#', content: '', export_template: null, image_data: null, ...o });
const PAYLOADS = [
  '<img src=x onerror="window.__xss=1" <b>bold</b>',
  '<a href="javascript:window.__xss=2">click</a>',
  '<b onclick="window.__xss=3" onmouseover="window.__xss=3">hover</b> <svg onload="window.__xss=4"></svg>',
  '<img src="https://example.invalid/a.png" onerror="window.__xss=5" width=10>',
  '<span style="color:red;background:url(javascript:window.__xss=6);position:fixed">styled</span> <script>window.__xss=7</script>',
  '<p>texto <i>normal</i> e <a href="https://example.com/ok">link ok</a></p>',
];
const cmds = PAYLOADS.map((d, i) => ({
  id: i + 1, topic: 't0', topics: ['t0'], folder_ids: [], icon: null, sort_order: i,
  requires_ip_port: false, placeholder_resolver: null,
  name: 'Cmd ' + i, name_empty: null, desc: 'Desc ' + i, desc_empty: null, details: d,
  vendors: [], systems: [], versions: [], environments: [],
  lines: { default: [L({ content: 'cphaprob stat ' + i })], empty: [] },
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'admin', modified_by: 'admin', is_system: false,
}));

async function newPage(browser, withCsp) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (withCsp) {
    // Reescreve só a resposta dos arquivos estáticos, acrescentando o CSP do nginx.
    await ctx.route(u => u.origin === BASE && !u.pathname.startsWith('/api/'), async route => {
      const resp = await route.fetch();
      await route.fulfill({ response: resp, headers: { ...resp.headers(), 'content-security-policy': CSP } });
    });
  }
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route('**/api/me', r => r.fulfill({ json: { username: 'admin', upn: 'admin', handle: 'admin', role: 'super_admin', isAdmin: true, isSuperAdmin: true, authMethod: 'local' } }));
  await page.route('**/api/catalogs', r => r.fulfill({ json: CATALOGS }));
  await page.route('**/api/commands', r => r.fulfill({ json: cmds }));
  await page.route('**/api/folders**', r => r.fulfill({ json: [] }));
  await page.route('**/api/user-data', r => (r.request().method() === 'GET' ? r.fulfill({ json: {} }) : r.fulfill({ status: 204, body: '' })));
  await page.route('**/api/system/logo', r => r.fulfill({ json: { imageData: null, imageDataDark: null } }));
  await page.route('**/api/system/appearance', r => r.fulfill({ json: { theme: 'light', accentColor: 'teal' } }));
  await page.route('**/api/auth/providers', r => r.fulfill({ json: { google: false, microsoft: false } }));
  return { ctx, page };
}

const browser = await chromium.launch();

// ── 1) HTML malicioso nos detalhes não executa e é neutralizado no DOM ──
for (const withCsp of [false, true]) {
  const tag = withCsp ? '(com CSP)' : '(sem CSP)';
  const { ctx, page } = await newPage(browser, withCsp);
  await page.addInitScript(() => localStorage.setItem('cpa-authenticated', '1'));
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card');
  await page.waitForTimeout(800); // dá tempo de qualquer onerror disparar
  assert((await page.evaluate(() => window.__xss)) === undefined, `detalhes maliciosos não executam código ${tag}`);
  const bad = await page.evaluate(() => {
    const root = document.querySelector('.main') || document.body;
    return {
      handlers: [...root.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length,
      jsHref: root.querySelectorAll('a[href^="javascript:" i]').length,
      scripts: root.querySelectorAll('.about-body script, .about-body svg').length,
      badStyle: [...root.querySelectorAll('.about-body [style]')].filter(e => /url\(|position|javascript/i.test(e.getAttribute('style'))).length,
    };
  });
  assert(bad.handlers === 0, `nenhum atributo on* sobrou no DOM ${tag}`);
  assert(bad.jsHref === 0, `nenhum href javascript: sobrou ${tag}`);
  assert(bad.scripts === 0, `nenhum <script>/<svg> sobrou nos detalhes ${tag}`);
  assert(bad.badStyle === 0, `style perigoso (url/position) removido ${tag}`);
  const okLink = await page.locator('.about-body a[href="https://example.com/ok"]').count();
  assert(okLink === 1, `link https legítimo continua nos detalhes ${tag}`);
  assert((await page.locator('.about-body a[href="https://example.com/ok"]').first().getAttribute('rel')) === 'noopener noreferrer', `link legítimo ganha rel=noopener ${tag}`);
  assert((await page.locator('.about-body b').count()) >= 1, `formatação legítima (<b>) preservada ${tag}`);
  await ctx.close();
}

// ── 2) CSP do nginx: o app e o login funcionam sem violações; <script> inline injetado é bloqueado ──
{
  const { ctx, page } = await newPage(browser, true);
  await page.addInitScript(() => localStorage.setItem('cpa-authenticated', '1'));
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card');
  await page.waitForTimeout(500);
  const v = await page.evaluate(() => window.__csp);
  assert(v.length === 0, `app principal: nenhuma violação de CSP (${JSON.stringify(v)})`);
  assert((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light', 'app principal: boot de tema (script externo) rodou');
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inline = 1';
    document.body.appendChild(s);
  });
  assert((await page.evaluate(() => window.__inline)) === undefined, 'CSP bloqueia <script> inline injetado');
  assert((await page.evaluate(() => window.__csp)).some(x => x.startsWith('script-src')), 'violação script-src foi reportada ao bloquear o inline');
  await ctx.close();
}
{
  const { ctx, page } = await newPage(browser, true);
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('input');
  await page.waitForTimeout(500);
  const v = await page.evaluate(() => window.__csp);
  // fonts.googleapis.com/gstatic.com são permitidos pelo CSP; sem rede aqui,
  // falha de carregamento não é violação de CSP.
  assert(v.length === 0, `login: nenhuma violação de CSP (${JSON.stringify(v)})`);
  assert((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light', 'login: boot de tema (script externo) rodou');
  await ctx.close();
}

await browser.close();
if (failures) { console.error(`\n${failures} falha(s)`); process.exit(1); }
console.log('\nxss.spec: tudo ok');
