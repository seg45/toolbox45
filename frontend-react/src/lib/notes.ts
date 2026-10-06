// ════════════════════════════════════════════════
// NOTES (/api/folders/:id/notes, /api/notes/:id[...]) — porta de
// startCreateNote/startEditNote/cancelNoteEdit/acceptNoteEdit/
// deleteNoteConfirm/cloneNote/_deriveNoteTitle (js/folders.js) — fatia 5c.
//
// Diferente de addCommandToFolder/removeCommandFromFolder (folders.ts,
// fire-and-forget: o chamador já aplicou a mudança otimisticamente e só
// quer disparar o request em paralelo), createNote/updateNote/cloneNote
// PRECISAM ser aguardadas (await) pelo chamador — a nota criada/clonada só
// ganha um `id` real na resposta do servidor, e é esse id que precisa ser
// inserido no estado local (folders[].notes/order) ANTES de continuar
// (mesmo motivo de moveFolder ser awaited em folders.ts, ver comentário lá).
// deleteNote segue o padrão fire-and-forget de deleteFolder/
// removeCommandFromFolder: o chamador remove a nota do estado local
// primeiro (otimista) e só depois chama deleteNote(id).catch(...), sem
// esperar a resposta — mesmo comportamento de deleteNoteConfirm() no
// original (FOLDERS.forEach(...) + render() ANTES do fetch DELETE).
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody } from './api';
import { sanitizeRichHtml } from './safeHtml';

export interface Note {
  id: number;
  folder_id: number;
  title: string;
  description: string;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
  username?: string;
}

// Shape bruto devolvido pelo servidor (GET /api/folders, GET /api/folders/all
// — campo `notes` de cada pasta — e POST/PUT/clone abaixo) — ver
// load_folder_order_and_notes()/create_note() em app_folders.py/
// routers_folders.py. `title`/`description` sempre vêm como string (nunca
// null) na prática, mas o fallback abaixo cobre qualquer registro antigo.
export interface NoteApiRow {
  id: number;
  folder_id: number;
  title?: string | null;
  description?: string | null;
  sort_order?: number;
  created_at?: string;
  updated_at?: string;
  username?: string;
}

export function shapeNote(row: NoteApiRow): Note {
  return {
    id: row.id,
    folder_id: row.folder_id,
    title: row.title || '',
    description: row.description || '',
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    username: row.username,
  };
}

// Deriva um "título" curto a partir do texto puro da nota — só usado
// internamente (mensagem de confirmação ao excluir), nunca mostrado como
// campo próprio — porte 1:1 de _deriveNoteTitle() (js/folders.js).
export function deriveNoteTitle(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = sanitizeRichHtml(html);
  const text = (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? text.slice(0, 80).trim() + '…' : text;
}

export async function createNote(folderId: number, payload: { title: string; description: string }): Promise<Note> {
  const res = await fetch(`/api/folders/${folderId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to save note.', body.error);
  }
  return shapeNote(await res.json());
}

export async function updateNote(noteId: number, payload: { title: string; description: string }): Promise<Note> {
  const res = await fetch(`/api/notes/${noteId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to save note.', body.error);
  }
  return shapeNote(await res.json());
}

export async function deleteNote(noteId: number): Promise<void> {
  const res = await fetch(`/api/notes/${noteId}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to delete note.', body.error);
  }
}

export async function cloneNote(noteId: number): Promise<Note> {
  const res = await fetch(`/api/notes/${noteId}/clone`, { method: 'POST' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to clone note.', body.error);
  }
  return shapeNote(await res.json());
}

// Move uma nota pra OUTRA pasta (folder_id é único, diferente da membership
// N:N de comando) — porta de PUT /api/notes/:id/move (ver
// _fldMoveItemAcrossFolders, ramo 'note', em js/folders.js). Usado pelo
// drag-and-drop (useFolderDrag.ts::onMove) quando o item arrastado é uma
// nota sendo solta em OUTRA pasta da mesma árvore.
export async function moveNote(noteId: number, folderId: number): Promise<void> {
  const res = await fetch(`/api/notes/${noteId}/move`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_id: folderId }),
  });
  if (!res.ok) throw new Error(`moveNote: HTTP ${res.status}`);
}
