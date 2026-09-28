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

// ════════════════════════════════════════════════
// PREFERÊNCIA PESSOAL (fatia 2 — Settings → User preferences) — porta de
// initTheme()/initAccentColor()/toggleModalTheme()/setAccentColor() do
// js/theme.js original, como um hook React em vez do padrão imperativo
// (ler/gravar 'cpa-theme'/'cpa-accent' diretamente e reaplicar em vários
// elementos do DOM manualmente).
//
// Semente inicial: se este navegador ainda não tem NENHUMA preferência
// pessoal salva, usa o default do admin (cache 'cpa-org-theme'/
// 'cpa-org-accent', já semeado por bootLoginAppearance() em
// appearanceBoot.ts) — mesma regra do original (_cpaOrgDefault). Uma vez
// que o usuário mexe no toggle/nos swatches, a preferência pessoal passa
// a existir e o default do admin nunca mais é consultado pra ele.
// ════════════════════════════════════════════════
import { useCallback, useState } from 'react';

const THEME_KEY = 'cpa-theme';
const ACCENT_KEY = 'cpa-accent';

function readPersonalTheme(): 'light' | 'dark' | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}
function readPersonalAccent(): string | null {
  try {
    return localStorage.getItem(ACCENT_KEY);
  } catch {
    return null;
  }
}
function orgDefault(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export function usePersonalTheme() {
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => {
    const resolved = readPersonalTheme() || (orgDefault('cpa-org-theme', 'light') as 'light' | 'dark');
    applyTheme(resolved);
    return resolved;
  });
  const [accent, setAccentState] = useState<string>(() => {
    let resolved = readPersonalAccent() || orgDefault('cpa-org-accent', DEFAULT_ACCENT);
    const currentTheme = readPersonalTheme() || (orgDefault('cpa-org-theme', 'light') as 'light' | 'dark');
    resolved = resolveAccentForTheme(currentTheme, resolved);
    applyAccentColor(resolved);
    return resolved;
  });

  // applyTheme() sempre PERSISTE (ver comentário no original) — é o que
  // torna útil pro toggle de tema de verdade. setTheme() aqui é chamado
  // só a partir de uma ação explícita do usuário (toggle no modal), nunca
  // no boot — o valor inicial acima já aplica visualmente sem gravar
  // nada de novo quando cai no fallback do admin.
  const setTheme = useCallback((next: 'light' | 'dark') => {
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* best-effort */ }
    setThemeState(next);
    // "white" só existe no tema escuro — troca automática pro padrão ao
    // voltar pro claro, mesma regra do original (_resetAccentIfWhite).
    if (next === 'light') {
      setAccentState(prevAccent => {
        if (prevAccent !== 'white') return prevAccent;
        applyAccentColor(DEFAULT_ACCENT);
        try { localStorage.setItem(ACCENT_KEY, DEFAULT_ACCENT); } catch { /* best-effort */ }
        return DEFAULT_ACCENT;
      });
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const setAccent = useCallback((key: string) => {
    applyAccentColor(key);
    try { localStorage.setItem(ACCENT_KEY, key); } catch { /* best-effort */ }
    setAccentState(key);
  }, []);

  return { theme, accent, toggleTheme, setAccent };
}
