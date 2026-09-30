// ════════════════════════════════════════════════
// Seção de uma pasta (ícone + nome/input + contagem + controles de edição +
// dropdown "+ Add"/botão "⧉ Copy" + itens) — porta de
// buildFolderSectionFromCards() (js/db-render-engine.js). Recursivo: uma
// subpasta é, ela mesma, um FolderSection aninhado dentro do corpo da seção
// da pasta-mãe (mesmo papel de renderFolderNode() em js/render.js).
//
// Reaproveita CollapsibleSection (mecânica de recolher/expandir — só no
// ícone .sec-chevron) passando o cabeçalho INTEIRO (ícone + nome/input +
// contagem + botões) como `headerContent` — cada controle interativo já
// tem seu próprio stopPropagation(), então nenhum deles dispara o toggle de
// colapso por engano (mesma garantia do original, onde só `.sec-chevron`
// tem o onclick de toggle).
//
// Fatia 5b acrescentou: `node.isOwn` (pasta de outro usuário — escopo
// cross-user, ver src/lib/folderScope.ts — é só leitura: SEM nome
// editável/Delete/dropdown "+ Add"/alça de arrastar, com um único botão
// "⧉ Copy this folder to your own Folders" no lugar de "+ Add") e
// drag-and-drop de verdade (cada item — card OU seção de subpasta inteira —
// ganha uma alça ⠿ quando `active` = node.isOwn && editMode, envolvido num
// `.folder-item-row` com os atributos `data-container-id`/`data-item-type`/
// `data-item-id`/`data-root-folder-id` que src/lib/useFolderDrag.ts lê via
// DOM — ver comentário lá sobre a decisão de manipular o DOM diretamente
// durante o `dragover`, só commitando estado no `dragend`).
//
// Fatia 5c acrescentou Notes: "+ Add" ganhou a opção "Note" (ACIMA de
// "Subfolder", mesma ordem do original); um item `{type:'note'}` de
// `node.items` vira um <NoteCard> (mesmo tratamento de drag que comando/
// subpasta — arrastável quando `active`); e uma nota NOVA ainda sem id
// (`creatingNoteFolderId === node.folderId`) é renderizada separadamente,
// no TOPO do corpo, FORA de `node.items`/do mecanismo de drag — mesmo
// critério de `draftNoteHtml` no original (uma nota ainda não salva não tem
// posição em folder.order, não há o que reordenar).
// ════════════════════════════════════════════════
import type { FocusEvent, KeyboardEvent } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { Catalogs } from '../../lib/catalogs';
import type { useCollapsedSections } from '../../lib/collapsedSections';
import type { FolderSectionNode } from '../../lib/foldersPipeline';
import type { FolderItemType } from '../../lib/useFolderDrag';
import { CollapsibleSection } from './CollapsibleSection';
import { CommandCard } from './CommandCard';
import { NoteCard } from './NoteCard';

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
// .sec-folder-add-btn (CSS já pronto desde a fatia 1). "Note" ACIMA de
// "Subfolder" — mesma ordem do original (db-render-engine.js, linha
// ~371-378: startCreateNote() antes de promptCreateSubfolder()).
function AddFolderDropdown({
  folderId,
  onCreateNote,
  onCreateSubfolder,
}: {
  folderId: number;
  onCreateNote: (folderId: number) => void;
  onCreateSubfolder: (parentId: number) => void;
}) {
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
              onCreateNote(folderId);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Note</span>
          </div>
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
  onCopyFolder,
  armDrag,
  editingNoteIds,
  creatingNoteFolderId,
  onCreateNote,
  onStartEditNote,
  onCancelNoteEdit,
  onAcceptNoteEdit,
  onDeleteNote,
  onCloneNote,
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
  // Fatia 5b — "⧉ Copy this folder to your own Folders" (só aparece quando
  // !node.isOwn, ver rightAction abaixo).
  onCopyFolder: (folderId: number, name: string) => void;
  // Fatia 5b — arma a alça de arrastar (ver src/lib/useFolderDrag.ts);
  // recebida do Provider (CommandsContent.tsx), que monta o hook UMA VEZ
  // pra toda a árvore (não faria sentido um hook de drag por FolderSection,
  // já que um item pode ser solto em qualquer outra pasta da MESMA árvore,
  // não só na sua pasta-mãe direta).
  armDrag: (handle: HTMLElement | null) => void;
  // Fatia 5c — Notes: mesmo espírito de `editMode`/`folderEditRoots`
  // (estado transitório de UI que mora em CommandsContent.tsx, ver
  // NOTE_EDIT_MODE/NOTE_CREATE_FOLDER_ID no original) — passado por prop
  // através da recursão (mesmo padrão já usado por todos os outros
  // callbacks de pasta acima, em vez de um Context novo só pra isso).
  editingNoteIds: Set<number>; // ids de notas EXISTENTES sendo editadas agora
  creatingNoteFolderId: number | null; // folderId com um rascunho de nota nova em edição, ou null
  onCreateNote: (folderId: number) => void;
  onStartEditNote: (noteId: number) => void;
  onCancelNoteEdit: (noteId: number | null, folderId: number) => void;
  onAcceptNoteEdit: (noteId: number | null, folderId: number, html: string) => void;
  onDeleteNote: (noteId: number, folderId: number) => void;
  onCloneNote: (noteId: number, folderId: number) => void;
}) {
  const sectionKey = `folder-${node.folderId}`;
  const collapsed = collapsedSections.isCollapsed(sectionKey);
  // Drag-and-drop só existe numa pasta PRÓPRIA (node.isOwn) em modo de
  // edição — mesmo critério de `active = withActions && editMode` no
  // original (buildFolderSectionFromCards). Pasta de outro usuário nunca
  // entra em modo de edição de verdade (não tem botão ✎ pra ligar — ver
  // hasLeftActions abaixo), mas a checagem explícita aqui é uma segunda
  // barreira contra soltar algo numa pasta só-leitura por engano.
  const active = node.isOwn && editMode;
  // "Favorites" nunca mostra nome editável nem botão excluir, mesmo dentro
  // do modo de edição — pedido do usuário replicado 1:1 do original
  // (buildFolderSectionFromCards: `isFavorites = withActions && folderName
  // === 'Favorites'`).
  const showRenameInput = editMode && !node.isFavorites && node.isOwn;

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
  // RAIZ (depth 0) de uma pasta PRÓPRIA — pedido do usuário: "a edição de
  // subpastas e ordem dos comandos e notas deve ficar somente na pasta
  // pai". deleteTag (✕ Delete Folder) continua em QUALQUER profundidade,
  // mas só dentro do modo de edição, nunca para Favorites, e nunca numa
  // pasta que não seja própria (fatia 5b: pasta de outro usuário nunca tem
  // hasLeftActions — é sempre só-leitura, ver rightAction abaixo).
  const hasLeftActions = node.isOwn && (isRoot || (editMode && !node.isFavorites));

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
      {/* Fatia 5b: pasta própria → dropdown "+ Add" de sempre; pasta de
          OUTRO usuário → um único botão "⧉ Copy" no lugar (nunca os dois
          juntos — mesma exclusividade de `withActions`/`copyable` no
          original, `buildFolderSectionFromCards`). */}
      {node.isOwn ? (
        <AddFolderDropdown folderId={node.folderId} onCreateNote={onCreateNote} onCreateSubfolder={onCreateSubfolder} />
      ) : (
        <button
          type="button"
          className="sec-folder-btn"
          onMouseDown={ev => ev.preventDefault()}
          onClick={ev => { ev.stopPropagation(); onCopyFolder(node.folderId, node.name); }}
          title="Copy this folder to your own Folders"
        >
          ⧉
        </button>
      )}
    </>
  );

  // `.section-editing` (destaque tracejado + mantém .sec-folder-actions
  // visível sem precisar de hover) segue `active` (não mais `editMode` cru
  // — fatia 5b: numa pasta de outro usuário, `editMode` herdado da raiz
  // nunca reflete edição de verdade ali, já que não existe botão ✎ pra
  // ligá-lo, mas usar `active` deixa a intenção explícita em vez de
  // depender desse efeito colateral) — mesmo critério de `active =
  // withActions && editMode` em buildFolderSectionFromCards.
  const extraClass = active ? 'section-folder section-editing' : 'section-folder';
  // Indentação por profundidade (subpastas, aninhamento ilimitado) — inline,
  // mesmo valor (18px/nível) do original.
  const style = node.depth > 0 ? { marginLeft: node.depth * 18 } : undefined;

  return (
    <CollapsibleSection
      sectionKey={sectionKey}
      headerContent={header}
      collapsed={collapsed}
      onToggleChevron={() => collapsedSections.toggle(sectionKey)}
      extraClass={extraClass}
      style={style}
      // `data-folder-id`/`data-root-folder-id` (no wrapper `.section`),
      // `data-folder-header-id` (no `.sec-title`) e `data-folder-body-id`
      // (no `.sec-body`) — mesmos três atributos/mesmos elementos do
      // original (buildFolderSectionFromCards's html.replace(...)),
      // lidos por src/lib/useFolderDrag.ts durante o dragover (soltar no
      // CABEÇALHO de uma pasta) e no dragend (ler a ordem final do corpo
      // de um container). Gravados em TODA pasta, própria ou não — não têm
      // efeito nenhum numa pasta só-leitura (nunca existe um
      // `.folder-item-row[draggable]` pra começar um drag vindo de lá), e
      // ficar no `rootFolderId` do useFolderDrag.ts já impede que um item
      // arrastado da própria árvore seja solto na árvore de outra pessoa.
      rootDataAttrs={{ 'data-folder-id': node.folderId, 'data-root-folder-id': node.rootFolderId }}
      headerDataAttrs={{ 'data-folder-header-id': node.folderId }}
      bodyDataAttrs={{ 'data-folder-body-id': node.folderId }}
      renderBody={() => {
        // Rascunho de nota NOVA em edição — não é um item de `node.items`
        // (não existe no servidor ainda, não tem posição em folder.order):
        // entra sempre no TOPO do corpo, fora do mecanismo de drag — mesmo
        // critério de `draftNoteHtml` no original. `key` ESTÁVEL
        // (`note-draft-${folderId}`) — ver comentário em NoteCard.tsx sobre
        // por que isso substitui NOTE_EDIT_DRAFTS.
        const isDrafting = node.isOwn && creatingNoteFolderId === node.folderId;
        const draftNote = isDrafting && (
          <NoteCard
            key={`note-draft-${node.folderId}`}
            note={{ id: null, folder_id: node.folderId, description: '' }}
            isNew
            editing
            isOwn
            onStartEdit={() => {}}
            onClone={() => {}}
            onAccept={html => onAcceptNoteEdit(null, node.folderId, html)}
            onCancel={() => onCancelNoteEdit(null, node.folderId)}
            onDelete={() => {}}
          />
        );
        return (
          <>
            {draftNote}
            {/* Pasta própria SEMPRE aparece, mesmo vazia (0 comandos, 0
                notas, 0 subpastas) — este aviso substitui a lista vazia, em
                vez de deixar o corpo da seção parecendo quebrado. Não
                aparece com um rascunho de nota nova ocupando o corpo
                (contraditório mostrar "Empty folder." ao lado do editor de
                uma nota que o próprio usuário acabou de abrir — mesmo
                critério do original). Pasta de outro usuário vazia nunca
                chega até aqui (podada na própria árvore — ver
                buildFolderSectionTreeForOwner em foldersPipeline.ts — então
                `node.items.length === 0` só acontece pra pastas próprias, a
                checagem de isOwn aqui é só defensiva). */}
            {node.items.length === 0 && node.isOwn && !isDrafting && <p className="sec-folder-empty-msg">Empty folder.</p>}
            {node.items.map(it => {
              const itemType: FolderItemType = it.type;
              const itemId = it.type === 'command' ? it.card.id : it.type === 'note' ? it.note.id : it.section.folderId;
              const rendered =
                it.type === 'command' ? (
                  <CommandCard
                    card={it.card}
                    catalogs={catalogs}
                    showImages={showImages}
                    onEdit={onEditCommand}
                    onDuplicate={onDuplicateCommand}
                  />
                ) : it.type === 'note' ? (
                  <NoteCard
                    note={it.note}
                    isNew={false}
                    editing={editingNoteIds.has(it.note.id)}
                    isOwn={node.isOwn}
                    onStartEdit={() => onStartEditNote(it.note.id)}
                    onClone={() => onCloneNote(it.note.id, node.folderId)}
                    onAccept={html => onAcceptNoteEdit(it.note.id, node.folderId, html)}
                    onCancel={() => onCancelNoteEdit(it.note.id, node.folderId)}
                    onDelete={() => onDeleteNote(it.note.id, node.folderId)}
                  />
                ) : (
                  <FolderSection
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
                    onCopyFolder={onCopyFolder}
                    armDrag={armDrag}
                    editingNoteIds={editingNoteIds}
                    creatingNoteFolderId={creatingNoteFolderId}
                    onCreateNote={onCreateNote}
                    onStartEditNote={onStartEditNote}
                    onCancelNoteEdit={onCancelNoteEdit}
                    onAcceptNoteEdit={onAcceptNoteEdit}
                    onDeleteNote={onDeleteNote}
                    onCloneNote={onCloneNote}
                  />
                );
              const key = itemType === 'command' ? `cmd-${itemId}` : itemType === 'note' ? `note-${itemId}` : `folder-${itemId}`;
              // Fora do modo de edição (ou numa pasta só-leitura), o item
              // aparece cru, sem o wrapper de drag — mesmo critério de
              // `active` no original (`body = items.map(it => active ?
              // wrapItemForFolderDrag(...) : it.html)`). `Fragment` (não uma
              // `<span>`/`<div>` extra) pra não introduzir um elemento a mais
              // no DOM só pra carregar a `key` — `.sec-body` (flex/grid,
              // ver components.css) espera `.card`/`.section` como filhos
              // DIRETOS.
              if (!active) return <Fragment key={key}>{rendered}</Fragment>;
              return (
                <div
                  key={key}
                  className="folder-item-row"
                  data-container-id={node.folderId}
                  data-item-type={itemType}
                  data-item-id={itemId}
                  data-root-folder-id={node.rootFolderId}
                >
                  <span className="folder-drag-handle" onMouseDown={ev => armDrag(ev.currentTarget)} title="Drag to reorder">
                    ⠿
                  </span>
                  <div className="folder-item-row-body">{rendered}</div>
                </div>
              );
            })}
          </>
        );
      }}
    />
  );
}
