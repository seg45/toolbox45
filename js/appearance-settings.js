// ════════════════════════════════════════════════
// TEMA E COR DE DESTAQUE PADRÃO (Settings -> System, super_admin-only) —
// pedido do usuário: "em system inclua a opção para que o super admin
// possa escolher o tema e cores default, e isso reflita na página de
// login". GET/PUT /api/system/appearance em server/index.js.
//
// Duas situações diferentes:
// - login.html: SEMPRE usa o default do admin pro tema E pra cor — página
//   pré-autenticação, não existe "preferência pessoal" aqui, então não faz
//   sentido puxar 'cpa-theme'/'cpa-accent' do navegador (seria vazar a
//   preferência pessoal de quem usou esse navegador da última vez, não a
//   identidade de quem está tentando logar agora). Substitui o antigo
//   data-theme="light" fixo — ver comentário no <head> e no <script>
//   inline no fim do <body> em login.html.
// - index.html: o default do admin só é usado como SEMENTE inicial pra
//   navegador que nunca tocou no toggle Dark mode/nos swatches de cor (ver
//   initTheme()/initAccentColor() em js/theme.js, que caem pro cache
//   'cpa-org-theme'/'cpa-org-accent' abaixo só quando não existe
//   preferência pessoal salva) — depois que o usuário escolhe o próprio
//   tema/cor, essa escolha pessoal continua valendo, o default do admin
//   não força nada por cima.
//
// Mesmo padrão de cache com aplicação síncrona ANTES do fetch (evita
// "flash" do valor errado) já usado pro logo — ver js/logo-settings.js.
// Só que aqui quem lê o cache primeiro é o PRÓPRIO js/theme.js
// (initTheme/initAccentColor), então esse arquivo precisa carregar ANTES
// deste (theme.js lê o cache no boot; este arquivo atualiza o cache pra
// próxima visita e, em login.html, força o valor mais recente por cima do
// que já foi aplicado a partir de uma preferência pessoal vazada).
// ════════════════════════════════════════════════

const APPEARANCE_ORG_THEME_KEY = 'cpa-org-theme';
const APPEARANCE_ORG_ACCENT_KEY = 'cpa-org-accent';

// true só em login.html (só ela tem #loginPageErrorMsg) — mesmo teste
// simples já usado noutros arquivos compartilhados entre as duas páginas
// pra decidir comportamento por página sem duplicar arquivo (ver
// js/logo-settings.js).
const _APPEARANCE_IS_LOGIN_PAGE = !!document.getElementById('loginPageErrorMsg');

async function _appearanceBoot() {
  let theme, accentColor;
  try {
    const res = await fetch('/api/system/appearance');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    theme = (data && (data.theme === 'light' || data.theme === 'dark')) ? data.theme : 'light';
    accentColor = (data && typeof data.accentColor === 'string' && data.accentColor) ? data.accentColor : 'teal';
  } catch (e) {
    console.warn('Não foi possível carregar o tema/cor padrão do admin', e);
    return; // sem resposta do servidor, não mexe em nada do que já estava aplicado
  }
  try {
    localStorage.setItem(APPEARANCE_ORG_THEME_KEY, theme);
    localStorage.setItem(APPEARANCE_ORG_ACCENT_KEY, accentColor);
  } catch (e) {}
  if (_APPEARANCE_IS_LOGIN_PAGE) {
    // Por cima de qualquer coisa que initTheme()/initAccentColor()
    // (js/theme.js) já tenham aplicado a partir de uma preferência pessoal
    // deste navegador — login.html não usa preferência pessoal, só o
    // default do admin. Aplica direto (sem applyTheme()/setAccentColor(),
    // que persistiriam em 'cpa-theme'/'cpa-accent' PESSOAIS — não é o que
    // queremos aqui).
    document.documentElement.setAttribute('data-theme', theme);
    if (typeof applyAccentColor === 'function') applyAccentColor(accentColor);
    if (typeof _resetAccentIfWhite === 'function' && theme === 'light') _resetAccentIfWhite();
  }
}
_appearanceBoot();

// ── Settings -> System -> "Default theme & colors" (super_admin-only) ──
// Modal (#appearanceSettingsOverlay em index.html), mesmo padrão de
// Logo/SSL Certificate — pedido do usuário: "organizar melhor essa
// página" (antes o toggle/swatches/Save ficavam soltos direto na aba, ver
// histórico completo no comentário do set-group #sysGroupAppearance em
// index.html). Muda um ESTADO PENDENTE local (_sysAppearancePending*) até
// o admin clicar Save; nada é enviado ao servidor antes disso, pro admin
// poder experimentar tema/cor sem afetar ninguém enquanto decide.
function openAppearanceSettingsModal() {
  const overlay = document.getElementById('appearanceSettingsOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  loadSysAppearance();
}

function closeAppearanceSettingsModal() {
  const overlay = document.getElementById('appearanceSettingsOverlay');
  if (overlay) overlay.classList.remove('show');
}

// Click-outside-to-close + Escape, mesmo padrão de logo-settings.js/
// ssl-certificate.js/oauth-settings.js.
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('appearanceSettingsOverlay');
  if (overlay) overlay.addEventListener('click', ev => { if (ev.target.id === 'appearanceSettingsOverlay') overlay.classList.remove('show'); });
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  const overlay = document.getElementById('appearanceSettingsOverlay');
  if (overlay) overlay.classList.remove('show');
});
let _sysAppearancePendingTheme = 'light';
let _sysAppearancePendingAccent = 'teal';
let _sysAppearanceLoaded = false; // evita Save habilitado antes do primeiro load

function _sysAppearanceSyncUI() {
  const toggle = document.getElementById('sysAppearanceThemeToggle');
  if (toggle) toggle.classList.toggle('on', _sysAppearancePendingTheme === 'dark');
  const whiteSwatch = document.getElementById('sysAppearanceAccentSwatchWhite');
  if (whiteSwatch) whiteSwatch.style.display = _sysAppearancePendingTheme === 'dark' ? '' : 'none';
  document.querySelectorAll('#sysAppearanceAccentSwatches .accent-swatch').forEach(el => {
    el.classList.toggle('on', el.dataset.accent === _sysAppearancePendingAccent);
  });
}

function toggleSysAppearanceTheme() {
  _sysAppearancePendingTheme = _sysAppearancePendingTheme === 'dark' ? 'light' : 'dark';
  // "white" só faz sentido no tema escuro (ver ACCENT_PRESETS em
  // js/theme.js) — mesma rede de segurança de _resetAccentIfWhite(), só
  // que aqui é sobre a seleção PENDENTE deste grupo, não a página em si.
  if (_sysAppearancePendingTheme === 'light' && _sysAppearancePendingAccent === 'white') {
    _sysAppearancePendingAccent = 'teal';
  }
  _sysAppearanceSyncUI();
  _sysAppearanceEnableSave();
}

function setSysAppearanceAccent(key) {
  _sysAppearancePendingAccent = key;
  _sysAppearanceSyncUI();
  _sysAppearanceEnableSave();
}

function _sysAppearanceEnableSave() {
  const btn = document.getElementById('sysAppearanceSaveBtn');
  if (btn) btn.disabled = false;
  const status = document.getElementById('sysAppearanceStatus');
  if (status) status.textContent = '';
}

async function loadSysAppearance() {
  const status = document.getElementById('sysAppearanceStatus');
  const btn = document.getElementById('sysAppearanceSaveBtn');
  try {
    const res = await fetch('/api/system/appearance');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _sysAppearancePendingTheme = (data && data.theme === 'dark') ? 'dark' : 'light';
    _sysAppearancePendingAccent = (data && typeof data.accentColor === 'string' && data.accentColor) ? data.accentColor : 'teal';
    _sysAppearanceLoaded = true;
    _sysAppearanceSyncUI();
    if (btn) btn.disabled = true; // nada pendente logo depois de carregar o valor salvo
    if (status) status.textContent = '';
  } catch (e) {
    console.error('Failed to load the default theme/color', e);
    if (status) status.textContent = 'Failed to load the current value.';
  }
}

async function saveSysAppearance() {
  if (!_sysAppearanceLoaded) return;
  const btn = document.getElementById('sysAppearanceSaveBtn');
  const status = document.getElementById('sysAppearanceStatus');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Saving…';
  try {
    const res = await fetch('/api/system/appearance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: _sysAppearancePendingTheme, accentColor: _sysAppearancePendingAccent }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    // Atualiza o cache local (mesma chave que initTheme()/initAccentColor()
    // em js/theme.js leem) — assim a PRÓPRIA sessão do admin, se ele nunca
    // escolheu um tema/cor pessoal, já reflete o novo default sem precisar
    // recarregar duas vezes.
    try {
      localStorage.setItem(APPEARANCE_ORG_THEME_KEY, data.theme);
      localStorage.setItem(APPEARANCE_ORG_ACCENT_KEY, data.accentColor);
    } catch (e) {}
    if (status) status.textContent = 'Saved.';
  } catch (err) {
    console.error('Failed to save the default theme/color', err);
    if (status) status.textContent = 'Failed to save. Please try again.';
    if (btn) btn.disabled = false; // ainda há uma mudança pendente não salva
  }
}
