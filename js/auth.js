// ════════════════════════════════════════════════
// LOGIN — a partir de agora, a página inicial de verdade é login.html (ver
// js/login.js): campos usuário/senha OU "Continue with Windows
// authentication". O gate que força passar por lá primeiro é o script
// inline no topo do <head> deste index.html; este arquivo cuida só do que
// acontece DEPOIS de já estar dentro do app — o dropdown de conta no header
// (role atual + botão Log out, único botão do dropdown) e o próprio Log out.
// Ver server/index.js: POST /api/auth/login (chamado a partir de login.html,
// não mais daqui), POST /api/auth/logout, GET /api/me (devolve role/
// isAdmin/authMethod), e users/sessions em server/schema.sql.
//
// window.TB45_IS_ADMIN / window.TB45_AUTH_METHOD são preenchidos por
// updateAccountUI(), chamada a partir de js/user-sync.js assim que /api/me
// responde (e de novo depois de logout) — outros arquivos
// (js/command-editor.js, js/settings-modal.js) leem window.TB45_IS_ADMIN para
// decidir o que mostrar/esconder.
//
// A marca 'cpa-authenticated' no localStorage (mesma chave usada em
// login.html/js/login.js e no gate inline de index.html) é o que decide se
// o app abre direto ou volta pra login.html — authLogout() abaixo é quem a
// limpa.
// ════════════════════════════════════════════════
window.TB45_IS_ADMIN = false;
window.TB45_AUTH_METHOD = 'ntlm';
const LOGIN_FLAG_KEY = 'cpa-authenticated';

// Atualiza o rótulo do usuário no header, o texto do dropdown de conta
// (role atual + botão Log out só quando a sessão ativa é local) e dispara a
// re-aplicação do gate de admin no resto da UI (ver js/user-sync.js).
function updateAccountUI(me) {
  if (!me) return;
  window.TB45_IS_ADMIN = !!me.isAdmin;
  window.TB45_AUTH_METHOD = me.authMethod || 'ntlm';

  const roleLine = document.getElementById('hdrUserRoleLine');
  if (roleLine) {
    const roleLabel = me.isAdmin ? 'Admin' : 'User';
    const methodLabels = { local: 'local account', api_key: 'API key', ntlm: 'Windows login', anonymous: 'unidentified session' };
    const methodLabel = methodLabels[me.authMethod] || 'Windows login';
    roleLine.textContent = `${roleLabel} — signed in via ${methodLabel}`;
  }
  // Log out sempre visível pra todo mundo (pedido do usuário) — antes só
  // aparecia pra quem tinha logado com conta local (authMethod === 'local'),
  // escondido para sessões NTLM/API key. Clicar em Log out continua seguro
  // pra esses casos: POST /api/auth/logout só apaga a sessão LOCAL se
  // existir uma (ver server/index.js) — pra quem está em NTLM/API key vira
  // um no-op inofensivo, só recarrega a página (volta a identificar via
  // NTLM/API key normalmente).
  const logoutBtn = document.getElementById('hdrLogoutBtn');
  if (logoutBtn) logoutBtn.style.display = '';

  if (typeof applyAdminGating === 'function') applyAdminGating();
}

// Esconde por completo os grupos/abas admin-only de Settings (Database:
// Backup & Restore/View audit log; API access — dentro de System; e a aba
// própria "Users", ver #usersNavBtn em index.html) para quem não é admin — a
// API já recusa essas chamadas com 403 de qualquer forma (ver requireAdmin()
// em server/index.js), isto é só para não mostrar controles que vão falhar.
// "Export/Import commands" fica de fora de propósito — não é admin-only (ver
// escopo do pedido original). Exceção dentro do próprio Import: o checkbox
// "Import as System commands" (importAsSystemRow) — ver js/csv-import.js —
// que aparece só para admins.
//
// FAIL CLOSED: os 4 elementos abaixo já nascem com style="display:none" no
// próprio index.html (não só escondidos por esta função em runtime) — bug
// relatado pelo usuário (com screenshots): um usuário não-admin via essas
// seções completas por um instante (ou indefinidamente, se GET /api/me
// falhar e cair no catch de initUserSync() em js/user-sync.js, que nunca
// chega a chamar updateAccountUI()/applyAdminGating()). Antes disso, o HTML
// estático não tinha nenhum display:none — ficava visível "por padrão" até
// prova de admin ("fail open"). Agora só fica visível depois que
// applyAdminGating() confirma isAdmin:true — nunca visível por omissão.
const ADMIN_ONLY_SETTINGS_GROUP_IDS = ['sysGroupDatabase', 'sysGroupSslCertificate', 'sysGroupApiAccess', 'usersNavBtn', 'importAsSystemRow'];
function applyAdminGating() {
  ADMIN_ONLY_SETTINGS_GROUP_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = window.TB45_IS_ADMIN ? '' : 'none';
  });
}

async function authLogout() {
  const dd = document.getElementById('hdrUserDD');
  if (dd) dd.classList.remove('open');
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    console.error('Logout failed (continuing to redirect anyway):', e);
  }
  // Limpa a marca de "já passou pelo login" (ver js/login.js e o gate
  // inline no <head> de index.html) — sem isso, o próximo boot do app
  // pularia direto pra dentro de novo, sem passar pela página de login
  // (pedido do usuário: "quando o usuário fizer logout deverá ser
  // direcionado para essa página").
  try { localStorage.removeItem(LOGIN_FLAG_KEY); } catch (e) {}
  location.href = 'login.html';
}
