// Extraido do <script> inline de login.html para que o Content-Security-Policy
// (frontend-react/nginx.conf) possa exigir script-src 'self' sem 'unsafe-inline'.
// Continua sincrono e antes do CSS/paint (<script src> sem async/defer no <head>).
  // BOOT SÍNCRONO — roda antes de qualquer CSS/paint, pra nunca mostrar o
  // tema/cor errados por uma fração de segundo ("flash"). Precisa ser um
  // <script> inline, plano, ANTES dos <link> de CSS — não pode esperar o
  // bundle React (que só carrega depois, é assíncrono por natureza).
  //
  // Replica o efeito LÍQUIDO do boot do app original nesta mesma página
  // (js/theme.js::initTheme()/initAccentColor() + o <script> de reforço no
  // fim do <body> de login.html) — login.html sempre acaba refletindo o
  // default do admin (cpa-org-theme/cpa-org-accent), nunca uma preferência
  // pessoal (cpa-theme/cpa-accent, que só existe no app principal) — ver
  // comentário completo no login.html original. Só o RESULTADO final foi
  // replicado aqui, não o passo intermediário (aplicar a pessoal e depois
  // sobrescrever) — o passo intermediário nunca chega a pintar na tela.
  //
  // ACCENT_PRESETS duplicado de propósito (mesmo padrão do app original,
  // que já duplica LOGO_CACHE_KEY entre login.html/js/logo-settings.js
  // pelo mesmo motivo): este script tem que ser 100% autocontido, sem
  // depender de nenhum módulo ainda não carregado. A cópia "de verdade"
  // (usada pelo resto do app a partir da fatia 2) vive em src/lib/theme.ts.
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
      var t = localStorage.getItem('cpa-org-theme');
      if (t === 'dark' || t === 'light') theme = t;
      accent = localStorage.getItem('cpa-org-accent') || 'teal';
    } catch (e) { /* localStorage indisponível — fica no fallback claro/teal */ }
    // "white" só faz sentido no tema escuro (ver ACCENT_PRESETS em
    // src/lib/theme.ts) — mesma rede de segurança do app original.
    if (theme === 'light' && accent === 'white') accent = 'teal';
    document.documentElement.setAttribute('data-theme', theme);
    var preset = ACCENT_PRESETS[accent] || ACCENT_PRESETS.teal;
    var s = document.documentElement.style;
    s.setProperty('--teal', preset.teal);
    s.setProperty('--teal-bg', preset.tealBg);
    s.setProperty('--teal-text', preset.text);
  })();
