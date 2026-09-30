// ════════════════════════════════════════════════
// Aba "Database" do modal de Configurações — fatia 5c — porta de
// .settings-pane[data-pane="database"] (index.html), MAS só o grupo
// "Folders" (Export/Import de pasta). Deliberadamente FORA do escopo desta
// fatia: o grupo "Commands" (Export/Import CSV do catálogo inteiro — uma
// feature diferente, sem fatia própria ainda) e o grupo "Database"
// (Backup & Restore/View audit log, admin-only — fatia 9 do roadmap). Ver
// instruções da tarefa.
//
// Sem gate de admin (mesmo critério do original pro grupo "Folders" —
// pastas são dados privados de cada usuário, diferente de um backup do
// banco inteiro).
// ════════════════════════════════════════════════
import { useState } from 'react';
import { FolderExportModal } from '../commands/FolderExportModal';
import { FolderImportModal } from '../commands/FolderImportModal';

export function DatabasePane() {
  const [modal, setModal] = useState<'export' | 'import' | null>(null);

  return (
    <>
      <div className="set-group">
        <span className="set-label">Folders</span>
        <div className="settings-action-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setModal('export')}
            title="Exports one folder — including all its subfolders, commands and notes — as a .json file."
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v7.5M4.5 6.5L8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Export folder</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setModal('import')}
            title="Recreates a folder (with subfolders, commands and notes) from a .json file exported here."
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 10.5V3M4.5 6.5L8 3l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Import folder</span>
          </button>
        </div>
      </div>
      {modal === 'export' && <FolderExportModal onClose={() => setModal(null)} />}
      {modal === 'import' && <FolderImportModal onClose={() => setModal(null)} />}
    </>
  );
}
