// ════════════════════════════════════════════════
// EXPORT FOLDER MODAL (Settings → Database → Folders → "Export folder") —
// fatia 5c — porta de #folderExportOverlay (index.html) +
// openFolderExportModal()/confirmExportFolder() (js/folders.js).
//
// Mesmo padrão de portal pro `document.body` que CommandsContent.tsx usa
// pro CommandEditorModal (ver comentário lá): este modal é montado dentro
// de DatabasePane.tsx → SettingsModal.tsx, que JÁ nasce fora do stacking
// context de `.main` (ver AppShell.tsx), mas o portal é feito aqui mesmo
// (dentro do próprio componente, não por quem o monta) pra manter
// FolderExportModal/FolderImportModal auto-contidos — qualquer chamador só
// precisa renderizar `<FolderExportModal onClose={...} />` sem se preocupar
// com createPortal.
//
// Busca a lista de pastas do usuário atual via fetchFolders() (mesmo cache
// de módulo que CommandsContent.tsx já usa) em vez de receber `folders` por
// prop — evita içar esse estado até AppShell.tsx só pra alimentar este
// modal, que é um fluxo raro (Configurações → Database), não o caminho
// principal da tela.
//
// Divergência deliberada do original: lá, o botão "Export folder" já
// verifica `FOLDERS.length` ANTES de abrir o modal (`if (!FOLDERS.length) {
// alert(...); return; }`). Aqui, abrir o modal é síncrono (não há como
// aguardar fetchFolders() antes de decidir abrir sem um estado de
// "carregando" a mais em DatabasePane.tsx) — o modal sempre abre, e mostra
// "You don't have any folders yet." no próprio corpo, com o botão Export
// desabilitado, em vez do alert() prévio. Efeito líquido idêntico (não dá
// pra exportar sem pasta), só o meio de comunicar que muda.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildFolderTree, fetchFolders, type Folder } from '../../lib/folders';

interface FolderOption {
  id: number;
  label: string;
}

// Porta de _folderTreeOptionsHtml() (js/folders.js) — árvore indentada por
// profundidade (`↳ `, 4 espaços por nível), Favorites/ordem alfabética já
// resolvidos por buildFolderTree().
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

// Porta 1:1 do slug em confirmExportFolder() (js/folders.js): minúsculas,
// não-alfanuméricos viram '-', sem '-' nas pontas.
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'folder';
}

export function FolderExportModal({ onClose }: { onClose: () => void }) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [selected, setSelected] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchFolders()
      .then(data => {
        if (cancelled) return;
        setFolders(data);
        const options = folderTreeOptions(data);
        if (options.length) setSelected(options[0].id);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load your folders.');
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

  async function handleExport() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/folders/${selected}/export`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || 'Failed to export the folder.');
        setBusy(false);
        return;
      }
      // Mesma técnica "Blob + <a download> sintético" do original
      // (confirmExportFolder) — gera o download sem precisar de nenhum
      // endpoint/redirect próprio pra servir o arquivo.
      const folderName = (data.root && data.root.name) || 'folder';
      const slug = slugify(folderName);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `toolbox45-folder-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch {
      setError('Failed to export the folder. Please try again.');
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
          <span className="modal-title">📤 Export folder</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">Folder</span>
            <span className="set-hint">
              Includes every subfolder, command and note inside it. Choose a top-level folder or one of its subfolders — the whole branch below
              your choice goes into the file.
            </span>
            {folders !== null && options.length === 0 ? (
              <p className="sec-folder-empty-msg">You don't have any folders yet.</p>
            ) : (
              <select className="set-input" value={selected} onChange={ev => setSelected(Number(ev.target.value))}>
                {options.map(o => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {error && (
              <span className="set-hint" style={{ color: 'var(--red)' }}>
                {error}
              </span>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" id="folderExportConfirmBtn" disabled={!selected || busy} onClick={handleExport}>
            Export
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
