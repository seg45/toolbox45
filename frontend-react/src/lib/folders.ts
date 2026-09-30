// ════════════════════════════════════════════════
// FOLDERS (/api/folders) — porta de js/folders.js (FOLDERS/buildFolderTree/
// reloadFoldersFromServer/_createFolderInternal/_folderNameInputBlur/
// deleteFolderConfirm/_collectFolderAndDescendantIds) — SEM notas, SEM
// cross-user (#folderScopeDD/ALL_USERS_FOLDERS/copyFolderFromUser) e SEM
// drag-and-drop (reorder) — tudo isso fora do escopo desta fatia (5a), ver
// instruções da tarefa. `order` ainda é lido do servidor tal como vem (pode
// conter entradas {type:'note',...} de uma pasta que já tinha notas de uma
// versão anterior do app — server-py já suporta notas desde a Fase 1), mas
// essas entradas são ignoradas na hora de montar a árvore de renderização
// (ver src/lib/foldersPipeline.ts) — não existe ainda um jeito de CRIAR uma
// nota nesta fatia (fica para a 5c).
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody } from './api';

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
}

interface FolderApiRow {
  id: number;
  name: string;
  sort_order: number;
  parent_id: number | null;
  command_ids?: number[];
  order?: FolderOrderItem[];
}

function shapeFolder(row: FolderApiRow): Folder {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    parentId: row.parent_id ?? null,
    commandIds: new Set(row.command_ids || []),
    order: (row.order || []).slice(),
  };
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
