// Rede de seguranca contra folha de estilo que falha ao carregar (pagina "sem
// CSS" que so normaliza com F5). Roda como <script src> (CSP: script-src 'self').
// Se algum <link rel="stylesheet"> do proprio site der erro ou ficar sem regras,
// busca de novo o mesmo arquivo com um parametro ?r=... (ate 3 tentativas, com
// espera crescente) e so entao remove o link quebrado. Nao mexe em folhas de
// outras origens (Google Fonts).
(function () {
  var MAX_TRIES = 3;

  function sameOriginSheet(link) {
    try {
      return link.rel === 'stylesheet' && new URL(link.href, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  function isBroken(link) {
    try {
      if (!link.sheet) return true;
      return link.sheet.cssRules.length === 0;
    } catch (e) {
      return true; // folha do mesmo origin sempre e legivel; SecurityError = a carga falhou (o Chrome marca assim)
    }
  }

  function retry(broken, n) {
    if (broken.__tbRetrying) return;
    broken.__tbRetrying = true;
    var url = new URL(broken.href, location.href);
    url.searchParams.set('r', String(Date.now()));
    var fresh = document.createElement('link');
    fresh.rel = 'stylesheet';
    fresh.href = url.toString();
    var co = broken.getAttribute('crossorigin');
    if (co !== null) fresh.setAttribute('crossorigin', co);
    fresh.onload = function () {
      if (isBroken(fresh)) return fail();
      if (broken.parentNode) broken.parentNode.removeChild(broken);
    };
    fresh.onerror = fail;
    function fail() {
      if (fresh.parentNode) fresh.parentNode.removeChild(fresh);
      broken.__tbRetrying = false;
      if (n < MAX_TRIES) setTimeout(function () { retry(broken, n + 1); }, 400 * n);
    }
    document.head.appendChild(fresh);
  }

  function check() {
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      if (sameOriginSheet(links[i]) && isBroken(links[i])) retry(links[i], 1);
    }
  }

  window.addEventListener('load', function () { setTimeout(check, 200); });
  document.addEventListener('error', function (ev) {
    var t = ev.target;
    if (t && t.tagName === 'LINK' && sameOriginSheet(t)) retry(t, 1);
  }, true);
})();
