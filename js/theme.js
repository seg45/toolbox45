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
  // "white" só existe como opção no tema escuro (ver comentário no preset
  // white, mais abaixo) — se o usuário troca pra claro com ele selecionado,
  // volta sozinho pro padrão, senão a UI ficaria com o destaque invisível
  // (branco em cima do fundo branco do tema claro).
  if (next === 'light') _resetAccentIfWhite();
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
// `text` = cor do texto/ícone nos botões "pill sólido" que usam
// background:var(--teal) cheio (ver var(--teal-text) abaixo) — ex.: o botão
// "Add" da toolbar (.ctb-cmd-actions .btn.ctb-cmd-btn.admin-highlight, ver
// css/layout.css), .ipc-calc-btn e .copy-btn.multi-on (css/components.css).
// Todos os presets antigos são cores saturadas/médias onde texto branco
// sempre teve bom contraste, por isso "text" não existia até agora — era
// sempre branco, fixo, hardcoded em cada regra. Precisou virar variável
// quando "white" (abaixo) quebrou esse pressuposto: texto branco em cima de
// fundo branco fica invisível — foi exatamente o bug relatado pelo usuário
// ("No modo escuro com a cor branca o botão ficou sem texto").
const ACCENT_PRESETS = {
  // "teal" é a cor oficial da marca Toolbox45 (#1695A3) e é o padrão do app.
  teal:   { teal: '#1695A3', tealBg: 'rgba(22,149,163,.08)', text: '#fff' },
  // "pink" é a cor oficial de marca da Check Point (#DA1572 — mesma usada como
  // msapplication-TileColor em checkpoint.com) — mantido como opção, não é
  // mais o padrão desde o rebranding para Toolbox45.
  pink:   { teal: '#DA1572', tealBg: 'rgba(218,21,114,.08)', text: '#fff' },
  blue:   { teal: '#60A5FA', tealBg: 'rgba(96,165,250,.08)', text: '#fff' },
  green:  { teal: '#4ADE80', tealBg: 'rgba(74,222,128,.08)', text: '#fff' },
  purple: { teal: '#C084FC', tealBg: 'rgba(192,132,252,.08)', text: '#fff' },
  orange: { teal: '#FB923C', tealBg: 'rgba(251,146,60,.08)', text: '#fff' },
  red:    { teal: '#F87171', tealBg: 'rgba(248,113,113,.08)', text: '#fff' },
  // Pedido do usuário: "em preferência do usuário inclua a cor branca quando
  // o modo escuro for habilitado" — branco só faz sentido em cima do fundo
  // escuro do tema dark (no claro ficaria invisível: destaque branco em
  // cima de fundo branco). O swatch (#accentSwatchWhite, index.html) só
  // aparece com [data-theme="dark"] (ver css/components.css), e
  // _resetAccentIfWhite() abaixo garante que a troca pra "white" nunca
  // sobrevive a uma troca de volta pro tema claro. text:'#0D1117' (mesmo
  // tom escuro fixo já usado em .btn-primary) em vez de branco, senão os
  // botões de pill sólido citados acima ficam com texto branco em cima de
  // fundo branco.
  white:  { teal: '#FFFFFF', tealBg: 'rgba(255,255,255,.12)', text: '#0D1117' },
};
const DEFAULT_ACCENT = 'teal';
function applyAccentColor(key) {
  const preset = ACCENT_PRESETS[key] || ACCENT_PRESETS[DEFAULT_ACCENT];
  document.documentElement.style.setProperty('--teal', preset.teal);
  document.documentElement.style.setProperty('--teal-bg', preset.tealBg);
  document.documentElement.style.setProperty('--teal-text', preset.text);
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
// Ver comentário no preset "white" acima — chamado ao trocar pro tema claro
// (toggleModalTheme) e no boot (initAccentColor), pros dois caminhos em que
// o tema pode passar a ser "light" com "white" ainda salvo.
function _resetAccentIfWhite() {
  let accent = null;
  try { accent = localStorage.getItem('cpa-accent'); } catch (e) {}
  if (accent === 'white') setAccentColor(DEFAULT_ACCENT);
}
(function initAccentColor() {
  let saved = null;
  try { saved = localStorage.getItem('cpa-accent'); } catch (e) {}
  applyAccentColor(saved || DEFAULT_ACCENT);
  syncAccentColorUI(saved || DEFAULT_ACCENT);
  const theme = document.documentElement.getAttribute('data-theme'); // já setado por initTheme() acima
  if (theme === 'light') _resetAccentIfWhite();
})();

