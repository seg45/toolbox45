// ════════════════════════════════════════════════
// "Access log" (Settings → Database → View access log) — SÓ super admin.
// Eventos de acesso gravados pelo servidor (app/auth_events.py): logins,
// falhas, bloqueios, setup, cadastro, troca/redefinição de senha e OAuth, com IP
// e navegador; guarda 180 dias. Somente leitura. Tudo é renderizado como texto
// React (escapado) — o "usuário" de um login que falhou é texto digitado por
// qualquer pessoa, nunca innerHTML.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatAuditDate } from '../../lib/folders';
import { fetchAuthEvents, type AuthEventRow } from '../../lib/backup';

export const AUTH_EVENT_LABELS: Record<string, string> = {
  login_success: 'Login',
  login_failed: 'Login failed',
  login_blocked: 'Login blocked',
  setup_completed: 'Initial setup',
  register: 'Sign-up',
  password_changed: 'Password changed',
  password_change_failed: 'Password change failed',
  password_change_blocked: 'Password change blocked',
  password_reset_by_admin: 'Password reset by admin',
  oauth_login: 'OAuth login',
  oauth_pending: 'OAuth pending approval',
  oauth_failed: 'OAuth failed',
};

// Eventos que merecem destaque (tentativas contra contas).
const WARN_EVENTS = new Set(['login_failed', 'login_blocked', 'password_change_failed', 'password_change_blocked', 'oauth_failed']);

function label(event: string): string {
  return Object.prototype.hasOwnProperty.call(AUTH_EVENT_LABELS, event) ? AUTH_EVENT_LABELS[event] : event;
}

type LoadState = 'loading' | 'error' | 'ready';

export function AccessLogModal({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<LoadState>('loading');
  const [rows, setRows] = useState<AuthEventRow[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchAuthEvents(filter || undefined)
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
  }, [filter]);

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
      id="accessLogOverlay"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box modal-wide">
        <div className="modal-head">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <span>Access log</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <span className="set-hint">
            Sign-ins, failed attempts, lockouts, password changes and OAuth logins, with IP address and browser — entries older than 180 days
            are removed automatically. Passwords are never recorded.
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
            <label className="set-label" htmlFor="accessLogFilter" style={{ margin: 0 }}>
              Event
            </label>
            <select id="accessLogFilter" className="set-input" value={filter} onChange={ev => setFilter(ev.target.value)}>
              <option value="">All events</option>
              {Object.keys(AUTH_EVENT_LABELS).map(k => (
                <option key={k} value={k}>
                  {AUTH_EVENT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="audit-log-wrap" id="accessLogWrap">
            <table className="audit-log-table">
              <thead>
                <tr>
                  <th>Date/Time</th>
                  <th>Event</th>
                  <th>User</th>
                  <th>IP</th>
                  <th>Browser</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody id="accessLogTbody">
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
                      Failed to load the access log. Please try again.
                    </td>
                  </tr>
                )}
                {state === 'ready' &&
                  rows.map(r => (
                    <tr key={r.id}>
                      <td>{formatAuditDate(r.ts)}</td>
                      <td>
                        <span className={`audit-action-pill ${WARN_EVENTS.has(r.event) ? 'audit-action-delete' : 'audit-action-create'}`}>
                          {label(r.event)}
                        </span>
                      </td>
                      <td>{r.username || '—'}</td>
                      <td>{r.ip || '—'}</td>
                      <td title={r.user_agent || undefined} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.user_agent || '—'}
                      </td>
                      <td>{r.detail || '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="audit-log-empty" id="accessLogEmpty" style={{ display: isEmpty ? '' : 'none' }}>
              No access events found.
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
