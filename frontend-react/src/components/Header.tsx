// ════════════════════════════════════════════════
// Cabeçalho (.hdr) — porta de index.html linhas 38-197 + js/auth.js
// (updateAccountUI/authLogout).
//
// Fatia 6 acrescentou os dropdowns "Links" (.hdr-tools-group, favoritos
// pessoais — js/links.js) e "Tools" (IP Calc, js/ipcalc.js +
// js/net-utils.js) — porte de toggleDropdown/closeAllDropdowns
// (js/state.js) como um único estado local `openDropdown` (só um dos dois
// — ou nenhum — fica aberto por vez), mais um único listener de
// clique-fora envolvendo o WRAPPER .hdr-tools-group inteiro (mesmo padrão
// `ddRef`/useEffect que o dropdown de conta logo abaixo já usa, com seu
// próprio estado independente). "Links" só carrega a lista na primeira vez
// que abre (loadLinksIfNeeded() — flag em useRef, não re-busca a cada
// abre/fecha). Os modais LinkEditorModal/IpCalcModal são montados aqui
// como filhos locais do Header (mesmo princípio de DatabasePane.tsx com
// FolderExportModal/FolderImportModal — o portal pro document.body mora
// dentro de cada modal, não aqui).
//
// goHome() (clique no logo) continua no-op — só volta a fazer sentido
// quando existir uma tela de comandos/Folders pra "voltar" (fatia 3/5).
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { useAuth, authMethodLabel } from '../lib/auth';
import type { LogoSrcs } from '../lib/useLogo';
import { useConfirm } from '../lib/useConfirm';
import { ApiError } from '../lib/api';
import { deleteLink, listLinks, type Link } from '../lib/links';
import { LinkEditorModal } from './LinkEditorModal';
import { IpCalcModal } from './IpCalcModal';

type LinkEditorState = { mode: 'create' } | { mode: 'edit'; link: Link } | null;

// `logo` sobe de AppShell.tsx (fatia 8) — antes era um useLogo() chamado
// aqui dentro, sem nenhum prop-drilling; agora precisa ser uma ÚNICA
// instância compartilhada com LogoSettingsModal (Settings → System → Logo),
// que fica numa ramificação irmã da árvore (dentro de SettingsModal) e
// precisa disparar `refresh` depois de salvar/resetar — mesmo caminho já
// usado por catalogs/onCatalogsChanged (ver AppShell.tsx).
export function Header({ onOpenSettings, logo }: { onOpenSettings: (pane: 'account' | 'prefs') => void; logo: LogoSrcs }) {
  const auth = useAuth();
  const confirm = useConfirm();
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

  // ── Links/Tools (.hdr-tools-group) ──────────────────────────────────
  const [openDropdown, setOpenDropdown] = useState<'links' | 'tools' | null>(null);
  const toolsGroupRef = useRef<HTMLDivElement>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [linksError, setLinksError] = useState('');
  const linksLoadedRef = useRef(false);
  const [linkEditor, setLinkEditor] = useState<LinkEditorState>(null);
  const [ipCalcOpen, setIpCalcOpen] = useState(false);

  useEffect(() => {
    if (!openDropdown) return;
    function onDocClick(ev: MouseEvent) {
      if (toolsGroupRef.current && !toolsGroupRef.current.contains(ev.target as Node)) setOpenDropdown(null);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [openDropdown]);

  async function loadLinksIfNeeded() {
    if (linksLoadedRef.current) return;
    // Marca ANTES de terminar — evita reentrada em cliques rápidos no
    // botão; em caso de erro, desmarca de novo pra tentar no próximo clique
    // (mesmo padrão de _lkLoaded em js/links.js).
    linksLoadedRef.current = true;
    setLinksError('');
    try {
      setLinks(await listLinks());
    } catch (e) {
      linksLoadedRef.current = false;
      setLinksError(e instanceof ApiError ? e.message : 'Failed to load links.');
    }
  }

  function toggleToolsDropdown(which: 'links' | 'tools') {
    setOpenDropdown(curr => (curr === which ? null : which));
    if (which === 'links') loadLinksIfNeeded();
  }

  function openLinkUrl(url: string) {
    setOpenDropdown(null);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function deleteLinkConfirm(link: Link) {
    const ok = await confirm(`Delete the link "${link.name}"?`, { danger: true });
    if (!ok) return;
    try {
      await deleteLink(link.id);
      setLinks(curr => curr.filter(l => l.id !== link.id));
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to delete link.');
    }
  }

  function handleLinkSaved(saved: Link) {
    setLinks(curr => {
      const idx = curr.findIndex(l => l.id === saved.id);
      if (idx >= 0) {
        const next = curr.slice();
        next[idx] = saved;
        return next;
      }
      return [...curr, saved];
    });
  }

  const roleLine = auth.me
    ? `${auth.roleLabel} — signed in via ${authMethodLabel(auth.authMethod)}`
    : auth.authError
    ? 'Could not verify your account — reload the page to try again.'
    : '';

  return (
    <>
    <header className="hdr">
      <div className="hdr-logo" title="Go to home page">
        <img className="hdr-logo-img for-dark" src={logo.dark || '/img/logo-toolbox45-white.png?v=2'} alt="Toolbox45" />
        <img className="hdr-logo-img for-light" src={logo.light || '/img/logo-toolbox45.png?v=2'} alt="Toolbox45" />
      </div>
      <div className="hdr-tools-group" ref={toolsGroupRef}>
        <div className={`dd${openDropdown === 'links' ? ' open' : ''}`}>
          <button
            type="button"
            className="ipc-header-btn"
            onClick={() => toggleToolsDropdown('links')}
            title="Links"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <span>Links</span>
          </button>
          {openDropdown === 'links' && (
            <div className="dd-panel" style={{ left: 0, right: 'auto', minWidth: 240, maxWidth: 320 }}>
              <div
                className="sb-row lk-add-row"
                onClick={() => {
                  setOpenDropdown(null);
                  setLinkEditor({ mode: 'create' });
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                  <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>Add link</span>
              </div>
              {links.map(link => (
                <div key={link.id} className="sb-row lk-row" onClick={() => openLinkUrl(link.url)} title={link.url}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  <span className="lk-row-name">{link.name}</span>
                  <span className="lk-row-actions">
                    <button
                      type="button"
                      className="sec-folder-btn"
                      title="Edit"
                      onClick={ev => {
                        ev.stopPropagation();
                        setOpenDropdown(null);
                        setLinkEditor({ mode: 'edit', link });
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="sec-folder-btn"
                      title="Delete"
                      onClick={ev => {
                        ev.stopPropagation();
                        deleteLinkConfirm(link);
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}
              {linksError ? (
                <div className="set-hint" style={{ padding: '6px 8px' }}>
                  {linksError}
                </div>
              ) : (
                links.length === 0 && (
                  <div className="set-hint" style={{ padding: '6px 8px 2px' }}>
                    No links yet.
                  </div>
                )
              )}
            </div>
          )}
        </div>
        <div className={`dd${openDropdown === 'tools' ? ' open' : ''}`}>
          <button
            type="button"
            className="ipc-header-btn"
            onClick={() => toggleToolsDropdown('tools')}
            title="Tools"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <span>Tools</span>
          </button>
          {openDropdown === 'tools' && (
            <div className="dd-panel" style={{ left: 0, right: 'auto', minWidth: 170 }}>
              <div
                className="sb-row"
                onClick={() => {
                  setOpenDropdown(null);
                  setIpCalcOpen(true);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <rect x="4" y="2" width="16" height="20" rx="2" />
                  <line x1="8" y1="6" x2="16" y2="6" />
                  <line x1="8" y1="10.5" x2="8" y2="10.5" />
                  <line x1="12" y1="10.5" x2="12" y2="10.5" />
                  <line x1="16" y1="10.5" x2="16" y2="10.5" />
                  <line x1="8" y1="14" x2="8" y2="14" />
                  <line x1="12" y1="14" x2="12" y2="14" />
                  <line x1="16" y1="14" x2="16" y2="14" />
                  <line x1="8" y1="17.5" x2="16" y2="17.5" />
                </svg>
                <span>IP Calc</span>
              </div>
            </div>
          )}
        </div>
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
    {linkEditor && (
      <LinkEditorModal
        link={linkEditor.mode === 'edit' ? linkEditor.link : null}
        onClose={() => setLinkEditor(null)}
        onSaved={handleLinkSaved}
      />
    )}
    {/* Sempre montado (não condicional) — ver comentário no topo de
        IpCalcModal.tsx: o estado dos campos precisa sobreviver a fechar/
        reabrir o modal, então só `open` alterna a classe "show". */}
    <IpCalcModal open={ipCalcOpen} onClose={() => setIpCalcOpen(false)} />
    </>
  );
}
