// ════════════════════════════════════════════════
// Sidebar (nav.sidebar) — porta de index.html linhas 197-409 + js/state.js
// (mecânica genérica de dropdown/multi-select) + js/settings.js (toggles).
//
// Busca + os 5 dropdowns de filtro (Vendor/System/Version/Environment/
// Topic) são ligados a useLiveFilters() (liveFilters.ts, fatia 3a) — o
// filtro AO VIVO que persiste em 'cpa-sidebar-filters', separado do default
// de Preferences (useSettings()/'cpa-settings') — ver comentário completo em
// liveFilters.ts. Isso substitui a ligação (incorreta, ver instruções da
// fatia 3a) direto em useSettings() que a fatia 2 usava provisoriamente.
//
// A linha "Folders" (fatia 5a) agora liga de verdade em useFoldersView()
// (src/lib/foldersView.ts — porta de viewAllFolders()/VIEW_FOLDERS_HOME em
// js/folders.js): clicar nela funciona como um toggle (liga/desliga a
// visão de Pastas em CommandsContent.tsx), com a classe "on" refletindo o
// estado ativo (mesmo tratamento visual de .dd-btn.filter-active). O
// bloco "Options" com os 4 toggles e o botão de fixar/colapsar a sidebar
// continuam ligados a useSettings() exatamente como antes.
// ════════════════════════════════════════════════
import type { Catalogs } from '../lib/catalogs';
import type { useFoldersView } from '../lib/foldersView';
import type { useLiveFilters } from '../lib/liveFilters';
import type { Settings } from '../lib/settingsStore';
import { CmdSearchBox } from './CmdSearchBox';
import { FilterDropdown } from './FilterDropdown';
import { Toggle } from './SegControls';

const ICONS = {
  vendor: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="2" width="10" height="20" rx="1" /><line x1="10" y1="6" x2="10" y2="6.01" /><line x1="14" y1="6" x2="14" y2="6.01" /><line x1="10" y1="10" x2="10" y2="10.01" /><line x1="14" y1="10" x2="14" y2="10.01" /><line x1="10" y1="14" x2="10" y2="14.01" /><line x1="14" y1="14" x2="14" y2="14.01" /></svg>
  ),
  system: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><line x1="7" y1="7" x2="7.01" y2="7" /><line x1="7" y1="17" x2="7.01" y2="17" /></svg>
  ),
  version: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.3" /><circle cx="6" cy="18" r="2.3" /><circle cx="18" cy="6" r="2.3" /><path d="M6 8.3v7.4" /><path d="M8.3 6h3.7a4 4 0 0 1 4 4v0" /></svg>
  ),
  environment: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
  ),
  topic: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
  ),
  options: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2" /><line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2" /><line x1="4" y1="18" x2="20" y2="18" /><circle cx="9" cy="18" r="2" /></svg>
  ),
  folders: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.2h8.5A1.5 1.5 0 0 1 21 8.7v9.8A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-12z" /></svg>
  ),
};

export function Sidebar({
  catalogs,
  settings,
  update,
  liveFilters,
  foldersView,
  onToggleCollapsed,
}: {
  catalogs: Catalogs | null;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  liveFilters: ReturnType<typeof useLiveFilters>;
  foldersView: ReturnType<typeof useFoldersView>;
  onToggleCollapsed: () => void;
}) {
  const { filters, update: updateFilters } = liveFilters;

  const vendorOptions = (catalogs?.vendors || []).map(v => ({ key: v.key, label: v.label, color: v.color }));
  const sysOptions = (catalogs?.systems || []).map(v => ({ key: v.key, label: v.label, color: v.color }));
  const versionOptions = (catalogs?.versions || []).map(v => ({ key: v.key, label: v.label, color: v.color }));
  const envOptions = (catalogs?.environments || []).map(v => ({ key: v.key, label: v.label, color: v.color }));
  const topicOptions = (catalogs?.topics || [])
    .filter(t => !t.is_protected)
    .map(v => ({ key: v.key, label: v.label, color: v.color }));

  return (
    <nav className="sidebar">
      <div className="sidebar-inner">
        <CmdSearchBox search={filters.search} onSearchChange={v => updateFilters({ search: v })} />

        <div className="sb-block">
          <div className="sb-list">
            <div
              className={`sb-row folders-head-row${foldersView.active ? ' on' : ''}`}
              onClick={foldersView.toggle}
            >
              {ICONS.folders}
              <span>Folders</span>
            </div>
          </div>
        </div>

        <FilterDropdown icon={ICONS.vendor} headingLabel="Vendor" options={vendorOptions} selected={filters.vendor} onChange={v => updateFilters({ vendor: v })} />
        <FilterDropdown icon={ICONS.system} headingLabel="System" options={sysOptions} selected={filters.system} onChange={v => updateFilters({ system: v })} />
        <FilterDropdown icon={ICONS.version} headingLabel="Version" options={versionOptions} selected={filters.version} onChange={v => updateFilters({ version: v })} />
        <FilterDropdown icon={ICONS.environment} headingLabel="Environment" options={envOptions} selected={filters.environment} onChange={v => updateFilters({ environment: v })} />
        <FilterDropdown icon={ICONS.topic} headingLabel="Topic" options={topicOptions} selected={filters.topic} onChange={v => updateFilters({ topic: v })} />

        <div className="sb-block sb-block-filter sb-block-clearfilters">
          <button
            type="button"
            className="btn btn-ghost sb-clear-filters-btn"
            style={{ width: '100%', fontSize: 11 }}
            onClick={() => updateFilters({ vendor: [], system: [], version: [], environment: [], topic: [] })}
          >
            Clear filters
          </button>
        </div>

        <div className="sb-block sb-block-filter">
          <div className="sb-head"><span className="sb-head-icon">{ICONS.options}</span><span className="sb-head-txt">Options</span></div>
          <Toggle label="Details" on={settings.showCardDetails} onClick={() => update({ showCardDetails: !settings.showCardDetails })} />
          <Toggle label="Export" on={settings.exportEnabled} onClick={() => update({ exportEnabled: !settings.exportEnabled })} />
          <Toggle label="Images" on={settings.showImages} onClick={() => update({ showImages: !settings.showImages })} />
          <Toggle label="System commands" on={settings.showSystemCommands} onClick={() => update({ showSystemCommands: !settings.showSystemCommands })} />
        </div>

        <a className="sb-credit" href="https://seg45.com.br" target="_blank" rel="noopener noreferrer">
          <span className="sb-credit-txt">Developed by SEG45</span>
        </a>
      </div>

      <button type="button" className="sb-divider-toggle" onClick={onToggleCollapsed} title="Pin/unpin sidebar">
        <svg className="icon-collapse" width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10.5 2l-6 6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M14.5 2l-6 6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <svg className="icon-expand" width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1.5 2l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M5.5 2l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </nav>
  );
}
