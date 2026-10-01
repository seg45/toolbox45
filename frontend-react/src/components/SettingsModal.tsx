// ════════════════════════════════════════════════
// Casca do modal de Configurações — porta de index.html (#settingsOverlay)
// + js/settings-modal.js (openSettingsModal/closeSettingsModal/
// switchSettingsPane/_settingsApplyScope).
//
// Fatia 5c acrescentou a aba "Database" (só o grupo "Folders" — Export/
// Import de pasta, ver DatabasePane.tsx). "Commands" (CSV do catálogo
// inteiro) e "Database"/Backup & Restore (admin-only) do original ficam de
// fora por ora (fatias/features próprias, ainda sem escopo definido) — só
// esse grupo específico, sem gate de admin (mesmo critério do original:
// pastas são dados privados de cada usuário). As demais abas admin-rank
// (Register/System/Users) continuam fora do escopo. Por isso o conceito de
// "escopo" do original (título/nav mudam conforme abriu pelo menu de conta
// ou pela engrenagem) ainda não se aplica de verdade: o título fica sempre
// "Account settings" por ora.
//
// Fatia 6 acrescentou "Groups" (CRUD de grupos, ver GroupsPane.tsx) —
// super_admin-only, fail-closed: o item só é incluído em NAV_ITEMS quando
// auth.isSuperAdmin é true (que começa `false` até /api/me confirmar, ver
// comentário em lib/auth.tsx), então nada do item OU do pane é montado
// durante esse intervalo — mesma garantia dos demais gates admin-rank do
// app, sem precisar de um array próprio de IDs (SUPER_ADMIN_ONLY_SETTINGS_
// GROUP_IDS do original) já que aqui é só filtrar NAV_ITEMS antes de
// renderizar.
// ════════════════════════════════════════════════
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { useSettings } from '../lib/settingsStore';
import type { Catalogs } from '../lib/catalogs';
import { AccountPane } from './panes/AccountPane';
import { DatabasePane } from './panes/DatabasePane';
import { GroupsPane } from './panes/GroupsPane';
import { PreferencesPane } from './panes/PreferencesPane';

export type SettingsPane = 'account' | 'prefs' | 'database' | 'groups';

interface NavItem {
  pane: SettingsPane;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    pane: 'account',
    label: 'User account',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 18.5a6 6 0 0 1 11 0" /></svg>
    ),
  },
  {
    pane: 'prefs',
    label: 'User preferences',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8" /></svg>
    ),
  },
  // Mesmo path/ícone (cilindro) de #sysGroupDatabase's nav button em
  // index.html — só o grupo "Folders" mora aqui (ver DatabasePane.tsx).
  {
    pane: 'database',
    label: 'Database',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></svg>
    ),
  },
];

// Mesmo ícone de duas pessoas de #groupsNavBtn no original — só incluído
// quando auth.isSuperAdmin (ver GROUPS_NAV_ITEM/uso em NAV_ITEMS abaixo).
const GROUPS_NAV_ITEM: NavItem = {
  pane: 'groups',
  label: 'Groups',
  icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" /><path d="M2 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><path d="M12 19c0-2.8 2.2-5.5 5-5.5 2.8 0 5 2.7 5 5.5" /></svg>
  ),
};

export function SettingsModal({
  pane,
  onChangePane,
  onClose,
  catalogs,
  settings,
  updateSettings,
}: {
  pane: SettingsPane;
  onChangePane: (pane: SettingsPane) => void;
  onClose: () => void;
  catalogs: Catalogs | null;
  settings: ReturnType<typeof useSettings>['settings'];
  updateSettings: ReturnType<typeof useSettings>['update'];
}) {
  const auth = useAuth();
  const navItems = auth.isSuperAdmin ? [...NAV_ITEMS, GROUPS_NAV_ITEM] : NAV_ITEMS;

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box settings-modal-box">
        <div className="modal-head">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8a4 4 0 100 8 4 4 0 000-8z" /><path d="M19.4 13a7.97 7.97 0 000-2l2.1-1.6-2-3.4-2.5 1a8.1 8.1 0 00-1.7-1L14.9 3h-4l-.4 2.9a8.1 8.1 0 00-1.7 1l-2.5-1-2 3.4L6.6 11a7.97 7.97 0 000 2l-2.1 1.6 2 3.4 2.5-1c.5.4 1.1.8 1.7 1l.4 2.9h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.4L19.4 13z" /></svg>
            <span>Account settings</span>
          </span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav">
            {navItems.map(item => (
              <button
                key={item.pane}
                type="button"
                className={`settings-nav-btn${pane === item.pane ? ' on' : ''}`}
                onClick={() => onChangePane(item.pane)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
            {/* Register/System/Users (admin-rank) seguem fora do escopo
                portado até agora. "Database" (fatia 5c) e "Groups" (fatia
                6) já estão prontas — "Groups" gated por auth.isSuperAdmin
                acima (fail-closed: nada é montado enquanto /api/me não
                confirmar), "Database" sem gate de admin (mesmo critério do
                original pro grupo "Folders"). */}
          </nav>
          <div className="settings-content">
            {pane === 'account' && <AccountPane />}
            {pane === 'prefs' && <PreferencesPane catalogs={catalogs} settings={settings} update={updateSettings} />}
            {pane === 'database' && <DatabasePane />}
            {pane === 'groups' && auth.isSuperAdmin && <GroupsPane />}
          </div>
        </div>
      </div>
    </div>
  );
}
