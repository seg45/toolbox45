// ════════════════════════════════════════════════
// EDITOR DE TEXTO RICO (toolbar + contenteditable) — porta das funções
// _ne*/neExec/neSetFontSize/neSetColor/neInsertLink/_neHandlePaste/
// _neInsertImage/_neArmImageResize, que vivem em js/folders.js (comentário
// no código original: compartilhadas entre "Notes" de pastas — fatia 5,
// ainda não portada — e o campo "Details" do editor de comandos — esta
// fatia). Markup da toolbar portado de index.html (#cmdDetailsEditor).
//
// No original, cada instância do editor é localizada via
// closest('.note-flat-body-editing')/closest('.note-editor-body') a partir
// do elemento clicado (delegação, pois pode haver vários editores de nota
// abertos ao mesmo tempo — Notes, fatia 5). Aqui, cada <RichTextEditor>
// React já é uma instância isolada (seu próprio ref para o
// .note-editor-body) — a LÓGICA de cada função é preservada tal como no
// original, só a forma de "achar o editor" muda de closest()/querySelector
// global para o ref interno do próprio componente. Construído de forma
// genérica (aceita quantas instâncias simultâneas forem montadas — nenhum
// id fixo global) porque a fatia 5 (Notes) vai reaproveitar este MESMO
// componente depois, com potencialmente vários abertos ao mesmo tempo.
//
// Uncontrolled DE PROPÓSITO (como o original, que lê/escreve
// .innerHTML diretamente): contenteditable + valor controlado do React é
// uma armadilha conhecida (o cursor pula, digitar fica instável). Quem usa
// o componente lê ref.current.getHtml() na hora de salvar e chama
// ref.current.setHtml(...) na hora de popular/resetar o form — exatamente
// como o original fazia com .innerHTML.
// ════════════════════════════════════════════════
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { sanitizeRichHtml } from '../lib/safeHtml';

export interface RichTextEditorHandle {
  getHtml(): string;
  setHtml(html: string): void;
  resetFontSizeUI(): void;
}

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24];
const COLORS: { color: string; label: string }[] = [
  { color: '#000000', label: 'Black' },
  { color: '#1565c0', label: 'Blue' },
  { color: '#2e7d32', label: 'Green' },
  { color: '#c62828', label: 'Red' },
  { color: '#f9a825', label: 'Yellow' },
];
const EXEC_CMDS = ['bold', 'italic', 'underline', 'justifyLeft', 'justifyCenter', 'justifyRight'] as const;

// Navegadores normalizam style.color pra "rgb(r, g, b)" ao ler de volta
// mesmo quando o valor foi setado como hex (ver neSetColor original) — sem
// esta conversão, comparar contra os data-color dos swatches (sempre hex)
// nunca bateria.
function rgbToHex(value: string): string {
  if (!value) return '#000000';
  if (value[0] === '#') return value.toLowerCase();
  const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return '#000000';
  const toHex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
  return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, { ariaLabel?: string }>(function RichTextEditor(
  { ariaLabel },
  ref
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // editor._neLastRange do original — aqui, um ref por instância (não uma
  // propriedade solta no elemento DOM, já que o componente já É a
  // instância).
  const lastRangeRef = useRef<Range | null>(null);

  const [fontSize, setFontSizeState] = useState(12);
  const [color, setColorState] = useState('#000000');
  const [activeCmds, setActiveCmds] = useState<Record<string, boolean>>({});
  const [openDropdown, setOpenDropdown] = useState<'size' | 'color' | null>(null);

  // ── _neSaveSelectionFor/_neRestoreSelectionFor ──────────────────────
  function saveSelection() {
    const body = bodyRef.current;
    const sel = window.getSelection();
    if (body && sel && sel.rangeCount && body.contains(sel.anchorNode)) {
      lastRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  }
  function restoreSelection() {
    const body = bodyRef.current;
    if (!body) return;
    body.focus();
    if (lastRangeRef.current) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(lastRangeRef.current);
    }
  }

  // ── _neCurrentFontSizeAt/_neCurrentColorAt ──────────────────────────
  function currentFontSizeAt(): number {
    const body = bodyRef.current;
    const sel = window.getSelection();
    if (!body || !sel || !sel.rangeCount || !body.contains(sel.anchorNode)) return 12;
    let node: Node | null = sel.anchorNode;
    if (node && node.nodeType === 3) node = node.parentElement;
    while (node && node !== body && body.contains(node)) {
      const el = node as HTMLElement;
      if (el.style && el.style.fontSize) {
        const n = parseInt(el.style.fontSize, 10);
        if (!isNaN(n)) return n;
      }
      node = el.parentElement;
    }
    return 12;
  }
  function currentColorAt(): string {
    const body = bodyRef.current;
    const sel = window.getSelection();
    if (body && sel && sel.rangeCount && body.contains(sel.anchorNode)) {
      let node: Node | null = sel.anchorNode;
      if (node && node.nodeType === 3) node = node.parentElement;
      while (node && node !== body && body.contains(node)) {
        const el = node as HTMLElement;
        if (el.style && el.style.color) return rgbToHex(el.style.color);
        if (el.tagName === 'FONT' && el.getAttribute('color')) return (el.getAttribute('color') as string).toLowerCase();
        node = el.parentElement;
      }
    }
    return '#000000';
  }

  // ── _neUpdateToolbarState ────────────────────────────────────────────
  // forceSize/forceColor: usados logo depois de aplicar um novo
  // tamanho/cor, porque a seleção recriada com setStartBefore/setEndAfter
  // cai no elemento PAI dos nós recém-formatados, não DENTRO deles — sem
  // isso a redetecção "erraria" e mostraria o valor herdado antigo (bug
  // real do original, já corrigido lá — preservado aqui).
  function updateToolbarState(forceSize?: number, forceColor?: string) {
    const size = typeof forceSize === 'number' ? forceSize : currentFontSizeAt();
    setFontSizeState(size);
    const cmds: Record<string, boolean> = {};
    EXEC_CMDS.forEach(cmd => {
      try {
        cmds[cmd] = document.queryCommandState(cmd);
      } catch {
        cmds[cmd] = false;
      }
    });
    setActiveCmds(cmds);
    const c = typeof forceColor === 'string' ? forceColor.toLowerCase() : currentColorAt();
    setColorState(c);
  }

  // ── neExec ────────────────────────────────────────────────────────
  function exec(cmd: (typeof EXEC_CMDS)[number]) {
    const body = bodyRef.current;
    if (body) body.focus();
    document.execCommand(cmd, false, undefined);
    if (body) {
      saveSelection();
      updateToolbarState();
    }
  }

  // ── neSetFontSize ─────────────────────────────────────────────────
  // document.execCommand('fontSize', false, '7') é o único jeito sem lib de
  // aplicar um tamanho em px arbitrário: aplica a escala legada tamanho=7
  // (só usado como marcador único, fácil de achar depois), troca cada
  // <font size="7"> resultante por um <span style="font-size:Npx">
  // removendo o atributo size, resseleciona o texto afetado e GRAVA essa
  // Range fresca de volta em lastRangeRef — sem isso, aplicar o tamanho
  // DUAS vezes seguidas sem re-selecionar manualmente falha silenciosamente
  // (bug real do original, já corrigido lá — preservado aqui).
  function setFontSize(px: number) {
    let n = Math.round(px);
    if (isNaN(n)) return;
    n = Math.max(8, Math.min(24, n));
    const body = bodyRef.current;
    if (!body) return;
    restoreSelection();
    document.execCommand('fontSize', false, '7');
    const affected = Array.from(body.querySelectorAll('font[size="7"]'));
    affected.forEach(f => {
      f.removeAttribute('size');
      (f as HTMLElement).style.fontSize = n + 'px';
    });
    if (affected.length) {
      const range = document.createRange();
      range.setStartBefore(affected[0]);
      range.setEndAfter(affected[affected.length - 1]);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      saveSelection();
    }
    // Passa `n` (o tamanho que ACABAMOS de aplicar) em vez de deixar
    // updateToolbarState redetectar sozinha — ver comentário na função.
    updateToolbarState(n);
    setOpenDropdown(null);
  }

  // ── neSetColor ────────────────────────────────────────────────────
  function setColor(c: string) {
    const body = bodyRef.current;
    if (!body) return;
    restoreSelection();
    document.execCommand('foreColor', false, c);
    setOpenDropdown(null);
    saveSelection();
    updateToolbarState(undefined, c);
  }

  // ── neInsertLink ──────────────────────────────────────────────────
  // Lê a seleção salva (lastRangeRef) ANTES de pedir a URL — pedir a URL
  // (window.prompt) tira o foco do editor de qualquer forma. Sem esquema
  // (regex abaixo), prefixa "https://". Restaura a seleção salva ANTES de
  // aplicar: se havia texto selecionado, document.execCommand('createLink');
  // senão insere um <a href="url">url</a> na posição do cursor salvo (ou no
  // fim do editor, se nunca houve cursor registrado).
  async function insertLink() {
    const body = bodyRef.current;
    if (!body) return;
    const savedRange = lastRangeRef.current ? lastRangeRef.current.cloneRange() : null;
    const hasSelection = !!(savedRange && !savedRange.collapsed);
    let url = window.prompt('Insert link URL');
    if (!url) return;
    url = url.trim();
    if (!url) return;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
    body.focus();
    const sel = window.getSelection();
    if (savedRange) {
      sel?.removeAllRanges();
      sel?.addRange(savedRange);
    }
    if (hasSelection) {
      document.execCommand('createLink', false, url);
    } else if (savedRange) {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      savedRange.deleteContents();
      savedRange.insertNode(a);
      const after = document.createRange();
      after.setStartAfter(a);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      body.appendChild(a);
    }
    saveSelection();
    setOpenDropdown(null);
  }

  // ── _neArmImageResize/_neInsertImage/_neHandlePaste ──────────────────
  function armImageResize(img: HTMLImageElement) {
    img.style.cursor = 'nwse-resize';
    img.addEventListener('mousedown', ev => {
      const rect = img.getBoundingClientRect();
      const nearCorner = ev.clientX > rect.right - 16 && ev.clientY > rect.bottom - 16;
      if (!nearCorner) return;
      ev.preventDefault();
      const startX = ev.clientX;
      const startWidth = rect.width;
      function onMove(moveEv: MouseEvent) {
        const newWidth = Math.max(40, Math.min(900, startWidth + (moveEv.clientX - startX)));
        img.width = Math.round(newWidth);
        img.removeAttribute('height');
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  function insertImage(dataUrl: string) {
    const body = bodyRef.current;
    if (!body) return;
    const img = document.createElement('img');
    img.src = dataUrl;
    img.width = 320;
    body.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount && body.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      body.appendChild(img);
    }
    armImageResize(img);
  }
  function handlePaste(ev: React.ClipboardEvent<HTMLDivElement>) {
    const items = ev.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type && item.type.startsWith('image/')) {
        ev.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => insertImage(reader.result as string);
        reader.readAsDataURL(file);
        return;
      }
    }
  }

  function onSelectionActivity() {
    saveSelection();
    updateToolbarState();
  }

  // Fecha os dropdowns de tamanho/cor ao clicar fora deles — mesmo padrão
  // de _neCloseFmtDropdowns/click-away do original.
  useEffect(() => {
    if (!openDropdown) return;
    function onDocClick(ev: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpenDropdown(null);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [openDropdown]);

  useImperativeHandle(ref, () => ({
    getHtml() {
      return bodyRef.current?.innerHTML || '';
    },
    setHtml(html: string) {
      const body = bodyRef.current;
      if (!body) return;
      body.innerHTML = sanitizeRichHtml(html);
      // Imagens que já vieram no HTML salvo (ex.: reabrindo um comando
      // existente com Details contendo imagens) também precisam da alça de
      // redimensionar — só as coladas na hora (via insertImage) ganham isso
      // automaticamente pelo próprio fluxo de colar (_neArmExistingImages
      // do original).
      body.querySelectorAll('img').forEach(img => armImageResize(img as HTMLImageElement));
    },
    resetFontSizeUI() {
      setFontSizeState(12);
      setColorState('#000000');
      setActiveCmds({});
      lastRangeRef.current = null;
    },
  }));

  return (
    <div className="note-flat-body note-flat-body-editing" ref={wrapRef}>
      <div className="note-editor-toolbar">
        <button
          type="button"
          className={`ne-fmt-btn${activeCmds.bold ? ' on' : ''}`}
          data-ne-cmd="bold"
          onMouseDown={e => e.preventDefault()}
          onClick={() => exec('bold')}
          title="Bold (Ctrl+B)"
        >
          <b>B</b>
        </button>
        <button
          type="button"
          className={`ne-fmt-btn${activeCmds.italic ? ' on' : ''}`}
          data-ne-cmd="italic"
          onMouseDown={e => e.preventDefault()}
          onClick={() => exec('italic')}
          title="Italic (Ctrl+I)"
        >
          <i>I</i>
        </button>
        <button
          type="button"
          className={`ne-fmt-btn${activeCmds.underline ? ' on' : ''}`}
          data-ne-cmd="underline"
          onMouseDown={e => e.preventDefault()}
          onClick={() => exec('underline')}
          title="Underline (Ctrl+U)"
        >
          <u>U</u>
        </button>
        <span className="ne-fmt-sep"></span>
        <span className="ne-fmt-dd">
          <button
            type="button"
            className="ne-fmt-dd-btn"
            onMouseDown={e => e.preventDefault()}
            onClick={() => setOpenDropdown(d => (d === 'size' ? null : 'size'))}
            title="Font size"
          >
            <span className="ne-fmt-dd-btn-label">{fontSize}</span>
            <span className="ne-fmt-dd-arrow">▾</span>
          </button>
          <span className={`ne-fmt-dd-panel ne-fmt-dd-panel-sizes${openDropdown === 'size' ? ' open' : ''}`}>
            {SIZES.map(sz => (
              <button
                key={sz}
                type="button"
                className={`ne-fmt-size-opt${fontSize === sz ? ' on' : ''}`}
                data-size={sz}
                onMouseDown={e => e.preventDefault()}
                onClick={() => setFontSize(sz)}
              >
                {sz}
              </button>
            ))}
          </span>
        </span>
        <span className="ne-fmt-dd">
          <button
            type="button"
            className="ne-fmt-dd-btn"
            onMouseDown={e => e.preventDefault()}
            onClick={() => setOpenDropdown(d => (d === 'color' ? null : 'color'))}
            title="Text color"
          >
            <span className="ne-fmt-color-trigger-swatch" style={{ background: color }}></span>
            <span className="ne-fmt-dd-arrow">▾</span>
          </button>
          <span className={`ne-fmt-dd-panel ne-fmt-dd-panel-colors${openDropdown === 'color' ? ' open' : ''}`}>
            {COLORS.map(c => (
              <button
                key={c.color}
                type="button"
                className={`ne-fmt-color-swatch${color === c.color ? ' on' : ''}`}
                data-color={c.color}
                style={{ background: c.color }}
                onMouseDown={e => e.preventDefault()}
                onClick={() => setColor(c.color)}
                title={c.label}
              ></button>
            ))}
          </span>
        </span>
        <span className="ne-fmt-sep"></span>
        <button
          type="button"
          className={`ne-fmt-btn${activeCmds.justifyLeft ? ' on' : ''}`}
          data-ne-cmd="justifyLeft"
          onMouseDown={e => e.preventDefault()}
          onClick={() => exec('justifyLeft')}
          title="Align left"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M1 3h14M1 7h9M1 11h14M1 15h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className={`ne-fmt-btn${activeCmds.justifyCenter ? ' on' : ''}`}
          data-ne-cmd="justifyCenter"
          onMouseDown={e => e.preventDefault()}
          onClick={() => exec('justifyCenter')}
          title="Align center"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M1 3h14M3.5 7h9M1 11h14M3.5 15h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className={`ne-fmt-btn${activeCmds.justifyRight ? ' on' : ''}`}
          data-ne-cmd="justifyRight"
          onMouseDown={e => e.preventDefault()}
          onClick={() => exec('justifyRight')}
          title="Align right"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M1 3h14M6 7h9M1 11h14M6 15h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <span className="ne-fmt-sep"></span>
        <button type="button" className="ne-fmt-btn" onMouseDown={e => e.preventDefault()} onClick={() => insertLink()} title="Insert link">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
              d="M6.5 9.5l3-3M7 4.5l1.3-1.3a2.6 2.6 0 013.7 3.7L10.5 8M9 11.5l-1.3 1.3a2.6 2.6 0 01-3.7-3.7L5.5 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div
        className="note-editor-body"
        contentEditable
        suppressContentEditableWarning
        ref={bodyRef}
        aria-label={ariaLabel}
        onMouseUp={onSelectionActivity}
        onKeyUp={onSelectionActivity}
        onPaste={handlePaste}
      />
    </div>
  );
});
