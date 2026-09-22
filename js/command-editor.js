// ════════════════════════════════════════════════
// COMMAND EDITOR — "Add command" / "Edit command" modal (#cmdEditorOverlay).
// Assembles a payload matching exactly what server/index.js's POST/PUT
// /api/commands expect (see buildCommandColumns/insertChildren there) and
// calls createCommand()/updateCommand()/deleteCommand() from api-client.js.
//
// The whole app (database + UI) is English-only now — name/desc/about/
// lines are all single-language fields, so a single fetchCommands()
// call is enough to populate the form (no more PT/EN zipping).
// ════════════════════════════════════════════════

const CMD_EDITOR_LINE_TYPES = ['cmd', 'note', 'warn', 'info', 'ok'];
// note/warn/info/ok são todas "linhas de texto" (sem prompt, sem export) que só
// diferem na cor/ícone de exibição (ver termRender() em terminal-renderer.js).
// Em vez de poluir o dropdown principal com 4 opções quase idênticas, elas são
// agrupadas visualmente sob um único tipo "Text" no editor; a categoria real
// (que é o line_type de fato salvo no banco — nenhuma mudança de schema) é
// escolhida num segundo dropdown que só aparece quando "Text" está selecionado.
const CMD_EDITOR_TEXT_CATEGORIES = ['info', 'ok', 'warn'];
// 'note' foi removida das categorias oferecidas para NOVAS linhas — pedido do
// usuário: "remover a opção note do text, assim já deixamos de ter o
// conflito com a note do comando" (o app já tem um conceito próprio de
// "Notes", os post-its dentro das pastas; ter também uma categoria de texto
// chamada "note" dentro do comando confundia os dois). Linhas antigas que já
// tinham line_type='note' salvo continuam funcionando (mesma cor/ícone
// roxo em terminal-renderer.js — nenhuma mudança de schema/dado), só não é
// mais possível ESCOLHER "note" numa linha nova; ver CMD_EDITOR_TEXT_CATEGORIES_LEGACY.
const CMD_EDITOR_TEXT_CATEGORIES_LEGACY = ['note'];

// O campo "Prompt" de cada linha tipo 'cmd' (ex.: "[Expert@FW]#") era texto
// livre; agora vem do catálogo Prompts (Settings → Register → Prompts, ver
// js/catalog-admin.js + server/schema.sql), igual a Vendor/System/etc. Se o
// valor atual da linha (vindo do banco) ainda não estiver cadastrado no
// catálogo — dado legado de antes desta mudança, ou um valor que o
// administrador removeu do catálogo depois — ele é preservado como uma opção
// extra no topo da lista, para nunca "sumir"/trocar sozinho o texto de um
// comando já salvo.
function _ceBuildPromptOptions(currentValue) {
  const prompts = (typeof CATALOGS !== 'undefined' && CATALOGS.prompts) || [];
  let values = prompts.map(p => p.label);
  if (currentValue && !values.includes(currentValue)) values = [currentValue, ...values];
  return values.map(v => `<option value="${_ceEscAttr(v)}"${v === currentValue ? ' selected' : ''}>${_ceEscHtml(v)}</option>`).join('');
}

let CMD_EDITOR_MODE = 'create'; // 'create' | 'edit'
let CMD_EDITOR_ORIGINAL_ID = null;
let CMD_EDITOR_RESOLVER = null; // placeholder_resolver of the row being edited (preserved as-is, never set by this UI)
// Snapshot (JSON string) of the form's state right after opening (blank form
// for 'create', or fully populated for 'edit'/'duplicate') — compared against
// the current state when the user clicks the X, to decide whether to warn
// about unsaved changes (see cmdEditorRequestClose()). null means "couldn't
// snapshot" (fails open: closes without asking rather than blocking the user).
let CMD_EDITOR_INITIAL_SNAPSHOT = null;

// Reads exactly the same fields cmdEditorSave() reads (minus derived/validated
// values like the generated id), so any change the user could actually save
// is reflected here. Used both right after opening (baseline) and right
// before closing (current) — see cmdEditorRequestClose().
function _ceSnapshotForm() {
  try {
    return JSON.stringify({
      vendors: _ceGetMultiSeg('cmdVendorSeg'),
      systems: _ceGetMultiSeg('cmdSysSeg'),
      versions: _ceGetMultiSeg('cmdVersionsSeg'),
      environments: _ceGetMultiSeg('cmdEnvSeg'),
      topics: _ceGetMultiSeg('cmdTopicSeg'),
      name: _ce('cmdName').value,
      name_empty: _ce('cmdNameEmpty').value,
      desc: _ce('cmdDesc').value,
      desc_empty: _ce('cmdDescEmpty').value,
      details: _ce('cmdDetailsEditor').innerHTML,
      lines: [
        ..._ceReadLinesFrom(_ce('cmdLinesDefaultList')),
        ..._ceReadLinesFrom(_ce('cmdLinesEmptyList')),
      ],
    });
  } catch (err) {
    // Falha ao ler o formulário (ex.: DOM inesperado) não deve travar o
    // usuário dentro do modal — melhor deixar fechar sem perguntar do que
    // impedir o fechamento por completo.
    console.error('_ceSnapshotForm failed', err);
    return null;
  }
}

// ════════════════════════════════════════════════
// WIZARD — 3 steps: 1) Identification, 2) Scope (Vendor/System/Version/
// Environment/Topic), 3) Command lines. Navigation is linear-with-validation:
// "Next" only advances (and unlocks the step indicator button) once the
// CURRENT step's required fields are filled; "Back" and clicking an
// already-unlocked step in the indicator are always free. In edit/duplicate
// mode every step starts unlocked (the command already has valid data
// everywhere), so you can jump straight to whatever section needs a change
// instead of having to re-walk the whole wizard — see openCommandEditor() below.
// ════════════════════════════════════════════════
const CMD_WIZ_TOTAL_STEPS = 3;
let CMD_WIZ_STEP = 1;
let CMD_WIZ_MAX_STEP = 1; // furthest step unlocked so far (indicator buttons beyond this are disabled)
// Whether the current command *may* be deleted by this user (owner or admin —
// see canDeleteThis in _cePopulateForm) — the button itself is only ever shown
// on the last wizard step (see _ceRenderWizardState), regardless of this flag.
let CMD_EDITOR_CAN_DELETE = false;

// Per-step blocking validation — mirrors (a subset of) the final check in
// cmdEditorSave(), just split by which step each field lives in, so the user
// can be told exactly what's missing without leaving the step it belongs to.
function _ceValidateStep(step) {
  if (step === 1) {
    if (!_ce('cmdName').value.trim()) return 'Fill in the command Name before continuing.';
    return null;
  }
  if (step === 2) {
    const vendors = _ceGetMultiSeg('cmdVendorSeg');
    const systems = _ceGetMultiSeg('cmdSysSeg');
    const versions = _ceGetMultiSeg('cmdVersionsSeg');
    const environments = _ceGetMultiSeg('cmdEnvSeg');
    const topics = _ceGetMultiSeg('cmdTopicSeg');
    if (!vendors.length || !systems.length || !versions.length || !environments.length || !topics.length) {
      return 'Check at least one option in Vendor, Systems, Versions, Environments and Topic before continuing.';
    }
    return null;
  }
  return null; // step 3 (lines) has no blocking requirement today
}

function _ceRenderWizardState() {
  document.querySelectorAll('.wiz-panel').forEach(p => {
    p.style.display = (Number(p.dataset.step) === CMD_WIZ_STEP) ? '' : 'none';
  });
  document.querySelectorAll('.wiz-step').forEach(b => {
    const s = Number(b.dataset.step);
    b.classList.toggle('on', s === CMD_WIZ_STEP);
    b.classList.toggle('done', s !== CMD_WIZ_STEP && s <= CMD_WIZ_MAX_STEP);
    b.disabled = s > CMD_WIZ_MAX_STEP;
  });
  // Pedido do usuário: "mantenha sempre na mesma posição os botões back e
  // next" — Back fica SEMPRE renderizado (nunca display:none), só desabilitado
  // no passo 1 (não existe passo anterior). Antes ele sumia (display:none) no
  // passo 1, o que deslocava o Next pra esquerda ali e criava uma posição
  // inconsistente entre os passos — .disabled aplica .btn:disabled (opacidade
  // reduzida, cursor not-allowed, ver css/components.css) sem tirar o botão
  // do layout.
  _ce('cmdWizBackBtn').disabled = CMD_WIZ_STEP <= 1;
  // Pedido do usuário: "deixe os tres botões nas tres telas de edição" — em
  // modo 'edit', Next fica SEMPRE renderizado (mesmo padrão do Back acima),
  // só desabilitado no último passo (não há próximo passo pra ir; clicar ali
  // já era um no-op em cmdWizNext(), então desabilitar é só feedback visual).
  // Em 'create'/'duplicate' mantém o comportamento antigo: Next some no
  // último passo, dando lugar ao Save sozinho ali (ver abaixo).
  _ce('cmdWizNextBtn').style.display =
    (CMD_EDITOR_MODE === 'edit' || CMD_WIZ_STEP < CMD_WIZ_TOTAL_STEPS) ? '' : 'none';
  _ce('cmdWizNextBtn').disabled = CMD_EDITOR_MODE === 'edit' && CMD_WIZ_STEP >= CMD_WIZ_TOTAL_STEPS;
  // Pedido do usuário: "deixe o botão de save após o next nas tres telas ao
  // editar o comando" — em modo 'edit' (comando já existente, todos os
  // passos já começam válidos/desbloqueados — ver openCommandEditor), Save
  // fica visível nos 3 passos, sempre depois do Next (mesma ordem de sempre
  // no DOM/index.html — ver .modal-foot). Em 'create' (e duplicate, que usa
  // CMD_EDITOR_MODE='create' — ver openCommandEditor) continua só no último
  // passo, já que ali faz sentido guiar o preenchimento passo a passo antes
  // de liberar o Save.
  _ce('cmdWizSaveBtn').style.display =
    (CMD_EDITOR_MODE === 'edit' || CMD_WIZ_STEP === CMD_WIZ_TOTAL_STEPS) ? '' : 'none';
  // Delete só aparece no último passo (Command lines) — nos passos anteriores
  // fica oculto mesmo que o usuário tenha permissão (CMD_EDITOR_CAN_DELETE),
  // para não competir visualmente com Next antes da revisão final. Ele mora
  // separado do grupo Back/Next/Save (ver index.html), depois da nota "*
  // required field" — quando aparece, fica isolado no canto direito do
  // rodapé, sem afetar a posição de Back/Next.
  _ce('cmdEditorDeleteBtn').style.display =
    (CMD_EDITOR_CAN_DELETE && CMD_WIZ_STEP === CMD_WIZ_TOTAL_STEPS) ? '' : 'none';
}

// Jump to an already-unlocked step (indicator click) — no-op if the target
// step hasn't been unlocked yet (can't skip ahead of validation).
function cmdWizGoTo(step) {
  if (step === CMD_WIZ_STEP || step > CMD_WIZ_MAX_STEP) return;
  CMD_WIZ_STEP = step;
  _ceHideError();
  _ceRenderWizardState();
}
function cmdWizNext() {
  const err = _ceValidateStep(CMD_WIZ_STEP);
  if (err) { _ceShowError(err); return; }
  _ceHideError();
  if (CMD_WIZ_STEP < CMD_WIZ_TOTAL_STEPS) CMD_WIZ_STEP += 1;
  if (CMD_WIZ_STEP > CMD_WIZ_MAX_STEP) CMD_WIZ_MAX_STEP = CMD_WIZ_STEP;
  _ceRenderWizardState();
}
function cmdWizBack() {
  if (CMD_WIZ_STEP > 1) CMD_WIZ_STEP -= 1;
  _ceHideError();
  _ceRenderWizardState();
}
// Authoritative jump used by cmdEditorSave()'s final validation — unlike
// cmdWizGoTo, this always navigates (and unlocks as needed), so a save-time
// error can surface on whichever step actually has the problem even if the
// user reached the last step by other means (e.g. edit mode starts fully
// unlocked, so Next's per-step gate can be bypassed there).
function _ceForceGoToStep(step) {
  CMD_WIZ_STEP = step;
  if (step > CMD_WIZ_MAX_STEP) CMD_WIZ_MAX_STEP = step;
  _ceRenderWizardState();
}
function _ceResetWizard() {
  CMD_WIZ_STEP = 1;
  CMD_WIZ_MAX_STEP = 1;
  _ceRenderWizardState();
}

function _ce(id) { return document.getElementById(id); }
function _ceEscAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function _ceEscHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── single-select seg group (topic) ──────────────
function _ceBindSingleSeg(containerId) {
  const c = _ce(containerId);
  if (!c) return;
  c.addEventListener('click', ev => {
    const btn = ev.target.closest('.seg-btn');
    if (!btn) return;
    c.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
  });
}
function _ceSetSingleSeg(containerId, val) {
  document.querySelectorAll('#' + containerId + ' .seg-btn').forEach(b => b.classList.toggle('on', b.dataset.val === val));
}
function _ceGetSingleSeg(containerId) {
  const b = document.querySelector('#' + containerId + ' .seg-btn.on');
  return b ? b.dataset.val : null;
}
// ── multi-select seg group (versions / environments / topic) ─
// Version/Environment/Topic now live inside a dropdown (.dd/.dd-btn, same
// pattern as the Settings modal) instead of a loose list of chips — the
// optional parameters below (ddBtnId/allLabel/pluralLabel) update the
// dropdown button text on every click/change. `allLabel` only applies to
// Version/Environment (none checked = applies to all) — Topic requires at
// least 1 checked, so it passes null.
function _ceBindMultiSeg(containerId, ddBtnId, allLabel, pluralLabel, onToggle) {
  const c = _ce(containerId);
  if (!c) return;
  c.addEventListener('click', ev => {
    const btn = ev.target.closest('.seg-btn');
    if (!btn) return;
    btn.classList.toggle('on');
    if (ddBtnId) _ceUpdateMultiSegDDLabel(containerId, ddBtnId, allLabel, pluralLabel);
    if (typeof onToggle === 'function') onToggle();
  });
}
function _ceSetMultiSeg(containerId, vals, ddBtnId, allLabel, pluralLabel) {
  const set = new Set(vals || []);
  document.querySelectorAll('#' + containerId + ' .seg-btn').forEach(b => b.classList.toggle('on', set.has(b.dataset.val)));
  if (ddBtnId) _ceUpdateMultiSegDDLabel(containerId, ddBtnId, allLabel, pluralLabel);
}
function _ceGetMultiSeg(containerId) {
  return [...document.querySelectorAll('#' + containerId + ' .seg-btn.on')].map(b => b.dataset.val);
}
// ── Vendor and System are single-select, not multi ──────────────
// A command belongs to exactly one Vendor and exactly one System (unlike
// Version/Environment/Topic, which a command can have several of) — clicking
// an option always selects ONLY that one (like a radio button: no toggle-off,
// no stacking with a previous pick), still using the same .seg-btn/.on markup
// and dropdown-label mechanics as the multi-select fields above so the rest
// of the code (_ceGetMultiSeg('cmdVendorSeg'/'cmdSysSeg'), _ceApplyEditorCascade,
// the payload builder, etc.) keeps working unchanged — it just never sees more
// than 1 item selected. Since only one option can ever end up checked, the
// dropdown also closes itself right after the click — no reason to make the
// user close it manually like the genuinely multi-select fields below.
function _ceBindSingleSeg(containerId, ddBtnId) {
  const c = _ce(containerId);
  if (!c) return;
  c.addEventListener('click', ev => {
    const btn = ev.target.closest('.seg-btn');
    if (!btn) return;
    c.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b === btn));
    _ceUpdateMultiSegDDLabel(containerId, ddBtnId, null, 'selected');
    if (typeof _ceApplyEditorCascade === 'function') _ceApplyEditorCascade();
    const dd = c.closest('.dd');
    if (dd) dd.classList.remove('open');
  });
}
function _ceSetSingleSeg(containerId, vals, ddBtnId) {
  const val = Array.isArray(vals) ? vals[0] : vals;
  document.querySelectorAll('#' + containerId + ' .seg-btn').forEach(b => b.classList.toggle('on', val != null && b.dataset.val === val));
  _ceUpdateMultiSegDDLabel(containerId, ddBtnId, null, 'selected');
}
// Dropdown button text: 0 checked (Version/Environment only) = allLabel;
// 1 checked = that item's label; 2+ = "N " + pluralLabel.
function _ceUpdateMultiSegDDLabel(containerId, ddBtnId, allLabel, pluralLabel) {
  const btn = _ce(ddBtnId);
  const label = btn && btn.querySelector('.dd-label');
  if (!label) return;
  const sel = _ceGetMultiSeg(containerId);
  if (!sel.length) { label.textContent = allLabel || '0'; return; }
  if (sel.length === 1) {
    const b = [...document.querySelectorAll('#' + containerId + ' .seg-btn')].find(x => x.dataset.val === sel[0]);
    label.textContent = b ? b.textContent.trim() : sel[0];
    return;
  }
  label.textContent = pluralLabel ? `${sel.length} ${pluralLabel}` : String(sel.length);
}
// Called by js/catalogs.js (renderCatalogUI) after rebuilding the 3 dropdowns
// (version/environment/topic catalog changed in admin mode) — without this
// the button text would be stale (the selection itself is preserved by
// ccSet, only the label isn't).
function _ceRefreshMultiSegDDLabels() {
  _ceUpdateMultiSegDDLabel('cmdVendorSeg', 'cmdVendorDDBtn', null, 'selected');
  _ceUpdateMultiSegDDLabel('cmdSysSeg', 'cmdSysDDBtn', null, 'selected');
  _ceUpdateMultiSegDDLabel('cmdVersionsSeg', 'cmdVersionsDDBtn', null, 'selected');
  _ceUpdateMultiSegDDLabel('cmdEnvSeg', 'cmdEnvDDBtn', null, 'selected');
  _ceUpdateMultiSegDDLabel('cmdTopicSeg', 'cmdTopicDDBtn', null, 'selected');
}

// ── Cascata Vendor → Sistema → Versão dentro do PRÓPRIO editor ──
// Diferente da cascata dos filtros (ccRefreshCascade em js/catalogs.js, que só
// aplica uma classe visual sobre a seleção da SIDEBAR/modal de Configurações),
// aqui as opções que não pertencem ao(s) Vendor(s)/Sistema(s) MARCADOS NESTE
// FORMULÁRIO são realmente escondidas (não só marcadas como desabilitadas) —
// já que não existe conceito de "All" no cadastro (Vendor/System/Version são
// obrigatórios, ver validação em cmdEditorSave), então não faz sentido listar
// Sistemas de um fabricante não selecionado, nem Versões de um sistema não
// selecionado. Roda: (a) a cada clique em cmdVendorSeg/cmdSysSeg (via o
// onToggle passado a _ceBindMultiSeg abaixo), e (b) sempre que o formulário é
// resetado/populado ou o catálogo é recarregado (chamado a partir de
// _ceResetForm/_cePopulateForm aqui, e de renderCatalogUI em catalogs.js).
function _ceApplyEditorCascade() {
  const catalogs = (typeof CATALOGS !== 'undefined') ? CATALOGS : null;
  if (!catalogs) return;

  const vendors = _ceGetMultiSeg('cmdVendorSeg');
  const allowedSystems = new Set(
    vendors.length ? (catalogs.systems || []).filter(s => vendors.includes(s.vendor)).map(s => s.key) : []
  );
  let sysChanged = false;
  document.querySelectorAll('#cmdSysSeg .seg-btn[data-val]').forEach(btn => {
    const allowed = allowedSystems.has(btn.dataset.val);
    btn.style.display = allowed ? '' : 'none';
    if (!allowed && btn.classList.contains('on')) { btn.classList.remove('on'); sysChanged = true; }
  });
  if (sysChanged) _ceUpdateMultiSegDDLabel('cmdSysSeg', 'cmdSysDDBtn', null, 'selected');

  const systems = _ceGetMultiSeg('cmdSysSeg');
  const allowedVersions = new Set(
    systems.length ? (catalogs.versions || []).filter(v => systems.includes(v.system)).map(v => v.key) : []
  );
  let verChanged = false;
  document.querySelectorAll('#cmdVersionsSeg .seg-btn[data-val]').forEach(btn => {
    const allowed = allowedVersions.has(btn.dataset.val);
    btn.style.display = allowed ? '' : 'none';
    if (!allowed && btn.classList.contains('on')) { btn.classList.remove('on'); verChanged = true; }
  });
  if (verChanged) _ceUpdateMultiSegDDLabel('cmdVersionsSeg', 'cmdVersionsDDBtn', null, 'selected');

  // Ambiente também tem Sistema relacionado agora (environments.system, ver
  // server/schema.sql) — mesmo tratamento de Versão logo acima, só que o FK
  // direto dele é Sistema (não precisa herdar de Vendor como Versão faria se
  // Sistema estivesse vazio: aqui usamos `systems` diretamente, igual à Versão
  // já faz).
  const allowedEnvironments = new Set(
    systems.length ? (catalogs.environments || []).filter(e => systems.includes(e.system)).map(e => e.key) : []
  );
  let envChanged = false;
  document.querySelectorAll('#cmdEnvSeg .seg-btn[data-val]').forEach(btn => {
    const allowed = allowedEnvironments.has(btn.dataset.val);
    btn.style.display = allowed ? '' : 'none';
    if (!allowed && btn.classList.contains('on')) { btn.classList.remove('on'); envChanged = true; }
  });
  if (envChanged) _ceUpdateMultiSegDDLabel('cmdEnvSeg', 'cmdEnvDDBtn', null, 'selected');
}

// ── error banner ──────────────────────────────────
function _ceShowError(msg) {
  const el = _ce('cmdEditorError');
  el.textContent = msg;
  el.classList.add('show');
}
function _ceHideError() {
  const el = _ce('cmdEditorError');
  el.textContent = '';
  el.classList.remove('show');
}

// ════════════════════════════════════════════════
// Repeatable list rows: command lines
// ════════════════════════════════════════════════
// opts.allowImage (default true) controls whether the 'image' line type is
// offered at all.
function _ceBuildLineRow(data, opts) {
  data = data || { line_type: 'cmd', prompt: '[Expert@FW]#', content: '', supports_export: false, image_data: '' };
  const allowImage = !opts || opts.allowImage !== false;
  // O dropdown principal só oferece cmd / image / text (ordem alfabética) —
  // note/warn/info/ok viram categorias do tipo "text" (ver comentário em
  // CMD_EDITOR_TEXT_CATEGORIES).
  const availableTypes = allowImage ? ['cmd', 'image', 'text'] : ['cmd', 'text'];
  // isTextCategory também reconhece a categoria legada 'note' (ver
  // CMD_EDITOR_TEXT_CATEGORIES_LEGACY) — uma linha antiga tipo 'note' precisa
  // continuar abrindo como "Text" no dropdown principal, não como "cmd".
  const isTextCategory = CMD_EDITOR_TEXT_CATEGORIES.includes(data.line_type) || CMD_EDITOR_TEXT_CATEGORIES_LEGACY.includes(data.line_type);
  const displayType = isTextCategory ? 'text' : data.line_type;
  const selectedCategory = isTextCategory ? data.line_type : CMD_EDITOR_TEXT_CATEGORIES[0];
  const row = document.createElement('div');
  row.className = 'line-row';
  const typeOptions = availableTypes.map(lt => `<option value="${lt}"${lt === displayType ? ' selected' : ''}>${lt}</option>`).join('');
  // Cor de cada <option> = a mesma cor que a linha vai ganhar na tela quando
  // renderizada (ver .ln-info/.ln-note/.ln-ok/.ln-warn em css/components.css
  // e termRender() em js/terminal-renderer.js) — pedido do usuário: "no campos
  // de text coloque a cor que será exibida na tela em cada opção".
  const CMD_EDITOR_TEXT_CATEGORY_COLORS = { info: 'var(--blue)', note: 'var(--purple)', ok: 'var(--green)', warn: 'var(--orange)' };
  let categoryOptions = CMD_EDITOR_TEXT_CATEGORIES.map(c => `<option value="${c}"${c === selectedCategory ? ' selected' : ''} style="color:${CMD_EDITOR_TEXT_CATEGORY_COLORS[c]};">${c}</option>`).join('');
  // Se a linha já salva tem a categoria legada 'note' (removida das opções
  // oferecidas — ver comentário em CMD_EDITOR_TEXT_CATEGORIES_LEGACY), ela
  // ganha uma opção extra oculta no topo, só para não trocar sozinha de
  // categoria/cor quando o usuário reabre e salva a linha sem mexer nela
  // (mesmo padrão já usado para Prompt legado, ver _ceBuildPromptOptions).
  if (CMD_EDITOR_TEXT_CATEGORIES_LEGACY.includes(selectedCategory)) {
    categoryOptions = `<option value="${selectedCategory}" selected style="display:none;color:${CMD_EDITOR_TEXT_CATEGORY_COLORS[selectedCategory]};">${selectedCategory}</option>` + categoryOptions;
  }
  const promptOptions = _ceBuildPromptOptions(data.prompt);
  row.innerHTML = `
    <div class="row-head">
      <span class="ln-drag-handle" title="Drag to reorder" onmousedown="_ceArmLineDrag(this)">
        <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.4"/><circle cx="7.5" cy="2.5" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13.5" r="1.4"/><circle cx="7.5" cy="13.5" r="1.4"/></svg>
      </span>
      <select class="set-input ln-type" style="max-width:100px;">${typeOptions}</select>
      <select class="set-input ln-text-category" style="max-width:90px;display:none;">${categoryOptions}</select>
      <select class="set-input ln-prompt" style="max-width:180px;">${promptOptions}</select>
      <div class="dd ln-var-dd">
        <button type="button" class="dd-btn btn btn-ghost btn-sm" onclick="_ceToggleVarDropdown(this)">
          <span class="dd-label">Insert variable</span><span class="dd-arrow">▾</span>
        </button>
        <div class="dd-panel seg ln-var-panel">
          ${_ceBuildVarDDItems()}
          <div class="dd-panel-foot"><button type="button" class="btn btn-ghost" onclick="_ceToggleVarDropdown(this)">Close</button></div>
        </div>
      </div>
      <label class="ln-export-label" title="When checked, the sidebar &quot;Export&quot; toggle automatically appends ' &gt; path' to this command's output.">
        <input type="checkbox" class="ln-export"${data.supports_export ? ' checked' : ''}>
        <span>Exportable</span>
      </label>
      <button type="button" class="btn btn-ghost btn-sm row-remove-btn">✕ Remove</button>
    </div>
    <div class="set-row">
      <div class="set-group ln-content-group">
        <span class="set-label ln-content-label">Content</span>
        <textarea class="set-input ln-content">${_ceEscHtml(data.content)}</textarea>
      </div>
    </div>
    <div class="set-row ln-image-controls" style="display:none;">
      <div class="set-group" style="flex:1;">
        <span class="set-label">Configuration image</span>
        <span class="set-hint">Drag an image here, click the box and paste (Ctrl+V) a screenshot, or use the button below to browse files.</span>
        <div class="ln-image-dropzone" tabindex="0"
             ondragover="event.preventDefault(); this.classList.add('dragover');"
             ondragleave="this.classList.remove('dragover');"
             ondrop="_ceHandleImageDrop(event, this)">
          <img class="ln-image-preview" style="display:none;" alt="">
          <span class="ln-image-placeholder">📷 Drag an image here, or paste it (Ctrl+V)</span>
          <button type="button" class="btn btn-ghost btn-sm ln-image-upload-btn" onclick="event.stopPropagation(); _ceOpenImageFilePicker(this)">📁 Choose file…</button>
        </div>
        <input type="file" class="ln-image-file" accept="image/*" style="display:none;" onchange="_ceHandleImageFileInput(this)">
        <input type="hidden" class="ln-image-data">
        <div class="ln-image-actions" style="display:none;">
          <button type="button" class="btn btn-ghost btn-sm ln-image-remove-btn" onclick="_ceRemoveLineImage(this)">✕ Remove image</button>
        </div>
      </div>
    </div>
  `;
  row.querySelector('.row-remove-btn').addEventListener('click', () => row.remove());
  const typeSel = row.querySelector('.ln-type');
  const categorySel = row.querySelector('.ln-text-category');
  const promptInput = row.querySelector('.ln-prompt');
  const exportLabel = row.querySelector('.ln-export-label');
  const varDD = row.querySelector('.ln-var-dd');
  const imageControls = row.querySelector('.ln-image-controls');
  const contentLabel = row.querySelector('.ln-content-label');
  const contentTextarea = row.querySelector('.ln-content');
  const syncPromptVisibility = () => {
    const isCmd = typeSel.value === 'cmd';
    const isImage = typeSel.value === 'image';
    const isText = typeSel.value === 'text';
    promptInput.style.display = isCmd ? '' : 'none';
    exportLabel.style.display = isCmd ? '' : 'none';
    varDD.style.display = isCmd ? '' : 'none';
    imageControls.style.display = isImage ? '' : 'none';
    categorySel.style.display = isText ? '' : 'none';
    contentLabel.textContent = isImage ? 'Name' : 'Content';
    contentTextarea.placeholder = isImage ? 'Name shown instead of the command, e.g. "VPN tunnel configuration"' : '';
  };
  typeSel.addEventListener('change', syncPromptVisibility);
  syncPromptVisibility();
  // Preenche a imagem já salva (modo edição) sem precisar reconstruir o HTML
  // com o base64 embutido — evita gerar/escapar uma string potencialmente
  // grande na montagem do template acima.
  if (data.image_data) _ceSetImagePreview(row, data.image_data);
  return row;
}
function cmdEditorAddLine(containerId, data, opts) { _ce(containerId).appendChild(_ceBuildLineRow(data, opts)); }

// ── Linha de imagem (screenshot de configuração) ───────────────────────
// A imagem é guardada como data URI base64 (command_lines.image_data — ver
// schema.sql) e viaja dentro do JSON do comando, sem endpoint de upload
// separado. Duas formas de preenchê-la: escolher um arquivo (input file
// disparado pelo clique na caixa) ou colar (Ctrl+V) com a caixa focada.
function _ceOpenImageFilePicker(dropzoneEl) {
  const row = dropzoneEl.closest('.line-row');
  const input = row && row.querySelector('.ln-image-file');
  if (input) input.click();
}
function _ceHandleImageFileInput(input) {
  const row = input.closest('.line-row');
  const file = input.files && input.files[0];
  if (row && file) _ceLoadImageFile(row, file);
  input.value = ''; // permite selecionar o mesmo arquivo de novo depois
}
function _ceLoadImageFile(row, file) {
  if (!row || !file) return;
  const reader = new FileReader();
  reader.onload = () => _ceSetImagePreview(row, reader.result);
  reader.readAsDataURL(file);
}
// Arrastar-e-soltar um arquivo de imagem sobre a caixa (.ln-image-dropzone).
// A classe 'dragover' (feedback visual, ver css/components.css) é adicionada
// no ondragover inline do próprio elemento e removida aqui e no ondragleave.
function _ceHandleImageDrop(ev, dropzoneEl) {
  ev.preventDefault();
  dropzoneEl.classList.remove('dragover');
  const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
  const row = dropzoneEl.closest('.line-row');
  if (row && file && file.type && file.type.startsWith('image/')) _ceLoadImageFile(row, file);
}
function _ceSetImagePreview(row, dataUrl) {
  const hidden = row.querySelector('.ln-image-data');
  const img = row.querySelector('.ln-image-preview');
  const placeholder = row.querySelector('.ln-image-placeholder');
  const actions = row.querySelector('.ln-image-actions');
  if (hidden) hidden.value = dataUrl || '';
  if (img) { img.src = dataUrl || ''; img.style.display = dataUrl ? '' : 'none'; }
  if (placeholder) placeholder.style.display = dataUrl ? 'none' : '';
  if (actions) actions.style.display = dataUrl ? '' : 'none';
}
function _ceRemoveLineImage(btn) {
  const row = btn.closest('.line-row');
  if (row) _ceSetImagePreview(row, '');
}
// Listener único a nível de documento (mesmo padrão do drag-to-reorder logo
// abaixo) — o evento 'paste' é despachado para o elemento focado; checamos
// se é (ou está dentro de) uma caixa de imagem antes de agir, para não
// interferir com colar texto em outros campos do formulário.
document.addEventListener('paste', ev => {
  const active = document.activeElement;
  const dropzone = active && active.closest && active.closest('.ln-image-dropzone');
  if (!dropzone) return;
  const items = (ev.clipboardData && ev.clipboardData.items) || [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        _ceLoadImageFile(dropzone.closest('.line-row'), file);
        ev.preventDefault();
      }
      break;
    }
  }
});
// "Insert variable" panel: lists the parameters registered in the catalog
// (CATALOGS.parameters) and inserts {{key}} into the command content
// textarea at the cursor position.
function _ceBuildVarDDItems() {
  const params = (typeof CATALOGS !== 'undefined' && CATALOGS.parameters) || [];
  if (!params.length) {
    return `<div class="set-hint">No parameters registered</div>`;
  }
  return params.map(p => {
    const label = p.label || p.key;
    return `<button type="button" class="seg-btn" onclick="_ceInsertVariable(this, '${_ceEscAttr(p.key)}')">${_ceEscHtml(label)}</button>`;
  }).join('');
}
function _ceToggleVarDropdown(btn) {
  const dd = btn.closest('.dd');
  if (!dd) return;
  const willOpen = !dd.classList.contains('open');
  document.querySelectorAll('.dd.open').forEach(d => { if (d !== dd) d.classList.remove('open'); });
  dd.classList.toggle('open', willOpen);
}
function _ceInsertVariable(btn, key) {
  const row = btn.closest('.line-row');
  const dd = btn.closest('.dd');
  const ta = row && row.querySelector('.ln-content');
  if (ta) {
    const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    const token = '{{' + key + '}}';
    ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
    const newPos = start + token.length;
    ta.focus();
    ta.setSelectionRange(newPos, newPos);
  }
  if (dd) dd.classList.remove('open');
}
// ── Drag-to-reorder for command lines ──────────────────────────────────
// sort_order is derived purely from DOM order at save time (see
// _ceReadLinesFrom below), so moving a .line-row in the DOM is the entire
// reorder operation — nothing else needs to track position. Works the same
// way for the Default list and the Empty-state list, since it only ever
// reorders a row among its own siblings (drag is rejected if hovering over
// a row from a different list).
// Drag is armed only via mousedown on the small grip handle (⠿), not the
// whole row, so selecting/editing text inside the content textarea is
// unaffected.
function _ceArmLineDrag(handle) {
  const row = handle.closest('.line-row');
  if (row) row.setAttribute('draggable', 'true');
}
document.addEventListener('mouseup', () => {
  document.querySelectorAll('.line-row[draggable="true"]').forEach(r => r.removeAttribute('draggable'));
});
let _ceDragLineRow = null;
document.addEventListener('dragstart', ev => {
  const row = ev.target.closest && ev.target.closest('.line-row');
  if (!row || !row.hasAttribute('draggable')) return;
  _ceDragLineRow = row;
  row.classList.add('dragging');
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', ''); // required by Firefox to allow the drag
});
document.addEventListener('dragover', ev => {
  if (!_ceDragLineRow) return;
  const overRow = ev.target.closest && ev.target.closest('.line-row');
  if (!overRow || overRow === _ceDragLineRow || overRow.parentElement !== _ceDragLineRow.parentElement) return;
  ev.preventDefault();
  const rect = overRow.getBoundingClientRect();
  const before = (ev.clientY - rect.top) < rect.height / 2;
  overRow.parentElement.insertBefore(_ceDragLineRow, before ? overRow : overRow.nextSibling);
});
document.addEventListener('drop', ev => { if (_ceDragLineRow) ev.preventDefault(); });
document.addEventListener('dragend', ev => {
  const row = ev.target.closest && ev.target.closest('.line-row');
  if (row) { row.classList.remove('dragging'); row.removeAttribute('draggable'); }
  _ceDragLineRow = null;
});

function _ceReadLinesFrom(containerEl) {
  return [...containerEl.querySelectorAll('.line-row')].map((row, i) => {
    const rawType = row.querySelector('.ln-type').value;
    // "text" não é um line_type de verdade — é só o rótulo do dropdown principal
    // que agrupa note/warn/info/ok; o valor real salvo vem do dropdown de categoria.
    const categorySel = row.querySelector('.ln-text-category');
    const lineType = rawType === 'text' && categorySel ? categorySel.value : rawType;
    const imageDataInput = row.querySelector('.ln-image-data'); // ausente quando allowImage:false
    return {
      sort_order: i,
      line_type: lineType,
      prompt: lineType === 'cmd' ? (row.querySelector('.ln-prompt').value || null) : null,
      content: row.querySelector('.ln-content').value || '', // para line_type='image', é o Nome exibido
      supports_export: lineType === 'cmd' ? row.querySelector('.ln-export').checked : false,
      image_data: lineType === 'image' && imageDataInput ? (imageDataInput.value || null) : null,
    };
  });
}

// ════════════════════════════════════════════════
// Reset / populate / open / close
// ════════════════════════════════════════════════
function _ceResetForm() {
  _ceSetMultiSeg('cmdTopicSeg', ['capture'], 'cmdTopicDDBtn', null, 'selected');
  ['cmdName', 'cmdNameEmpty', 'cmdDesc', 'cmdDescEmpty']
    .forEach(id => { _ce(id).value = ''; });
  // `details` substitui about_purpose/when/obs (rich text, ver index.html) —
  // não é um .value, é o innerHTML do editor contenteditable.
  _ce('cmdDetailsEditor').innerHTML = '';
  // Dropdown de tamanho de fonte "estilo Word" (lista de opções, ver
  // index.html/js/folders.js) — volta pro padrão (12) a cada reset, já que o
  // modal é reaproveitado (não recriado) entre uma edição e outra; sem isso
  // o botão continuaria mostrando o último tamanho clicado na edição
  // anterior.
  _neResetFontSizeUI('cmdDetailsFontSizeLabel', 'cmdDetailsFontSizeList');
  _ceSetSingleSeg('cmdVendorSeg', [], 'cmdVendorDDBtn');
  _ceSetSingleSeg('cmdSysSeg', [], 'cmdSysDDBtn');
  _ceSetMultiSeg('cmdVersionsSeg', [], 'cmdVersionsDDBtn', null, 'selected');
  _ceSetMultiSeg('cmdEnvSeg', [], 'cmdEnvDDBtn', null, 'selected');
  _ceApplyEditorCascade();
  _ce('cmdLinesDefaultList').innerHTML = '';
  _ce('cmdLinesEmptyList').innerHTML = '';
  _ceHideError();
  _ce('cmdEditorResolverWarning').classList.remove('show');
  CMD_EDITOR_CAN_DELETE = false;
  cmdEditorAddLine('cmdLinesDefaultList'); // one blank starter line, convenience only
  _ceResetWizard(); // back to step 1, locked (create/duplicate walk the wizard step by step) — also re-renders the (hidden) Delete button via _ceRenderWizardState
}

async function _cePopulateForm(id) {
  const list = await fetchCommands();
  const row = list.find(c => c.id === id);
  if (!row) throw new Error('Command not found: ' + id);

  _ceSetMultiSeg('cmdTopicSeg', row.topics || [row.topic], 'cmdTopicDDBtn', null, 'selected');
  _ce('cmdName').value = row.name || '';
  _ce('cmdNameEmpty').value = row.name_empty || '';
  _ce('cmdDesc').value = row.desc || '';
  _ce('cmdDescEmpty').value = row.desc_empty || '';
  _ce('cmdDetailsEditor').innerHTML = row.details || '';
  _neResetFontSizeUI('cmdDetailsFontSizeLabel', 'cmdDetailsFontSizeList'); // mostra o padrão até o usuário clicar no texto (ver _neUpdateToolbarState)

  _ceSetSingleSeg('cmdVendorSeg', row.vendors || [], 'cmdVendorDDBtn');
  _ceSetSingleSeg('cmdSysSeg', row.systems || [], 'cmdSysDDBtn');
  _ceSetMultiSeg('cmdVersionsSeg', row.versions || [], 'cmdVersionsDDBtn', null, 'selected');
  _ceSetMultiSeg('cmdEnvSeg', row.environments || [], 'cmdEnvDDBtn', null, 'selected');
  _ceApplyEditorCascade();

  _ce('cmdLinesDefaultList').innerHTML = '';
  ((row.lines && row.lines.default) || []).forEach(l => {
    cmdEditorAddLine('cmdLinesDefaultList', { line_type: l.line_type, prompt: l.prompt, content: l.content, supports_export: !!l.supports_export, image_data: l.image_data || '' });
  });

  // cmdLinesEmptyList/cmdNameEmpty/cmdDescEmpty continuam sendo carregados
  // mesmo sem nenhum controle de UI que os exiba — são a variante 'empty'
  // usada por requires_ip_port (ex.: tcpdumpipport), que nunca teve
  // toggle próprio nesta tela (ver comentário em server/index.js
  // buildCommandColumns). Preservar os valores aqui evita que salvar um
  // comando existente com essa flag apague silenciosamente seus dados.
  _ce('cmdLinesEmptyList').innerHTML = '';
  ((row.lines && row.lines.empty) || []).forEach(l => {
    cmdEditorAddLine('cmdLinesEmptyList', { line_type: l.line_type, prompt: l.prompt, content: l.content, supports_export: !!l.supports_export, image_data: l.image_data || '' });
  });

  CMD_EDITOR_RESOLVER = row.placeholder_resolver || null;
  _ce('cmdEditorResolverWarning').classList.toggle('show', !!CMD_EDITOR_RESOLVER);
  // Excluir comando: dono (created_by === CURRENT_USER) OU admin — mesma
  // regra do editar (ver isOwn abaixo em openCommandEditor) e do servidor
  // (DELETE /api/commands/:id em server/index.js). Um comando 'System' ou
  // de outro usuário nunca bate com CURRENT_USER, então continua exigindo
  // admin automaticamente, sem precisar de um caso especial aqui.
  const canDeleteThis = window.TB45_IS_ADMIN || (typeof CURRENT_USER !== 'undefined' && CURRENT_USER === row.created_by);
  // Só guarda a permissão aqui — a visibilidade real do botão (também exige
  // estar no último passo do wizard) é decidida em _ceRenderWizardState().
  CMD_EDITOR_CAN_DELETE = canDeleteThis;
  _ce('cmdEditorDeleteBtn').dataset.name = row.name || id;
  return row;
}

async function openCommandEditor(mode, id, ev) {
  // Incluir/duplicar/editar agora são recursos disponíveis para todos os
  // usuários (não dependem mais de 'Admin mode' em Configurações — ver
  // COMMAND_EDITING_ENABLED em js/settings.js, que hoje só controla o
  // gerenciamento de catálogos e o default de System commands).
  const isDuplicate = mode === 'duplicate';
  // Duplicating is, for save purposes, a 'create': it generates a new command (new id),
  // just pre-filled with the source command's data instead of a blank form.
  CMD_EDITOR_MODE = isDuplicate ? 'create' : mode;
  CMD_EDITOR_ORIGINAL_ID = mode === 'edit' ? id : null;
  CMD_EDITOR_RESOLVER = null;
  _ceResetForm();

  if (mode === 'edit' || isDuplicate) {
    let row;
    try {
      row = await _cePopulateForm(id);
    } catch (err) {
      console.error('Failed to open command editor for ' + mode, err);
      alert('Failed to save the command. Please try again.');
      return;
    }
    // Um usuário comum edita o PRÓPRIO comando OU um comando de referência
    // (created_by='System') — pedido do usuário: "todos usuários podem
    // alterar os comandos do sistema". Só o comando de OUTRO usuário
    // continua bloqueado. O botão Edit já reflete essa mesma regra (ver
    // terminal-renderer.js), mas repetimos a checagem aqui como defesa em
    // profundidade (ex.: chamada direta via console) antes de abrir o
    // formulário de edição. O servidor também recusa com 403 (ver PUT
    // /api/commands/:id em server/index.js) — esta checagem só evita abrir
    // a tela para nada.
    if (mode === 'edit' && !window.TB45_IS_ADMIN && !row.is_system) {
      const isOwn = typeof CURRENT_USER !== 'undefined' && CURRENT_USER === row.created_by;
      if (!isOwn) {
        alert('You can only edit your own commands (or System commands). Use "Duplicate" to create your own editable copy.');
        return;
      }
    }

    // Edit/duplicate start with EVERY wizard step unlocked — the command
    // being loaded already has valid data in every step, so forcing the
    // user to click "Next" through steps they don't need to touch would
    // just be friction. The wizard's step-by-step gating is really about
    // guiding someone through filling in a NEW command (mode === 'create').
    CMD_WIZ_MAX_STEP = CMD_WIZ_TOTAL_STEPS;
    _ceRenderWizardState();
  }

  if (isDuplicate) {
    // Differences from 'edit': no delete button, and doesn't inherit the
    // source command's advanced code resolver (it's tied to the source id
    // and wouldn't make sense/work under a new id). The id itself is auto-
    // generated from the Name at save time (see cmdEditorSave) — nothing to
    // reset here, since it's never shown/editable in the form.
    CMD_EDITOR_CAN_DELETE = false;
    CMD_EDITOR_RESOLVER = null;
    _ce('cmdEditorResolverWarning').classList.remove('show');
  }

  _ce('cmdEditorTitle').textContent = isDuplicate ? '📋 Duplicate command'
    : (mode === 'edit' ? '✏️ Edit command' : '➕ New command');
  _ce('cmdEditorOverlay').classList.add('show');
  if (mode === 'create' || isDuplicate) setTimeout(() => _ce('cmdName').focus(), 30);
  // Baseline pro alerta de "fechar sem salvar" (ver cmdEditorRequestClose) —
  // tirado por último, já com o formulário 100% montado (reset OU populate +
  // duplicate tweaks acima já aplicados).
  CMD_EDITOR_INITIAL_SNAPSHOT = _ceSnapshotForm();
}
function closeCommandEditor() {
  _ce('cmdEditorOverlay').classList.remove('show');
  CMD_EDITOR_INITIAL_SNAPSHOT = null;
}
// Chamado pelo X do cabeçalho (index.html) — diferente de closeCommandEditor(),
// que também é usado internamente logo após salvar/excluir com sucesso (onde
// não faz sentido perguntar nada, já que não há mais nada a perder). Pedido do
// usuário: "inclua um popup para quando eu estiver editando um comando e
// fechar a tela sem salvar, ser alertado".
function cmdEditorRequestClose() {
  const current = _ceSnapshotForm();
  const dirty = current !== null && CMD_EDITOR_INITIAL_SNAPSHOT !== null && current !== CMD_EDITOR_INITIAL_SNAPSHOT;
  if (!dirty) { closeCommandEditor(); return; }
  openConfirmModal('You have unsaved changes. Close without saving?', { danger: true }).then(ok => {
    if (ok) closeCommandEditor();
  });
}

// ════════════════════════════════════════════════
// Save / Delete
// ════════════════════════════════════════════════
async function cmdEditorSave() {
  _ceHideError();
  // "All" (empty selection = applies to all) só existe como conceito de FILTRO
  // (sidebar/Configurações) — no cadastro de um comando, Vendor/System/Version/
  // Environment/Topic são todos obrigatórios (pelo menos 1 marcado cada),
  // mesma regra que já valia só para Topic. Ver validação espelhada em
  // server/index.js: validateBody.
  const vendors = _ceGetMultiSeg('cmdVendorSeg');
  const systems = _ceGetMultiSeg('cmdSysSeg');
  const versions = _ceGetMultiSeg('cmdVersionsSeg');
  const environments = _ceGetMultiSeg('cmdEnvSeg');
  const topics = _ceGetMultiSeg('cmdTopicSeg'); // a command can have more than one Topic
  const name = _ce('cmdName').value.trim();

  // Split by wizard step (Name lives in step 1, the 5 catalog lists in step
  // 2) so a failure here — which can still happen in edit mode, where every
  // step starts unlocked and this final check is the only remaining safety
  // net — sends the user straight to the step that actually needs fixing,
  // instead of just showing an error on whatever step they happen to be on.
  if (!name) {
    _ceForceGoToStep(1);
    _ceShowError('Fill in the required field: Name.');
    return;
  }
  if (!vendors.length || !systems.length || !versions.length || !environments.length || !topics.length) {
    _ceForceGoToStep(2);
    _ceShowError('Fill in the required fields: Vendor, System, Version, Environment, Topic — each list needs at least one option checked ("All" is only a filter, not a value a command can be saved with).');
    return;
  }

  // ID: não é mais gerado no cliente — commands.id agora é um INTEGER
  // sequencial (SERIAL) atribuído pelo próprio Postgres na criação (ver
  // schema.sql/server/index.js: POST /api/commands usa INSERT ... RETURNING
  // id). Em modo 'edit' o id já existe (CMD_EDITOR_ORIGINAL_ID) e só é usado
  // como parâmetro da URL do PUT, nunca dentro do payload.

  const defaultLines = _ceReadLinesFrom(_ce('cmdLinesDefaultList')).map(l => Object.assign({}, l, { variant: 'default' }));
  // cmdLinesEmptyList é sempre lida (não há mais toggle de UI para isso — ver
  // comentário em _cePopulateForm) para não apagar a variante 'empty' de um
  // comando com requires_ip_port=1 (ex.: tcpdumpipport) ao salvar uma edição.
  const emptyLines = _ceReadLinesFrom(_ce('cmdLinesEmptyList')).map(l => Object.assign({}, l, { variant: 'empty' }));

  const payload = {
    topics,
    placeholder_resolver: CMD_EDITOR_MODE === 'edit' ? CMD_EDITOR_RESOLVER : null,
    name,
    name_empty: _ce('cmdNameEmpty').value || null,
    desc: _ce('cmdDesc').value || '',
    desc_empty: _ce('cmdDescEmpty').value || '',
    details: _ce('cmdDetailsEditor').innerHTML || '',
    vendors, systems, versions, environments,
    lines: [...defaultLines, ...emptyLines],
  };

  try {
    if (CMD_EDITOR_MODE === 'create') {
      await createCommand(payload);
    } else {
      await updateCommand(CMD_EDITOR_ORIGINAL_ID, payload);
    }
    closeCommandEditor();
    await render();
  } catch (err) {
    console.error('cmdEditorSave failed', err);
    const msg = String((err && err.message) || '');
    // Server-side validation (validateBody em server/index.js) devolve o
    // motivo exato (ex.: "vendors" is required...) depois do "— " — mostra
    // isso em vez de um texto genérico, já que há vários campos obrigatórios
    // (Vendor/System/Version/Environment/Topic/Nome). O 409 (ID já existe) só
    // deveria acontecer numa corrida rara entre duas abas — o ID em si é
    // gerado e conferido contra a lista de comandos logo acima, antes do POST.
    const serverMsg = msg.split(' — ').slice(1).join(' — ');
    if (msg.indexOf('409') !== -1) _ceShowError('A command with this name already exists — try a slightly different name and save again.');
    else if (msg.indexOf('400') !== -1) _ceShowError(serverMsg || 'Fill in the required fields: Vendor, System, Version, Environment, Topic, Name.');
    // 403: só acontece tentando editar o comando de OUTRO usuário sem ser
    // admin (System commands já são editáveis por todos — ver comentário em
    // PUT /api/commands/:id em server/index.js) — a UI já bloqueia isso
    // antes (botão Edit escondido + guarda em openCommandEditor), mas
    // mantemos a mensagem específica do servidor aqui como último resort.
    else if (msg.indexOf('403') !== -1) _ceShowError(serverMsg || 'You can only edit your own commands (or System commands). Duplicate it to create your own editable copy.');
    else _ceShowError('Failed to save the command. Please try again.');
  }
}

function cmdEditorDelete() {
  if (CMD_EDITOR_MODE !== 'edit' || !CMD_EDITOR_ORIGINAL_ID) return;
  const name = _ce('cmdEditorDeleteBtn').dataset.name || CMD_EDITOR_ORIGINAL_ID;
  const ok = confirm(`Delete command "${name}" (${CMD_EDITOR_ORIGINAL_ID})? This action cannot be undone.`);
  if (!ok) return;
  deleteCommand(CMD_EDITOR_ORIGINAL_ID).then(() => {
    closeCommandEditor();
    return render();
  }).catch(err => {
    console.error('cmdEditorDelete failed', err);
    const msg = String((err && err.message) || '');
    _ceShowError('Failed to delete the command. Please try again.');
  });
}

// ════════════════════════════════════════════════
// Bindings + modal chrome (overlay click / Escape), same pattern as
// settings-modal.js's #settingsOverlay handling.
// ════════════════════════════════════════════════
_ceBindMultiSeg('cmdTopicSeg', 'cmdTopicDDBtn', null, 'selected'); // a command can belong to more than one Topic
// Version/Environment: "All" is a filter-only concept — a command being
// registered/edited must have at least one explicit value in each of these,
// so (like Topic) the empty-selection label falls back to null ("0") instead
// of "All", to avoid implying an unselected list is valid. Vendor and System
// are bound separately below (_ceBindSingleSeg) since a command belongs to
// exactly one Vendor and exactly one System, not several — System re-filters
// which Versions are shown via _ceApplyEditorCascade (called from within
// _ceBindSingleSeg itself), so Version has nothing below it in this cascade
// and doesn't need an onToggle.
_ceBindSingleSeg('cmdVendorSeg', 'cmdVendorDDBtn');
_ceBindSingleSeg('cmdSysSeg', 'cmdSysDDBtn');
_ceBindMultiSeg('cmdVersionsSeg', 'cmdVersionsDDBtn', null, 'selected');
_ceBindMultiSeg('cmdEnvSeg', 'cmdEnvDDBtn', null, 'selected');
// Antes, clicar fora da caixa (fundo escuro do overlay) OU apertar Escape
// fechava o editor e descartava qualquer alteração não salva — pedido do
// usuário: "quando estou editando uma nota ou comando, e clico fora da
// janela eu perco tudo que tinha feito. mantenha na tela aberta até que eu
// salve ou feche a janela" (mesmo pedido resolvido para o editor de notas
// em js/folders.js). Removidos os dois listeners — agora só fecha via um
// botão explícito ("Cancel"/✕, sem salvar) ou "Save" (cmdEditorSave()).
_ceRenderWizardState(); // initial paint (step 1 visible, rest hidden) even before the modal is first opened
