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
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Catalogs } from '../../lib/catalogs';
import { useCollapsedSections } from '../../lib/collapsedSections';
import { fetchCommands, invalidateCommandsCache, type Command } from '../../lib/commands';
import { useFolderScope, type FolderScope } from '../../lib/folderScope';
import {
  addCommandToFolder,
  collectFolderAndDescendantIds,
  copyFolderFromUser as apiCopyFolderFromUser,
  createFolder,
  deleteFolder as apiDeleteFolder,
  fetchAllUsersFolders,
  fetchFolders,
  invalidateFoldersCache,
  moveFolder as apiMoveFolder,
  onFoldersChanged,
  removeCommandFromFolder,
  renameFolder as apiRenameFolder,
  reorderFolderItems,
  type Folder,
  type FolderOrderItem,
  type FolderWithOwner,
} from '../../lib/folders';
import type { useFoldersView } from '../../lib/foldersView';
import {
  buildFolderSectionTree,
  buildFolderSectionTreeForOwner,
  filterFolderTree,
  folderTreeCardCount,
  type FolderSectionNode,
} from '../../lib/foldersPipeline';
import { FoldersUIContext } from '../../lib/foldersUI';
import type { useLiveFilters } from '../../lib/liveFilters';
import {
  cloneNote as apiCloneNote,
  createNote,
  deleteNote as apiDeleteNote,
  deriveNoteTitle,
  moveNote as apiMoveNote,
  updateNote,
  type Note,
} from '../../lib/notes';
import { buildRenderTree, buildValues, filterCommands, type ComboBlockData, type SectionData } from '../../lib/renderPipeline';
import type { Settings } from '../../lib/settingsStore';
import { useConfirm } from '../../lib/useConfirm';
import { useFolderDrag, type FolderItemType, type FolderOrderedItem } from '../../lib/useFolderDrag';
import { useFolderPrompt } from '../../lib/useFolderPrompt';
import { CollapsibleSection } from './CollapsibleSection';
import { CommandCard } from './CommandCard';
import { CommandEditorModal, type EditorMode } from './CommandEditorModal';
import { ContentToolbar } from './ContentToolbar';
import { FolderSection } from './FolderSection';
import { QueryBar } from './QueryBar';

type EditorState = { mode: EditorMode; id?: number };

// Resultado de montar a árvore de Pastas pro escopo ATUAL (fatia 5b) — dois
// formatos, espelhando os dois formatos que o próprio original produz pro
// ramo VIEW_FOLDERS_HOME de render.js: "flat" (escopo "mine" ou
// "user:<username>" — uma lista de raízes, sem nenhum agrupamento por
// dono) e "grouped" (só o escopo "all" — uma lista de grupos "👤
// <username>", cada um com suas próprias raízes). Guardado aqui (não em
// foldersPipeline.ts) porque é puramente uma decisão de COMO RENDERIZAR, a
// própria árvore de cada grupo já vem pronta de buildFolderSectionTree/
// buildFolderSectionTreeForOwner.
type FolderScopeGroup = { username: string; isOwn: boolean; nodes: FolderSectionNode[] };
type FolderScopeRenderData = { kind: 'flat'; nodes: FolderSectionNode[] } | { kind: 'grouped'; groups: FolderScopeGroup[] };

function folderScopeDataCardCount(data: FolderScopeRenderData): number {
  if (data.kind === 'flat') return folderTreeCardCount(data.nodes);
  return data.groups.reduce((sum, g) => sum + folderTreeCardCount(g.nodes), 0);
}

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
  // Fatia 5c (Notes) — mesmo espírito de FOLDER_EDIT_MODE acima, mas pra
  // notas: `editingNoteIds` (Set de note.id sendo editadas AGORA — notas
  // EXISTENTES) e `creatingNoteFolderId` (id da pasta com uma nota NOVA em
  // edição, rascunho ainda sem id no servidor, ou null) — porte de
  // NOTE_EDIT_MODE/NOTE_CREATE_FOLDER_ID (js/folders.js). Só em memória,
  // mesma decisão de folderEditRoots.
  const [editingNoteIds, setEditingNoteIds] = useState<Set<number>>(new Set());
  const [creatingNoteFolderId, setCreatingNoteFolderId] = useState<number | null>(null);
  // Qual comando tem o próprio dropdown "Add to folder" aberto — substitui
  // querySelectorAll('.folder-menu-pop.open') do original (fechar os
  // outros ao abrir um novo) por um único estado React (ver
  // src/lib/foldersUI.tsx).
  const [openFolderMenuId, setOpenFolderMenuId] = useState<number | null>(null);
  const folderPrompt = useFolderPrompt();
  const confirmAction = useConfirm();
  const { me } = useAuth();

  // ── Fatia 5b: escopo de pastas dentro de "Folders" (My folders/usuário
  // escolhido/All) — ver src/lib/folderScope.ts. `allUsersFolders` (GET
  // /api/folders/all) só é buscada sob demanda (ensureAllUsersFoldersLoaded
  // abaixo), nunca no boot — a maioria fica em "My folders", mesma decisão
  // do original (reloadAllUsersFoldersFromServer()).
  const folderScopeState = useFolderScope();
  const [allUsersFolders, setAllUsersFolders] = useState<FolderWithOwner[] | null>(null);
  const [allUsersFoldersLoadError, setAllUsersFoldersLoadError] = useState(false);
  // Guarda contra disparar dois fetches de /api/folders/all em paralelo
  // (dropdown aberto + scope!=='mine' no mesmo instante, ver os dois
  // chamadores de ensureAllUsersFoldersLoaded abaixo) — não precisa ser
  // estado (não afeta o que é renderizado, só evita trabalho duplicado).
  const allUsersFoldersLoadingRef = useRef(false);
  function ensureAllUsersFoldersLoaded() {
    if (allUsersFolders !== null || allUsersFoldersLoadingRef.current) return;
    allUsersFoldersLoadingRef.current = true;
    fetchAllUsersFolders()
      .then(data => {
        setAllUsersFolders(data);
        setAllUsersFoldersLoadError(false);
      })
      .catch(err => {
        console.error('Failed to load all users folders from API', err);
        setAllUsersFoldersLoadError(true);
      })
      .finally(() => {
        allUsersFoldersLoadingRef.current = false;
      });
  }
  // Cobre o caso de o escopo salvo (localStorage, ver useFolderScope) já
  // não ser "mine" desde o boot (F5 com "All"/um usuário específico
  // escolhido antes) — sem isso, a lista cross-user só carregaria quando o
  // usuário abrisse o dropdown de novo, deixando a tela "presa" em Folders
  // sem mostrar nada até essa interação.
  useEffect(() => {
    if (foldersView.active && folderScopeState.scope !== 'mine') ensureAllUsersFoldersLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersView.active, folderScopeState.scope]);

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

  // Fatia 5c — Settings → Database → Folders → "Import folder"
  // (FolderImportModal.tsx) roda como IRMÃO deste componente (ambos filhos
  // de AppShell.tsx, ver SettingsModal.tsx), sem acesso direto a `folders`/
  // `setFolders`/`commands`/`setCommands`. Em vez de içar esse estado pra
  // AppShell só por causa de um fluxo, assina o canal de
  // src/lib/folders.ts::onFoldersChanged (emitido pelo import bem-sucedido)
  // e refaz os DOIS fetches — mesmo efeito líquido de
  // reloadFoldersFromServer() + invalidateCommandsCache()/fetchCommands()
  // no original (um import de pasta também cria comandos NOVOS, que
  // precisam aparecer fora da visão "Folders" também).
  useEffect(() => {
    return onFoldersChanged(() => {
      invalidateFoldersCache();
      fetchFolders()
        .then(data => {
          setFolders(data);
          setFoldersLoadError(false);
        })
        .catch(err => {
          console.error('Failed to reload folders from API', err);
          setFoldersLoadError(true);
        });
      refreshCommands();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Toolbar "+ Add > Folder" — pasta de topo VAZIA (promptCreateFolder() sem
  // cmdIdToAddAfter, js/folders.js).
  async function createEmptyRootFolder() {
    const name = await folderPrompt('create');
    if (!name) return;
    try {
      const folder = await createFolder(name);
      setFolders(prev => (prev ? [...prev, folder] : [folder]));
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

  // "⧉ Copy this folder to your own Folders" (fatia 5b) — porta de
  // copyFolderFromUser() (js/folders.js). Mesmo texto de confirmação do
  // original (reaproveita useConfirm(), já usado por deleteFolderAction
  // acima); `danger: false` — diferente da exclusão, copiar não é uma ação
  // destrutiva (não muda nem apaga nada da pasta original), então o botão
  // de confirmar sai no estilo "primary" (teal) em vez de "danger"
  // (vermelho) — pequena divergência deliberada de estilo em relação ao
  // original, que não distinguia os dois na única modal de confirmação que
  // tinha.
  async function copyFolderAction(folderId: number, name: string) {
    const ok = await confirmAction(
      `Copy folder "${name}" to your own Folders? This creates a new folder with the same commands — it won't affect the original.`,
      { danger: false }
    );
    if (!ok) return;
    try {
      const copied = await apiCopyFolderFromUser(folderId);
      // A pasta copiada é uma pasta PRÓPRIA nova — entra direto em
      // `folders` (mesmo estado que "My folders"/o dropdown "Add to
      // folder" de cada card já leem), pra aparecer sem precisar de F5
      // tanto se o usuário for olhar "My folders" a seguir quanto no
      // próprio dropdown de pastas dos cards.
      setFolders(prev => (prev ? [...prev, copied] : [copied]));
      invalidateFoldersCache();
    } catch (e) {
      window.alert(folderCrudErrorMessage(e, 'Failed to copy folder. Please try again.'));
    }
  }

  // ── Notes (fatia 5c) — porte de startCreateNote/startEditNote/
  // cancelNoteEdit/acceptNoteEdit/deleteNoteConfirm/cloneNote (js/folders.js).
  // "+ Add > Note" (cabeçalho de uma seção de pasta) — porta de
  // startCreateNote(). Só existe UM rascunho de nota nova por vez em TODA a
  // árvore (mesma decisão do original — NOTE_CREATE_FOLDER_ID é uma variável
  // única, não um Set), então abrir "Note" numa pasta descarta um rascunho
  // pendente em outra, se houver.
  function startCreateNote(folderId: number) {
    setCreatingNoteFolderId(folderId);
  }

  // Botão "✎ Edit" do mini-toolbar hover de uma nota existente — porta de
  // startEditNote().
  function startEditNote(noteId: number) {
    setEditingNoteIds(prev => {
      const next = new Set(prev);
      next.add(noteId);
      return next;
    });
  }

  // "✕ Cancel" do modo de edição de uma nota — porta de cancelNoteEdit():
  // descarta o rascunho sem tocar no servidor. `noteId === null` identifica
  // o rascunho de nota NOVA (o card some do corpo da pasta); caso contrário,
  // a nota EXISTENTE simplesmente sai do modo de edição (volta a mostrar
  // note.description, já salvo).
  function cancelNoteEdit(noteId: number | null, folderId: number) {
    if (noteId != null) {
      setEditingNoteIds(prev => {
        const next = new Set(prev);
        next.delete(noteId);
        return next;
      });
    } else {
      setCreatingNoteFolderId(prev => (prev === folderId ? null : prev));
    }
  }

  // "✓ Accept" do modo de edição — porta de acceptNoteEdit(): cria (noteId
  // null) OU atualiza (noteId existente) a nota, aguardando o servidor (ver
  // comentário em src/lib/notes.ts sobre por que isso PRECISA ser awaited,
  // diferente de addCommandToFolder/removeCommandFromFolder) antes de
  // mesclar o resultado em `folders[].notes`/`order` e sair do modo de
  // edição. A checagem "nota vazia" (sem texto E sem <img>) já rodou dentro
  // de NoteCard.tsx antes deste callback ser chamado — aqui só falta
  // persistir. Em caso de erro do servidor, mantém a nota aberta em edição
  // (mesmo comportamento do original: `alert(...); return;` sem sair do
  // modo de edição) — o conteúdo digitado não é perdido porque
  // RichTextEditor é uncontrolled e o NoteCard não desmonta.
  async function acceptNoteEdit(noteId: number | null, folderId: number, html: string) {
    const title = deriveNoteTitle(html);
    try {
      if (noteId == null) {
        const note = await createNote(folderId, { title, description: html });
        setFolders(prev =>
          prev
            ? prev.map(f =>
                f.id === folderId
                  ? {
                      ...f,
                      notes: [...f.notes, note],
                      order: f.order.some(o => o.type === 'note' && o.id === note.id) ? f.order : [...f.order, { type: 'note', id: note.id }],
                    }
                  : f
              )
            : prev
        );
        setCreatingNoteFolderId(prev => (prev === folderId ? null : prev));
      } else {
        const note = await updateNote(noteId, { title, description: html });
        setFolders(prev => (prev ? prev.map(f => (f.id === note.folder_id ? { ...f, notes: f.notes.map(n => (n.id === note.id ? note : n)) } : f)) : prev));
        setEditingNoteIds(prev => {
          const next = new Set(prev);
          next.delete(noteId);
          return next;
        });
      }
      invalidateFoldersCache();
    } catch (e) {
      window.alert(folderCrudErrorMessage(e, 'Failed to save note.'));
    }
  }

  // "✕ Delete Note" (só visível dentro do modo de edição) — porta de
  // deleteNoteConfirm(): mesmo texto de confirmação do original (usando o
  // "título" derivado do conteúdo — ver deriveNoteTitle em
  // src/lib/notes.ts), remoção OTIMISTA + DELETE fire-and-forget (mesmo
  // padrão de deleteFolderAction/removeCommandFromFolder — o original também
  // não espera a resposta do DELETE pra atualizar a tela).
  async function deleteNoteAction(noteId: number, folderId: number) {
    const note = folders?.find(f => f.id === folderId)?.notes.find(n => n.id === noteId);
    const title = note ? deriveNoteTitle(note.description) : '';
    const ok = await confirmAction(`Delete note "${title}"? This action cannot be undone.`);
    if (!ok) return;
    setEditingNoteIds(prev => {
      const next = new Set(prev);
      next.delete(noteId);
      return next;
    });
    setFolders(prev =>
      prev
        ? prev.map(f =>
            f.id === folderId
              ? { ...f, notes: f.notes.filter(n => n.id !== noteId), order: f.order.filter(o => !(o.type === 'note' && o.id === noteId)) }
              : f
          )
        : prev
    );
    invalidateFoldersCache();
    apiDeleteNote(noteId).catch(e => console.warn('Falha ao excluir nota no servidor (mantida localmente)', e));
  }

  // Botão "⧉ Clone" do mini-toolbar hover — porta de cloneNote(): cria a
  // cópia direto no servidor (título com sufixo " (copy)", decidido lá) e já
  // reflete na tela, sem passar por um modo de edição.
  async function cloneNoteAction(noteId: number, folderId: number) {
    try {
      const note = await apiCloneNote(noteId);
      setFolders(prev => (prev ? prev.map(f => (f.id === folderId ? { ...f, notes: [...f.notes, note], order: [...f.order, { type: 'note', id: note.id }] } : f)) : prev));
      invalidateFoldersCache();
    } catch (e) {
      window.alert(folderCrudErrorMessage(e, 'Failed to clone note.'));
    }
  }

  // ── Drag-and-drop (fatia 5b) — ver src/lib/useFolderDrag.ts pra decisão
  // de arquitetura (manipulação direta do DOM durante o dragover, só
  // commitando estado aqui no dragend). `onReorder`/`onMove` abaixo são os
  // dois únicos pontos onde o resultado de um drag vira, de fato, um
  // `setState`/chamada à API — tudo antes disso (mover a linha pelo DOM
  // durante o dragover) é só visual, sem tocar em `folders`/`commands`.
  //
  // Reorder simples (mesma pasta, só mudou de posição) — otimista: aplica
  // a nova ordem local na hora, PUT /reorder em paralelo (mesmo padrão de
  // toggleCommandFolder acima — falha só loga um aviso, nunca desfaz o
  // estado local).
  function persistFolderReorder(containerId: number, order: FolderOrderedItem[]) {
    setFolders(prev => (prev ? prev.map(f => (f.id === containerId ? { ...f, order: order.slice() } : f)) : prev));
    invalidateFoldersCache();
    reorderFolderItems(containerId, order).catch(e => console.warn('Falha ao salvar a nova ordem da pasta no servidor (mantida localmente)', e));
  }

  // Mover um item (comando OU subpasta) pra OUTRA pasta da MESMA árvore —
  // porta de _fldMoveItemAcrossFolders()/reorderFolderItems() (js/folders.js,
  // ramo "else" do dragend). Diferente do reorder simples acima, este
  // ESPERA a membership/parent mudar de verdade no backend antes de
  // persistir a ordem do destino (mesma ordem em que o original faz —
  // _fldMoveItemAcrossFolders().then(...).then(() => reorderFolderItems(...))
  // — ainda que aqui não seja estritamente necessário esperar pra
  // atualizar o estado LOCAL, que já é otimista de qualquer forma; esperar
  // só evita persistir uma ordem de reorder num container que o move
  // acabou de falhar em popular).
  // Fatia 5c: `itemType` ganhou 'note' — folder_id ÚNICO (diferente da
  // membership N:N de comando), PUT /api/notes/:id/move (ver
  // src/lib/notes.ts::moveNote) — mesmo espírito de apiMoveFolder (subpasta,
  // parent_id único) logo abaixo.
  async function persistFolderMove(itemType: FolderItemType, itemId: number, oldContainerId: number, newContainerId: number, order: FolderOrderedItem[]) {
    try {
      if (itemType === 'command') {
        await Promise.all([addCommandToFolder(newContainerId, itemId), removeCommandFromFolder(oldContainerId, itemId)]);
      } else if (itemType === 'note') {
        await apiMoveNote(itemId, newContainerId);
      } else {
        await apiMoveFolder(itemId, newContainerId);
      }
    } catch (e) {
      console.warn('Falha ao mover item entre pastas no servidor', e);
    }
    reorderFolderItems(newContainerId, order).catch(e => console.warn('Falha ao salvar a ordem da pasta de destino no servidor', e));

    // Estado local otimista — espelha os dois ajustes documentados no
    // original: (a) folders[].commandIds/order/parentId/notes (mesmo papel
    // de FOLDERS local em reloadFoldersFromServer()) e (b)
    // commands[].folder_ids (o "bug corrigido" citado nas instruções da
    // tarefa — comment original: "notas consigo movimentar normalmente, mas
    // continuo com problema para movimentar os comandos dentro das
    // pastas", porque a seção de cada pasta lista comandos a partir de
    // c.folder_ids, não de FOLDERS[].command_ids — sem atualizar os dois em
    // conjunto aqui, um comando movido sumiria da origem mas não apareceria
    // no destino até um F5). Notas não sofrem desse bug (vêm direto de
    // folder.notes, atualizado abaixo junto com o resto), mesma observação
    // do original (comentário em _fldMoveItemAcrossFolders/js/folders.js).
    let movedNote: Note | undefined;
    setFolders(prev => {
      if (!prev) return prev;
      if (itemType === 'note') {
        const origin = prev.find(f => f.id === oldContainerId);
        movedNote = origin?.notes.find(n => n.id === itemId);
      }
      return prev.map(f => {
        if (itemType === 'folder' && f.id === itemId) {
          return { ...f, parentId: newContainerId };
        }
        if (itemType === 'command' && f.id === oldContainerId) {
          const nextIds = new Set(f.commandIds);
          nextIds.delete(itemId);
          return { ...f, commandIds: nextIds, order: f.order.filter(o => !(o.type === 'command' && o.id === itemId)) };
        }
        if (itemType === 'note' && f.id === oldContainerId) {
          return { ...f, notes: f.notes.filter(n => n.id !== itemId), order: f.order.filter(o => !(o.type === 'note' && o.id === itemId)) };
        }
        if (f.id === newContainerId) {
          if (itemType === 'command') {
            const nextIds = new Set(f.commandIds);
            nextIds.add(itemId);
            return { ...f, commandIds: nextIds, order: order.slice() }; // `order` já é a ordem final do destino, lida do DOM no dragend
          }
          if (itemType === 'note') {
            const note = movedNote;
            return { ...f, notes: note ? [...f.notes, { ...note, folder_id: newContainerId }] : f.notes, order: order.slice() };
          }
          return { ...f, order: order.slice() };
        }
        return f;
      });
    });
    if (itemType === 'command') {
      setCommands(prev =>
        prev
          ? prev.map(c => {
              if (c.id !== itemId) return c;
              const ids = new Set(c.folder_ids);
              ids.delete(oldContainerId);
              ids.add(newContainerId);
              return { ...c, folder_ids: [...ids] };
            })
          : prev
      );
    }
    invalidateFoldersCache();
  }

  const { armDrag } = useFolderDrag({ onReorder: persistFolderReorder, onMove: persistFolderMove });

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
  // Fatia 5b: os 3 escopos (mine/all/user:<username>) — porta dos 3 ramos
  // de VIEW_FOLDERS_HOME em render.js (ver comentário de FolderScopeGroup/
  // FolderScopeRenderData acima). "mine" segue igual à fatia 5a
  // (buildFolderSectionTree, sem mudança); os outros dois usam
  // buildFolderSectionTreeForOwner (foldersPipeline.ts) — "user:<x>" uma
  // vez, "all" uma vez POR USUÁRIO (agrupado por dono, mesmo critério do
  // original: `byUser`/`usernames.map(...)`). A busca
  // (liveFilters.filters.search) é aplicada por cima em qualquer escopo,
  // filtrando os CARDS recursivamente (filterFolderTree) — inclusive
  // dentro de cada grupo do escopo "all".
  const folderScopeData = useMemo<FolderScopeRenderData | null>(() => {
    if (!foldersView.active || !commands) return null;
    const filtered = filterCommands(commands, settings, liveFilters.filters);
    const values = buildValues(fieldValues, settings, catalogs);
    const hasIPs = !!(values.src_ip && values.dst_ip);
    const catalogParams = catalogs?.parameters || [];
    const query = liveFilters.filters.search.trim().toLowerCase();
    const currentUsername = me?.username;
    const scope = folderScopeState.scope;

    if (scope === 'mine') {
      if (!folders) return null;
      const nodes = buildFolderSectionTree({ commands: filtered, folders, values, hasIPs, catalogParams });
      return { kind: 'flat', nodes: query ? filterFolderTree(nodes, query, catalogs) : nodes };
    }

    // "all"/"user:<username>" — precisam da lista cross-user carregada
    // (ver ensureAllUsersFoldersLoaded); `null` aqui é lido como "ainda
    // carregando", não como "sem pastas" (ver JSX mais abaixo).
    if (!allUsersFolders) return null;

    if (scope === 'all') {
      const byUser = new Map<string, FolderWithOwner[]>();
      allUsersFolders.forEach(f => {
        const arr = byUser.get(f.username);
        if (arr) arr.push(f);
        else byUser.set(f.username, [f]);
      });
      const usernames = [...byUser.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      const groups: FolderScopeGroup[] = usernames
        .map(username => {
          const isOwn = username === currentUsername;
          const userFolders = byUser.get(username) || [];
          const rawNodes = buildFolderSectionTreeForOwner({ commands: filtered, folders: userFolders, values, hasIPs, catalogParams, isOwn });
          const nodes = query ? filterFolderTree(rawNodes, query, catalogs) : rawNodes;
          return { username, isOwn, nodes };
        })
        // Grupo do usuário ATUAL sempre aparece (mesma pasta própria vazia
        // que buildFolderNode nunca poda) mesmo com 0 pastas visíveis;
        // grupo de outro usuário some por inteiro se ficou sem nenhuma
        // pasta (todas vazias/podadas) — mesmo critério de
        // `!cardCount && !hasOwnEmptyFolder` no original.
        .filter(g => g.isOwn || g.nodes.length > 0);
      return { kind: 'grouped', groups };
    }

    // scope === 'user:<username>' — as pastas DESSA pessoa direto, sem
    // agrupamento "👤 username" (só faz sentido pra "all", que mistura
    // várias pessoas na mesma tela).
    const targetUsername = scope.slice('user:'.length);
    const isOwn = targetUsername === currentUsername;
    const userFolders = allUsersFolders.filter(f => f.username === targetUsername);
    const rawNodes = buildFolderSectionTreeForOwner({ commands: filtered, folders: userFolders, values, hasIPs, catalogParams, isOwn });
    return { kind: 'flat', nodes: query ? filterFolderTree(rawNodes, query, catalogs) : rawNodes };
  }, [foldersView.active, commands, folders, allUsersFolders, folderScopeState.scope, catalogs, settings, liveFilters.filters, fieldValues, me?.username]);

  // Todas as chaves de seção atualmente na árvore — usado por Expand all/
  // Collapse all, que no original recolhem/expandem TODOS os `.section` na
  // tela (collapseAllSections()/expandAllSections()), não só as seções de
  // Tópico. Enquanto a visão "Folders" está ativa, isso inclui toda a
  // árvore de pastas/subpastas (mesmo `document.querySelectorAll('.section')`
  // do original, que não distingue seção de Tópico de seção de pasta) — no
  // escopo "all" (fatia 5b), inclui também a chave sintética de cada grupo
  // "👤 <username>" (`scope-user-<username>`, ver JSX mais abaixo), já que
  // ela também é um CollapsibleSection recolhível como qualquer outra;
  // fora dela, as chaves são as de sempre (tópico/ambiente/agrupamentos de
  // Created by/Versão).
  const allSectionKeys = useMemo(() => {
    if (foldersView.active) {
      if (!folderScopeData) return [];
      const keys: string[] = [];
      const walk = (nodes: FolderSectionNode[]) =>
        nodes.forEach(n => {
          keys.push(`folder-${n.folderId}`);
          walk(n.items.filter((it): it is { type: 'folder'; section: FolderSectionNode } => it.type === 'folder').map(it => it.section));
        });
      if (folderScopeData.kind === 'flat') {
        walk(folderScopeData.nodes);
      } else {
        folderScopeData.groups.forEach(g => {
          keys.push(`scope-user-${g.username}`);
          walk(g.nodes);
        });
      }
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
  }, [foldersView.active, folderScopeData, renderResult]);

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
        <Fragment key={block.key}>
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
        </Fragment>
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
      <Fragment key={block.key}>
        {comboHeader}
        {envNote}
        {(block.sections || []).map(renderSection)}
      </Fragment>
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

  // QueryBar e ContentToolbar ficam FORA de `.content` (irmãos dele dentro de
  // `.main`, como em index.html: .inp-bar / .content-toolbar / #out) — dentro,
  // herdavam o padding de 14px e ficavam 28px mais estreitos que o original.
  return (
    <>
      <FoldersUIContext.Provider value={foldersUIValue}>
        <QueryBar onChange={setFieldValues} catalogs={catalogs} />
        {/* Fatia 5b: "Group by" dá lugar por inteiro ao seletor de ESCOPO
            de pastas (My folders/usuário escolhido/All) enquanto a visão
            "Folders" está ativa — os dois dropdowns nunca ficam visíveis
            juntos (ver ContentToolbar.tsx). Expand all/Collapse all e
            "+ Add command" continuam funcionais nos dois modos. */}
        <ContentToolbar
          groupBy={settings.groupBy}
          onChangeGroupBy={v => updateSettings({ groupBy: v })}
          onExpandAll={() => collapsedSections.expandAll(allSectionKeys)}
          onCollapseAll={() => collapsedSections.collapseAll(allSectionKeys)}
          onAddCommand={() => setEditor({ mode: 'create' })}
          onAddFolder={createEmptyRootFolder}
          foldersActive={foldersView.active}
          folderScope={folderScopeState.scope}
          onChangeFolderScope={(s: FolderScope) => folderScopeState.setScope(s)}
          allUsersFolders={allUsersFolders}
          currentUsername={me?.username}
          onOpenFolderScope={ensureAllUsersFoldersLoaded}
        />
      </FoldersUIContext.Provider>
      <div className={`content${settings.showCardDetails ? '' : ' compact-cards'}`} id="out">
      <FoldersUIContext.Provider value={foldersUIValue}>
        {foldersLoadError && (
          <div className="empty">
            <div className="empty-ico">⚠️</div>
            <p>Failed to load folders from the server. The "Add to folder" menu may be incomplete.</p>
          </div>
        )}
        {foldersView.active ? (
          <>
            {allUsersFoldersLoadError && folderScopeState.scope !== 'mine' && (
              <div className="empty">
                <div className="empty-ico">⚠️</div>
                <p>Failed to load folders from other users. Try a different scope.</p>
              </div>
            )}
            {folderScopeData?.kind === 'flat' && folderScopeData.nodes.length === 0 && (
              <div className="empty">
                <div className="empty-ico">📁</div>
                <p>
                  {folderScopeState.scope === 'mine'
                    ? 'No folders yet. Use "Add to folder" on any command to create one.'
                    : 'This user has no folders.'}
                </p>
              </div>
            )}
            {folderScopeData?.kind === 'flat' &&
              folderScopeData.nodes.map(node => (
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
                  onCopyFolder={copyFolderAction}
                  armDrag={armDrag}
                  editingNoteIds={editingNoteIds}
                  creatingNoteFolderId={creatingNoteFolderId}
                  onCreateNote={startCreateNote}
                  onStartEditNote={startEditNote}
                  onCancelNoteEdit={cancelNoteEdit}
                  onAcceptNoteEdit={acceptNoteEdit}
                  onDeleteNote={deleteNoteAction}
                  onCloneNote={cloneNoteAction}
                />
              ))}
            {/* Escopo "all" — um grupo recolhível "👤 <username>" por dono,
                cada um com sua própria árvore de raízes (mesmo componente
                CollapsibleSection usado em qualquer outra seção
                recolhível — ver instruções da tarefa). Pastas vazias de
                outro usuário já não chegam aqui (podadas em
                buildFolderSectionTreeForOwner); a pasta PRÓPRIA vazia
                ainda aparece, e o grupo do usuário atual nunca é escondido
                por inteiro mesmo com 0 pastas (ver filter em
                folderScopeData acima). */}
            {folderScopeData?.kind === 'grouped' &&
              folderScopeData.groups.map(g => {
                const groupKey = `scope-user-${g.username}`;
                const collapsed = collapsedSections.isCollapsed(groupKey);
                return (
                  <CollapsibleSection
                    key={groupKey}
                    sectionKey={groupKey}
                    extraClass="section-creator"
                    headerContent={
                      <>
                        👤 <strong>{g.username}</strong> <span className="sec-count">{folderTreeCardCount(g.nodes)}</span>
                      </>
                    }
                    collapsed={collapsed}
                    onToggleChevron={() => collapsedSections.toggle(groupKey)}
                    renderBody={() =>
                      g.nodes.length === 0 ? (
                        <p className="sec-folder-empty-msg">No folders yet.</p>
                      ) : (
                        g.nodes.map(node => (
                          <FolderSection
                            key={`folder-${node.folderId}`}
                            node={node}
                            isRoot
                            editMode={g.isOwn && folderEditRoots.has(node.rootFolderId)}
                            collapsedSections={collapsedSections}
                            catalogs={catalogs}
                            showImages={settings.showImages}
                            onEditCommand={id => setEditor({ mode: 'edit', id })}
                            onDuplicateCommand={id => setEditor({ mode: 'duplicate', id })}
                            onToggleRootEditMode={toggleRootEditMode}
                            onRename={renameFolderAction}
                            onDelete={deleteFolderAction}
                            onCreateSubfolder={createSubfolder}
                            onCopyFolder={copyFolderAction}
                            armDrag={armDrag}
                            editingNoteIds={editingNoteIds}
                            creatingNoteFolderId={creatingNoteFolderId}
                            onCreateNote={startCreateNote}
                            onStartEditNote={startEditNote}
                            onCancelNoteEdit={cancelNoteEdit}
                            onAcceptNoteEdit={acceptNoteEdit}
                            onDeleteNote={deleteNoteAction}
                            onCloneNote={cloneNoteAction}
                          />
                        ))
                      )
                    }
                  />
                );
              })}
            {folderScopeData && liveFilters.filters.search.trim() && folderScopeDataCardCount(folderScopeData) === 0 && (
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
    </>
  );
}
