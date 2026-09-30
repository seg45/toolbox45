// Suíte de validação manual (Playwright) da Fase 3, fatia 5a (Pastas —
// pastas básicas) — mesmo padrão de mocking de /api/* usado em
// test/commandeditor.spec.mjs (route() por endpoint, sem backend real
// rodando). Cobre: alternar a visão "Folders"/menu normal, subpastas
// aninhadas, criar pasta/subpasta, marcar/desmarcar um comando numa pasta,
// renomear (inline), excluir (com confirmação e cascata), a pasta
// "Favorites" (sem nome editável/exclusão mesmo em modo de edição) e o
// popover de auditoria do botão de pastas.
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
// FIXTURES
// ════════════════════════════════════════════════
const CATALOGS = {
  vendors: [],
  systems: [],
  versions: [],
  environments: [],
  topics: [{ key: 'status', label: 'Status', color: '#34D399', sort_order: 0, is_protected: 0 }],
  parameters: [],
  prompts: [],
  exports: [],
};

function line(overrides) {
  return { line_type: 'cmd', prompt: null, content: '', export_template: null, image_data: null, ...overrides };
}

// Comando 1 está em "Favorites" (folder_ids:[1]), comando 2 está em
// "Migrations" (folder_ids:[2]), comando 3 não está em nenhuma pasta —
// usado pra confirmar que a visão de Pastas de fato FILTRA (só mostra
// comandos com folder_ids.length).
const COMMANDS = [
  {
    id: 1, topic: 'status', topics: ['status'], folder_ids: [1], icon: null, sort_order: 0,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'Cluster status', name_empty: null, desc: 'Show HA state', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'cphaprob stat' })], empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-05T10:30:00Z',
    created_by: 'admin', modified_by: 'admin', is_system: false,
  },
  {
    id: 2, topic: 'status', topics: ['status'], folder_ids: [2], icon: null, sort_order: 1,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'Migration step', name_empty: null, desc: 'Some migration command', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'echo step' })], empty: [] },
    created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    created_by: 'admin', modified_by: 'admin', is_system: false,
  },
  {
    id: 3, topic: 'status', topics: ['status'], folder_ids: [], icon: null, sort_order: 2,
    requires_ip_port: false, placeholder_resolver: null,
    name: 'No folder command', name_empty: null, desc: 'Not in any folder', desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: 'echo hi' })], empty: [] },
    created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z',
    created_by: 'admin', modified_by: 'admin', is_system: false,
  },
];

// Estado mutável de pastas em memória — simula server-py/app/routers/
// folders.py o suficiente pra exercitar create/rename/delete/membership
// através de uma sessão de página inteira (cada cenário cria o seu próprio,
// isolado). Seed: "Favorites" (raiz, com o comando 1) + "Migrations" (raiz,
// com o comando 2) + "Step 1" (subpasta de Migrations, vazia) — dá pra
// testar aninhamento (cenário 3) e a exclusão em cascata (cenário 8) sem
// precisar criar nada antes.
function makeFolderState() {
  let folders = [
    { id: 1, name: 'Favorites', sort_order: 0, parent_id: null, command_ids: [1], order: [{ type: 'command', id: 1 }] },
    { id: 2, name: 'Migrations', sort_order: 0, parent_id: null, command_ids: [2], order: [{ type: 'command', id: 2 }] },
    { id: 3, name: 'Step 1', sort_order: 0, parent_id: 2, command_ids: [], order: [] },
  ];
  let nextId = 4;
  return {
    list() {
      return folders.map(f => ({ ...f, command_ids: f.command_ids.slice(), order: f.order.slice() }));
    },
    create(name, parentId) {
      const f = { id: nextId++, name, sort_order: 0, parent_id: parentId || null, command_ids: [], order: [] };
      folders.push(f);
      return { ...f };
    },
    rename(id, name) {
      const f = folders.find(x => x.id === id);
      if (!f) return { status: 404 };
      if (f.name === 'Favorites') return { status: 403 };
      f.name = name;
      return { ok: true, body: { id: f.id, name: f.name, sort_order: f.sort_order } };
    },
    remove(id) {
      const target = folders.find(x => x.id === id);
      if (!target) return { status: 404 };
      if (target.name === 'Favorites') return { status: 403 };
      const toRemove = new Set([id]);
      let changed = true;
      while (changed) {
        changed = false;
        folders.forEach(f => {
          if (f.parent_id != null && toRemove.has(f.parent_id) && !toRemove.has(f.id)) {
            toRemove.add(f.id);
            changed = true;
          }
        });
      }
      folders = folders.filter(f => !toRemove.has(f.id));
      return { ok: true };
    },
    addCommand(folderId, cmdId) {
      const f = folders.find(x => x.id === folderId);
      if (!f) return;
      if (!f.command_ids.includes(cmdId)) {
        f.command_ids.push(cmdId);
        f.order.push({ type: 'command', id: cmdId });
      }
    },
    removeCommand(folderId, cmdId) {
      const f = folders.find(x => x.id === folderId);
      if (!f) return;
      f.command_ids = f.command_ids.filter(id => id !== cmdId);
      f.order = f.order.filter(o => !(o.type === 'command' && o.id === cmdId));
    },
  };
}

async function mockLoggedInAdmin(page, state) {
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
    if (route.request().method() === 'GET') return route.fulfill({ json: COMMANDS });
    return route.continue();
  });
  await page.route('**/api/folders', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: state.list() });
    if (method === 'POST') {
      const body = route.request().postDataJSON();
      const f = state.create(body.name, body.parent_id);
      return route.fulfill({ status: 201, json: f });
    }
    return route.continue();
  });
  await page.route('**/api/folders/*/commands/*', route => {
    const method = route.request().method();
    const parts = new URL(route.request().url()).pathname.split('/');
    const folderId = Number(parts[3]);
    const cmdId = Number(parts[5]);
    if (method === 'POST') {
      state.addCommand(folderId, cmdId);
      return route.fulfill({ status: 204, body: '' });
    }
    if (method === 'DELETE') {
      state.removeCommand(folderId, cmdId);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
  await page.route('**/api/folders/*', route => {
    const method = route.request().method();
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      const r = state.rename(id, body.name);
      if (r.status) {
        return route.fulfill({
          status: r.status,
          json: { message: r.status === 403 ? 'The "Favorites" folder cannot be renamed.' : 'Not found.' },
        });
      }
      return route.fulfill({ json: r.body });
    }
    if (method === 'DELETE') {
      const r = state.remove(id);
      if (r.status) {
        return route.fulfill({
          status: r.status,
          json: { message: r.status === 403 ? 'The "Favorites" folder cannot be deleted.' : 'Not found.' },
        });
      }
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
}

// Seção INTEIRA (cabeçalho + corpo) de uma pasta pelo nome — só é seguro
// usar pra procurar CONTEÚDO do corpo (ex.: um .card dentro dela) numa
// pasta sem subpastas: como `.section.section-folder` está aninhado (uma
// subpasta é, ela mesma, uma `.section.section-folder` dentro do sec-body
// da pasta-mãe), este locator INCLUI as subpastas no seu escopo.
function folderSectionByName(page, name) {
  return page.locator('.section.section-folder', { has: page.locator('.sec-title', { hasText: name }) }).first();
}

// Só o CABEÇALHO (.sec-title) de uma pasta pelo nome — usado pra clicar/
// checar botões do próprio cabeçalho (chevron, ✎ Edit/Accept/Cancel/Delete,
// input de nome, dropdown "+ Add"). Ao contrário de folderSectionByName()
// acima, `.sec-title` NÃO aninha (o `.sec-title` de uma subpasta não é
// descendente do `.sec-title` da pasta-mãe, só do `.sec-body` dela) — então
// isto sempre resolve para um único elemento, mesmo quando a pasta tem
// subpastas com seus próprios botões (ex.: "Migrations" tem "Step 1"
// dentro; sem isso, `migrations.locator('.sec-chevron')` acharia DOIS
// chevrons — o da própria Migrations e o de Step 1 — e violaria o modo
// estrito do Playwright).
function folderHeaderByName(page, name) {
  return page.locator('.sec-title', { hasText: name }).first();
}

// Wrapper `<div data-folder-id="N">` de UMA pasta específica, por id (ver
// FolderSection.tsx) — único na página (ids não se repetem), ao contrário de
// nomes (que podem colidir com o próprio texto do input durante a edição).
function folderById(page, id) {
  return page.locator(`[data-folder-id="${id}"]`);
}

// Cabeçalho (.sec-title) de uma pasta por ID, escopado via
// `:scope > .section > .sec-title` — igual a folderHeaderByName(), mas
// imune a mudanças no texto (nome vira <input> em modo de edição) e sem
// depender do nome atual da pasta. É o jeito seguro de interagir com
// botões/inputs do PRÓPRIO cabeçalho (✎/Accept/Cancel/Delete/input de
// nome/dropdown "+ Add") sem colidir com os de uma subpasta aninhada, já
// que `.sec-title` nunca contém `.sec-body` (onde vivem as subpastas).
function folderHeaderById(page, id) {
  return folderById(page, id).locator(':scope > .section > .sec-title');
}

async function classListHas(locator, cls) {
  return locator.evaluate((el, c) => el.classList.contains(c), cls);
}

const browser = await chromium.launch();

// ── Cenário 1: clicar em "Folders" na sidebar mostra a visão de pastas FILTRADA ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  assert(await page.isVisible('.card[data-cmd-id="3"]'), 'cenário 1: comando sem pasta visível na visão normal (menu de comandos)');

  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');
  assert(await classListHas(page.locator('.folders-head-row'), 'on'), 'cenário 1: linha "Folders" marcada como ativa (.on)');
  assert(await page.isVisible('.card[data-cmd-id="1"]'), 'cenário 1: comando da pasta "Favorites" visível na visão de Pastas');
  assert(await page.isVisible('.card[data-cmd-id="2"]'), 'cenário 1: comando da pasta "Migrations" visível na visão de Pastas');
  assert(!(await page.isVisible('.card[data-cmd-id="3"]')), 'cenário 1: comando sem NENHUMA pasta não aparece na visão de Pastas');
});

// ── Cenário 2: clicar de novo volta pra visão normal ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  await page.locator('.folders-head-row').click();
  await assertEventually(async () => !(await classListHas(page.locator('.folders-head-row'), 'on')), 'cenário 2: clicar de novo desliga a classe "on" da linha "Folders"');
  assert(await page.isVisible('.card[data-cmd-id="3"]'), 'cenário 2: volta a mostrar o comando sem pasta (visão normal restaurada)');
});

// ── Cenário 3: uma pasta com subpasta renderiza a subpasta aninhada visualmente ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  assert(await page.isVisible('.sec-title:has-text("Migrations")'), 'cenário 3: seção "Migrations" visível');
  assert(await page.isVisible('.sec-title:has-text("Step 1")'), 'cenário 3: subpasta "Step 1" renderizada (aninhada dentro de Migrations)');

  // Colapsar "Migrations" também esconde "Step 1" — confirma que ela está
  // de fato DENTRO do sec-body da pasta-mãe, não uma seção solta ao lado.
  await folderHeaderByName(page, 'Migrations').locator('.sec-chevron').click();
  await assertEventually(async () => !(await page.isVisible('.sec-title:has-text("Step 1")')), 'cenário 3: colapsar "Migrations" esconde "Step 1" junto (confirma o aninhamento)');
});

// ── Cenário 4: "+ New folder" do menu de um card cria a pasta e já adiciona o comando a ela ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="3"]');

  await page.locator('.card[data-cmd-id="3"] .fav-btn').click();
  await page.waitForSelector('.card[data-cmd-id="3"] .folder-menu-pop.open');
  await page.locator('.card[data-cmd-id="3"] .folder-menu-new').click();
  await page.waitForSelector('.modal-overlay.show .modal-title:has-text("New folder")');
  await page.fill('.modal-overlay.show .set-input', 'Newly created');
  await page.locator('.modal-overlay.show .btn-primary').click();

  await assertEventually(
    async () => classListHas(page.locator('.card[data-cmd-id="3"] .fav-btn'), 'on'),
    'cenário 4: botão de pastas do card fica "on" (o comando entrou na pasta recém-criada)'
  );

  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');
  const newSection = folderSectionByName(page, 'Newly created');
  assert(await newSection.isVisible(), 'cenário 4: nova seção "Newly created" aparece na visão de Pastas');
  assert(await newSection.locator('.card[data-cmd-id="3"]').isVisible(), 'cenário 4: o comando 3 está dentro da nova pasta');
});

// ── Cenário 5: marcar/desmarcar um comando numa pasta existente pelo menu do card ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="2"]');

  await page.locator('.card[data-cmd-id="2"] .fav-btn').click();
  await page.waitForSelector('.card[data-cmd-id="2"] .folder-menu-pop.open');
  const favoritesItem = page.locator('.card[data-cmd-id="2"] .folder-menu-item', { hasText: 'Favorites' }).first();
  assert(!(await classListHas(favoritesItem, 'on')), 'cenário 5: comando 2 não está em "Favorites" inicialmente');

  await favoritesItem.locator('.folder-menu-row').click();
  await assertEventually(async () => classListHas(favoritesItem, 'on'), 'cenário 5: marcar "Favorites" no menu do card adiciona o comando à pasta');

  await favoritesItem.locator('.folder-menu-row').click();
  await assertEventually(async () => !(await classListHas(favoritesItem, 'on')), 'cenário 5: desmarcar "Favorites" no menu do card remove o comando da pasta');
});

// ── Cenário 6: criar uma subpasta pelo dropdown "+ Add" do cabeçalho de uma seção ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  const favoritesHeader = folderHeaderByName(page, 'Favorites');
  await favoritesHeader.locator('.sec-folder-add-btn').click();
  await favoritesHeader.locator('.sec-folder-add-dd .sb-row', { hasText: 'Subfolder' }).click();
  await page.waitForSelector('.modal-overlay.show .modal-title:has-text("New subfolder")');
  await page.fill('.modal-overlay.show .set-input', 'Sub A');
  await page.locator('.modal-overlay.show .btn-primary').click();

  await assertEventually(async () => page.isVisible('.sec-title:has-text("Sub A")'), 'cenário 6: nova subpasta "Sub A" aparece depois de criada pelo dropdown "+ Add"');
});

// ── Cenário 7: entrar em modo de edição, renomear uma pasta (Enter salva), sair do modo ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  // Migrations = pasta id 2 (seed de makeFolderState()) — usa-se
  // [data-folder-id="2"] pra escopar com precisão: uma vez em modo de
  // edição, a subpasta "Step 1" (id 3, DENTRO de Migrations) também herda
  // editMode e passa a ter seus próprios `.sec-folder-name-input`/
  // `.pill-accept`/`.sec-folder-edit-btn` — um locator por classe sem esse
  // escopo (ou por texto, que deixa de bater assim que o nome vira <input>)
  // violaria o modo estrito do Playwright.
  const migrationsHeader = folderHeaderById(page, 2);
  // `.sec-folder-actions` só fica visível no :hover do cabeçalho (ou já
  // dentro do modo de edição) — sem passar o mouse por cima primeiro, o
  // botão ✦ permanece `display:none` e o .click() do Playwright nunca
  // encontra um alvo pra mirar (nem consegue disparar o próprio hover).
  await migrationsHeader.hover();
  await migrationsHeader.locator('.sec-folder-edit-btn').click();
  await page.waitForSelector('.section.section-editing');

  // Em modo de edição o nome é um <input> (não mais texto) — o valor
  // renomeado só é conferível lendo o próprio input (`.sec-title:has-text`
  // não bate, já que o texto do título deixou de existir enquanto durar a
  // edição).
  const input = migrationsHeader.locator('.sec-folder-name-input');
  await input.fill('Migrations renamed');
  await input.press('Enter');
  await assertEventually(async () => (await input.inputValue()) === 'Migrations renamed', 'cenário 7: renomear com Enter salva o novo nome (conferido no valor do input, que segue em modo de edição)');

  await migrationsHeader.locator('.pill-accept').click();
  await assertEventually(async () => (await migrationsHeader.locator('.pill-accept').count()) === 0, 'cenário 7: "Accept" sai do modo de edição (botões somem)');
  assert(await migrationsHeader.locator('.sec-folder-edit-btn').isVisible(), 'cenário 7: o botão "✎ Edit folder" volta a aparecer fora do modo de edição');
  // `.sec-title` tem text-transform:uppercase (CSS) — innerText() reflete o
  // texto RENDERIZADO (maiúsculo), ao contrário de textContent(); por isso a
  // comparação é case-insensitive aqui, não porque o nome salvo mudou.
  assert((await migrationsHeader.innerText()).toLowerCase().includes('migrations renamed'), 'cenário 7: nome renomeado aparece como texto no cabeçalho, agora fora do modo de edição');
});

// ── Cenário 8: excluir uma pasta — confirmação aparece, cancelar mantém, confirmar remove (com cascata) ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  // Migrations = id 2, Step 1 (subpasta) = id 3 — ver comentário do cenário
  // 7 sobre por que `.pill-delete` precisa ser escopado ao cabeçalho
  // (folderHeaderById), não à seção inteira (que inclui a subpasta
  // aninhada e teria SEU PRÓPRIO `.pill-delete` uma vez em modo de edição).
  const migrationsHeader = folderHeaderById(page, 2);
  await migrationsHeader.hover();
  await migrationsHeader.locator('.sec-folder-edit-btn').click();
  await page.waitForSelector('.section.section-editing');
  await migrationsHeader.locator('.pill-delete').click();
  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  assert(msg.includes('Delete folder "Migrations"?'), 'cenário 8: mensagem de confirmação menciona o nome da pasta');
  assert(msg.includes('1 subfolder'), 'cenário 8: mensagem de confirmação avisa sobre a subpasta que será removida junto');

  await page.locator('#confirmOverlay .modal-foot .btn', { hasText: 'Cancel' }).click();
  assert((await folderById(page, 2).count()) === 1, 'cenário 8: cancelar a confirmação mantém a pasta');

  await migrationsHeader.locator('.pill-delete').click();
  await page.waitForSelector('#confirmOverlay.show');
  await page.locator('#confirmOkBtn').click();
  await assertEventually(async () => (await folderById(page, 2).count()) === 0, 'cenário 8: confirmar a exclusão remove a pasta');
  assert((await folderById(page, 3).count()) === 0, 'cenário 8: a subpasta "Step 1" também some junto (exclusão em cascata)');
});

// ── Cenário 9: "Favorites" não mostra nome editável nem botão excluir, mesmo em modo de edição ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  // Favorites = id 1 (sem subpastas no seed — nenhuma ambiguidade possível
  // aqui mesmo com folderSectionByName, mas usa-se o helper por ID por
  // consistência com os cenários 7/8).
  const favoritesHeader = folderHeaderById(page, 1);
  await favoritesHeader.hover();
  await favoritesHeader.locator('.sec-folder-edit-btn').click();
  await page.waitForSelector('.section.section-editing');
  assert(await favoritesHeader.locator('.pill-accept').isVisible(), 'cenário 9: "Favorites" mostra Accept/Cancel normalmente ao entrar em edição');
  assert((await favoritesHeader.locator('.sec-folder-name-input').count()) === 0, 'cenário 9: "Favorites" NÃO mostra nome editável mesmo em modo de edição');
  assert((await favoritesHeader.locator('.pill-delete').count()) === 0, 'cenário 9: "Favorites" NÃO mostra botão "Delete Folder" mesmo em modo de edição');
});

// ── Cenário 10: popover de auditoria (created by/modified by) aparece ao passar o mouse no botão de pastas ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');

  await page.locator('.card[data-cmd-id="1"] .fav-wrap').hover();
  await assertEventually(async () => page.isVisible('.card[data-cmd-id="1"] .fav-audit-pop'), 'cenário 10: popover de auditoria aparece ao passar o mouse sobre o botão de pastas do card');
  const text = await page.locator('.card[data-cmd-id="1"] .fav-audit-pop').innerText();
  assert(text.includes('Created by:') && text.includes('admin'), 'cenário 10: popover mostra "Created by" com o autor do comando');
  assert(text.includes('Modified on:'), 'cenário 10: popover mostra a data de modificação formatada');
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
