// ════════════════════════════════════════════════
// LOGIN PAGE (login.html) — página inicial da aplicação. Duas formas de
// entrar (pedido do usuário: "deixar somente autenticação local e com
// Google" — o login do Windows/NTLM que existia aqui foi removido):
//   1) Local (usuário/senha) -> POST /api/auth/login — cria uma sessão via
//      cookie httpOnly tb45_session.
//   2) "Sign in with Google" -> navegação inteira pra GET /api/auth/google
//      (OAuth) — ver startGoogleLogin()/_lpHandleGoogleRedirectResult()
//      abaixo e o login com Google em server/index.js.
//
// Depois de qualquer login bem-sucedido, grava LOGIN_FLAG_KEY no
// localStorage e manda pra index.html — o gate inline no topo do <head> de
// index.html é quem lê essa marca pra decidir se deixa entrar direto ou
// redireciona de volta pra cá. js/auth.js::authLogout() é quem apaga a
// marca no logout.
//
// Mesma chave usada nos 2 outros pontos (comentário duplicado de propósito
// — são 3 arquivos carregados em páginas diferentes, sem runtime
// compartilhado entre eles):
//   - index.html (gate inline no <head>)
//   - js/auth.js (authLogout)
// ════════════════════════════════════════════════
const LOGIN_FLAG_KEY = 'cpa-authenticated';

function _lpShowError(msg) {
  const box = document.getElementById('loginPageErrorMsg');
  if (box) { box.textContent = msg; box.style.display = ''; }
}
function _lpClearError() {
  const box = document.getElementById('loginPageErrorMsg');
  if (box) { box.style.display = 'none'; box.textContent = ''; }
}
function _lpMarkAuthenticatedAndEnter() {
  try { localStorage.setItem(LOGIN_FLAG_KEY, '1'); } catch (e) { /* localStorage indisponível — entra mesmo assim, só não persiste entre reloads */ }
  location.href = 'index.html';
}

// "Sign in with Google" — navegação de página inteira pra GET
// /api/auth/google (server/index.js), que redireciona pro consentimento do
// Google e, no fim, volta pra ESTA página via GET /api/auth/google/callback
// (ver _lpHandleGoogleRedirectResult() abaixo). Não dá pra fazer isso com
// fetch: o navegador precisa navegar de verdade pra accounts.google.com.
function startGoogleLogin() {
  location.href = '/api/auth/google';
}

// Só mostra o botão do Google quando o backend está configurado
// (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI) — GET /api/auth/providers é
// público e nunca falha "de verdade" (backend sem essas variáveis só
// devolve { google: false }), então um botão morto nunca aparece.
async function _lpInitGoogleButton() {
  const btn = document.getElementById('lpGoogleBtn');
  if (!btn) return;
  try {
    const res = await fetch('/api/auth/providers');
    const data = await res.json();
    btn.style.display = data.google ? '' : 'none';
  } catch (e) {
    btn.style.display = 'none';
  }
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
  const reasons = {
    access_denied: 'Google sign-in was cancelled.',
    invalid_state: 'Google sign-in session expired. Please try again.',
    account_exists_other_method: "This Google account's e-mail matches an existing account that uses a different sign-in method. Please log in with your username and password instead.",
    account_disabled: 'This account has been disabled. Contact an administrator.',
    not_configured: 'Google sign-in is not configured on this server.',
  };
  _lpShowError(reasons[reason] || 'Google sign-in failed. Please try again.');
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
  _lpInitGoogleButton();
  _lpHandleGoogleRedirectResult();
});
