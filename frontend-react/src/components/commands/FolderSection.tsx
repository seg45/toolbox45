// ════════════════════════════════════════════════
// Seção de uma pasta (ícone + nome/input + contagem + controles de edição +
// dropdown "+ Add" + itens) — porta de buildFolderSectionFromCards()
// (js/db-render-engine.js). Recursivo: uma subpasta é, ela mesma, um
// FolderSection aninhado dentro do corpo da seção da pasta-mãe (mesmo papel
// de renderFolderNode() em js/render.js).
//
// Reaproveita CollapsibleSection (mecânica de recolher/expandir — só no
// ícone .sec-chevron) passando o cabeçalho INTEIRO (ícone + nome/input +
// contagem + botões) como `headerContent` — cada controle interativo já
// tem seu próprio stopPropagation(), então nenhum deles dispara o toggle de
// colapso por engano (mesma garantia do original, onde só `.sec-chevron`
// tem o onclick de toggle).
//
// SEM drag-and-drop (fora do escopo desta fatia — itens são só lidos na
// ordem de folder.order, nunca reordenados aqui) e SEM notas ("+ Add" só
// oferece "Subfolder", decisão deliberada de escopo — ver instruções da
// tarefa).
// ════════════════════════════════════════════════
import type { FocusEvent, KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { Catalogs } from '../../lib/catalogs';
import type { useCollapsedSections } from '../../lib/collapsedSections';
import type { FolderSectionNode } from '../../lib/foldersPipeline';
import { CollapsibleSection } from './CollapsibleSection';
import { CommandCard } from './CommandCard';

// Mesmo path SVG de folderIcon()/js/terminal-renderer.js (ver também
// FolderMenu.tsx) — sempre "preenchido" aqui (toda pasta desta tela é
// própria do usuário, filled=true no original: `folderIcon(true, 12)`).
const FOLDER_PATH = 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.2h8.5A1.5 1.5 0 0 1 21 8.7v9.8A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-12z';

function FolderTitleIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" style={{ flexShrink: 0 }}>
      <path d={FOLDER_PATH} />
    </svg>
  );
}

// Dropdown "+ Add" do cabeçalho — mesmo componente visual .dd/.dd-panel/
// .sb-row do "Add" da toolbar principal (ver ContentToolbar.tsx/
// FilterDropdown.tsx), só que ancorado por .sec-folder-add-dd/
// .sec-folder-add-btn (CSS já pronto desde a fatia 1). Só "Subfolder" nesta
// fatia — "Note" fica pra 5c (RichTextEditor.tsx já existe mas não é usado
// aqui, ver instruções da tarefa).
function AddFolderDropdown({ folderId, onCreateSubfolder }: { folderId: number; onCreateSubfolder: (parentId: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  return (
    <div className={`dd sec-folder-add-dd${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        className="btn sec-folder-add-btn"
        onMouseDown={ev => ev.preventDefault()}
        onClick={ev => {
          ev.stopPropagation();
          setOpen(o => !o);
        }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        <span>Add</span><span className="dd-arrow">▾</span>
      </button>
      {open && (
        <div className="dd-panel">
          <div
            className="sb-row"
            onClick={ev => {
              ev.stopPropagation();
              setOpen(false);
              onCreateSubfolder(folderId);
            }}
          >
            <FolderTitleIcon />
            <span>Subfolder</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function FolderSection({
  node,
  isRoot,
  editMode,
  collapsedSections,
  catalogs,
  showImages,
  onEditCommand,
  onDuplicateCommand,
  onToggleRootEditMode,
  onRename,
  onDelete,
  onCreateSubfolder,
}: {
  node: FolderSectionNode;
  isRoot: boolean;
  editMode: boolean; // do ROOT da árvore inteira — viaja sem mudar por toda a recursão (ver comentário em CommandsContent.tsx)
  collapsedSections: ReturnType<typeof useCollapsedSections>;
  catalogs: Catalogs | null;
  showImages: boolean;
  onEditCommand: (id: number) => void;
  onDuplicateCommand: (id: number) => void;
  onToggleRootEditMode: (rootFolderId: number) => void;
  onRename: (folderId: number, newName: string) => Promise<boolean>;
  onDelete: (folderId: number, name: string) => void;
  onCreateSubfolder: (parentId: number) => void;
}) {
  const sectionKey = `folder-${node.folderId}`;
  const collapsed = collapsedSections.isCollapsed(sectionKey);
  // "Favorites" nunca mostra nome editável nem botão excluir, mesmo dentro
  // do modo de edição — pedido do usuário replicado 1:1 do original
  // (buildFolderSectionFromCards: `isFavorites = withActions && folderName
  // === 'Favorites'`).
  const showRenameInput = editMode && !node.isFavorites;

  // Renomear inline — porta de _folderNameInputKeydown()/
  // _folderNameInputBlur() (js/folders.js). Enter salva (blur dispara o
  // save); Escape reverte o valor pro nome atual e sai sem salvar.
  function handleKeyDown(ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.currentTarget.blur();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.currentTarget.value = node.name;
      ev.currentTarget.blur();
    }
  }
  async function handleBlur(ev: FocusEvent<HTMLInputElement>) {
    const input = ev.currentTarget;
    const oldName = node.name;
    const newName = input.value.trim();
    if (!newName || newName === oldName) {
      input.value = oldName; // vazio ou sem mudança: não chama a API
      return;
    }
    const ok = await onRename(node.folderId, newName);
    if (!ok) input.value = oldName; // falhou no servidor — reverte a exibição
  }

  // editControls (✎ fora do modo / Accept+Cancel dentro dele) só existem na
  // RAIZ (depth 0) — pedido do usuário: "a edição de subpastas e ordem dos
  // comandos e notas deve ficar somente na pasta pai". deleteTag (✕ Delete
  // Folder) continua em QUALQUER profundidade, mas só dentro do modo de
  // edição e nunca para Favorites.
  const hasLeftActions = isRoot || (editMode && !node.isFavorites);

  const header = (
    <>
      <FolderTitleIcon />
      {showRenameInput ? (
        <input
          type="text"
          className="sec-folder-name-input"
          defaultValue={node.name}
          onClick={ev => ev.stopPropagation()}
          onMouseDown={ev => ev.stopPropagation()}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
        />
      ) : (
        node.name
      )}
      <span className="sec-count">{node.cardCount}</span>
      {hasLeftActions && (
        <span className="sec-folder-actions">
          {isRoot &&
            (editMode ? (
              <>
                <button
                  type="button"
                  className="sec-folder-pill-btn pill-accept"
                  onMouseDown={ev => ev.preventDefault()}
                  onClick={ev => { ev.stopPropagation(); onToggleRootEditMode(node.rootFolderId); }}
                  title="Accept and finish editing"
                >
                  ✓ Accept
                </button>
                <button
                  type="button"
                  className="sec-folder-pill-btn pill-cancel"
                  onMouseDown={ev => ev.preventDefault()}
                  onClick={ev => { ev.stopPropagation(); onToggleRootEditMode(node.rootFolderId); }}
                  title="Cancel editing"
                >
                  ✕ Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="sec-folder-btn sec-folder-edit-btn"
                onMouseDown={ev => ev.preventDefault()}
                onClick={ev => { ev.stopPropagation(); onToggleRootEditMode(node.rootFolderId); }}
                title="Edit folder"
              >
                ✎
              </button>
            ))}
          {editMode && !node.isFavorites && (
            <button
              type="button"
              className="sec-folder-pill-btn pill-delete"
              onMouseDown={ev => ev.preventDefault()}
              onClick={ev => { ev.stopPropagation(); onDelete(node.folderId, node.name); }}
              title="Delete folder"
            >
              ✕ Delete Folder
            </button>
          )}
        </span>
      )}
      <span className="sec-title-divider" />
      <AddFolderDropdown folderId={node.folderId} onCreateSubfolder={onCreateSubfolder} />
    </>
  );

  // `.section-editing` (destaque tracejado + mantém .sec-folder-actions
  // visível sem precisar de hover) segue `editMode`, igual em toda a árvore
  // (raiz e subpastas) — mesmo critério de `active` em
  // buildFolderSectionFromCards (`active = withActions && editMode`).
  const extraClass = editMode ? 'section-folder section-editing' : 'section-folder';
  // Indentação por profundidade (subpastas, aninhamento ilimitado) — inline,
  // mesmo valor (18px/nível) do original.
  const style = node.depth > 0 ? { marginLeft: node.depth * 18 } : undefined;

  return (
    // `data-folder-id`/`data-root-folder-id` — mesmos atributos que o
    // original grava no próprio `.section` (buildFolderSectionFromCards:
    // `html.replace('<div class="section', '<div data-folder-id=... data-
    // root-folder-id=...')`), úteis daqui a uma fatia futura (5b,
    // drag-and-drop) e já hoje pra identificar CADA seção de pasta sem
    // ambiguidade (uma pasta com subpastas tem várias seções aninhadas com
    // nomes/botões parecidos no DOM).
    <div style={style} data-folder-id={node.folderId} data-root-folder-id={node.rootFolderId}>
      <CollapsibleSection
        sectionKey={sectionKey}
        headerContent={header}
        collapsed={collapsed}
        onToggleChevron={() => collapsedSections.toggle(sectionKey)}
        extraClass={extraClass}
        renderBody={() => (
          <>
            {/* Pasta própria SEMPRE aparece, mesmo vazia (0 comandos, 0
                subpastas) — este aviso substitui a lista vazia, em vez de
                deixar o corpo da seção parecendo quebrado. */}
            {node.items.length === 0 && <p className="sec-folder-empty-msg">Empty folder.</p>}
            {node.items.map(it =>
              it.type === 'command' ? (
                <CommandCard
                  key={`cmd-${it.card.id}`}
                  card={it.card}
                  catalogs={catalogs}
                  showImages={showImages}
                  onEdit={onEditCommand}
                  onDuplicate={onDuplicateCommand}
                />
              ) : (
                <FolderSection
                  key={`folder-${it.section.folderId}`}
                  node={it.section}
                  isRoot={false}
                  editMode={editMode}
                  collapsedSections={collapsedSections}
                  catalogs={catalogs}
                  showImages={showImages}
                  onEditCommand={onEditCommand}
                  onDuplicateCommand={onDuplicateCommand}
                  onToggleRootEditMode={onToggleRootEditMode}
                  onRename={onRename}
                  onDelete={onDelete}
                  onCreateSubfolder={onCreateSubfolder}
                />
              )
            )}
          </>
        )}
      />
    </div>
  );
}
