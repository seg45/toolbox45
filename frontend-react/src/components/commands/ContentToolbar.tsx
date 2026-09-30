// ════════════════════════════════════════════════
// Barra "Group by / Expand all / Collapse all" acima da lista de comandos —
// porta do `.content-toolbar` em index.html (dropdown "Group by" + os dois
// icon-btn) + expandAllSections()/collapseAllSections() em
// js/terminal-renderer.js (a lógica de fato mora em collapsedSections.ts;
// este componente só dispara os callbacks).
//
// Reaproveita SegSingle (SegControls.tsx) pro dropdown "Group by", mesmo
// componente já usado no espelho de Preferences (PreferencesPane.tsx).
//
// Fatia 5b: dentro da visão "Folders" (`foldersActive`), o dropdown "Group
// by" dá lugar por inteiro ao seletor de ESCOPO de pastas
// (FolderScopeDropdown — My folders/usuário escolhido/All) — mesma
// exclusividade mútua de #groupByDD/#folderScopeDD no original
// (updateGroupByOptionsForFoldersScope(), js/folders.js), só que aqui
// decidida com um `foldersActive ? A : B` em vez de alternar
// `style.display` nos dois elementos sempre montados. O rótulo
// compartilhado (`.ctb-label`) troca de texto junto: "Group by" fora de
// Folders, "Filter by" dentro (mesmo texto do original — ali o dropdown
// não agrupa nada, só filtra de quem são as pastas exibidas).
//
// "Add" (fatia 4): só "Add command" por enquanto — sem dropdown, já que
// "Add folder" (fatia 5, Pastas) ainda não existe; quando essa fatia
// chegar, este botão simples vira um dropdown (mesmo padrão de escopo
// adiado já usado em Header.tsx para os dropdowns Links/Tools).
// ════════════════════════════════════════════════
import type { FolderScope } from '../../lib/folderScope';
import type { FolderWithOwner } from '../../lib/folders';
import type { Settings } from '../../lib/settingsStore';
import { SegSingle } from '../SegControls';
import { FolderScopeDropdown } from './FolderScopeDropdown';

const GROUP_BY_OPTIONS = [
  { val: 'creator', label: 'Created by' },
  { val: 'topic', label: 'Topic' },
  { val: 'version', label: 'Version' },
];

export function ContentToolbar({
  groupBy,
  onChangeGroupBy,
  onExpandAll,
  onCollapseAll,
  onAddCommand,
  foldersActive,
  folderScope,
  onChangeFolderScope,
  allUsersFolders,
  currentUsername,
  onOpenFolderScope,
}: {
  groupBy: Settings['groupBy'];
  onChangeGroupBy: (v: Settings['groupBy']) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onAddCommand: () => void;
  // Fatia 5b — ver comentário do arquivo acima.
  foldersActive: boolean;
  folderScope: FolderScope;
  onChangeFolderScope: (scope: FolderScope) => void;
  allUsersFolders: FolderWithOwner[] | null;
  currentUsername: string | undefined;
  onOpenFolderScope: () => void;
}) {
  return (
    <div className="content-toolbar">
      <span className="ctb-label">{foldersActive ? 'Filter by' : 'Group by'}</span>
      {foldersActive ? (
        <FolderScopeDropdown
          scope={folderScope}
          onChange={onChangeFolderScope}
          allUsersFolders={allUsersFolders}
          currentUsername={currentUsername}
          onOpen={onOpenFolderScope}
        />
      ) : (
        <div className="ctb-groupby-dd">
          <SegSingle label="Group by" options={GROUP_BY_OPTIONS} value={groupBy} onChange={v => onChangeGroupBy(v as Settings['groupBy'])} />
        </div>
      )}
      <button type="button" className="icon-btn" title="Expand all" onClick={onExpandAll}>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path d="M2 5.5l6 5 6-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 1.5l6 5 6-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button type="button" className="icon-btn" title="Collapse all" onClick={onCollapseAll}>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path d="M2 10.5l6-5 6 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 14.5l6-5 6 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* .ctb-cmd-actions/.ctb-cmd-btn.admin-highlight já existiam prontos em
          css/layout.css (pill sólido na cor de destaque) — CSS deixado
          preparado desde antes desta fatia para este exato botão. Vira um
          dropdown "Add" (Add command / Add folder, ver #addDDPanel já
          estilizado em layout.css) quando a fatia 5 (Pastas) chegar; por
          ora, um botão simples — só "Add command" está no escopo. */}
      <div className="ctb-cmd-actions">
        <button type="button" className="btn ctb-cmd-btn admin-highlight" onClick={onAddCommand}>
          + Add command
        </button>
      </div>
    </div>
  );
}
