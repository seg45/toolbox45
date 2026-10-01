// ════════════════════════════════════════════════
// GROUPS (/api/groups*) + /api/users (só pro picker "add member") — porta
// tipada de js/groups-admin.js — fatia 6. CRUD de grupos super_admin-only
// (ver server-py/app/routers/groups.py) — o EFEITO de visibilidade (quem vê
// o quê) mora inteiramente no backend; este módulo só gerencia a composição
// dos grupos.
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody } from './api';

export interface Group {
  id: number;
  name: string;
  created_at?: string;
  created_by?: string;
  members: string[];
}

export async function listGroups(): Promise<Group[]> {
  const res = await fetch('/api/groups');
  if (!res.ok) throw new ApiError(res.status, `listGroups: HTTP ${res.status}`);
  return res.json();
}

export async function createGroup(name: string): Promise<Group> {
  const res = await fetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to create group.', body.error);
  }
  return res.json();
}

export async function renameGroup(id: number, name: string): Promise<{ id: number; name: string }> {
  const res = await fetch(`/api/groups/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to rename group.', body.error);
  }
  return res.json();
}

export async function deleteGroup(id: number): Promise<void> {
  const res = await fetch(`/api/groups/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to delete group.', body.error);
  }
}

export async function addGroupMember(id: number, username: string): Promise<{ members: string[] }> {
  const res = await fetch(`/api/groups/${id}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to add member.', body.error);
  }
  return res.json();
}

export async function removeGroupMember(id: number, username: string): Promise<void> {
  const res = await fetch(`/api/groups/${id}/members/${encodeURIComponent(username)}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to remove member.', body.error);
  }
}

// ── Picker de "add member" (Manage group) ──────────────────────────────
// GET /api/users é super_admin-only, mesmo gate desta aba inteira — ver
// server-py/app/routers/users.py (USERS_PUBLIC_COLUMNS). Só o `username` é
// usado aqui (o picker lista candidatos a membro, nada mais); NÃO cacheado
// de lugar nenhum — busca de novo toda vez que o modal "Manage group" abre,
// mesma decisão deliberada do original (comentário em
// _gaLoadMemberAddOptions, js/groups-admin.js: a aba "Users" admin pode
// nunca ter sido aberta nesta sessão).
export interface UserPickerRow {
  username: string;
}

export async function listUsersForGroupPicker(): Promise<UserPickerRow[]> {
  const res = await fetch('/api/users');
  if (!res.ok) throw new ApiError(res.status, `listUsersForGroupPicker: HTTP ${res.status}`);
  return res.json();
}
