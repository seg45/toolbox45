// ════════════════════════════════════════════════
// "New local user" (#newUserOverlay no original) — porta de
// openNewUserPrompt/closeNewUserPrompt/submitNewUser (js/users-admin.js) —
// fatia 7. Mesma validação client-side do original (feedback rápido; quem
// vale de fato é o 400 validation_error do backend) ANTES do POST: e-mail
// válido + senha com pelo menos 4 caracteres.
//
// Portal pra document.body, igual a LinkEditorModal.tsx/ManageGroupModal.tsx
// (este modal é aberto de dentro do UsersPane, que já mora dentro do modal de
// Configurações — precisa escapar da stacking context dele). Overlay-click E
// Escape fecham, diferente de LinkEditorModal/ManageGroupModal (que só têm
// overlay-click) — pedido explícito desta fatia.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../lib/api';
import { createUser } from '../../lib/users';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function NewUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function handleSubmit() {
    const trimmed = username.trim();
    if (!EMAIL_RE.test(trimmed) || password.length < 4) {
      setError('A valid e-mail address is required, and the password must be at least 4 characters.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await createUser(trimmed, password, role);
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create user.');
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box">
        <div className="modal-head">
          <span className="modal-title">New local user</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">Email</span>
            <input
              className="set-input"
              type="email"
              autoComplete="off"
              autoFocus
              placeholder="e.g. jsilva@empresa.com"
              maxLength={120}
              value={username}
              onChange={ev => setUsername(ev.target.value)}
            />
          </div>
          <div className="set-group">
            <span className="set-label">Password</span>
            <input
              className="set-input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={ev => setPassword(ev.target.value)}
              onKeyDown={ev => {
                if (ev.key === 'Enter') handleSubmit();
              }}
            />
          </div>
          <div className="set-group">
            <span className="set-label">Role</span>
            <select className="set-input" value={role} onChange={ev => setRole(ev.target.value)}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>
          {error && (
            <div className="set-hint" style={{ color: 'var(--red)' }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={handleSubmit}>
            Create
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
