// ════════════════════════════════════════════════
// "Default theme & colors" (Settings → System, super_admin-only — ÚNICO
// widget desta fatia que exige super_admin, não só admin, ver
// SystemPane.tsx) — porta da parte MODAL ADMIN de js/appearance-
// settings.js (_sysAppearanceSyncUI/toggleSysAppearanceTheme/
// setSysAppearanceAccent/loadSysAppearance/saveSysAppearance). O boot
// ("aplicar o default do admin pra quem ainda não tem preferência
// pessoal") já está portado em lib/appearanceBoot.ts/lib/theme.ts (fatia
// 2) — este modal só cobre a tela de administração.
//
// Mesmo toggle visual (.sb-toggle/.tog-track/.tog-knob) + swatches
// (.accent-swatch) já usados em PreferencesPane.tsx pro tema/accent
// PESSOAL — aqui os mesmos controles, só operando sobre um estado
// "pendente" local (nunca aplicado ao próprio navegador do admin) até
// "Save" confirmar.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ACCENT_PRESETS } from '../../lib/theme';
import { fetchAppearance, updateAppearance } from '../../lib/api';

const ACCENT_TITLES: Record<string, string> = {
  teal: 'Toolbox45 teal (default)',
  pink: 'Check Point pink',
  blue: 'Light blue',
  green: 'Green',
  purple: 'Purple',
  orange: 'Orange',
  red: 'Red',
  white: 'White (dark theme only)',
};

export function AppearanceSettingsModal({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [pendingTheme, setPendingTheme] = useState<'light' | 'dark'>('light');
  const [pendingAccent, setPendingAccent] = useState('teal');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // loadSysAppearance() do original: GET /api/system/appearance -> seta
  // pending theme/accent com o valor salvo, `loaded=true`, Save fica
  // DISABLED (nada pendente ainda — `dirty` começa false).
  useEffect(() => {
    let cancelled = false;
    fetchAppearance()
      .then(data => {
        if (cancelled) return;
        setPendingTheme(data.theme);
        setPendingAccent(data.accentColor);
        setLoaded(true);
        setDirty(false);
        setStatus('');
      })
      .catch(() => {
        if (!cancelled) setStatus('Failed to load the current value.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // toggleSysAppearanceTheme(): "white" só faz sentido no tema escuro — se
  // virou light e o accent pendente era 'white', reseta pra 'teal' (mesma
  // regra de _resetAccentIfWhite usada pelo tema PESSOAL em theme.ts).
  function toggleTheme() {
    setPendingTheme(curr => {
      const next: 'light' | 'dark' = curr === 'dark' ? 'light' : 'dark';
      if (next === 'light') setPendingAccent(a => (a === 'white' ? 'teal' : a));
      return next;
    });
    setDirty(true);
    setStatus('');
  }

  function chooseAccent(key: string) {
    setPendingAccent(key);
    setDirty(true);
    setStatus('');
  }

  // saveSysAppearance(): Save some desabilitado ("Saving…"); sucesso ->
  // 'Saved.' e Save continua disabled até o usuário mexer de novo (dirty
  // volta a false); erro -> 'Failed to save. Please try again.' e Save
  // volta a ficar enabled (dirty permanece true — ainda há mudança
  // pendente).
  async function handleSave() {
    if (!loaded) return;
    setBusy(true);
    setStatus('Saving…');
    try {
      await updateAppearance(pendingTheme, pendingAccent);
      setStatus('Saved.');
      setDirty(false);
    } catch {
      setStatus('Failed to save. Please try again.');
    } finally {
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
      <div className="modal-box modal-wide">
        <div className="modal-head">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3a6 6 0 000 12 2.5 2.5 0 010 5" />
              <circle cx="8" cy="9" r="1" fill="currentColor" />
              <circle cx="12" cy="7" r="1" fill="currentColor" />
              <circle cx="16" cy="9" r="1" fill="currentColor" />
            </svg>
            <span>Default theme &amp; colors</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-hint">
              Applied on the login page for everyone, and as the starting theme/color for anyone who hasn't chosen their own yet in the app.
            </span>
            <div className={`sb-toggle${pendingTheme === 'dark' ? ' on' : ''}`} onClick={toggleTheme}>
              <div className="set-row-half">
                <div className="tog-track">
                  <div className="tog-knob"></div>
                </div>
                <span>Dark theme</span>
              </div>
              <div className="set-row-half">
                <span className="set-label">Color</span>
                <div className="accent-swatches" onClick={ev => ev.stopPropagation()}>
                  {Object.keys(ACCENT_PRESETS).map(key => (
                    <button
                      key={key}
                      type="button"
                      className={`accent-swatch${pendingAccent === key ? ' on' : ''}`}
                      style={{ background: ACCENT_PRESETS[key].teal, display: key === 'white' && pendingTheme !== 'dark' ? 'none' : undefined }}
                      onClick={() => chooseAccent(key)}
                      title={ACCENT_TITLES[key] || key}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <button type="button" className="btn btn-primary" disabled={!loaded || !dirty || busy} onClick={handleSave}>
                Save
              </button>
              <span className="set-hint">{status}</span>
            </div>
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
