// Extraido do <script> inline de index.html para que o Content-Security-Policy
// (frontend-react/nginx.conf) possa exigir script-src 'self' sem 'unsafe-inline'.
// Continua sincrono e antes do CSS/paint (<script src> sem async/defer no <head>).
  (function () {
    try {
      if (localStorage.getItem('cpa-authenticated') !== '1') {
        location.replace('login.html');
      }
    } catch (e) { /* localStorage indisponível — deixa passar, sem gate */ }
  })();
