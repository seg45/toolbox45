// ════════════════════════════════════════════════
// USERS (/api/users*) — porta tipada de js/users-admin.js — fatia 7.
// CRUD de usuários locais + promover/rebaixar/desabilitar QUALQUER usuário
// (local, Google, ou uma conta antiga do login do Windows/NTLM — removido,
// mas pode sobrar na tabela), super_admin-only (ver require_super_admin em
// server-py/app/routers/users.py). Mesmo padrão deste módulo de
// src/lib/groups.ts: funções soltas por endpoint, ApiError/parseErrorBody
// reaproveitados de lib/api.ts.
//
// As mutações (role/disabled/password/delete) não precisam devolver o
// usuário atualizado pra quem chama — UsersPane sempre recarrega a lista
// inteira depois (GET /api/users) em vez de aplicar a resposta otimisticamente
// (mesmo padrão do original: renderUserList() de novo após cada ação), então
// essas funções só resolvem (void) ou lançam ApiError.
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody } from './api';

export interface User {
  username: string;
  role: 'user' | 'admin' | 'super_admin';
  is_local: boolean;
  disabled: boolean;
  created_at?: string;
  created_by?: string;
  auth_provider?: string;
  approved_at?: string | null;
}

export async function listUsers(): Promise<User[]> {
  const res = await fetch('/api/users');
  if (!res.ok) throw new ApiError(res.status, `listUsers: HTTP ${res.status}`);
  return res.json();
}

export async function createUser(username: string, password: string, role: string): Promise<void> {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to create user.', body.error);
  }
}

// PUT /api/users/:username — corpo parcial {role?, disabled?, password?}. As
// três ações da tabela (trocar role, habilitar/desabilitar, redefinir senha)
// são só chamadas diferentes do mesmo endpoint — mesma ideia do original
// (changeUserRole/toggleUserDisabled/submitResetPassword todas fazendo um
// fetch PUT equivalente).
async function updateUser(username: string, body: Partial<{ role: string; disabled: boolean; password: string }>): Promise<void> {
  const res = await fetch(`/api/users/${encodeURIComponent(username)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await parseErrorBody(res);
    throw new ApiError(res.status, errBody.message || 'Failed to update user.', errBody.error);
  }
}

export function updateUserRole(username: string, role: string): Promise<void> {
  return updateUser(username, { role });
}

export function updateUserDisabled(username: string, disabled: boolean): Promise<void> {
  return updateUser(username, { disabled });
}

export function resetUserPassword(username: string, password: string): Promise<void> {
  return updateUser(username, { password });
}

export async function deleteUser(username: string): Promise<void> {
  const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to delete user.', body.error);
  }
}
