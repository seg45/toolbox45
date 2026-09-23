// ════════════════════════════════════════════════
// OAUTH INTEGRATIONS — Settings → System → OAuth Integrations (admin-only,
// ver ADMIN_ONLY_SETTINGS_GROUP_IDS em js/auth.js). Pedido do usuário:
// "coloque em system a opção para integrar o login e registro com o Google
// e Microsoft. inclua a instrução de como realizar a integração tb".
//
// Um único modal (#oauthSettingsOverlay) é reaproveitado pros dois
// provedores — openOauthSettingsModal('google'|'microsoft') troca título,
// ícone, passo a passo e campos (Tenant ID só existe pro Microsoft). Client
// ID/Secret/Redirect URI/Tenant ID são salvos em oauth_settings (ver
// server/schema.sql) via PUT /api/system/oauth/:provider — têm prioridade
// sobre as variáveis de ambiente GOOGLE_*/MICROSOFT_* (que continuam
// funcionando como fallback, ver reloadOAuthConfig() em server/index.js e
// docs/server-overview.md, pra quem já configurou via .env). O client
// secret nunca volta na resposta da API depois de salvo — só um booleano
// "clientSecretSet" (GET /api/system/oauth) — por isso o campo de senha
// aqui nunca vem pré-preenchido, mesmo quando já existe um configurado.
// ════════════════════════════════════════════════

let _oauthCurrentProvider = null;
let _oauthStatusCache = null; // último GET /api/system/oauth (os 2 provedores)

function _oauthEscHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _oauthFormatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const OAUTH_PROVIDER_META = {
  google: {
    label: 'Google',
    icon: '<svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.4 0 6.4 1.2 8.8 3.5l6.6-6.6C35.2 2.6 30 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.7 6C12.2 13.1 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.9 38 46.5 31.8 46.5 24.5z"/><path fill="#FBBC05" d="M10.3 19.2c-.5 1.5-.8 3.1-.8 4.8s.3 3.3.8 4.8l-7.7 6C1 31 0 27.7 0 24s1-7 2.6-10l7.7 6.2z"/><path fill="#34A853" d="M24 48c6 0 11.2-2 14.9-5.4l-7.5-5.8c-2.1 1.4-4.7 2.2-7.4 2.2-6.4 0-11.8-3.6-13.7-8.7l-7.7 6C6.5 42.6 14.6 48 24 48z"/></svg>',
    clientIdPlaceholder: 'e.g. 1234567890-abc123.apps.googleusercontent.com',
  },
  microsoft: {
    label: 'Microsoft',
    icon: '<svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>',
    clientIdPlaceholder: 'e.g. b05f5306-31ee-434f-982e-8dd70c1bc365',
  },
};

// Passo a passo — mesmo conteúdo de "Login com Google/Microsoft (opcional)"
// em docs/server-overview.md, adaptado pra quem está configurando direto
// pela tela (os passos finais viram "cole os valores abaixo" em vez de
// "edite o .env").
function _oauthStepsHtml(provider) {
  if (provider === 'google') {
    return `
      <ol>
        <li>No <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a>, crie (ou reaproveite) um projeto e vá em <strong>APIs &amp; Services → OAuth consent screen</strong> — configure um app básico (nome, e-mail de suporte); "External" funciona mesmo para uso interno.</li>
        <li>Em <strong>APIs &amp; Services → Credentials → Create Credentials → OAuth client ID</strong>, tipo <strong>Web application</strong>.</li>
        <li>Em <strong>Authorized redirect URIs</strong>, adicione a URL EXATA mostrada abaixo em "Redirect URI to register with the provider".</li>
        <li>Copie o <strong>Client ID</strong> e o <strong>Client secret</strong> gerados e cole nos campos abaixo.</li>
      </ol>`;
  }
  return `
    <ol>
      <li>No <a href="https://portal.azure.com/" target="_blank" rel="noopener">Azure Portal</a> → <strong>Microsoft Entra ID → App registrations → New registration</strong>.</li>
      <li>Dê um nome ao app. Em <strong>Supported account types</strong>, escolha <strong>Accounts in any organizational directory and personal Microsoft accounts</strong> (combina com deixar o Tenant ID em branco/"common" abaixo).</li>
      <li>Em <strong>Redirect URI</strong>, tipo <strong>Web</strong>, cole a URL EXATA mostrada abaixo em "Redirect URI to register with the provider". Clique <strong>Register</strong>.</li>
      <li>Copie o <strong>Application (client) ID</strong> e cole no campo abaixo.</li>
      <li>Em <strong>Certificates &amp; secrets → Client secrets → New client secret</strong>, crie um e copie o <strong>Value</strong> na hora — ele só aparece uma vez.</li>
    </ol>`;
}

function _oauthSourceNote(info) {
  if (!info) return '';
  if (info.source === 'db') {
    const who = info.updatedBy ? ` by ${_oauthEscHtml(info.updatedBy)}` : '';
    const when = info.updatedAt ? ` on ${_oauthFormatDate(info.updatedAt)}` : '';
    return `Configured here${who}${when}.`;
  }
  if (info.source === 'env') {
    return 'Configured via the server\'s environment variables (.env). Saving a configuration here will take priority over those.';
  }
  return 'Not configured yet — the sign-in button stays hidden on the login page until this is set up.';
}

function _oauthRenderProviderRow(provider, info) {
  const el = document.getElementById(`oauthStatus-${provider}`);
  if (!el || !info) return;
  if (info.configured) {
    el.textContent = info.source === 'db' ? 'Configured' : 'Configured (via server .env)';
    el.classList.add('is-on');
  } else {
    el.textContent = 'Not configured';
    el.classList.remove('is-on');
  }
}

// Chamada quando a aba "System" do modal de Configurações é aberta — mesmo
// padrão de js/api-keys.js/js/ssl-certificate.js (envolve switchSettingsPane
// em vez de duplicar a lógica de troca de aba). Também usada por
// openOauthSettingsModal() pra sempre abrir com o status mais recente.
async function loadOauthProvidersStatus() {
  try {
    const res = await fetch('/api/system/oauth');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _oauthStatusCache = data;
    _oauthRenderProviderRow('google', data.google);
    _oauthRenderProviderRow('microsoft', data.microsoft);
    return data;
  } catch (err) {
    console.error('Failed to load OAuth providers status', err);
    ['google', 'microsoft'].forEach(p => {
      const el = document.getElementById(`oauthStatus-${p}`);
      if (el) { el.textContent = 'Failed to load status.'; el.classList.remove('is-on'); }
    });
    return null;
  }
}

async function openOauthSettingsModal(provider) {
  const overlay = document.getElementById('oauthSettingsOverlay');
  const meta = OAUTH_PROVIDER_META[provider];
  if (!overlay || !meta) return;
  _oauthCurrentProvider = provider;
  overlay.classList.add('show');

  document.getElementById('oauthModalIcon').innerHTML = meta.icon;
  document.getElementById('oauthModalTitle').textContent = `Configure ${meta.label} sign-in`;
  document.getElementById('oauthStepsBox').innerHTML = _oauthStepsHtml(provider);
  document.getElementById('oauthClientIdInput').placeholder = meta.clientIdPlaceholder;
  document.getElementById('oauthClientIdInput').value = '';
  document.getElementById('oauthClientSecretInput').value = '';
  document.getElementById('oauthRedirectUriInput').value = '';
  document.getElementById('oauthTenantIdInput').value = '';
  document.getElementById('oauthTenantIdGroup').style.display = provider === 'microsoft' ? '' : 'none';
  document.getElementById('oauthCurrentStatus').textContent = 'Loading…';
  document.getElementById('oauthSaveStatus').textContent = '';
  document.getElementById('oauthDangerZone').style.display = 'none';

  // URL sugerida sempre calculada a partir da origem ATUAL (funciona mesmo
  // se o admin nunca configurou nada ainda) — é o valor que precisa ser
  // cadastrado no Google Cloud Console/Azure Portal.
  const suggestedRedirectUri = `${location.origin}/api/auth/${provider}/callback`;
  document.getElementById('oauthSuggestedRedirectUri').value = suggestedRedirectUri;

  const data = await loadOauthProvidersStatus();
  const info = data && data[provider];
  document.getElementById('oauthCurrentStatus').innerHTML = _oauthEscHtml(_oauthSourceNote(info)).replace(/\n/g, '<br>');
  if (info) {
    if (info.clientId) document.getElementById('oauthClientIdInput').value = info.clientId;
    document.getElementById('oauthRedirectUriInput').value = info.redirectUri || suggestedRedirectUri;
    if (provider === 'microsoft' && info.tenantId) document.getElementById('oauthTenantIdInput').value = info.tenantId === 'common' ? '' : info.tenantId;
    document.getElementById('oauthClientSecretHint').textContent = info.clientSecretSet
      ? 'A secret is already saved. Leave this blank to keep it, or enter a new value to replace it.'
      : 'Required.';
    // "Remove configuration" só faz sentido quando existe algo salvo NESTA
    // tela (source === 'db') — apagar uma config que na verdade vem do
    // .env não removeria nada (a env var continua lá).
    document.getElementById('oauthDangerZone').style.display = info.source === 'db' ? '' : 'none';
  } else {
    document.getElementById('oauthRedirectUriInput').value = suggestedRedirectUri;
    document.getElementById('oauthClientSecretHint').textContent = 'Required.';
  }
}

function closeOauthSettingsModal() {
  const overlay = document.getElementById('oauthSettingsOverlay');
  if (overlay) overlay.classList.remove('show');
  _oauthCurrentProvider = null;
}

// Click-outside-to-close + Escape, mesmo padrão de ssl-certificate.js.
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('oauthSettingsOverlay');
  if (overlay) overlay.addEventListener('click', ev => { if (ev.target.id === 'oauthSettingsOverlay') closeOauthSettingsModal(); });
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  const overlay = document.getElementById('oauthSettingsOverlay');
  if (overlay && overlay.classList.contains('show')) closeOauthSettingsModal();
});

function _oauthCopySuggestedRedirectUri() {
  const input = document.getElementById('oauthSuggestedRedirectUri');
  if (!input) return;
  input.select();
  input.setSelectionRange(0, 99999);
  try {
    navigator.clipboard.writeText(input.value);
  } catch (e) {
    document.execCommand('copy');
  }
}

async function saveOauthSettings() {
  const provider = _oauthCurrentProvider;
  if (!provider) return;
  const clientId = (document.getElementById('oauthClientIdInput').value || '').trim();
  const clientSecret = document.getElementById('oauthClientSecretInput').value || '';
  const redirectUri = (document.getElementById('oauthRedirectUriInput').value || '').trim();
  const tenantId = (document.getElementById('oauthTenantIdInput').value || '').trim();
  const btn = document.getElementById('oauthSaveBtn');
  const status = document.getElementById('oauthSaveStatus');

  if (!clientId || !redirectUri) {
    status.textContent = 'Client ID and Redirect URI are required.';
    return;
  }

  if (btn) btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    const res = await fetch(`/api/system/oauth/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, redirectUri, tenantId: provider === 'microsoft' ? tenantId : undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    status.textContent = 'Saved. The sign-in button now appears on the login page.';
    document.getElementById('oauthClientSecretInput').value = '';
    await openOauthSettingsModal(provider); // recarrega status/campos com o que ficou salvo
  } catch (err) {
    status.textContent = err.message || 'Failed to save. Please try again.';
    console.error('Failed to save OAuth settings', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function deleteOauthSettings() {
  const provider = _oauthCurrentProvider;
  if (!provider) return;
  const meta = OAUTH_PROVIDER_META[provider];
  openConfirmModal(
    `Remove the ${meta.label} sign-in configuration? It will revert to the server's environment variables, if set — otherwise sign-in with ${meta.label} is disabled again.`,
    { danger: true }
  ).then(async ok => {
    if (!ok) return;
    try {
      const res = await fetch(`/api/system/oauth/${provider}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      await openOauthSettingsModal(provider);
      document.getElementById('oauthSaveStatus').textContent = 'Configuration removed.';
    } catch (err) {
      alert('Failed to remove the configuration. Please try again.');
      console.error('Failed to delete OAuth settings', err);
    }
  });
}

// switchSettingsPane() (js/settings-modal.js) já existe antes deste arquivo
// ser carregado (ver ordem dos <script> em index.html) — mesmo padrão de
// js/api-keys.js/js/users-admin.js/js/sharing.js: envolve a função original
// pra carregar o status dos provedores sem duplicar a lógica de troca de
// aba.
if (typeof switchSettingsPane === 'function') {
  const _oauthOrigSwitchSettingsPane = switchSettingsPane;
  switchSettingsPane = function (pane) {
    _oauthOrigSwitchSettingsPane(pane);
    if (pane === 'system') loadOauthProvidersStatus();
  };
}
