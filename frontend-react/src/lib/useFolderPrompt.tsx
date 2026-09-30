// ════════════════════════════════════════════════
// MODAL DE NOME DE PASTA (criar pasta/subpasta) — porta de
// openFolderPromptModal()/_FOLDER_PROMPT_CONFIG/submitFolderPromptModal()
// (js/folders.js) + #folderPromptOverlay (index.html). SÓ os modos
// 'create' e 'subfolder' existem aqui — o modo 'rename' do original NUNCA é
// chamado a partir deste modal nesta fatia: renomear uma pasta já existente
// é feito com um <input> inline direto no cabeçalho da seção (ver
// FolderSection.tsx, _folderNameInputBlur/_folderNameInputKeydown no
// original), não por este prompt. O modo 'link' (inserir link — editor de
// Notes) também fica de fora: notas não existem nesta fatia (5a).
//
// Mesmo padrão de useConfirm.tsx: Context + Provider (montado uma vez em
// AppShell.tsx, ao lado de ConfirmProvider) que devolve uma função baseada
// em Promise (`prompt(mode) => Promise<string|null>`, null = cancelado),
// resolvida via estado React em vez de uma variável de módulo +
// manipulação direta do DOM.
// ════════════════════════════════════════════════
import React, { createContext, useCallback, useContext, useState } from 'react';

type PromptMode = 'create' | 'subfolder';

const CONFIG: Record<PromptMode, { title: string; ok: string; err: string }> = {
  create: { title: 'New folder', ok: 'Create', err: 'Enter a folder name.' },
  subfolder: { title: 'New subfolder', ok: 'Create', err: 'Enter a folder name.' },
};

type PromptFn = (mode: PromptMode) => Promise<string | null>;

interface Pending {
  mode: PromptMode;
  resolve: (name: string | null) => void;
}

const FolderPromptContext = createContext<PromptFn | null>(null);

export function FolderPromptProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const prompt = useCallback<PromptFn>(mode => {
    return new Promise<string | null>(resolve => {
      setValue('');
      setError('');
      setPending({ mode, resolve });
    });
  }, []);

  const close = useCallback((result: string | null) => {
    setPending(curr => {
      if (curr) curr.resolve(result);
      return null;
    });
  }, []);

  function submit() {
    if (!pending) return;
    const v = value.trim();
    if (!v) {
      setError(CONFIG[pending.mode].err);
      return;
    }
    close(v);
  }

  const cfg = CONFIG[pending?.mode ?? 'create'];

  return (
    <FolderPromptContext.Provider value={prompt}>
      {children}
      {/* Montado só enquanto `pending` existe (ao contrário do #confirmOverlay
          de useConfirm.tsx/ConfirmProvider, que fica sempre no DOM e só
          alterna a classe "show"): `.modal-overlay { display:none }` sem
          `.show` já esconde visualmente de qualquer jeito (ver
          components.css — sem transição/animação de saída envolvida, então
          não há diferença visual em desmontar), e mantê-lo FORA do DOM
          quando fechado evita que este modal (que reaproveita as MESMAS
          classes genéricas .modal-overlay/.modal-box/.modal-foot .btn do
          #confirmOverlay) atrapalhe um seletor genérico feito pra mirar
          SÓ o outro modal — foi exatamente isso que quebrou
          test/commandeditor.spec.mjs (cenário 11: `.modal-foot .btn` com
          texto "Cancel" passou a bater em DOIS elementos na página — o
          deste modal, sempre presente porém invisível, e o do
          #confirmOverlay — e `.first()` acertava o errado). */}
      {pending && (
        <div
          className="modal-overlay show"
          style={{ zIndex: 600 }}
          onClick={ev => {
            if (ev.target === ev.currentTarget) close(null);
          }}
        >
          <div className="modal-box modal-confirm">
            <div className="modal-head">
              <span className="modal-title">{cfg.title}</span>
              <button className="modal-close" onClick={() => close(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="set-group">
                <span className="set-label">Name</span>
                <input
                  type="text"
                  className="set-input"
                  autoFocus
                  value={value}
                  onChange={ev => {
                    setValue(ev.target.value);
                    if (error) setError('');
                  }}
                  onKeyDown={ev => {
                    if (ev.key === 'Enter') submit();
                  }}
                />
                {error && <div className="cmd-editor-error show">{error}</div>}
              </div>
            </div>
            <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => close(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={submit}>{cfg.ok}</button>
            </div>
          </div>
        </div>
      )}
    </FolderPromptContext.Provider>
  );
}

export function useFolderPrompt(): PromptFn {
  const ctx = useContext(FolderPromptContext);
  if (!ctx) throw new Error('useFolderPrompt() precisa estar dentro de <FolderPromptProvider>');
  return ctx;
}
