// ════════════════════════════════════════════════
// LOGIN — a página inicial de verdade é login.html (ver js/login.js):
// campos usuário/senha OU "Sign in with Google" (login do Windows/NTLM que
// existia aqui foi removido — pedido do usuário: "deixar somente
// autenticação local e com Google"). O gate que força passar por lá
// primeiro é o script inline no topo do <head> deste index.html; este
// arquivo cuida só do que acontece DEPOIS de já estar dentro do app — o
// dropdown de conta no header (role atual + botão Log out, único botão do
// dropdown) e o próprio Log out. Ver server/index.js: POST /api/auth/login
// (chamado a partir de login.html, não mais daqui), POST /api/auth/logout,
// GET /api/me (devolve role/isAdmin/authMethod), e users/sessions em
// server/schema.sql.
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
window.TB45_IS_SUPER_ADMIN = false;
window.TB45_AUTH_METHOD = 'local';
const LOGIN_FLAG_KEY = 'cpa-authenticated';

// Atualiza o rótulo do usuário no header, o texto do dropdown de conta
// (role atual + botão Log out só quando a sessão ativa é local) e dispara a
// re-aplicação do gate de admin no resto da UI (ver js/user-sync.js).
function updateAccountUI(me) {
  if (!me) return;
  window.TB45_IS_ADMIN = !!me.isAdmin;
  window.TB45_IS_SUPER_ADMIN = !!me.isSuperAdmin;
  window.TB45_AUTH_METHOD = me.authMethod || 'local';

  const roleLine = document.getElementById('hdrUserRoleLine');
  if (roleLine) {
    // 3 níveis (pedido do usuário: "três perfis de acesso: User, Admin e
    // Super Admin") — isSuperAdmin implica isAdmin (ver ROLE_RANK em
    // server/index.js), então checa a mais específica primeiro.
    const roleLabel = me.isSuperAdmin ? 'Super Admin' : (me.isAdmin ? 'Admin' : 'User');
    const methodLabels = { local: 'local account', api_key: 'API key', google: 'Google account', anonymous: 'unidentified session' };
    const methodLabel = methodLabels[me.authMethod] || 'local account';
    roleLine.textContent = `${roleLabel} — signed in via ${methodLabel}`;
  }
  // Log out sempre visível pra todo mundo (pedido do usuário). Clicar em
  // Log out continua seguro mesmo pra uma chamada autenticada por API key
  // (não usa cookie/sessão): POST /api/auth/logout só apaga a sessão local/
  // Google se existir uma (ver server/index.js) — pra API key vira um
  // no-op inofensivo, só recarrega a página e o gate de login manda de
  // volta pra login.html (sem sessão de navegador, não há como continuar).
  const logoutBtn = document.getElementById('hdrLogoutBtn');
  if (logoutBtn) logoutBtn.style.display = '';

  if (typeof applyAdminGating === 'function') applyAdminGating();
}

// Esconde por completo os grupos/abas admin-rank-only de Settings (Database:
// Backup & Restore/View audit log; SSL Certificate; API access; Register —
// dentro de System/Register) para quem não é Admin nem Super Admin — a API
// já recusa essas chamadas com 403 de qualquer forma (ver requireAdmin() em
// server/index.js), isto é só para não mostrar controles que vão falhar. A
// aba própria "Users" (#usersNavBtn) é a exceção: super_admin-only (pedido
// do usuário: "o perfil de Admin só não pode gerenciar usuários" — nem um
// Admin comum a vê), por isso mora na lista separada
// SUPER_ADMIN_ONLY_SETTINGS_GROUP_IDS. "Export/Import commands" fica de
// fora de propósito — não é admin-only (ver escopo do pedido original).
// Exceção dentro do próprio Import: o checkbox "Import as System commands"
// (importAsSystemRow) — ver js/csv-import.js — que aparece só para
// admin-rank.
//
// FAIL CLOSED: os elementos das 2 listas abaixo já nascem com
// style="display:none" no próprio index.html (não só escondidos por esta
// função em runtime) — bug
// relatado pelo usuário (com screenshots): um usuário não-admin via essas
// seções completas por um instante (ou indefinidamente, se GET /api/me
// falhar e cair no catch de initUserSync() em js/user-sync.js, que nunca
// chega a chamar updateAccountUI()/applyAdminGating()). Antes disso, o HTML
// estático não tinha nenhum display:none — ficava visível "por padrão" até
// prova de admin ("fail open"). Agora só fica visível depois que
// applyAdminGating() confirma isAdmin:true — nunca visível por omissão.
// registerNavBtn (aba Settings → Register/catálogos) entrou aqui — pedido do
// usuário: "o perfil User não poderá acessar cadastro de registros". Antes
// desse pedido Register não tinha gate nenhum (qualquer usuário logado
// acessava); agora é admin-rank (Admin OU Super Admin), igual ao resto
// desta lista.
const ADMIN_ONLY_SETTINGS_GROUP_IDS = ['sysGroupDatabase', 'sysGroupSslCertificate', 'sysGroupApiAccess', 'registerNavBtn', 'importAsSystemRow'];
// usersNavBtn saiu da lista acima e virou super_admin-only — pedido do
// usuário: "o perfil de Admin só não pode gerenciar usuários" (um Admin
// comum não vê nem a aba Users existir).
const SUPER_ADMIN_ONLY_SETTINGS_GROUP_IDS = ['usersNavBtn'];
function applyAdminGating() {
  ADMIN_ONLY_SETTINGS_GROUP_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = window.TB45_IS_ADMIN ? '' : 'none';
  });
  SUPER_ADMIN_ONLY_SETTINGS_GROUP_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = window.TB45_IS_SUPER_ADMIN ? '' : 'none';
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
