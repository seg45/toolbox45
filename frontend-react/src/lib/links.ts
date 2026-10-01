// ════════════════════════════════════════════════
// LINKS (/api/links) — porta tipada de js/links.js (fetches soltos) —
// fatia 6. Favoritos de URL 100% pessoais (sem conceito de compartilhamento
// nem admin — ver server-py/app/routers/links.py, sempre escopado pelo
// username da sessão, sem exceção nem para admin).
//
// Diferente de notes.ts (criar/editar/deletar, sem lista própria em cache),
// aqui a "cache da última lista" (_lkAllLinks do original) vira estado local
// do componente que consome (ver Header.tsx — loadLinksIfNeeded/useRef de
// `loaded`), não deste módulo — mantém o client de API sem estado, igual ao
// padrão de notes.ts/shares.ts/groups.ts.
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody } from './api';

export interface Link {
  id: number;
  name: string;
  url: string;
  created_at?: string;
}

export async function listLinks(): Promise<Link[]> {
  const res = await fetch('/api/links');
  if (!res.ok) throw new ApiError(res.status, `listLinks: HTTP ${res.status}`);
  return res.json();
}

export async function createLink(payload: { name: string; url: string }): Promise<Link> {
  const res = await fetch('/api/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to save link.', body.error);
  }
  return res.json();
}

export async function updateLink(id: number, payload: { name: string; url: string }): Promise<Link> {
  const res = await fetch(`/api/links/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to save link.', body.error);
  }
  return res.json();
}

export async function deleteLink(id: number): Promise<void> {
  const res = await fetch(`/api/links/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'Failed to delete link.', body.error);
  }
}
