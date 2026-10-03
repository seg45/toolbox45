// ════════════════════════════════════════════════
// "Logo" (Settings → System → Logo) — porta da parte ADMIN de
// js/logo-settings.js (_logoHandleFileInput/_logoRenderSlotStatus/
// saveLogoSettings/deleteLogoSettings). O boot "aplicar o logo assim que a
// página carrega" já foi portado em lib/useLogo.ts (fatia 2) — este modal
// só cobre a tela de administração (admin-only, ver SystemPane.tsx).
//
// `onLogoChanged` (= logo.refresh, elevado em AppShell.tsx/Header.tsx) é
// chamado logo após um PUT/DELETE bem-sucedido — aplica o logo novo no
// header AO VIVO, sem reload, mesmo efeito de _logoApplyToDom() no
// original. `loadStatus()` (GET /api/system/logo, já existe em lib/api.ts)
// é a MESMA chamada que loadLogoStatus() fazia — não precisou de nenhum
// endpoint novo, só reaproveita fetchLogo().
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfirm } from '../../lib/useConfirm';
import { formatAuditDate } from '../../lib/folders';
import { deleteLogo, fetchLogo, putLogo, type LogoResponse } from '../../lib/api';

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const LOGO_MAX_DIMENSION = 4096;

// Mesmas constantes de fallback já usadas em Header.tsx/useLogo.ts quando
// não há logo customizado.
const DEFAULT_SRC: Record<'light' | 'dark', string> = {
  light: '/img/logo-toolbox45.png?v=2',
  dark: '/img/logo-toolbox45-white.png?v=2',
};

interface ThemeUiState {
  pending: string | null; // data URL lido do arquivo escolhido, ainda não salvo
  // Trava o botão Save depois de um erro de PUT — só destrava ao escolher
  // OUTRO arquivo (handleFileChange), nunca sozinha — mesma regra do
  // original ("Save continua desabilitado até escolher outro arquivo").
  saveLocked: boolean;
  status: string;
  busy: boolean;
}
const EMPTY_THEME_STATE: ThemeUiState = { pending: null, saveLocked: false, status: '', busy: false };

export function LogoSettingsModal({ onClose, onLogoChanged }: { onClose: () => void; onLogoChanged: () => Promise<void> }) {
  const confirm = useConfirm();
  const [logoData, setLogoData] = useState<LogoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [light, setLight] = useState<ThemeUiState>(EMPTY_THEME_STATE);
  const [dark, setDark] = useState<ThemeUiState>(EMPTY_THEME_STATE);

  async function loadStatus() {
    setLoading(true);
    try {
      setLogoData(await fetchLogo());
    } catch {
      setLogoData(null);
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

  function patch(theme: 'light' | 'dark', next: Partial<ThemeUiState>) {
    (theme === 'light' ? setLight : setDark)(curr => ({ ...curr, ...next }));
  }

  // _logoHandleFileInput() do original: valida tipo/tamanho de arquivo
  // ANTES de ler, depois sonda as dimensões reais via um <img> temporário
  // (só o FileReader não diz a resolução) antes de aceitar como "pending".
  function handleFileChange(theme: 'light' | 'dark', file: File | undefined) {
    if (!file) return;
    if (!LOGO_ALLOWED_TYPES.has(file.type)) {
      alert('Unsupported image format — use PNG, JPEG or WEBP.');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      alert(`Image is too large (max ${(LOGO_MAX_BYTES / (1024 * 1024)).toFixed(0)}MB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const probe = new Image();
      probe.onload = () => {
        if (probe.naturalWidth > LOGO_MAX_DIMENSION || probe.naturalHeight > LOGO_MAX_DIMENSION) {
          alert(`Image dimensions are too large (${probe.naturalWidth}×${probe.naturalHeight}px, max ${LOGO_MAX_DIMENSION}×${LOGO_MAX_DIMENSION}px).`);
          return;
        }
        patch(theme, { pending: dataUrl, saveLocked: false, status: '' });
      };
      probe.onerror = () => alert('Could not read the selected file.');
      probe.src = dataUrl;
    };
    reader.onerror = () => alert('Could not read the selected file.');
    reader.readAsDataURL(file);
  }

  async function handleSave(theme: 'light' | 'dark') {
    const state = theme === 'light' ? light : dark;
    if (!state.pending) return;
    patch(theme, { busy: true });
    try {
      await putLogo(theme, state.pending);
      await onLogoChanged();
      patch(theme, { pending: null, saveLocked: false, status: 'Saved.', busy: false });
      await loadStatus();
    } catch {
      patch(theme, { saveLocked: true, status: 'Failed to save. Please try again.', busy: false });
    }
  }

  async function handleDelete(theme: 'light' | 'dark') {
    const ok = await confirm(
      `Reset the ${theme} theme logo to the default Toolbox45 logo? This affects the app header and the login page, whenever ${theme} theme is active.`,
      { danger: true }
    );
    if (!ok) return;
    try {
      await deleteLogo(theme);
      await onLogoChanged();
      await loadStatus();
      patch(theme, { status: 'Reverted to the default logo.' });
    } catch {
      alert('Failed to reset the logo. Please try again.');
    }
  }

  function renderSection(theme: 'light' | 'dark') {
    const state = theme === 'light' ? light : dark;
    const currentSrc = theme === 'light' ? logoData?.imageData : logoData?.imageDataDark;
    const updatedBy = theme === 'light' ? logoData?.updatedBy : logoData?.updatedByDark;
    const updatedAt = theme === 'light' ? logoData?.updatedAt : logoData?.updatedAtDark;
    const hasCustom = !!currentSrc;
    const infoText = loading
      ? 'Loading…'
      : hasCustom
      ? `Custom logo${updatedBy ? ` — set by ${updatedBy}` : ''}${updatedAt ? ` on ${formatAuditDate(updatedAt)}` : ''}`
      : `Default Toolbox45 logo (no custom ${theme} logo set).`;

    return (
      <div className="set-group" key={theme}>
        <span className="set-label">{theme === 'light' ? 'Light theme logo' : 'Dark theme logo'}</span>
        <span className="set-hint">
          {theme === 'light'
            ? "Used in the app header and on the login page whenever light theme is active (the login page follows the default theme set below)."
            : 'Used in the app header and on the login page whenever dark theme is active. Falls back to the default white Toolbox45 mark if not set.'}
        </span>
        <div className="audit-log-wrap" style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src={currentSrc || DEFAULT_SRC[theme]} style={{ width: 48, height: 48, objectFit: 'contain' }} alt="" />
          <div style={{ fontSize: '12.5px', lineHeight: 1.6, color: 'var(--muted)' }}>{infoText}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
          {state.pending && (
            <img
              src={state.pending}
              style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 6, background: 'var(--surf3, rgba(128,128,128,.15))' }}
              alt=""
            />
          )}
          <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
            📤 Choose image
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: 'none' }}
              onChange={ev => {
                handleFileChange(theme, ev.target.files?.[0]);
                ev.target.value = '';
              }}
            />
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!state.pending || state.busy || state.saveLocked}
            onClick={() => handleSave(theme)}
          >
            Save
          </button>
          {hasCustom && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger, #e5484d)' }} onClick={() => handleDelete(theme)}>
              🗑️ Reset
            </button>
          )}
          <span className="set-hint">{state.status}</span>
        </div>
      </div>
    );
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
              <rect x="3" y="4" width="18" height="15" rx="2" />
              <circle cx="8.5" cy="9.5" r="1.5" />
              <path d="M21 15l-5-5-6 6M9 19l3-3" />
            </svg>
            <span>Logo</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <span className="set-hint">
            PNG, JPEG or WEBP, up to 2MB and 4096×4096px — recommended size 1600×400px (wide banner, same shape as the current default). The default
            logo now includes the "Toolbox45" name baked into the image — include your own text if you want a name shown next to the icon.
            Transparent background works best.
          </span>
          {renderSection('light')}
          {renderSection('dark')}
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
