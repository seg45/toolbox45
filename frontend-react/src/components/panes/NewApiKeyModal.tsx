// ════════════════════════════════════════════════
// "New API key" (Settings → System → API access) — porta de
// js/api-keys.js (100% novo nesta fatia). Submit do original: valida nome
// (trim, senão foca o campo e não faz mais nada) -> FECHA o prompt -> só
// ENTÃO chama createApiKey(name, role, validity) — ou seja, a mutação de
// rede (POST + refresh da lista + abrir o modal de reveal) não é
// responsabilidade deste componente, e sim de quem o abre (SystemPane.tsx,
// via `onSubmit`), do mesmo jeito que o original separava
// submitNewApiKey() (só o prompt) de createApiKey() (a chamada em si).
// ════════════════════════════════════════════════
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function NewApiKeyModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (name: string, role: 'user' | 'admin', validity: string) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [validity, setValidity] = useState('never');
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    onClose();
    onSubmit(trimmed, role, validity);
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
          <span className="modal-title">New API key</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">Name</span>
            <input
              ref={inputRef}
              className="set-input"
              type="text"
              autoComplete="off"
              autoFocus
              placeholder='e.g. "Integration X" or the team/system that will use it'
              maxLength={120}
              value={name}
              onChange={ev => setName(ev.target.value)}
              onKeyDown={ev => {
                if (ev.key === 'Enter') handleSubmit();
              }}
            />
          </div>
          <div className="set-group">
            <span className="set-label">Role</span>
            <select className="set-input" value={role} onChange={ev => setRole(ev.target.value as 'user' | 'admin')}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="set-group">
            <span className="set-label">Validity</span>
            <select className="set-input" value={validity} onChange={ev => setValidity(ev.target.value)}>
              <option value="1d">1 day</option>
              <option value="1w">1 week</option>
              <option value="1m">1 month</option>
              <option value="1y">1 year</option>
              <option value="never">Never</option>
            </select>
          </div>
        </div>
        <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            Create
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
