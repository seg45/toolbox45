// Export log file (Settings -> System) — pedido do usuário: "onde está
// esse registro de export? no cadastro está como {{logFile}}" seguido de
// "deixe como os demais registros em banco, e cadastre esse para refletir
// nos comandos", com "Um valor único, global (Recomendado)" confirmado como
// o escopo. Substitui o antigo campo por usuário "Export to" (#mLogFile,
// removido de Settings -> User preferences) por um único valor cadastrado
// aqui pelo admin (GET/PUT /api/system/export-log-file em
// server/index.js), aplicado a TODOS os usuários via GLOBAL_EXPORT_LOG_FILE
// (js/settings.js, já carregado no boot por loadGlobalExportLogFile() em
// js/user-sync.js).

async function loadSystemExportLogFile() {
  const input = document.getElementById('sysExportLogFileInput');
  const status = document.getElementById('sysExportLogFileStatus');
  if (!input) return;
  try {
    const res = await fetch('/api/system/export-log-file');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    input.value = (data && typeof data.value === 'string') ? data.value : '';
    if (status) status.textContent = '';
  } catch (e) {
    console.warn('Não foi possível carregar o caminho global de export', e);
    if (status) status.textContent = 'Could not load the current value.';
  }
}

async function saveSystemExportLogFile() {
  const input = document.getElementById('sysExportLogFileInput');
  const status = document.getElementById('sysExportLogFileStatus');
  const btn = document.getElementById('sysExportLogFileSaveBtn');
  if (!input) return;
  const value = input.value.trim();
  if (!value) {
    if (status) status.textContent = 'Enter a path before saving.';
    return;
  }
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Saving…';
  try {
    const res = await fetch('/api/system/export-log-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    // Aplica o novo valor imediatamente nesta sessão, sem esperar um reload
    // — mesma variável que loadGlobalExportLogFile() (js/user-sync.js)
    // popula no boot, e mesmo #f-log que render.js lê (gv('f-log')).
    if (typeof GLOBAL_EXPORT_LOG_FILE !== 'undefined') GLOBAL_EXPORT_LOG_FILE = data.value;
    if (typeof gvSet === 'function') gvSet('f-log', data.value);
    if (typeof render === 'function') render();
    if (status) status.textContent = 'Saved.';
  } catch (err) {
    console.error('Failed to save the export log file', err);
    if (status) status.textContent = 'Failed to save. Please try again.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// switchSettingsPane() (js/settings-modal.js) já existe antes deste arquivo
// ser carregado (ver ordem dos <script> em index.html) — mesmo padrão de
// js/api-keys.js/js/oauth-settings.js/js/ssl-certificate.js: envolve a
// função original pra carregar o valor atual sem duplicar a lógica de troca
// de aba.
if (typeof switchSettingsPane === 'function') {
  const _sysSettingsOrigSwitchSettingsPane = switchSettingsPane;
  switchSettingsPane = function (pane) {
    _sysSettingsOrigSwitchSettingsPane(pane);
    if (pane === 'system') loadSystemExportLogFile();
  };
}
