// Extraido do <script> inline de index.html para que o Content-Security-Policy
// (frontend-react/nginx.conf) possa exigir script-src 'self' sem 'unsafe-inline'.
// Continua sincrono e antes do CSS/paint (<script src> sem async/defer no <head>).
  (function () {
    var ACCENT_PRESETS = {
      teal:   { teal: '#1695A3', tealBg: 'rgba(22,149,163,.08)', text: '#fff' },
      pink:   { teal: '#DA1572', tealBg: 'rgba(218,21,114,.08)', text: '#fff' },
      blue:   { teal: '#60A5FA', tealBg: 'rgba(96,165,250,.08)', text: '#fff' },
      green:  { teal: '#4ADE80', tealBg: 'rgba(74,222,128,.08)', text: '#fff' },
      purple: { teal: '#C084FC', tealBg: 'rgba(192,132,252,.08)', text: '#fff' },
      orange: { teal: '#FB923C', tealBg: 'rgba(251,146,60,.08)', text: '#fff' },
      red:    { teal: '#F87171', tealBg: 'rgba(248,113,113,.08)', text: '#fff' },
      white:  { teal: '#FFFFFF', tealBg: 'rgba(255,255,255,.12)', text: '#0D1117' },
    };
    var theme = 'light', accent = 'teal';
    try {
      // Preferência PESSOAL ('cpa-theme'/'cpa-accent') tem prioridade
      // aqui — diferente de login.html, que só olha o default do admin
      // (ver comentário lá). Só cai pro default do admin
      // ('cpa-org-theme'/'cpa-org-accent') quando o navegador ainda não
      // tem nenhuma preferência pessoal salva — mesma regra de
      // usePersonalTheme() em src/lib/theme.ts.
      var pt = localStorage.getItem('cpa-theme');
      if (pt === 'dark' || pt === 'light') {
        theme = pt;
        accent = localStorage.getItem('cpa-accent') || localStorage.getItem('cpa-org-accent') || 'teal';
      } else {
        var ot = localStorage.getItem('cpa-org-theme');
        if (ot === 'dark' || ot === 'light') theme = ot;
        accent = localStorage.getItem('cpa-org-accent') || 'teal';
      }
    } catch (e) { /* localStorage indisponível — fica no fallback claro/teal */ }
    if (theme === 'light' && accent === 'white') accent = 'teal';
    document.documentElement.setAttribute('data-theme', theme);
    var preset = ACCENT_PRESETS[accent] || ACCENT_PRESETS.teal;
    var s = document.documentElement.style;
    s.setProperty('--teal', preset.teal);
    s.setProperty('--teal-bg', preset.tealBg);
    s.setProperty('--teal-text', preset.text);
  })();
