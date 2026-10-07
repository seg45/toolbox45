// Suíte de validação manual (Playwright) da Fase 3, fatia 6 (Links pessoais
// + Tools/IP Calculator + Sharing + Groups) — mesmo padrão de mocking de
// /api/* usado em test/folders5c.spec.mjs (route() por endpoint, sem
// backend real rodando; fixtures em memória mutáveis com contadores `calls`
// pra verificar quantas vezes um endpoint foi chamado). Cobre: dropdown
// "Links" do header (listar/cache/criar/editar/excluir/validação/exclusão
// mútua com "Tools"), dropdown "Tools" → IP Calculator (resultado padrão ao
// abrir, cálculo de rede conhecida, "move to" split/supernet/mesmo prefixo,
// IP inválido, fechar só pelo "✕", estado sobrevive a fechar/reabrir),
// Sharing na aba "User account" (listar given/received numa chamada só,
// validação, criar com e-mail normalizado pra minúsculas, revogar), e
// Groups na aba "Groups" (gate super_admin, listar, buscar client-side,
// criar, abrir "Manage group", adicionar/remover membro recarregando o
// picker sem cache, renomear, excluir).
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
// FIXTURES / MOCKS BASE
// ════════════════════════════════════════════════
const CATALOGS = { vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [] };

// Mocka só o necessário pro AppShell/CommandsContent montarem sem travar
// (ver fetchCatalogs/fetchCommands/fetchFolders chamados no mount) — nenhum
// cenário desta fatia depende de comandos/pastas reais.
async function mockBase(page, { isSuperAdmin = true } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
  });
  await page.route('**/api/me', route =>
    route.fulfill({
      json: {
        username: 'admin', upn: 'admin',
        role: isSuperAdmin ? 'super_admin' : 'user',
        isAdmin: isSuperAdmin, isSuperAdmin, authMethod: 'local',
      },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: CATALOGS }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
  await page.route('**/api/commands', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    return route.continue();
  });
  await page.route('**/api/folders', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    return route.continue();
  });
}

async function goToApp(page) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.hdr-tools-group');
}

// ── Links ────────────────────────────────────────────────────────────────
function makeLinksState(initial) {
  let links = initial.map(l => ({ ...l }));
  let nextId = 100;
  const calls = { list: 0, create: [], update: [], delete: [] };
  return {
    calls,
    list() {
      calls.list++;
      return links.map(l => ({ ...l }));
    },
    create(payload) {
      const link = { id: nextId++, name: payload.name, url: payload.url };
      links.push(link);
      calls.create.push(payload);
      return link;
    },
    update(id, payload) {
      const l = links.find(x => x.id === id);
      if (!l) return null;
      l.name = payload.name;
      l.url = payload.url;
      calls.update.push({ id, payload });
      return l;
    },
    remove(id) {
      const idx = links.findIndex(x => x.id === id);
      if (idx < 0) return false;
      links.splice(idx, 1);
      calls.delete.push(id);
      return true;
    },
  };
}

async function mockLinks(page, state) {
  await page.route('**/api/links', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: state.list() });
    if (method === 'POST') {
      const body = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: state.create(body) });
    }
    return route.continue();
  });
  await page.route('**/api/links/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const method = route.request().method();
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      const l = state.update(id, body);
      if (!l) return route.fulfill({ status: 404, json: { message: 'Not found.' } });
      return route.fulfill({ json: l });
    }
    if (method === 'DELETE') {
      state.remove(id);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
}

const LINKS_FIXTURE = [
  { id: 1, name: 'Check Point SmartConsole', url: 'https://example.com/smartconsole' },
  { id: 2, name: 'TAC Portal', url: 'https://example.com/tac-portal' },
];

function linksGroup(page) {
  return page.locator('.hdr-tools-group > div.dd').nth(0);
}
function toolsGroup(page) {
  return page.locator('.hdr-tools-group > div.dd').nth(1);
}

// ── Shares ───────────────────────────────────────────────────────────────
function makeSharesState(given, received) {
  let g = given.map(x => ({ ...x }));
  let r = received.map(x => ({ ...x }));
  let nextId = 100;
  const calls = { list: 0, create: [], delete: [] };
  return {
    calls,
    get() {
      calls.list++;
      return { given: g.map(x => ({ ...x })), received: r.map(x => ({ ...x })) };
    },
    create(payload) {
      const share = { id: nextId++, grantee_email: payload.email, share_folders: payload.share_folders, share_commands: payload.share_commands };
      g.push(share);
      calls.create.push(payload);
      return share;
    },
    remove(id) {
      const idx = g.findIndex(x => x.id === id);
      if (idx >= 0) g.splice(idx, 1);
      calls.delete.push(id);
    },
  };
}

async function mockShares(page, state) {
  await page.route('**/api/shares', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: state.get() });
    if (method === 'POST') {
      const body = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: state.create(body) });
    }
    return route.continue();
  });
  await page.route('**/api/shares/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    if (route.request().method() === 'DELETE') {
      state.remove(id);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
}

async function openUserAccountPane(page) {
  await page.click('.hdr-user');
  await page.click('text=User account');
  await page.waitForSelector('.settings-modal-box');
}

// ── Groups ───────────────────────────────────────────────────────────────
function makeGroupsState(initial) {
  let groups = initial.map(g => ({ ...g, members: g.members.slice() }));
  let nextId = 100;
  const calls = { list: 0, create: [], rename: [], delete: [], addMember: [], removeMember: [] };
  return {
    calls,
    list() {
      calls.list++;
      return groups.map(g => ({ ...g, members: g.members.slice() }));
    },
    create(name) {
      const group = { id: nextId++, name, members: [] };
      groups.push(group);
      calls.create.push(name);
      return group;
    },
    rename(id, name) {
      const g = groups.find(x => x.id === id);
      if (!g) return null;
      g.name = name;
      calls.rename.push({ id, name });
      return g;
    },
    remove(id) {
      const idx = groups.findIndex(x => x.id === id);
      if (idx >= 0) groups.splice(idx, 1);
      calls.delete.push(id);
    },
    addMember(id, username) {
      const g = groups.find(x => x.id === id);
      if (!g) return null;
      if (!g.members.includes(username)) g.members.push(username);
      calls.addMember.push({ id, username });
      return g;
    },
    removeMember(id, username) {
      const g = groups.find(x => x.id === id);
      if (!g) return null;
      g.members = g.members.filter(u => u !== username);
      calls.removeMember.push({ id, username });
      return g;
    },
  };
}

function makeUsersState(usernames) {
  const calls = { list: 0 };
  return {
    calls,
    list() {
      calls.list++;
      return usernames.map(u => ({ username: u }));
    },
  };
}

async function mockGroups(page, groupsState, usersState) {
  await page.route('**/api/groups', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: groupsState.list() });
    if (method === 'POST') {
      const body = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: groupsState.create(body.name) });
    }
    return route.continue();
  });
  await page.route('**/api/groups/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const method = route.request().method();
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      const g = groupsState.rename(id, body.name);
      if (!g) return route.fulfill({ status: 404, json: { message: 'Not found.' } });
      return route.fulfill({ json: { id: g.id, name: g.name } });
    }
    if (method === 'DELETE') {
      groupsState.remove(id);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
  await page.route('**/api/groups/*/members', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      const g = groupsState.addMember(id, body.username);
      if (!g) return route.fulfill({ status: 404, json: { message: 'Not found.' } });
      return route.fulfill({ json: { members: g.members } });
    }
    return route.continue();
  });
  await page.route('**/api/groups/*/members/*', route => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const id = Number(parts[3]);
    const username = decodeURIComponent(parts[5]);
    if (route.request().method() === 'DELETE') {
      groupsState.removeMember(id, username);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
  await page.route('**/api/users', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: usersState.list() });
    return route.continue();
  });
}

async function openGroupsPane(page) {
  await page.click('.theme-toggle[title="Settings"]');
  await page.waitForSelector('.settings-modal-box');
  await page.locator('.settings-nav-btn', { hasText: 'Groups' }).click();
}

// ── IP Calculator ────────────────────────────────────────────────────────
function ipcOverlay(page) {
  return page.locator('.modal-overlay', { has: page.locator('.modal-title', { hasText: 'IP Calculator' }) });
}
async function openIpCalc(page) {
  await toolsGroup(page).locator('button[title="Tools"]').click();
  await toolsGroup(page).locator('.dd-panel .sb-row', { hasText: 'IP Calc' }).click();
  await page.waitForSelector('.modal-overlay.show .modal-wide');
}
function ipcAddressInput(page) {
  return ipcOverlay(page).locator('input[placeholder="192.168.0.1"]');
}
function ipcMaskInput(page) {
  return ipcOverlay(page).locator('input[placeholder="24 or 255.255.255.0"]');
}
function ipcMoveToInput(page) {
  return ipcOverlay(page).locator('input[placeholder="25 or 255.255.255.128"]');
}
function ipcCalcBtn(page) {
  return ipcOverlay(page).locator('.ipc-calc-btn');
}
function ipcResultGroup(page) {
  return ipcOverlay(page).locator('.set-group', { has: page.locator('.set-label', { hasText: 'Result' }) });
}

const browser = await chromium.launch();

// ════════════════════════════════════════════════
// LINKS (header)
// ════════════════════════════════════════════════

// ── Cenário 1: abrir o dropdown "Links" → GET /api/links carrega a lista ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeLinksState(LINKS_FIXTURE);
  await mockLinks(page, state);
  await goToApp(page);

  await linksGroup(page).locator('button[title="Links"]').click();
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  assert(state.calls.list === 1, 'cenário 1: GET /api/links foi chamado uma vez ao abrir o dropdown');
  const rows = linksGroup(page).locator('.dd-panel .lk-row');
  assert((await rows.count()) === 2, 'cenário 1: os 2 links do mock aparecem na lista');
  assert((await rows.nth(0).locator('.lk-row-name').innerText()) === 'Check Point SmartConsole', 'cenário 1: primeiro link mostra o nome certo');
  assert((await rows.nth(1).locator('.lk-row-name').innerText()) === 'TAC Portal', 'cenário 1: segundo link mostra o nome certo');
});

// ── Cenário 2: reabrir o dropdown NÃO re-chama GET /api/links (cache) ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeLinksState(LINKS_FIXTURE);
  await mockLinks(page, state);
  await goToApp(page);

  const btn = linksGroup(page).locator('button[title="Links"]');
  await btn.click(); // abre #1 — dispara fetch
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  await btn.click(); // fecha
  await btn.click(); // abre #2 — não deveria disparar fetch de novo
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  assert(state.calls.list === 1, 'cenário 2: GET /api/links continua em 1 chamada depois de abrir/fechar/abrir de novo');
});

// ── Cenário 3: "Add link" cria um link novo e aparece na lista ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeLinksState(LINKS_FIXTURE);
  await mockLinks(page, state);
  await goToApp(page);

  await linksGroup(page).locator('button[title="Links"]').click();
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  await linksGroup(page).locator('.dd-panel .lk-add-row').click();

  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Add link' }) });
  await modal.waitFor();
  assert(await modal.locator('button', { hasText: 'Add' }).isVisible(), 'cenário 3: modal "Add link" tem o botão "Add"');
  await modal.locator('input').nth(0).fill('Grafana');
  await modal.locator('input').nth(1).fill('https://grafana.example.com');
  await modal.locator('.btn-primary').click();

  await assertEventually(() => state.calls.create.length === 1, 'cenário 3: POST /api/links foi chamado');
  assert(
    state.calls.create[0].name === 'Grafana' && state.calls.create[0].url === 'https://grafana.example.com',
    'cenário 3: o payload enviado tem o Name/URL certos'
  );
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 3: o modal fecha depois de salvar');

  // Reabre o dropdown pra confirmar que o novo link já está lá — e que isso
  // veio do merge local (handleLinkSaved), não de um novo GET /api/links.
  await linksGroup(page).locator('button[title="Links"]').click();
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  const rows = linksGroup(page).locator('.dd-panel .lk-row');
  assert((await rows.count()) === 3, 'cenário 3: o novo link aparece na lista (3 links agora)');
  assert(await linksGroup(page).locator('.dd-panel .lk-row', { hasText: 'Grafana' }).isVisible(), 'cenário 3: "Grafana" está na lista');
  assert(state.calls.list === 1, 'cenário 3: reabrir o dropdown não disparou um novo GET /api/links');
});

// ── Cenário 4: editar um link existente (✎) ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeLinksState(LINKS_FIXTURE);
  await mockLinks(page, state);
  await goToApp(page);

  await linksGroup(page).locator('button[title="Links"]').click();
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  const tacRow = linksGroup(page).locator('.dd-panel .lk-row', { hasText: 'TAC Portal' });
  await tacRow.hover(); // .lk-row-actions só é visível no hover (ver components.css)
  await tacRow.locator('button[title="Edit"]').click();

  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Edit link' }) });
  await modal.waitFor();
  assert(await modal.locator('button', { hasText: 'Save' }).isVisible(), 'cenário 4: modal "Edit link" tem o botão "Save"');
  assert((await modal.locator('input').nth(0).inputValue()) === 'TAC Portal', 'cenário 4: campo Name vem pré-preenchido');
  assert((await modal.locator('input').nth(1).inputValue()) === 'https://example.com/tac-portal', 'cenário 4: campo URL vem pré-preenchido');

  await modal.locator('input').nth(0).fill('TAC Portal (EMEA)');
  await modal.locator('.btn-primary').click();

  await assertEventually(() => state.calls.update.length === 1, 'cenário 4: PUT /api/links/:id foi chamado');
  assert(state.calls.update[0].id === 2, 'cenário 4: o id correto (2) foi enviado no PUT');
  assert(state.calls.update[0].payload.name === 'TAC Portal (EMEA)', 'cenário 4: o novo nome foi enviado no PUT');

  await linksGroup(page).locator('button[title="Links"]').click();
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  assert(await linksGroup(page).locator('.dd-panel .lk-row', { hasText: 'TAC Portal (EMEA)' }).isVisible(), 'cenário 4: a lista reflete o nome atualizado');
});

// ── Cenário 5: excluir um link (✕) com confirmação ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeLinksState(LINKS_FIXTURE);
  await mockLinks(page, state);
  await goToApp(page);

  await linksGroup(page).locator('button[title="Links"]').click();
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  const tacRow = linksGroup(page).locator('.dd-panel .lk-row', { hasText: 'TAC Portal' });
  await tacRow.hover(); // .lk-row-actions só é visível no hover (ver components.css)
  await tacRow.locator('button[title="Delete"]').click();

  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  assert(msg === 'Delete the link "TAC Portal"?', `cenário 5: a confirmação usa a mensagem exata esperada (lida: "${msg}")`);
  await page.locator('#confirmOkBtn').click();

  await assertEventually(() => state.calls.delete.includes(2), 'cenário 5: DELETE /api/links/2 foi chamado');
  // O clique em "#confirmOkBtn" (portal em document.body, fora de
  // toolsGroupRef) aciona o listener de "clique fora" do Header e fecha o
  // dropdown de Links sozinho — comportamento real do app (ver useEffect de
  // onDocClick em Header.tsx), não um bug desta suíte. Reabre pra conferir
  // o resultado, sem disparar um novo GET /api/links (cache já carregado).
  await assertEventually(async () => (await linksGroup(page).locator('.dd-panel').count()) === 0, 'cenário 5: o dropdown fecha sozinho ao confirmar (clique fora, portal em document.body)');
  await linksGroup(page).locator('button[title="Links"]').click();
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  await assertEventually(async () => (await linksGroup(page).locator('.dd-panel .lk-row').count()) === 1, 'cenário 5: o link some da lista');
  assert(!(await linksGroup(page).locator('.dd-panel .lk-row', { hasText: 'TAC Portal' }).isVisible()), 'cenário 5: "TAC Portal" não aparece mais');
  assert(state.calls.list === 1, 'cenário 5: reabrir o dropdown não disparou um novo GET /api/links');
});

// ── Cenário 6: validação — Name ou URL vazio bloqueia o submit ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeLinksState(LINKS_FIXTURE);
  await mockLinks(page, state);
  await goToApp(page);

  await linksGroup(page).locator('button[title="Links"]').click();
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  await linksGroup(page).locator('.dd-panel .lk-add-row').click();

  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'Add link' }) });
  await modal.waitFor();
  // Nem Name nem URL preenchidos.
  await modal.locator('.btn-primary').click();
  await assertEventually(
    async () => (await modal.locator('.set-hint', { hasText: 'Name and URL are required.' }).count()) === 1,
    'cenário 6: submeter sem Name/URL mostra "Name and URL are required."'
  );
  assert(state.calls.create.length === 0, 'cenário 6: nenhum POST /api/links foi disparado');

  // Só Name preenchido, URL ainda vazia.
  await modal.locator('input').nth(0).fill('Algo');
  await modal.locator('.btn-primary').click();
  await assertEventually(
    async () => (await modal.locator('.set-hint', { hasText: 'Name and URL are required.' }).count()) === 1,
    'cenário 6: submeter só com Name (sem URL) também mostra o erro'
  );
  assert(state.calls.create.length === 0, 'cenário 6: ainda nenhum POST /api/links foi disparado');
});

// ── Cenário 7: "Links" e "Tools" nunca ficam abertos ao mesmo tempo ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeLinksState(LINKS_FIXTURE);
  await mockLinks(page, state);
  await goToApp(page);

  await linksGroup(page).locator('button[title="Links"]').click();
  await page.waitForSelector('.hdr-tools-group .dd-panel');
  assert((await linksGroup(page).locator('.dd-panel').count()) === 1, 'cenário 7: o painel de Links está visível depois de abri-lo');

  await toolsGroup(page).locator('button[title="Tools"]').click();
  await assertEventually(async () => (await toolsGroup(page).locator('.dd-panel').count()) === 1, 'cenário 7: o painel de Tools abre');
  assert((await linksGroup(page).locator('.dd-panel').count()) === 0, 'cenário 7: o painel de Links não está mais visível depois de abrir Tools');
});

// ════════════════════════════════════════════════
// TOOLS / IP CALCULATOR
// ════════════════════════════════════════════════

// ── Cenário 8: abrir "IP Calc" já mostra um resultado padrão calculado ──
await withPage(browser, async page => {
  await mockBase(page);
  await goToApp(page);
  await openIpCalc(page);

  assert((await ipcAddressInput(page).inputValue()) === '192.168.0.1', 'cenário 8: Address já vem preenchido com 192.168.0.1');
  assert((await ipcMaskInput(page).inputValue()) === '24', 'cenário 8: Netmask já vem preenchida com 24');
  const resultText = await ipcResultGroup(page).innerText();
  assert(resultText.includes('192.168.0.0/24'), `cenário 8: a seção Result mostra a rede 192.168.0.0/24 (lido: ${resultText})`);
  assert(resultText.includes('Class C'), 'cenário 8: a seção Result mostra "Class C"');
});

// ── Cenário 9: calcular uma rede conhecida (10.0.0.5/255.255.255.0) ──
await withPage(browser, async page => {
  await mockBase(page);
  await goToApp(page);
  await openIpCalc(page);

  await ipcAddressInput(page).fill('10.0.0.5');
  await ipcMaskInput(page).fill('255.255.255.0');
  await ipcCalcBtn(page).click();

  const resultText = await ipcResultGroup(page).innerText();
  assert(resultText.includes('10.0.0.0/24'), `cenário 9: Network calculada corretamente (lido: ${resultText})`);
  assert(resultText.includes('10.0.0.255'), 'cenário 9: Broadcast calculado corretamente');
  assert(resultText.includes('10.0.0.1') , 'cenário 9: HostMin calculado corretamente');
  assert(resultText.includes('10.0.0.254'), 'cenário 9: HostMax calculado corretamente');
});

// ── Cenário 10: "Move to" com prefixo maior → split em múltiplos blocos ──
await withPage(browser, async page => {
  await mockBase(page);
  await goToApp(page);
  await openIpCalc(page);

  await ipcAddressInput(page).fill('192.168.1.0');
  await ipcMaskInput(page).fill('24');
  await ipcMoveToInput(page).fill('26');
  await ipcCalcBtn(page).click();

  const subnetsGroup = ipcOverlay(page).locator('.set-group', { has: page.locator('.set-label', { hasText: /^Subnets/ }) });
  await subnetsGroup.waitFor();
  assert(await subnetsGroup.locator('.set-label', { hasText: 'Subnets (4)' }).isVisible(), 'cenário 10: o rótulo mostra "Subnets (4)"');
  assert((await subnetsGroup.locator('.ipc-block').count()) === 4, 'cenário 10: aparecem 4 blocos de sub-rede');
  const subnetsText = await subnetsGroup.innerText();
  for (const cidr of ['192.168.1.0/26', '192.168.1.64/26', '192.168.1.128/26', '192.168.1.192/26']) {
    assert(subnetsText.includes(cidr), `cenário 10: o bloco ${cidr} aparece no resultado`);
  }
});

// ── Cenário 11: "Move to" com prefixo menor → Supernet ──
await withPage(browser, async page => {
  await mockBase(page);
  await goToApp(page);
  await openIpCalc(page);

  await ipcAddressInput(page).fill('192.168.1.0');
  await ipcMaskInput(page).fill('24');
  await ipcMoveToInput(page).fill('23');
  await ipcCalcBtn(page).click();

  const supernetGroup = ipcOverlay(page).locator('.set-group', { has: page.locator('.set-label', { hasText: 'Supernet' }) });
  await supernetGroup.waitFor();
  const text = await supernetGroup.innerText();
  assert(text.includes('192.168.0.0/23'), `cenário 11: o rótulo "Supernet" mostra a rede mais larga 192.168.0.0/23 (lido: ${text})`);
});

// ── Cenário 12: "Move to" com o MESMO prefixo da máscara ──
await withPage(browser, async page => {
  await mockBase(page);
  await goToApp(page);
  await openIpCalc(page);

  await ipcAddressInput(page).fill('192.168.1.0');
  await ipcMaskInput(page).fill('24');
  await ipcMoveToInput(page).fill('24');
  await ipcCalcBtn(page).click();

  await assertEventually(
    async () => (await ipcResultGroup(page).innerText()).includes('Same prefix as the netmask above — nothing to move to.'),
    'cenário 12: a nota "Same prefix as the netmask above — nothing to move to." aparece'
  );
});

// ── Cenário 13: IP inválido mostra erro inline sem travar a UI ──
await withPage(browser, async page => {
  await mockBase(page);
  await goToApp(page);
  await openIpCalc(page);

  await ipcAddressInput(page).fill('abc');
  await ipcCalcBtn(page).click();

  await assertEventually(
    async () => (await ipcOverlay(page).locator('.set-hint', { hasText: 'Invalid IP address.' }).count()) === 1,
    'cenário 13: IP inválido mostra "Invalid IP address."'
  );
  assert(await ipcOverlay(page).locator('.modal-close').isVisible(), 'cenário 13: a UI do modal continua funcional (não travou)');
});

// ── Cenário 14: fechar o modal — clicar fora do overlay NÃO fecha ──
await withPage(browser, async page => {
  await mockBase(page);
  await goToApp(page);
  await openIpCalc(page);

  await page.mouse.click(5, 5);
  await page.waitForTimeout(150);
  assert(await ipcOverlay(page).evaluate(el => el.classList.contains('show')), 'cenário 14: clicar fora do modal NÃO fecha (classe "show" permanece)');

  await ipcOverlay(page).locator('.modal-close').click();
  await assertEventually(
    async () => !(await ipcOverlay(page).evaluate(el => el.classList.contains('show'))),
    'cenário 14: clicar no "✕" fecha o modal'
  );
});

// ── Cenário 15: reabrir o modal preserva os valores digitados antes ──
await withPage(browser, async page => {
  await mockBase(page);
  await goToApp(page);
  await openIpCalc(page);

  await ipcAddressInput(page).fill('172.16.5.5');
  await ipcMaskInput(page).fill('16');
  await ipcCalcBtn(page).click();
  await ipcOverlay(page).locator('.modal-close').click();
  await assertEventually(
    async () => !(await ipcOverlay(page).evaluate(el => el.classList.contains('show'))),
    'cenário 15: modal fechado antes de reabrir'
  );

  await openIpCalc(page);
  assert((await ipcAddressInput(page).inputValue()) === '172.16.5.5', 'cenário 15: Address continua com o valor digitado antes');
  assert((await ipcMaskInput(page).inputValue()) === '16', 'cenário 15: Netmask continua com o valor digitado antes');
});

// ════════════════════════════════════════════════
// SHARING (aba "User account")
// ════════════════════════════════════════════════

const SHARES_FIXTURE_GIVEN = [
  { id: 1, grantee_email: 'bob@example.com', share_folders: true, share_commands: false },
  { id: 2, grantee_email: 'carol@example.com', share_folders: false, share_commands: true },
];
const SHARES_FIXTURE_RECEIVED = [{ id: 3, grantor_email: 'dave@example.com', share_folders: true, share_commands: true }];

// ── Cenário 16: aba "User account" mostra os 3 sub-blocos de Sharing ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeSharesState(SHARES_FIXTURE_GIVEN, SHARES_FIXTURE_RECEIVED);
  await mockShares(page, state);
  await goToApp(page);
  await openUserAccountPane(page);

  const content = page.locator('.settings-content');
  assert(await content.locator('.set-label', { hasText: 'Share with someone' }).isVisible(), 'cenário 16: bloco "Share with someone" visível');
  assert(await content.locator('.set-label', { hasText: 'Shared by you' }).isVisible(), 'cenário 16: bloco "Shared by you" visível');
  assert(await content.locator('.set-label', { hasText: 'Shared with you' }).isVisible(), 'cenário 16: bloco "Shared with you" visível');

  const givenTable = content.locator('.audit-log-table').nth(0);
  await assertEventually(async () => (await givenTable.locator('tbody tr').count()) === 2, 'cenário 16: tabela "Shared by you" mostra os 2 itens do mock');
  const bobRow = givenTable.locator('tr', { hasText: 'bob' });
  assert((await bobRow.locator('td').nth(1).innerText()) === '✓', 'cenário 16: "bob" mostra ✓ em Folders');
  assert((await bobRow.locator('td').nth(2).innerText()) === '—', 'cenário 16: "bob" mostra — em Commands');

  const receivedTable = content.locator('.audit-log-table').nth(1);
  await assertEventually(async () => (await receivedTable.locator('tbody tr').count()) === 1, 'cenário 16: tabela "Shared with you" mostra o 1 item do mock');
  assert((await receivedTable.locator('tr', { hasText: 'dave' }).locator('td').nth(1).innerText()) === '✓', 'cenário 16: "dave" mostra ✓ em Folders');
});

// ── Cenário 17: validação — nenhum checkbox marcado bloqueia o Share ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeSharesState(SHARES_FIXTURE_GIVEN, SHARES_FIXTURE_RECEIVED);
  await mockShares(page, state);
  await goToApp(page);
  await openUserAccountPane(page);

  const content = page.locator('.settings-content');
  await content.locator('input[placeholder="Their e-mail"]').fill('erin@example.com');
  await content.locator('button', { hasText: 'Share' }).click();

  await assertEventually(
    async () => (await content.locator('.set-hint', { hasText: 'Choose Folders and/or Commands to share.' }).count()) === 1,
    'cenário 17: erro "Choose Folders and/or Commands to share." aparece'
  );
  assert(state.calls.create.length === 0, 'cenário 17: nenhum POST /api/shares foi disparado');
});

// ── Cenário 17b: "Share" fica sempre ativo; com e-mail vazio só foca o campo; não existe mais "Your handle" ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeSharesState(SHARES_FIXTURE_GIVEN, SHARES_FIXTURE_RECEIVED);
  await mockShares(page, state);
  await goToApp(page);
  await openUserAccountPane(page);

  const content = page.locator('.settings-content');
  const shareBtn = content.locator('button', { hasText: 'Share' });
  assert(await shareBtn.isEnabled(), 'cenário 17b: botão "Share" ativo mesmo com o campo vazio');
  await shareBtn.click();
  assert(
    await content.locator('input[placeholder="Their e-mail"]').evaluate(el => el === document.activeElement),
    'cenário 17b: clicar em "Share" com e-mail vazio foca o campo'
  );
  assert(state.calls.create.length === 0, 'cenário 17b: nenhum POST /api/shares com e-mail vazio');
  assert(
    (await content.locator('.set-label', { hasText: 'Your handle' }).count()) === 0 && (await content.locator('code').count()) === 0,
    'cenário 17b: o campo "Your handle" não existe mais'
  );
});

// ── Cenário 18: e-mail em MAIÚSCULAS é enviado em minúsculas ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeSharesState(SHARES_FIXTURE_GIVEN, SHARES_FIXTURE_RECEIVED);
  await mockShares(page, state);
  await goToApp(page);
  await openUserAccountPane(page);

  const content = page.locator('.settings-content');
  await content.locator('input[placeholder="Their e-mail"]').fill('ERIN@Example.com');
  await content.locator('label.set-check-row', { hasText: 'Folders' }).locator('input[type="checkbox"]').check();
  await content.locator('button', { hasText: 'Share' }).click();

  await assertEventually(() => state.calls.create.length === 1, 'cenário 18: POST /api/shares foi chamado');
  assert(
    JSON.stringify(state.calls.create[0]) === JSON.stringify({ email: 'erin@example.com', share_folders: true, share_commands: false }),
    `cenário 18: payload normaliza o e-mail pra minúsculas (lido: ${JSON.stringify(state.calls.create[0])})`
  );
});

// ── Cenário 19: "Revoke" numa linha de "Shared by you" ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeSharesState(SHARES_FIXTURE_GIVEN, SHARES_FIXTURE_RECEIVED);
  await mockShares(page, state);
  await goToApp(page);
  await openUserAccountPane(page);

  const content = page.locator('.settings-content');
  const givenTable = content.locator('.audit-log-table').nth(0);
  await givenTable.locator('tr', { hasText: 'bob' }).locator('button', { hasText: 'Revoke' }).click();

  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  assert(
    msg === 'Stop sharing with "bob@example.com"? They will immediately lose access to whatever you shared with them.',
    `cenário 19: mensagem de confirmação exata (lida: "${msg}")`
  );
  await page.locator('#confirmOkBtn').click();

  await assertEventually(() => state.calls.delete.includes(1), 'cenário 19: DELETE /api/shares/1 foi chamado');
});

// ── Cenário 20: GET /api/shares é chamado só UMA vez ao abrir a aba ──
await withPage(browser, async page => {
  await mockBase(page);
  const state = makeSharesState(SHARES_FIXTURE_GIVEN, SHARES_FIXTURE_RECEIVED);
  await mockShares(page, state);
  await goToApp(page);
  await openUserAccountPane(page);

  await page.waitForSelector('.audit-log-table');
  await assertEventually(() => state.calls.list === 1, 'cenário 20: GET /api/shares foi chamado exatamente uma vez');
});

// ════════════════════════════════════════════════
// GROUPS (aba "Groups", super_admin-only)
// ════════════════════════════════════════════════

const GROUPS_FIXTURE = [
  { id: 1, name: 'NGFW Support', members: ['alice@example.com', 'bob@example.com'] },
  { id: 2, name: 'VSX Team', members: ['carol@example.com'] },
];
const USERS_FIXTURE = ['alice@example.com', 'bob@example.com', 'carol@example.com', 'dave@example.com', 'erin@example.com'];

// ── Cenário 21: sem super_admin, a aba "Groups" não aparece ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: false });
  await goToApp(page);

  await page.click('.theme-toggle[title="Settings"]');
  await page.waitForSelector('.settings-modal-box');
  assert((await page.locator('.settings-nav-btn', { hasText: 'Groups' }).count()) === 0, 'cenário 21: botão "Groups" não aparece na navegação');
  assert((await page.locator('.settings-pane[data-pane="groups"]').count()) === 0, 'cenário 21: o conteúdo da aba Groups não é alcançável');
});

// ── Cenário 22: com super_admin, "Groups" carrega a lista ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true });
  const groupsState = makeGroupsState(GROUPS_FIXTURE);
  const usersState = makeUsersState(USERS_FIXTURE);
  await mockGroups(page, groupsState, usersState);
  await goToApp(page);

  await openGroupsPane(page);
  await assertEventually(() => groupsState.calls.list === 1, 'cenário 22: GET /api/groups foi chamado');
  const rows = page.locator('.settings-pane[data-pane="groups"] tbody tr');
  await assertEventually(async () => (await rows.count()) === 2, 'cenário 22: os 2 grupos do mock aparecem na lista');
  assert(await page.locator('.settings-pane[data-pane="groups"] tr', { hasText: 'NGFW Support' }).isVisible(), 'cenário 22: "NGFW Support" aparece na lista');
});

// ── Cenário 23: busca por nome filtra client-side (sem nova chamada) ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true });
  const groupsState = makeGroupsState(GROUPS_FIXTURE);
  const usersState = makeUsersState(USERS_FIXTURE);
  await mockGroups(page, groupsState, usersState);
  await goToApp(page);

  await openGroupsPane(page);
  const rows = page.locator('.settings-pane[data-pane="groups"] tbody tr');
  await assertEventually(async () => (await rows.count()) === 2, 'cenário 23: lista inicial com 2 grupos');

  await page.locator('input[placeholder="Search by group name…"]').fill('vsx');
  await assertEventually(async () => (await rows.count()) === 1, 'cenário 23: busca "vsx" filtra pra 1 grupo');
  assert(await page.locator('.settings-pane[data-pane="groups"] tr', { hasText: 'VSX Team' }).isVisible(), 'cenário 23: o grupo que sobrou é "VSX Team"');
  assert(groupsState.calls.list === 1, 'cenário 23: a busca não disparou um novo GET /api/groups');
});

// ── Cenário 24: "New group" cria um grupo ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true });
  const groupsState = makeGroupsState(GROUPS_FIXTURE);
  const usersState = makeUsersState(USERS_FIXTURE);
  await mockGroups(page, groupsState, usersState);
  await goToApp(page);

  await openGroupsPane(page);
  await page.locator('.settings-pane[data-pane="groups"] button', { hasText: 'New group' }).click();

  const modal = page.locator('.modal-box', { has: page.locator('.modal-title', { hasText: 'New group' }) });
  await modal.waitFor();
  await modal.locator('button', { hasText: 'Create' }).click();
  await assertEventually(
    async () => (await modal.locator('.set-hint', { hasText: 'Name is required.' }).count()) === 1,
    'cenário 24: nome vazio mostra "Name is required."'
  );
  assert(groupsState.calls.create.length === 0, 'cenário 24: nenhum POST /api/groups foi disparado ainda');

  await modal.locator('input').fill('Maestro Team');
  await modal.locator('button', { hasText: 'Create' }).click();

  await assertEventually(() => groupsState.calls.create.includes('Maestro Team'), 'cenário 24: POST /api/groups foi chamado com o nome certo');
  await assertEventually(async () => (await modal.count()) === 0, 'cenário 24: o modal fecha depois de criar');
  await assertEventually(
    async () => (await page.locator('.settings-pane[data-pane="groups"] tr', { hasText: 'Maestro Team' }).count()) === 1,
    'cenário 24: "Maestro Team" aparece na lista'
  );
});

// ── Cenário 25: clicar numa linha abre "Manage group" ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true });
  const groupsState = makeGroupsState(GROUPS_FIXTURE);
  const usersState = makeUsersState(USERS_FIXTURE);
  await mockGroups(page, groupsState, usersState);
  await goToApp(page);

  await openGroupsPane(page);
  await page.locator('.settings-pane[data-pane="groups"] tr', { hasText: 'NGFW Support' }).click();

  const modal = page.locator('.group-panel');
  await modal.waitFor();
  assert((await modal.locator('.modal-title').innerText()) === 'Manage group — NGFW Support', 'cenário 25: título "Manage group — NGFW Support"');
  await assertEventually(async () => (await modal.locator('table tbody tr').count()) === 2, 'cenário 25: lista de membros mostra os 2 membros do grupo');
});

// ── Cenário 26: "add member" dentro de "Manage group" ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true });
  const groupsState = makeGroupsState(GROUPS_FIXTURE);
  const usersState = makeUsersState(USERS_FIXTURE);
  await mockGroups(page, groupsState, usersState);
  await goToApp(page);

  await openGroupsPane(page);
  await page.locator('.settings-pane[data-pane="groups"] tr', { hasText: 'NGFW Support' }).click();
  const modal = page.locator('.group-panel');
  await modal.waitFor();

  await assertEventually(() => usersState.calls.list === 1, 'cenário 26: GET /api/users foi chamado ao abrir "Manage group"');
  const select = modal.locator('select');
  await assertEventually(async () => (await select.locator('option').count()) === 3, 'cenário 26: select lista os 3 usuários que ainda não são membros (carol/dave/erin)');
  const optionValues = await select.locator('option').evaluateAll(opts => opts.map(o => o.value));
  assert(
    JSON.stringify(optionValues) === JSON.stringify(['carol@example.com', 'dave@example.com', 'erin@example.com']),
    `cenário 26: as opções são exatamente os não-membros (lidas: ${JSON.stringify(optionValues)})`
  );

  await select.selectOption('dave@example.com');
  await modal.locator('.group-panel-row button', { hasText: 'Add member' }).click();

  await assertEventually(() => groupsState.calls.addMember.some(c => c.id === 1 && c.username === 'dave@example.com'), 'cenário 26: POST /api/groups/1/members foi chamado com {username: "dave@example.com"}');
  await assertEventually(async () => (await modal.locator('table tbody tr', { hasText: 'dave@example.com' }).count()) === 1, 'cenário 26: "dave@example.com" aparece na tabela de membros');
  await assertEventually(() => usersState.calls.list === 2, 'cenário 26: GET /api/users foi chamado de novo depois do add (recarrega sem cache)');
});

// ── Cenário 27: remover um membro ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true });
  const groupsState = makeGroupsState(GROUPS_FIXTURE);
  const usersState = makeUsersState(USERS_FIXTURE);
  await mockGroups(page, groupsState, usersState);
  await goToApp(page);

  await openGroupsPane(page);
  await page.locator('.settings-pane[data-pane="groups"] tr', { hasText: 'NGFW Support' }).click();
  const modal = page.locator('.group-panel');
  await modal.waitFor();

  await modal.locator('table tbody tr', { hasText: 'bob@example.com' }).locator('button', { hasText: 'Remove' }).click();
  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  assert(msg.includes('bob@example.com'), `cenário 27: a confirmação contém o username (lida: "${msg}")`);
  await page.locator('#confirmOkBtn').click();

  await assertEventually(() => groupsState.calls.removeMember.some(c => c.id === 1 && c.username === 'bob@example.com'), 'cenário 27: DELETE /api/groups/1/members/bob@example.com foi chamado');
  await assertEventually(async () => (await modal.locator('table tbody tr', { hasText: 'bob@example.com' }).count()) === 0, 'cenário 27: "bob@example.com" some da tabela');
});

// ── Cenário 28: renomear o grupo ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true });
  const groupsState = makeGroupsState(GROUPS_FIXTURE);
  const usersState = makeUsersState(USERS_FIXTURE);
  await mockGroups(page, groupsState, usersState);
  await goToApp(page);

  await openGroupsPane(page);
  await page.locator('.settings-pane[data-pane="groups"] tr', { hasText: 'NGFW Support' }).click();
  const modal = page.locator('.group-panel');
  await modal.waitFor();

  await modal.locator('input.set-input').first().fill('NGFW Support (EMEA)');
  await modal.locator('button', { hasText: 'Rename' }).click();

  await assertEventually(() => groupsState.calls.rename.some(c => c.id === 1 && c.name === 'NGFW Support (EMEA)'), 'cenário 28: PUT /api/groups/1 foi chamado com o nome novo');
  await assertEventually(async () => (await modal.locator('.modal-title').innerText()) === 'Manage group — NGFW Support (EMEA)', 'cenário 28: o título do modal reflete o novo nome');
});

// ── Cenário 29: excluir um grupo na lista principal ──
await withPage(browser, async page => {
  await mockBase(page, { isSuperAdmin: true });
  const groupsState = makeGroupsState(GROUPS_FIXTURE);
  const usersState = makeUsersState(USERS_FIXTURE);
  await mockGroups(page, groupsState, usersState);
  await goToApp(page);

  await openGroupsPane(page);
  await page.locator('.settings-pane[data-pane="groups"] tr', { hasText: 'VSX Team' }).locator('button[title="Delete group"]').click();

  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  assert(msg.includes('VSX Team'), `cenário 29: a confirmação contém o nome do grupo (lida: "${msg}")`);
  await page.locator('#confirmOkBtn').click();

  await assertEventually(() => groupsState.calls.delete.includes(2), 'cenário 29: DELETE /api/groups/2 foi chamado');
  await assertEventually(async () => (await page.locator('.settings-pane[data-pane="groups"] tr', { hasText: 'VSX Team' }).count()) === 0, 'cenário 29: "VSX Team" some da lista');
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
