// Menu "⋯" de ações de uma linha de tabela. O popover vai pra um portal no
// <body> (position: fixed) porque as tabelas ficam em contêineres com
// overflow (que cortariam um menu absoluto). Fecha ao clicar fora, Esc,
// rolar ou escolher um item.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface RowMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export function RowMenu({ items, label = 'Actions' }: { items: RowMenuItem[]; label?: string }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  useEffect(() => {
    if (!open) return;
    function close() {
      setPos(null);
    }
    function onDown(ev: MouseEvent) {
      const t = ev.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        close();
        btnRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  function toggle(ev: React.MouseEvent) {
    ev.stopPropagation();
    if (open) {
      setPos(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const menuH = items.length * 34 + 12;
    const top = r.bottom + menuH > window.innerHeight - 8 ? Math.max(8, r.top - menuH - 4) : r.bottom + 4;
    setPos({ top, right: Math.max(8, window.innerWidth - r.right) });
  }

  if (!items.length) return null;
  return (
    <>
      <button type="button" ref={btnRef} className={`row-menu-btn${open ? ' on' : ''}`} aria-label={label} aria-haspopup="menu" aria-expanded={open} title={label} onClick={toggle}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {pos &&
        createPortal(
          <div ref={menuRef} className="row-menu" role="menu" style={{ top: pos.top, right: pos.right }}>
            {items.map(it => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={`row-menu-item${it.danger ? ' danger' : ''}`}
                onClick={ev => {
                  ev.stopPropagation();
                  setPos(null);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
