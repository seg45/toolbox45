
// ── Modal ──────────────────────────────────────
function setSegActive(groupId, val) {
  const g = document.getElementById(groupId);
  if (!g) return;
  g.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b.dataset.val === val));
}
function getSegActive(groupId) {
  const b = document.querySelector('#' + groupId + ' .seg-btn.on');
  return b ? b.dataset.val : null;
}
// Variantes multi-seleção (Vendor/System/Versão/Ambiente/Tópico) — sem item mestre
// 'all' (ver js/state.js), cada botão é marcado individualmente conforme `vals`.
function setSegActiveMulti(groupId, vals) {
  const g = document.getElementById(groupId);
  if (!g) return;
  g.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', vals.includes(b.dataset.val)));
}
function getSegActiveMulti(groupId) {
  return [...document.querySelectorAll('#' + groupId + ' .seg-btn.on')].map(b => b.dataset.val);
}
// Rótulo do botão dropdown de um grupo de seleção única (mHome) do modal.
function updateModalSingleLabel(groupId, btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const active = document.querySelector('#' + groupId + ' .seg-btn.on');
  btn.querySelector('.dd-label').textContent = active ? active.textContent.trim() : '';
}
// Rótulo do botão dropdown de um grupo multi-seleção (mVersion/mEnv/mType) do modal —
// mesma lógica de updateMultiDDLabel, mas lendo o estado direto dos .seg-btn.on.
function updateModalMultiLabel(groupId, btnId, allKeys, pluralWord, noneWord) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const label = btn.querySelector('.dd-label');
  const sel = getSegActiveMulti(groupId);
  if (sel.length === 0) { label.textContent = 'All'; return; }
  if (sel.length === 1) {
    const b = document.querySelector(`#${groupId} .seg-btn[data-val="${sel[0]}"]`);
    label.textContent = b ? b.textContent.trim() : sel[0];
    return;
  }
  label.textContent = `${sel.length} ${pluralWord}`;
}
// mHome continua seleção única (Tema e Descrição viraram toggles compactos, ver
// toggleModalTheme/toggleModalDesc). mVendor/mSys/mVersion/mEnv/mType usam o mesmo
// comportamento multi-seleção sem item mestre já usado na sidebar (bindMultiSelect).
['mHome','mGroupBy'].forEach(id => {
  document.getElementById(id).addEventListener('click', ev => {
    const btn = ev.target.closest('.seg-btn');
    if (!btn) return;
    document.getElementById(id).querySelectorAll('.seg-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    if (id === 'mGroupBy') {
      applyGroupBySetting(btn.dataset.val);
      syncGroupByToggleUI(btn.dataset.val);
      persistSettings(Object.assign({}, loadSettings(), { groupBy: btn.dataset.val }));
    }
    updateModalSingleLabel(id, id + 'DDBtn');
    document.getElementById(id + 'DD').classList.remove('open'); // seleção única: fecha ao escolher
  });
});
bindMultiSelect('mVendor', '.seg-btn', 'data-val', () => { updateModalMultiLabel('mVendor', 'mVendorDDBtn', VENDOR_KEYS, 'selected', 'None'); if (typeof ccRefreshCascade === 'function') ccRefreshCascade(); });
bindMultiSelect('mSys', '.seg-btn', 'data-val', () => { updateModalMultiLabel('mSys', 'mSysDDBtn', SYSTEM_KEYS, 'selected', 'None'); if (typeof ccRefreshCascade === 'function') ccRefreshCascade(); });
bindMultiSelect('mVersion', '.seg-btn', 'data-val', () => updateModalMultiLabel('mVersion', 'mVersionDDBtn', VERSION_KEYS, 'selected', 'None'));
bindMultiSelect('mEnv', '.seg-btn', 'data-val', () => updateModalMultiLabel('mEnv', 'mEnvDDBtn', ENV_KEYS, 'selected', 'None'));
bindMultiSelect('mType', '.seg-btn', 'data-val', () => updateModalMultiLabel('mType', 'mTypeDDBtn', TYPE_KEYS, 'selected', 'None'));

// Troca de aba do modal de Configurações (User preferences / Registration /
// System / Users) — ver .settings-nav-btn/.settings-pane em index.html e
// components.css. Só a aba "prefs" usa o rodapé Cancel/Save/Restore
// defaults; nas outras (Registration/System/Users) não há nada para salvar,
// então o rodapé fica vazio — fechar é só pelo X do cabeçalho (removido o
// antigo botão "Close" redundante, ver histórico).
function switchSettingsPane(pane) {
  document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.toggle('on', b.dataset.pane === pane));
  document.querySelectorAll('.settings-pane').forEach(p => { p.style.display = (p.dataset.pane === pane) ? '' : 'none'; });
  const isPrefs = pane === 'prefs';
  const footLeft = document.getElementById('settingsFootLeft');
  const cancelBtn = document.getElementById('settingsCancelBtn');
  const saveBtn = document.getElementById('settingsSaveBtn');
  if (footLeft) footLeft.style.display = isPrefs ? '' : 'none';
  if (cancelBtn) cancelBtn.style.display = isPrefs ? '' : 'none';
  if (saveBtn) saveBtn.style.display = isPrefs ? '' : 'none';
}
function openSettingsModal() {
  switchSettingsPane('account'); // sempre abre na primeira aba ("User account", pedido do usuário), independente de onde foi fechado da última vez
  const s = loadSettings();
  const curTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  syncThemeToggleUI(curTheme);
  setSegActive('mHome', s.home);
  setSegActiveMulti('mVendor', s.vendor);
  setSegActiveMulti('mSys', s.sys);
  setSegActiveMulti('mVersion', s.version);
  setSegActiveMulti('mEnv', s.env);
  setSegActiveMulti('mType', s.type);
  setSegActive('mGroupBy', normalizeGroupBy(s.groupBy));
  updateModalSingleLabel('mHome', 'mHomeDDBtn');
  updateModalMultiLabel('mVendor', 'mVendorDDBtn', VENDOR_KEYS, 'selected', 'None');
  updateModalMultiLabel('mSys', 'mSysDDBtn', SYSTEM_KEYS, 'selected', 'None');
  updateModalMultiLabel('mVersion', 'mVersionDDBtn', VERSION_KEYS, 'selected', 'None');
  updateModalMultiLabel('mEnv', 'mEnvDDBtn', ENV_KEYS, 'selected', 'None');
  updateModalMultiLabel('mType', 'mTypeDDBtn', TYPE_KEYS, 'selected', 'None');
  updateModalSingleLabel('mGroupBy', 'mGroupByDDBtn');
  if (typeof ccRefreshCascade === 'function') ccRefreshCascade();
  gvSet('mLogFile', s.logFile);
  syncShowDetailsToggleUI(s.showCardDetails === true);
  // O antigo botão "Clear favorites" (mClearFavBtn) foi removido junto com a
  // migração para Folders (ver js/folders.js) — excluir uma pasta específica
  // agora é feito direto na sidebar (botão ✕ em cada linha de pasta).
  document.getElementById('settingsOverlay').classList.add('show');
}
function closeSettingsModal() {
  document.getElementById('settingsOverlay').classList.remove('show');
}
function saveSettingsModal() {
  const vendorSel = getSegActiveMulti('mVendor');
  const sysSel = getSegActiveMulti('mSys');
  const versionSel = getSegActiveMulti('mVersion');
  const envSel = getSegActiveMulti('mEnv');
  const typeSel = getSegActiveMulti('mType');
  // showCardDetails/enableCommandEditing já foram aplicadas e persistidas na hora (commit
  // instantâneo, como tema/idioma) — preserva o valor atual em vez de sobrescrever com o padrão.
  const s = Object.assign({}, loadSettings(), {
    home: getSegActive('mHome') || DEFAULT_SETTINGS.home,
    // Seleção vazia é intencional e válida — não força mais de volta para o padrão 'Any'.
    vendor: vendorSel,
    sys: sysSel,
    version: versionSel,
    env: envSel,
    type: typeSel,
    logFile: (gv('mLogFile') || DEFAULT_SETTINGS.logFile),
  });
  persistSettings(s);
  // Tema já foi aplicado e persistido na hora pelo toggle (toggleModalTheme) — nada a fazer aqui.
  ST.vd = s.vendor; ST.sys = s.sys; ST.v = s.version; ST.e = s.env; ST.t = s.type;
  setActiveRowsMulti('vendorList', 'data-vd', s.vendor);
  setActiveRowsMulti('sysList', 'data-sys', s.sys);
  setActiveRowsMulti('vList', 'data-v', s.version);
  setActiveRowsMulti('eList', 'data-e', s.env);
  setActiveRowsMulti('tList', 'data-t', s.type);
  updateVendorDDLabel();
  updateSystemDDLabel();
  updateVersionDDLabel();
  updateEnvDDLabel();
  updateTypeDDLabel();
  if (typeof ccRefreshCascade === 'function') ccRefreshCascade();
  gvSet('f-log', s.logFile);
  VIEW_FOLDERS_HOME = s.home === 'folders';
  // Bug reportado: "configurei para pagina inicial ser a folders, mas
  // quando usuario loga esta indo para pagina de comandos". Causa:
  // resolveFoldersHome() (js/settings.js) prioriza a ultima visao memorizada
  // ('cpa-last-view', gravada por viewAllFolders()/goHome() em
  // js/folders.js) sobre a preferencia "Home page" (s.home) — pensado pra um
  // F5 nao "chutar" o usuario de volta pra fora de Folders so porque ele
  // entrou la manualmente numa sessao (ver comentario em LAST_VIEW_KEY).
  // Mas isso tambem significa que, se essa chave ja guardava 'menu' de uma
  // navegacao anterior, salvar aqui uma NOVA preferencia "Home page" =
  // Folders no modal de Configuracoes nunca revertia esse valor — a troca
  // parecia funcionar na hora (VIEW_FOLDERS_HOME muda em memoria, ver
  // abaixo), mas um F5 ou um login novo (que roda essa mesma leitura do
  // zero) sempre voltava pra tela de comandos. Salvar essa preferencia no
  // modal e uma acao tao deliberada quanto clicar em "Folders" ou no
  // logo/nome do app — por isso tambem grava aqui, mantendo a visao
  // memorizada em dia com o que o usuario acabou de escolher como padrao.
  if (typeof persistLastView === 'function') persistLastView(VIEW_FOLDERS_HOME);
  const foldersNav = document.getElementById('foldersNavRow');
  if (foldersNav) foldersNav.classList.toggle('on', VIEW_FOLDERS_HOME);
  closeSettingsModal();
  render();
}
function restoreDefaultsModal() {
  setSegActive('mHome', DEFAULT_SETTINGS.home);
  setSegActiveMulti('mVendor', DEFAULT_SETTINGS.vendor);
  setSegActiveMulti('mSys', DEFAULT_SETTINGS.sys);
  setSegActiveMulti('mVersion', DEFAULT_SETTINGS.version);
  setSegActiveMulti('mEnv', DEFAULT_SETTINGS.env);
  setSegActiveMulti('mType', DEFAULT_SETTINGS.type);
  setSegActive('mGroupBy', DEFAULT_SETTINGS.groupBy);
  updateModalSingleLabel('mHome', 'mHomeDDBtn');
  updateModalMultiLabel('mVendor', 'mVendorDDBtn', VENDOR_KEYS, 'selected', 'None');
  updateModalMultiLabel('mSys', 'mSysDDBtn', SYSTEM_KEYS, 'selected', 'None');
  updateModalMultiLabel('mVersion', 'mVersionDDBtn', VERSION_KEYS, 'selected', 'None');
  updateModalMultiLabel('mEnv', 'mEnvDDBtn', ENV_KEYS, 'selected', 'None');
  updateModalMultiLabel('mType', 'mTypeDDBtn', TYPE_KEYS, 'selected', 'None');
  updateModalSingleLabel('mGroupBy', 'mGroupByDDBtn');
  if (typeof ccRefreshCascade === 'function') ccRefreshCascade();
  gvSet('mLogFile', DEFAULT_SETTINGS.logFile);
  setShowCardDetails(DEFAULT_SETTINGS.showCardDetails);
  // "Default settings" (Dark mode/Details/Export/Show images/System
  // commands) voltam todos para desabilitado — Details já estava aqui,
  // Export e System commands faltavam (bug pré-existente: o botão não os
  // restaurava).
  setExportEnabled(DEFAULT_SETTINGS.exportEnabled);
  setShowImages(DEFAULT_SETTINGS.showImages);
  setShowSidebar(DEFAULT_SETTINGS.showSidebar);
  setShowSystemCommands(DEFAULT_SETTINGS.showSystemCommands);
  setGroupBy(DEFAULT_SETTINGS.groupBy);
  applyTheme('light');
  syncThemeToggleUI('light');
  // Restaura a cor de destaque para o padrão (teal da marca Toolbox45) —
  // ver ACCENT_PRESETS/DEFAULT_ACCENT em js/theme.js.
  setAccentColor(DEFAULT_ACCENT);
}
document.getElementById('settingsOverlay').addEventListener('click', ev => {
  if (ev.target.id === 'settingsOverlay') closeSettingsModal();
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') closeSettingsModal();
});
