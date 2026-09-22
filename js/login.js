// ════════════════════════════════════════════════
// LOGIN PAGE (login.html) — página inicial da aplicação (pedido do usuário:
// "criar uma página para login com os campos usuário e senha, e a opção de
// windows authentication... essa deve ser a página inicial, e quando o
// usuário fizer logout deverá ser direcionado para essa página").
//
// Duas formas de entrar, as MESMAS que o backend já suporta (nada novo do
// lado do servidor além de authMethod ficar mais preciso — ver
// getAuthMethod() em server/index.js):
//   1) Local (usuário/senha) -> POST /api/auth/login (mesma rota de sempre)
//      — cria uma sessão local via cookie httpOnly tb45_session.
//   2) "Continue with Windows authentication" -> GET /api/me, que dispara o
//      handshake NTLM do navegador (silencioso, sem prompt, desde que o
//      site esteja na zona "Intranet local") através do middleware NTLM do
//      backend. Só é aceito como login de verdade quando authMethod volta
//      exatamente 'ntlm' (identificação NTLM genuína) — 'anonymous' (NTLM
//      desligado no servidor, fora de domínio Windows, ou handshake sem
//      sucesso) mostra um erro e sugere usar usuário/senha.
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

async function submitWindowsLogin() {
  const btn = document.getElementById('lpWindowsBtn');
  _lpClearError();
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/me');
    if (!res.ok) throw new Error('Windows authentication is not available right now.');
    const me = await res.json();
    if (me.authMethod !== 'ntlm') {
      throw new Error('Windows authentication is not available. Please log in with your username and password instead.');
    }
    _lpMarkAuthenticatedAndEnter();
  } catch (err) {
    _lpShowError(err.message || 'Windows authentication failed.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const userInput = document.getElementById('lpUsernameInput');
  if (userInput) userInput.focus();
  const passInput = document.getElementById('lpPasswordInput');
  if (passInput) passInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') submitLocalLogin(); });
});
