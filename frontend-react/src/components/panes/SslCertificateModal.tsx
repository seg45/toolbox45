// ════════════════════════════════════════════════
// "SSL Certificate" (Settings → System → SSL Certificate) — porta de
// js/ssl-certificate.js (100% novo nesta fatia). Diferença deliberada do
// Logo (ver LogoSettingsModal.tsx): o upload aqui LÊ COMO TEXTO
// (`readAsText`, não `readAsDataURL`) — PEM é texto, não binário — e o
// resultado é aparado (trim) antes de ir pro textarea.
// ════════════════════════════════════════════════
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useConfirm } from '../../lib/useConfirm';
import { formatAuditDate } from '../../lib/folders';
import { ApiError, deleteSslCertificate, fetchSslCertificate, saveSslCertificate, type SslCertificateInfo } from '../../lib/api';

function renderInfo(info: SslCertificateInfo | null, loading: boolean, loadFailed: boolean): ReactNode {
  if (loading) return 'Loading…';
  if (loadFailed || !info) return 'Failed to load certificate status. Please try again.';
  return (
    <>
      {(info.isSelfSigned || info.isExpired) && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          {/* Mesmo destaque visual do original — "expired" em vermelho
              (aviso de verdade), "self-signed" em cinza neutro (informativo),
              em vez dos dois caírem no mesmo badge neutro padrão. */}
          {info.isSelfSigned && (
            <span className="cat-protected-badge" style={{ background: 'var(--surf3, rgba(128,128,128,.2))', color: 'var(--dim)' }}>
              self-signed
            </span>
          )}
          {info.isExpired && (
            <span className="cat-protected-badge" style={{ background: 'rgba(229,72,77,.15)', color: 'var(--danger, #e5484d)' }}>
              expired
            </span>
          )}
        </div>
      )}
      <div>
        <strong>{info.subject}</strong>
      </div>
      <div>{info.issuer}</div>
      <div>
        Valid: {formatAuditDate(info.validFrom)} — {formatAuditDate(info.validTo)}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: '11px' }}>SHA-256: {info.fingerprint256}</div>
    </>
  );
}

export function SslCertificateModal({ onClose }: { onClose: () => void }) {
  const confirm = useConfirm();
  const [info, setInfo] = useState<SslCertificateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [chain, setChain] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadStatus() {
    setLoading(true);
    setLoadFailed(false);
    try {
      setInfo(await fetchSslCertificate());
    } catch {
      setInfo(null);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Lê como TEXTO (não dataURL) + trim — diferente do upload de Logo, ver
  // comentário no topo do arquivo.
  function handleFileChange(which: 'cert' | 'key' | 'chain', file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = (reader.result as string).trim();
      if (which === 'cert') setCert(text);
      else if (which === 'key') setKey(text);
      else setChain(text);
    };
    reader.onerror = () => alert('Could not read the selected file.');
    reader.readAsText(file);
  }

  async function handleSave() {
    const trimmedCert = cert.trim();
    const trimmedKey = key.trim();
    if (!trimmedCert || !trimmedKey) {
      setStatus('Paste (or upload) both the certificate and the private key.');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const data = await saveSslCertificate({ cert: trimmedCert, key: trimmedKey, chain: chain.trim() || undefined });
      setStatus('Certificate saved. HTTPS will pick it up automatically within a few seconds.');
      setCert('');
      setKey('');
      setChain('');
      setInfo(data);
      setLoadFailed(false);
    } catch (e) {
      setStatus(e instanceof ApiError ? e.message : 'Failed to save the certificate. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm(
      'Remove the custom certificate and revert to a self-signed one? Browsers will show a trust warning again until a new certificate is imported.',
      { danger: true }
    );
    if (!ok) return;
    try {
      const data = await deleteSslCertificate();
      setInfo(data);
      setLoadFailed(false);
      setStatus('Reverted to a self-signed certificate.');
    } catch {
      alert('Failed to remove the certificate. Please try again.');
    }
  }

  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box modal-wide">
        <div className="modal-head">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 118 0v4" />
            </svg>
            <span>SSL Certificate</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">Current certificate</span>
            <div className="audit-log-wrap" style={{ padding: '10px 12px' }}>
              <div style={{ fontSize: '12.5px', lineHeight: 1.7 }}>{renderInfo(info, loading, loadFailed)}</div>
            </div>
          </div>
          <div className="set-group">
            <span className="set-label">Import / replace certificate</span>
            <span className="set-hint">
              Paste (or upload) the certificate and its private key as PEM text — both are required, unencrypted (no passphrase). An optional
              chain/intermediate bundle can be appended after the certificate.
            </span>
            <span className="set-label" style={{ marginTop: 6 }}>
              Certificate (PEM)
            </span>
            <textarea
              className="set-input"
              rows={5}
              spellCheck={false}
              placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'}
              style={{ fontFamily: 'var(--mono)', fontSize: '11.5px', width: '100%', resize: 'vertical' }}
              value={cert}
              onChange={ev => setCert(ev.target.value)}
            />
            <div className="settings-action-row" style={{ marginTop: 4 }}>
              <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                📄 Upload file
                <input
                  type="file"
                  accept=".pem,.crt,.cer,.txt"
                  style={{ display: 'none' }}
                  onChange={ev => {
                    handleFileChange('cert', ev.target.files?.[0]);
                    ev.target.value = '';
                  }}
                />
              </label>
            </div>
            <span className="set-label" style={{ marginTop: 10 }}>
              Private key (PEM)
            </span>
            <textarea
              className="set-input"
              rows={5}
              spellCheck={false}
              placeholder={'-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'}
              style={{ fontFamily: 'var(--mono)', fontSize: '11.5px', width: '100%', resize: 'vertical' }}
              value={key}
              onChange={ev => setKey(ev.target.value)}
            />
            <div className="settings-action-row" style={{ marginTop: 4 }}>
              <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                📄 Upload file
                <input
                  type="file"
                  accept=".pem,.key,.txt"
                  style={{ display: 'none' }}
                  onChange={ev => {
                    handleFileChange('key', ev.target.files?.[0]);
                    ev.target.value = '';
                  }}
                />
              </label>
            </div>
            <span className="set-label" style={{ marginTop: 10 }}>
              Chain / intermediates (PEM, optional)
            </span>
            <textarea
              className="set-input"
              rows={3}
              spellCheck={false}
              style={{ fontFamily: 'var(--mono)', fontSize: '11.5px', width: '100%', resize: 'vertical' }}
              value={chain}
              onChange={ev => setChain(ev.target.value)}
            />
            <div className="settings-action-row" style={{ marginTop: 4 }}>
              <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
                📄 Upload file
                <input
                  type="file"
                  accept=".pem,.crt,.cer,.txt"
                  style={{ display: 'none' }}
                  onChange={ev => {
                    handleFileChange('chain', ev.target.files?.[0]);
                    ev.target.value = '';
                  }}
                />
              </label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={handleSave}>
                Save certificate
              </button>
              <span className="set-hint">{status}</span>
            </div>
          </div>
          <div className="set-group">
            <span className="set-label">Danger zone</span>
            <span className="set-hint">
              Removes the custom certificate and reverts to a freshly generated self-signed one. Browsers will show a trust warning again until a
              new certificate is imported.
            </span>
            <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger, #e5484d)' }} onClick={handleDelete}>
              🗑️ Remove custom certificate
            </button>
          </div>
        </div>
        <div className="modal-foot">
          <div></div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
