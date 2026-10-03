// ════════════════════════════════════════════════
// Reveal da chave recém-criada (Settings → System → API access) — porta
// de js/api-keys.js (100% novo nesta fatia). Aberto automaticamente logo
// após um "New API key" bem-sucedido (ver SystemPane.tsx) — a chave em
// texto puro só existe neste momento; depois disso só o prefixo fica
// disponível em qualquer lugar.
// ════════════════════════════════════════════════
import { createPortal } from 'react-dom';
import { CopyButton } from '../commands/CopyButton';

export function ApiKeyRevealModal({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box">
        <div className="modal-head">
          <span className="modal-title">API key created</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-hint">
              Copy this key now — it will not be shown again (only the prefix is kept afterwards, for identification). Send it in the{' '}
              <code>X-API-Key</code> header of external requests.
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="text" className="set-input" readOnly style={{ fontFamily: 'var(--mono)', fontSize: '11.5px', flex: 1 }} value={apiKey} />
              <CopyButton text={apiKey} />
            </div>
          </div>
        </div>
        <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
