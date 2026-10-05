// ════════════════════════════════════════════════
// Casca do modal de Configurações — porta de index.html (#settingsOverlay)
// + js/settings-modal.js (openSettingsModal/closeSettingsModal/
// switchSettingsPane/_settingsApplyScope).
//
// Fatia 5c acrescentou a aba "Database" (inicialmente só o grupo "Folders" —
// Export/Import de pasta); a fatia 9 completou a aba com os grupos "Commands"
// (Export/Import CSV do catálogo) e "Database" (Backup & Restore + audit log,
// admin-only) — ver DatabasePane.tsx. Por isso o conceito de
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
//
// Fatia 7 acrescentou "Users" (CRUD de usuários + promover/rebaixar/
// desabilitar, ver UsersPane.tsx) — super_admin-only, MESMO gate/padrão de
// "Groups" acima — e "Register" (catálogo compartilhado: Vendors/Systems/
// Versions/Environments/Topics/Parameters/Prompts/Exports, ver
// CatalogPane.tsx) — admin-rank (admin OU super_admin, `auth.isAdmin` já
// cobre os dois), mesmo defense-in-depth duplo (gate no filtro de NAV_ITEMS
// E gate de novo na renderização do pane, ver `pane === 'catalog' &&
// auth.isAdmin` abaixo).
// ════════════════════════════════════════════════
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { useSettings } from '../lib/settingsStore';
import type { Catalogs } from '../lib/catalogs';
import { AccountPane } from './panes/AccountPane';
import { CatalogPane } from './panes/CatalogPane';
import { DatabasePane } from './panes/DatabasePane';
import { GroupsPane } from './panes/GroupsPane';
import { PreferencesPane } from './panes/PreferencesPane';
import { SystemPane } from './panes/SystemPane';
import { UsersPane } from './panes/UsersPane';

export type SettingsPane = 'account' | 'prefs' | 'database' | 'groups' | 'users' | 'catalog' | 'system';

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

// Mesmo ícone de #usersNavBtn no original — só incluído quando
// auth.isSuperAdmin (mesmo gate de GROUPS_NAV_ITEM acima).
const USERS_NAV_ITEM: NavItem = {
  pane: 'users',
  label: 'Users',
  icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="7" r="3.2" /><path d="M2.5 19c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M17 4.5v5M14.3 7h5.4" /></svg>
  ),
};

// Mesmo ícone de 3 linhas horizontais de #registerNavBtn no original — só
// incluído quando auth.isAdmin (admin OU super_admin).
const CATALOG_NAV_ITEM: NavItem = {
  pane: 'catalog',
  label: 'Register',
  icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg>
  ),
};

// Fatia 8 — mesma engrenagem usada no título deste próprio modal (acima),
// aqui em miniatura (14×14, mesmo padrão dos outros itens de nav). SEMPRE
// visível (nunca gated) — ver SystemPane.tsx: os 5 widgets de dentro é que
// são individualmente gated por admin/super_admin, não o item de nav em si
// (mesmo comportamento do botão `data-pane="system"` no index.html
// original, que nunca tinha nenhum atributo de gate).
const SYSTEM_NAV_ITEM: NavItem = {
  pane: 'system',
  label: 'System',
  icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8a4 4 0 100 8 4 4 0 000-8z" /><path d="M19.4 13a7.97 7.97 0 000-2l2.1-1.6-2-3.4-2.5 1a8.1 8.1 0 00-1.7-1L14.9 3h-4l-.4 2.9a8.1 8.1 0 00-1.7 1l-2.5-1-2 3.4L6.6 11a7.97 7.97 0 000 2l-2.1 1.6 2 3.4 2.5-1c.5.4 1.1.8 1.7 1l.4 2.9h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.4L19.4 13z" /></svg>
  ),
};

export function SettingsModal({
  pane,
  onChangePane,
  onClose,
  catalogs,
  onCatalogsChanged,
  settings,
  updateSettings,
  onLogoChanged,
  theme,
  accent,
  toggleTheme,
  setAccent,
}: {
  pane: SettingsPane;
  onChangePane: (pane: SettingsPane) => void;
  onClose: () => void;
  catalogs: Catalogs | null;
  onCatalogsChanged: () => void;
  settings: ReturnType<typeof useSettings>['settings'];
  updateSettings: ReturnType<typeof useSettings>['update'];
  // Fatia 8 — repassado até SystemPane -> LogoSettingsModal; ver
  // AppShell.tsx/Header.tsx (mesmo `logo` useLogo() elevado, compartilhado
  // entre os dois).
  onLogoChanged: () => Promise<void>;
  // Fatia 8 — usePersonalTheme() elevado pra AppShell.tsx e repassado até
  // PreferencesPane (ver comentário completo lá) — pelo mesmo motivo de
  // `logo`/`onLogoChanged` acima: o listener de 'storage' do user-data sync
  // só funciona enquanto o hook está montado, e PreferencesPane só monta
  // quando esta aba está aberta.
  theme: 'light' | 'dark';
  accent: string;
  toggleTheme: () => void;
  setAccent: (key: string) => void;
}) {
  const auth = useAuth();
  // Mesma ordem do original (index.html): account, prefs, database, groups,
  // register(catalog), system, users.
  let navItems = NAV_ITEMS;
  if (auth.isSuperAdmin) navItems = [...navItems, GROUPS_NAV_ITEM];
  if (auth.isAdmin) navItems = [...navItems, CATALOG_NAV_ITEM];
  navItems = [...navItems, SYSTEM_NAV_ITEM];
  if (auth.isSuperAdmin) navItems = [...navItems, USERS_NAV_ITEM];

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
            {/* "Database" (fatia 5c), "Groups"/"Users" (fatia 6/7),
                "Register" (fatia 7) e "System" (fatia 8) já estão prontas —
                "Groups"/"Users" gated por auth.isSuperAdmin, "Register" por
                auth.isAdmin (admin OU super_admin — pedido do usuário: "o
                perfil User não poderá acessar cadastro de registros"),
                ambos fail-closed (nada é montado enquanto /api/me não
                confirmar); "Database" sem gate de admin (mesmo critério do
                original pro grupo "Folders"); "System" sem gate no item de
                nav em si (ver SYSTEM_NAV_ITEM acima) — só os widgets
                internos de SystemPane.tsx são gated. "Audit log",
                "backup/restore" e "import/export de comandos" moram na aba
                "Database" (DatabasePane.tsx, fatia 9) — não nesta. */}
          </nav>
          <div className="settings-content">
            {pane === 'account' && <AccountPane />}
            {pane === 'prefs' && (
              <PreferencesPane
                catalogs={catalogs}
                settings={settings}
                update={updateSettings}
                theme={theme}
                accent={accent}
                toggleTheme={toggleTheme}
                setAccent={setAccent}
              />
            )}
            {pane === 'database' && <DatabasePane onCatalogsChanged={onCatalogsChanged} />}
            {pane === 'groups' && auth.isSuperAdmin && <GroupsPane />}
            {pane === 'users' && auth.isSuperAdmin && <UsersPane />}
            {pane === 'catalog' && auth.isAdmin && catalogs && <CatalogPane catalogs={catalogs} onCatalogsChanged={onCatalogsChanged} />}
            {/* Sem gate aqui (mesmo critério do nav item acima) — a aba em
                si é sempre montada; cada um dos 5 widgets dentro de
                SystemPane decide por si (auth.isAdmin/auth.isSuperAdmin)
                se renderiza ou não. */}
            {pane === 'system' && <SystemPane onLogoChanged={onLogoChanged} />}
          </div>
        </div>
      </div>
    </div>
  );
}
