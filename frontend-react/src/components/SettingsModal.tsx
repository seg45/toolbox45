// ════════════════════════════════════════════════
// Casca do modal de Configurações — porta de index.html (#settingsOverlay)
// + js/settings-modal.js (openSettingsModal/closeSettingsModal/
// switchSettingsPane/_settingsApplyScope).
//
// Fatia 5c acrescentou a aba "Database" (inicialmente só o grupo "Folders" —
// Export/Import de pasta); a fatia 9 completou a aba com os grupos "Commands"
// (Export/Import CSV do catálogo) e "Database" (Backup & Restore + audit log,
// admin-only) — ver DatabasePane.tsx.
//
// ESCOPO (auditoria visual pós-corte — igual ao original, _settingsApplyScope()
// em js/settings-modal.js): o modal é um só, mas o que aparece depende de
// como foi aberto. Menu da conta (nome do usuário no header) => escopo
// "user": título "Account settings", nav só com User account/User
// preferences. Engrenagem => escopo "system": título "Settings", nav com
// Database/Groups/Register/System/Users (sujeitos aos gates de admin).
// O rodapé (Restore defaults / Cancel / Save) só tem botões na aba "User
// preferences"; nas demais fica vazio, como no original.
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
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { DEFAULT_SETTINGS, useSettings, type Settings } from '../lib/settingsStore';
import { DEFAULT_ACCENT } from '../lib/theme';
import type { LiveFilters } from '../lib/liveFilters';
import type { Catalogs } from '../lib/catalogs';
import type { LogoSrcs } from '../lib/useLogo';
import { AccountPane } from './panes/AccountPane';
import { CatalogPane } from './panes/CatalogPane';
import { DatabasePane } from './panes/DatabasePane';
import { GroupsPane } from './panes/GroupsPane';
import { PreferencesPane } from './panes/PreferencesPane';
import { SystemPane } from './panes/SystemPane';
import { UsersPane } from './panes/UsersPane';

// Rascunho de Home page + filtros PADRÃO da aba User preferences — só viram
// valor de verdade no Save (ver SettingsModal abaixo e PreferencesPane.tsx).
export type PrefsDraft = Pick<Settings, 'home' | 'vendor' | 'sys' | 'version' | 'env' | 'type'>;

const USER_SCOPE_PANES: SettingsPane[] = ['account', 'prefs'];

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

// Agrupamento do menu lateral (estilo "painel de administração": categorias com
// título + itens) e cabeçalho de página de cada aba (título + descrição curta).
// A ordem dentro de cada escopo é a de PANE_ORDER; os títulos de grupo só
// aparecem quando o grupo tem ao menos um item visível para o usuário.
const PANE_ORDER: SettingsPane[] = ['account', 'prefs', 'database', 'catalog', 'groups', 'users', 'system'];

const PANE_META: Record<SettingsPane, { group: string; title: string; desc: string }> = {
  account: { group: 'Account', title: 'User account', desc: 'Your sign-in details, password and who you share commands with.' },
  prefs: { group: 'Account', title: 'User preferences', desc: 'How Toolbox45 looks and which filters and view open by default for you.' },
  database: { group: 'Content', title: 'Database', desc: 'Import and export commands and folders, back up and restore the database, and review activity logs.' },
  catalog: { group: 'Content', title: 'Register', desc: 'Shared catalogs used across the app. Changes apply to every user immediately.' },
  groups: { group: 'Access control', title: 'Groups', desc: 'Let teams see each other\'s commands and folders without sharing one by one.' },
  users: { group: 'Access control', title: 'Users', desc: 'Create accounts, approve sign-ups and manage roles.' },
  system: { group: 'Platform', title: 'System', desc: 'Branding, appearance, certificates, sign-in providers and API access.' },
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
  logo,
  theme,
  accent,
  toggleTheme,
  setTheme,
  setAccent,
  updateLiveFilters,
  setFoldersView,
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
  // Mesmo logo do cabeçalho do app (inclusive o personalizado) — a tela cheia
  // cobre o Header, então o logo é repetido na barra superior, na mesma posição.
  logo: LogoSrcs;
  // Fatia 8 — usePersonalTheme() elevado pra AppShell.tsx e repassado até
  // PreferencesPane (ver comentário completo lá) — pelo mesmo motivo de
  // `logo`/`onLogoChanged` acima: o listener de 'storage' do user-data sync
  // só funciona enquanto o hook está montado, e PreferencesPane só monta
  // quando esta aba está aberta.
  theme: 'light' | 'dark';
  accent: string;
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setAccent: (key: string) => void;
  // Save aplica os filtros padrão também aos filtros AO VIVO da sidebar e a
  // "Home page" à visão atual (ST.vd... / VIEW_FOLDERS_HOME em
  // saveSettingsModal() no original).
  updateLiveFilters: (patch: Partial<LiveFilters>) => void;
  setFoldersView: (isFolders: boolean) => void;
}) {
  const auth = useAuth();
  const isUserScope = USER_SCOPE_PANES.includes(pane);

  // Rascunho montado quando o modal abre (o modal só existe enquanto está
  // aberto); sobrevive à troca de aba dentro do modal, como os controles
  // escondidos do original.
  const [draft, setDraft] = useState<PrefsDraft>(() => ({
    home: settings.home,
    vendor: settings.vendor,
    sys: settings.sys,
    version: settings.version,
    env: settings.env,
    type: settings.type,
  }));
  function onDraftChange(patch: Partial<PrefsDraft>) {
    setDraft(prev => ({ ...prev, ...patch }));
  }
  function save() {
    updateSettings({ ...draft });
    updateLiveFilters({
      vendor: draft.vendor,
      system: draft.sys,
      version: draft.version,
      environment: draft.env,
      topic: draft.type,
    });
    setFoldersView(draft.home === 'folders');
    onClose();
  }
  // Rascunho volta ao padrão (só vale se o usuário salvar); o que é
  // aplicado na hora (toggles, Group by, tema, cor) volta ao padrão agora —
  // restoreDefaultsModal() no original.
  function restoreDefaults() {
    setDraft({
      home: DEFAULT_SETTINGS.home,
      vendor: DEFAULT_SETTINGS.vendor,
      sys: DEFAULT_SETTINGS.sys,
      version: DEFAULT_SETTINGS.version,
      env: DEFAULT_SETTINGS.env,
      type: DEFAULT_SETTINGS.type,
    });
    updateSettings({
      showCardDetails: DEFAULT_SETTINGS.showCardDetails,
      exportEnabled: DEFAULT_SETTINGS.exportEnabled,
      showImages: DEFAULT_SETTINGS.showImages,
      showSidebar: DEFAULT_SETTINGS.showSidebar,
      showSystemCommands: DEFAULT_SETTINGS.showSystemCommands,
      groupBy: DEFAULT_SETTINGS.groupBy,
    });
    setTheme('light');
    setAccent(DEFAULT_ACCENT);
  }
  // Mesma ordem do original (index.html): account, prefs, database, groups,
  // register(catalog), system, users — filtrada pelo escopo do modal (ver
  // comentário no topo do arquivo).
  let navItems = NAV_ITEMS;
  if (auth.isSuperAdmin) navItems = [...navItems, GROUPS_NAV_ITEM];
  if (auth.isAdmin) navItems = [...navItems, CATALOG_NAV_ITEM];
  navItems = [...navItems, SYSTEM_NAV_ITEM];
  if (auth.isSuperAdmin) navItems = [...navItems, USERS_NAV_ITEM];
  navItems = navItems.filter(item => USER_SCOPE_PANES.includes(item.pane) === isUserScope);
  navItems = [...navItems].sort((a, b) => PANE_ORDER.indexOf(a.pane) - PANE_ORDER.indexOf(b.pane));
  const paneMeta = PANE_META[pane];
  const userName = auth.me?.username || '';

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
      id="settingsOverlay"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box settings-modal-box">
        <div className="modal-head">
          <div className="hdr-logo settings-topbar-logo" title="Back to the app" onClick={onClose}>
            <img className="hdr-logo-img for-dark" src={logo.dark || '/img/logo-toolbox45-white.png?v=2'} alt="Toolbox45" />
            <img className="hdr-logo-img for-light" src={logo.light || '/img/logo-toolbox45.png?v=2'} alt="Toolbox45" />
          </div>
          <button type="button" className="modal-close settings-back" onClick={onClose} title="Back to the app (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
            <span>Back</span>
          </button>
          <span className="modal-title settings-topbar-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8a4 4 0 100 8 4 4 0 000-8z" /><path d="M19.4 13a7.97 7.97 0 000-2l2.1-1.6-2-3.4-2.5 1a8.1 8.1 0 00-1.7-1L14.9 3h-4l-.4 2.9a8.1 8.1 0 00-1.7 1l-2.5-1-2 3.4L6.6 11a7.97 7.97 0 000 2l-2.1 1.6 2 3.4 2.5-1c.5.4 1.1.8 1.7 1l.4 2.9h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.4L19.4 13z" /></svg>
            <span id="settingsModalTitle">{isUserScope ? 'Account settings' : 'Settings'}</span>
          </span>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <div className="settings-nav-list">
              {navItems.map((item, i) => {
                const group = PANE_META[item.pane].group;
                const showGroup = i === 0 || PANE_META[navItems[i - 1].pane].group !== group;
                return (
                  <div key={item.pane} className="settings-nav-item-wrap">
                    {showGroup && <div className="settings-nav-group">{group}</div>}
                    <button
                      type="button"
                      className={`settings-nav-btn${pane === item.pane ? ' on' : ''}`}
                      aria-current={pane === item.pane ? 'page' : undefined}
                      onClick={() => onChangePane(item.pane)}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  </div>
                );
              })}
            </div>
            {userName && (
              <div className="settings-nav-user" title={userName}>
                <span className="settings-nav-avatar" aria-hidden="true">{userName.charAt(0).toUpperCase()}</span>
                <span className="settings-nav-user-text">
                  <span className="settings-nav-user-name">{userName}</span>
                  <span className="settings-nav-user-role">{auth.roleLabel}</span>
                </span>
              </div>
            )}
          </nav>
          <div className="settings-content">
            <div className="settings-content-inner">
            <header className="settings-page-head">
              <h2 className="settings-page-title">{paneMeta.title}</h2>
              <p className="settings-page-desc">{paneMeta.desc}</p>
            </header>
            {pane === 'account' && <AccountPane />}
            {pane === 'prefs' && (
              <PreferencesPane
                catalogs={catalogs}
                settings={settings}
                update={updateSettings}
                draft={draft}
                onDraftChange={onDraftChange}
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
        {/* Rodapé sempre presente (como no original); só a aba "User
            preferences" tem botões — nas demais fica vazio. */}
        {pane === 'prefs' && (
        <div className="modal-foot">
          <div style={{ display: 'flex', gap: 8 }} id="settingsFootLeft">
            {pane === 'prefs' && (
              <button type="button" className="btn btn-ghost" onClick={restoreDefaults}>
                Restore defaults
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {pane === 'prefs' && (
              <>
                <button type="button" className="btn" id="settingsCancelBtn" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" id="settingsSaveBtn" onClick={save}>
                  Save
                </button>
              </>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
