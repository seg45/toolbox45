// ════════════════════════════════════════════════
// MODAL DE CONFIRMAÇÃO GENÉRICO — porta de js/confirm-modal.js (40 linhas,
// completo) + #confirmOverlay em index.html. Substitui o confirm() nativo
// do navegador — que exibe o host da página (ex.: "localhost:3000 diz") e
// não segue as cores do tema — por um modal próprio, centralizado na tela,
// com as cores do tema atual (claro/escuro).
//
// O original é uma promise solta (openConfirmModal(msg).then(ok => ...)),
// resolvida por um único #confirmOverlay estático já presente no DOM
// (nasce escondido, container único reaproveitado por qualquer chamador).
// Portado aqui como Context (ConfirmProvider, montado uma vez em
// AppShell.tsx, mesmo nível de SettingsModal) + hook (useConfirm()) que
// devolve a função `confirm(message, opts?) => Promise<boolean>` — mesma
// assinatura baseada em Promise do original (o wizard do editor de
// comandos faz `const ok = await confirm('...'); if (!ok) return;`), só
// que resolvida via estado React (setState) em vez de uma variável de
// módulo (_confirmResolve) + manipulação direta do DOM.
// ════════════════════════════════════════════════
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface ConfirmOptions {
  danger?: boolean; // default true (mesmo default do original — a maioria das confirmações são destrutivas: fechar sem salvar, excluir)
}

type ConfirmFn = (message: string, opts?: ConfirmOptions) => Promise<boolean>;

interface PendingConfirm {
  message: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((message, opts = {}) => {
    return new Promise<boolean>(resolve => {
      setPending({ message, danger: opts.danger !== false, resolve });
    });
  }, []);

  // closeConfirmModal(result) do original — resolve a promise pendente (se
  // houver) e esconde o overlay (aqui, desmonta o estado `pending`).
  const close = useCallback((result: boolean) => {
    setPending(curr => {
      if (curr) curr.resolve(result);
      return null;
    });
  }, []);

  // Mesmo listener global de Escape do original (document.addEventListener
  // 'keydown'), só fechando quando o overlay está de fato aberto.
  useEffect(() => {
    if (!pending) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') close(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pending, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {/* Sempre montado (como o #confirmOverlay estático do original) — só
          a classe "show" (via .modal-overlay/.modal-overlay.show em
          components.css) alterna a visibilidade; clicar no fundo fecha
          com `false`, mesmo comportamento do listener 'click' original
          (ev.target.id === 'confirmOverlay'). */}
      <div
        className={`modal-overlay${pending ? ' show' : ''}`}
        id="confirmOverlay"
        // z-index explícito acima do padrão de .modal-overlay (500, ver
        // components.css) — um confirm() precisa SEMPRE ficar por cima de
        // qualquer outro modal que o disparou (ex.: "Close without saving?"
        // enquanto o CommandEditorModal ainda está aberto por trás). No
        // original, os dois <div class="modal-overlay"> coexistiam com a
        // mesma z-index:500 mas a ordem estática no DOM de index.html (
        // #confirmOverlay sempre depois de #cmdEditorOverlay) já garantia o
        // empate a favor da confirmação. Aqui, CommandEditorModal é
        // renderizado via React Portal direto em document.body (ver
        // comentário em CommandsContent.tsx) — isso pode colocá-lo DEPOIS
        // do #confirmOverlay na árvore do DOM dependendo da ordem de
        // montagem, quebrando esse empate silenciosamente. Um z-index maior
        // aqui resolve isso de forma robusta, sem depender de ordem de DOM.
        style={{ zIndex: 600 }}
        onClick={ev => {
          if (ev.target === ev.currentTarget) close(false);
        }}
      >
        <div className="modal-box modal-confirm">
          <div className="modal-head">
            <span className="modal-title" id="confirmTitle">Confirm action</span>
            <button className="modal-close" onClick={() => close(false)}>✕</button>
          </div>
          <div className="modal-body">
            <p className="confirm-msg" id="confirmMessage">{pending?.message || ''}</p>
          </div>
          <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => close(false)}>Cancel</button>
            <button
              className={`btn ${pending && !pending.danger ? 'btn-primary' : 'btn-danger'}`}
              id="confirmOkBtn"
              onClick={() => close(true)}
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm() precisa estar dentro de <ConfirmProvider>');
  return ctx;
}
