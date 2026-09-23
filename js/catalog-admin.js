// ════════════════════════════════════════════════
// CATALOG ADMIN — "Manage Versions" / "Manage Environments" / "Manage Topics" /
// "Manage Parameters" screens (one separate window per item, not a single
// tabbed modal — see #catalogAdminVersionsOverlay, #catalogAdminEnvironmentsOverlay,
// #catalogAdminTopicsOverlay, #catalogAdminParametersOverlay in index.html).
// ════════════════════════════════════════════════
// Reachable by any user via Settings → Registration (see index.html,
// .settings-pane[data-pane="catalog"]) — the old "Admin mode" gate was
// removed; COMMAND_EDITING_ENABLED (js/settings.js) is now always true, kept
// only as a harmless defensive check below.
//
// Each item (version/environment/topic) has a stable `key` — the same one
// used in command_versions/command_environments/command_topics — which can
// NEVER be edited after creation, only label/color/icon/order. Deletion is
// blocked by the server (409) when the item is in use by at least one
// command, or when it's a protected topic (e.g. 'environment') — see
// server/index.js.
//
// After any create/edit/delete, catAdminRefreshCatalogs() fetches the updated
// catalogs from the server and propagates them to the rest of the app
// (sidebar, Settings modal, command editor, render()) without reloading the
// page — see js/catalogs.js (renderCatalogUI/ccApplyToLegacyArrays).

function _cat(id) { return document.getElementById(id); }
function _catEscAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function _catEscHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Ordena uma CÓPIA de uma lista de catálogo por label (alfabético,
// case-insensitive, locale-aware) sem alterar o array original de CATALOGS
// -- mesmo critério já usado pelos chips "Command parameter" da sidebar (ver
// js/catalogs.js, renderCatalogUI) e pelos dropdowns de filtro
// (sortAllDropdowns, js/state.js). Pedido do usuário: "exibir os cadastros
// em ordem alfabética" (telas Settings -> Register). Usado só para exibição
// aqui -- a ordem em CATALOGS (sort_order/key, vinda do servidor) continua
// intacta para quem mais consome esses arrays.
function _catSortByLabel(items) {
  return (items || []).slice().sort((a, b) => (a.label || a.key || '').localeCompare(b.label || b.key || '', undefined, { sensitivity: 'base' }));
}

// `kind`: 'versions' | 'environments' | 'topics' | 'parameters' — each one is
// its own screen now (no tabs). The corresponding sidebar button calls
// openCatalogAdmin('environments') etc. — see index.html/#addCommandBlock.
const CAT_ADMIN_OVERLAY_IDS = {
  vendors: 'catalogAdminVendorsOverlay',
  systems: 'catalogAdminSystemsOverlay',
  versions: 'catalogAdminVersionsOverlay',
  environments: 'catalogAdminEnvironmentsOverlay',
  topics: 'catalogAdminTopicsOverlay',
  parameters: 'catalogAdminParametersOverlay',
  prompts: 'catalogAdminPromptsOverlay',
  exports: 'catalogAdminExportsOverlay',
};
// One message box per screen — catAdminMsg() below writes to all at once
// (only one is visible at a time, so this is always harmless and simpler
// than tracking "which screen is open now").
const CAT_ADMIN_MSG_IDS = ['catAdminMsgVendors', 'catAdminMsgSystems', 'catAdminMsgVersions', 'catAdminMsgEnvironments', 'catAdminMsgTopics', 'catAdminMsgParameters', 'catAdminMsgPrompts', 'catAdminMsgExports'];
// Ícone de exclusão (substitui o emoji 🗑️ por um SVG de contorno, no mesmo
// padrão visual dos outros ícones já convertidos no app — ex.: lápis/copiar
// em js/db-render-engine.js). Usado nos 6 botões "Delete" das telas de
// Register — ver .cat-delete-btn em css/components.css para o hover
// vermelho (ação destrutiva).
const CAT_TRASH_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6.5 4V2.7c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7V4M4.5 4l.6 9c.05.6.5 1 1.1 1h3.6c.6 0 1.05-.4 1.1-1l.6-9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.7 7v4M9.3 7v4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
// Preenche um <select> de catálogo (Vendor/Sistema) com as opções atuais,
// preservando/aplicando o valor selecionado — usado pelos formulários de
// Sistema (vendor) e Versão (sistema), que agora são FK obrigatória e direta
// (ver server/schema.sql) em vez de vínculo N:N.
// `placeholder` (opcional): rótulo da dependência (ex.: "Vendor", "System")
// mostrado como 1ª opção desabilitada — sem isso, um <select> nunca fica
// "em branco" de verdade quando não há nada selecionado (o navegador sempre
// escolhe a primeira opção da lista), o que deixava o campo parecendo vazio/
// sem explicação nenhuma (ex.: linha "+ Add system" antes de qualquer Vendor
// existir). Com o placeholder, sempre fica claro o que aquele dropdown
// representa, tanto vazio quanto já preenchido.
function _catPopulateSelect(selectId, items, selectedValue, placeholder) {
  const el = _cat(selectId);
  if (!el) return;
  const placeholderHtml = placeholder
    ? `<option value="" disabled${selectedValue ? '' : ' selected'}>${_catEscHtml(placeholder)}</option>`
    : '';
  el.innerHTML = placeholderHtml + (items || []).map(it => `<option value="${_catEscAttr(it.key)}">${_catEscHtml(it.label)}</option>`).join('');
  if (selectedValue != null) el.value = selectedValue;
}

function openCatalogAdmin(kind) {
  if (typeof COMMAND_EDITING_ENABLED !== 'undefined' && !COMMAND_EDITING_ENABLED) return; // safety lock, same as the command editor
  const overlayId = CAT_ADMIN_OVERLAY_IDS[kind];
  if (!overlayId) return;
  _cat(overlayId).classList.add('show');
  catAdminMsg('');
  renderCatAdminAll();
}
function closeCatalogAdmin(kind) {
  const overlayId = CAT_ADMIN_OVERLAY_IDS[kind];
  if (overlayId) _cat(overlayId).classList.remove('show');
}
Object.values(CAT_ADMIN_OVERLAY_IDS).forEach(overlayId => {
  const el = document.getElementById(overlayId);
  if (el) el.addEventListener('click', ev => { if (ev.target.id === overlayId) el.classList.remove('show'); });
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  Object.values(CAT_ADMIN_OVERLAY_IDS).forEach(overlayId => { const el = _cat(overlayId); if (el) el.classList.remove('show'); });
});

function catAdminMsg(text, kind) {
  CAT_ADMIN_MSG_IDS.forEach(id => {
    const el = _cat(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('err', kind === 'err');
    el.classList.toggle('ok', kind === 'ok');
  });
}

// Turns a fetch error response (409 in-use/protected, 400 validation, etc.)
// into a friendly message.
async function catAdminHandleError(res) {
  let body = {};
  try { body = await res.json(); } catch (e) {}
  if (body.error === 'in_use') { catAdminMsg(`Cannot delete: in use by ${body.count != null ? body.count : '?'} command(s).`, 'err'); return; }
  if (body.error === 'protected') { catAdminMsg('This item is protected by the system and cannot be deleted.', 'err'); return; }
  if (body.error === 'structural_dependency') { catAdminMsg(`Cannot delete: ${body.count != null ? body.count : '?'} command(s) depend on this parameter directly in code (e.g. "Requires SRC/DST").`, 'err'); return; }
  if (body.error === 'conflict') { catAdminMsg('An item with this key already exists.', 'err'); return; }
  if (body.error === 'validation_error') { catAdminMsg(body.message || 'Something went wrong. Please try again.', 'err'); return; }
  catAdminMsg('Something went wrong. Please try again.', 'err');
}

// Fetches the updated catalogs from the server and propagates them to the
// rest of the app (sidebar, Settings modal, command editor, render()) — see js/catalogs.js.
async function catAdminRefreshCatalogs() {
  try {
    const res = await fetch('/api/catalogs');
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.versions)) {
      CATALOGS = Object.assign(
        { vendors: [], systems: [], prompts: [], exports: [], version_environments: [], environment_topics: [] },
        data
      );
    }
    }
  } catch (e) { console.warn('Failed to reload catalogs', e); }
  if (typeof ccApplyToLegacyArrays === 'function') ccApplyToLegacyArrays();
  if (typeof renderCatalogUI === 'function') renderCatalogUI();
  if (typeof sortAllDropdowns === 'function') sortAllDropdowns();
  renderCatAdminAll();
  if (typeof render === 'function') render();
}

function renderCatAdminAll() {
  renderCatAdminVendors();
  renderCatAdminSystems();
  renderCatAdminVersions();
  renderCatAdminEnvironments();
  renderCatAdminTopics();
  renderCatAdminParameters();
  renderCatAdminPrompts();
  renderCatAdminExports();
}

// ── Busca (filtro client-side, por tela) ──────────
// Pedido do usuário: "campo de pesquisa em cada tela de cadastro" — filtra a
// lista já carregada (sem nova chamada à API), no mesmo estilo do
// #userSearchInput da aba Users (ver js/users-admin.js). Implementado com
// display:none em vez de reconstruir o HTML da lista inteira, para não
// descartar edições ainda não salvas enquanto o usuário digita na busca (o
// Save em lote abaixo depende dos <input> de cada linha continuarem com o
// valor que o usuário digitou).
const CAT_ADMIN_SEARCH = { vendors: '', systems: '', versions: '', environments: '', topics: '', parameters: '', prompts: '', exports: '' };
const CAT_ADMIN_LIST_IDS = {
  vendors: 'catVendorsList', systems: 'catSysList', versions: 'catVersionsList',
  environments: 'catEnvironmentsList', topics: 'catTopicsList', parameters: 'catParametersList', prompts: 'catPromptsList',
  exports: 'catExportsList',
};
function catAdminSearchInput(kind, value) {
  CAT_ADMIN_SEARCH[kind] = (value || '').trim().toLowerCase();
  catAdminApplyFilter(kind);
}
function catAdminApplyFilter(kind) {
  const list = _cat(CAT_ADMIN_LIST_IDS[kind]);
  if (!list) return;
  const q = CAT_ADMIN_SEARCH[kind] || '';
  list.querySelectorAll('[data-cat-search]').forEach(row => {
    const hay = row.getAttribute('data-cat-search') || '';
    row.style.display = (!q || hay.indexOf(q) !== -1) ? '' : 'none';
  });
}

// ── Barra Save/Cancel no rodapé (substitui o antigo botão 💾 por linha) ──
// Pedido do usuário: "trocar Save por linha por barra Save/Cancel no
// rodapé". Cada tela tem seu próprio par de botões (ver index.html,
// .modal-foot dentro de cada #catalogAdmin*Overlay), habilitados só quando
// há alguma edição pendente — catAdminMarkDirty() é chamado pelos
// oninput/onchange dos campos de cada linha (ver renderCatAdminX abaixo).
// "Save" varre TODAS as linhas da tela e só envia PUT para as que realmente
// mudaram (compara o valor atual do DOM com o valor em CATALOGS); "Cancel"
// simplesmente re-renderiza a lista a partir de CATALOGS, descartando
// qualquer edição não salva.
const CAT_ADMIN_FOOT_IDS = {
  vendors: { save: 'catAdminSaveVendors', cancel: 'catAdminCancelVendors' },
  systems: { save: 'catAdminSaveSystems', cancel: 'catAdminCancelSystems' },
  versions: { save: 'catAdminSaveVersions', cancel: 'catAdminCancelVersions' },
  environments: { save: 'catAdminSaveEnvironments', cancel: 'catAdminCancelEnvironments' },
  topics: { save: 'catAdminSaveTopics', cancel: 'catAdminCancelTopics' },
  parameters: { save: 'catAdminSaveParameters', cancel: 'catAdminCancelParameters' },
  prompts: { save: 'catAdminSavePrompts', cancel: 'catAdminCancelPrompts' },
  exports: { save: 'catAdminSaveExports', cancel: 'catAdminCancelExports' },
};
const CAT_ADMIN_DIRTY = {};
function catAdminMarkDirty(kind) {
  if (CAT_ADMIN_DIRTY[kind]) return;
  CAT_ADMIN_DIRTY[kind] = true;
  catAdminSetFootEnabled(kind, true);
}
function catAdminSetFootEnabled(kind, enabled) {
  const ids = CAT_ADMIN_FOOT_IDS[kind];
  if (!ids) return;
  const saveBtn = _cat(ids.save), cancelBtn = _cat(ids.cancel);
  if (saveBtn) saveBtn.disabled = !enabled;
  if (cancelBtn) cancelBtn.disabled = !enabled;
}
function catAdminClearDirty(kind) {
  CAT_ADMIN_DIRTY[kind] = false;
  catAdminSetFootEnabled(kind, false);
}
// Preenchido no fim do arquivo, depois que cada renderCatAdminX() é declarada.
const CAT_ADMIN_RENDER_FN = {};
function catAdminCancel(kind) {
  const fn = CAT_ADMIN_RENDER_FN[kind];
  if (fn) fn();
  catAdminMsg('');
  catAdminClearDirty(kind);
}

function _catShallowEqual(a, b) {
  return Object.keys(a).every(k => String(a[k]) === String(b[k]));
}

// Descreve, para cada tela, como ler o estado atual dos campos de uma linha
// a partir do DOM (readRow) e qual é o valor "original" em CATALOGS
// (original), para o Save em lote só enviar PUT das linhas que realmente
// mudaram. `rowId` é o identificador usado nos ids de DOM de cada campo
// (ver renderCatAdminX) — para Versions é composto (`system::key`), porque a
// chave primária real da versão também é composta.
const CAT_ADMIN_BULK = {
  vendors: {
    items: () => CATALOGS.vendors || [],
    rowId: v => v.key,
    readRow: key => ({ label: _cat('catVd_label_' + key).value.trim(), color: _cat('catVd_color_' + key).value }),
    original: v => ({ label: v.label, color: v.color || '#8B949E' }),
    url: key => '/api/vendors/' + encodeURIComponent(key),
    validate: b => b.label ? null : 'Fill in the required label(s).',
    name: v => v.label || v.key,
  },
  systems: {
    items: () => CATALOGS.systems || [],
    rowId: s => s.key,
    readRow: key => ({ label: _cat('catSys_label_' + key).value.trim(), color: _cat('catSys_color_' + key).value, vendor: _cat('catSys_vendor_' + key).value }),
    original: s => ({ label: s.label, color: s.color || '#8B949E', vendor: s.vendor }),
    url: key => '/api/systems/' + encodeURIComponent(key),
    validate: b => !b.label ? 'Fill in the required label(s).' : (!b.vendor ? 'Choose a vendor.' : null),
    name: s => s.label || s.key,
  },
  versions: {
    items: () => CATALOGS.versions || [],
    rowId: v => v.system + '::' + v.key,
    readRow: rid => ({ label: _cat('catV_label_' + rid).value.trim(), color: _cat('catV_color_' + rid).value, system: _cat('catV_system_' + rid).value }),
    original: v => ({ label: v.label, color: v.color || '#8B949E', system: v.system }),
    url: rid => { const i = rid.indexOf('::'); return `/api/versions/${encodeURIComponent(rid.slice(0, i))}/${encodeURIComponent(rid.slice(i + 2))}`; },
    validate: b => !b.label ? 'Fill in the required label(s).' : (!b.system ? 'Choose a system.' : null),
    name: v => v.label || v.key,
  },
  environments: {
    items: () => CATALOGS.environments || [],
    rowId: e => e.key,
    readRow: key => ({ label: _cat('catE_label_' + key).value.trim(), color: _cat('catE_color_' + key).value, system: _cat('catE_system_' + key).value }),
    original: e => ({ label: e.label, color: e.color || '#8B949E', system: e.system }),
    url: key => '/api/environments/' + encodeURIComponent(key),
    validate: b => !b.label ? 'Fill in the required label(s).' : (!b.system ? 'Choose a system.' : null),
    name: e => e.label || e.key,
  },
  topics: {
    items: () => CATALOGS.topics || [],
    rowId: t => t.key,
    readRow: key => ({ label: _cat('catT_label_' + key).value.trim(), color: _cat('catT_color_' + key).value }),
    original: t => ({ label: t.label, color: t.color || '#8B949E' }),
    url: key => '/api/topics/' + encodeURIComponent(key),
    validate: b => b.label ? null : 'Fill in the required label(s).',
    name: t => t.label || t.key,
  },
  parameters: {
    items: () => CATALOGS.parameters || [],
    rowId: p => p.key,
    readRow: key => ({ label: _cat('catP_label_' + key).value.trim() }),
    original: p => ({ label: p.label }),
    url: key => '/api/parameters/' + encodeURIComponent(key),
    validate: b => b.label ? null : 'Fill in the required label(s).',
    name: p => p.label || p.key,
  },
  prompts: {
    items: () => CATALOGS.prompts || [],
    rowId: p => p.key,
    readRow: key => ({ label: _cat('catPr_label_' + key).value.trim() }),
    original: p => ({ label: p.label }),
    url: key => '/api/prompts/' + encodeURIComponent(key),
    validate: b => b.label ? null : 'Fill in the required label(s).',
    name: p => p.label || p.key,
  },
  exports: {
    items: () => CATALOGS.exports || [],
    rowId: x => x.key,
    readRow: key => ({ label: _cat('catEx_label_' + key).value.trim() }),
    original: x => ({ label: x.label }),
    url: key => '/api/exports/' + encodeURIComponent(key),
    validate: b => b.label ? null : 'Fill in the required label(s).',
    name: x => x.label || x.key,
  },
};

async function catAdminSaveAll(kind) {
  const cfg = CAT_ADMIN_BULK[kind];
  if (!cfg) return;
  const errors = [];
  let changed = 0;
  for (const item of cfg.items()) {
    const rid = cfg.rowId(item);
    const body = cfg.readRow(rid);
    if (_catShallowEqual(body, cfg.original(item))) continue; // linha não foi tocada
    const err = cfg.validate(body);
    if (err) { errors.push(`"${cfg.name(item)}": ${err}`); continue; }
    changed++;
    try {
      const res = await fetch(cfg.url(rid), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        let b = {}; try { b = await res.json(); } catch (e) {}
        errors.push(`"${cfg.name(item)}": ${b.message || b.error || 'save failed'}.`);
      }
    } catch (e) { errors.push(`"${cfg.name(item)}": network error.`); }
  }
  await catAdminRefreshCatalogs();
  if (errors.length) catAdminMsg(errors.join(' '), 'err');
  else if (changed === 0) catAdminMsg('No changes to save.', 'ok');
  else catAdminMsg('Changes saved.', 'ok');
  catAdminClearDirty(kind);
}

// ── Vendors ──────────────────────────────────────
function renderCatAdminVendors() {
  const list = _cat('catVendorsList');
  if (!list) return;
  list.innerHTML = _catSortByLabel(CATALOGS.vendors).map(v => `
    <div class="cat-row" data-cat-search="${_catEscAttr((v.key + ' ' + v.label).toLowerCase())}">
      <input class="set-input" id="catVd_label_${_catEscAttr(v.key)}" value="${_catEscAttr(v.label)}" style="flex:1;min-width:80px;" oninput="catAdminMarkDirty('vendors')">
      <input type="color" class="cat-color-input" id="catVd_color_${_catEscAttr(v.key)}" value="${_catEscAttr(v.color || '#8B949E')}" oninput="catAdminMarkDirty('vendors')">
      <div class="cat-row-actions">
        <button type="button" class="edit-btn cat-delete-btn" onclick="catAdminDeleteVendor('${_catEscAttr(v.key)}')" title="Delete">${CAT_TRASH_SVG}</button>
      </div>
    </div>`).join('');
  catAdminApplyFilter('vendors');
}
async function catAdminDeleteVendor(key) {
  const ok = await openConfirmModal(`Delete "${key}"? This action cannot be undone.`);
  if (!ok) return;
  try {
    const res = await fetch('/api/vendors/' + encodeURIComponent(key), { method: 'DELETE' });
    if (!res.ok) return catAdminHandleError(res);
    catAdminMsg('Deleted.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}
async function catAdminAddVendor() {
  const label = _cat('catVdNewLabel').value.trim();
  const color = _cat('catVdNewColor').value;
  if (!label) { catAdminMsg('Fill in the required label(s).', 'err'); return; }
  try {
    const res = await fetch('/api/vendors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, color }),
    });
    if (!res.ok) return catAdminHandleError(res);
    _cat('catVdNewLabel').value = ''; _cat('catVdNewColor').value = '#8B949E';
    catAdminMsg('Added.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}

// ── Systems ──────────────────────────────────────
// Hierarquia ESTRITA: um Sistema pertence a exatamente um Vendor (FK direta —
// systems.vendor, ver server/schema.sql), por isso o Vendor é um campo
// obrigatório aqui (um <select> por linha + no formulário de novo sistema),
// diferente do antigo vínculo N:N opcional (vendor_os).
function renderCatAdminSystems() {
  const list = _cat('catSysList');
  if (!list) return;
  const systems = _catSortByLabel(CATALOGS.systems);
  list.innerHTML = systems.map(s => `
    <div class="cat-row" data-cat-search="${_catEscAttr((s.key + ' ' + s.label).toLowerCase())}">
      <select class="set-input" id="catSys_vendor_${_catEscAttr(s.key)}" style="max-width:140px;" onchange="catAdminMarkDirty('systems')"></select>
      <input class="set-input" id="catSys_label_${_catEscAttr(s.key)}" value="${_catEscAttr(s.label)}" style="flex:1;min-width:80px;" oninput="catAdminMarkDirty('systems')">
      <input type="color" class="cat-color-input" id="catSys_color_${_catEscAttr(s.key)}" value="${_catEscAttr(s.color || '#8B949E')}" oninput="catAdminMarkDirty('systems')">
      <div class="cat-row-actions">
        <button type="button" class="edit-btn cat-delete-btn" onclick="catAdminDeleteSystem('${_catEscAttr(s.key)}')" title="Delete">${CAT_TRASH_SVG}</button>
      </div>
    </div>`).join('');
  systems.forEach(s => _catPopulateSelect('catSys_vendor_' + s.key, CATALOGS.vendors, s.vendor, 'Vendor'));
  _catPopulateSelect('catSysNewVendor', CATALOGS.vendors, null, 'Vendor');
  catAdminApplyFilter('systems');
}
async function catAdminDeleteSystem(key) {
  const ok = await openConfirmModal(`Delete "${key}"? This action cannot be undone.`);
  if (!ok) return;
  try {
    const res = await fetch('/api/systems/' + encodeURIComponent(key), { method: 'DELETE' });
    if (!res.ok) return catAdminHandleError(res);
    catAdminMsg('Deleted.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}
async function catAdminAddSystem() {
  const label = _cat('catSysNewLabel').value.trim();
  const color = _cat('catSysNewColor').value;
  const vendor = _cat('catSysNewVendor').value;
  if (!label) { catAdminMsg('Fill in the required label(s).', 'err'); return; }
  if (!vendor) { catAdminMsg('Choose a vendor.', 'err'); return; }
  try {
    const res = await fetch('/api/systems', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, color, vendor }),
    });
    if (!res.ok) return catAdminHandleError(res);
    _cat('catSysNewLabel').value = ''; _cat('catSysNewColor').value = '#8B949E';
    catAdminMsg('Added.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}

// ── Versions ─────────────────────────────────────
// A chave primária real agora é composta (system, key) — o mesmo `key` de
// versão pode existir sob sistemas diferentes (ex.: "R82" em dois sistemas
// distintos), só não dentro do MESMO vendor (ver comentário em
// server/schema.sql). Por isso os ids de DOM de cada linha incorporam o
// sistema (`${system}::${key}`) para não colidir, e delete recebe os dois
// valores e chama /api/versions/:system/:key.
function renderCatAdminVersions() {
  const list = _cat('catVersionsList');
  if (!list) return;
  const versions = _catSortByLabel(CATALOGS.versions);
  list.innerHTML = versions.map(v => {
    const rid = _catEscAttr(v.system) + '::' + _catEscAttr(v.key);
    return `
    <div class="cat-row" data-cat-search="${_catEscAttr((v.system + ' ' + v.key + ' ' + v.label).toLowerCase())}">
      <select class="set-input" id="catV_system_${rid}" style="max-width:130px;" onchange="catAdminMarkDirty('versions')"></select>
      <input class="set-input" id="catV_label_${rid}" value="${_catEscAttr(v.label)}" style="flex:1;min-width:80px;" oninput="catAdminMarkDirty('versions')">
      <input type="color" class="cat-color-input" id="catV_color_${rid}" value="${_catEscAttr(v.color || '#8B949E')}" oninput="catAdminMarkDirty('versions')">
      <div class="cat-row-actions">
        <button type="button" class="edit-btn cat-delete-btn" onclick="catAdminDeleteVersion('${_catEscAttr(v.system)}','${_catEscAttr(v.key)}')" title="Delete">${CAT_TRASH_SVG}</button>
      </div>
    </div>`;
  }).join('');
  versions.forEach(v => _catPopulateSelect('catV_system_' + v.system + '::' + v.key, CATALOGS.systems, v.system, 'System'));
  _catPopulateSelect('catVNewSystem', CATALOGS.systems, null, 'System');
  catAdminApplyFilter('versions');
}
async function catAdminDeleteVersion(system, key) {
  const ok = await openConfirmModal(`Delete "${key}"? This action cannot be undone.`);
  if (!ok) return;
  try {
    const res = await fetch(`/api/versions/${encodeURIComponent(system)}/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!res.ok) return catAdminHandleError(res);
    catAdminMsg('Deleted.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}
async function catAdminAddVersion() {
  const label = _cat('catVNewLabel').value.trim();
  const color = _cat('catVNewColor').value;
  const system = _cat('catVNewSystem').value;
  if (!label) { catAdminMsg('Fill in the required label(s).', 'err'); return; }
  if (!system) { catAdminMsg('Choose a system.', 'err'); return; }
  try {
    const res = await fetch('/api/versions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, color, system }),
    });
    if (!res.ok) return catAdminHandleError(res);
    _cat('catVNewLabel').value = ''; _cat('catVNewColor').value = '#8B949E';
    catAdminMsg('Added.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}

// ── Environments ─────────────────────────────────
// Agora tem Sistema relacionado (FK obrigatória — environments.system, ver
// server/schema.sql), mesmo padrão de Versions acima: um <select> por linha +
// no formulário de novo ambiente.
function renderCatAdminEnvironments() {
  const list = _cat('catEnvironmentsList');
  if (!list) return;
  const environments = _catSortByLabel(CATALOGS.environments);
  list.innerHTML = environments.map(e => `
    <div class="cat-row" data-cat-search="${_catEscAttr((e.key + ' ' + e.label + ' ' + (e.system || '')).toLowerCase())}">
      <select class="set-input" id="catE_system_${_catEscAttr(e.key)}" style="max-width:130px;" onchange="catAdminMarkDirty('environments')"></select>
      <input class="set-input" id="catE_label_${_catEscAttr(e.key)}" value="${_catEscAttr(e.label)}" style="flex:1;min-width:120px;" oninput="catAdminMarkDirty('environments')">
      <input type="color" class="cat-color-input" id="catE_color_${_catEscAttr(e.key)}" value="${_catEscAttr(e.color || '#8B949E')}" oninput="catAdminMarkDirty('environments')">
      <div class="cat-row-actions">
        <button type="button" class="edit-btn cat-delete-btn" onclick="catAdminDeleteEnvironment('${_catEscAttr(e.key)}')" title="Delete">${CAT_TRASH_SVG}</button>
      </div>
    </div>`).join('');
  environments.forEach(e => _catPopulateSelect('catE_system_' + e.key, CATALOGS.systems, e.system, 'System'));
  _catPopulateSelect('catENewSystem', CATALOGS.systems, null, 'System');
  catAdminApplyFilter('environments');
}
async function catAdminDeleteEnvironment(key) {
  const ok = await openConfirmModal(`Delete "${key}"? This action cannot be undone.`);
  if (!ok) return;
  try {
    const res = await fetch('/api/environments/' + encodeURIComponent(key), { method: 'DELETE' });
    if (!res.ok) return catAdminHandleError(res);
    catAdminMsg('Deleted.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}
async function catAdminAddEnvironment() {
  const label = _cat('catENewLabel').value.trim();
  const color = _cat('catENewColor').value;
  const system = _cat('catENewSystem').value;
  if (!label) { catAdminMsg('Fill in the required label(s).', 'err'); return; }
  if (!system) { catAdminMsg('Choose a system.', 'err'); return; }
  try {
    const res = await fetch('/api/environments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, color, system }),
    });
    if (!res.ok) return catAdminHandleError(res);
    _cat('catENewLabel').value = ''; _cat('catENewColor').value = '#8B949E';
    catAdminMsg('Added.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}

// ── Topics ───────────────────────────────────────
// Mesmos campos de Environments (label/color) — sem section_title (removido
// a pedido do usuário, ver comentário em schema.sql); a única diferença real
// é is_protected (badge/gate de exclusão do tópico especial 'environment').
function renderCatAdminTopics() {
  const list = _cat('catTopicsList');
  if (!list) return;
  list.innerHTML = _catSortByLabel(CATALOGS.topics).map(tp => `
    <div class="cat-row" data-cat-search="${_catEscAttr((tp.key + ' ' + tp.label).toLowerCase())}">
      ${tp.is_protected ? `<span class="cat-protected-badge">${_catEscHtml('protected')}</span>` : ''}
      <input class="set-input" id="catT_label_${_catEscAttr(tp.key)}" value="${_catEscAttr(tp.label)}" style="flex:1;min-width:120px;" oninput="catAdminMarkDirty('topics')">
      <input type="color" class="cat-color-input" id="catT_color_${_catEscAttr(tp.key)}" value="${_catEscAttr(tp.color || '#8B949E')}" oninput="catAdminMarkDirty('topics')">
      <div class="cat-row-actions">
        ${tp.is_protected ? '' : `<button type="button" class="edit-btn cat-delete-btn" onclick="catAdminDeleteTopic('${_catEscAttr(tp.key)}')" title="Delete">${CAT_TRASH_SVG}</button>`}
      </div>
    </div>`).join('');
  catAdminApplyFilter('topics');
}
async function catAdminDeleteTopic(key) {
  const ok = await openConfirmModal(`Delete "${key}"? This action cannot be undone.`);
  if (!ok) return;
  try {
    const res = await fetch('/api/topics/' + encodeURIComponent(key), { method: 'DELETE' });
    if (!res.ok) return catAdminHandleError(res);
    catAdminMsg('Deleted.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}
async function catAdminAddTopic() {
  const label = _cat('catTNewLabel').value.trim();
  const color = _cat('catTNewColor').value;
  if (!label) { catAdminMsg('Fill in the required label(s).', 'err'); return; }
  try {
    const res = await fetch('/api/topics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, color }),
    });
    if (!res.ok) return catAdminHandleError(res);
    _cat('catTNewLabel').value = ''; _cat('catTNewColor').value = '#8B949E';
    catAdminMsg('Added.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}

// ── Parameters (unified query bar + "Insert variable") ──
// Row layout: Parameter (key, immutable) / Description — same in-line style
// (.cat-row) used for Versions/Environments/Topics. Single `label` field (no
// more PT/EN pair) — the whole app is English-only now. Sem coluna de Ordem
// (removida a pedido do usuário — a listagem de exibição no "Command
// parameter" (js/catalogs.js: ccBuildQueryChips) agora é sempre alfabética,
// então não fazia mais sentido manter uma ordem manual aqui).
function renderCatAdminParameters() {
  const list = _cat('catParametersList');
  if (!list) return;
  list.innerHTML = _catSortByLabel(CATALOGS.parameters).map(p => `
    <div class="cat-row" data-cat-search="${_catEscAttr((p.key + ' ' + p.label).toLowerCase())}">
      <span class="cat-key-badge" title="{{${_catEscAttr(p.key)}}}">${_catEscHtml(p.key)}</span>
      <input class="set-input" id="catP_label_${_catEscAttr(p.key)}" value="${_catEscAttr(p.label)}" style="flex:1;min-width:140px;" oninput="catAdminMarkDirty('parameters')">
      <div class="cat-row-actions">
        <button type="button" class="edit-btn cat-delete-btn" onclick="catAdminDeleteParameter('${_catEscAttr(p.key)}')" title="Delete">${CAT_TRASH_SVG}</button>
      </div>
    </div>`).join('');
  catAdminApplyFilter('parameters');
}
async function catAdminDeleteParameter(key) {
  const ok = await openConfirmModal(`Delete "${key}"? This action cannot be undone.`);
  if (!ok) return;
  try {
    const res = await fetch('/api/parameters/' + encodeURIComponent(key), { method: 'DELETE' });
    if (!res.ok) return catAdminHandleError(res);
    catAdminMsg('Deleted.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}
async function catAdminAddParameter() {
  const key = _cat('catPNewKey').value.trim();
  const label = _cat('catPNewLabel').value.trim();
  if (!key || !/^[A-Za-z0-9._-]{1,40}$/.test(key)) { catAdminMsg('Enter a valid key (letters, numbers, dot, hyphen).', 'err'); return; }
  if (!label) { catAdminMsg('Fill in the required label(s).', 'err'); return; }
  try {
    const res = await fetch('/api/parameters', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, label }),
    });
    if (!res.ok) return catAdminHandleError(res);
    _cat('catPNewKey').value = ''; _cat('catPNewLabel').value = '';
    catAdminMsg('Added.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}

// ── Prompts ──────────────────────────────────────
// Lista de valores reutilizáveis para o campo "Prompt" de cada linha tipo
// 'cmd' no editor de comandos (js/command-editor.js, .ln-prompt) — antes
// texto livre, agora um catálogo. Mesmo padrão de Vendors/Environments (key
// auto-gerada a partir do label), só que sem cor: o prompt nunca é exibido
// como badge/tag em lugar nenhum, só popula um <select>.
function renderCatAdminPrompts() {
  const list = _cat('catPromptsList');
  if (!list) return;
  list.innerHTML = _catSortByLabel(CATALOGS.prompts).map(p => `
    <div class="cat-row" data-cat-search="${_catEscAttr((p.key + ' ' + p.label).toLowerCase())}">
      <input class="set-input" id="catPr_label_${_catEscAttr(p.key)}" value="${_catEscAttr(p.label)}" style="flex:1;min-width:140px;" oninput="catAdminMarkDirty('prompts')">
      <div class="cat-row-actions">
        <button type="button" class="edit-btn cat-delete-btn" onclick="catAdminDeletePrompt('${_catEscAttr(p.key)}')" title="Delete">${CAT_TRASH_SVG}</button>
      </div>
    </div>`).join('');
  catAdminApplyFilter('prompts');
}
async function catAdminDeletePrompt(key) {
  const ok = await openConfirmModal(`Delete "${key}"? This action cannot be undone.`);
  if (!ok) return;
  try {
    const res = await fetch('/api/prompts/' + encodeURIComponent(key), { method: 'DELETE' });
    if (!res.ok) return catAdminHandleError(res);
    catAdminMsg('Deleted.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}
async function catAdminAddPrompt() {
  const label = _cat('catPrNewLabel').value.trim();
  if (!label) { catAdminMsg('Fill in the required label(s).', 'err'); return; }
  try {
    const res = await fetch('/api/prompts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
    });
    if (!res.ok) return catAdminHandleError(res);
    _cat('catPrNewLabel').value = '';
    catAdminMsg('Added.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}

// Exports -- mesmo padrao de Prompts acima (dropdown "Export" de cada linha
// tipo 'cmd' no editor de comandos, js/command-editor.js .ln-export) --
// antes um checkbox fixo "Exportable". key auto-gerada a partir do label,
// sem cor, sem contagem de uso no DELETE.
function renderCatAdminExports() {
  const list = _cat('catExportsList');
  if (!list) return;
  list.innerHTML = _catSortByLabel(CATALOGS.exports).map(x => `
    <div class="cat-row" data-cat-search="${_catEscAttr((x.key + ' ' + x.label).toLowerCase())}">
      <input class="set-input" id="catEx_label_${_catEscAttr(x.key)}" value="${_catEscAttr(x.label)}" style="flex:1;min-width:140px;" oninput="catAdminMarkDirty('exports')">
      <div class="cat-row-actions">
        <button type="button" class="edit-btn cat-delete-btn" onclick="catAdminDeleteExport('${_catEscAttr(x.key)}')" title="Delete">${CAT_TRASH_SVG}</button>
      </div>
    </div>`).join('');
  catAdminApplyFilter('exports');
}
async function catAdminDeleteExport(key) {
  const ok = await openConfirmModal(`Delete "${key}"? This action cannot be undone.`);
  if (!ok) return;
  try {
    const res = await fetch('/api/exports/' + encodeURIComponent(key), { method: 'DELETE' });
    if (!res.ok) return catAdminHandleError(res);
    catAdminMsg('Deleted.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}
async function catAdminAddExport() {
  const label = _cat('catExNewLabel').value.trim();
  if (!label) { catAdminMsg('Fill in the required label(s).', 'err'); return; }
  try {
    const res = await fetch('/api/exports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
    });
    if (!res.ok) return catAdminHandleError(res);
    _cat('catExNewLabel').value = '';
    catAdminMsg('Added.', 'ok');
    catAdminRefreshCatalogs();
  } catch (e) { catAdminMsg('Something went wrong. Please try again.', 'err'); }
}

// Precisa vir depois de todas as renderCatAdminX() acima estarem declaradas.
Object.assign(CAT_ADMIN_RENDER_FN, {
  vendors: renderCatAdminVendors, systems: renderCatAdminSystems, versions: renderCatAdminVersions,
  environments: renderCatAdminEnvironments, topics: renderCatAdminTopics, parameters: renderCatAdminParameters,
  prompts: renderCatAdminPrompts, exports: renderCatAdminExports,
});
