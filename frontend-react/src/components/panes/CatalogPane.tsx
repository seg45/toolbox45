// ════════════════════════════════════════════════
// Aba "Register" do modal de Configurações (admin-only — admin OU
// super_admin, ver auth.isAdmin/SettingsModal.tsx) — porta de
// .settings-pane[data-pane="catalog"] (index.html) — fatia 7. Grid de 2
// grupos de "tiles" (Vendors/Systems/Versions/Environments/Topics — têm
// hierarquia entre si — e Exports/Parameters/Prompts, em ordem alfabética),
// cada um abrindo CatalogAdminModal com o `kind` certo. Ícones SVG idênticos
// aos do original (ver onclick="openCatalogAdmin(kind)" em index.html).
// ════════════════════════════════════════════════
import { useState } from 'react';
import type { Catalogs } from '../../lib/catalogs';
import { CatalogAdminModal } from './CatalogAdminModal';
import type { CatalogKind } from '../../lib/catalogAdmin';

const TILE_ICONS: Record<CatalogKind, React.ReactNode> = {
  vendors: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21V7l7-4 7 4v14" />
      <path d="M10 21v-6h4v6" />
      <path d="M17 21V10l4 2v9" />
    </svg>
  ),
  systems: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
  versions: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  ),
  environments: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 4 5.6 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.6-4-9s1.5-6.5 4-9z" />
    </svg>
  ),
  topics: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.6 13.4L13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.3" />
    </svg>
  ),
  exports: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  ),
  parameters: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  prompts: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17l6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  ),
};

// Dois grupos visuais — o 1º com hierarquia entre si (Vendor -> System ->
// Version/Environment -> Topic), o 2º em ordem alfabética (Exports/
// Parameters/Prompts) — mesma ordem exata do original (index.html).
type CatalogItem = { kind: CatalogKind; label: string; desc: string };

// Descrições evitam repetir o nome dos outros catálogos (os testes localizam o
// item por texto).
const GROUP_1: CatalogItem[] = [
  { kind: 'vendors', label: 'Vendors', desc: 'Manufacturers of the equipment.' },
  { kind: 'systems', label: 'Systems', desc: 'Platform each manufacturer’s devices run.' },
  { kind: 'versions', label: 'Versions', desc: 'Releases of each platform.' },
  { kind: 'environments', label: 'Environments', desc: 'Deployment types per platform, such as firewall or management.' },
  { kind: 'topics', label: 'Topics', desc: 'Subjects used to group commands.' },
];
const GROUP_2: CatalogItem[] = [
  { kind: 'exports', label: 'Exports', desc: 'Output redirection appended to a command line.' },
  { kind: 'parameters', label: 'Parameters', desc: 'Placeholders a command asks for, like source or host.' },
  { kind: 'prompts', label: 'Prompts', desc: 'Shell prompt shown before each command.' },
];

export function CatalogPane({ catalogs, onCatalogsChanged }: { catalogs: Catalogs; onCatalogsChanged: () => void }) {
  const [openKind, setOpenKind] = useState<CatalogKind | null>(null);

  function renderGroup(title: string, hint: string, items: CatalogItem[]) {
    return (
      <section className="settings-catalog-group">
        <div className="settings-catalog-head">
          <h3 className="settings-catalog-title">{title}</h3>
          <p className="settings-catalog-hint">{hint}</p>
        </div>
        <div className="settings-catalog-list">
          {items.map(item => (
            <button key={item.kind} type="button" className="settings-tile" onClick={() => setOpenKind(item.kind)}>
              <span className="settings-tile-icon">{TILE_ICONS[item.kind]}</span>
              <span className="settings-tile-text">
                <span className="settings-tile-name">{item.label}</span>
                <span className="settings-tile-desc">{item.desc}</span>
              </span>
              <span className="settings-tile-count" title="Items in this catalog">{catalogs[item.kind]?.length ?? 0}</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <div className="settings-pane" data-pane="catalog">
      <span className="set-hint">Manage the shared catalogs used across the app. Changes apply to every user immediately.</span>
      <div className="settings-catalog-grid">
        {renderGroup('Hierarchy', 'Vendor → System → Version / Environment: each level depends on the one before it.', GROUP_1)}
        {renderGroup('Command building blocks', 'Lists offered while writing a command line.', GROUP_2)}
      </div>
      {openKind && <CatalogAdminModal kind={openKind} catalogs={catalogs} onClose={() => setOpenKind(null)} onCatalogsChanged={onCatalogsChanged} />}
    </div>
  );
}
