// Suíte de validação manual (Playwright) da Fase 3, fatia 5b (Pastas —
// drag-and-drop + seletor de escopo cross-user) — mesmo padrão de mocking
// de /api/* usado em test/folders.spec.mjs (route() por endpoint, sem
// backend real rodando). Cobre: reordenar comandos dentro da mesma pasta,
// mover um comando pra uma subpasta (soltando no cabeçalho dela), mover uma
// subpasta inteira pra dentro de outra subpasta da MESMA árvore, recusar
// soltar um item fora da árvore de topo, trocar o escopo pra "All" (com
// agrupamento "👤 <username>" e poda de pasta vazia de outro usuário),
// trocar pra um usuário específico, buscar um usuário na caixa de busca do
// dropdown de escopo, copiar uma pasta de outro usuário, e confirmar que
// pastas de outro usuário nunca mostram alça de arrastar/controles de
// edição.
//
// Drag-and-drop real via HTML5 `draggable` é conhecido por ser delicado no
// Playwright (`page.dragAndDrop()`/mouse down-move-up nem sempre disparam
// os eventos nativos `dragstart`/`dragover`/`drop` de um elemento
// `draggable`) — aqui os eventos são disparados manualmente via
// `page.evaluate()` + `DataTransfer` (ver `simulateDrag()` abaixo), na
// mesma ordem que o próprio navegador dispararia (dragstart → dragover →
// drop → dragend), incluindo `clientY` calculado pra reproduzir "soltar
// antes/depois" de uma row. O `mousedown` na alça (que arma `draggable`,
// ver useFolderDrag.ts::armDrag) é disparado à parte, via
// `locator.dispatchEvent('mousedown')`, pra exercitar o handler React real
// (armDrag), não só simular o resultado dele.
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

function makeCommand(id, name, folderIds) {
  return {
    id, topic: 'status', topics: ['status'], folder_ids: folderIds, icon: null, sort_order: id,
    requires_ip_port: false, placeholder_resolver: null,
    name, name_empty: null, desc: `desc ${name}`, desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: [line({ prompt: '[Expert@FW]#', content: `echo ${id}` })], empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    created_by: 'admin', modified_by: 'admin', is_system: false,
  };
}

// Admin (usuário atual, logado em todos os cenários) é dono de:
//   1 Favorites   (cmd 1)
//   2 Toolbox     (cmd 2, cmd 3) — raiz usada pros cenários de drag
//     4 Nested      (subpasta de Toolbox, vazia — alvo de "mover pro cabeçalho")
//     5 NestedB     (subpasta de Toolbox, cmd 6 — movida inteira no cenário 3)
// bob (outro usuário) é dono de:
//   20 Bob's folder (cmd 7) — cross-user, copiável
//   21 Empty (bob)  (sem comandos) — nunca aparece (poda de pasta vazia de outro usuário)
const ADMIN_COMMANDS = [
  makeCommand(1, 'Fav command', [1]),
  makeCommand(2, 'Toolbox A', [2]),
  makeCommand(3, 'Toolbox B', [2]),
  makeCommand(6, 'Nested B command', [5]),
];
// command 7 só existe do lado de bob — folder_ids (por-usuário) fica vazio
// pra quem não é bob (mesmo critério do server-py real: folder_ids só
// reflete as pastas do usuário que está olhando a tela).
const BOB_COMMAND = { ...makeCommand(7, "Bob's command", []) };
const ALL_COMMANDS = [...ADMIN_COMMANDS, BOB_COMMAND];

function makeFolderState() {
  let folders = [
    { id: 1, name: 'Favorites', sort_order: 0, parent_id: null, command_ids: [1], order: [{ type: 'command', id: 1 }] },
    { id: 2, name: 'Toolbox', sort_order: 0, parent_id: null, command_ids: [2, 3], order: [{ type: 'command', id: 2 }, { type: 'command', id: 3 }] },
    { id: 4, name: 'Nested', sort_order: 0, parent_id: 2, command_ids: [], order: [] },
    { id: 5, name: 'NestedB', sort_order: 1, parent_id: 2, command_ids: [6], order: [{ type: 'command', id: 6 }] },
  ];
  // Pastas de bob — só entram em GET /api/folders/all, nunca em GET
  // /api/folders (essa continua 100% escopada ao usuário logado).
  const bobFolders = [
    { id: 20, name: "Bob's folder", username: 'bob', sort_order: 0, parent_id: null, command_ids: [7], order: [{ type: 'command', id: 7 }] },
    { id: 21, name: 'Empty (bob)', username: 'bob', sort_order: 0, parent_id: null, command_ids: [], order: [] },
  ];
  let nextId = 100;
  const calls = { reorder: [], move: [], addCommand: [], removeCommand: [], copy: [] };
  return {
    calls,
    list() {
      return folders.map(f => ({ ...f, command_ids: f.command_ids.slice(), order: f.order.slice() }));
    },
    listAll() {
      const own = folders.map(f => ({ ...f, username: 'admin', command_ids: f.command_ids.slice(), order: f.order.slice() }));
      const bob = bobFolders.map(f => ({ ...f, command_ids: f.command_ids.slice(), order: f.order.slice() }));
      return [...own, ...bob];
    },
    addCommand(folderId, cmdId) {
      calls.addCommand.push({ folderId, cmdId });
      const f = folders.find(x => x.id === folderId);
      if (!f) return;
      if (!f.command_ids.includes(cmdId)) {
        f.command_ids.push(cmdId);
        f.order.push({ type: 'command', id: cmdId });
      }
    },
    removeCommand(folderId, cmdId) {
      calls.removeCommand.push({ folderId, cmdId });
      const f = folders.find(x => x.id === folderId);
      if (!f) return;
      f.command_ids = f.command_ids.filter(id => id !== cmdId);
      f.order = f.order.filter(o => !(o.type === 'command' && o.id === cmdId));
    },
    reorder(folderId, order) {
      calls.reorder.push({ folderId, order });
      const f = folders.find(x => x.id === folderId);
      if (f) f.order = order.slice();
    },
    move(folderId, parentId) {
      calls.move.push({ folderId, parentId });
      const f = folders.find(x => x.id === folderId);
      if (f) f.parent_id = parentId;
      return { ok: true };
    },
    copy(folderId) {
      calls.copy.push({ folderId });
      const src = bobFolders.find(f => f.id === folderId);
      if (!src) return { status: 404 };
      const copied = { id: nextId++, name: src.name, sort_order: 0, parent_id: null, command_ids: src.command_ids.slice(), order: src.order.slice() };
      folders.push(copied);
      return { ok: true, body: copied };
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
        username: 'admin', upn: 'admin', role: 'super_admin',
        isAdmin: true, isSuperAdmin: true, authMethod: 'local',
      },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: CATALOGS }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
  await page.route('**/api/commands', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: ALL_COMMANDS });
    return route.continue();
  });
  await page.route('**/api/folders/all', route => route.fulfill({ json: state.listAll() }));
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
  await page.route('**/api/folders/*/reorder', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const body = route.request().postDataJSON();
    state.reorder(id, body.order);
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/folders/*/move', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const body = route.request().postDataJSON();
    state.move(id, body.parent_id);
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/folders/*/copy', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const r = state.copy(id);
    if (r.status) return route.fulfill({ status: r.status, json: { message: 'Not found.' } });
    return route.fulfill({ status: 201, json: r.body });
  });
  await page.route('**/api/folders', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: state.list() });
    return route.continue();
  });
  // SEM catch-all genérico `**/api/folders/*` aqui de propósito — rotas do
  // Playwright são checadas na ordem INVERSA de registro (a última
  // registrada tem prioridade), e `/api/folders/all` (endpoint real, só um
  // segmento) bate nesse mesmo glob de um segmento só; um catch-all
  // `route.continue()` registrado por último (logo, checado PRIMEIRO)
  // interceptaria `/api/folders/all` antes da rota específica acima
  // (`**/api/folders/all`, registrada mais cedo) nunca rodar — bug real
  // encontrado rodando esta suíte (a resposta virava o HTML do próprio
  // `index.html`, não o JSON esperado). PUT/DELETE em `/api/folders/:id`
  // solto (rename/delete) não são exercitados nesta suíte (5b é sobre
  // drag-and-drop + escopo; rename/delete já são cobertos em
  // test/folders.spec.mjs, fatia 5a) — sem necessidade de um catch-all.
}

// `data-folder-id` já fica no PRÓPRIO `.section` (não num wrapper extra —
// ver CollapsibleSection.tsx::rootDataAttrs), então o cabeçalho é filho
// DIRETO do elemento com esse atributo.
function folderHeaderById(page, id) {
  return page.locator(`[data-folder-id="${id}"]`).locator(':scope > .sec-title').first();
}

function commandRow(page, cmdId) {
  return page.locator(`.folder-item-row[data-item-type="command"][data-item-id="${cmdId}"]`);
}

function folderRow(page, folderId) {
  return page.locator(`.folder-item-row[data-item-type="folder"][data-item-id="${folderId}"]`);
}

async function enterEditMode(page, rootFolderId) {
  const header = folderHeaderById(page, rootFolderId);
  await header.hover();
  await header.locator('.sec-folder-edit-btn').click();
  // Seletor COMPOSTO num único elemento (`[data-folder-id="X"].section-editing`,
  // sem espaço) — não um combinador de descendente (`[data-folder-id="X"]
  // .section-editing`, com espaço): desde a fatia 5b, os dois atributos
  // vivem no MESMO `<div class="section">` (ver CollapsibleSection.tsx::
  // rootDataAttrs), não mais num wrapper por fora dele — um seletor de
  // descendente nunca bateria aqui (esperaria dois elementos aninhados).
  await page.waitForSelector(`[data-folder-id="${rootFolderId}"].section-editing`);
}

// Dispara dragstart→dragover→drop→dragend "à mão" (ver comentário no topo
// do arquivo) — `handle` é o locator da alça (⠿) da row sendo arrastada;
// `target` é o locator do alvo (outra `.folder-item-row`, pra reordenar, ou
// um `[data-folder-header-id]`, pra mover pra dentro de uma pasta);
// `before` (só importa quando o alvo é uma row) decide se solta antes ou
// depois dela.
async function simulateDrag(page, handle, target, { before = true } = {}) {
  await handle.dispatchEvent('mousedown', { bubbles: true });
  const handleHandleJs = await handle.elementHandle();
  const targetHandleJs = await target.elementHandle();
  await page.evaluate(
    ({ handleEl, targetEl, before }) => {
      const row = handleEl.closest('.folder-item-row');
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      let clientY = 0;
      if (targetEl.classList.contains('folder-item-row')) {
        const rect = targetEl.getBoundingClientRect();
        clientY = before ? rect.top + 1 : rect.bottom - 1;
      }
      targetEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY }));
      targetEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { handleEl: handleHandleJs, targetEl: targetHandleJs, before }
  );
}

const browser = await chromium.launch();

// ── Cenário 1: reordenar dois comandos dentro da MESMA pasta ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');
  await enterEditMode(page, 2);

  // Toolbox tem, de saída, cmd2/cmd3 (direto em folder.order) + as
  // subpastas Nested (4)/NestedB (5), que entram no FIM por não terem
  // posição salva em folder.order (mesmo critério de "item sem posição
  // salva vai pro fim" — ver buildFolderNode/foldersPipeline.ts).
  const rowsBefore = await page.locator('[data-folder-body-id="2"] > .folder-item-row').evaluateAll(els => els.map(e => e.dataset.itemId));
  assert(rowsBefore.join(',') === '2,3,4,5', `cenário 1: ordem inicial de Toolbox é 2,3,4,5 (lida: ${rowsBefore.join(',')})`);

  await simulateDrag(page, commandRow(page, 3).locator('.folder-drag-handle'), commandRow(page, 2), { before: true });

  await assertEventually(async () => {
    const order = await page.locator('[data-folder-body-id="2"] > .folder-item-row').evaluateAll(els => els.map(e => e.dataset.itemId));
    return order.join(',') === '3,2,4,5';
  }, 'cenário 1: arrastar o comando 3 pra antes do 2 reordena a seção (DOM refletindo 3,2,4,5)');

  assert(state.calls.reorder.length >= 1, 'cenário 1: PUT /api/folders/2/reorder foi chamado');
  const lastReorder = state.calls.reorder[state.calls.reorder.length - 1];
  assert(lastReorder.folderId === 2, 'cenário 1: o reorder foi persistido na pasta certa (Toolbox, id 2)');
  assert(
    JSON.stringify(lastReorder.order) ===
      JSON.stringify([{ type: 'command', id: 3 }, { type: 'command', id: 2 }, { type: 'folder', id: 4 }, { type: 'folder', id: 5 }]),
    `cenário 1: a ordem persistida no servidor é [3,2,folder4,folder5] (lida: ${JSON.stringify(lastReorder.order)})`
  );
});

// ── Cenário 2: mover um comando pra uma subpasta (soltando no cabeçalho dela) ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');
  await enterEditMode(page, 2);

  assert(await page.locator('.sec-folder-empty-msg').first().isVisible(), 'cenário 2: "Nested" começa vazia ("Empty folder.")');

  const nestedHeader = page.locator('[data-folder-header-id="4"]');
  await simulateDrag(page, commandRow(page, 2).locator('.folder-drag-handle'), nestedHeader, {});

  await assertEventually(
    async () => (await page.locator('[data-folder-body-id="4"] .card[data-cmd-id="2"]').count()) === 1,
    'cenário 2: o comando 2 aparece dentro de "Nested" depois do drop no cabeçalho'
  );
  assert((await page.locator('[data-folder-body-id="2"] > .folder-item-row[data-item-id="2"]').count()) === 0, 'cenário 2: o comando 2 não é mais filho DIRETO de "Toolbox" (saiu de lá)');

  await assertEventually(() => state.calls.addCommand.some(c => c.folderId === 4 && c.cmdId === 2), 'cenário 2: POST /api/folders/4/commands/2 foi chamado (entrou em "Nested")');
  await assertEventually(() => state.calls.removeCommand.some(c => c.folderId === 2 && c.cmdId === 2), 'cenário 2: DELETE /api/folders/2/commands/2 foi chamado (saiu de "Toolbox")');
  await assertEventually(() => state.calls.reorder.some(c => c.folderId === 4), 'cenário 2: a ordem do destino ("Nested") foi persistida depois do move');

  // Card 2 fora da visão de Pastas: folder_ids do comando precisa refletir
  // a mudança (bug documentado no original — "continuo com problema para
  // movimentar os comandos dentro das pastas" — sem isso, o dropdown "Add
  // to folder" do próprio card continuaria mostrando "Toolbox" marcada).
  await page.locator('.folders-head-row').click(); // sai de Folders
  await page.waitForSelector('.card[data-cmd-id="2"]');
  await page.locator('.card[data-cmd-id="2"] .fav-btn').click();
  await page.waitForSelector('.card[data-cmd-id="2"] .folder-menu-pop.open');
  // `:text-is("Nested")` (match EXATO) em vez de `hasText: 'Nested'` —
  // "Toolbox" (pasta-mãe, com submenu) também contém o texto "Nested" na
  // sua própria subárvore (a subpasta "Nested" dentro dela), então um
  // `hasText` simples bateria em DOIS itens (Toolbox E Nested) e violaria
  // o modo estrito do Playwright; "NestedB" também começa com "Nested" mas
  // `:text-is` exige o texto INTEIRO igual, não um prefixo.
  const nestedChk = page.locator('.card[data-cmd-id="2"] .folder-menu-row:has(.folder-menu-name:text-is("Nested")) .folder-menu-chk');
  assert((await nestedChk.innerText()).trim() === '✓', 'cenário 2: o dropdown "Add to folder" do card 2 já mostra "Nested" marcada (cache de folder_ids atualizado)');
});

// ── Cenário 3: mover uma SUBPASTA inteira pra dentro de outra subpasta da MESMA árvore ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');
  // Checagem de nome ANTES de entrar em modo de edição — uma vez em
  // edição, o nome vira um <input> (ver FolderSection.tsx), então
  // `:has-text("NestedB")` deixaria de bater no texto do título.
  assert(await page.isVisible('.sec-title:has-text("NestedB")'), 'cenário 3: "NestedB" começa como subpasta direta de "Toolbox"');
  await enterEditMode(page, 2);

  const nestedHeader = page.locator('[data-folder-header-id="4"]');
  await simulateDrag(page, folderRow(page, 5).locator(':scope > .folder-drag-handle'), nestedHeader, {});

  await assertEventually(() => state.calls.move.some(c => c.folderId === 5 && c.parentId === 4), 'cenário 3: PUT /api/folders/5/move foi chamado com parent_id=4 ("Nested")');
  await assertEventually(async () => {
    const insideNested = await page.locator('[data-folder-id="4"] [data-folder-id="5"]').count();
    return insideNested === 1;
  }, 'cenário 3: "NestedB" aparece aninhada DENTRO de "Nested" depois do move (data-folder-id="5" dentro de data-folder-id="4")');
  assert(await page.locator('[data-folder-body-id="4"] .card[data-cmd-id="6"]').count() === 1, 'cenário 3: o comando 6 (dentro de NestedB) foi junto, continua acessível na nova posição');
});

// ── Cenário 4: nunca deixa soltar um item fora da árvore de topo ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');
  // Entra em modo de edição nas DUAS árvores de topo (Favorites e Toolbox)
  // — o mecanismo de drag por si só já recusa (rootFolderId diferente),
  // mas isso também exercita o caso em que as DUAS seções estão com a
  // alça de arrastar visível ao mesmo tempo.
  await enterEditMode(page, 1);
  await enterEditMode(page, 2);

  const favoritesHeader = page.locator('[data-folder-header-id="1"]');
  await simulateDrag(page, commandRow(page, 2).locator('.folder-drag-handle'), favoritesHeader, {});

  // Nada muda: nenhuma chamada de move/membership pra fora da árvore de
  // Toolbox, e o comando 2 continua filho direto de Toolbox no DOM.
  await page.waitForTimeout(200);
  assert(!state.calls.addCommand.some(c => c.folderId === 1 && c.cmdId === 2), 'cenário 4: soltar no cabeçalho de "Favorites" (outra árvore) NÃO adiciona o comando 2 lá');
  assert((await page.locator('[data-folder-body-id="2"] > .folder-item-row[data-item-id="2"]').count()) === 1, 'cenário 4: o comando 2 continua filho direto de "Toolbox" (não foi movido pra fora da árvore)');
});

// ── Cenário 5: pasta de outro usuário nunca mostra alça de arrastar/controles de edição ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  const ctbLabel = await page.locator('#folderScopeDD').count();
  assert(ctbLabel === 0, 'cenário 5 (sanidade): o dropdown de escopo não usa o id antigo #folderScopeDD (componente React próprio) — sempre 0 no port');

  await page.locator('.ctb-label', { hasText: 'Filter by' }).waitFor();
  await page.locator('.content-toolbar .dd-btn', { hasText: 'My folders' }).click();
  await page.locator('.dd-panel.seg .seg-btn', { hasText: 'bob' }).click();
  await page.waitForSelector('.sec-title:has-text("Bob\'s folder")');

  const bobHeader = page.locator('[data-folder-header-id="20"]');
  assert((await bobHeader.locator('.sec-folder-edit-btn').count()) === 0, 'cenário 5: pasta de bob não tem botão "✎ Edit folder"');
  assert((await bobHeader.locator('.sec-folder-add-btn').count()) === 0, 'cenário 5: pasta de bob não tem dropdown "+ Add"');
  assert(await bobHeader.locator('button[title="Copy this folder to your own Folders"]').isVisible(), 'cenário 5: pasta de bob mostra o botão "⧉ Copy" no lugar');
  assert((await page.locator('[data-folder-body-id="20"] .folder-drag-handle').count()) === 0, 'cenário 5: nenhum item dentro da pasta de bob tem alça de arrastar');
});

// ── Cenário 6: trocar o escopo pra "All" agrupa por dono e poda pasta vazia de outro usuário ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  await page.locator('.content-toolbar .dd-btn', { hasText: 'My folders' }).click();
  await page.locator('.dd-panel.seg .seg-btn', { hasText: 'All' }).click();

  await page.waitForSelector('.section-creator:has-text("admin")');
  assert(await page.isVisible('.section-creator:has-text("bob")'), 'cenário 6: grupo "👤 bob" aparece no escopo "All"');
  assert(await page.isVisible('.sec-title:has-text("Bob\'s folder")'), 'cenário 6: a pasta não-vazia de bob ("Bob\'s folder") aparece dentro do grupo dele');
  assert(!(await page.isVisible('.sec-title:has-text("Empty (bob)")')), 'cenário 6: a pasta VAZIA de bob ("Empty (bob)") é podada — nunca aparece em "All"');
  assert(await page.isVisible('.section-creator:has-text("admin") .sec-title:has-text("Toolbox")'), 'cenário 6: as próprias pastas do usuário atual (admin) também aparecem, agrupadas sob o próprio nome, dentro de "All"');
});

// ── Cenário 7: trocar pra um usuário específico mostra só as pastas dele, sem o agrupamento "👤" ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  await page.locator('.content-toolbar .dd-btn', { hasText: 'My folders' }).click();
  await page.locator('.dd-panel.seg .seg-btn', { hasText: 'bob' }).click();

  await page.waitForSelector('.sec-title:has-text("Bob\'s folder")');
  assert(!(await page.isVisible('.section-creator')), 'cenário 7: escopo "user:bob" não mostra o agrupamento "👤" (só faz sentido em "All")');
  assert(!(await page.isVisible('.sec-title:has-text("Toolbox")')), 'cenário 7: as pastas do usuário atual (admin) não aparecem no escopo de outro usuário específico');
  assert(await page.locator('.content-toolbar .dd-btn', { hasText: 'bob' }).isVisible(), 'cenário 7: o rótulo do dropdown de escopo mostra "bob"');
});

// ── Cenário 8: buscar um usuário na caixa de busca do dropdown de escopo ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  await page.locator('.content-toolbar .dd-btn', { hasText: 'My folders' }).click();
  await page.waitForSelector('.dd-panel .dd-search-input');
  await assertEventually(async () => page.isVisible('.dd-panel.seg .seg-btn >> text="bob"'), 'cenário 8: "bob" aparece na lista antes de buscar');

  await page.fill('.dd-panel .dd-search-input', 'zzz-no-match');
  await assertEventually(async () => !(await page.isVisible('.dd-panel.seg .seg-btn >> text="bob"')), 'cenário 8: busca sem resultado esconde "bob" da lista');

  await page.fill('.dd-panel .dd-search-input', 'BO');
  await assertEventually(async () => page.isVisible('.dd-panel.seg .seg-btn >> text="bob"'), 'cenário 8: busca case-insensitive ("BO") volta a mostrar "bob"');
  assert(await page.isVisible('.dd-panel.seg .seg-btn >> text="My folders"'), 'cenário 8: "My folders" continua visível durante a busca (não é um username, nunca é filtrado)');
});

// ── Cenário 9: copiar uma pasta de outro usuário — confirma e aparece nas próprias pastas ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');

  await page.locator('.content-toolbar .dd-btn', { hasText: 'My folders' }).click();
  await page.locator('.dd-panel.seg .seg-btn', { hasText: 'bob' }).click();
  await page.waitForSelector('.sec-title:has-text("Bob\'s folder")');

  await page.locator('[data-folder-header-id="20"] button[title="Copy this folder to your own Folders"]').click();
  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  assert(msg.includes('Copy folder "Bob\'s folder"'), 'cenário 9: a confirmação menciona o nome da pasta sendo copiada');
  await page.locator('#confirmOkBtn').click();

  await assertEventually(() => state.calls.copy.some(c => c.folderId === 20), 'cenário 9: POST /api/folders/20/copy foi chamado');

  await page.locator('.content-toolbar .dd-btn', { hasText: 'bob' }).click();
  await page.locator('.dd-panel.seg .seg-btn', { hasText: 'My folders' }).click();
  await assertEventually(() => page.isVisible(".sec-title:has-text(\"Bob's folder\")"), 'cenário 9: a pasta copiada aparece em "My folders" (mesmo nome do original)');
  const copiedHeader = page.locator('.sec-title:has-text("Bob\'s folder")').first();
  await copiedHeader.hover();
  assert(await copiedHeader.locator('.sec-folder-edit-btn').isVisible(), 'cenário 9: a pasta copiada é totalmente própria (tem botão "✎ Edit folder", diferente do original só-leitura)');
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
