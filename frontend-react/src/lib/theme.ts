// ════════════════════════════════════════════════
// TEMA CLARO/ESCURO + COR DE DESTAQUE (ACCENT) — porta de js/theme.js.
//
// Nesta fatia (login), só a parte de APLICAR o tema/cor é usada (pelo
// boot inline em login.html — que tem sua PRÓPRIA cópia inline destes
// mesmos presets, de propósito, pra rodar antes de qualquer JS carregar —
// ver comentário lá — e por appearanceBoot.ts, que corrige o valor depois
// que o fetch a /api/system/appearance responde). O toggle de tema
// pessoal (toggleModalTheme, setAccentColor) e o boot de preferência
// PESSOAL (initTheme/initAccentColor completos, com 'cpa-theme'/
// 'cpa-accent') só fazem sentido dentro do app principal (Settings) —
// entram na fatia 2/8, não são usados por login.html.
// ════════════════════════════════════════════════

export const ACCENT_PRESETS: Record<string, { teal: string; tealBg: string; text: string }> = {
  teal:   { teal: '#1695A3', tealBg: 'rgba(22,149,163,.08)', text: '#fff' },
  pink:   { teal: '#DA1572', tealBg: 'rgba(218,21,114,.08)', text: '#fff' },
  blue:   { teal: '#60A5FA', tealBg: 'rgba(96,165,250,.08)', text: '#fff' },
  green:  { teal: '#4ADE80', tealBg: 'rgba(74,222,128,.08)', text: '#fff' },
  purple: { teal: '#C084FC', tealBg: 'rgba(192,132,252,.08)', text: '#fff' },
  orange: { teal: '#FB923C', tealBg: 'rgba(251,146,60,.08)', text: '#fff' },
  red:    { teal: '#F87171', tealBg: 'rgba(248,113,113,.08)', text: '#fff' },
  // "white" só faz sentido no tema escuro — ver comentário completo no
  // js/theme.js original (preset "white").
  white:  { teal: '#FFFFFF', tealBg: 'rgba(255,255,255,.12)', text: '#0D1117' },
};
export const DEFAULT_ACCENT = 'teal';

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function applyAccentColor(key: string): void {
  const preset = ACCENT_PRESETS[key] || ACCENT_PRESETS[DEFAULT_ACCENT];
  const s = document.documentElement.style;
  s.setProperty('--teal', preset.teal);
  s.setProperty('--teal-bg', preset.tealBg);
  s.setProperty('--teal-text', preset.text);
}

// Ver comentário no preset "white" acima — usado tanto no boot (org
// default) quanto, a partir da fatia 8, no toggle pessoal de tema.
export function resolveAccentForTheme(theme: 'light' | 'dark', accent: string): string {
  return theme === 'light' && accent === 'white' ? DEFAULT_ACCENT : accent;
}
