// Suíte de validação manual (Playwright) da Fase 3, fatia 5c (Notes dentro
// de pastas + Export/Import de pasta em Settings → Database) — mesmo padrão
// de mocking de /api/* usado em test/folders5b.spec.mjs (route() por
// endpoint, sem backend real rodando). Cobre: criar uma nota nova (editor
// aparece, digitar texto, negrito, Accept salva), editar uma nota existente,
// cancelar sem salvar, excluir (com confirmação), clonar, bloqueio de nota
// vazia, contagem no cabeçalho incluindo notas, arrastar uma nota pra
// reordenar dentro da mesma pasta, a aba Database (só grupo Folders, sem
// Commands/Backup), exportar uma pasta, importar um arquivo válido (resumo
// de contagem) e a mensagem de erro pra um arquivo inválido.
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

// admin (usuário atual) é dono de:
//   1 Favorites (cmd 1)
//   2 Toolbox   (cmd 2, cmd 3, note 50 "Existing note") — raiz usada pros
//     cenários de nota/drag
const COMMANDS = [makeCommand(1, 'Fav command', [1]), makeCommand(2, 'Toolbox A', [2]), makeCommand(3, 'Toolbox B', [2])];

function makeNote(id, folderId, description, sortOrder) {
  return {
    id, folder_id: folderId, username: 'admin', title: '', description, sort_order: sortOrder,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}

// Estado mutável de pastas+notas em memória — simula app_folders.py/
// routers_folders.py o suficiente pra exercitar create/update/delete/clone/
// move de nota, e export/import de pasta, através de uma sessão de página
// inteira (cada cenário cria o seu próprio, isolado).
function makeFolderState() {
  let notesById = new Map([[50, makeNote(50, 2, '<div>Existing note</div>', 2)]]);
  let folders = [
    { id: 1, name: 'Favorites', sort_order: 0, parent_id: null, command_ids: [1], order: [{ type: 'command', id: 1 }] },
    {
      id: 2, name: 'Toolbox', sort_order: 0, parent_id: null, command_ids: [2, 3],
      order: [{ type: 'command', id: 2 }, { type: 'command', id: 3 }, { type: 'note', id: 50 }],
    },
  ];
  let nextNoteId = 100;
  const calls = { createNote: [], updateNote: [], deleteNote: [], cloneNote: [], moveNote: [], reorder: [], export: [], import: [] };

  function notesOf(folderId) {
    return [...notesById.values()].filter(n => n.folder_id === folderId);
  }
  function folderRow(f) {
    return { ...f, command_ids: f.command_ids.slice(), order: f.order.slice(), notes: notesOf(f.id) };
  }

  return {
    calls,
    list() {
      return folders.map(folderRow);
    },
    createNote(folderId, title, description) {
      const f = folders.find(x => x.id === folderId);
      if (!f) return { status: 404 };
      const note = makeNote(nextNoteId++, folderId, description, notesOf(folderId).length + f.command_ids.length);
      note.title = title;
      notesById.set(note.id, note);
      f.order.push({ type: 'note', id: note.id });
      calls.createNote.push({ folderId, title, description });
      return { ok: true, body: note };
    },
    updateNote(noteId, title, description) {
      const n = notesById.get(noteId);
      if (!n) return { status: 404 };
      n.title = title;
      n.description = description;
      n.updated_at = '2026-01-02T00:00:00Z';
      calls.updateNote.push({ noteId, title, description });
      return { ok: true, body: n };
    },
    deleteNote(noteId) {
      const n = notesById.get(noteId);
      if (!n) return { status: 404 };
      notesById.delete(noteId);
      const f = folders.find(x => x.id === n.folder_id);
      if (f) f.order = f.order.filter(o => !(o.type === 'note' && o.id === noteId));
      calls.deleteNote.push({ noteId });
      return { ok: true };
    },
    cloneNote(noteId) {
      const src = notesById.get(noteId);
      if (!src) return { status: 404 };
      const note = makeNote(nextNoteId++, src.folder_id, src.description, notesOf(src.folder_id).length + 10);
      note.title = (src.title || '') + ' (copy)';
      notesById.set(note.id, note);
      const f = folders.find(x => x.id === src.folder_id);
      if (f) f.order.push({ type: 'note', id: note.id });
      calls.cloneNote.push({ noteId });
      return { ok: true, body: note };
    },
    moveNote(noteId, folderId) {
      const n = notesById.get(noteId);
      if (!n) return { status: 404 };
      const oldFolder = folders.find(x => x.id === n.folder_id);
      if (oldFolder) oldFolder.order = oldFolder.order.filter(o => !(o.type === 'note' && o.id === noteId));
      n.folder_id = folderId;
      calls.moveNote.push({ noteId, folderId });
      return { ok: true };
    },
    reorder(folderId, order) {
      calls.reorder.push({ folderId, order });
      const f = folders.find(x => x.id === folderId);
      if (f) f.order = order.slice();
    },
    exportFolder(folderId) {
      const f = folders.find(x => x.id === folderId);
      if (!f) return { status: 404 };
      calls.export.push({ folderId });
      return {
        ok: true,
        body: {
          type: 'toolbox45-folder-export', version: 1, exported_at: '2026-01-03T00:00:00Z',
          root: {
            name: f.name,
            notes: notesOf(f.id).map(n => ({ title: n.title, description: n.description, sort_order: n.sort_order })),
            commands: f.command_ids.map((id, i) => ({ sort_order: i, command: { name: `cmd${id}` } })),
            children: [],
          },
        },
      };
    },
    importFolder(tree, parentId) {
      calls.import.push({ tree, parentId });
      function count(node) {
        let folders = 1;
        let commands = (node.commands || []).length;
        let notesCount = (node.notes || []).length;
        (node.children || []).forEach(c => {
          if (!c || !c.folder) return;
          const sub = count(c.folder);
          folders += sub.folders; commands += sub.commands; notesCount += sub.notes;
        });
        return { folders, commands, notes: notesCount };
      }
      const c = count(tree);
      return { ok: true, body: { folders: c.folders, commands: c.commands, notes: c.notes, commandsFailed: 0 } };
    },
  };
}

async function mockLoggedInAdmin(page, state) {
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
  });
  await page.route('**/api/me', route =>
    route.fulfill({
      json: { username: 'admin', upn: 'admin', handle: 'admin', role: 'super_admin', isAdmin: true, isSuperAdmin: true, authMethod: 'local' },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: CATALOGS }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
  await page.route('**/api/commands', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: COMMANDS });
    return route.continue();
  });
  await page.route('**/api/folders', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: state.list() });
    return route.continue();
  });
  await page.route('**/api/folders/import', route => {
    const body = route.request().postDataJSON();
    const r = state.importFolder(body.tree, body.parent_id);
    return route.fulfill({ status: 201, json: r.body });
  });
  await page.route('**/api/folders/*/export', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const r = state.exportFolder(id);
    if (r.status) return route.fulfill({ status: r.status, json: { message: 'Not found.' } });
    return route.fulfill({ status: 200, json: r.body });
  });
  await page.route('**/api/folders/*/notes', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const body = route.request().postDataJSON();
    const r = state.createNote(id, body.title, body.description);
    if (r.status) return route.fulfill({ status: r.status, json: { message: 'Not found.' } });
    return route.fulfill({ status: 201, json: r.body });
  });
  await page.route('**/api/folders/*/reorder', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const body = route.request().postDataJSON();
    state.reorder(id, body.order);
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/notes/*/clone', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const r = state.cloneNote(id);
    if (r.status) return route.fulfill({ status: r.status, json: { message: 'Not found.' } });
    return route.fulfill({ status: 201, json: r.body });
  });
  await page.route('**/api/notes/*/move', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const body = route.request().postDataJSON();
    const r = state.moveNote(id, body.folder_id);
    if (r.status) return route.fulfill({ status: r.status, json: { message: 'Not found.' } });
    return route.fulfill({ status: 204, body: '' });
  });
  // `**/api/notes/*` (PUT update / DELETE) registrado POR ÚLTIMO — bateria
  // também em `.../clone`/`.../move` (glob `*` casa qualquer caractere
  // exceto `/`, então `50/clone` NÃO bate em `*` sozinho — ok), mas
  // Playwright prioriza o registro MAIS RECENTE quando duas rotas
  // colidiriam; aqui os padrões não se sobrepõem de verdade (`*` não cruza
  // `/`), então a ordem não importa, mas mantemos este por último por
  // clareza (mesmo padrão "mais específico primeiro" de folders5b.spec.mjs).
  await page.route('**/api/notes/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const method = route.request().method();
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      const r = state.updateNote(id, body.title, body.description);
      if (r.status) return route.fulfill({ status: r.status, json: { message: 'Not found.' } });
      return route.fulfill({ status: 200, json: r.body });
    }
    if (method === 'DELETE') {
      const r = state.deleteNote(id);
      if (r.status) return route.fulfill({ status: r.status, json: { message: 'Not found.' } });
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
}

function folderHeaderById(page, id) {
  return page.locator(`[data-folder-id="${id}"]`).locator(':scope > .sec-title').first();
}

async function enterEditMode(page, rootFolderId) {
  const header = folderHeaderById(page, rootFolderId);
  await header.hover();
  await header.locator('.sec-folder-edit-btn').click();
  await page.waitForSelector(`[data-folder-id="${rootFolderId}"].section-editing`);
}

async function openAddDropdown(page, folderId) {
  const header = folderHeaderById(page, folderId);
  await header.hover();
  await header.locator('.sec-folder-add-btn').click();
}

async function goToFolders(page) {
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="1"]');
  await page.locator('.folders-head-row').click();
  await page.waitForSelector('.section.section-folder');
}

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

// ── Cenário 1: criar uma nota nova (editor aparece, digitar, negrito, Accept salva) ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  // Cabeçalho de Toolbox começa em "3" (2 comandos + 1 nota existente) —
  // regra de negócio: a contagem inclui notas, só exclui subpastas.
  await assertEventually(async () => (await folderHeaderById(page, 2).locator('.sec-count').innerText()) === '3', 'cenário 1: cabeçalho de "Toolbox" começa em 3 (2 comandos + 1 nota)');

  await openAddDropdown(page, 2);
  await folderHeaderById(page, 2).locator('.dd-panel .sb-row', { hasText: 'Note' }).click();

  const draft = page.locator('[data-folder-body-id="2"] .card[data-note-editing="1"]');
  await draft.waitFor();
  // `.note-edit-label` é exibido com text-transform:uppercase via CSS —
  // innerText() reflete o texto RENDERIZADO ("NEW NOTE"), não o literal do
  // JSX ("New note"); comparação case-insensitive.
  assert((await draft.locator('.note-edit-label').innerText()).toLowerCase() === 'new note', 'cenário 1: o rascunho mostra o rótulo "New note"');

  const editorBody = draft.locator('.note-editor-body');
  await editorBody.click();
  await page.keyboard.type('Hello world');
  await page.keyboard.press('Control+a');
  await draft.locator('.ne-fmt-btn[data-ne-cmd="bold"]').click();
  assert(await draft.locator('.ne-fmt-btn[data-ne-cmd="bold"]').evaluate(el => el.classList.contains('on')), 'cenário 1: o botão Bold reflete "ativo" depois do clique (toolbar reage à formatação aplicada)');

  await draft.locator('.pill-accept').click();

  await assertEventually(() => state.calls.createNote.length === 1, 'cenário 1: POST /api/folders/2/notes foi chamado');
  assert(state.calls.createNote[0].description.includes('Hello world'), 'cenário 1: a descrição enviada ao servidor contém o texto digitado');
  await assertEventually(async () => (await page.locator('[data-folder-body-id="2"] .card[data-note-editing="1"]').count()) === 0, 'cenário 1: o card sai do modo de edição depois do Accept');
  await assertEventually(async () => (await folderHeaderById(page, 2).locator('.sec-count').innerText()) === '4', 'cenário 1: o cabeçalho de "Toolbox" passa a 4 depois de criar a nota (contagem inclui notas)');
});

// ── Cenário 2: editar uma nota existente — Accept salva a mudança ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  const noteCard = page.locator('.card[data-note-id="50"]');
  await noteCard.waitFor();
  assert((await noteCard.locator('.note-flat-body').innerText()).includes('Existing note'), 'cenário 2: a nota existente mostra o conteúdo salvo em modo de visualização');

  await noteCard.hover();
  await noteCard.locator('button[title="Edit note"]').click();

  const editing = page.locator('.card[data-note-editing="1"][data-note-id="50"]');
  await editing.waitFor();
  await assertEventually(async () => (await editing.locator('.note-editor-body').innerText()).includes('Existing note'), 'cenário 2: o editor já abre com o conteúdo salvo (setHtml populou o RichTextEditor)');

  const body = editing.locator('.note-editor-body');
  await body.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' — edited');
  await editing.locator('.pill-accept').click();

  await assertEventually(() => state.calls.updateNote.length === 1, 'cenário 2: PUT /api/notes/50 foi chamado');
  assert(state.calls.updateNote[0].description.includes('edited'), 'cenário 2: a descrição enviada contém o texto adicionado');
  await assertEventually(async () => (await page.locator('.card[data-note-id="50"] .note-flat-body').innerText()).includes('edited'), 'cenário 2: a visualização reflete a mudança salva');
});

// ── Cenário 3: cancelar uma edição sem salvar — Cancel descarta ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  const noteCard = page.locator('.card[data-note-id="50"]');
  await noteCard.hover();
  await noteCard.locator('button[title="Edit note"]').click();

  const editing = page.locator('.card[data-note-editing="1"][data-note-id="50"]');
  await editing.waitFor();
  const body = editing.locator('.note-editor-body');
  await body.click();
  await page.keyboard.type('discard me');
  await editing.locator('.pill-cancel').click();

  await assertEventually(async () => (await page.locator('.card[data-note-editing="1"]').count()) === 0, 'cenário 3: Cancel sai do modo de edição');
  assert(state.calls.updateNote.length === 0, 'cenário 3: Cancel NÃO chama PUT /api/notes/:id');
  assert(!(await page.locator('.card[data-note-id="50"] .note-flat-body').innerText()).includes('discard me'), 'cenário 3: o texto digitado não aparece na visualização (descartado)');
});

// ── Cenário 4: excluir uma nota (via confirmação) ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  const noteCard = page.locator('.card[data-note-id="50"]');
  await noteCard.hover();
  await noteCard.locator('button[title="Edit note"]').click();
  const editing = page.locator('.card[data-note-editing="1"][data-note-id="50"]');
  await editing.waitFor();
  assert(await editing.locator('.pill-delete').isVisible(), 'cenário 4: "✕ Delete Note" só aparece dentro do modo de edição');

  await editing.locator('.pill-delete').click();
  await page.waitForSelector('#confirmOverlay.show');
  const msg = await page.locator('#confirmMessage').innerText();
  assert(msg.includes('Delete note') && msg.includes('Existing note'), 'cenário 4: a confirmação usa um título derivado do conteúdo da nota');
  await page.locator('#confirmOkBtn').click();

  await assertEventually(() => state.calls.deleteNote.some(c => c.noteId === 50), 'cenário 4: DELETE /api/notes/50 foi chamado');
  await assertEventually(async () => (await page.locator('.card[data-note-id="50"]').count()) === 0, 'cenário 4: a nota some da tela');
  await assertEventually(async () => (await folderHeaderById(page, 2).locator('.sec-count').innerText()) === '2', 'cenário 4: o cabeçalho de "Toolbox" volta a 2 depois de excluir a única nota');
});

// ── Cenário 5: clonar uma nota ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  const noteCard = page.locator('.card[data-note-id="50"]');
  await noteCard.hover();
  await noteCard.locator('button[title="Clone note"]').click();

  await assertEventually(() => state.calls.cloneNote.some(c => c.noteId === 50), 'cenário 5: POST /api/notes/50/clone foi chamado');
  await assertEventually(async () => (await page.locator('[data-folder-body-id="2"] .card[data-note-id]').count()) === 2, 'cenário 5: aparece uma segunda nota depois de clonar');
  await assertEventually(async () => (await folderHeaderById(page, 2).locator('.sec-count').innerText()) === '4', 'cenário 5: o cabeçalho de "Toolbox" reflete a nota clonada na contagem');
});

// ── Cenário 6: bloqueio de salvar nota vazia (sem texto e sem imagem) ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  const dialogs = [];
  page.on('dialog', async d => {
    dialogs.push(d.message());
    await d.accept();
  });

  await openAddDropdown(page, 2);
  await folderHeaderById(page, 2).locator('.dd-panel .sb-row', { hasText: 'Note' }).click();
  const draft = page.locator('[data-folder-body-id="2"] .card[data-note-editing="1"]');
  await draft.waitFor();
  await draft.locator('.pill-accept').click();

  await assertEventually(() => dialogs.some(m => m.includes('Write something in the note.')), 'cenário 6: nota vazia (sem texto, sem imagem) mostra o alerta "Write something in the note."');
  assert(state.calls.createNote.length === 0, 'cenário 6: nenhum POST /api/folders/2/notes foi disparado pra uma nota vazia');
  assert((await draft.count()) === 1, 'cenário 6: o editor continua aberto depois do bloqueio (nada foi perdido)');
});

// ── Cenário 7: arrastar uma nota pra reordenar dentro da mesma pasta ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);
  await enterEditMode(page, 2);

  const rowsBefore = await page.locator('[data-folder-body-id="2"] > .folder-item-row').evaluateAll(els => els.map(e => `${e.dataset.itemType}:${e.dataset.itemId}`));
  assert(rowsBefore.join(',') === 'command:2,command:3,note:50', `cenário 7: ordem inicial é command:2,command:3,note:50 (lida: ${rowsBefore.join(',')})`);

  const noteRow = page.locator('.folder-item-row[data-item-type="note"][data-item-id="50"]');
  const firstCommandRow = page.locator('.folder-item-row[data-item-type="command"][data-item-id="2"]');
  await simulateDrag(page, noteRow.locator(':scope > .folder-drag-handle'), firstCommandRow, { before: true });

  await assertEventually(async () => {
    const order = await page.locator('[data-folder-body-id="2"] > .folder-item-row').evaluateAll(els => els.map(e => `${e.dataset.itemType}:${e.dataset.itemId}`));
    return order.join(',') === 'note:50,command:2,command:3';
  }, 'cenário 7: arrastar a nota pra antes do comando 2 reordena a seção (DOM refletindo note:50,command:2,command:3)');

  await assertEventually(() => state.calls.reorder.length >= 1, 'cenário 7: PUT /api/folders/2/reorder foi chamado');
  const lastReorder = state.calls.reorder[state.calls.reorder.length - 1];
  assert(
    JSON.stringify(lastReorder.order) === JSON.stringify([{ type: 'note', id: 50 }, { type: 'command', id: 2 }, { type: 'command', id: 3 }]),
    `cenário 7: a ordem persistida no servidor é [note50,cmd2,cmd3] (lida: ${JSON.stringify(lastReorder.order)})`
  );
});

// ── Cenário 8: aba Database nas Configurações mostra o grupo Folders (a fatia 9 acrescentou Commands e Database, admin-only — cobertos em fatia9a/9b) ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  await page.locator('.theme-toggle[title="Settings"]').click();
  await page.waitForSelector('.settings-modal-box');
  await page.locator('.settings-nav-btn', { hasText: 'Database' }).click();

  const content = page.locator('.settings-content');
  await assertEventually(async () => (await content.locator('.set-label', { hasText: 'Folders' }).count()) === 1, 'cenário 8: a aba Database mostra o grupo "Folders"');
  // Desde a fatia 9 a aba tem os 3 grupos do original; como este usuário é admin, vê todos.
  assert((await content.locator('.set-label', { hasText: 'Commands' }).count()) === 1, 'cenário 8: a aba Database mostra o grupo "Commands" (fatia 9)');
  assert((await content.locator('.set-label', { hasText: /^Database$/ }).count()) === 1, 'cenário 8: a aba Database mostra o grupo "Database"/Backup para admin (fatia 9)');
  assert(await content.locator('button', { hasText: 'Export folder' }).isVisible(), 'cenário 8: o botão "Export folder" está visível');
  assert(await content.locator('button', { hasText: 'Import folder' }).isVisible(), 'cenário 8: o botão "Import folder" está visível');
});

// ── Cenário 9: exportar uma pasta ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  await page.locator('.theme-toggle[title="Settings"]').click();
  await page.locator('.settings-nav-btn', { hasText: 'Database' }).click();
  await page.locator('button', { hasText: 'Export folder' }).click();
  await page.waitForSelector('#folderExportConfirmBtn');

  // Escopado pelo id ÚNICO do botão Export (não por hasText:"Export folder"
  // — a própria aba Database, por trás do modal, também tem um botão
  // "Export folder", e ambos os `.modal-box` (o do SettingsModal e o deste
  // modal) continuam no DOM ao mesmo tempo — um `.modal-box` filtrado só
  // por texto bateria nos dois e violaria o modo estrito do Playwright).
  const modal = page.locator('.modal-box', { has: page.locator('#folderExportConfirmBtn') });
  await modal.locator('select').selectOption({ label: 'Toolbox' });

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#folderExportConfirmBtn').click()]);
  assert(state.calls.export.some(c => c.folderId === 2), 'cenário 9: GET /api/folders/2/export foi chamado com o id da pasta escolhida');
  assert(download.suggestedFilename().startsWith('toolbox45-folder-toolbox-'), `cenário 9: o arquivo baixado segue o padrão de nome esperado (lido: ${download.suggestedFilename()})`);
});

// ── Cenário 10: importar um arquivo .json válido — resumo de contagem aparece ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  await page.locator('.theme-toggle[title="Settings"]').click();
  await page.locator('.settings-nav-btn', { hasText: 'Database' }).click();
  await page.locator('button', { hasText: 'Import folder' }).click();
  await page.waitForSelector('#folderImportConfirmBtn');

  const validExport = {
    type: 'toolbox45-folder-export', version: 1, exported_at: '2026-01-01T00:00:00Z',
    root: { name: 'Imported root', notes: [{ title: '', description: '<p>a</p>' }], commands: [{ sort_order: 0, command: { name: 'x' } }], children: [] },
  };
  await page.locator('#folderImportFile').setInputFiles({ name: 'export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(validExport)) });

  await assertEventually(async () => (await page.locator('#folderImportPreview').innerText()).includes('Imported root'), 'cenário 10: o resumo de contagem aparece com o nome da pasta do arquivo');
  assert((await page.locator('#folderImportPreview').innerText()).match(/1 folder\(s\), 1 command\(s\), 1 note\(s\)/), 'cenário 10: o resumo mostra 1 folder(s), 1 command(s), 1 note(s)');
  assert(!(await page.locator('#folderImportConfirmBtn').isDisabled()), 'cenário 10: o botão Import fica habilitado depois de um arquivo válido');

  const dialogs = [];
  page.on('dialog', async d => {
    dialogs.push(d.message());
    await d.accept();
  });
  await page.locator('#folderImportConfirmBtn').click();

  await assertEventually(() => state.calls.import.length === 1, 'cenário 10: POST /api/folders/import foi chamado');
  assert(state.calls.import[0].tree.name === 'Imported root', 'cenário 10: o corpo enviado contém a árvore (tree) do arquivo');
  assert(state.calls.import[0].parentId === null, 'cenário 10: sem escolher "Import into", parent_id vai null (Top level)');
  await assertEventually(() => dialogs.some(m => m.includes('Imported 1 folder(s), 1 command(s) and 1 note(s)')), 'cenário 10: a mensagem final de resultado aparece com a contagem devolvida pelo servidor');
});

// ── Cenário 11: mensagem de erro ao escolher um arquivo inválido/não reconhecido ──
await withPage(browser, async page => {
  const state = makeFolderState();
  await mockLoggedInAdmin(page, state);
  await goToFolders(page);

  await page.locator('.theme-toggle[title="Settings"]').click();
  await page.locator('.settings-nav-btn', { hasText: 'Database' }).click();
  await page.locator('button', { hasText: 'Import folder' }).click();
  await page.waitForSelector('#folderImportConfirmBtn');

  await page.locator('#folderImportFile').setInputFiles({ name: 'not-an-export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ hello: 'world' })) });

  await assertEventually(async () => (await page.locator('#folderImportPreview').innerText()).includes("doesn't look like a folder export file"), 'cenário 11: um JSON sem o formato esperado mostra a mensagem de erro exata do original');
  assert(await page.locator('#folderImportConfirmBtn').isDisabled(), 'cenário 11: o botão Import continua desabilitado pra um arquivo inválido');
  assert(state.calls.import.length === 0, 'cenário 11: nenhum POST /api/folders/import foi disparado');
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
