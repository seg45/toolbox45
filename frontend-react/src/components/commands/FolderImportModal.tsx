// ════════════════════════════════════════════════
// IMPORT FOLDER MODAL (Settings → Database → Folders → "Import folder") —
// fatia 5c — porta de #folderImportOverlay (index.html) +
// openFolderImportModal()/onFolderImportFileChosen()/confirmImportFolder()
// (js/folders.js). Mesmo padrão de portal auto-contido de
// FolderExportModal.tsx (ver comentário lá).
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invalidateCommandsCache } from '../../lib/commands';
import { buildFolderTree, fetchFolders, notifyFoldersChanged, type Folder } from '../../lib/folders';

interface FolderOption {
  id: number;
  label: string;
}

function folderTreeOptions(folders: Folder[]): FolderOption[] {
  const tree = buildFolderTree(folders);
  const out: FolderOption[] = [];
  function walk(list: Folder[], depth: number) {
    list.forEach(f => {
      const indent = '    '.repeat(depth) + (depth ? '↳ ' : '');
      out.push({ id: f.id, label: indent + f.name });
      walk(tree.childrenOf(f.id), depth + 1);
    });
  }
  walk(tree.roots, 0);
  return out;
}

interface ExportFolderNode {
  name: string;
  notes?: unknown[];
  commands?: unknown[];
  children?: { folder?: ExportFolderNode }[];
}

interface ParsedExport {
  type: string;
  root: ExportFolderNode;
}

// Porta 1:1 de _countFolderExportNode() (js/folders.js) — soma comandos/
// notes/subpastas de toda a árvore lida do arquivo, recursivamente.
function countExportNode(node: ExportFolderNode): { folders: number; commands: number; notes: number } {
  let folders = 1;
  let commands = (node.commands || []).length;
  let notes = (node.notes || []).length;
  (node.children || []).forEach(c => {
    if (!c || !c.folder) return;
    const sub = countExportNode(c.folder);
    folders += sub.folders;
    commands += sub.commands;
    notes += sub.notes;
  });
  return { folders, commands, notes };
}

function isValidExport(data: unknown): data is ParsedExport {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.type === 'toolbox45-folder-export' && !!d.root && typeof (d.root as Record<string, unknown>).name === 'string';
}

export function FolderImportModal({ onClose }: { onClose: () => void }) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [parsed, setParsed] = useState<ParsedExport | null>(null);
  const [preview, setPreview] = useState('');
  const [previewIsError, setPreviewIsError] = useState(false);
  const [parentId, setParentId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchFolders()
      .then(data => {
        if (!cancelled) setFolders(data);
      })
      .catch(() => {
        /* dropdown "Import into" só fica sem opções além de "Top level" — não impede o import em si */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const options = folders ? folderTreeOptions(folders) : [];

  // Lê e valida o arquivo assim que o <input type="file"> muda — porta de
  // onFolderImportFileChosen(): FileReader + JSON.parse, valida
  // `type === 'toolbox45-folder-export' && root && typeof root.name ===
  // 'string'`, e se válido calcula o resumo de contagem ANTES do usuário
  // clicar em "Import".
  function handleFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    setParsed(null);
    setPreview('');
    setPreviewIsError(false);
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(reader.result as string);
      } catch {
        data = null;
      }
      if (!isValidExport(data)) {
        setPreviewIsError(true);
        setPreview("This doesn't look like a folder export file (or it's from an incompatible version).");
        return;
      }
      setParsed(data);
      const counts = countExportNode(data.root);
      setPreviewIsError(false);
      setPreview(`"${data.root.name}" — ${counts.folders} folder(s), ${counts.commands} command(s), ${counts.notes} note(s).`);
    };
    reader.onerror = () => {
      setPreviewIsError(true);
      setPreview('Failed to read the file.');
    };
    reader.readAsText(file);
  }

  // Envia a árvore já lida/validada — porta de confirmImportFolder(): o
  // servidor recria tudo (pasta + subpastas + comandos + notes) como NOVO,
  // sempre pertencendo ao usuário atual, nunca sobrescrevendo nada.
  // invalidateCommandsCache() + notifyFoldersChanged() (em vez da chamada
  // direta reloadFoldersFromServer() do original — ver comentário em
  // src/lib/folders.ts sobre por que esse canal existe) garantem que os
  // comandos/pastas recém-criados apareçam em CommandsContent.tsx sem F5.
  async function handleImport() {
    if (!parsed) return;
    setBusy(true);
    try {
      const res = await fetch('/api/folders/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tree: parsed.root, parent_id: parentId === '' ? null : parentId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        window.alert(body.message || 'Failed to import the folder.');
        setBusy(false);
        return;
      }
      invalidateCommandsCache();
      notifyFoldersChanged();
      onClose();
      let msg = `Imported ${body.folders} folder(s), ${body.commands} command(s) and ${body.notes} note(s).`;
      if (body.commandsFailed) {
        msg += ` ${body.commandsFailed} command(s) failed to import — check that their Vendor/System/Version/Environment exist in this installation's catalog.`;
      }
      window.alert(msg);
    } catch {
      window.alert('Failed to import the folder. Please try again.');
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box">
        <div className="modal-head">
          <span className="modal-title">📥 Import folder</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">File</span>
            <span className="set-hint">
              A .json file created by "Export folder" (this or another Toolbox45 installation). The whole folder is recreated as new — it never
              overwrites anything you already have.
            </span>
            <input type="file" id="folderImportFile" accept="application/json,.json" onChange={handleFileChange} />
          </div>
          <div className="set-group">
            <span className="set-label">Import into</span>
            <span className="set-hint">Where the imported folder lands. If you already have a folder with the same name there, it's imported as "(copy)".</span>
            <select
              className="set-input"
              id="folderImportParentSelect"
              value={parentId}
              onChange={ev => setParentId(ev.target.value ? Number(ev.target.value) : '')}
            >
              <option value="">Top level</option>
              {options.map(o => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {preview && (
            <div className="set-hint" id="folderImportPreview" style={previewIsError ? { color: 'var(--red)' } : undefined}>
              {preview}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" id="folderImportConfirmBtn" disabled={!parsed || busy} onClick={handleImport}>
            Import
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
