// ════════════════════════════════════════════════
// SHARING — seção "Sharing" na aba System do modal de Configurações (ver
// #sysGroupSharing em index.html). Pedido do usuário:
//   1) cada usuário tem um HANDLE único (nunca o username/e-mail) para
//      compartilhar com outros — "e-mail fique restrito".
//   2) o handle é gerado automaticamente na criação da conta; o próprio
//      usuário pode trocá-lo depois (PUT /api/me/handle), contanto que
//      continue único.
//   3) login continua igual (local/Google) — nada aqui mexe nisso.
//   4) compartilhar pastas e/ou comandos, "tudo ou nada, por tipo" — dois
//      toggles independentes (share_folders/share_commands), sem seleção de
//      pasta/comando específico, valendo IMEDIATAMENTE (sem aceite do outro
//      lado) — ver POST/GET/DELETE /api/shares em server/index.js.
// Admins continuam vendo as pastas/comandos de todo mundo sempre — esta
// tela (e o próprio mecanismo de shares) só existe para usuários comuns se
// verem entre si; um admin também pode usá-la para gerenciar o PRÓPRIO
// compartilhamento normalmente.
// ════════════════════════════════════════════════

function _shEscHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _shFormatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function _shCheckIcon(on) {
  return on ? '✓' : '—';
}

// ── Seu handle ──────────────────────────────────────────────────────────
let _shMyHandle = null;

async function _shLoadMyHandle() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const me = await res.json();
    _shMyHandle = me.handle || null;
  } catch (err) {
    console.error('Failed to load current handle', err);
    _shMyHandle = null;
  }
  const display = document.getElementById('myHandleDisplay');
  if (display) display.textContent = _shMyHandle || '—';
}

function startEditMyHandle() {
  const display = document.getElementById('myHandleDisplay');
  const input = document.getElementById('myHandleInput');
  const editBtn = document.getElementById('myHandleEditBtn');
  const saveBtn = document.getElementById('myHandleSaveBtn');
  const cancelBtn = document.getElementById('myHandleCancelBtn');
  const errorMsg = document.getElementById('myHandleErrorMsg');
  if (errorMsg) errorMsg.style.display = 'none';
  if (input) { input.value = _shMyHandle || ''; input.style.display = ''; }
  if (display) display.style.display = 'none';
  if (editBtn) editBtn.style.display = 'none';
  if (saveBtn) saveBtn.style.display = '';
  if (cancelBtn) cancelBtn.style.display = '';
  if (input) { input.focus(); input.select(); }
}

function cancelEditMyHandle() {
  const display = document.getElementById('myHandleDisplay');
  const input = document.getElementById('myHandleInput');
  const editBtn = document.getElementById('myHandleEditBtn');
  const saveBtn = document.getElementById('myHandleSaveBtn');
  const cancelBtn = document.getElementById('myHandleCancelBtn');
  const errorMsg = document.getElementById('myHandleErrorMsg');
  if (errorMsg) errorMsg.style.display = 'none';
  if (input) input.style.display = 'none';
  if (display) display.style.display = '';
  if (editBtn) editBtn.style.display = '';
  if (saveBtn) saveBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

async function saveMyHandle() {
  const input = document.getElementById('myHandleInput');
  const errorMsg = document.getElementById('myHandleErrorMsg');
  const handle = input ? input.value.trim().toLowerCase() : '';
  if (errorMsg) errorMsg.style.display = 'none';
  if (!handle) { if (input) input.focus(); return; }
  try {
    const res = await fetch('/api/me/handle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    _shMyHandle = data.handle;
    const display = document.getElementById('myHandleDisplay');
    if (display) display.textContent = _shMyHandle;
    cancelEditMyHandle();
  } catch (err) {
    if (errorMsg) { errorMsg.textContent = err.message || 'Failed to update handle.'; errorMsg.style.display = ''; }
  }
}

// ── Nova concessão (compartilhar com alguém) ───────────────────────────
async function submitNewShare() {
  const handleInput = document.getElementById('shareHandleInput');
  const foldersCb = document.getElementById('shareFoldersCheckbox');
  const commandsCb = document.getElementById('shareCommandsCheckbox');
  const errorMsg = document.getElementById('newShareErrorMsg');
  if (errorMsg) errorMsg.style.display = 'none';
  const handle = handleInput ? handleInput.value.trim().toLowerCase() : '';
  const shareFolders = !!(foldersCb && foldersCb.checked);
  const shareCommands = !!(commandsCb && commandsCb.checked);
  if (!handle) { if (handleInput) handleInput.focus(); return; }
  if (!shareFolders && !shareCommands) {
    if (errorMsg) { errorMsg.textContent = 'Choose Folders and/or Commands to share.'; errorMsg.style.display = ''; }
    return;
  }
  try {
    const res = await fetch('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, share_folders: shareFolders, share_commands: shareCommands }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    if (handleInput) handleInput.value = '';
    if (foldersCb) foldersCb.checked = false;
    if (commandsCb) commandsCb.checked = false;
    renderSharesGiven();
  } catch (err) {
    if (errorMsg) { errorMsg.textContent = err.message || 'Failed to share.'; errorMsg.style.display = ''; }
  }
}

function deleteShare(id, handle) {
  openConfirmModal(`Stop sharing with "${handle}"? They will immediately lose access to whatever you shared with them.`, { danger: true })
    .then(async ok => {
      if (!ok) return;
      try {
        const res = await fetch(`/api/shares/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        renderSharesGiven();
      } catch (err) {
        alert('Failed to revoke share. Please try again.');
        console.error('Delete share failed', err);
      }
    });
}

// ── Listas ──────────────────────────────────────────────────────────────
async function renderSharesGiven() {
  const tbody = document.getElementById('sharesGivenTbody');
  const empty = document.getElementById('sharesGivenEmpty');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="audit-log-loading">Loading…</td></tr>`;
  if (empty) empty.style.display = 'none';
  let given = [];
  try {
    const res = await fetch('/api/shares');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    given = data.given || [];
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="audit-log-loading">Failed to load. Please try again.</td></tr>`;
    return;
  }
  if (!given.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  tbody.innerHTML = given.map(s => `
    <tr>
      <td>${_shEscHtml(s.grantee_handle)}</td>
      <td>${_shCheckIcon(s.share_folders)}</td>
      <td>${_shCheckIcon(s.share_commands)}</td>
      <td><button type="button" class="btn btn-sm" onclick="deleteShare(${s.id}, '${_shEscHtml(s.grantee_handle)}')">Revoke</button></td>
    </tr>
  `).join('');
}

async function renderSharesReceived() {
  const tbody = document.getElementById('sharesReceivedTbody');
  const empty = document.getElementById('sharesReceivedEmpty');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="3" class="audit-log-loading">Loading…</td></tr>`;
  if (empty) empty.style.display = 'none';
  let received = [];
  try {
    const res = await fetch('/api/shares');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    received = data.received || [];
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="audit-log-loading">Failed to load. Please try again.</td></tr>`;
    return;
  }
  if (!received.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  tbody.innerHTML = received.map(s => `
    <tr>
      <td>${_shEscHtml(s.grantor_handle)}</td>
      <td>${_shCheckIcon(s.share_folders)}</td>
      <td>${_shCheckIcon(s.share_commands)}</td>
    </tr>
  `).join('');
}

// GET /api/shares é chamado duas vezes (given/received) em paralelo — o
// endpoint já devolve os dois juntos, mas manter renderSharesGiven()/
// renderSharesReceived() independentes (mesmo padrão de renderApiKeyList())
// deixa cada tabela se recarregar sozinha depois de uma ação (ex.: só
// "Shared by you" precisa recarregar depois de um Revoke).
function renderSharingPanel() {
  _shLoadMyHandle();
  renderSharesGiven();
  renderSharesReceived();
}

document.addEventListener('DOMContentLoaded', () => {
  const handleInput = document.getElementById('myHandleInput');
  if (handleInput) handleInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') saveMyHandle(); else if (ev.key === 'Escape') cancelEditMyHandle(); });
  const shareHandleInput = document.getElementById('shareHandleInput');
  if (shareHandleInput) shareHandleInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') submitNewShare(); });
});

// Carrega a seção quando a aba "System" do modal de Configurações é aberta —
// mesmo padrão de encadeamento de js/api-keys.js (que já envolve
// switchSettingsPane uma vez; isto envolve de novo por cima, então as duas
// listas recarregam juntas ao abrir "System").
if (typeof switchSettingsPane === 'function') {
  const _shOrigSwitchSettingsPane = switchSettingsPane;
  switchSettingsPane = function (pane) {
    _shOrigSwitchSettingsPane(pane);
    if (pane === 'system') renderSharingPanel();
  };
}
