// ════════════════════════════════════════════════
// FOLDERS (/api/folders) — porta de js/folders.js (FOLDERS/buildFolderTree/
// reloadFoldersFromServer/_createFolderInternal/_folderNameInputBlur/
// deleteFolderConfirm/_collectFolderAndDescendantIds).
//
// Fatia 5c acrescentou: `Folder.notes` (campo `notes` que o servidor já
// devolve em GET /api/folders / GET /api/folders/all, ver
// load_folder_order_and_notes() em app_folders.py — CRUD de nota em si mora
// em src/lib/notes.ts) + onFoldersChanged/notifyFoldersChanged (pub-sub
// simples, ver comentário logo abaixo da declaração).
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody } from './api';
import { shapeNote, type Note, type NoteApiRow } from './notes';

export interface FolderOrderItem {
  type: 'command' | 'note' | 'folder';
  id: number;
}

export interface Folder {
  id: number;
  name: string;
  sortOrder: number;
  parentId: number | null;
  commandIds: Set<number>;
  order: FolderOrderItem[];
  notes: Note[];
}

interface FolderApiRow {
  id: number;
  name: string;
  sort_order: number;
  parent_id: number | null;
  command_ids?: number[];
  order?: FolderOrderItem[];
  notes?: NoteApiRow[];
}

function shapeFolder(row: FolderApiRow): Folder {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    parentId: row.parent_id ?? null,
    commandIds: new Set(row.command_ids || []),
    order: (row.order || []).slice(),
    notes: (row.notes || []).map(shapeNote),
  };
}

// ── Pub-sub minúsculo pra "algo mudou as pastas de fora da árvore de
// CommandsContent.tsx" — hoje só tem um emissor: FolderImportModal.tsx
// (Settings → Database → Folders → "Import folder"), que roda como IRMÃO de
// CommandsContent (ambos filhos de AppShell.tsx, ver SettingsModal.tsx), sem
// acesso direto ao `folders`/`setFolders` que mora lá. Em vez de içar esse
// estado inteiro pra AppShell só por causa de um fluxo (o que obrigaria
// passar `folders`/todo o CRUD de pasta por prop através da árvore inteira),
// CommandsContent assina este canal (useEffect, ver lá) e reage invalidando
// o cache + refazendo fetchFolders()/fetchCommands() — mesmo efeito líquido
// de reloadFoldersFromServer() no original, só que disparado por um evento
// em vez de uma chamada direta.
type FoldersChangeListener = () => void;
const _foldersChangeListeners = new Set<FoldersChangeListener>();

export function onFoldersChanged(cb: FoldersChangeListener): () => void {
  _foldersChangeListeners.add(cb);
  return () => {
    _foldersChangeListeners.delete(cb);
  };
}

export function notifyFoldersChanged(): void {
  _foldersChangeListeners.forEach(cb => cb());
}

// Cache simples — mesmo padrão/motivo de fetchCommands() (commands.ts):
// evita rebuscar a cada render(). Invalidado após qualquer CRUD de pasta ou
// mudança de membership, para que um próximo mount/remount que chame
// fetchFolders() de novo (ex.: F5) não sirva uma lista obsoleta — o estado
// "ao vivo" de verdade, enquanto o app está montado, mora no `useState` de
// CommandsContent.tsx (atualizado otimisticamente), não neste cache.
let _foldersCache: Promise<Folder[]> | null = null;

export function invalidateFoldersCache(): void {
  _foldersCache = null;
}

export async function fetchFolders(): Promise<Folder[]> {
  if (_foldersCache) return _foldersCache;
  const promise = fetch('/api/folders')
    .then(res => {
      if (!res.ok) throw new Error(`fetchFolders: HTTP ${res.status}`);
      return res.json();
    })
    .then((rows: FolderApiRow[]) => (rows || []).map(shapeFolder))
    .catch(err => {
      _foldersCache = null; // não guarda um fetch falho em cache — permite retry no próximo mount
      throw err;
    });
  _foldersCache = promise;
  return promise;
}

export async function createFolder(name: string, parentId?: number | null): Promise<Folder> {
  try {
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parentId ? { name, parent_id: parentId } : { name }),
    });
    if (!res.ok) {
      const body = await parseErrorBody(res);
      throw new ApiError(res.status, body.message || 'Failed to create folder.', body.error);
    }
    return shapeFolder(await res.json());
  } finally {
    invalidateFoldersCache();
  }
}

// Devolve só {id, name} (não o Folder inteiro) porque é só isso que
// PUT /api/folders/:id devolve de fato (ver rename_folder em
// server-py/app/routers/folders.py: `RETURNING id, name, sort_order`, sem
// parent_id) — o chamador (CommandsContent.tsx) já tem o resto do Folder
// local e só precisa mesclar o nome novo nele.
export async function renameFolder(id: number, name: string): Promise<{ id: number; name: string }> {
  try {
    const res = await fetch(`/api/folders/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = await parseErrorBody(res);
      throw new ApiError(res.status, body.message || 'Failed to rename folder.', body.error);
    }
    const row = await res.json();
    return { id: row.id, name: row.name };
  } finally {
    invalidateFoldersCache();
  }
}

export async function deleteFolder(id: number): Promise<void> {
  try {
    const res = await fetch(`/api/folders/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await parseErrorBody(res);
      throw new ApiError(res.status, body.message || 'Failed to delete folder.', body.error);
    }
  } finally {
    invalidateFoldersCache();
  }
}

// Sem `await`/try-catch aqui de propósito — quem chama (CommandsContent.tsx)
// já aplicou a mudança otimisticamente e só quer disparar o request em
// paralelo, tratando uma falha como um simples aviso no console (mesmo
// padrão do toggleCommandInFolder()/_createFolderInternal() original, que
// nunca desfazem o estado local otimista por causa de uma falha de rede).
export function addCommandToFolder(folderId: number, commandId: number): Promise<void> {
  return fetch(`/api/folders/${folderId}/commands/${commandId}`, { method: 'POST' }).then(res => {
    if (!res.ok) throw new Error(`addCommandToFolder: HTTP ${res.status}`);
  });
}

export function removeCommandFromFolder(folderId: number, commandId: number): Promise<void> {
  return fetch(`/api/folders/${folderId}/commands/${commandId}`, { method: 'DELETE' }).then(res => {
    if (!res.ok) throw new Error(`removeCommandFromFolder: HTTP ${res.status}`);
  });
}

// ════════════════════════════════════════════════
// FATIA 5b — drag-and-drop (reordenar/mover) + escopo cross-user
// ════════════════════════════════════════════════

// Muda o `parent_id` de uma subpasta — porta de PUT /api/folders/:id/move
// (ver _fldMoveItemAcrossFolders em js/folders.js). Usado pelo
// drag-and-drop quando o item arrastado é uma SUBPASTA inteira (não um
// comando) sendo movida pra dentro de outra pasta/subpasta da MESMA árvore
// — o backend recusa (400) se o destino estiver fora da árvore de topo de
// onde a subpasta já estava (ver getRootAncestorId no original), mas isso
// já é bloqueado antes mesmo de chegar aqui pelo próprio mecanismo de drag
// (useFolderDrag.ts: nunca deixa soltar fora do rootFolderId).
// Sem try/await no chamador de propósito (mesmo padrão de
// addCommandToFolder/removeCommandFromFolder acima) NÃO se aplica aqui:
// mover uma subpasta precisa que o caller SAIBA se deu certo antes de
// persistir a ordem do destino (ver persistFolderMove em
// CommandsContent.tsx), por isso devolve uma Promise que rejeita em erro,
// em vez de engolir a falha como as duas funções de membership acima.
export async function moveFolder(id: number, newParentId: number): Promise<void> {
  try {
    const res = await fetch(`/api/folders/${id}/move`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: newParentId }),
    });
    if (!res.ok) {
      const body = await parseErrorBody(res);
      throw new ApiError(res.status, body.message || 'Failed to move folder.', body.error);
    }
  } finally {
    invalidateFoldersCache();
  }
}

// Persiste a ordem final (comandos + subpastas intercalados) do corpo de
// UMA pasta — porta de PUT /api/folders/:id/reorder (ver
// reorderFolderItems em js/folders.js). Sem notas nesta fatia (5b, igual
// 5a) — `order` aqui só carrega {type:'command'|'folder', id}, nunca
// 'note', mas o tipo aceita o FolderOrderItem inteiro (compatível com o
// que o servidor devolve em GET /api/folders) para não precisar de um tipo
// paralelo só para isso.
export function reorderFolderItems(folderId: number, order: FolderOrderItem[]): Promise<void> {
  return fetch(`/api/folders/${folderId}/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  }).then(res => {
    if (!res.ok) throw new Error(`reorderFolderItems: HTTP ${res.status}`);
  });
}

// Pasta de QUALQUER usuário (cross-user, ver ALL_USERS_FOLDERS/
// reloadAllUsersFoldersFromServer em js/folders.js) — mesmo shape de
// `Folder`, só com `username` do dono a mais. `commandIds`/`order` aqui
// refletem a membership de verdade da pasta (ao contrário de
// `command.folder_ids`, que só reflete as pastas do usuário que está
// olhando a tela — ver comentário de folderScope em
// src/lib/foldersPipeline.ts sobre por que o pipeline cross-user precisa
// usar `folder.commandIds`, não `command.folder_ids`, pra montar a árvore).
export interface FolderWithOwner extends Folder {
  username: string;
}

interface FolderApiRowWithOwner extends FolderApiRow {
  username: string;
}

// Busca as pastas de TODOS os usuários (GET /api/folders/all) — porta de
// reloadAllUsersFoldersFromServer() (js/folders.js). Diferente de
// fetchFolders() acima, SEM cache de módulo: carregada sob demanda (só
// quando o escopo dentro de Folders deixa de ser "mine" — ver
// ensureAllUsersFoldersLoaded em CommandsContent.tsx), e a lista inteira é
// pequena o bastante (só metadados de pasta, não comandos) para não valer a
// pena a complexidade extra de invalidação que fetchFolders() tem.
export async function fetchAllUsersFolders(): Promise<FolderWithOwner[]> {
  const res = await fetch('/api/folders/all');
  if (!res.ok) throw new Error(`fetchAllUsersFolders: HTTP ${res.status}`);
  const rows: FolderApiRowWithOwner[] = await res.json();
  return (rows || []).map(row => ({ ...shapeFolder(row), username: row.username }));
}

// Copia uma pasta de OUTRO usuário pra lista de pastas PRÓPRIAS — porta de
// POST /api/folders/:id/copy (ver copyFolderFromUser em js/folders.js). O
// backend cria uma pasta NOVA com os mesmos comandos/ordem; a pasta
// original de quem foi copiada não é alterada.
export async function copyFolderFromUser(folderId: number): Promise<Folder> {
  try {
    const res = await fetch(`/api/folders/${folderId}/copy`, { method: 'POST' });
    if (!res.ok) {
      const body = await parseErrorBody(res);
      throw new ApiError(res.status, body.message || 'Failed to copy folder.', body.error);
    }
    return shapeFolder(await res.json());
  } finally {
    invalidateFoldersCache();
  }
}

// ── Árvore (subpastas, aninhamento ilimitado) — porta de buildFolderTree()
// em js/folders.js. Raízes: "Favorites" sempre primeiro, depois em ordem
// alfabética (sort_order não é gerenciado pelo usuário pra pastas de topo);
// subpastas: sort_order então nome. ──
export function buildFolderTree(list: Folder[]): { roots: Folder[]; childrenOf: (id: number) => Folder[] } {
  const ids = new Set(list.map(f => f.id));
  const byParent = new Map<number | null, Folder[]>();
  list.forEach(f => {
    const pid = f.parentId !== null && ids.has(f.parentId) ? f.parentId : null;
    let arr = byParent.get(pid);
    if (!arr) {
      arr = [];
      byParent.set(pid, arr);
    }
    arr.push(f);
  });
  const roots = byParent.get(null) || [];
  roots.sort((a, b) => {
    const aFav = a.name === FAVORITES_FOLDER_NAME;
    const bFav = b.name === FAVORITES_FOLDER_NAME;
    if (aFav !== bFav) return aFav ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  byParent.forEach((arr, pid) => {
    if (pid === null) return; // roots já ordenadas acima (regra diferente: Favorites primeiro)
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  });
  return { roots, childrenOf: (id: number) => byParent.get(id) || [] };
}

// Reúne o id de uma pasta + de TODA a árvore de subpastas abaixo dela
// (recursivo) — usado tanto pro texto de confirmação de exclusão (avisar
// quantas subpastas somem junto) quanto pra limpar o estado local otimista
// sem esperar um refetch.
export function collectFolderAndDescendantIds(id: number, list: Folder[]): number[] {
  const ids = [id];
  list.filter(f => f.parentId === id).forEach(child => {
    ids.push(...collectFolderAndDescendantIds(child.id, list));
  });
  return ids;
}

export const FAVORITES_FOLDER_NAME = 'Favorites';

// ── Data de auditoria (Created by/Modified by/Modified on, ver .fav-audit-
// pop) — porta de formatAuditDate() em js/terminal-renderer.js, com UMA
// diferença deliberada: o original sempre tratava a entrada como um
// timestamp do SQLite SEM fuso ('YYYY-MM-DD HH:MM:SS', sempre UTC) e
// simplesmente acrescentava "Z" depois de trocar o espaço por "T". Esta
// fatia já roda contra o backend Python/Postgres (server-py) — que
// serializa `updated_at` (um datetime do asyncpg) via .isoformat(), o que
// PODE já incluir um fuso embutido (ex.: "...T00:00:00+00:00") dependendo
// do tipo de coluna — acrescentar "Z" cegamente nesse caso quebraria o
// parsing (dois marcadores de fuso na mesma string). Por isso, aqui a
// função primeiro verifica se a string já termina com um fuso (Z ou
// ±HH:MM) antes de decidir se completa com "Z" — mesmo resultado do
// original para o formato antigo (sem fuso), sem quebrar para o novo.
export function formatAuditDate(s: string | null | undefined): string {
  if (!s) return '—';
  const str = String(s);
  const hasTz = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(str);
  const iso = hasTz ? str.replace(' ', 'T') : `${str.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return str;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
