// ════════════════════════════════════════════════
// Cabeçalho (.hdr) — porta de index.html linhas 38-197 + js/auth.js
// (updateAccountUI/authLogout).
//
// ESCOPO DESTA FATIA: logo, dropdown de conta (role/authMethod, "User
// account"/"User preferences", Log out) e o botão de engrenagem que abre
// o modal de Configurações. Os dropdowns "Links" (.hdr-tools-group,
// favoritos pessoais — js/links.js) e "Tools"/IP Calc (js/ipcalc.js +
// js/net-utils.js, ~720 linhas de lógica própria) ficam de fora por ora —
// deferidos pra fatia 6, junto com o resto do domínio de
// Links/compartilhamento/grupos, pra não misturar duas fatias numa só.
// goHome() (clique no logo) também é no-op por enquanto — só volta a
// fazer sentido quando existir uma tela de comandos/Folders pra "voltar"
// (fatia 3/5).
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { useAuth, authMethodLabel } from '../lib/auth';
import { useLogo } from '../lib/useLogo';

export function Header({ onOpenSettings }: { onOpenSettings: (pane: 'account' | 'prefs') => void }) {
  const auth = useAuth();
  const logo = useLogo();
  const [open, setOpen] = useState(false);
  const ddRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      if (ddRef.current && !ddRef.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  const roleLine = auth.me
    ? `${auth.roleLabel} — signed in via ${authMethodLabel(auth.authMethod)}`
    : auth.authError
    ? 'Could not verify your account — reload the page to try again.'
    : '';

  return (
    <header className="hdr">
      <div className="hdr-logo" title="Go to home page">
        <img className="hdr-logo-img for-dark" src={logo.dark || '/img/logo-toolbox45-white.png?v=2'} alt="Toolbox45" />
        <img className="hdr-logo-img for-light" src={logo.light || '/img/logo-toolbox45.png?v=2'} alt="Toolbox45" />
      </div>
      <div className="hdr-gap"></div>
      <div className={`dd hdr-user-dd${open ? ' open' : ''}`} ref={ddRef}>
        <button type="button" className="hdr-user" onClick={() => setOpen(o => !o)} title="Account">
          <svg className="hdr-user-ico" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 18.5a6 6 0 0 1 11 0" /></svg>
          <span>{auth.me?.handle || auth.me?.upn || ''}</span>
        </button>
        {open && (
          <div className="dd-panel" style={{ left: 'auto', right: 0, minWidth: 220 }}>
            <div className="set-hint" style={{ padding: '4px 8px 8px' }}>{roleLine}</div>
            <div className="sb-row" onClick={() => { setOpen(false); onOpenSettings('account'); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 18.5a6 6 0 0 1 11 0" /></svg>
              <span>User account</span>
            </div>
            <div className="sb-row" onClick={() => { setOpen(false); onOpenSettings('prefs'); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8" /></svg>
              <span>User preferences</span>
            </div>
            <button type="button" className="sb-row hdr-user-logout" onClick={() => auth.logout()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
              <span>Log out</span>
            </button>
          </div>
        )}
      </div>
      {/* Escopo "system" (abas Register/System/Database/Users) ainda não
          existe nesta fatia — abre em 'prefs' como estado provisório,
          até a aba Database (fatia 9) dar um destino melhor a este botão. */}
      <button
        className="theme-toggle"
        onClick={() => onOpenSettings('prefs')}
        title="Settings"
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8a4 4 0 100 8 4 4 0 000-8z" /><path d="M19.4 13a7.97 7.97 0 000-2l2.1-1.6-2-3.4-2.5 1a8.1 8.1 0 00-1.7-1L14.9 3h-4l-.4 2.9a8.1 8.1 0 00-1.7 1l-2.5-1-2 3.4L6.6 11a7.97 7.97 0 000 2l-2.1 1.6 2 3.4 2.5-1c.5.4 1.1.8 1.7 1l.4 2.9h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.4L19.4 13z" /></svg>
      </button>
    </header>
  );
}
