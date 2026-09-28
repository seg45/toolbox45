// ════════════════════════════════════════════════
// Linhas de terminal de um card — porta de termRender() em
// js/terminal-renderer.js. Ícones SVG copiados verbatim do original.
//
// O lightbox de imagem (openImageLightbox/closeImageLightbox) fica fora do
// escopo desta fatia (não estava na lista de funções a portar) — a etiqueta
// de imagem e a miniatura inline (quando "Show images" está ligado) são
// renderizadas com a mesma marcação, mas o clique ainda não abre nada; uma
// fatia futura liga o lightbox de verdade.
// ════════════════════════════════════════════════
import type { TermLine } from '../../lib/commandTemplate';
import { safeHL, stripVarMarkers } from '../../lib/syntaxHighlight';
import { CopyButton } from './CopyButton';

const NOTE_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
    <path d="M8 13h8M8 17h5" />
  </svg>
);

const IMAGE_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
);

function isCmdLine(l: TermLine): l is { p: string | null; c: string } {
  return !('type' in l);
}

export function TerminalLines({ lines, showImages }: { lines: TermLine[]; showImages: boolean }) {
  return (
    <div className="term">
      {lines.map((l, i) => {
        if (isCmdLine(l)) {
          const prompt = l.p || '[Expert@FW]#';
          return (
            <span className="cmd-line" key={i}>
              <span className="pr">{prompt} </span>
              <span dangerouslySetInnerHTML={{ __html: safeHL(l.c) }} />
              <CopyButton text={stripVarMarkers(l.c)} />
            </span>
          );
        }

        if (l.type === 'note') {
          return (
            <span className="ln-note" key={i}>
              {NOTE_ICON}
              {l.c}
            </span>
          );
        }
        if (l.type === 'warn') {
          return (
            <span className="ln-warn" key={i}>
              ⚠ {l.c}
            </span>
          );
        }
        if (l.type === 'info') {
          return (
            <span className="ln-info" key={i}>
              ℹ {l.c}
            </span>
          );
        }
        if (l.type === 'ok') {
          return (
            <span className="ln-ok" key={i}>
              ✔ {l.c}
            </span>
          );
        }
        if (l.type !== 'image') return null;
        const label = l.c || 'Configuration image';
        return (
          <span key={i}>
            {l.imageData ? (
              <span className="ln-image">
                <span className="ln-image-prompt">[Image]#</span>
                <span className="ln-image-tag" title="Click to view image" role="button" tabIndex={0}>
                  {IMAGE_ICON}
                  <span className="ln-image-label">{label}</span>
                </span>
              </span>
            ) : (
              <span className="ln-image ln-image-missing">
                <span className="ln-image-prompt">[Image]#</span>
                <span className="ln-image-tag" title="No image attached">
                  {IMAGE_ICON}
                  <span className="ln-image-label">{label}</span>
                </span>
              </span>
            )}
            {showImages && l.imageData && (
              <img className="ln-image-inline" src={l.imageData} alt={label} title="Click to view full size" />
            )}
          </span>
        );
      })}
    </div>
  );
}
