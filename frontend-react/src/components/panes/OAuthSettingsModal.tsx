// ════════════════════════════════════════════════
// "Configure {provider} sign-in" (Settings → System → OAuth Integrations)
// — porta de js/oauth-settings.js (100% novo nesta fatia — não existia em
// nenhuma fatia anterior). Um único modal, conteúdo dinâmico por provider
// (google/microsoft) — mesmo padrão de #oauthSettingsOverlay no original.
//
// OAUTH_PROVIDER_META é exportado pra SystemPane.tsx reaproveitar o mesmo
// ícone/label nas linhas de status (.oauth-provider-row) fora do modal.
// ════════════════════════════════════════════════
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useConfirm } from '../../lib/useConfirm';
import { formatAuditDate } from '../../lib/folders';
import { ApiError, deleteOAuthProvider, fetchOAuthProviders, saveOAuthProvider, type OAuthProviderInfo } from '../../lib/api';
import { CopyButton } from '../commands/CopyButton';

export type OAuthProviderKey = 'google' | 'microsoft';

const GOOGLE_ICON: ReactNode = (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.4 0 6.4 1.2 8.8 3.5l6.6-6.6C35.2 2.6 30 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.7 6C12.2 13.1 17.6 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.9 38 46.5 31.8 46.5 24.5z" />
    <path fill="#FBBC05" d="M10.3 19.2c-.5 1.5-.8 3.1-.8 4.8s.3 3.3.8 4.8l-7.7 6C1 31 0 27.7 0 24s1-7 2.6-10l7.7 6.2z" />
    <path fill="#34A853" d="M24 48c6 0 11.2-2 14.9-5.4l-7.5-5.8c-2.1 1.4-4.7 2.2-7.4 2.2-6.4 0-11.8-3.6-13.7-8.7l-7.7 6C6.5 42.6 14.6 48 24 48z" />
  </svg>
);

const MICROSOFT_ICON: ReactNode = (
  <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#F25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
    <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
    <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
  </svg>
);

export const OAUTH_PROVIDER_META: Record<OAuthProviderKey, { label: string; clientIdPlaceholder: string; icon: ReactNode }> = {
  google: {
    label: 'Google',
    clientIdPlaceholder: 'e.g. 1234567890-abc123.apps.googleusercontent.com',
    icon: GOOGLE_ICON,
  },
  microsoft: {
    label: 'Microsoft',
    clientIdPlaceholder: 'e.g. b05f5306-31ee-434f-982e-8dd70c1bc365',
    icon: MICROSOFT_ICON,
  },
};

function sourceNote(info: OAuthProviderInfo | null): string {
  if (!info) return '';
  if (info.source === 'db') {
    return `Configured here${info.updatedBy ? ` by ${info.updatedBy}` : ''}${info.updatedAt ? ` on ${formatAuditDate(info.updatedAt)}` : ''}.`;
  }
  if (info.source === 'env') {
    return "Configured via the server's environment variables (.env). Saving a configuration here will take priority over those.";
  }
  return 'Not configured yet — the sign-in button stays hidden on the login page until this is set up.';
}

function stepsFor(provider: OAuthProviderKey): ReactNode {
  if (provider === 'google') {
    return (
      <ol>
        <li>
          In the{' '}
          <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">
            <strong>Google Cloud Console</strong>
          </a>
          , create (or reuse) a project and go to <strong>APIs &amp; Services → OAuth consent screen</strong> — set up a basic app (name, support
          e-mail); "External" works even for internal use.
        </li>
        <li>
          In <strong>APIs &amp; Services → Credentials → Create Credentials → OAuth client ID</strong>, type <strong>Web application</strong>.
        </li>
        <li>Under <strong>Authorized redirect URIs</strong>, add the EXACT URL shown below in "Redirect URI to register with the provider".</li>
        <li>
          Copy the generated <strong>Client ID</strong> and <strong>Client secret</strong> and paste them into the fields below.
        </li>
      </ol>
    );
  }
  return (
    <ol>
      <li>
        In the{' '}
        <a href="https://portal.azure.com/" target="_blank" rel="noopener noreferrer">
          <strong>Azure Portal</strong>
        </a>
        , go to <strong>Microsoft Entra ID → App registrations → New registration</strong>.
      </li>
      <li>Give the app a name.</li>
      <li>
        Under <strong>Supported account types</strong>, choose "Accounts in any organizational directory and personal Microsoft accounts". Add a{' '}
        <strong>Redirect URI</strong> of type <strong>Web</strong> with the EXACT URL shown below.
      </li>
      <li>
        Copy the <strong>Application (client) ID</strong>.
      </li>
      <li>
        Under <strong>Certificates &amp; secrets → Client secrets → New client secret</strong>, copy the <strong>Value</strong> right away — it
        only appears once.
      </li>
    </ol>
  );
}

export function OAuthSettingsModal({ provider, onClose }: { provider: OAuthProviderKey; onClose: () => void }) {
  const confirm = useConfirm();
  const meta = OAUTH_PROVIDER_META[provider];
  const suggestedRedirectUri = `${location.origin}/api/auth/${provider}/callback`;

  const [info, setInfo] = useState<OAuthProviderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(suggestedRedirectUri);
  const [tenantId, setTenantId] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // openOauthSettingsModal() do original: reseta campos, busca o status
  // atual (GET /api/system/oauth) e preenche o que já existe — client
  // secret NUNCA pré-preenchido, mesmo quando já existe salvo
  // (clientSecretSet só informa SE existe, não o valor).
  async function load() {
    setLoading(true);
    setClientSecret('');
    try {
      const data = await fetchOAuthProviders();
      const providerInfo = data[provider];
      setInfo(providerInfo);
      setClientId(providerInfo?.clientId || '');
      setRedirectUri(providerInfo?.redirectUri || suggestedRedirectUri);
      // 'common' (valor default do backend quando nenhum tenant foi
      // restringido) vira campo vazio — mesma regra do original.
      setTenantId(providerInfo?.tenantId && providerInfo.tenantId !== 'common' ? providerInfo.tenantId : '');
    } catch {
      setInfo(null);
      setClientId('');
      setRedirectUri(suggestedRedirectUri);
      setTenantId('');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function handleSave() {
    const trimmedClientId = clientId.trim();
    const trimmedRedirect = redirectUri.trim();
    if (!trimmedClientId || !trimmedRedirect) {
      setStatus('Client ID and Redirect URI are required.');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      await saveOAuthProvider(provider, {
        clientId: trimmedClientId,
        clientSecret,
        redirectUri: trimmedRedirect,
        tenantId: provider === 'microsoft' ? tenantId.trim() || undefined : undefined,
      });
      setStatus('Saved. The sign-in button now appears on the login page.');
      await load();
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : 'Failed to save. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm(
      `Remove the ${meta.label} sign-in configuration? It will revert to the server's environment variables, if set — otherwise sign-in with ${meta.label} is disabled again.`,
      { danger: true }
    );
    if (!ok) return;
    try {
      await deleteOAuthProvider(provider);
      await load();
      setStatus('Configuration removed.');
    } catch {
      alert('Failed to remove the configuration. Please try again.');
    }
  }

  const clientSecretHint = loading ? '' : info?.clientSecretSet
    ? 'A secret is already saved. Leave this blank to keep it, or enter a new value to replace it.'
    : 'Required.';

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
            <span className="oauth-provider-icon">{meta.icon}</span>
            <span>Configure {meta.label} sign-in</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">Status</span>
            <div className="audit-log-wrap" style={{ padding: '10px 12px' }}>
              <div style={{ fontSize: '12.5px', lineHeight: 1.6 }}>{loading ? 'Loading…' : sourceNote(info)}</div>
            </div>
          </div>
          <div className="set-group">
            <span className="set-label">How to get these values</span>
            <div className="oauth-steps-box">{stepsFor(provider)}</div>
          </div>
          <div className="set-group">
            <span className="set-label">Redirect URI to register with the provider</span>
            <span className="set-hint">
              Copy this EXACT URL into the provider's console (Authorized redirect URI) — it must match the field below character for character.
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="text"
                className="set-input"
                readOnly
                style={{ fontFamily: 'var(--mono)', fontSize: '11.5px', flex: 1 }}
                value={suggestedRedirectUri}
              />
              <CopyButton text={suggestedRedirectUri} />
            </div>
          </div>
          <div className="set-group">
            <span className="set-label">Client ID</span>
            <input
              type="text"
              className="set-input"
              autoComplete="off"
              spellCheck={false}
              placeholder={meta.clientIdPlaceholder}
              value={clientId}
              onChange={ev => setClientId(ev.target.value)}
            />
          </div>
          <div className="set-group">
            <span className="set-label">Client Secret</span>
            <input
              type="password"
              className="set-input"
              autoComplete="off"
              spellCheck={false}
              value={clientSecret}
              onChange={ev => setClientSecret(ev.target.value)}
            />
            <span className="set-hint">{clientSecretHint}</span>
          </div>
          <div className="set-group">
            <span className="set-label">Redirect URI</span>
            <input
              type="text"
              className="set-input"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://your-domain/api/auth/google/callback"
              value={redirectUri}
              onChange={ev => setRedirectUri(ev.target.value)}
            />
          </div>
          {provider === 'microsoft' && (
            <div className="set-group">
              <span className="set-label">
                Tenant ID <span style={{ textTransform: 'none', fontWeight: 400 }}>(optional)</span>
              </span>
              <span className="set-hint">
                Leave blank (or "common") to accept any Microsoft account — personal or from any organization. Set a tenant ID/domain here only to
                restrict sign-in to a single organization.
              </span>
              <input type="text" className="set-input" placeholder="common" value={tenantId} onChange={ev => setTenantId(ev.target.value)} />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={handleSave}>
              Save
            </button>
            <span className="set-hint">{status}</span>
          </div>
          {info?.source === 'db' && (
            <div className="set-group">
              <span className="set-label">Danger zone</span>
              <span className="set-hint">
                Removes this configuration. Sign-in for this provider reverts to the server's environment variables, if set — otherwise it's
                disabled again.
              </span>
              <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger, #e5484d)' }} onClick={handleDelete}>
                🗑️ Remove configuration
              </button>
            </div>
          )}
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
