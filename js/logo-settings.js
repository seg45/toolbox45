// ════════════════════════════════════════════════
// LOGO — pedido do usuário: "em system inclua uma opção para troca de
// logo. o logo trocado será da página de login e da página principal. a
// opção Developed by SEG45 não pode ser alterada". Uma única imagem
// enviada aqui (GET/PUT/DELETE /api/system/logo em server/index.js)
// substitui SIMULTANEAMENTE as duas imagens do cabeçalho principal
// (.hdr-logo-img.for-dark/.for-light, ver index.html/css/layout.css) e a
// da tela de login (.login-logo-img, ver login.html) — mesmo arquivo nos
// três lugares, sem variante clara/escura própria (diferente do padrão
// antigo de 2 arquivos). O rodapé "Developed by SEG45" é só texto, sem
// imagem — não é tocado por nada aqui.
//
// GET é público (ver REQUIRE_AUTH_PUBLIC_ROUTES em server/index.js) porque
// login.html precisa aplicar o logo customizado ANTES de qualquer sessão
// existir. Este arquivo é carregado tanto por index.html quanto por
// login.html — a parte de "aplicar o logo assim que a página carrega"
// (_logoBoot/_logoApplyToDom abaixo) roda nos dois; as funções do MODAL de
// administração (openLogoSettingsModal etc.) só são chamadas em
// index.html, onde o botão "Manage logo" (Settings -> System -> Logo)
// existe — em login.html elas simplesmente nunca são invocadas.
// ════════════════════════════════════════════════

// Defaults originais (2 arquivos — claro/escuro no header, 1 arquivo na
// tela de login, que sempre usa a versão "clara") — usados tanto pra
// aplicar o padrão quando não há logo customizado quanto pro Reset.
const LOGO_DEFAULT_SRC = {
  headerDark: 'img/logo-toolbox45-white.png?v=2',
  headerLight: 'img/logo-toolbox45.png?v=2',
  login: 'img/logo-toolbox45.png?v=2',
};

// Pedido do usuário: "ao ficar atualizando a tela a imagem default fica
// aparecendo rapidamente antes de exibir a imagem atual" — o <img> já
// nasce no HTML com o src PADRÃO (pra funcionar sem JS/enquanto carrega),
// e _logoBoot() abaixo só troca pro logo customizado DEPOIS que o fetch em
// /api/system/logo responder — nesse intervalo o default pisca na tela.
// Corrigido com o mesmo padrão já usado em 'cpa-theme'/initTheme()
// (js/theme.js): um <script> inline logo depois do(s) <img> em
// index.html/login.html aplica esse cache SINCRONAMENTE, antes de
// qualquer fetch, e _logoBoot()/saveLogoSettings()/deleteLogoSettings()
// abaixo mantêm o cache atualizado pra próxima visita. Mesma chave lida
// por aquele script inline — se mudar aqui, tem que mudar lá também.
const LOGO_CACHE_KEY = 'cpa-logo-cache';
function _logoWriteCache(dataUrl) {
  try {
    if (dataUrl) localStorage.setItem(LOGO_CACHE_KEY, dataUrl);
    else localStorage.removeItem(LOGO_CACHE_KEY);
  } catch (e) { /* localStorage indisponível — sem cache, sem problema, só volta a piscar */ }
}

// Aplica um logo (customizado, data URL, ou null pra voltar ao padrão) em
// TODOS os <img> de logo presentes na página atual — index.html tem
// .hdr-logo-img (2, claro/escuro), login.html tem .login-logo-img (1);
// querySelector simplesmente não acha nada na página que não tiver o
// elemento, então esta função funciona sem checar qual página é.
function _logoApplyToDom(dataUrl) {
  const headerDark = document.querySelector('.hdr-logo-img.for-dark');
  const headerLight = document.querySelector('.hdr-logo-img.for-light');
  const login = document.querySelector('.login-logo-img');
  if (headerDark) headerDark.src = dataUrl || LOGO_DEFAULT_SRC.headerDark;
  if (headerLight) headerLight.src = dataUrl || LOGO_DEFAULT_SRC.headerLight;
  if (login) login.src = dataUrl || LOGO_DEFAULT_SRC.login;
}

// Estado em memória do logo customizado atual (null = nenhum, usa o
// padrão) — populado por _logoBoot() abaixo e reaplicado pelo modal de
// admin depois de salvar/excluir, sem precisar recarregar a página.
let _logoCurrentDataUrl = null;

async function _logoBoot() {
  try {
    const res = await fetch('/api/system/logo');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _logoCurrentDataUrl = (data && typeof data.imageData === 'string') ? data.imageData : null;
    _logoApplyToDom(_logoCurrentDataUrl);
    _logoWriteCache(_logoCurrentDataUrl);
  } catch (e) {
    console.warn('Não foi possível carregar o logo customizado — usando o padrão', e);
  }
}
_logoBoot();

// ── Modal de administração (Settings -> System -> Logo) — só existe em
// index.html (#logoSettingsOverlay); em login.html os getElementById
// abaixo retornam null e as funções saem cedo, sem efeito. ─────────────
function _logoEscHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _logoFormatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

let _logoPendingDataUrl = null; // arquivo escolhido no picker, ainda não salvo

function openLogoSettingsModal() {
  const overlay = document.getElementById('logoSettingsOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  _logoPendingDataUrl = null;
  const fileInput = document.getElementById('logoFileInput');
  if (fileInput) fileInput.value = '';
  const pendingPreview = document.getElementById('logoPendingPreview');
  if (pendingPreview) { pendingPreview.style.display = 'none'; pendingPreview.src = ''; }
  const saveBtn = document.getElementById('logoSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  const status = document.getElementById('logoSaveStatus');
  if (status) status.textContent = '';
  loadLogoStatus();
}

function closeLogoSettingsModal() {
  const overlay = document.getElementById('logoSettingsOverlay');
  if (overlay) overlay.classList.remove('show');
}

// Click-outside-to-close + Escape, mesmo padrão de ssl-certificate.js/
// oauth-settings.js.
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('logoSettingsOverlay');
  if (overlay) overlay.addEventListener('click', ev => { if (ev.target.id === 'logoSettingsOverlay') overlay.classList.remove('show'); });
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  const overlay = document.getElementById('logoSettingsOverlay');
  if (overlay) overlay.classList.remove('show');
});

async function loadLogoStatus() {
  const preview = document.getElementById('logoCurrentPreview');
  const info = document.getElementById('logoCurrentInfo');
  const resetBtn = document.getElementById('logoResetBtn');
  if (!preview) return;
  if (info) info.textContent = 'Loading…';
  try {
    const res = await fetch('/api/system/logo');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const hasCustom = !!(data && data.imageData);
    preview.src = hasCustom ? data.imageData : LOGO_DEFAULT_SRC.headerLight;
    if (info) {
      info.innerHTML = hasCustom
        ? `Custom logo${data.updatedBy ? ` — set by ${_logoEscHtml(data.updatedBy)}` : ''}${data.updatedAt ? ` on ${_logoEscHtml(_logoFormatDate(data.updatedAt))}` : ''}`
        : 'Default Toolbox45 logo (no custom logo set).';
    }
    if (resetBtn) resetBtn.style.display = hasCustom ? '' : 'none';
  } catch (err) {
    if (info) info.textContent = 'Failed to load logo status. Please try again.';
    console.error('Failed to load logo status', err);
  }
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2MB — mesmo limite validado no servidor (LOGO_MAX_BYTES em server/index.js)
const LOGO_ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
// Pedido do usuário: "inclua dimensões e tamanho máximo da imagem" — mesmo
// valor de LOGO_MAX_DIMENSION em server/index.js, checado aqui de novo só
// pra avisar o admin ANTES do upload (o servidor recusa de qualquer forma,
// esta checagem client-side é só uma resposta mais rápida).
const LOGO_MAX_DIMENSION = 4096;

function _logoHandleFileInput(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!LOGO_ALLOWED_TYPES.has(file.type)) {
    alert('Unsupported image format — use PNG, JPEG or WEBP.');
    input.value = '';
    return;
  }
  if (file.size > LOGO_MAX_BYTES) {
    alert(`Image is too large (max ${(LOGO_MAX_BYTES / (1024 * 1024)).toFixed(0)}MB).`);
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth > LOGO_MAX_DIMENSION || probe.naturalHeight > LOGO_MAX_DIMENSION) {
        alert(`Image dimensions are too large (${probe.naturalWidth}×${probe.naturalHeight}px, max ${LOGO_MAX_DIMENSION}×${LOGO_MAX_DIMENSION}px).`);
        input.value = '';
        return;
      }
      _logoPendingDataUrl = dataUrl;
      const pendingPreview = document.getElementById('logoPendingPreview');
      if (pendingPreview) { pendingPreview.src = _logoPendingDataUrl; pendingPreview.style.display = ''; }
      const saveBtn = document.getElementById('logoSaveBtn');
      if (saveBtn) saveBtn.disabled = false;
      const status = document.getElementById('logoSaveStatus');
      if (status) status.textContent = '';
    };
    probe.onerror = () => alert('Could not read the selected file.');
    probe.src = dataUrl;
  };
  reader.onerror = () => alert('Could not read the selected file.');
  reader.readAsDataURL(file);
  input.value = ''; // permite escolher o mesmo arquivo de novo depois
}

async function saveLogoSettings() {
  if (!_logoPendingDataUrl) return;
  const btn = document.getElementById('logoSaveBtn');
  const status = document.getElementById('logoSaveStatus');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Saving…';
  try {
    const res = await fetch('/api/system/logo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData: _logoPendingDataUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    _logoCurrentDataUrl = data.imageData;
    _logoApplyToDom(_logoCurrentDataUrl); // já aparece no header desta sessão, sem precisar recarregar
    _logoWriteCache(_logoCurrentDataUrl);
    _logoPendingDataUrl = null;
    const pendingPreview = document.getElementById('logoPendingPreview');
    if (pendingPreview) { pendingPreview.style.display = 'none'; pendingPreview.src = ''; }
    if (status) status.textContent = 'Saved.';
    await loadLogoStatus();
  } catch (err) {
    console.error('Failed to save the logo', err);
    if (status) status.textContent = 'Failed to save. Please try again.';
  }
  // Save fica desabilitado até outro arquivo ser escolhido (ver
  // _logoHandleFileInput) — não reabilita aqui, sucesso ou erro.
}

function deleteLogoSettings() {
  openConfirmModal(
    'Reset to the default Toolbox45 logo? This removes the custom logo from both the login page and the app header.',
    { danger: true }
  ).then(async ok => {
    if (!ok) return;
    try {
      const res = await fetch('/api/system/logo', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      _logoCurrentDataUrl = null;
      _logoApplyToDom(null);
      _logoWriteCache(null);
      await loadLogoStatus();
      const status = document.getElementById('logoSaveStatus');
      if (status) status.textContent = 'Reverted to the default logo.';
    } catch (err) {
      alert('Failed to reset the logo. Please try again.');
      console.error('Failed to delete logo settings', err);
    }
  });
}
