// ════════════════════════════════════════════════
// Botão de pastas do card (.fav-wrap/.fav-btn) + dropdown "Add to folder"
// (.folder-menu-pop, com flyout de subpastas) + popover de auditoria
// (.fav-audit-pop) — porta de folderIcon()/auditPopover()/folderMenuHtml()
// (js/terminal-renderer.js) + toggleFolderMenu()/_folderMenuShowSubmenu()/
// _folderMenuScheduleHideSubmenu() (js/folders.js).
//
// O fechamento ao clicar fora (no original, um único listener 'click'
// delegado no document) e "fecha os outros dropdowns abertos"
// (querySelectorAll('.folder-menu-pop.open')) viram, aqui, um único estado
// compartilhado (FoldersUIContext.openCommandId — ver src/lib/foldersUI.tsx):
// só um comando por vez tem o próprio dropdown "aberto" em toda a árvore,
// esteja o card na visão normal ou dentro de uma seção de pasta (mesmo
// componente CommandCard é reaproveitado nos dois lugares).
//
// O popover de auditoria continua 100% CSS (.fav-wrap:hover), sem nenhum
// estado React — inclusive o :has(.folder-menu-pop.open) que o esconde
// enquanto o dropdown está aberto (ver components.css): basta a classe
// "open" estar presente no elemento certo quando o dropdown está aberto.
// ════════════════════════════════════════════════
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { buildFolderTree, formatAuditDate, type Folder } from '../../lib/folders';
import { useFoldersUI } from '../../lib/foldersUI';

// Mesmo path SVG de folderIcon()/js/terminal-renderer.js — reaproveitado
// também pelo ícone do cabeçalho de uma seção de pasta (ver
// FolderSection.tsx) e pelo item "+ New folder" abaixo.
const FOLDER_PATH = 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.2h8.5A1.5 1.5 0 0 1 21 8.7v9.8A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-12z';

function FolderIcon({ filled, size = 13 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
      <path d={FOLDER_PATH} />
    </svg>
  );
}

// Uma linha do dropdown — recursiva (aninhamento ilimitado): uma pasta com
// subpastas ganha uma seta (›) e, ao passar o mouse, abre um flyout lateral
// com as subpastas diretas (que por sua vez também podem ter sua própria
// seta/flyout). Cada item continua sendo, ele mesmo, um alvo válido pra
// marcar/desmarcar (a seta só abre o flyout de navegação).
function FolderMenuItemRow({
  folder,
  childrenOf,
  idSet,
  onToggle,
}: {
  folder: Folder;
  childrenOf: (id: number) => Folder[];
  idSet: Set<number>;
  onToggle: (folderId: number) => void;
}) {
  const [showSub, setShowSub] = useState(false);
  const rowRef = useRef<HTMLSpanElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const children = childrenOf(folder.id);
  const hasChildren = children.length > 0;
  const on = idSet.has(folder.id);

  function openSub() {
    window.clearTimeout(closeTimer.current);
    setShowSub(true);
  }
  function scheduleClose() {
    window.clearTimeout(closeTimer.current);
    // Dá tempo do usuário "atravessar" o espaço entre a linha e o flyout
    // (mesmo em diagonal) sem o menu sumir no meio do caminho — mesmo prazo
    // (200ms) de _folderMenuScheduleHideSubmenu() no original.
    closeTimer.current = window.setTimeout(() => setShowSub(false), 200);
  }
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Posiciona o flyout via getBoundingClientRect() da própria linha, com
  // fallback pra esquerda se ultrapassar a borda direita da tela — mesmo
  // espírito de _folderMenuShowSubmenu() (js/folders.js), simplificado (só
  // recalcula quando o flyout abre, não a cada scroll contínuo — aceitável
  // pra um menu que fecha ao rolar/clicar fora de qualquer forma).
  useLayoutEffect(() => {
    if (!showSub || !rowRef.current || !subRef.current) return;
    const rect = rowRef.current.getBoundingClientRect();
    const sub = subRef.current;
    sub.style.top = `${Math.round(rect.top)}px`;
    sub.style.left = `${Math.round(rect.right) + 2}px`;
    const subRect = sub.getBoundingClientRect();
    if (subRect.right > window.innerWidth - 8) {
      sub.style.left = `${Math.round(rect.left) - subRect.width - 2}px`;
    }
  }, [showSub]);

  return (
    <div
      className={`folder-menu-item${on ? ' on' : ''}${hasChildren ? ' has-children' : ''}`}
      onMouseEnter={hasChildren ? openSub : undefined}
      onMouseLeave={hasChildren ? scheduleClose : undefined}
    >
      <span className="folder-menu-row" ref={rowRef} onClick={ev => { ev.stopPropagation(); onToggle(folder.id); }}>
        <span className="folder-menu-chk">{on ? '✓' : ''}</span>
        <span className="folder-menu-name">{folder.name}</span>
        {hasChildren && <span className="folder-menu-arrow">›</span>}
      </span>
      {hasChildren && (
        <div
          className={`folder-menu-submenu${showSub ? ' show' : ''}`}
          ref={subRef}
          onMouseEnter={openSub}
          onMouseLeave={scheduleClose}
        >
          {children.map(c => (
            <FolderMenuItemRow key={c.id} folder={c} childrenOf={childrenOf} idSet={idSet} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderMenuPop({ commandId, folderIds, open }: { commandId: number; folderIds: number[]; open: boolean }) {
  const { folders, toggleCommandFolder, createRootFolder, setOpenCommandId } = useFoldersUI();
  const idSet = new Set(folderIds);
  const tree = buildFolderTree(folders || []);
  return (
    <div className={`folder-menu-pop${open ? ' open' : ''}`} onClick={ev => ev.stopPropagation()}>
      {tree.roots.length === 0 && <div className="folder-menu-empty">No folders yet.</div>}
      {tree.roots.map(f => (
        <FolderMenuItemRow key={f.id} folder={f} childrenOf={tree.childrenOf} idSet={idSet} onToggle={fid => toggleCommandFolder(commandId, fid)} />
      ))}
      <div className="folder-menu-divider" />
      {/* "+ New folder" — a pasta nova já entra com este comando dentro dela
          (cmdIdToAddAfter no original), sem precisar reabrir o dropdown e
          marcar de novo. Fecha ESTE dropdown antes de abrir o modal de nome
          (mesmo comportamento do onclick original). */}
      <div
        className="folder-menu-item folder-menu-new"
        onClick={ev => {
          ev.stopPropagation();
          setOpenCommandId(null);
          createRootFolder(commandId);
        }}
      >
        <span className="folder-menu-chk" />
        <span className="folder-menu-name">+ New folder</span>
      </div>
    </div>
  );
}

export function FolderButton({
  commandId,
  folderIds,
  createdBy,
  modifiedBy,
  updatedAt,
}: {
  commandId: number;
  folderIds: number[];
  createdBy: string | null;
  modifiedBy: string | null;
  updatedAt: string;
}) {
  const { openCommandId, setOpenCommandId } = useFoldersUI();
  const open = openCommandId === commandId;
  const inAnyFolder = folderIds.length > 0;
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Fecha o dropdown ao clicar fora dele/do botão — mesmo listener único
  // delegado no document do original (document.addEventListener('click', …)
  // logo depois de toggleFolderMenu(), js/folders.js).
  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpenCommandId(null);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open, setOpenCommandId]);

  return (
    <span className="fav-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`fav-btn${inAnyFolder ? ' on' : ''}`}
        title={inAnyFolder ? 'In folders' : 'Add to folder'}
        onClick={ev => {
          ev.stopPropagation();
          setOpenCommandId(open ? null : commandId);
        }}
      >
        <FolderIcon filled={inAnyFolder} />
      </button>
      <FolderMenuPop commandId={commandId} folderIds={folderIds} open={open} />
      {/* Popover de auditoria — puramente CSS (.fav-wrap:hover), sem nenhum
          estado próprio; :has(.folder-menu-pop.open) acima já cuida de
          escondê-lo enquanto o dropdown está aberto. */}
      <div className="fav-audit-pop">
        <div className="fav-audit-row"><span className="fav-audit-k">Created by:</span><span>{createdBy || '—'}</span></div>
        <div className="fav-audit-row"><span className="fav-audit-k">Modified by:</span><span>{modifiedBy || createdBy || '—'}</span></div>
        <div className="fav-audit-row"><span className="fav-audit-k">Modified on:</span><span>{formatAuditDate(updatedAt)}</span></div>
      </div>
    </span>
  );
}
