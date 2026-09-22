// ════════════════════════════════════════════════
// TEMA CLARO / ESCURO
// ════════════════════════════════════════════════
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('cpa-theme', theme); } catch (e) {}
}
// Toggle compacto (Tema) do modal de Configurações — reflete o estado atual e
// aplica o tema oposto ao clicar, no mesmo padrão de commit instantâneo já usado
// por Idioma/Descrição/Modo administrador.
function syncThemeToggleUI(theme) {
  const el = document.getElementById('mThemeToggle');
  if (el) el.classList.toggle('on', theme === 'dark');
}
function toggleModalTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  syncThemeToggleUI(next);
}
(function initTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem('cpa-theme') || 'light'; } catch (e) {}
  applyTheme(saved);
})();

// ════════════════════════════════════════════════
// COR DE DESTAQUE (ACCENT) — sobrescreve --teal/--teal-bg (borda/texto de
// itens ativos, botão "Add command", ícones marcados, k-var etc.). A cor
// escolhida pelo usuário vale igual nos dois temas (claro e escuro) — não
// há mais distinção por tema, o que simplifica a lógica (uma única
// sobrescrita inline, sempre aplicada). Preferência independente do tema,
// salva à parte (mesmo padrão simples de 'cpa-theme' acima — não passa pelo
// SETTINGS/user-sync.js, é local ao navegador, igual ao tema).
// ════════════════════════════════════════════════
const ACCENT_PRESETS = {
  // "teal" é a cor oficial da marca Toolbox45 (#1695A3) e é o padrão do app.
  teal:   { teal: '#1695A3', tealBg: 'rgba(22,149,163,.08)' },
  // "pink" é a cor oficial de marca da Check Point (#DA1572 — mesma usada como
  // msapplication-TileColor em checkpoint.com) — mantido como opção, não é
  // mais o padrão desde o rebranding para Toolbox45.
  pink:   { teal: '#DA1572', tealBg: 'rgba(218,21,114,.08)' },
  blue:   { teal: '#60A5FA', tealBg: 'rgba(96,165,250,.08)' },
  green:  { teal: '#4ADE80', tealBg: 'rgba(74,222,128,.08)' },
  purple: { teal: '#C084FC', tealBg: 'rgba(192,132,252,.08)' },
  orange: { teal: '#FB923C', tealBg: 'rgba(251,146,60,.08)' },
  red:    { teal: '#F87171', tealBg: 'rgba(248,113,113,.08)' },
};
const DEFAULT_ACCENT = 'teal';
function applyAccentColor(key) {
  const preset = ACCENT_PRESETS[key] || ACCENT_PRESETS[DEFAULT_ACCENT];
  document.documentElement.style.setProperty('--teal', preset.teal);
  document.documentElement.style.setProperty('--teal-bg', preset.tealBg);
}
// Marca o swatch selecionado (anel de destaque, ver .accent-swatch.on em
// components.css) no grupo "Accent color" do modal de Configurações.
function syncAccentColorUI(key) {
  document.querySelectorAll('.accent-swatch').forEach(el => {
    el.classList.toggle('on', el.dataset.accent === (key || DEFAULT_ACCENT));
  });
}
function setAccentColor(key) {
  applyAccentColor(key);
  syncAccentColorUI(key);
  try { localStorage.setItem('cpa-accent', key); } catch (e) {}
}
(function initAccentColor() {
  let saved = null;
  try { saved = localStorage.getItem('cpa-accent'); } catch (e) {}
  applyAccentColor(saved || DEFAULT_ACCENT);
  syncAccentColorUI(saved || DEFAULT_ACCENT);
})();

