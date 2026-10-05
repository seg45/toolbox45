// ════════════════════════════════════════════════
// LOGIN PAGE — porta de login.html + js/login.js (app original) pra
// React+TS. 3 "views" dentro do mesmo card (login/register/pending),
// mesmo comportamento e mensagens do original — ver comentário completo
// em js/login.js (histórico de pedidos do usuário).
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { ApiError, fetchAuthProviders, fetchMe, login, register } from '../lib/api';
import { bootLoginAppearance } from '../lib/appearanceBoot';
import { useLogo } from '../lib/useLogo';

const LOGIN_FLAG_KEY = 'cpa-authenticated';

// Último estado conhecido dos provedores OAuth (true/false por provedor),
// guardado pela visita anterior — o primeiro render já sai com o estado certo,
// sem os botões "piscarem" até GET /api/auth/providers responder. Mesmo padrão
// de cache dos boots de tema ('cpa-org-theme'). Sem cache (primeira visita) ou
// com localStorage indisponível, o estado fica "desconhecido" (undefined).
const PROVIDERS_CACHE_KEY = 'tb45-login-providers';
type ProviderState = { google?: boolean; microsoft?: boolean };

function readProvidersCache(): ProviderState {
  try {
    const raw = JSON.parse(localStorage.getItem(PROVIDERS_CACHE_KEY) || '{}');
    return {
      google: typeof raw.google === 'boolean' ? raw.google : undefined,
      microsoft: typeof raw.microsoft === 'boolean' ? raw.microsoft : undefined,
    };
  } catch {
    return {};
  }
}

type View = 'login' | 'register' | 'pending';

const GOOGLE_REASONS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  invalid_state: 'Google sign-in session expired. Please try again.',
  account_exists_other_method:
    "This Google account's e-mail matches an existing account that uses a different sign-in method. Please log in with your username and password instead.",
  account_disabled: 'This account has been disabled. Contact an administrator.',
  not_configured: 'Google sign-in is not configured on this server.',
};

const MICROSOFT_REASONS: Record<string, string> = {
  access_denied: 'Microsoft sign-in was cancelled.',
  invalid_state: 'Microsoft sign-in session expired. Please try again.',
  account_exists_other_method:
    "This Microsoft account's e-mail matches an existing account that uses a different sign-in method. Please log in with your username and password instead.",
  account_disabled: 'This account has been disabled. Contact an administrator.',
  not_configured: 'Microsoft sign-in is not configured on this server.',
};

function markAuthenticatedAndEnter(): void {
  try {
    localStorage.setItem(LOGIN_FLAG_KEY, '1');
  } catch {
    /* localStorage indisponível — entra mesmo assim, só não persiste entre reloads */
  }
  location.href = 'index.html';
}

async function waitForSessionConfirmed(): Promise<void> {
  // Bug relatado no app original: "continuo com problema de exibição do
  // menu de admin. tenho que ficar atualizando a página várias vezes para
  // aparecer" — até 3 tentativas rápidas de GET /api/me confirmando
  // authMethod==='local' antes de entrar, em vez de confiar cegamente que
  // a 1ª leitura em index.html vai bater com o cookie recém-gravado.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const me = await fetchMe();
      if (me.authMethod === 'local') return;
    } catch {
      /* ignora e tenta de novo, ou desiste no último attempt */
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 300));
  }
}

export default function LoginPage() {
  const [view, setView] = useState<View>('login');
  const [providers, setProviders] = useState<ProviderState>(readProvidersCache);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginSubmitting, setLoginSubmitting] = useState(false);

  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [registerSubmitting, setRegisterSubmitting] = useState(false);

  const [pendingMessage, setPendingMessage] = useState('');

  const usernameInputRef = useRef<HTMLInputElement>(null);
  const logo = useLogo();

  useEffect(() => {
    usernameInputRef.current?.focus();
    bootLoginAppearance();

    fetchAuthProviders().then(data => {
      if (!data) return; // consulta falhou — mantém o último estado conhecido
      const next = { google: !!data.google, microsoft: !!data.microsoft };
      setProviders(next);
      try {
        localStorage.setItem(PROVIDERS_CACHE_KEY, JSON.stringify(next));
      } catch {
        /* sem cache — só volta a "desconhecido" na próxima visita */
      }
    });

    // Resultado do redirect OAuth (volta pra esta MESMA página) — ver
    // GET /api/auth/google[/microsoft]/callback em server-py/app/routers/oauth.py.
    const params = new URLSearchParams(location.search);
    const google = params.get('google');
    const microsoft = params.get('microsoft');
    if (google || microsoft) {
      const reason = params.get('reason');
      history.replaceState(null, '', location.pathname);
      if (google === 'success' || microsoft === 'success') {
        markAuthenticatedAndEnter();
      } else if (google === 'pending') {
        setPendingMessage('Your account was created with Google sign-in and is pending administrator approval.');
        setView('pending');
      } else if (microsoft === 'pending') {
        setPendingMessage('Your account was created with Microsoft sign-in and is pending administrator approval.');
        setView('pending');
      } else if (google) {
        setLoginError(GOOGLE_REASONS[reason || ''] || 'Google sign-in failed. Please try again.');
      } else if (microsoft) {
        setLoginError(MICROSOFT_REASONS[reason || ''] || 'Microsoft sign-in failed. Please try again.');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showView(next: View) {
    setView(next);
    setLoginError('');
    setRegisterError('');
  }

  function startGoogleLogin() {
    location.href = '/api/auth/google';
  }
  function startMicrosoftLogin() {
    location.href = '/api/auth/microsoft';
  }

  async function submitLocalLogin() {
    setLoginError('');
    if (!username.trim() || !password) {
      setLoginError('Enter both username and password.');
      return;
    }
    setLoginSubmitting(true);
    try {
      await login(username.trim(), password);
      await waitForSessionConfirmed();
      markAuthenticatedAndEnter();
    } catch (err) {
      setLoginError(err instanceof ApiError ? err.message : 'Login failed. Please try again.');
    } finally {
      setLoginSubmitting(false);
    }
  }

  async function submitRegister() {
    setRegisterError('');
    if (!regEmail.trim() || !regPassword) {
      setRegisterError('Enter both e-mail and password.');
      return;
    }
    setRegisterSubmitting(true);
    try {
      const data = await register(regEmail.trim(), regPassword);
      setPendingMessage(data.message || 'Your account was created and is pending administrator approval.');
      setView('pending');
    } catch (err) {
      // pending_approval (mesmo e-mail já cadastrado, ainda não aprovado)
      // usa a MESMA view de sucesso — não é tratado como erro, ver
      // js/login.js original.
      if (err instanceof ApiError && err.code === 'pending_approval') {
        setPendingMessage(err.message || 'This e-mail is already registered and is pending administrator approval.');
        setView('pending');
      } else {
        setRegisterError(err instanceof ApiError ? err.message : 'Failed to create account.');
      }
    } finally {
      setRegisterSubmitting(false);
    }
  }

  const notPending = view !== 'pending';
  // Botões e divisor ficam SEMPRE na página (fora da view "pending"). Só
  // clicáveis se o provedor está configurado; se o servidor disse que não está,
  // aparece o aviso logo abaixo do botão. Estado ainda desconhecido (primeira
  // visita, antes da resposta): botão desabilitado, sem aviso.
  const showOauth = notPending;

  return (
    <div className="login-card">
      <div className="login-brand">
        <img
          className="login-logo-img for-dark"
          src={logo.dark || '/img/logo-toolbox45-white.png?v=2'}
          alt="Toolbox45"
        />
        <img
          className="login-logo-img for-light"
          src={logo.light || '/img/logo-toolbox45.png?v=2'}
          alt="Toolbox45"
        />
      </div>

      {view === 'login' && loginError && (
        <div className="set-hint login-error" style={{ color: 'var(--red)' }}>
          {loginError}
        </div>
      )}

      {view === 'login' && (
        <div>
          <div className="set-group" style={{ marginTop: 14 }}>
            <span className="set-label">Email</span>
            <input
              className="set-input"
              type="text"
              autoComplete="username"
              ref={usernameInputRef}
              value={username}
              onChange={e => setUsername(e.target.value)}
            />
          </div>
          <div className="set-group">
            <span className="set-label">Password</span>
            <input
              className="set-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitLocalLogin();
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary login-submit-btn"
            disabled={loginSubmitting}
            onClick={submitLocalLogin}
          >
            Log in
          </button>
          <div className="login-toggle-mode">
            Don&apos;t have an account?{' '}
            <a href="javascript:void(0)" onClick={() => showView('register')}>
              Register
            </a>
          </div>
        </div>
      )}

      {view === 'register' && (
        <div>
          {registerError && (
            <div className="set-hint login-error" style={{ color: 'var(--red)', marginTop: 14 }}>
              {registerError}
            </div>
          )}
          <div className="set-group" style={{ marginTop: 14 }}>
            <span className="set-label">E-mail</span>
            <input
              className="set-input"
              type="email"
              autoComplete="email"
              value={regEmail}
              onChange={e => setRegEmail(e.target.value)}
            />
          </div>
          <div className="set-group">
            <span className="set-label">Password</span>
            <input
              className="set-input"
              type="password"
              autoComplete="new-password"
              value={regPassword}
              onChange={e => setRegPassword(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitRegister();
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary login-submit-btn"
            disabled={registerSubmitting}
            onClick={submitRegister}
          >
            Create account
          </button>
          <div className="login-toggle-mode">
            Already have an account?{' '}
            <a href="javascript:void(0)" onClick={() => showView('login')}>
              Log in
            </a>
          </div>
        </div>
      )}

      {view === 'pending' && (
        <div>
          <div className="login-pending-box" style={{ marginTop: 14 }}>
            {pendingMessage}
          </div>
          <div className="login-toggle-mode">
            Need help? Contact <a href="mailto:suporte@seg45.com.br">suporte@seg45.com.br</a>
          </div>
          <div className="login-toggle-mode">
            <a href="javascript:void(0)" onClick={() => showView('login')}>
              ← Back to log in
            </a>
          </div>
        </div>
      )}

      {showOauth && (
        <div className="login-divider">
          <span>or</span>
        </div>
      )}

      {showOauth && (
        <button
          type="button"
          className="btn login-google-btn"
          onClick={startGoogleLogin}
          disabled={providers.google !== true}
        >
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.4 0 6.4 1.2 8.8 3.5l6.6-6.6C35.2 2.6 30 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.7 6C12.2 13.1 17.6 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.9 38 46.5 31.8 46.5 24.5z" />
            <path fill="#FBBC05" d="M10.3 19.2c-.5 1.5-.8 3.1-.8 4.8s.3 3.3.8 4.8l-7.7 6C1 31 0 27.7 0 24s1-7 2.6-10l7.7 6.2z" />
            <path fill="#34A853" d="M24 48c6 0 11.2-2 14.9-5.4l-7.5-5.8c-2.1 1.4-4.7 2.2-7.4 2.2-6.4 0-11.8-3.6-13.7-8.7l-7.7 6C6.5 42.6 14.6 48 24 48z" />
          </svg>
          <span>Sign in with Google</span>
        </button>
      )}
      {showOauth && providers.google === false && (
        <div className="set-hint login-provider-note">
          Google sign-in is not configured on this server. An administrator can set it up in Settings → System.
        </div>
      )}

      {showOauth && (
        <button
          type="button"
          className="btn login-google-btn"
          onClick={startMicrosoftLogin}
          disabled={providers.microsoft !== true}
        >
          <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#F25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
            <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
            <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
          </svg>
          <span>Sign in with Microsoft</span>
        </button>
      )}
      {showOauth && providers.microsoft === false && (
        <div className="set-hint login-provider-note">
          Microsoft sign-in is not configured on this server. An administrator can set it up in Settings → System.
        </div>
      )}
    </div>
  );
}
