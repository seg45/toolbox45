// ════════════════════════════════════════════════
// Segurança da conta: "Esqueci a senha", MFA por e-mail, conversão local ⇄ SSO e as
// telas de super admin (SMTP + política de MFA). Backend: server-py/app/routers/
// auth.py (forgot/reset/mfa), me.py, smtp.py, mfa_policy.py e users.py.
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody, type LoginResponse } from './api';

async function send<T = unknown>(url: string, method: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await parseErrorBody(res);
    throw new ApiError(res.status, err.message || fallback, err.error);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => ({}))) as T;
}

// ── Login: esqueci a senha / código MFA ────────────────────────────────
export const forgotPassword = (email: string) =>
  send<{ ok: boolean; message: string }>('/api/auth/forgot-password', 'POST', { email }, 'Could not send the reset e-mail. Please try again.');

export const resetPassword = (token: string, password: string) =>
  send<{ ok: boolean; message: string }>('/api/auth/reset-password', 'POST', { token, password }, 'Could not reset the password. Please try again.');

export const verifyMfa = (challenge: string, code: string) =>
  send<LoginResponse>('/api/auth/mfa/verify', 'POST', { challenge, code }, 'Could not verify the code. Please try again.');

export const resendMfa = (challenge: string) =>
  send<{ ok: boolean; maskedEmail: string }>('/api/auth/mfa/resend', 'POST', { challenge }, 'Could not send a new code.');

// ── Conta do usuário ────────────────────────────────────────────────────
export const startMfa = () =>
  send<{ ok: boolean; challenge: string; maskedEmail: string }>('/api/me/mfa/start', 'POST', {}, 'Could not send the verification code.');

export const confirmMfa = (challenge: string, code: string) =>
  send<{ ok: boolean }>('/api/me/mfa/confirm', 'POST', { challenge, code }, 'Could not verify the code.');

export const disableMfa = (password: string) =>
  send<{ ok: boolean }>('/api/me/mfa/disable', 'POST', { password }, 'Could not turn MFA off.');

export const convertToLocal = (password: string) =>
  send<{ ok: boolean }>('/api/me/convert-to-local', 'POST', { password }, 'Could not switch to password sign-in.');

// Local → SSO: navegação completa (o provedor redireciona de volta para /index.html?converted=…).
export const ssoLinkUrl = (provider: 'google' | 'microsoft') => `/api/auth/${provider}?link=1`;

// ── Super admin: SMTP ───────────────────────────────────────────────────
export interface SmtpSettings {
  configured: boolean;
  host: string;
  port: number;
  security: 'starttls' | 'ssl' | 'none';
  username: string;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
  appUrl: string;
  updatedAt: string | null;
  updatedBy: string | null;
  secretKeyConfigured: boolean;
}

export interface SmtpSavePayload {
  host: string;
  port: number;
  security: SmtpSettings['security'];
  username: string;
  password: string; // vazio = mantém a senha já salva
  fromAddress: string;
  fromName: string;
  appUrl: string;
}

export const fetchSmtp = () => send<SmtpSettings>('/api/system/smtp', 'GET', undefined, 'Failed to load the SMTP settings.');
export const saveSmtp = (p: SmtpSavePayload) => send<SmtpSettings>('/api/system/smtp', 'PUT', p, 'Failed to save. Please try again.');
export const deleteSmtp = () => send('/api/system/smtp', 'DELETE', undefined, 'Failed to remove the SMTP settings.');
export const testSmtp = (to: string) => send<{ ok: boolean }>('/api/system/smtp/test', 'POST', { to }, 'The test message could not be sent.');

// ── Super admin: política de MFA ────────────────────────────────────────
export interface MfaPolicy {
  requireAll: boolean;
  smtpAvailable: boolean;
  requiredUsers: number;
  enabledUsers: number;
}

export const fetchMfaPolicy = () => send<MfaPolicy>('/api/system/mfa', 'GET', undefined, 'Failed to load the MFA policy.');
export const saveMfaPolicy = (requireAll: boolean) => send<MfaPolicy>('/api/system/mfa', 'PUT', { requireAll }, 'Failed to save the MFA policy.');

// Resultado da conversão local → SSO (o provedor volta para /index.html?converted=google ou
// ?convert=error&reason=...). Lê e LIMPA a query; devolve a mensagem a mostrar (ou null).
const CONVERT_ERRORS: Record<string, string> = {
  login_required: 'Your session was not found. Log in again and retry.',
  email_mismatch: 'The account you chose at the provider has a different e-mail than this account. Pick the account with the same e-mail.',
  already_sso: 'This account already signs in with single sign-on.',
  last_local_super_admin: 'This is the only super admin with a password. Create another password-based super admin first, so you cannot lock yourself out.',
  access_denied: 'The sign-in at the provider was cancelled.',
  invalid_state: 'The sign-in session expired. Please try again.',
  email_not_verified: "The provider could not confirm that you own that e-mail address.",
  tenant_mismatch: 'That Microsoft account does not belong to the organization allowed on this server.',
  invalid_token: 'The provider sign-in could not be verified. Please try again.',
  not_configured: 'Single sign-in is not configured on this server.',
};

export function consumeConvertResult(): string | null {
  const params = new URLSearchParams(location.search);
  const ok = params.get('converted');
  const err = params.get('convert');
  if (!ok && !err) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  if (ok === 'google' || ok === 'microsoft') {
    const label = ok === 'google' ? 'Google' : 'Microsoft';
    return `Done — this account now signs in with ${label}. The password no longer works; you can switch back to a password at any time in Settings → User account.`;
  }
  if (err === 'error') {
    return CONVERT_ERRORS[params.get('reason') || ''] || 'Could not switch the sign-in method. Please try again.';
  }
  return null;
}
