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
// "Add": dropdown "Command" / "Folder" (mesmo do original, #addDD em
// index.html). "Folder" cria uma pasta de topo vazia (promptCreateFolder()
// em js/folders.js). Auditoria visual pós-corte: o botão tinha ficado só
// "+ Add command" porque o dropdown foi adiado na fatia 4 e nunca revisitado.
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
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
  onAddFolder,
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
  onAddFolder: () => void;
  // Fatia 5b — ver comentário do arquivo acima.
  foldersActive: boolean;
  folderScope: FolderScope;
  onChangeFolderScope: (scope: FolderScope) => void;
  allUsersFolders: FolderWithOwner[] | null;
  currentUsername: string | undefined;
  onOpenFolderScope: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addOpen) return;
    function onDown(ev: MouseEvent) {
      if (addRef.current && !addRef.current.contains(ev.target as Node)) setAddOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setAddOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);
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
      {/* .ctb-cmd-actions/.ctb-cmd-btn.admin-highlight (layout.css) + painel
          #addDDPanel (o CSS do painel é por #id — o id é obrigatório). */}
      <div className="ctb-cmd-actions" id="cmdActionsBlock">
        <div className={`dd${addOpen ? ' open' : ''}`} id="addDD" ref={addRef}>
          <button type="button" className="btn ctb-cmd-btn admin-highlight" id="addDDBtn" onClick={() => setAddOpen(o => !o)}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <span>Add</span>
            <span className="dd-arrow">▾</span>
          </button>
          {addOpen && (
            <div className="dd-panel" id="addDDPanel">
              <div className="sb-row" onClick={() => { setAddOpen(false); onAddCommand(); }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}><path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                <span>Command</span>
              </div>
              <div className="sb-row" onClick={() => { setAddOpen(false); onAddFolder(); }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.2h8.5A1.5 1.5 0 0 1 21 8.7v9.8A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-12z" /></svg>
                <span>Folder</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
