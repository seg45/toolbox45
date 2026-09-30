// ════════════════════════════════════════════════
// Área principal de comandos — substitui o placeholder
// `<div class="content" id="out">{/* Preenchido pela fatia 3 */}</div>` de
// AppShell.tsx (este componente É o `.content#out`, não um filho dele).
//
// Orquestra: QueryBar (fatia 3b — campo de query unificado com tags,
// chips fixos/Others e histórico, ver query-bar.js; substitui o stopgap
// SimpleQueryFields.tsx da fatia 3a) + ContentToolbar (Group by / Expand
// all / Collapse all) + fetchCommands() (loading/erro) +
// renderPipeline.buildRenderTree() + a árvore de comboBlocks/sections/cards
// + a nota de truncamento de MAX_COMBOS + o estado vazio final de busca
// sem resultado.
//
// Porta de render() em js/render.js (a parte de orquestração/DOM — a lógica
// de dados já foi portada em renderPipeline.ts).
//
// Fatia 4 (Editor de comandos) acrescentou aqui: o estado de "qual editor
// está aberto" (`editor`) e uma função de refresh (invalida cache + refetch
// + setCommands) passada como callback pro modal salvar/deletar, pro
// ContentToolbar (botão Add) e pro CommandCard (botões Edit/Duplicate) —
// mesmo espírito de AppShell.tsx com settingsOpen/setSettingsOpen pro modal
// de Configurações. Mora aqui (não em AppShell.tsx) porque é aqui que o
// estado `commands`/`setCommands`/fetchCommands() já vivia.
//
// Fatia 5a (Pastas) acrescentou: o estado `folders` (fetchFolders(), mesmo
// padrão de `commands`) + toda a lógica de CRUD/membership de pastas
// (toggle/criar raiz/criar subpasta/renomear/excluir/modo de edição), e a
// visão alternativa "Folders" (`foldersView.active`, ver AppShell.tsx) que
// troca a árvore normal (comboBlocks/sections, Tópico/Versão/Created by)
// por uma árvore PARALELA de seções de pasta (buildFolderSectionTree, ver
// src/lib/foldersPipeline.ts) — nunca as duas ao mesmo tempo, mesmo
// comportamento do VIEW_FOLDERS_HOME original ("sempre retorna... nunca cai
// nos ramos de GROUP_BY" — Group by continua visível na toolbar enquanto em
// Folders, mas fica sem efeito nenhum, exatamente como no original).
// `folders`/o botão de pastas de cada card (FolderButton, dentro de
// CommandCard.tsx) ficam disponíveis nos DOIS modos — o dropdown "Add to
// folder" de um card na visão normal já reflete/edita as mesmas pastas.
// ════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../lib/api';
import type { Catalogs } from '../../lib/catalogs';
import { useCollapsedSections } from '../../lib/collapsedSections';
import { fetchCommands, invalidateCommandsCache, type Command } from '../../lib/commands';
import {
  addCommandToFolder,
  collectFolderAndDescendantIds,
  createFolder,
  deleteFolder as apiDeleteFolder,
  fetchFolders,
  invalidateFoldersCache,
  removeCommandFromFolder,
  renameFolder as apiRenameFolder,
  type Folder,
  type FolderOrderItem,
} from '../../lib/folders';
import type { useFoldersView } from '../../lib/foldersView';
import { buildFolderSectionTree, filterFolderTree, folderTreeCardCount, type FolderSectionNode } from '../../lib/foldersPipeline';
import { FoldersUIContext } from '../../lib/foldersUI';
import type { useLiveFilters } from '../../lib/liveFilters';
import { buildRenderTree, buildValues, filterCommands, type ComboBlockData, type SectionData } from '../../lib/renderPipeline';
import type { Settings } from '../../lib/settingsStore';
import { useConfirm } from '../../lib/useConfirm';
import { useFolderPrompt } from '../../lib/useFolderPrompt';
import { CollapsibleSection } from './CollapsibleSection';
import { CommandCard } from './CommandCard';
import { CommandEditorModal, type EditorMode } from './CommandEditorModal';
import { ContentToolbar } from './ContentToolbar';
import { FolderSection } from './FolderSection';
import { QueryBar } from './QueryBar';

type EditorState = { mode: EditorMode; id?: number };

function folderCrudErrorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

export function CommandsContent({
  settings,
  updateSettings,
  catalogs,
  liveFilters,
  foldersView,
}: {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  catalogs: Catalogs | null;
  liveFilters: ReturnType<typeof useLiveFilters>;
  foldersView: ReturnType<typeof useFoldersView>;
}) {
  const [commands, setCommands] = useState<Command[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [foldersLoadError, setFoldersLoadError] = useState(false);
  // Um valor por parâmetro do catálogo (não só os 9 hardcoded), resolvido
  // pela QueryBar a partir das tags confirmadas + o que está sendo
  // digitado — estado "lifted" aqui, exatamente como SimpleQueryFields.tsx
  // fazia na fatia 3a (mesmo contrato de shape; só a UI que o produz mudou).
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const collapsedSections = useCollapsedSections();
  const [editor, setEditor] = useState<EditorState | null>(null);
  // Set de folderIds de RAIZ atualmente em modo de edição — porta de
  // FOLDER_EDIT_MODE (js/folders.js): só em memória, não persiste entre
  // reloads (mesma decisão do original pra esse tipo de estado de UI
  // transitório). Só pastas de TOPO entram neste Set; uma subpasta herda o
  // valor da raiz da própria árvore (ver FolderSection.tsx: `editMode`
  // viaja sem mudar por toda a recursão, nunca lido por subfolderId).
  const [folderEditRoots, setFolderEditRoots] = useState<Set<number>>(new Set());
  // Qual comando tem o próprio dropdown "Add to folder" aberto — substitui
  // querySelectorAll('.folder-menu-pop.open') do original (fechar os
  // outros ao abrir um novo) por um único estado React (ver
  // src/lib/foldersUI.tsx).
  const [openFolderMenuId, setOpenFolderMenuId] = useState<number | null>(null);
  const folderPrompt = useFolderPrompt();
  const confirmAction = useConfirm();

  useEffect(() => {
    let cancelled = false;
    fetchCommands()
      .then(data => {
        if (!cancelled) {
          setCommands(data);
          setLoadError(false);
        }
      })
      .catch(err => {
        console.error('Failed to load commands from API', err);
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pastas — buscadas sempre no boot (independente de `foldersView.active`):
  // o botão de pastas de cada card (FolderButton) precisa da lista completa
  // pra montar seu dropdown mesmo fora da visão "Folders" — mesmo papel de
  // reloadFoldersFromServer() no original, chamado uma vez no boot via
  // user-sync.js.
  useEffect(() => {
    let cancelled = false;
    fetchFolders()
      .then(data => {
        if (!cancelled) {
          setFolders(data);
          setFoldersLoadError(false);
        }
      })
      .catch(err => {
        console.error('Failed to load folders from API', err);
        if (!cancelled) setFoldersLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Callback de refresh passado pro CommandEditorModal (salvar/excluir) —
  // invalida o cache de fetchCommands() e busca a lista de novo, refletindo
  // na tela sem precisar de um reload de página.
  async function refreshCommands() {
    invalidateCommandsCache();
    try {
      const data = await fetchCommands();
      setCommands(data);
      setLoadError(false);
    } catch (err) {
      console.error('Failed to reload commands from API', err);
      setLoadError(true);
    }
  }

  // ── Membership (marcar/desmarcar um comando numa pasta) — porta de
  // toggleCommandInFolder() (js/folders.js). Atualização OTIMISTA: mutação
  // local imediata (commands[].folder_ids + folders[].commandIds/order) sem
  // esperar o round-trip do servidor — o request roda em PARALELO, e uma
  // falha dele só loga um aviso (mesmo comportamento do original, que nunca
  // desfaz o estado local otimista por causa de um erro de rede). Funciona
  // idêntico estando o card na visão normal ou dentro de uma seção de
  // pasta — em ambos os casos, o próprio React já cuida de "reconstruir a
  // tela" (a árvore de dados é recalculada a partir de `commands`/`folders`
  // atualizados), sem precisar da lógica extra do original pra reabrir o
  // dropdown/re-render manual dentro de Folders.
  function toggleCommandFolder(commandId: number, folderId: number) {
    const currentFolder = folders?.find(f => f.id === folderId);
    if (!currentFolder) return;
    const wasOn = currentFolder.commandIds.has(commandId);

    setFolders(prev =>
      prev
        ? prev.map(f => {
            if (f.id !== folderId) return f;
            const nextIds = new Set(f.commandIds);
            let nextOrder: FolderOrderItem[];
            if (wasOn) {
              nextIds.delete(commandId);
              nextOrder = f.order.filter(o => !(o.type === 'command' && o.id === commandId));
            } else {
              nextIds.add(commandId);
              nextOrder = f.order.some(o => o.type === 'command' && o.id === commandId)
                ? f.order
                : [...f.order, { type: 'command', id: commandId }];
            }
            return { ...f, commandIds: nextIds, order: nextOrder };
          })
        : prev
    );
    setCommands(prev =>
      prev
        ? prev.map(c => {
            if (c.id !== commandId) return c;
            const ids = new Set(c.folder_ids);
            if (wasOn) ids.delete(folderId);
            else ids.add(folderId);
            return { ...c, folder_ids: [...ids] };
          })
        : prev
    );
    invalidateFoldersCache();

    const req = wasOn ? removeCommandFromFolder(folderId, commandId) : addCommandToFolder(folderId, commandId);
    req.catch(e => console.warn('Falha ao atualizar pasta no servidor (mantido localmente)', e));
  }

  // "+ New folder" (dropdown de pastas de um card) — porta de
  // promptCreateFolder()/_createFolderInternal() (js/folders.js). A pasta
  // nova já entra com ESTE comando dentro dela (cmdIdToAddAfter no
  // original), sem precisar reabrir o dropdown e marcar de novo.
  async function createRootFolder(commandId: number) {
    const name = await folderPrompt('create');
    if (!name) return;
    try {
      const folder = await createFolder(name);
      const nextFolder: Folder = { ...folder, commandIds: new Set([commandId]), order: [{ type: 'command', id: commandId }] };
      setFolders(prev => (prev ? [...prev, nextFolder] : [nextFolder]));
      setCommands(prev =>
        prev ? prev.map(c => (c.id === commandId ? { ...c, folder_ids: [...new Set([...c.folder_ids, folder.id])] } : c)) : prev
      );
      addCommandToFolder(folder.id, commandId).catch(e =>
        console.warn('Falha ao adicionar o comando à nova pasta no servidor (mantido localmente)', e)
      );
    } catch (e) {
      window.alert(folderCrudErrorMessage(e, 'Failed to create folder. Please try again.'));
    }
  }

  // "+ Add > Subfolder" (cabeçalho de uma seção de pasta) — porta de
  // promptCreateSubfolder() (js/folders.js).
  async function createSubfolder(parentId: number) {
    const name = await folderPrompt('subfolder');
    if (!name) return;
    try {
      const folder = await createFolder(name, parentId);
      setFolders(prev => (prev ? [...prev, folder] : prev));
    } catch (e) {
      window.alert(folderCrudErrorMessage(e, 'Failed to create folder. Please try again.'));
    }
  }

  // Renomear (inline, no cabeçalho da seção — ver FolderSection.tsx) — porta
  // de _folderNameInputBlur() (js/folders.js). Devolve `true`/`false` pro
  // chamador decidir se reverte a exibição do nome.
  async function renameFolderAction(id: number, name: string): Promise<boolean> {
    try {
      const saved = await apiRenameFolder(id, name);
      setFolders(prev => (prev ? prev.map(f => (f.id === id ? { ...f, name: saved.name } : f)) : prev));
      return true;
    } catch (e) {
      window.alert(folderCrudErrorMessage(e, 'Failed to rename folder. Please try again.'));
      return false;
    }
  }

  // Excluir pasta — porta de deleteFolderConfirm()/_collectFolderAndDescendantIds()
  // (js/folders.js): avisa quantas subpastas somem junto, reaproveita
  // useConfirm() (fatia 4) em vez de um confirm() novo. Remoção OTIMISTA
  // (mesmo padrão do original — nem espera a resposta do DELETE pra
  // atualizar a tela).
  //
  // Decisão de escopo: a mensagem original também avisa que "Notes inside
  // it ARE deleted along with the folder" — omitido aqui de propósito, já
  // que notas não existem nesta fatia (5a, fica pra 5c); mencioná-las
  // confundiria mais do que ajudaria. O resto do aviso (comandos não são
  // excluídos, só saem da pasta; ação não pode ser desfeita; contagem de
  // subpastas) é preservado.
  async function deleteFolderAction(id: number, name: string) {
    const list = folders || [];
    const descendantCount = collectFolderAndDescendantIds(id, list).length - 1;
    const subfolderWarning = descendantCount
      ? ` This also deletes ${descendantCount} subfolder${descendantCount > 1 ? 's' : ''} inside it.`
      : '';
    const ok = await confirmAction(
      `Delete folder "${name}"? Commands inside it are not deleted — they just leave this folder.${subfolderWarning} This action cannot be undone.`
    );
    if (!ok) return;
    const idsToRemove = new Set(collectFolderAndDescendantIds(id, list));
    setFolders(prev => (prev ? prev.filter(f => !idsToRemove.has(f.id)) : prev));
    setFolderEditRoots(prev => {
      const next = new Set(prev);
      idsToRemove.forEach(fid => next.delete(fid));
      return next;
    });
    invalidateFoldersCache();
    apiDeleteFolder(id).catch(e => console.warn('Falha ao excluir pasta no servidor (mantida localmente)', e));
  }

  // Toggle "⚙ Edit folder" (task #461/#463 do original, ver
  // toggleFolderEditMode() em js/folders.js) — Set de folderIds de RAIZ, só
  // em memória.
  function toggleRootEditMode(rootFolderId: number) {
    setFolderEditRoots(prev => {
      const next = new Set(prev);
      if (next.has(rootFolderId)) next.delete(rootFolderId);
      else next.add(rootFolderId);
      return next;
    });
  }

  const foldersUIValue = {
    folders,
    openCommandId: openFolderMenuId,
    setOpenCommandId: setOpenFolderMenuId,
    toggleCommandFolder,
    createRootFolder,
  };

  const renderResult = useMemo(() => {
    if (!commands) return null;
    return buildRenderTree({ commands, filters: liveFilters.filters, settings, catalogs, fieldValues });
  }, [commands, liveFilters.filters, settings, catalogs, fieldValues]);

  // Árvore de Pastas (visão "Folders", escopo "My folders") — porta do ramo
  // VIEW_FOLDERS_HOME/scope==='mine' de render() (js/render.js). Só
  // calculada quando a visão está ativa: aplica o MESMO filtro de "System
  // commands"/Vendor/System (filterCommands, exportada de renderPipeline.ts)
  // usado pela visão normal, e então monta a árvore paralela de seções de
  // pasta (buildFolderSectionTree). A busca (liveFilters.filters.search) é
  // aplicada por cima, filtrando os CARDS recursivamente (ver
  // filterFolderTree/src/lib/foldersPipeline.ts).
  const folderTree = useMemo<FolderSectionNode[] | null>(() => {
    if (!foldersView.active || !commands || !folders) return null;
    const filtered = filterCommands(commands, settings, liveFilters.filters);
    const values = buildValues(fieldValues, settings, catalogs);
    const hasIPs = !!(values.src_ip && values.dst_ip);
    const nodes = buildFolderSectionTree({ commands: filtered, folders, values, hasIPs, catalogParams: catalogs?.parameters || [] });
    const query = liveFilters.filters.search.trim().toLowerCase();
    return query ? filterFolderTree(nodes, query, catalogs) : nodes;
  }, [foldersView.active, commands, folders, catalogs, settings, liveFilters.filters, fieldValues]);

  // Todas as chaves de seção atualmente na árvore — usado por Expand all/
  // Collapse all, que no original recolhem/expandem TODOS os `.section` na
  // tela (collapseAllSections()/expandAllSections()), não só as seções de
  // Tópico. Enquanto a visão "Folders" está ativa, isso inclui toda a
  // árvore de pastas/subpastas (mesmo `document.querySelectorAll('.section')`
  // do original, que não distingue seção de Tópico de seção de pasta);
  // fora dela, as chaves são as de sempre (tópico/ambiente/agrupamentos de
  // Created by/Versão).
  const allSectionKeys = useMemo(() => {
    if (foldersView.active) {
      if (!folderTree) return [];
      const keys: string[] = [];
      const walk = (nodes: FolderSectionNode[]) =>
        nodes.forEach(n => {
          keys.push(`folder-${n.folderId}`);
          walk(n.items.filter((it): it is { type: 'folder'; section: FolderSectionNode } => it.type === 'folder').map(it => it.section));
        });
      walk(folderTree);
      return keys;
    }
    if (!renderResult) return [];
    const keys: string[] = [];
    renderResult.comboBlocks.forEach(block => {
      if (block.groupBy === 'creator' && block.creatorGroups) {
        block.creatorGroups.forEach(g => {
          keys.push(g.key);
          g.sections.forEach(s => keys.push(s.key));
        });
      } else if (block.sections) {
        if (block.groupBy === 'version') keys.push(block.key);
        block.sections.forEach(s => keys.push(s.key));
      }
    });
    return keys;
  }, [foldersView.active, folderTree, renderResult]);

  function renderSection(sec: SectionData) {
    const collapsed = collapsedSections.isCollapsed(sec.key);
    const header = (
      <>
        {sec.icon ? `${sec.icon} ` : ''}
        {sec.title} <span className="sec-count">{sec.count}</span>
      </>
    );
    return (
      <CollapsibleSection
        key={sec.key}
        sectionKey={sec.key}
        headerContent={header}
        collapsed={collapsed}
        onToggleChevron={() => collapsedSections.toggle(sec.key)}
        renderBody={() =>
          sec.cards.map(c => (
            <CommandCard
              key={c.id}
              card={c}
              catalogs={catalogs}
              showImages={settings.showImages}
              onEdit={id => setEditor({ mode: 'edit', id })}
              onDuplicate={id => setEditor({ mode: 'duplicate', id })}
            />
          ))
        }
      />
    );
  }

  function renderComboBlock(block: ComboBlockData) {
    const comboHeader =
      block.showHeader && block.groupBy !== 'version' ? (
        <div className="combo-header">
          🔀 <strong>{block.versionLabel}</strong> / <strong>{block.envLabel}</strong>
        </div>
      ) : null;
    const envNote = block.envNoteHtml ? (
      <div className="env-note" dangerouslySetInnerHTML={{ __html: `ℹ️ <span>${block.envNoteHtml}</span>` }} />
    ) : null;

    if (block.groupBy === 'creator') {
      if (!block.creatorGroups || !block.creatorGroups.length) return null;
      return (
        <div key={block.key}>
          {comboHeader}
          {envNote}
          {block.creatorGroups.map(g => {
            const collapsed = collapsedSections.isCollapsed(g.key);
            return (
              <CollapsibleSection
                key={g.key}
                sectionKey={g.key}
                extraClass="section-creator"
                headerContent={
                  <>
                    👤 <strong>{g.creator}</strong> <span className="sec-count">{g.count}</span>
                  </>
                }
                collapsed={collapsed}
                onToggleChevron={() => collapsedSections.toggle(g.key)}
                renderBody={() => g.sections.map(renderSection)}
              />
            );
          })}
        </div>
      );
    }

    if (block.groupBy === 'version') {
      if (!block.cardCount) return null;
      const collapsed = collapsedSections.isCollapsed(block.key);
      return (
        <CollapsibleSection
          key={block.key}
          sectionKey={block.key}
          extraClass="section-version"
          headerContent={
            <>
              🔀 <strong>{block.versionLabel}</strong> / <strong>{block.envLabel}</strong> <span className="sec-count">{block.cardCount}</span>
            </>
          }
          collapsed={collapsed}
          onToggleChevron={() => collapsedSections.toggle(block.key)}
          renderBody={() => (
            <>
              {envNote}
              {(block.sections || []).map(renderSection)}
            </>
          )}
        />
      );
    }

    // "topic" (padrão)
    return (
      <div key={block.key}>
        {comboHeader}
        {envNote}
        {(block.sections || []).map(renderSection)}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="content" id="out">
        <div className="empty">
          <div className="empty-ico">⚠️</div>
          <p>Failed to load commands from the server. Check whether the backend is running.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`content${settings.showCardDetails ? '' : ' compact-cards'}`} id="out">
      <FoldersUIContext.Provider value={foldersUIValue}>
        <QueryBar onChange={setFieldValues} catalogs={catalogs} />
        {/* "Group by" continua visível/clicável dentro da visão "Folders" —
            mesmo comportamento (deliberado) do original: VIEW_FOLDERS_HOME
            "sempre retorna... nunca cai nos ramos de GROUP_BY", ou seja, a
            seleção de Group by simplesmente não tem efeito nenhum enquanto
            Folders está ativo. Expand all/Collapse all e "+ Add command"
            continuam funcionais nos dois modos. */}
        <ContentToolbar
          groupBy={settings.groupBy}
          onChangeGroupBy={v => updateSettings({ groupBy: v })}
          onExpandAll={() => collapsedSections.expandAll(allSectionKeys)}
          onCollapseAll={() => collapsedSections.collapseAll(allSectionKeys)}
          onAddCommand={() => setEditor({ mode: 'create' })}
        />
        {foldersLoadError && (
          <div className="empty">
            <div className="empty-ico">⚠️</div>
            <p>Failed to load folders from the server. The "Add to folder" menu may be incomplete.</p>
          </div>
        )}
        {foldersView.active ? (
          <>
            {folderTree && folderTree.length === 0 && (
              <div className="empty">
                <div className="empty-ico">📁</div>
                <p>No folders yet. Use "Add to folder" on any command to create one.</p>
              </div>
            )}
            {folderTree &&
              folderTree.map(node => (
                <FolderSection
                  key={`folder-${node.folderId}`}
                  node={node}
                  isRoot
                  editMode={folderEditRoots.has(node.rootFolderId)}
                  collapsedSections={collapsedSections}
                  catalogs={catalogs}
                  showImages={settings.showImages}
                  onEditCommand={id => setEditor({ mode: 'edit', id })}
                  onDuplicateCommand={id => setEditor({ mode: 'duplicate', id })}
                  onToggleRootEditMode={toggleRootEditMode}
                  onRename={renameFolderAction}
                  onDelete={deleteFolderAction}
                  onCreateSubfolder={createSubfolder}
                />
              ))}
            {folderTree && liveFilters.filters.search.trim() && folderTreeCardCount(folderTree) === 0 && (
              <div className="empty">
                <div className="empty-ico">🔍</div>
                <p>No commands found for "{liveFilters.filters.search}".</p>
              </div>
            )}
          </>
        ) : (
          <>
            {renderResult?.truncatedNote && (
              <div className="env-note" style={{ borderColor: 'rgba(251,191,36,.3)', background: 'rgba(251,191,36,.06)', color: 'var(--yellow)' }}>
                ⚠️ <span>{renderResult.truncatedNote}</span>
              </div>
            )}
            {renderResult && renderResult.comboBlocks.map(renderComboBlock)}
            {renderResult?.noResults && (
              <div className="empty">
                <div className="empty-ico">🔍</div>
                <p>No commands found for "{liveFilters.filters.search}".</p>
              </div>
            )}
          </>
        )}
      </FoldersUIContext.Provider>
      {editor &&
        (editor.mode === 'create' || (commands && commands.some(c => c.id === editor.id))) &&
        // Portal pro <body> — `.main` (ancestral direto deste componente)
        // define `position: relative; z-index: 1` (ver comentário "─── MAIN
        // ───" em layout.css), o que cria um stacking context próprio e
        // prendia o `.modal-overlay` (z-index: 500) ABAIXO da `.sidebar`
        // (z-index: 10, num stacking context irmão) — diferente de
        // SettingsModal/ConfirmProvider, que já nascem como irmãos de
        // `.app` em AppShell.tsx, fora desse contexto. Sem o portal, a
        // sidebar ficava clicável por cima do editor (bug real, achado ao
        // rodar os testes desta fatia).
        createPortal(
          <CommandEditorModal
            mode={editor.mode}
            sourceRow={editor.mode === 'create' ? undefined : commands?.find(c => c.id === editor.id)}
            catalogs={catalogs}
            onClose={() => setEditor(null)}
            onSaved={refreshCommands}
          />,
          document.body
        )}
    </div>
  );
}
