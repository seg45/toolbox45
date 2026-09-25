// ════════════════════════════════════════════════
// LOGO — pedido do usuário: "em system inclua uma opção para troca de
// logo. o logo trocado será da página de login e da página principal. a
// opção Developed by SEG45 não pode ser alterada" e, depois, "incluir
// opção para logo em dark e light mode". Duas variantes independentes
// (GET/PUT/DELETE /api/system/logo em server/index.js, com um parâmetro
// `theme`: 'light'|'dark'): a CLARA substitui o logo do header em tema
// claro E o da tela de login (que é sempre clara — não tem preferência
// pessoal, ver comentário em login.html); a ESCURA só substitui o logo do
// header em tema escuro. Definir uma não exige nem apaga a outra — sem a
// escura definida, o header em dark mode cai no default estático
// (img/logo-toolbox45-white.png). O rodapé "Developed by SEG45" é só
// texto, sem imagem — não é tocado por nada aqui.
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
// aparecendo rapidamente antes de exibir a imagem atual" — os <img> já
// nascem no HTML com o src PADRÃO (pra funcionar sem JS/enquanto carrega),
// e _logoBoot() abaixo só troca pro logo customizado DEPOIS que o fetch em
// /api/system/logo responder — nesse intervalo o default pisca na tela.
// Corrigido com o mesmo padrão já usado em 'cpa-theme'/initTheme()
// (js/theme.js): um <script> inline logo depois do(s) <img> em
// index.html/login.html aplica este cache SINCRONAMENTE, antes de
// qualquer fetch, e _logoBoot()/saveLogoSettings()/deleteLogoSettings()
// abaixo mantêm o cache atualizado pra próxima visita. Duas chaves agora
// (clara/escura, cada uma só aplicada ao(s) <img> certo(s) pelo script
// inline) — mesmos nomes lidos lá; se mudar aqui, tem que mudar lá também.
const LOGO_CACHE_KEY = { light: 'cpa-logo-cache-light', dark: 'cpa-logo-cache-dark' };
function _logoWriteCache(theme, dataUrl) {
  try {
    if (dataUrl) localStorage.setItem(LOGO_CACHE_KEY[theme], dataUrl);
    else localStorage.removeItem(LOGO_CACHE_KEY[theme]);
  } catch (e) { /* localStorage indisponível — sem cache, sem problema, só volta a piscar */ }
}

// Aplica as duas variantes (customizada, data URL, ou null pra voltar ao
// padrão) em TODOS os <img> de logo presentes na página atual —
// index.html tem .hdr-logo-img (2, claro/escuro), login.html tem
// .login-logo-img (1, sempre a variante clara); querySelector simplesmente
// não acha nada na página que não tiver o elemento, então esta função
// funciona sem checar qual página é.
function _logoApplyToDom(lightUrl, darkUrl) {
  const headerDark = document.querySelector('.hdr-logo-img.for-dark');
  const headerLight = document.querySelector('.hdr-logo-img.for-light');
  const login = document.querySelector('.login-logo-img');
  if (headerDark) headerDark.src = darkUrl || LOGO_DEFAULT_SRC.headerDark;
  if (headerLight) headerLight.src = lightUrl || LOGO_DEFAULT_SRC.headerLight;
  if (login) login.src = lightUrl || LOGO_DEFAULT_SRC.login;
}

// Estado em memória do logo customizado atual (null = nenhum, usa o
// padrão) — populado por _logoBoot() abaixo e reaplicado pelo modal de
// admin depois de salvar/excluir, sem precisar recarregar a página.
let _logoCurrentDataUrl = { light: null, dark: null };

async function _logoBoot() {
  try {
    const res = await fetch('/api/system/logo');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _logoCurrentDataUrl.light = (data && typeof data.imageData === 'string') ? data.imageData : null;
    _logoCurrentDataUrl.dark = (data && typeof data.imageDataDark === 'string') ? data.imageDataDark : null;
    _logoApplyToDom(_logoCurrentDataUrl.light, _logoCurrentDataUrl.dark);
    _logoWriteCache('light', _logoCurrentDataUrl.light);
    _logoWriteCache('dark', _logoCurrentDataUrl.dark);
  } catch (e) {
    console.warn('Não foi possível carregar o logo customizado — usando o padrão', e);
  }
}
_logoBoot();

// ── Modal de administração (Settings -> System -> Logo) — só existe em
// index.html (#logoSettingsOverlay); em login.html os getElementById
// abaixo retornam null e as funções saem cedo, sem efeito. Cada tema tem
// seu próprio conjunto de elementos, com o sufixo Light/Dark no id (ver
// index.html) — as funções abaixo recebem `theme` ('light'|'dark') e
// resolvem o id certo a partir dele, em vez de duplicar cada função. ────
function _logoEscHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _logoFormatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function _logoSuffix(theme) { return theme === 'dark' ? 'Dark' : 'Light'; }
function _logoEl(theme, base) { return document.getElementById(base + _logoSuffix(theme)); }

let _logoPendingDataUrl = { light: null, dark: null }; // arquivo escolhido no picker, ainda não salvo, por tema

function _logoResetSlotUI(theme) {
  const fileInput = _logoEl(theme, 'logoFileInput');
  if (fileInput) fileInput.value = '';
  const pendingPreview = _logoEl(theme, 'logoPendingPreview');
  if (pendingPreview) { pendingPreview.style.display = 'none'; pendingPreview.src = ''; }
  const saveBtn = _logoEl(theme, 'logoSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  const status = _logoEl(theme, 'logoSaveStatus');
  if (status) status.textContent = '';
}

function openLogoSettingsModal() {
  const overlay = document.getElementById('logoSettingsOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  _logoPendingDataUrl = { light: null, dark: null };
  _logoResetSlotUI('light');
  _logoResetSlotUI('dark');
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
  const previewLight = document.getElementById('logoCurrentPreviewLight');
  if (!previewLight) return; // login.html não tem o modal — sai cedo
  try {
    const res = await fetch('/api/system/logo');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _logoRenderSlotStatus('light', data.imageData, data.updatedBy, data.updatedAt);
    _logoRenderSlotStatus('dark', data.imageDataDark, data.updatedByDark, data.updatedAtDark);
  } catch (err) {
    const info = document.getElementById('logoCurrentInfoLight');
    if (info) info.textContent = 'Failed to load logo status. Please try again.';
    console.error('Failed to load logo status', err);
  }
}

function _logoRenderSlotStatus(theme, imageData, updatedBy, updatedAt) {
  const preview = _logoEl(theme, 'logoCurrentPreview');
  const info = _logoEl(theme, 'logoCurrentInfo');
  const resetBtn = _logoEl(theme, 'logoResetBtn');
  if (!preview) return;
  const hasCustom = !!imageData;
  const defaultSrc = theme === 'dark' ? LOGO_DEFAULT_SRC.headerDark : LOGO_DEFAULT_SRC.headerLight;
  preview.src = hasCustom ? imageData : defaultSrc;
  if (info) {
    info.innerHTML = hasCustom
      ? `Custom logo${updatedBy ? ` — set by ${_logoEscHtml(updatedBy)}` : ''}${updatedAt ? ` on ${_logoEscHtml(_logoFormatDate(updatedAt))}` : ''}`
      : `Default Toolbox45 logo (no custom ${theme} logo set).`;
  }
  if (resetBtn) resetBtn.style.display = hasCustom ? '' : 'none';
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2MB — mesmo limite validado no servidor (LOGO_MAX_BYTES em server/index.js)
const LOGO_ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
// Pedido do usuário: "inclua dimensões e tamanho máximo da imagem" — mesmo
// valor de LOGO_MAX_DIMENSION em server/index.js, checado aqui de novo só
// pra avisar o admin ANTES do upload (o servidor recusa de qualquer forma,
// esta checagem client-side é só uma resposta mais rápida).
const LOGO_MAX_DIMENSION = 4096;

function _logoHandleFileInput(input, theme) {
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
      _logoPendingDataUrl[theme] = dataUrl;
      const pendingPreview = _logoEl(theme, 'logoPendingPreview');
      if (pendingPreview) { pendingPreview.src = dataUrl; pendingPreview.style.display = ''; }
      const saveBtn = _logoEl(theme, 'logoSaveBtn');
      if (saveBtn) saveBtn.disabled = false;
      const status = _logoEl(theme, 'logoSaveStatus');
      if (status) status.textContent = '';
    };
    probe.onerror = () => alert('Could not read the selected file.');
    probe.src = dataUrl;
  };
  reader.onerror = () => alert('Could not read the selected file.');
  reader.readAsDataURL(file);
  input.value = ''; // permite escolher o mesmo arquivo de novo depois
}

async function saveLogoSettings(theme) {
  if (!_logoPendingDataUrl[theme]) return;
  const btn = _logoEl(theme, 'logoSaveBtn');
  const status = _logoEl(theme, 'logoSaveStatus');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Saving…';
  try {
    const res = await fetch('/api/system/logo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageData: _logoPendingDataUrl[theme], theme }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    _logoCurrentDataUrl[theme] = data.imageData;
    _logoApplyToDom(_logoCurrentDataUrl.light, _logoCurrentDataUrl.dark); // já aparece no header desta sessão, sem precisar recarregar
    _logoWriteCache(theme, _logoCurrentDataUrl[theme]);
    _logoPendingDataUrl[theme] = null;
    const pendingPreview = _logoEl(theme, 'logoPendingPreview');
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

function deleteLogoSettings(theme) {
  const label = theme === 'dark' ? 'dark' : 'light';
  openConfirmModal(
    `Reset the ${label} theme logo to the default Toolbox45 logo? ${theme === 'dark' ? 'This only affects the app header in dark theme.' : 'This affects the app header in light theme and the login page.'}`,
    { danger: true }
  ).then(async ok => {
    if (!ok) return;
    try {
      const res = await fetch(`/api/system/logo?theme=${encodeURIComponent(theme)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      _logoCurrentDataUrl[theme] = null;
      _logoApplyToDom(_logoCurrentDataUrl.light, _logoCurrentDataUrl.dark);
      _logoWriteCache(theme, null);
      await loadLogoStatus();
      const status = _logoEl(theme, 'logoSaveStatus');
      if (status) status.textContent = 'Reverted to the default logo.';
    } catch (err) {
      alert('Failed to reset the logo. Please try again.');
      console.error('Failed to delete logo settings', err);
    }
  });
}
