// ════════════════════════════════════════════════
// Botão de copiar compacto (fim de cada linha de comando) — porta de
// COPY_BTN_ICON*/COPY_BTN_FEEDBACK_MS/_copyToClipboard/_doSingleCopy em
// js/terminal-renderer.js. Só o caminho de cópia ÚNICA (um clique) — o modo
// de seleção múltipla (duplo clique, MULTI_COPY_MODE, _mc*) fica de fora do
// escopo desta fatia (nenhuma outra funcionalidade depende dele ainda).
// ════════════════════════════════════════════════
import { useEffect, useId, useRef, useState } from 'react';
import { enterMultiCopy, isMultiCopyActive, toggleMultiCopy, useMultiCopy } from '../../lib/multiCopy';

const COPY_ICON = (
  <svg width="10" height="10" fill="none" viewBox="0 0 16 16">
    <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M3 10H2a1 1 0 01-1-1V2a1 1 0 011-1h7a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const OK_ICON = (
  <svg width="10" height="10" fill="none" viewBox="0 0 16 16">
    <path d="M2 8.5l3.5 3.5L14 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ERR_ICON = (
  <svg width="10" height="10" fill="none" viewBox="0 0 16 16">
    <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const COPY_BTN_FEEDBACK_MS = 1400;

// navigator.clipboard (Clipboard API assíncrona) só existe em "contexto
// seguro" (HTTPS ou localhost). Enquanto o servidor estiver em HTTP puro
// (antes de um certificado TLS ser configurado), navigator.clipboard
// normalmente é undefined, e chamar .writeText direto quebra
// silenciosamente. Tenta a API moderna primeiro e, se não existir ou
// falhar, cai no método clássico (textarea temporário +
// document.execCommand('copy')), que funciona em HTTP também.
// Exportada (fatia 6) pra IpCalcModal.tsx reaproveitar a MESMA lógica de
// cópia nos botões inline de cada linha de endereço (ipcCopyBtnHtml/
// ipcCopyInline no original), em vez de duplicá-la — só o botão em si (ícone
// sem rótulo "Copied"/"Failed", largura fixa em ch exigida pelo alinhamento
// de .ipc-valwrap) é um componente próprio ali, não este <CopyButton/>.
export function copyToClipboard(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error("execCommand('copy') returned false"));
    } catch (err) {
      reject(err);
    }
  });
}

type CopyState = 'idle' | 'ok' | 'err';

// Janela pra distinguir clique simples de duplo clique (MULTI_COPY_DBLCLICK_MS
// no original). Um clique simples copia a linha depois dessa janela; o duplo
// clique entra no modo de seleção múltipla (ver lib/multiCopy.ts).
const MULTI_COPY_DBLCLICK_MS = 300;

export function CopyButton({ text, cmdId }: { text: string; cmdId?: number }) {
  const [state, setState] = useState<CopyState>('idle');
  const timerRef = useRef<number | undefined>(undefined);
  const clickTimerRef = useRef<number | undefined>(undefined);
  const btnRef = useRef<HTMLButtonElement>(null);
  const key = useId();
  const { selected } = useMultiCopy();
  const picked = selected.has(key);

  // Desmontar com cópia individual pendente não pode copiar depois.
  useEffect(() => () => window.clearTimeout(clickTimerRef.current), []);

  function handleClick() {
    const entry = () => ({ el: btnRef.current as HTMLElement, text, cmdId });
    if (isMultiCopyActive()) {
      toggleMultiCopy(key, entry());
      return;
    }
    if (clickTimerRef.current !== undefined) {
      // 2º clique dentro da janela = duplo clique: cancela a cópia individual
      // pendente do 1º clique e entra no modo já marcando esta linha.
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = undefined;
      enterMultiCopy(key, entry());
      return;
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = undefined;
      doSingleCopy();
    }, MULTI_COPY_DBLCLICK_MS);
  }

  function doSingleCopy() {
    copyToClipboard(text)
      .then(() => {
        window.clearTimeout(timerRef.current);
        setState('ok');
        timerRef.current = window.setTimeout(() => setState('idle'), COPY_BTN_FEEDBACK_MS);
      })
      .catch(err => {
        console.error('Copy failed', err);
        window.clearTimeout(timerRef.current);
        setState('err');
        timerRef.current = window.setTimeout(() => setState('idle'), COPY_BTN_FEEDBACK_MS);
      });
  }

  const title = state === 'ok' ? 'Copied!' : state === 'err' ? 'Copy failed — select and copy manually' : 'Copy (double-click to select multiple commands)';
  const cls = `copy-btn copy-btn-inline${state === 'ok' ? ' ok' : ''}${state === 'err' ? ' err' : ''}${picked ? ' multi-on' : ''}`;

  return (
    <button type="button" ref={btnRef} className={cls} title={title} aria-pressed={picked ? true : undefined} onClick={handleClick} onDoubleClick={ev => ev.preventDefault()}>
      {state === 'ok' ? (
        <>
          {OK_ICON}
          <span>Copied</span>
        </>
      ) : state === 'err' ? (
        <>
          {ERR_ICON}
          <span>Failed</span>
        </>
      ) : (
        COPY_ICON
      )}
    </button>
  );
}
