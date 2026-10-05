// ════════════════════════════════════════════════
// CATALOG ADMIN (/api/vendors|systems|versions|environments|topics|
// parameters|prompts|exports) — porta tipada da parte de ESCRITA de
// js/catalog-admin.js (733 linhas no original) — fatia 7, Register. A
// leitura continua 100% em lib/catalogs.ts (fetchCatalogs/GET /api/catalogs,
// usada em todo o app); este módulo só cobre as 24 combinações create/
// update/delete das 8 janelas (ver server-py/app/routers/catalog.py).
//
// Create/update usam o mesmo corpo parcial em todos os 8 kinds (um subset de
// {key, label, color, vendor, system} — cada kind só manda os campos que tem,
// ver CatalogAdminModal.tsx), então uma função genérica por verbo HTTP basta
// — não precisa de 24 funções distintas. `versions` é o único kind com chave
// composta (system+key) — por isso update/delete recebem `system` à parte
// (o valor ORIGINAL, usado na URL; o valor novo, se mudou, vai no corpo via
// CreateOrUpdatePayload.system).
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody } from './api';

export type CatalogKind = 'vendors' | 'systems' | 'versions' | 'environments' | 'topics' | 'parameters' | 'prompts' | 'exports';

export interface CatalogItemPayload {
  key?: string; // só POST /api/parameters (é o único kind com key definida pelo usuário na criação)
  label?: string;
  color?: string;
  vendor?: string; // só systems
  system?: string; // só versions/environments
}

// Mapeamento de erro do backend pra mensagem amigável — idêntico nas 8
// janelas do original (cada uma chamava a mesma função de mapeamento antes
// de exibir o erro em .cat-admin-msg.err). `count` só vem preenchido em
// in_use/structural_dependency (ver server-py/app/routers/catalog.py).
function mapCatalogErrorBody(body: { error?: string; message?: string; count?: number }): string {
  switch (body.error) {
    case 'in_use':
      return `Cannot delete: in use by ${body.count} command(s).`;
    case 'protected':
      return 'This item is protected by the system and cannot be deleted.';
    case 'structural_dependency':
      return `Cannot delete: ${body.count} command(s) depend on this parameter directly in code (e.g. "Requires SRC/DST").`;
    case 'conflict':
      return 'An item with this key already exists.';
    case 'validation_error':
      return body.message || 'Something went wrong. Please try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

async function throwCatalogError(res: Response): Promise<never> {
  const body = await parseErrorBody(res);
  throw new ApiError(res.status, mapCatalogErrorBody(body), body.error);
}

export async function createCatalogItem(kind: CatalogKind, payload: CatalogItemPayload): Promise<void> {
  const res = await fetch(`/api/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) await throwCatalogError(res);
}

// Mesmo POST de createCatalogItem, mas devolve o JSON da resposta (a linha
// criada, com a `key` gerada pelo servidor — ver POST /api/<kind> em
// server-py/app/routers/catalog.py, status 201 + `dict(row)`). Usado pelo
// painel "Resolve unmatched values" do import CSV (ImportCommandsModal.tsx),
// que precisa da key real para mapear o valor digitado -> item recém-criado.
//
// Diferença deliberada em relação a createCatalogItem: a mensagem do ApiError é
// a do próprio servidor (`body.message || 'failed to create'`), como no original
// (js/csv-import.js::applyImportResolutions), em vez do texto mapeado por
// mapCatalogErrorBody — o painel mostra a mensagem crua ao lado do item.
export async function createCatalogItemReturningKey(kind: CatalogKind, payload: CatalogItemPayload): Promise<{ key: string }> {
  const res = await fetch(`/api/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body.message || 'failed to create', body.error);
  }
  return res.json();
}

// `originalSystem` só é usado (e obrigatório) pra `kind === 'versions'` — vai
// na URL (/api/versions/:system/:key) ANTES de qualquer re-key que o próprio
// `payload.system` possa estar pedindo.
export async function updateCatalogItem(kind: CatalogKind, key: string, payload: CatalogItemPayload, originalSystem?: string): Promise<void> {
  const path = kind === 'versions' ? `/api/versions/${encodeURIComponent(originalSystem!)}/${encodeURIComponent(key)}` : `/api/${kind}/${encodeURIComponent(key)}`;
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) await throwCatalogError(res);
}

export async function deleteCatalogItem(kind: CatalogKind, key: string, originalSystem?: string): Promise<void> {
  const path = kind === 'versions' ? `/api/versions/${encodeURIComponent(originalSystem!)}/${encodeURIComponent(key)}` : `/api/${kind}/${encodeURIComponent(key)}`;
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok) await throwCatalogError(res);
}
