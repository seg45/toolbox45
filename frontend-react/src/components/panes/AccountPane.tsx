// ════════════════════════════════════════════════
// Aba "User account" do modal de Configurações — porta de index.html
// (.settings-pane[data-pane="account"], grupo #acctGroupPassword) +
// js/sharing.js (troca de senha self-service + o grupo "Sharing").
//
// Fatia 6 acrescentou o grupo "Sharing" (#acctGroupSharing no original) —
// compartilhar pastas/comandos com outro usuário, pelo e-mail (POST/DELETE /api/shares)
// e as duas listas "Shared by you"/"Shared with you" (GET /api/shares).
// Divergência deliberada do original: GET /api/shares já devolve
// {given, received} numa resposta só — aqui é chamado UMA vez (loadShares)
// e as duas tabelas são derivadas do mesmo resultado, em vez de duas
// buscas redundantes em paralelo (ver comentário em shares.ts). Carrega
// no mount do componente (useEffect), equivalente a
// switchSettingsPane('account') disparar renderSharingPanel() no original —
// aqui a própria aba já SER o componente monta tudo de uma vez.
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useConfirm } from '../../lib/useConfirm';
import { ApiError, fetchAuthProviders, updatePassword, type AuthProviders } from '../../lib/api';
import { confirmMfa, convertToLocal, disableMfa, ssoLinkUrl, startMfa } from '../../lib/accountSecurity';
import { createShare, deleteShare, listShares, type SharesResponse } from '../../lib/shares';

export function AccountPane() {
  const auth = useAuth();
  const confirm = useConfirm();
  const isLocal = auth.me?.isLocal ?? (auth.authMethod === 'local' || auth.authMethod === undefined);
  const provider = auth.me?.authProvider ?? auth.authMethod;
  const providerLabel = provider === 'microsoft' ? 'Microsoft' : provider === 'google' ? 'Google' : 'single sign-on';

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

  // ── Método de login (local ⇄ SSO) ─────────────────────────────────────
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [toLocalPw, setToLocalPw] = useState('');
  const [toLocalPw2, setToLocalPw2] = useState('');
  const [methodMsg, setMethodMsg] = useState('');
  const [methodIsError, setMethodIsError] = useState(false);
  const [methodBusy, setMethodBusy] = useState(false);

  useEffect(() => {
    fetchAuthProviders().then(p => setProviders(p));
  }, []);

  async function switchToSso(provider: 'google' | 'microsoft') {
    const label = provider === 'google' ? 'Google' : 'Microsoft';
    const ok = await confirm(
      `Switch this account to ${label} sign-in? You will be sent to ${label} to confirm that you own ${auth.me?.username}. After that the password stops working (and MFA by e-mail is turned off — ${label} handles it). You can switch back to a password later.`
    );
    if (!ok) return;
    location.href = ssoLinkUrl(provider);
  }

  async function submitToLocal() {
    setMethodMsg('');
    setMethodIsError(false);
    if (toLocalPw.length < 8) {
      setMethodMsg('Password must be at least 8 characters.');
      setMethodIsError(true);
      return;
    }
    if (toLocalPw !== toLocalPw2) {
      setMethodMsg('The two passwords do not match.');
      setMethodIsError(true);
      return;
    }
    const ok = await confirm(`Switch this account to password sign-in? ${providerLabel} sign-in will stop working for it. You can switch back later.`);
    if (!ok) return;
    setMethodBusy(true);
    try {
      await convertToLocal(toLocalPw);
      setToLocalPw('');
      setToLocalPw2('');
      setMethodMsg('Done — from now on you sign in with your e-mail and this password.');
      await auth.refresh();
    } catch (e) {
      setMethodMsg(e instanceof ApiError ? e.message : 'Could not switch to password sign-in.');
      setMethodIsError(true);
    } finally {
      setMethodBusy(false);
    }
  }

  // ── MFA por e-mail ──────────────────────────────────────────────────
  const mfa = auth.me?.mfa;
  const [mfaChallenge, setMfaChallenge] = useState('');
  const [mfaMasked, setMfaMasked] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaOffPw, setMfaOffPw] = useState('');
  const [mfaMsg, setMfaMsg] = useState('');
  const [mfaIsError, setMfaIsError] = useState(false);
  const [mfaBusy, setMfaBusy] = useState(false);

  function mfaSay(msg: string, isError = false) {
    setMfaMsg(msg);
    setMfaIsError(isError);
  }

  async function beginMfa() {
    mfaSay('');
    setMfaBusy(true);
    try {
      const r = await startMfa();
      setMfaChallenge(r.challenge);
      setMfaMasked(r.maskedEmail);
      setMfaCode('');
      mfaSay(`We sent a 6-digit code to ${r.maskedEmail}.`);
    } catch (e) {
      mfaSay(e instanceof ApiError ? e.message : 'Could not send the verification code.', true);
    } finally {
      setMfaBusy(false);
    }
  }

  async function finishMfa() {
    mfaSay('');
    if (!/^\d{6}$/.test(mfaCode.replace(/\s+/g, ''))) {
      mfaSay('Enter the 6-digit code from the e-mail.', true);
      return;
    }
    setMfaBusy(true);
    try {
      await confirmMfa(mfaChallenge, mfaCode.replace(/\s+/g, ''));
      setMfaChallenge('');
      setMfaCode('');
      await auth.refresh();
      mfaSay('MFA is on. From now on, signing in asks for a code sent to your e-mail.');
    } catch (e) {
      mfaSay(e instanceof ApiError ? e.message : 'Could not verify the code.', true);
      if (e instanceof ApiError && e.code === 'invalid_challenge') setMfaChallenge('');
    } finally {
      setMfaBusy(false);
    }
  }

  async function turnOffMfa() {
    mfaSay('');
    if (!mfaOffPw) {
      mfaSay('Enter your password to turn MFA off.', true);
      return;
    }
    setMfaBusy(true);
    try {
      await disableMfa(mfaOffPw);
      setMfaOffPw('');
      await auth.refresh();
      mfaSay('MFA is off.');
    } catch (e) {
      mfaSay(e instanceof ApiError ? e.message : 'Could not turn MFA off.', true);
    } finally {
      setMfaBusy(false);
    }
  }

  // ── Sharing ──────────────────────────────────────────────────────────
  const [shares, setShares] = useState<SharesResponse | null>(null);
  const [sharesLoading, setSharesLoading] = useState(true);
  const [sharesLoadError, setSharesLoadError] = useState('');
  const [shareEmail, setShareEmail] = useState('');
  const shareEmailRef = useRef<HTMLInputElement>(null);
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
    const email = shareEmail.trim().toLowerCase();
    if (!email) {
      shareEmailRef.current?.focus();
      return;
    }
    if (!shareFolders && !shareCommands) {
      setNewShareError('Choose Folders and/or Commands to share.');
      return;
    }
    setShareBusy(true);
    try {
      await createShare(email, shareFolders, shareCommands);
      setShareEmail('');
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

  async function revokeShare(id: number, email: string) {
    const ok = await confirm(`Stop sharing with "${email}"? They will immediately lose access to whatever you shared with them.`, { danger: true });
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
          <div className="set-hint">This account signs in with {providerLabel} — there's no local password to change.</div>
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

      <div className="set-group" id="acctGroupSignIn">
        <span className="set-label">Sign-in method</span>
        {isLocal ? (
          <div>
            <div className="set-hint">
              This account signs in with its <strong>e-mail and password</strong>. You can switch it to single sign-on (Google or Microsoft) instead — the
              provider must use the same e-mail as this account.
            </div>
            <div className="acct-btn-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" id="switchToGoogle" disabled={!providers?.google} onClick={() => switchToSso('google')}>
                Switch to Google sign-in
              </button>
              <button type="button" className="btn btn-sm" id="switchToMicrosoft" disabled={!providers?.microsoft} onClick={() => switchToSso('microsoft')}>
                Switch to Microsoft sign-in
              </button>
            </div>
            {providers && !providers.google && !providers.microsoft && (
              <div className="set-hint" id="ssoNotConfigured">Single sign-on is not configured on this server (an administrator can set it up in Settings → System).</div>
            )}
          </div>
        ) : (
          <div>
            <div className="set-hint">
              This account signs in with <strong>{providerLabel}</strong>. You can switch it to <strong>e-mail and password</strong> instead: choose a password
              below. {providerLabel} sign-in then stops working for this account.
            </div>
            {provider === 'google' || provider === 'microsoft' ? (
              <div style={{ marginTop: 8 }}>
                <div className="set-group">
                  <span className="set-label">New password</span>
                  <input className="set-input" id="toLocalPw" type="password" autoComplete="new-password" value={toLocalPw} onChange={e => setToLocalPw(e.target.value)} />
                </div>
                <div className="set-group">
                  <span className="set-label">Confirm new password</span>
                  <input className="set-input" id="toLocalPw2" type="password" autoComplete="new-password" value={toLocalPw2} onChange={e => setToLocalPw2(e.target.value)} />
                </div>
                <div className="acct-btn-row">
                  <button type="button" className="btn btn-sm btn-primary" id="switchToLocal" disabled={methodBusy} onClick={submitToLocal}>
                    Switch to password sign-in
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
        {methodMsg && (
          <div className="set-hint" id="signInMethodMsg" style={{ color: methodIsError ? 'var(--red)' : 'var(--green)' }}>
            {methodMsg}
          </div>
        )}
      </div>

      {isLocal && auth.me?.mfa && (
        <div className="set-group" id="acctGroupMfa">
          <span className="set-label">Multi-factor authentication (e-mail)</span>
          <div className="set-hint" id="mfaStatusLine">
            {mfa?.enabled
              ? 'MFA is ON: after your password, sign-in asks for a 6-digit code sent to your e-mail.'
              : 'MFA is OFF. Turn it on to receive a 6-digit code by e-mail every time you sign in.'}
            {mfa?.required ? ' An administrator requires MFA for this account.' : ''}
          </div>
          {!mfa?.enabled && !mfa?.available && (
            <div className="set-hint" id="mfaUnavailable">E-mail is not configured on this server, so MFA is not available yet. Ask an administrator.</div>
          )}
          {!mfa?.enabled && mfa?.available && !mfaChallenge && (
            <div className="acct-btn-row">
              <button type="button" className="btn btn-sm btn-primary" id="mfaEnableBtn" disabled={mfaBusy} onClick={beginMfa}>
                Turn on MFA
              </button>
            </div>
          )}
          {!mfa?.enabled && mfaChallenge && (
            <div className="set-group" style={{ marginTop: 8 }}>
              <span className="set-label">Code sent to {mfaMasked}</span>
              <div className="acct-inline-row">
                <input
                  className="set-input"
                  id="mfaConfirmCode"
                  style={{ maxWidth: 160 }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  value={mfaCode}
                  onChange={e => setMfaCode(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') finishMfa();
                  }}
                />
                <button type="button" className="btn btn-sm btn-primary" id="mfaConfirmBtn" disabled={mfaBusy} onClick={finishMfa}>
                  Confirm
                </button>
                <button type="button" className="btn btn-sm" disabled={mfaBusy} onClick={beginMfa}>
                  Send a new code
                </button>
              </div>
            </div>
          )}
          {mfa?.enabled && !mfa.required && (
            <div className="set-group" style={{ marginTop: 8 }}>
              <span className="set-label">Password (to turn MFA off)</span>
              <div className="acct-inline-row">
                <input className="set-input" id="mfaOffPw" type="password" style={{ maxWidth: 240 }} autoComplete="current-password" value={mfaOffPw} onChange={e => setMfaOffPw(e.target.value)} />
                <button type="button" className="btn btn-sm" id="mfaDisableBtn" disabled={mfaBusy} onClick={turnOffMfa}>
                  Turn off MFA
                </button>
              </div>
            </div>
          )}
          {mfaMsg && (
            <div className="set-hint" id="mfaMsg" style={{ color: mfaIsError ? 'var(--red)' : 'var(--green)' }}>
              {mfaMsg}
            </div>
          )}
        </div>
      )}

      <div className="set-group" id="acctGroupSharing">
        <span className="set-label">Sharing</span>
        <div className="set-hint">
          Folders and commands are private by default. Share with someone by e-mail so they can see yours; what others share with you shows up below.
        </div>
        <div className="set-group" style={{ marginTop: 10 }}>
          <span className="set-label">Share with someone</span>
          <div className="acct-inline-row">
            <input
              className="set-input"
              type="email"
              style={{ maxWidth: 240 }}
              placeholder="Their e-mail"
              ref={shareEmailRef}
              autoComplete="off"
              value={shareEmail}
              onChange={e => setShareEmail(e.target.value)}
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
                  <th>Email</th>
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
                      <td>{s.grantee_email}</td>
                      <td>{s.share_folders ? '✓' : '—'}</td>
                      <td>{s.share_commands ? '✓' : '—'}</td>
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => revokeShare(s.id, s.grantee_email)}>
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
                  <th>Email</th>
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
                      <td>{s.grantor_email}</td>
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
