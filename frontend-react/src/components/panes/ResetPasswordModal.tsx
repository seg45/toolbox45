// ════════════════════════════════════════════════
// "Reset password — {username}" (#resetPasswordOverlay no original) — porta
// de openResetPasswordPrompt/closeResetPasswordPrompt/submitResetPassword
// (js/users-admin.js) — fatia 7. Só para usuários locais (ver botão
// condicional em UsersPane.tsx). Ao salvar, fecha o modal mas NÃO recarrega
// a lista de usuários — não há nenhuma coluna visível que mude com a troca
// de senha (mesmo comportamento do original).
//
// Portal pra document.body + overlay-click/Escape fecham, mesmo padrão de
// NewUserModal.tsx.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../lib/api';
import { resetUserPassword } from '../../lib/users';

export function ResetPasswordModal({ username, onClose }: { username: string; onClose: () => void }) {
  const [password, setPassword] = useState('');
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
    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await resetUserPassword(username, password);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to reset password.');
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
          <span className="modal-title">Reset password — {username}</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">New password</span>
            <input
              className="set-input"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={ev => setPassword(ev.target.value)}
              onKeyDown={ev => {
                if (ev.key === 'Enter') handleSubmit();
              }}
            />
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
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
