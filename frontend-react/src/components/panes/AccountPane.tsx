// ════════════════════════════════════════════════
// Aba "User account" do modal de Configurações — porta de index.html
// (.settings-pane[data-pane="account"], grupo #acctGroupPassword) +
// js/sharing.js (troca de senha/handle self-service).
//
// ESCOPO DESTA FATIA: troca de senha (só contas locais — PUT
// /api/me/password) e troca de handle (PUT /api/me/handle). O grupo
// "Sharing" (compartilhar pastas/comandos com outro handle — PUT
// /api/shares e afins) fica de fora por ora: mora no mesmo domínio de
// Links/grupos (fatia 6), não é "identidade da própria conta" no sentido
// estrito — é uma FEATURE própria, maior, que merece sua fatia junto com
// o resto do compartilhamento.
// ════════════════════════════════════════════════
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { ApiError, updateHandle, updatePassword } from '../../lib/api';

export function AccountPane() {
  const auth = useAuth();
  const isLocal = auth.authMethod === 'local' || auth.authMethod === undefined;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  async function submitPasswordChange() {
    setPasswordError('');
    setPasswordSuccess('');
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match.');
      return;
    }
    setPasswordBusy(true);
    try {
      await updatePassword(currentPassword, newPassword);
      setPasswordSuccess('Password updated.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e) {
      setPasswordError(e instanceof ApiError ? e.message : 'Failed to update password.');
    } finally {
      setPasswordBusy(false);
    }
  }

  const [handleValue, setHandleValue] = useState(auth.me?.handle || '');
  const [editingHandle, setEditingHandle] = useState(false);
  const [handleError, setHandleError] = useState('');
  const [handleBusy, setHandleBusy] = useState(false);

  async function saveHandle() {
    setHandleError('');
    setHandleBusy(true);
    try {
      const res = await updateHandle(handleValue);
      setHandleValue(res.handle);
      setEditingHandle(false);
      await auth.refresh();
    } catch (e) {
      setHandleError(e instanceof ApiError ? e.message : 'Failed to update handle.');
    } finally {
      setHandleBusy(false);
    }
  }

  return (
    <div className="settings-pane" data-pane="account">
      <div className="set-group" id="acctGroupPassword">
        <span className="set-label">Password</span>
        {!isLocal ? (
          <div className="set-hint">This account signs in with Google — there's no local password to change.</div>
        ) : (
          <div>
            <div className="set-group" style={{ marginTop: 8 }}>
              <span className="set-label">Current password</span>
              <input className="set-input" type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
            </div>
            <div className="set-group">
              <span className="set-label">New password</span>
              <input className="set-input" type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
            </div>
            <div className="set-group">
              <span className="set-label">Confirm new password</span>
              <input className="set-input" type="password" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
            </div>
            {passwordError && <div className="set-hint" style={{ color: 'var(--red)' }}>{passwordError}</div>}
            {passwordSuccess && <div className="set-hint" style={{ color: 'var(--green)' }}>{passwordSuccess}</div>}
            <div className="acct-btn-row">
              <button type="button" className="btn btn-sm btn-primary" disabled={passwordBusy} onClick={submitPasswordChange}>
                Change password
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="set-group" style={{ marginTop: 10 }}>
        <span className="set-label">Your handle</span>
        <div className="acct-inline-row">
          {!editingHandle ? (
            <>
              <code>{handleValue || '—'}</code>
              <button type="button" className="btn btn-sm" onClick={() => setEditingHandle(true)}>Change</button>
            </>
          ) : (
            <>
              <input
                className="set-input"
                type="text"
                style={{ maxWidth: 180 }}
                placeholder="your-handle"
                autoComplete="off"
                value={handleValue}
                onChange={e => setHandleValue(e.target.value)}
              />
              <button type="button" className="btn btn-sm btn-primary" disabled={handleBusy} onClick={saveHandle}>Save</button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setHandleValue(auth.me?.handle || '');
                  setHandleError('');
                  setEditingHandle(false);
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
        {handleError && <div className="set-hint" style={{ color: 'var(--red)' }}>{handleError}</div>}
      </div>
      {/* Sharing (share handle/folders/commands) — ver comentário no topo
          do arquivo — fica pra fatia 6. */}
    </div>
  );
}
