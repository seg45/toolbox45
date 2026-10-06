// ════════════════════════════════════════════════
// Aba "User account" do modal de Configurações — porta de index.html
// (.settings-pane[data-pane="account"], grupo #acctGroupPassword) +
// js/sharing.js (troca de senha/handle self-service + o grupo "Sharing").
//
// Fatia 6 acrescentou o grupo "Sharing" (#acctGroupSharing no original) —
// compartilhar pastas/comandos com outro handle (POST/DELETE /api/shares)
// e as duas listas "Shared by you"/"Shared with you" (GET /api/shares).
// Divergência deliberada do original: GET /api/shares já devolve
// {given, received} numa resposta só — aqui é chamado UMA vez (loadShares)
// e as duas tabelas são derivadas do mesmo resultado, em vez de duas
// buscas redundantes em paralelo (ver comentário em shares.ts). Carrega
// junto com handle/senha no mount do componente (useEffect), equivalente a
// switchSettingsPane('account') disparar renderSharingPanel() no original —
// aqui a própria aba já SER o componente monta tudo de uma vez.
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useConfirm } from '../../lib/useConfirm';
import { ApiError, updateHandle, updatePassword } from '../../lib/api';
import { createShare, deleteShare, listShares, type SharesResponse } from '../../lib/shares';

export function AccountPane() {
  const auth = useAuth();
  const confirm = useConfirm();
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

  // ── Sharing ──────────────────────────────────────────────────────────
  const [shares, setShares] = useState<SharesResponse | null>(null);
  const [sharesLoading, setSharesLoading] = useState(true);
  const [sharesLoadError, setSharesLoadError] = useState('');
  const [shareHandle, setShareHandle] = useState('');
  const shareHandleRef = useRef<HTMLInputElement>(null);
  const [shareFolders, setShareFolders] = useState(false);
  const [shareCommands, setShareCommands] = useState(false);
  const [newShareError, setNewShareError] = useState('');
  const [shareBusy, setShareBusy] = useState(false);

  async function loadShares() {
    setSharesLoading(true);
    setSharesLoadError('');
    try {
      setShares(await listShares());
    } catch (e) {
      setSharesLoadError(e instanceof ApiError ? e.message : 'Failed to load.');
    } finally {
      setSharesLoading(false);
    }
  }

  useEffect(() => {
    loadShares();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitNewShare() {
    setNewShareError('');
    const handle = shareHandle.trim().toLowerCase();
    if (!handle) {
      shareHandleRef.current?.focus();
      return;
    }
    if (!shareFolders && !shareCommands) {
      setNewShareError('Choose Folders and/or Commands to share.');
      return;
    }
    setShareBusy(true);
    try {
      await createShare(handle, shareFolders, shareCommands);
      setShareHandle('');
      setShareFolders(false);
      setShareCommands(false);
      // Só "Shared by you" precisa recarregar depois de um novo
      // compartilhamento — mesmo efeito de renderSharesGiven() isolado no
      // original — mas como listShares() busca os dois juntos numa
      // resposta só (ver comentário no topo do arquivo), recarrega tudo.
      await loadShares();
    } catch (e) {
      setNewShareError(e instanceof ApiError ? e.message : 'Failed to share.');
    } finally {
      setShareBusy(false);
    }
  }

  async function revokeShare(id: number, handle: string) {
    const ok = await confirm(`Stop sharing with "${handle}"? They will immediately lose access to whatever you shared with them.`, { danger: true });
    if (!ok) return;
    try {
      await deleteShare(id);
      await loadShares();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to revoke share. Please try again.');
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

      <div className="set-group" id="acctGroupSharing">
        <span className="set-label">Sharing</span>
        <div className="set-hint">
          Folders and commands are private by default. Share your handle with someone so they can see yours, or share below to see someone
          else's.
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
        <div className="set-group" style={{ marginTop: 14 }}>
          <span className="set-label">Share with someone</span>
          <div className="acct-inline-row">
            <input
              className="set-input"
              type="text"
              style={{ maxWidth: 180 }}
              placeholder="Their handle"
              ref={shareHandleRef}
              autoComplete="off"
              value={shareHandle}
              onChange={e => setShareHandle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitNewShare();
              }}
            />
            <label className="set-check-row" style={{ margin: 0 }}>
              <input type="checkbox" checked={shareFolders} onChange={e => setShareFolders(e.target.checked)} />
              <span>Folders</span>
            </label>
            <label className="set-check-row" style={{ margin: 0 }}>
              <input type="checkbox" checked={shareCommands} onChange={e => setShareCommands(e.target.checked)} />
              <span>Commands</span>
            </label>
            <button type="button" className="btn btn-sm btn-primary" disabled={shareBusy} onClick={submitNewShare}>
              Share
            </button>
          </div>
          {newShareError && (
            <div className="set-hint" style={{ color: 'var(--red)' }}>
              {newShareError}
            </div>
          )}
        </div>
        <div className="set-group" style={{ marginTop: 14 }}>
          <span className="set-label">Shared by you</span>
          <div className="audit-log-wrap">
            <table className="audit-log-table">
              <thead>
                <tr>
                  <th>Handle</th>
                  <th>Folders</th>
                  <th>Commands</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sharesLoading ? (
                  <tr>
                    <td colSpan={4} className="audit-log-loading">
                      Loading…
                    </td>
                  </tr>
                ) : sharesLoadError ? (
                  <tr>
                    <td colSpan={4} className="audit-log-loading">
                      {sharesLoadError}
                    </td>
                  </tr>
                ) : (
                  shares?.given.map(s => (
                    <tr key={s.id}>
                      <td>{s.grantee_handle}</td>
                      <td>{s.share_folders ? '✓' : '—'}</td>
                      <td>{s.share_commands ? '✓' : '—'}</td>
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => revokeShare(s.id, s.grantee_handle)}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {!sharesLoading && !sharesLoadError && shares?.given.length === 0 && (
              <div className="audit-log-empty">You haven't shared anything yet.</div>
            )}
          </div>
        </div>
        <div className="set-group" style={{ marginTop: 10 }}>
          <span className="set-label">Shared with you</span>
          <div className="audit-log-wrap">
            <table className="audit-log-table">
              <thead>
                <tr>
                  <th>Handle</th>
                  <th>Folders</th>
                  <th>Commands</th>
                </tr>
              </thead>
              <tbody>
                {sharesLoading ? (
                  <tr>
                    <td colSpan={3} className="audit-log-loading">
                      Loading…
                    </td>
                  </tr>
                ) : sharesLoadError ? (
                  <tr>
                    <td colSpan={3} className="audit-log-loading">
                      {sharesLoadError}
                    </td>
                  </tr>
                ) : (
                  shares?.received.map(s => (
                    <tr key={s.id}>
                      <td>{s.grantor_handle}</td>
                      <td>{s.share_folders ? '✓' : '—'}</td>
                      <td>{s.share_commands ? '✓' : '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {!sharesLoading && !sharesLoadError && shares?.received.length === 0 && (
              <div className="audit-log-empty">No one has shared anything with you yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
