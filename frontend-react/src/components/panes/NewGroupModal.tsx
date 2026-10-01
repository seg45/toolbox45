// ════════════════════════════════════════════════
// "New group" (#newGroupOverlay no original) — porta de
// openNewGroupPrompt/closeNewGroupPrompt/submitNewGroup (js/groups-admin.js)
// — fatia 6. Só exige `name` não-vazio — o backend valida duplicata com 409
// ("A group named "X" already exists", ver server-py/app/routers/
// groups.py), mostrado inline igual aos outros erros do app.
// ════════════════════════════════════════════════
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../lib/api';
import { createGroup, type Group } from '../../lib/groups';

export function NewGroupModal({ onClose, onCreated }: { onClose: () => void; onCreated: (group: Group) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const group = await createGroup(trimmed);
      onCreated(group);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create group.');
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
          <span className="modal-title">New group</span>
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
              autoComplete="off"
              autoFocus
              placeholder="e.g. NGFW Support"
              maxLength={120}
              value={name}
              onChange={ev => setName(ev.target.value)}
              onKeyDown={ev => {
                if (ev.key === 'Enter') handleSubmit();
              }}
            />
          </div>
          {error && (
            <div className="set-hint" style={{ color: 'var(--red)' }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={handleSubmit}>
            Create
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
