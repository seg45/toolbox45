// ════════════════════════════════════════════════
// SANITIZAÇÃO DE HTML RICO NO CLIENTE (defesa em profundidade).
//
// O servidor já sanitiza `details` de comandos e as notas ao gravar
// (server-py/app/sanitize.py), mas o cliente NÃO deve confiar nisso: dados
// gravados por versões antigas (cujo sanitizador baseado em regex podia
// deixar passar uma tag malformada, ex.: `<img src=x onerror=… <b>`) ainda
// podem estar no banco, e o HTML dos detalhes também recebe valores digitados
// pelo usuário (tokens {{…}}) depois de vir do servidor. Toda vez que HTML
// rico vira DOM (dangerouslySetInnerHTML ou .innerHTML), ele passa por aqui.
//
// Mesma allow-list do servidor: b strong i em u br p div span ul ol li a img;
// a → só href http(s) (senão "#"), sempre target=_blank rel=noopener;
// img → só src http(s) ou data:image/, width/height; style → só color,
// font-size (NNpx) e text-align. Todo o resto (on*, class, id, data-*, tags
// desconhecidas) é descartado; o texto das tags removidas é mantido.
// ════════════════════════════════════════════════
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'u', 'br', 'p', 'div', 'span', 'ul', 'ol', 'li', 'a', 'img'];
const ALLOWED_ATTR = ['href', 'target', 'rel', 'src', 'width', 'height', 'style'];

const COLOR_RE = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/;
const FONT_SIZE_RE = /^\d{1,3}px$/;
const HTTP_RE = /^https?:\/\//i;
const IMG_SRC_RE = /^(?:https?:\/\/|data:image\/)/i;

function sanitizeStyle(style: string): string {
  const kept: string[] = [];
  for (const decl of style.split(';')) {
    const m = /^\s*([a-zA-Z-]+)\s*:\s*(.+?)\s*$/.exec(decl);
    if (!m) continue;
    const prop = m[1].toLowerCase();
    const val = m[2];
    if (prop === 'color' && COLOR_RE.test(val)) kept.push(`color:${val}`);
    else if (prop === 'font-size' && FONT_SIZE_RE.test(val)) kept.push(`font-size:${val}`);
    else if (prop === 'text-align' && ['left', 'center', 'right', 'justify'].includes(val.toLowerCase())) {
      kept.push(`text-align:${val.toLowerCase()}`);
    }
  }
  return kept.join(';');
}

let hooksInstalled = false;
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    const el = node as Element;
    if (!el.getAttribute) return;
    if (el.hasAttribute('style')) {
      const clean = sanitizeStyle(el.getAttribute('style') || '');
      if (clean) el.setAttribute('style', clean);
      else el.removeAttribute('style');
    }
    if (el.nodeName === 'A') {
      const href = (el.getAttribute('href') || '').trim();
      el.setAttribute('href', HTTP_RE.test(href) ? href : '#');
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    } else {
      el.removeAttribute('target');
      el.removeAttribute('rel');
    }
    if (el.nodeName === 'IMG') {
      const src = (el.getAttribute('src') || '').trim();
      if (!IMG_SRC_RE.test(src)) el.remove();
    }
  });
}

/** Devolve HTML seguro para uso em innerHTML/dangerouslySetInnerHTML. */
export function sanitizeRichHtml(html: string | null | undefined): string {
  if (!html) return '';
  installHooks();
  return DOMPurify.sanitize(String(html), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|data:image\/)/i,
    KEEP_CONTENT: true,
  }) as unknown as string;
}

/** Escapa texto para interpolar dentro de uma string HTML montada à mão. */
export function escapeHtml(text: string): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
