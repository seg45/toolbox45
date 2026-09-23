// ════════════════════════════════════════════════
// LOGIN PAGE (login.html) — página inicial da aplicação. 3 "views" dentro
// do mesmo card (#lpLoginView/#lpRegisterView/#lpPendingView — ver
// _lpShowView() abaixo), formas de entrar/criar conta (pedido do usuário:
// "deixar somente autenticação local e com Google" — o login do Windows/
// NTLM que existia aqui foi removido — e depois "na tela de login criar a
// opção para registro"):
//   1) Local (usuário/senha) -> POST /api/auth/login — cria uma sessão via
//      cookie httpOnly tb45_session.
//   2) Auto-cadastro local (e-mail/senha) -> POST /api/auth/register — NÃO
//      cria sessão; a conta nasce desabilitada/pendente de aprovação (ver
//      submitRegister() abaixo e server/index.js).
//   3) "Sign in with Google" -> navegação inteira pra GET /api/auth/google
//      (OAuth) — ver startGoogleLogin()/_lpHandleGoogleRedirectResult()
//      abaixo e o login com Google em server/index.js. Serve tanto pra
//      entrar (e-mail já aprovado) quanto pra se cadastrar (e-mail novo —
//      também nasce pendente, mesma UX da opção 2).
//
// Depois de um login bem-sucedido (opções 1 ou 3, só quando já aprovada),
// grava LOGIN_FLAG_KEY no localStorage e manda pra index.html — o gate
// inline no topo do <head> de index.html é quem lê essa marca pra decidir
// se deixa entrar direto ou redireciona de volta pra cá. js/auth.js::
// authLogout() é quem apaga a marca no logout.
//
// Mesma chave usada nos 2 outros pontos (comentário duplicado de propósito
// — são 3 arquivos carregados em páginas diferentes, sem runtime
// compartilhado entre eles):
//   - index.html (gate inline no <head>)
//   - js/auth.js (authLogout)
// ════════════════════════════════════════════════
const LOGIN_FLAG_KEY = 'cpa-authenticated';
let _lpGoogleEnabled = false;
let _lpMicrosoftEnabled = false;
let _lpCurrentView = 'login';

function _lpShowError(msg) {
  const box = document.getElementById('loginPageErrorMsg');
  if (box) { box.textContent = msg; box.style.display = ''; }
}
function _lpClearError() {
  const box = document.getElementById('loginPageErrorMsg');
  if (box) { box.style.display = 'none'; box.textContent = ''; }
}
function _lpShowRegisterError(msg) {
  const box = document.getElementById('lpRegisterErrorMsg');
  if (box) { box.textContent = msg; box.style.display = ''; }
}
function _lpClearRegisterError() {
  const box = document.getElementById('lpRegisterErrorMsg');
  if (box) { box.style.display = 'none'; box.textContent = ''; }
}
function _lpMarkAuthenticatedAndEnter() {
  try { localStorage.setItem(LOGIN_FLAG_KEY, '1'); } catch (e) { /* localStorage indisponível — entra mesmo assim, só não persiste entre reloads */ }
  location.href = 'index.html';
}

// Alterna entre as 3 views do card (ver comentário grande acima e
// login.html) — 'login' (padrão), 'register', 'pending'. O botão/divider
// "Sign in with Google" só aparece nas 2 primeiras (pedido do usuário: "Ele
// poderá se registrar com a conta do Google" — não faz sentido na view de
// "pendente", que já não tem formulário nenhum).
function _lpShowView(view) {
  const views = { login: 'lpLoginView', register: 'lpRegisterView', pending: 'lpPendingView' };
  Object.entries(views).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = key === view ? '' : 'none';
  });
  _lpCurrentView = view;
  _lpClearError();
  _lpClearRegisterError();
  const divider = document.getElementById('lpGoogleDivider');
  const googleBtn = document.getElementById('lpGoogleBtn');
  const microsoftBtn = document.getElementById('lpMicrosoftBtn');
  const notPending = view !== 'pending';
  const showGoogle = _lpGoogleEnabled && notPending;
  const showMicrosoft = _lpMicrosoftEnabled && notPending;
  // O divider ("ou") é compartilhado pelos 2 botões de provedor — aparece
  // se pelo menos um estiver habilitado.
  if (divider) divider.style.display = (showGoogle || showMicrosoft) ? '' : 'none';
  if (googleBtn) googleBtn.style.display = showGoogle ? '' : 'none';
  if (microsoftBtn) microsoftBtn.style.display = showMicrosoft ? '' : 'none';
}
function _lpShowPending(message) {
  const box = document.getElementById('lpPendingMsg');
  if (box) box.textContent = message;
  _lpShowView('pending');
}

// "Sign in with Google" — navegação de página inteira pra GET
// /api/auth/google (server/index.js), que redireciona pro consentimento do
// Google e, no fim, volta pra ESTA página via GET /api/auth/google/callback
// (ver _lpHandleGoogleRedirectResult() abaixo). Não dá pra fazer isso com
// fetch: o navegador precisa navegar de verdade pra accounts.google.com.
function startGoogleLogin() {
  location.href = '/api/auth/google';
}

// "Sign in with Microsoft" — mesmo mecanismo do Google acima, navegação de
// página inteira pra GET /api/auth/microsoft (server/index.js), que
// redireciona pro consentimento da Microsoft (Azure AD / login.microsoftonline.com)
// e volta pra esta página via GET /api/auth/microsoft/callback (ver
// _lpHandleMicrosoftRedirectResult() abaixo).
function startMicrosoftLogin() {
  location.href = '/api/auth/microsoft';
}

// Só mostra os botões de Google/Microsoft quando o backend está
// configurado pra cada um (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI e
// MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI respectivamente) — GET
// /api/auth/providers é público e nunca falha "de verdade" (backend sem
// essas variáveis só devolve { google: false, microsoft: false }), então
// um botão morto nunca aparece. Uma chamada só serve pros 2 provedores.
async function _lpInitProviderButtons() {
  try {
    const res = await fetch('/api/auth/providers');
    const data = await res.json();
    _lpGoogleEnabled = !!data.google;
    _lpMicrosoftEnabled = !!data.microsoft;
  } catch (e) {
    _lpGoogleEnabled = false;
    _lpMicrosoftEnabled = false;
  }
  // Reaplica a visibilidade na view ATUAL (_lpCurrentView, não sniffada do
  // DOM) sem trocar de view — esta função é async e os handlers de
  // redirect (chamados logo em seguida, no mesmo DOMContentLoaded) podem
  // já ter mudado pra 'pending' antes do fetch acima resolver; sniffar o
  // DOM acabaria voltando pro login por engano nesse caso.
  _lpShowView(_lpCurrentView);
}

// Depois da ida-e-volta pelo Google, o resultado chega como querystring
// nesta MESMA página (?google=success|error&reason=...), não como resposta
// de fetch — ver GET /api/auth/google/callback em server/index.js. Em caso
// de sucesso o cookie tb45_session já foi gravado pelo backend; só falta
// marcar o localStorage e entrar, igual aos outros 2 métodos de login.
// Limpa a querystring (history.replaceState) pra um F5 não reprocessar.
function _lpHandleGoogleRedirectResult() {
  const params = new URLSearchParams(location.search);
  const google = params.get('google');
  if (!google) return;
  const reason = params.get('reason');
  history.replaceState(null, '', location.pathname);
  if (google === 'success') {
    _lpMarkAuthenticatedAndEnter();
    return;
  }
  // E-mail Google novo (ou já cadastrado mas ainda não aprovado) — mesma
  // UX de pendente do auto-cadastro local (ver submitRegister() abaixo e
  // GET /api/auth/google/callback em server/index.js).
  if (google === 'pending') {
    _lpShowPending('Your account was created with Google sign-in and is pending administrator approval.');
    return;
  }
  const reasons = {
    access_denied: 'Google sign-in was cancelled.',
    invalid_state: 'Google sign-in session expired. Please try again.',
    account_exists_other_method: "This Google account's e-mail matches an existing account that uses a different sign-in method. Please log in with your username and password instead.",
    account_disabled: 'This account has been disabled. Contact an administrator.',
    not_configured: 'Google sign-in is not configured on this server.',
  };
  _lpShowError(reasons[reason] || 'Google sign-in failed. Please try again.');
}

// Espelho de _lpHandleGoogleRedirectResult() acima pro provedor Microsoft
// (?microsoft=success|error|pending&reason=... — ver GET
// /api/auth/microsoft/callback em server/index.js).
function _lpHandleMicrosoftRedirectResult() {
  const params = new URLSearchParams(location.search);
  const microsoft = params.get('microsoft');
  if (!microsoft) return;
  const reason = params.get('reason');
  history.replaceState(null, '', location.pathname);
  if (microsoft === 'success') {
    _lpMarkAuthenticatedAndEnter();
    return;
  }
  // E-mail Microsoft novo (ou já cadastrado mas ainda não aprovado) — mesma
  // UX de pendente do auto-cadastro local / Google (ver submitRegister()
  // acima e GET /api/auth/microsoft/callback em server/index.js).
  if (microsoft === 'pending') {
    _lpShowPending('Your account was created with Microsoft sign-in and is pending administrator approval.');
    return;
  }
  const reasons = {
    access_denied: 'Microsoft sign-in was cancelled.',
    invalid_state: 'Microsoft sign-in session expired. Please try again.',
    account_exists_other_method: "This Microsoft account's e-mail matches an existing account that uses a different sign-in method. Please log in with your username and password instead.",
    account_disabled: 'This account has been disabled. Contact an administrator.',
    not_configured: 'Microsoft sign-in is not configured on this server.',
  };
  _lpShowError(reasons[reason] || 'Microsoft sign-in failed. Please try again.');
}

// Auto-cadastro local (login.html → "Register") — pedido do usuário: "na
// tela de login criar a opção para registro. todo novo usuário deverá vir
// desabilitado. Exibir mensagem no cadastro dizendo que a conta está
// pendente de aprovação pelo administrador. se o usuário tentar se
// cadastrar novamente com o mesmo email informar que o cadastro está
// pendente de aprovação." POST /api/auth/register nunca cria sessão — só
// depois de um super_admin aprovar em Settings → Users é que o login local
// funciona (ver server/index.js).
async function submitRegister() {
  const email = (document.getElementById('lpRegEmailInput') || {}).value || '';
  const password = (document.getElementById('lpRegPasswordInput') || {}).value || '';
  const btn = document.getElementById('lpRegisterSubmitBtn');
  _lpClearRegisterError();
  if (!email.trim() || !password) {
    _lpShowRegisterError('Enter both e-mail and password.');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      _lpShowPending(data.message || 'Your account was created and is pending administrator approval.');
      return;
    }
    // pending_approval (mesmo e-mail já cadastrado, ainda não aprovado) usa
    // a MESMA view de sucesso — pedido do usuário: "informar que o
    // cadastro está pendente de aprovação", não é tratado como erro.
    if (data.error === 'pending_approval') {
      _lpShowPending(data.message || 'This e-mail is already registered and is pending administrator approval.');
      return;
    }
    _lpShowRegisterError(data.message || 'Failed to create account.');
  } catch (err) {
    _lpShowRegisterError('Failed to create account. Please try again.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function submitLocalLogin() {
  const username = (document.getElementById('lpUsernameInput') || {}).value || '';
  const password = (document.getElementById('lpPasswordInput') || {}).value || '';
  const btn = document.getElementById('lpSubmitBtn');
  _lpClearError();
  if (!username.trim() || !password) {
    _lpShowError('Enter both username and password.');
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || 'Invalid username or password.');
    }
    // Confirma que a sessão recém-criada já é reconhecida ANTES de navegar
    // pra index.html — bug reportado: "continuo com problema de exibição do
    // menu de admin. tenho que ficar atualizando a página várias vezes para
    // aparecer" (usuário admin local). O login em si já está correto (cookie
    // gravado antes desta resposta voltar — ver POST /api/auth/login em
    // server/index.js), mas essa checagem é uma rede de segurança extra:
    // até 3 tentativas rápidas de GET /api/me confirmando authMethod==='local'
    // antes de entrar, em vez de confiar cegamente que a 1ª leitura em
    // index.html (js/user-sync.js) vai bater com o cookie recém-gravado.
    // Melhor esperar ~1s aqui do que o usuário ver o menu de admin faltando
    // e precisar dar F5 manualmente.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const meRes = await fetch('/api/me');
        const me = await meRes.json();
        if (me.authMethod === 'local') break; // sessão confirmada, pode entrar
      } catch (e) { /* ignora e tenta de novo, ou desiste no último attempt */ }
      if (attempt < 3) await new Promise(r => setTimeout(r, 300));
    }
    _lpMarkAuthenticatedAndEnter();
  } catch (err) {
    _lpShowError(err.message || 'Login failed. Please try again.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const userInput = document.getElementById('lpUsernameInput');
  if (userInput) userInput.focus();
  const passInput = document.getElementById('lpPasswordInput');
  if (passInput) passInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') submitLocalLogin(); });
  const regPassInput = document.getElementById('lpRegPasswordInput');
  if (regPassInput) regPassInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') submitRegister(); });
  _lpInitProviderButtons();
  _lpHandleGoogleRedirectResult();
  _lpHandleMicrosoftRedirectResult();
});
