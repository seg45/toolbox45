// ════════════════════════════════════════════════
// AUDIT LOG VIEWER — "View audit log" button in Settings (modal-foot). Shows
// the create/update/delete history recorded by the server for every kind of
// organizational change (commands, folders, notes, catalogs, users, API
// keys — see server/index.js: logAudit()/GET /api/audit-log, and
// server/schema.sql: table audit_log). Entries older than 30 days are
// deleted automatically by the server — this screen is read-only.
//
// Available to every user (no Admin mode gate), same as the other
// modal-foot button (Restore defaults).
// ════════════════════════════════════════════════

function _alEscHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const AUDIT_ACTION_LABELS = { create: 'Created', update: 'Updated', delete: 'Deleted' };
// Rótulo amigável do entity_type (ver audit_log em server/schema.sql) —
// mostrado na coluna "Type" da tabela abaixo.
const AUDIT_ENTITY_LABELS = {
  command: 'Command', folder: 'Folder', note: 'Note',
  vendor: 'Vendor', system: 'System', version: 'Version',
  environment: 'Environment', topic: 'Topic', parameter: 'Parameter',
  prompt: 'Prompt', export: 'Export',
  user: 'User', api_key: 'API key',
};

function openAuditLogModal() {
  const overlay = document.getElementById('auditLogOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  renderAuditLog();
}

function closeAuditLogModal() {
  const overlay = document.getElementById('auditLogOverlay');
  if (overlay) overlay.classList.remove('show');
}

// Click-outside-to-close + Escape, same pattern as catalog-admin.js.
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('auditLogOverlay');
  if (overlay) overlay.addEventListener('click', ev => { if (ev.target.id === 'auditLogOverlay') overlay.classList.remove('show'); });
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  const overlay = document.getElementById('auditLogOverlay');
  if (overlay) overlay.classList.remove('show');
});

async function renderAuditLog() {
  const tbody = document.getElementById('auditLogTbody');
  const empty = document.getElementById('auditLogEmpty');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="audit-log-loading">Loading…</td></tr>`;
  if (empty) empty.style.display = 'none';
  let rows = [];
  try {
    const res = await fetch('/api/audit-log');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = await res.json();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="audit-log-loading">Failed to load the audit log. Please try again.</td></tr>`;
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const actionLabel = AUDIT_ACTION_LABELS[r.action] || r.action || '—';
    const actionClass = `audit-action-${_alEscHtml(r.action || '')}`;
    const entityType = r.entity_type || 'command';
    const typeLabel = AUDIT_ENTITY_LABELS[entityType] || entityType;
    const itemName = r.entity_name || r.command_name || r.entity_id || r.command_id || '—';
    return `<tr>
      <td>${_alEscHtml(typeof formatAuditDate === 'function' ? formatAuditDate(r.ts) : r.ts)}</td>
      <td>${_alEscHtml(r.username || '—')}</td>
      <td><span class="audit-action-pill ${actionClass}">${_alEscHtml(actionLabel)}</span></td>
      <td>${_alEscHtml(typeLabel)}</td>
      <td>${_alEscHtml(itemName)}</td>
      <td>${_alEscHtml(r.details || '—')}</td>
    </tr>`;
  }).join('');
}
