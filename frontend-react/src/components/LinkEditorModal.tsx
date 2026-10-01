// ════════════════════════════════════════════════
// "Add/Edit link" (#linkEditorOverlay no original) — porta de
// openLinkEditor/closeLinkEditor/submitLinkEditor (js/links.js) — fatia 6.
// Montado como filho local do Header (que guarda o modo/estado "qual link
// está sendo editado"), mesmo princípio de DatabasePane.tsx com
// FolderExportModal/FolderImportModal — só que o portal pro document.body
// (ver comentário em FolderExportModal.tsx) fica AQUI dentro, não em quem
// monta.
//
// `link` null = modo "criar" (openLinkEditor('create')); um Link = modo
// "editar" esse link (openLinkEditor('edit', id)) — mesma ideia de
// _lkEditingId no original, só que como prop em vez de variável de módulo.
// ════════════════════════════════════════════════
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../lib/api';
import { createLink, updateLink, type Link } from '../lib/links';

export function LinkEditorModal({
  link,
  onClose,
  onSaved,
}: {
  link: Link | null;
  onClose: () => void;
  onSaved: (saved: Link) => void;
}) {
  const isEdit = link != null;
  const [name, setName] = useState(link?.name || '');
  const [url, setUrl] = useState(link?.url || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl) {
      setError('Name and URL are required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const saved = isEdit ? await updateLink(link!.id, { name: trimmedName, url: trimmedUrl }) : await createLink({ name: trimmedName, url: trimmedUrl });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save link.');
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box">
        <div className="modal-head">
          <span className="modal-title">{isEdit ? 'Edit link' : 'Add link'}</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">Name</span>
            <input
              className="set-input"
              type="text"
              maxLength={120}
              autoComplete="off"
              autoFocus
              value={name}
              onChange={ev => setName(ev.target.value)}
            />
          </div>
          <div className="set-group">
            <span className="set-label">URL</span>
            <input
              className="set-input"
              type="text"
              placeholder="https://example.com"
              autoComplete="off"
              value={url}
              onChange={ev => setUrl(ev.target.value)}
              onKeyDown={ev => {
                if (ev.key === 'Enter') handleSubmit();
              }}
            />
          </div>
          {error && (
            <span className="set-hint" style={{ color: 'var(--red)' }}>
              {error}
            </span>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={handleSubmit}>
            {isEdit ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
