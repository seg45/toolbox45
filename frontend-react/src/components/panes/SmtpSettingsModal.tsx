// ════════════════════════════════════════════════
// "E-mail (SMTP)" (Settings → System, super admin) — servidor usado para mandar o link de
// "Forgot password?" e os códigos de MFA por e-mail. Backend: server-py/app/routers/smtp.py.
//
// A senha do SMTP NUNCA volta do servidor (só `hasPassword`): em branco = mantém a salva.
// "Send test e-mail" usa a configuração JÁ SALVA (salve antes de testar).
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfirm } from '../../lib/useConfirm';
import { formatAuditDate } from '../../lib/folders';
import { ApiError } from '../../lib/api';
import { deleteSmtp, fetchSmtp, saveSmtp, testSmtp, type SmtpSettings } from '../../lib/accountSecurity';
import { useAuth } from '../../lib/auth';
import { overlayDismissProps } from '../../lib/overlayDismiss';

type Security = SmtpSettings['security'];
const DEFAULT_PORT: Record<Security, number> = { starttls: 587, ssl: 465, none: 25 };

export function SmtpSettingsModal({ onClose }: { onClose: () => void }) {
  const confirm = useConfirm();
  const auth = useAuth();

  const [info, setInfo] = useState<SmtpSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [security, setSecurity] = useState<Security>('starttls');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('Toolbox45');
  const [appUrl, setAppUrl] = useState(location.origin);
  const [testTo, setTestTo] = useState(auth.me?.username && auth.me.username.includes('@') ? auth.me.username : '');
  const [status, setStatus] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  function say(msg: string, isError = false) {
    setStatus(msg);
    setStatusIsError(isError);
  }

  async function load() {
    setLoading(true);
    setPassword('');
    try {
      const data = await fetchSmtp();
      setInfo(data);
      if (data.configured) {
        setHost(data.host);
        setPort(String(data.port));
        setSecurity(data.security);
        setUsername(data.username);
        setFromAddress(data.fromAddress);
        setFromName(data.fromName);
        setAppUrl(data.appUrl);
      }
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function changeSecurity(next: Security) {
    // só troca a porta se ela ainda era a padrão do modo anterior
    if (port === String(DEFAULT_PORT[security])) setPort(String(DEFAULT_PORT[next]));
    setSecurity(next);
  }

  async function handleSave() {
    const portNum = Number(port);
    if (!host.trim() || !fromAddress.trim() || !appUrl.trim()) {
      say('Host, From address and Public URL are required.', true);
      return;
    }
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      say('Port must be a number between 1 and 65535.', true);
      return;
    }
    setBusy(true);
    say('');
    try {
      await saveSmtp({
        host: host.trim(), port: portNum, security, username: username.trim(), password,
        fromAddress: fromAddress.trim(), fromName: fromName.trim(), appUrl: appUrl.trim(),
      });
      await load();
      say('Saved. "Forgot password?" now appears on the login page. Use "Send test e-mail" to check it.');
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Failed to save. Please try again.', true);
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    if (!testTo.trim()) {
      say('Enter the e-mail address that should receive the test message.', true);
      return;
    }
    setBusy(true);
    say('Sending…');
    try {
      await testSmtp(testTo.trim());
      say(`Test message sent to ${testTo.trim()}. Check the inbox (and spam).`);
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'The test message could not be sent.', true);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm(
      'Remove the SMTP settings? "Forgot password?" disappears from the login page and MFA codes can no longer be sent — accounts with MFA will sign in with the password only until SMTP is configured again.',
      { danger: true }
    );
    if (!ok) return;
    try {
      await deleteSmtp();
      setHost(''); setUsername(''); setFromAddress('');
      await load();
      say('Configuration removed.');
    } catch {
      alert('Failed to remove the configuration. Please try again.');
    }
  }

  const passwordHint = loading ? '' : info?.hasPassword
    ? 'A password is already saved. Leave blank to keep it, or type a new one to replace it.'
    : 'Leave the username and password blank if the server needs no authentication.';

  return createPortal(
    <div className="modal-overlay show" {...overlayDismissProps(onClose)}>
      <div className="modal-box modal-wide" id="smtpSettingsBox">
        <div className="modal-head">
          <span className="modal-title">E-mail (SMTP)</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">Status</span>
            <div className="audit-log-wrap" style={{ padding: '10px 12px' }}>
              <div style={{ fontSize: '12.5px', lineHeight: 1.6 }} id="smtpStatusNote">
                {loading
                  ? 'Loading…'
                  : info?.configured
                    ? `Configured${info.updatedBy ? ` by ${info.updatedBy}` : ''}${info.updatedAt ? ` on ${formatAuditDate(info.updatedAt)}` : ''}.`
                    : 'Not configured yet — "Forgot password?" and e-mail MFA stay unavailable until this is set up.'}
              </div>
              {!loading && info && !info.secretKeyConfigured && (
                <div className="set-hint" style={{ marginTop: 6 }}>
                  The server has no TOOLBOX45_SECRET_KEY, so the SMTP password is stored in plain text in the database. Set that variable in the server .env (see the install guide) and save again to encrypt it.
                </div>
              )}
            </div>
          </div>

          <div className="set-group">
            <span className="set-label">SMTP host</span>
            <input type="text" className="set-input" autoComplete="off" spellCheck={false} placeholder="smtp.example.com" value={host} onChange={ev => setHost(ev.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="set-group" style={{ flex: 1 }}>
              <span className="set-label">Security</span>
              <select className="set-input" value={security} onChange={ev => changeSecurity(ev.target.value as Security)}>
                <option value="starttls">STARTTLS (port 587)</option>
                <option value="ssl">SSL/TLS (port 465)</option>
                <option value="none">None (port 25 — not recommended)</option>
              </select>
            </div>
            <div className="set-group" style={{ width: 110 }}>
              <span className="set-label">Port</span>
              <input type="text" inputMode="numeric" className="set-input" value={port} onChange={ev => setPort(ev.target.value)} />
            </div>
          </div>
          <div className="set-group">
            <span className="set-label">Username <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></span>
            <input type="text" className="set-input" autoComplete="off" spellCheck={false} value={username} onChange={ev => setUsername(ev.target.value)} />
          </div>
          <div className="set-group">
            <span className="set-label">Password</span>
            <input type="password" className="set-input" autoComplete="new-password" spellCheck={false} value={password} onChange={ev => setPassword(ev.target.value)} />
            <span className="set-hint">{passwordHint}</span>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="set-group" style={{ flex: 1 }}>
              <span className="set-label">From address</span>
              <input type="text" className="set-input" autoComplete="off" spellCheck={false} placeholder="toolbox@example.com" value={fromAddress} onChange={ev => setFromAddress(ev.target.value)} />
            </div>
            <div className="set-group" style={{ flex: 1 }}>
              <span className="set-label">From name <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span></span>
              <input type="text" className="set-input" autoComplete="off" value={fromName} onChange={ev => setFromName(ev.target.value)} />
            </div>
          </div>
          <div className="set-group">
            <span className="set-label">Public URL of Toolbox45</span>
            <span className="set-hint">Used to build the link in the reset e-mail. Use the address people open in the browser.</span>
            <input type="text" className="set-input" autoComplete="off" spellCheck={false} placeholder="https://toolbox.example.com" value={appUrl} onChange={ev => setAppUrl(ev.target.value)} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
            <button type="button" className="btn btn-primary" id="smtpSaveBtn" disabled={busy} onClick={handleSave}>Save</button>
            <span className="set-hint" id="smtpStatusMsg" style={statusIsError ? { color: 'var(--red)' } : undefined}>{status}</span>
          </div>

          {info?.configured && (
            <div className="set-group">
              <span className="set-label">Send test e-mail</span>
              <span className="set-hint">Sends a message using the saved settings.</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="text" className="set-input" style={{ flex: 1 }} placeholder="you@example.com" value={testTo} onChange={ev => setTestTo(ev.target.value)} />
                <button type="button" className="btn btn-ghost" id="smtpTestBtn" disabled={busy} onClick={handleTest}>Send test</button>
              </div>
            </div>
          )}
          {info?.configured && (
            <div className="set-group">
              <span className="set-label">Danger zone</span>
              <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger, #e5484d)' }} onClick={handleDelete}>
                🗑️ Remove configuration
              </button>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <div></div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
