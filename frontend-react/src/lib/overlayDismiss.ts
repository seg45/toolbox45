// ════════════════════════════════════════════════
// Fechar um modal clicando no fundo escurecido (overlay) — SÓ quando o clique
// inteiro (apertar E soltar o mouse) acontece no fundo.
//
// Bug que isto evita: selecionar o texto de um campo dentro do modal e soltar
// o botão do mouse FORA da caixa gera um evento `click` cujo alvo é o overlay
// (o ancestral comum de onde apertou e de onde soltou) — a checagem simples
// `ev.target === ev.currentTarget` achava que era um clique no fundo e fechava
// o modal no meio da seleção. Aqui o `mousedown` também precisa ter começado
// no overlay.
// ════════════════════════════════════════════════
import type { MouseEvent } from 'react';

// Um flag POR overlay (chave = elemento): modais empilhados/aninhados na árvore
// React deixam o mousedown borbulhar até o overlay de trás, e um flag global
// seria sobrescrito por ele.
const pressed = new WeakMap<EventTarget, boolean>();

export function overlayDismissProps(close: () => void) {
  return {
    onMouseDown: (ev: MouseEvent) => {
      pressed.set(ev.currentTarget, ev.target === ev.currentTarget);
    },
    onClick: (ev: MouseEvent) => {
      const dismiss = pressed.get(ev.currentTarget) === true && ev.target === ev.currentTarget;
      pressed.set(ev.currentTarget, false);
      if (dismiss) close();
    },
  };
}
