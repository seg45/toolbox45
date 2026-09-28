// Suite de validação manual (Playwright) da Fase 3, fatia 3b (Query bar
// unificada + histórico de busca genérico) — mesmo padrão de mocking de
// /api/* usado em test/login.spec.mjs, test/appshell.spec.mjs e
// test/commands.spec.mjs.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/fase3-fatia3b-shots';
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
// 9 parâmetros: os 8 da linha fixa (CPQ_FIXED_PARAM_ORDER) + 1 extra
// ("action") que só aparece dentro do painel "Others" — usado pra provar
// que "Others" mostra TODO o catálogo (não só os que não estão na linha
// fixa) e pra exercitar o typeahead com um rótulo que não colide com os
// outros.
const CATALOGS = {
  vendors: [],
  systems: [],
  versions: [],
  environments: [],
  topics: [{ key: 'vpn', label: 'VPN', color: '#22D3EE', sort_order: 0, is_protected: 0 }],
  parameters: [
    { key: 'src_ip', label: 'Source IP', sort_order: 0 },
    { key: 'dst_ip', label: 'Destination IP', sort_order: 1 },
    { key: 'src_port', label: 'Source Port', sort_order: 2 },
    { key: 'dst_port', label: 'Destination Port', sort_order: 3 },
    { key: 'user', label: 'User', sort_order: 4 },
    { key: 'host', label: 'Host', sort_order: 5 },
    { key: 'license', label: 'License', sort_order: 6 },
    { key: 'signature', label: 'Signature', sort_order: 7 },
    { key: 'action', label: 'Action', sort_order: 8 },
  ],
};

function line(overrides) {
  return { line_type: 'cmd', prompt: null, content: '', export_template: null, image_data: null, ...overrides };
}

const COMMANDS = [
  {
    id: 1, topic: 'vpn', topics: ['vpn'], folder_ids: [], icon: null, sort_order: 0,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'Debug IKE handshake', name_empty: null, desc: 'fw monitor filter for src/dst', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: {
      default: [line({ prompt: '[Expert@FW]#', content: 'fw monitor -e "accept host({{src_ip}}) and host({{dst_ip}});"' })],
      empty: [],
    },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    created_by: 'admin', modified_by: 'admin', is_system: false,
  },
];

async function mockLoggedInAdmin(page) {
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
  });
  await page.route('**/api/me', route =>
    route.fulfill({
      json: { username: 'admin', upn: 'admin', handle: 'admin', role: 'super_admin', isAdmin: true, isSuperAdmin: true, authMethod: 'local' },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: CATALOGS }));
  await page.route('**/api/commands', route => route.fulfill({ json: COMMANDS }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
}

// Semeia o localStorage ANTES da navegação (addInitScript) — os dois
// históricos (query-bar e sidebar search) só existem sob a chave
// '<prefix>:admin' (CURRENT_USER, ver useSearchHistory), já que /api/me só
// resolve depois do primeiro paint.
async function seedHistory(page, storageKey, entries) {
  await page.addInitScript(
    ([key, data]) => localStorage.setItem(key, JSON.stringify(data)),
    [storageKey, entries]
  );
}

const browser = await chromium.launch();

// ── Cenário 1: digitar "key:value key2:value2" + Enter cria tags e filtra os comandos ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const input = page.locator('.cpq-input');
  await input.click();
  await input.fill('src_ip:10.0.0.1 dst_ip:10.0.0.2');
  await input.press('Enter');
  assert((await page.locator('.cpq-tag').count()) === 2, 'cenário 1: Enter criou 2 tags (uma por campo:valor reconhecido)');
  const tagTexts = await page.locator('.cpq-tag-txt').allInnerTexts();
  assert(tagTexts.includes('src_ip:10.0.0.1') && tagTexts.includes('dst_ip:10.0.0.2'), 'cenário 1: texto das tags é o "campo:valor" completo');
  await assertEventually(
    async () => {
      const t = await page.locator('.card[data-cmd-id="1"] .term').innerText();
      return t.includes('10.0.0.1') && t.includes('10.0.0.2');
    },
    'cenário 1: valores das tags aparecem no comando renderizado (debounce de 120ms)'
  );
  await page.screenshot({ path: `${SHOTS}/1-tags-created.png` });
});

// ── Cenário 2: editar uma tag salva a linha completa ANTIGA no histórico antes de aplicar a mudança ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const input = page.locator('.cpq-input');
  await input.click();
  await input.fill('src_ip:10.0.0.1 dst_ip:10.0.0.2');
  await input.press('Enter');
  await page.waitForSelector('.cpq-tag', { timeout: 2000 });

  // Clica no TEXTO da primeira tag (src_ip) para editar. O campo de edição
  // nasce preenchido com a tag INTEIRA ("src_ip:10.0.0.1", não só o valor —
  // mesmo comportamento do original, `input.value = queryTags[idx]` em
  // startEditQueryTag), então retipar só o valor (sem o prefixo "src_ip:")
  // trocaria o campo, não só o valor — por isso a tag nova precisa do
  // prefixo de novo.
  await page.locator('.cpq-tag-txt').first().click();
  const editInput = page.locator('.cpq-tag-edit-input');
  await editInput.waitFor({ state: 'visible' });
  assert((await editInput.inputValue()) === 'src_ip:10.0.0.1', 'cenário 2: campo de edição nasce preenchido com a tag completa ("campo:valor")');
  await editInput.fill('src_ip:10.0.0.99');
  await editInput.press('Enter');

  await assertEventually(
    async () => (await page.locator('.cpq-tag-txt').allInnerTexts()).includes('src_ip:10.0.0.99'),
    'cenário 2: valor da tag editada foi aplicado (src_ip:10.0.0.99)'
  );

  // Reabre o painel (o commit de edição fecha o painel via blur) para ver o histórico.
  await input.click();
  await page.waitForSelector('.cpq-panel.open');
  const historyTexts = await page.locator('.cpq-history-item-txt').allInnerTexts();
  assert(
    historyTexts.includes('src_ip:10.0.0.1 dst_ip:10.0.0.2'),
    'cenário 2: histórico contém a linha COMPLETA antiga (com o valor antigo de src_ip), não só o campo alterado'
  );
  await page.screenshot({ path: `${SHOTS}/2-tag-edit-history.png` });
});

// ── Cenário 3: remover uma tag re-aplica a filtragem e salva a linha completa antiga no histórico ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const input = page.locator('.cpq-input');
  await input.click();
  await input.fill('src_ip:10.0.0.1 dst_ip:10.0.0.2');
  await input.press('Enter');
  await assertEventually(async () => (await page.locator('.card[data-cmd-id="1"] .term').innerText()).includes('10.0.0.2'), 'cenário 3: pré-condição — dst_ip aplicado');

  await page.locator('.cpq-tag-x').nth(1).click(); // remove a tag dst_ip
  assert((await page.locator('.cpq-tag').count()) === 1, 'cenário 3: remover a tag (X) deixa só 1 tag');
  await assertEventually(
    async () => !(await page.locator('.card[data-cmd-id="1"] .term').innerText()).includes('10.0.0.2'),
    'cenário 3: comando renderizado não contém mais o valor removido (re-filtrado)'
  );

  await input.click();
  await page.waitForSelector('.cpq-panel.open');
  const historyTexts = await page.locator('.cpq-history-item-txt').allInnerTexts();
  assert(
    historyTexts.includes('src_ip:10.0.0.1 dst_ip:10.0.0.2'),
    'cenário 3: histórico contém a linha completa como estava ANTES da remoção'
  );
  await page.screenshot({ path: `${SHOTS}/3-remove-tag-history.png` });
});

// ── Cenário 4: a linha fixa de 8 chips insere "campo:" no input ao clicar ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const input = page.locator('.cpq-input');
  await input.click();
  await page.waitForSelector('.cpq-panel.open');
  assert((await page.locator('.cpq-chips .cpq-chip-flat[data-field]').count()) === 8, 'cenário 4: 8 chips fixos renderizados (todos os 8 existem no catálogo)');

  await page.locator('.cpq-chips .cpq-chip-flat[data-field="host"]').click();
  assert((await input.inputValue()) === 'host:', 'cenário 4: clicar no chip "Host" insere "host:" no campo');
  await page.screenshot({ path: `${SHOTS}/4-fixed-chip-insert.png` });
});

// ── Cenário 5: "Others:" abre a lista completa, filtra por digitação (typeahead) enquanto não há ':', e para de filtrar assim que ':' aparece ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const input = page.locator('.cpq-input');
  await input.click();
  await page.waitForSelector('.cpq-panel.open');

  assert(!(await page.isVisible('.cpq-chips-others.open')), 'cenário 5: painel "Others" começa fechado');
  await page.locator('.cpq-chip-others').click();
  await page.waitForSelector('.cpq-chips-others.open');
  assert((await page.locator('.cpq-chips-others .cpq-chip').count()) === 9, 'cenário 5: "Others" mostra TODOS os 9 parâmetros do catálogo (não só os fora da linha fixa)');

  await input.fill('sig');
  await assertEventually(
    async () => (await page.locator('.cpq-chips-others .cpq-chip').count()) === 1,
    'cenário 5: digitar "sig" filtra a lista "Others" para só o parâmetro que bate (Signature)'
  );
  assert((await page.locator('.cpq-chips-others .cpq-chip').first().innerText()) === 'Signature', 'cenário 5: chip restante é "Signature"');

  await input.fill('sig:algo');
  await assertEventually(
    async () => (await page.locator('.cpq-chips-others .cpq-chip').count()) === 9,
    'cenário 5: assim que aparece \':\' o typeahead para (campo já escolhido, agora digitando o valor) — lista volta a mostrar todos'
  );
  await page.screenshot({ path: `${SHOTS}/5-others-typeahead.png` });
});

// ── Cenário 6: colar uma linha com vários "campo:valor" confirma várias tags de uma vez ──
await withPage(
  browser,
  async page => {
    await mockLoggedInAdmin(page);
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.card[data-cmd-id="1"]');
    await page.evaluate(() => navigator.clipboard.writeText('src_ip:172.16.0.1 dst_ip:172.16.0.2'));
    const input = page.locator('.cpq-input');
    await input.click();
    await page.keyboard.press('ControlOrMeta+V');
    await assertEventually(async () => (await page.locator('.cpq-tag').count()) === 2, 'cenário 6: colar um texto com 2 campo:valor reconhecidos confirma 2 tags de uma vez');
    assert((await input.inputValue()) === '', 'cenário 6: campo de digitação fica vazio depois do paste múltiplo (tudo virou tag)');
    await page.screenshot({ path: `${SHOTS}/6-paste-multiple.png` });
  },
  { clipboard: true }
);

// ── Cenário 7: Backspace com o campo vazio remove a última tag ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const input = page.locator('.cpq-input');
  await input.click();
  await input.fill('src_ip:10.0.0.1 dst_ip:10.0.0.2');
  await input.press('Enter');
  await page.waitForSelector('.cpq-tag');
  assert((await page.locator('.cpq-tag').count()) === 2, 'cenário 7: pré-condição — 2 tags confirmadas');

  await input.click(); // campo vazio, com foco
  await page.keyboard.press('Backspace');
  assert((await page.locator('.cpq-tag').count()) === 1, 'cenário 7: Backspace com o campo vazio removeu a última tag (dst_ip)');
  const remaining = await page.locator('.cpq-tag-txt').first().innerText();
  assert(remaining === 'src_ip:10.0.0.1', 'cenário 7: a tag restante é a primeira (src_ip), não a removida');
  await page.screenshot({ path: `${SHOTS}/7-backspace-remove.png` });
});

// ── Cenário 8: histórico agrupado por dia; clicar numa entrada MESCLA os campos na busca atual sem duplicar ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  const now = Date.now();
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
  await seedHistory(page, 'cpa-query-history:admin', [
    { text: 'user:alice', ts: now - 60000 },
    { text: 'src_ip:9.9.9.9', ts: twoDaysAgo },
  ]);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  const input = page.locator('.cpq-input');
  await input.click();
  await page.waitForSelector('.cpq-panel.open');

  assert((await page.locator('.cpq-history-day').count()) === 2, 'cenário 8: 2 entradas em dias diferentes (hoje / 2 dias atrás) viram 2 grupos');
  const dayHeads = await page.locator('.cpq-history-day-head span').first().allInnerTexts();
  assert(dayHeads.length > 0, 'cenário 8: cabeçalho do grupo de dia renderizado');

  // Cria as tags atuais (dst_ip + src_ip com um valor DIFERENTE do histórico).
  await input.fill('dst_ip:5.5.5.5 src_ip:1.1.1.1');
  await input.press('Enter');
  await page.waitForSelector('.cpq-tag');
  await input.click();
  await page.waitForSelector('.cpq-panel.open');

  // Clica na entrada de histórico "src_ip:9.9.9.9" — deve SUBSTITUIR o
  // valor de src_ip (sem duplicar) e preservar dst_ip intacto.
  await page.locator('.cpq-history-item', { hasText: 'src_ip:9.9.9.9' }).click();
  await assertEventually(async () => (await page.locator('.cpq-tag').count()) === 2, 'cenário 8: aplicar a entrada do histórico não duplica o campo src_ip (continua 2 tags)');
  const finalTags = await page.locator('.cpq-tag-txt').allInnerTexts();
  assert(finalTags.includes('src_ip:9.9.9.9'), 'cenário 8: src_ip foi atualizado para o valor do histórico');
  assert(finalTags.includes('dst_ip:5.5.5.5'), 'cenário 8: dst_ip (campo diferente) foi preservado');
  assert(!finalTags.includes('src_ip:1.1.1.1'), 'cenário 8: valor antigo de src_ip não sobrou como tag duplicada');
  await page.screenshot({ path: `${SHOTS}/8-history-merge.png` });
});

// ── Cenário 9: a caixa de busca da sidebar tem histórico PRÓPRIO (chave separada), e clicar numa entrada SUBSTITUI o texto inteiro ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await seedHistory(page, 'cpa-cmdsearch-history:admin', [{ text: 'handshake', ts: Date.now() - 60000 }]);
  // Chave DIFERENTE da query-bar, com uma entrada que NÃO deve aparecer na
  // caixa de busca da sidebar (prova de isolamento entre os dois históricos).
  await seedHistory(page, 'cpa-query-history:admin', [{ text: 'src_ip:1.2.3.4', ts: Date.now() - 60000 }]);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');

  const searchInput = page.locator('.cmd-search-wrap .cmd-search');
  await searchInput.click();
  await page.waitForSelector('.cmd-search-wrap .cpq-panel.open');
  const sidebarHistoryTexts = await page.locator('.cmd-search-wrap .cpq-history-item-txt').allInnerTexts();
  assert(sidebarHistoryTexts.includes('handshake'), 'cenário 9: histórico da caixa de busca da sidebar mostra sua própria entrada');
  assert(!sidebarHistoryTexts.includes('src_ip:1.2.3.4'), 'cenário 9: histórico da sidebar NÃO mostra entradas do histórico da query-bar (chaves separadas)');

  await page.locator('.cmd-search-wrap .cpq-history-item', { hasText: 'handshake' }).click();
  await assertEventually(async () => (await searchInput.inputValue()) === 'handshake', 'cenário 9: clicar na entrada SUBSTITUI o texto de busca inteiro');
  await assertEventually(async () => page.isVisible('.card[data-cmd-id="1"]'), 'cenário 9: busca "handshake" mantém o comando 1 visível (bate no nome)');
  await page.screenshot({ path: `${SHOTS}/9-sidebar-history-separate.png` });
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
