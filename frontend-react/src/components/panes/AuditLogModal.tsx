// ════════════════════════════════════════════════
// "Audit log" (Settings → Database → Audit log) — porta de js/audit-log.js
// + #auditLogOverlay (index.html). Somente leitura: histórico de
// create/update/delete dos últimos 30 dias (o servidor remove o resto).
// Tudo é renderizado como texto React (escapado) — nunca innerHTML.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatAuditDate } from '../../lib/folders';
import { fetchAuditLog, type AuditLogRow } from '../../lib/backup';

const AUDIT_ACTION_LABELS: Record<string, string> = { create: 'Created', update: 'Updated', delete: 'Deleted' };
// Rótulo amigável do entity_type (ver audit_log em server/schema.sql) —
// mostrado na coluna "Type".
const AUDIT_ENTITY_LABELS: Record<string, string> = {
  command: 'Command', folder: 'Folder', note: 'Note',
  vendor: 'Vendor', system: 'System', version: 'Version',
  environment: 'Environment', topic: 'Topic', parameter: 'Parameter',
  prompt: 'Prompt', export: 'Export',
  user: 'User', api_key: 'API key',
};

function lookup(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

type LoadState = 'loading' | 'error' | 'ready';

export function AuditLogModal({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<LoadState>('loading');
  const [rows, setRows] = useState<AuditLogRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchAuditLog()
      .then(data => {
        if (cancelled) return;
        setRows(data);
        setState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const isEmpty = state === 'ready' && rows.length === 0;

  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box modal-wide">
        <div className="modal-head">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M3 2.5h10v11H3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>Audit log</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <span className="set-hint">
            Create/update/delete history for commands, folders, notes, catalogs, users and API keys — entries older than 30 days are removed
            automatically.
          </span>
          <div className="audit-log-wrap" id="auditLogWrap">
            <table className="audit-log-table">
              <thead>
                <tr>
                  <th>Date/Time</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Type</th>
                  <th>Item</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody id="auditLogTbody">
                {state === 'loading' && (
                  <tr>
                    <td colSpan={6} className="audit-log-loading">
                      Loading…
                    </td>
                  </tr>
                )}
                {state === 'error' && (
                  <tr>
                    <td colSpan={6} className="audit-log-loading">
                      Failed to load the audit log. Please try again.
                    </td>
                  </tr>
                )}
                {state === 'ready' &&
                  rows.map(r => {
                    const action = r.action || '';
                    const actionLabel = lookup(AUDIT_ACTION_LABELS, action) || r.action || '—';
                    const entityType = r.entity_type || 'command';
                    const typeLabel = lookup(AUDIT_ENTITY_LABELS, entityType) || entityType;
                    const itemName = r.entity_name || r.command_name || r.entity_id || r.command_id || '—';
                    return (
                      <tr key={r.id}>
                        <td>{formatAuditDate(r.ts)}</td>
                        <td>{r.username || '—'}</td>
                        <td>
                          <span className={`audit-action-pill audit-action-${action}`}>{actionLabel}</span>
                        </td>
                        <td>{typeLabel}</td>
                        <td>{itemName}</td>
                        <td>{r.details || '—'}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            <div className="audit-log-empty" id="auditLogEmpty" style={{ display: isEmpty ? '' : 'none' }}>
              No audit log entries in the last 30 days.
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <div></div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
