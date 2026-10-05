// ════════════════════════════════════════════════
// API CLIENT (Fase 3) — fala com o backend Python (server-py/, já
// migrado e validado nas fatias 1-10 da Fase 1). Porta tipada do
// js/api-client.js original + os fetches soltos que js/login.js,
// js/appearance-settings.js e js/logo-settings.js faziam inline.
// ════════════════════════════════════════════════

export interface AuthProviders {
  google: boolean;
  microsoft: boolean;
}

export interface LoginResponse {
  username: string;
  role: string;
}

export interface MeResponse {
  username?: string;
  upn?: string;
  handle?: string;
  role?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  authMethod?: 'local' | 'api_key' | 'google' | 'microsoft' | 'anonymous';
}

export interface RegisterResponse {
  message?: string;
  error?: string;
}

export interface AppearanceResponse {
  theme: 'light' | 'dark';
  accentColor: string;
}

export interface LogoResponse {
  imageData: string | null;
  imageDataDark: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
  updatedByDark?: string | null;
  updatedAtDark?: string | null;
}

// Erro tipado com o `message`/`error` que o backend devolve no corpo (ver
// os dois exception handlers dedicados a isso em server-py/app/main.py) —
// equivalente ao `throw new Error(...)` do JS original, mas preservando o
// código de erro estruturado (`error`) além da mensagem legível.
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Exportado (a partir da fatia 4) para outros módulos de API (ex.:
// commands.ts::createCommand/updateCommand/deleteCommand) reaproveitarem o
// MESMO parsing de corpo de erro, em vez de duplicar a função.
export async function parseErrorBody(res: Response): Promise<{ error?: string; message?: string }> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// Retorna null quando a consulta FALHA (rede/HTTP) — a tela de login então
// mantém o último estado conhecido em vez de afirmar "não configurado".
export async function fetchAuthProviders(): Promise<AuthProviders | null> {
  try {
    const res = await fetch('/api/auth/providers');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Invalid username or password.', body.error);
  }
  return res.json();
}

export async function fetchMe(): Promise<MeResponse> {
  const res = await fetch('/api/me');
  if (!res.ok) throw new ApiError(res.status, `fetchMe: HTTP ${res.status}`);
  return res.json();
}

export async function register(email: string, password: string): Promise<RegisterResponse> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data: RegisterResponse = await res.json().catch(() => ({}));
  if (!res.ok) {
    // pending_approval (mesmo e-mail já cadastrado, ainda não aprovado) não
    // é tratado como erro de verdade pela UI — ver LoginPage.tsx — mas o
    // status HTTP em si já não é 2xx, por isso ainda passa pelo throw;
    // quem chama decide o que fazer com `data.error`.
    throw new ApiError(res.status, data.message || 'Failed to create account.', data.error);
  }
  return data;
}

export async function fetchAppearance(): Promise<AppearanceResponse> {
  const res = await fetch('/api/system/appearance');
  if (!res.ok) throw new ApiError(res.status, `fetchAppearance: HTTP ${res.status}`);
  return res.json();
}

export async function fetchLogo(): Promise<LogoResponse> {
  const res = await fetch('/api/system/logo');
  if (!res.ok) throw new ApiError(res.status, `fetchLogo: HTTP ${res.status}`);
  return res.json();
}

// ── Fatia 2 (App shell) ──────────────────────────────────────────────

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // best-effort — mesmo padrão do original (authLogout() em js/auth.js):
    // quem chama redireciona pra login.html de qualquer forma.
  }
}

export async function updateHandle(handle: string): Promise<{ handle: string }> {
  const res = await fetch('/api/me/handle', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to update handle.', body.error);
  }
  return res.json();
}

export async function updatePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch('/api/me/password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to update password.', body.error);
  }
}

// ── Fatia 8 (Configurações do sistema — aba "System") ──────────────────

// PUT /api/system/appearance — require_super_admin (único widget desta
// fatia que exige super_admin, não só admin — ver SystemPane.tsx). O
// chamador (AppearanceSettingsModal) não usa `message`/`code` do erro —
// mesmo comportamento fixo de saveSysAppearance() no original
// ('Failed to save. Please try again.' sempre, independente do corpo) —
// mas a função ainda popula ApiError normalmente, pelo mesmo motivo de
// parseErrorBody ser reaproveitado em todo o app.
export async function updateAppearance(theme: 'light' | 'dark', accentColor: string): Promise<void> {
  const res = await fetch('/api/system/appearance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme, accentColor }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to save the default appearance.', body.error);
  }
}

// PUT /DELETE /api/system/logo — require_admin. `theme` escolhe qual dos
// dois slots (light/dark) é afetado; o status completo (updatedBy/
// updatedAt de AMBOS) é relido depois via fetchLogo() (GET, já existe
// acima) — mesmo papel de loadLogoStatus() no original.
export async function putLogo(theme: 'light' | 'dark', imageData: string): Promise<void> {
  const res = await fetch('/api/system/logo', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageData, theme }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to save. Please try again.', body.error);
  }
}

export async function deleteLogo(theme: 'light' | 'dark'): Promise<void> {
  const res = await fetch(`/api/system/logo?theme=${theme}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to reset the logo. Please try again.', body.error);
  }
}

// GET/PUT/DELETE /api/system/oauth[/:provider] — require_admin.
export interface OAuthProviderInfo {
  configured: boolean;
  source: 'db' | 'env' | null;
  clientId?: string;
  redirectUri?: string;
  tenantId?: string;
  clientSecretSet: boolean;
  updatedBy?: string;
  updatedAt?: string;
}
export type OAuthProvidersResponse = Record<'google' | 'microsoft', OAuthProviderInfo>;
export interface OAuthSavePayload {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenantId?: string;
}

export async function fetchOAuthProviders(): Promise<OAuthProvidersResponse> {
  const res = await fetch('/api/system/oauth');
  if (!res.ok) throw new ApiError(res.status, `fetchOAuthProviders: HTTP ${res.status}`);
  return res.json();
}

export async function saveOAuthProvider(provider: 'google' | 'microsoft', payload: OAuthSavePayload): Promise<void> {
  const res = await fetch(`/api/system/oauth/${provider}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to save. Please try again.', body.error);
  }
}

export async function deleteOAuthProvider(provider: 'google' | 'microsoft'): Promise<void> {
  const res = await fetch(`/api/system/oauth/${provider}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to remove the configuration. Please try again.', body.error);
  }
}

// GET/POST/DELETE /api/system/ssl-certificate — require_admin.
export interface SslCertificateInfo {
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  fingerprint256?: string;
  isSelfSigned?: boolean;
  isExpired?: boolean;
}
export interface SslCertificatePayload {
  cert: string;
  key: string;
  chain?: string;
}

export async function fetchSslCertificate(): Promise<SslCertificateInfo> {
  const res = await fetch('/api/system/ssl-certificate');
  if (!res.ok) throw new ApiError(res.status, `fetchSslCertificate: HTTP ${res.status}`);
  return res.json();
}

export async function saveSslCertificate(payload: SslCertificatePayload): Promise<SslCertificateInfo> {
  const res = await fetch('/api/system/ssl-certificate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to save the certificate. Please try again.', body.error);
  }
  return res.json();
}

export async function deleteSslCertificate(): Promise<SslCertificateInfo> {
  const res = await fetch('/api/system/ssl-certificate', { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to remove the certificate. Please try again.', body.error);
  }
  return res.json();
}

// GET/POST/DELETE /api/api-keys[/:id] — require_admin.
export interface ApiKeyRow {
  id: number;
  name: string;
  role: 'admin' | 'user';
  key_prefix: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}
export interface CreateApiKeyResponse {
  key: string;
}

export async function fetchApiKeys(): Promise<ApiKeyRow[]> {
  const res = await fetch('/api/api-keys');
  if (!res.ok) throw new ApiError(res.status, `fetchApiKeys: HTTP ${res.status}`);
  return res.json();
}

export async function createApiKey(name: string, role: 'admin' | 'user', validity: string): Promise<CreateApiKeyResponse> {
  const res = await fetch('/api/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, role, validity }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to create API key. Please try again.', body.error);
  }
  return res.json();
}

export async function deleteApiKey(id: number): Promise<void> {
  const res = await fetch(`/api/api-keys/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to delete API key. Please try again.', body.error);
  }
}

// GET/PUT /api/user-data — require_user (qualquer usuário autenticado,
// não só admin). Ver src/lib/userDataSync.ts — putUserData() é chamada
// pelo flush debounced, que ENGOLE o erro (best-effort, mesmo
// .catch(() => {}) do original) — nunca deixa uma falha de rede atrapalhar
// a digitação do usuário.
export async function fetchUserData(): Promise<Record<string, string>> {
  const res = await fetch('/api/user-data');
  if (!res.ok) throw new ApiError(res.status, `fetchUserData: HTTP ${res.status}`);
  return res.json();
}

export async function putUserData(patch: Record<string, string>): Promise<void> {
  const res = await fetch('/api/user-data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to sync user data.', body.error);
  }
}
