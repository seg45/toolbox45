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

async function parseErrorBody(res: Response): Promise<{ error?: string; message?: string }> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export async function fetchAuthProviders(): Promise<AuthProviders> {
  const res = await fetch('/api/auth/providers');
  if (!res.ok) return { google: false, microsoft: false };
  return res.json();
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
