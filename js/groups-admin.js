// ═════════════════════════════════════════════════
// MANAGE GROUPS — Settings → Groups (super_admin-only, ver
// applyAdminGating() em js/auth.js e SUPER_ADMIN_ONLY_SETTINGS_GROUP_IDS).
// Pedido do usuário: "criar uma estrutura de grupos onde os usuários dos
// grupos podem ver todos comandos [e pastas] de quem está no grupo.
// somente super admin podem gerenciar grupos". CRUD de grupos + membros
// (users.username REAL — mesma convenção de Manage users) — ver `groups`/
// `group_members` em server/schema.sql e /api/groups* em server/index.js.
// O EFEITO de visibilidade em si (não a gestão daqui) mora inteiramente no
// backend (GET /api/commands, GET /api/commands/:id, GET /api/folders/all,
// POST /api/folders/:id/copy) — nada neste arquivo decide quem vê o quê,
// só gerencia a composição dos grupos. Mesmo padrão visual/estrutural de
// js/users-admin.js.
// ═══════════════════════════════════════════════

function _gaEscHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Mesma necessidade de escape em duas camadas (string JS dentro de
// onclick="...('VALOR')" + atributo HTML) que _uaEscJsAttr em
// js/users-admin.js — ver o comentário completo lá (contas legadas
// "DOMINIO\usuario" quebrando em \r se a barra invertida não for escapada
// primeiro).
function _gaEscJsAttr(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Cache da última lista carregada — a busca (#groupSearchInput) filtra em
// cima dela sem precisar rebater na API a cada tecla (ver filterGroupList()).
let _gaAllGroups = [];

function _gaRenderRows(rows) {
  const tbody = document.getElementById('groupListTbody');
  const empty = document.getElementById('groupListEmpty');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty) {
      const term = (document.getElementById('groupSearchInput') || {}).value || '';
      empty.textContent = term.trim() ? 'No groups match your search.' : 'No groups yet.';
      empty.style.display = '';
    }
    return;
  }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = rows.map(g => {
    const gid = g.id;
    const gname = _gaEscJsAttr(g.name);
    const members = g.members || [];
    // Lista os primeiros handful de usernames inline (com contagem se
    // vazio/1 nome só já cabe tranquilo) — a lista completa (com botão de
    // remover cada um) fica no modal "Manage".
    const membersCell = members.length
      ? _gaEscHtml(members.join(', '))
      : '<span style="color:var(--muted);">No members</span>';
    return `
    <tr>
      <td>${_gaEscHtml(g.name)}</td>
      <td>${membersCell}</td>
      <td style="white-space:nowrap;">
        <button type="button" class="btn btn-sm" onclick="openManageGroupModal(${gid})">Manage</button>
        <button type="button" class="btn btn-sm" onclick="deleteGroupConfirm(${gid}, '${gname}')">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function filterGroupList() {
  const term = ((document.getElementById('groupSearchInput') || {}).value || '').trim().toLowerCase();
  const filtered = term ? _gaAllGroups.filter(g => String(g.name).toLowerCase().includes(term)) : _gaAllGroups;
  _gaRenderRows(filtered);
}

async function renderGroupList() {
  const tbody = document.getElementById('groupListTbody');
  const empty = document.getElementById('groupListEmpty');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="3" class="audit-log-loading">Loading…</td></tr>`;
  if (empty) empty.style.display = 'none';
  try {
    const res = await fetch('/api/groups');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _gaAllGroups = await res.json();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="audit-log-loading">Failed to load groups. Please try again.</td></tr>`;
    return;
  }
  filterGroupList();
}

function deleteGroupConfirm(id, name) {
  openConfirmModal(`Delete the group "${name}"? Its members immediately stop seeing each other's shared commands/folders through it. This cannot be undone.`, { danger: true })
    .then(async ok => {
      if (!ok) return;
      try {
        const res = await fetch(`/api/groups/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || `HTTP ${res.status}`);
        }
        renderGroupList();
      } catch (err) {
        alert(err.message || 'Failed to delete group.');
      }
    });
}

// ── "New group" ──
function openNewGroupPrompt() {
  const n = document.getElementById('newGroupNameInput');
  const err = document.getElementById('newGroupErrorMsg');
  if (n) n.value = '';
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  const overlay = document.getElementById('newGroupOverlay');
  if (overlay) overlay.classList.add('show');
  if (n) setTimeout(() => n.focus(), 0);
}
function closeNewGroupPrompt() {
  const overlay = document.getElementById('newGroupOverlay');
  if (overlay) overlay.classList.remove('show');
}
async function submitNewGroup() {
  const name = ((document.getElementById('newGroupNameInput') || {}).value || '').trim();
  const err = document.getElementById('newGroupErrorMsg');
  if (!name) {
    if (err) { err.textContent = 'Name is required.'; err.style.display = ''; }
    return;
  }
  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    closeNewGroupPrompt();
    renderGroupList();
  } catch (e) {
    if (err) { err.textContent = e.message || 'Failed to create group.'; err.style.display = ''; }
  }
}

// ── "Manage group" (renomear + membros) ──
let _gaCurrentGroupId = null;
let _gaCurrentGroupMembers = []; // usernames, atualizado a cada add/remove sem precisar recarregar a lista inteira

function _gaFindGroup(id) {
  return _gaAllGroups.find(g => g.id === id) || null;
}

async function openManageGroupModal(id) {
  _gaCurrentGroupId = id;
  const group = _gaFindGroup(id);
  const title = document.getElementById('manageGroupTitle');
  const nameInput = document.getElementById('manageGroupNameInput');
  const renameStatus = document.getElementById('manageGroupRenameStatus');
  const addStatus = document.getElementById('groupMemberAddStatus');
  if (title) title.textContent = group ? `Manage group — ${group.name}` : 'Manage group';
  if (nameInput) nameInput.value = group ? group.name : '';
  if (renameStatus) renameStatus.textContent = '';
  if (addStatus) addStatus.textContent = '';
  _gaCurrentGroupMembers = group ? (group.members || []).slice() : [];
  const overlay = document.getElementById('manageGroupOverlay');
  if (overlay) overlay.classList.add('show');
  _gaRenderMemberTable();
  await _gaLoadMemberAddOptions();
}
function closeManageGroupModal() {
  const overlay = document.getElementById('manageGroupOverlay');
  if (overlay) overlay.classList.remove('show');
  _gaCurrentGroupId = null;
}

function _gaRenderMemberTable() {
  const tbody = document.getElementById('groupMemberListTbody');
  const empty = document.getElementById('groupMemberListEmpty');
  if (!tbody) return;
  if (!_gaCurrentGroupMembers.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  tbody.innerHTML = _gaCurrentGroupMembers.slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map(u => {
    const uname = _gaEscJsAttr(u);
    return `
    <tr>
      <td>${_gaEscHtml(u)}</td>
      <td style="white-space:nowrap;"><button type="button" class="btn btn-sm" onclick="removeGroupMemberConfirm('${uname}')">Remove</button></td>
    </tr>`;
  }).join('');
}

// Popula o <select> de "adicionar membro" com todo mundo que AINDA não
// está no grupo — busca GET /api/users de novo aqui (não reaproveita
// _uaAllUsers de js/users-admin.js: a aba Users pode nunca ter sido
// aberta nesta sessão, então aquele cache pode estar vazio).
async function _gaLoadMemberAddOptions() {
  const select = document.getElementById('groupMemberAddSelect');
  if (!select) return;
  select.innerHTML = '<option value="">Loading…</option>';
  try {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const users = await res.json();
    const memberSet = new Set(_gaCurrentGroupMembers);
    const available = users
      .map(u => u.username)
      .filter(u => !memberSet.has(u))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    select.innerHTML = available.length
      ? available.map(u => `<option value="${_gaEscHtml(u)}">${_gaEscHtml(u)}</option>`).join('')
      : '<option value="">No other users available</option>';
  } catch (e) {
    select.innerHTML = '<option value="">Failed to load users</option>';
  }
}

async function submitRenameGroup() {
  if (!_gaCurrentGroupId) return;
  const name = ((document.getElementById('manageGroupNameInput') || {}).value || '').trim();
  const status = document.getElementById('manageGroupRenameStatus');
  if (!name) {
    if (status) status.textContent = 'Name is required.';
    return;
  }
  try {
    const res = await fetch(`/api/groups/${_gaCurrentGroupId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    if (status) status.textContent = 'Saved.';
    const title = document.getElementById('manageGroupTitle');
    if (title) title.textContent = `Manage group — ${name}`;
    renderGroupList();
  } catch (e) {
    if (status) status.textContent = e.message || 'Failed to rename group.';
  }
}

async function submitAddGroupMember() {
  if (!_gaCurrentGroupId) return;
  const select = document.getElementById('groupMemberAddSelect');
  const username = select ? select.value : '';
  const status = document.getElementById('groupMemberAddStatus');
  if (!username) {
    if (status) status.textContent = 'Choose a user to add.';
    return;
  }
  try {
    const res = await fetch(`/api/groups/${_gaCurrentGroupId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    _gaCurrentGroupMembers = data.members || _gaCurrentGroupMembers.concat([username]);
    if (status) status.textContent = '';
    _gaRenderMemberTable();
    await _gaLoadMemberAddOptions();
    renderGroupList(); // mantém a lista de fundo (contagem/lista de membros) em dia
  } catch (e) {
    if (status) status.textContent = e.message || 'Failed to add member.';
  }
}

function removeGroupMemberConfirm(username) {
  if (!_gaCurrentGroupId) return;
  openConfirmModal(`Remove "${username}" from this group? They immediately stop sharing commands/folders with the other members through it.`, { danger: true })
    .then(async ok => {
      if (!ok) return;
      try {
        const res = await fetch(`/api/groups/${_gaCurrentGroupId}/members/${encodeURIComponent(username)}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || `HTTP ${res.status}`);
        }
        _gaCurrentGroupMembers = _gaCurrentGroupMembers.filter(u => u !== username);
        _gaRenderMemberTable();
        await _gaLoadMemberAddOptions();
        renderGroupList();
      } catch (e) {
        alert(e.message || 'Failed to remove member.');
      }
    });
}

document.addEventListener('DOMContentLoaded', () => {
  const newGroupOverlay = document.getElementById('newGroupOverlay');
  if (newGroupOverlay) newGroupOverlay.addEventListener('click', ev => { if (ev.target.id === 'newGroupOverlay') closeNewGroupPrompt(); });
  const manageGroupOverlay = document.getElementById('manageGroupOverlay');
  if (manageGroupOverlay) manageGroupOverlay.addEventListener('click', ev => { if (ev.target.id === 'manageGroupOverlay') closeManageGroupModal(); });
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  const newGroupOverlay = document.getElementById('newGroupOverlay');
  if (newGroupOverlay && newGroupOverlay.classList.contains('show')) closeNewGroupPrompt();
  const manageGroupOverlay = document.getElementById('manageGroupOverlay');
  if (manageGroupOverlay && manageGroupOverlay.classList.contains('show')) closeManageGroupModal();
});

// Carrega a lista quando a aba própria "Groups" do modal de Configurações é
// aberta — mesmo padrão de wrap de switchSettingsPane usado em
// js/users-admin.js/js/api-keys.js (os wraps se empilham sem conflito,
// cada um chamando o anterior).
if (typeof switchSettingsPane === 'function') {
  const _gaOrigSwitchSettingsPane = switchSettingsPane;
  switchSettingsPane = function (pane) {
    _gaOrigSwitchSettingsPane(pane);
    if (pane === 'groups') {
      const searchInput = document.getElementById('groupSearchInput');
      if (searchInput) searchInput.value = '';
      renderGroupList();
    }
  };
}
