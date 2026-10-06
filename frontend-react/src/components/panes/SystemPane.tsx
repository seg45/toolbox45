// ════════════════════════════════════════════════
// Aba "System" do modal de Configurações — porta de
// .settings-pane[data-pane="system"] (index.html) — fatia 8. O item de nav
// em si nunca é gated (ver SettingsModal.tsx/SYSTEM_NAV_ITEM); CADA um dos
// 5 widgets abaixo decide por si se renderiza, usando useAuth() aqui
// dentro — mesmo critério do original (botão `data-pane="system"` sem
// nenhum atributo de gate; só os `set-group`s internos eram
// `display:none`). Se `!auth.isAdmin`, a aba fica efetivamente vazia —
// comportamento esperado, não um estado de erro.
//
// Auditoria de segurança (out/2026, item 8): SSL Certificate e OAuth
// Integrations são só para super admin (o backend responde 403 ao admin
// comum), então os dois widgets só aparecem com `auth.isSuperAdmin`.
//
// Logo/Default theme & colors/SSL Certificate têm um botão "Manage …" (com
// ícone, como no original) que abre o modal cheio; OAuth Integrations lista
// as duas linhas com "Configure" — só "API access" é
// diferente: a LISTA de chaves fica inline aqui mesmo (sem modal de lista),
// mesmo critério do original citado no prompt desta fatia.
// ════════════════════════════════════════════════
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useConfirm } from '../../lib/useConfirm';
import { formatAuditDate } from '../../lib/folders';
import {
  ApiError,
  deleteApiKey,
  createApiKey as apiCreateApiKey,
  fetchApiKeys,
  fetchOAuthProviders,
  type ApiKeyRow,
  type OAuthProviderInfo,
} from '../../lib/api';
import { LogoSettingsModal } from './LogoSettingsModal';
import { AppearanceSettingsModal } from './AppearanceSettingsModal';
import { SslCertificateModal } from './SslCertificateModal';
import { OAuthSettingsModal, OAUTH_PROVIDER_META, type OAuthProviderKey } from './OAuthSettingsModal';
import { NewApiKeyModal } from './NewApiKeyModal';
import { ApiKeyRevealModal } from './ApiKeyRevealModal';

const OAUTH_PROVIDERS: OAuthProviderKey[] = ['google', 'microsoft'];

// _akFormatExpiry() do original — "Never" quando null, senão a data
// formatada + " (expired)" se já passou.
function formatExpiry(iso: string | null): string {
  if (!iso) return 'Never';
  const label = formatAuditDate(iso);
  const expired = new Date(iso).getTime() <= Date.now();
  return expired ? `${label} (expired)` : label;
}

function oauthStatusFor(info: OAuthProviderInfo | undefined, failed: boolean): { text: string; on: boolean } {
  if (failed) return { text: 'Failed to load status.', on: false };
  if (!info) return { text: 'Loading…', on: false };
  if (info.configured && info.source === 'env') return { text: 'Configured (via server .env)', on: true };
  if (info.configured) return { text: 'Configured', on: true };
  return { text: 'Not configured', on: false };
}

export function SystemPane({ onLogoChanged }: { onLogoChanged: () => Promise<void> }) {
  const auth = useAuth();
  const confirm = useConfirm();

  const [logoOpen, setLogoOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [sslOpen, setSslOpen] = useState(false);
  const [oauthProvider, setOauthProvider] = useState<OAuthProviderKey | null>(null);

  const [oauthStatus, setOauthStatus] = useState<Record<OAuthProviderKey, OAuthProviderInfo> | null>(null);
  const [oauthStatusFailed, setOauthStatusFailed] = useState(false);

  const [apiKeys, setApiKeys] = useState<ApiKeyRow[] | null>(null);
  const [apiKeysError, setApiKeysError] = useState('');
  const [newApiKeyOpen, setNewApiKeyOpen] = useState(false);
  const [revealKey, setRevealKey] = useState<string | null>(null);

  const loadOauthStatus = useCallback(async () => {
    setOauthStatusFailed(false);
    try {
      setOauthStatus(await fetchOAuthProviders());
    } catch {
      setOauthStatusFailed(true);
    }
  }, []);

  const loadApiKeys = useCallback(async () => {
    setApiKeysError('');
    try {
      setApiKeys(await fetchApiKeys());
    } catch (e) {
      setApiKeysError(e instanceof ApiError ? e.message : 'Failed to load API keys. Please try again.');
    }
  }, []);

  useEffect(() => {
    if (auth.isSuperAdmin) loadOauthStatus();
    if (auth.isAdmin) loadApiKeys();
  }, [auth.isAdmin, auth.isSuperAdmin, loadOauthStatus, loadApiKeys]);

  // createApiKey() do original: a mutação de rede em si (POST + refresh da
  // lista + abrir o reveal) mora aqui, não dentro de NewApiKeyModal — ver
  // comentário no topo daquele arquivo.
  async function handleCreateApiKey(name: string, role: 'admin' | 'user', validity: string) {
    try {
      const data = await apiCreateApiKey(name, role, validity);
      await loadApiKeys();
      setRevealKey(data.key);
    } catch {
      alert('Failed to create API key. Please try again.');
    }
  }

  async function handleDeleteApiKey(row: ApiKeyRow) {
    const ok = await confirm(
      `Delete the API key "${row.name}"? Any integration still using it will stop working immediately, and this cannot be undone.`,
      { danger: true }
    );
    if (!ok) return;
    try {
      await deleteApiKey(row.id);
      await loadApiKeys();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to delete API key. Please try again.');
    }
  }

  return (
    <div className="settings-pane" data-pane="system">
      {auth.isAdmin && (
        <div className="set-group" id="sysGroupLogo">
          <span className="set-label">Logo</span>
          <span className="set-hint">Replace the logo shown in the header and on the sign-in page.</span>
          <div className="settings-action-row">
            <button type="button" className="btn btn-ghost" id="logoSettingsBtn" onClick={() => setLogoOpen(true)}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="1.3" stroke="currentColor" strokeWidth="1.3" /><circle cx="5.6" cy="6" r="1.2" stroke="currentColor" strokeWidth="1.1" /><path d="M2.8 12l3.6-4 2.4 2.6 1.7-2 2.7 3.4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" /></svg>
              <span>Manage logo</span>
            </button>
          </div>
        </div>
      )}

      {/* Único widget desta fatia que exige super_admin (não só admin) —
          ver AppearanceSettingsModal.tsx/PUT /api/system/appearance no
          backend. */}
      {auth.isSuperAdmin && (
        <div className="set-group" id="sysGroupAppearance">
          <span className="set-label">Default theme &amp; colors</span>
          <span className="set-hint">Theme and accent color new users get before they choose their own.</span>
          <div className="settings-action-row">
            <button type="button" className="btn btn-ghost" id="appearanceSettingsBtn" onClick={() => setAppearanceOpen(true)}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" /><circle cx="6" cy="6.3" r=".9" fill="currentColor" /><circle cx="9.5" cy="5.6" r=".7" fill="currentColor" /><circle cx="10.3" cy="9" r=".8" fill="currentColor" /><circle cx="6.5" cy="9.7" r=".7" fill="currentColor" /></svg>
              <span>Manage appearance</span>
            </button>
          </div>
        </div>
      )}

      {auth.isSuperAdmin && (
        <div className="set-group" id="sysGroupSslCertificate">
          <span className="set-label">SSL Certificate</span>
          <span className="set-hint">Upload or reset the HTTPS certificate served by this installation.</span>
          <div className="settings-action-row">
            <button type="button" className="btn btn-ghost" id="sslCertificateBtn" onClick={() => setSslOpen(true)}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.3" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="8" cy="10.2" r=".9" fill="currentColor" /></svg>
              <span>Manage certificate</span>
            </button>
          </div>
        </div>
      )}

      {auth.isSuperAdmin && (
        <div className="set-group" id="sysGroupOAuth">
          <span className="set-label">OAuth Integrations</span>
          <span className="set-hint">
            Lets people log in or self-register with a Google or Microsoft account, in addition to a local username/password (login.html).
            Optional — local login always works either way.
          </span>
          <div className="audit-log-wrap" id="oauthProviderListWrap" style={{ padding: 2 }}>
          {OAUTH_PROVIDERS.map(provider => {
            const meta = OAUTH_PROVIDER_META[provider];
            const { text, on } = oauthStatusFor(oauthStatus?.[provider], oauthStatusFailed);
            return (
              <div className="oauth-provider-row" id={`oauthRow-${provider}`} key={provider}>
                <span className="oauth-provider-icon">{meta.icon}</span>
                <span className="oauth-provider-name">{meta.label}</span>
                <span className={`oauth-provider-status${on ? ' is-on' : ''}`}>{text}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOauthProvider(provider)}>
                  Configure
                </button>
              </div>
            );
          })}
          </div>
        </div>
      )}

      {auth.isAdmin && (
        <div className="set-group">
          <span className="set-label">API access</span>
          <span className="set-hint">Keys for scripts and integrations that call the Toolbox45 API.</span>
          <div className="settings-action-row">
            <button type="button" className="btn btn-ghost" onClick={() => setNewApiKeyOpen(true)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2v12M2 8h12" />
              </svg>
              <span>New API key</span>
            </button>
          </div>
          <div className="audit-log-wrap" style={{ maxHeight: '58vh' }}>
            <table className="audit-log-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Key</th>
                  <th>Created by</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {apiKeysError ? (
                  <tr>
                    <td colSpan={8} className="audit-log-loading">
                      {apiKeysError}
                    </td>
                  </tr>
                ) : apiKeys === null ? (
                  <tr>
                    <td colSpan={8} className="audit-log-loading">
                      Loading…
                    </td>
                  </tr>
                ) : apiKeys.length === 0 ? null : (
                  apiKeys.map(row => {
                    const isExpired = !!row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
                    const dimmed = !!row.revoked_at || isExpired;
                    return (
                      <tr key={row.id} style={dimmed ? { opacity: 0.5 } : undefined}>
                        <td>{row.name}</td>
                        <td>{row.role === 'admin' ? 'Admin' : 'User'}</td>
                        <td>
                          <code>{row.key_prefix}…</code>
                        </td>
                        <td>{row.created_by || '—'}</td>
                        <td>{formatAuditDate(row.created_at)}</td>
                        <td>{formatExpiry(row.expires_at)}</td>
                        <td>{row.last_used_at ? formatAuditDate(row.last_used_at) : '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button type="button" className="sec-folder-btn" title="Delete" onClick={() => handleDeleteApiKey(row)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M4 7h16" />
                              <path d="M10 11v6M14 11v6" />
                              <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
                              <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            {apiKeys !== null && !apiKeysError && apiKeys.length === 0 && (
              <div className="audit-log-empty">No API keys yet — click "New API key" to create the first one.</div>
            )}
          </div>
        </div>
      )}

      {logoOpen && <LogoSettingsModal onClose={() => setLogoOpen(false)} onLogoChanged={onLogoChanged} />}
      {appearanceOpen && <AppearanceSettingsModal onClose={() => setAppearanceOpen(false)} />}
      {sslOpen && <SslCertificateModal onClose={() => setSslOpen(false)} />}
      {oauthProvider && (
        <OAuthSettingsModal
          provider={oauthProvider}
          onClose={() => {
            setOauthProvider(null);
            loadOauthStatus();
          }}
        />
      )}
      {newApiKeyOpen && <NewApiKeyModal onClose={() => setNewApiKeyOpen(false)} onSubmit={handleCreateApiKey} />}
      {revealKey && <ApiKeyRevealModal apiKey={revealKey} onClose={() => setRevealKey(null)} />}
    </div>
  );
}
