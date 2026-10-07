// ════════════════════════════════════════════════
// SHARES (/api/shares) — porta tipada da metade "Sharing" de js/sharing.js
// (submitNewShare/deleteShare/renderSharesGiven/renderSharesReceived) —
// fatia 6. A troca de senha do mesmo arquivo original JÁ foi
// portada na fatia 2 (ver AccountPane.tsx) — não repetida aqui.
//
// Divergência deliberada do original: GET /api/shares já devolve
// {given, received} numa resposta só, mas o original chamava o endpoint
// DUAS vezes (uma por renderSharesGiven(), outra por renderSharesReceived(),
// disparadas juntas por renderSharingPanel()) — puro desperdício de round-
// trip. Aqui listShares() é chamado UMA vez e o componente deriva as duas
// tabelas do mesmo resultado (ver AccountPane.tsx).
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody } from './api';

export interface ShareGiven {
  id: number;
  share_folders: boolean;
  share_commands: boolean;
  created_at?: string;
  updated_at?: string;
  grantee_email: string;
}

export interface ShareReceived {
  id: number;
  share_folders: boolean;
  share_commands: boolean;
  created_at?: string;
  updated_at?: string;
  grantor_email: string;
}

export interface SharesResponse {
  given: ShareGiven[];
  received: ShareReceived[];
}

export async function listShares(): Promise<SharesResponse> {
  const res = await fetch('/api/shares');
  if (!res.ok) throw new ApiError(res.status, `listShares: HTTP ${res.status}`);
  return res.json();
}

export async function createShare(email: string, shareFolders: boolean, shareCommands: boolean): Promise<ShareGiven> {
  const res = await fetch('/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, share_folders: shareFolders, share_commands: shareCommands }),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to share.', body.error);
  }
  return res.json();
}

export async function deleteShare(id: number): Promise<void> {
  const res = await fetch(`/api/shares/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to revoke share.', body.error);
  }
}
