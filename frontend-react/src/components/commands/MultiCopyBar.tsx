// Barra flutuante da cópia em lote (ver lib/multiCopy.ts) — porta de _mcBar()/
// _mcFinish()/_mcDeleteSelected() de js/terminal-renderer.js. "Delete" só
// aparece para admin (a API recusaria de qualquer forma).
import { useEffect } from 'react';
import { useAuth } from '../../lib/auth';
import { deleteCommand } from '../../lib/commands';
import { useConfirm } from '../../lib/useConfirm';
import { cancelMultiCopy, orderedSelection, selectedCommandIds, useMultiCopy } from '../../lib/multiCopy';
import { copyToClipboard } from './CopyButton';

export function MultiCopyBar({ onDeleted }: { onDeleted: () => void }) {
  const auth = useAuth();
  const confirmAction = useConfirm();
  const { active, selected } = useMultiCopy();
  const n = selected.size;

  // Escape e clique fora (fora de botões de copiar e da barra) saem do modo.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') cancelMultiCopy();
    }
    function onClick(ev: MouseEvent) {
      const t = ev.target as Element | null;
      if (t && (t.closest('.copy-btn') || t.closest('.multi-copy-bar'))) return;
      cancelMultiCopy();
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onClick);
    };
  }, [active]);

  // Sai do modo se a tela de comandos desmontar (troca de aba/visão).
  useEffect(() => () => cancelMultiCopy(), []);

  async function finish() {
    const entries = orderedSelection();
    if (!entries.length) {
      cancelMultiCopy();
      return;
    }
    try {
      await copyToClipboard(entries.map(e => e.text).join('\n'));
      cancelMultiCopy();
    } catch (err) {
      console.error('Multi-copy failed', err);
      window.alert('Failed to copy — please try again.');
    }
  }

  async function deleteSelected() {
    const ids = selectedCommandIds();
    if (!ids.length) return;
    const label = ids.length === 1 ? '1 selected command' : `${ids.length} selected commands`;
    const ok = await confirmAction(`Delete ${label}? This action cannot be undone.`, { danger: true });
    if (!ok) return;
    try {
      await Promise.all(ids.map(id => deleteCommand(id)));
    } catch (err) {
      console.error('Bulk delete failed', err);
      window.alert('Failed to delete one or more of the selected commands. Please try again.');
    }
    cancelMultiCopy();
    onDeleted();
  }

  return (
    <div className={`multi-copy-bar${active ? ' show' : ''}`} id="multiCopyBar" role="toolbar" aria-label="Copy several commands">
      <span className="multi-copy-count" id="multiCopyCount">{n === 1 ? '1 selected' : `${n} selected`}</span>
      {auth.isAdmin && (
        <button type="button" className="btn btn-danger btn-sm" id="multiCopyDeleteBtn" disabled={selectedCommandIds().length === 0} onClick={deleteSelected}>
          Delete
        </button>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={cancelMultiCopy}>Cancel</button>
      <button type="button" className="btn btn-primary btn-sm" id="multiCopyCopyBtn" disabled={n === 0} onClick={finish}>Copy</button>
    </div>
  );
}
