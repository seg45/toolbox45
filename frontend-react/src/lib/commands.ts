// ════════════════════════════════════════════════
// COMANDOS (/api/commands) — tipos + fetch, porta de js/api-client.js
// (fetchCommands/invalidateCommandsCache + createCommand/updateCommand/
// deleteCommand, acrescentados na fatia 4 — Editor de comandos).
//
// Formato ({CommandLine}/{Command}) porta 1:1 de _shape_row/_shape_line em
// server-py/app/commands.py — já validado contra o backend real, não
// adivinhado.
// ════════════════════════════════════════════════
import { ApiError, parseErrorBody } from './api';

export interface CommandLine {
  line_type: 'cmd' | 'note' | 'warn' | 'info' | 'ok' | 'image';
  prompt: string | null;
  content: string;
  export_template: string | null;
  image_data: string | null;
}

export interface Command {
  id: number;
  topic: string;
  topics: string[];
  folder_ids: number[];
  icon: string | null;
  sort_order: number;
  requires_ip_port: boolean;
  placeholder_resolver: string | null;
  name: string;
  name_empty: string | null;
  desc: string;
  desc_empty: string | null;
  details: string | null;
  vendors: string[];
  systems: string[];
  versions: string[];
  environments: string[];
  lines: { default: CommandLine[]; empty: CommandLine[] };
  created_at: string;
  updated_at: string;
  created_by: string | null;
  modified_by: string | null;
  is_system: boolean;
}

// Cache da promise do fetch — evita rebuscar a cada render() (render()
// roda a quase cada tecla digitada, ver renderPipeline.ts). Invalidado após
// create/update/delete (fatia 4) — exportado aqui já para essas fatias
// futuras usarem, mesmo sem nenhum chamador ainda nesta fatia.
let _commandsCache: Promise<Command[]> | null = null;

export function invalidateCommandsCache(): void {
  _commandsCache = null;
}

export async function fetchCommands(): Promise<Command[]> {
  if (_commandsCache) return _commandsCache;
  const promise = fetch('/api/commands')
    .then(res => {
      if (!res.ok) throw new Error(`fetchCommands: HTTP ${res.status}`);
      return res.json();
    })
    .catch(err => {
      _commandsCache = null; // não guarda um fetch falho em cache — permite retry no próximo render()
      throw err;
    });
  _commandsCache = promise;
  return promise;
}

// ════════════════════════════════════════════════
// create/update/delete (fatia 4 — Editor de comandos) — contrato validado
// contra server-py/app/routers/commands.py (POST/PUT/DELETE /api/commands),
// já 100% implementado desde a Fase 1: nenhuma mudança de API é necessária
// aqui, só consumir o contrato já existente.
//
// `lines` no payload é uma lista ÚNICA e achatada (não mais separada em
// default/empty, como no formato de LEITURA de {Command} acima) — cada linha
// carrega seu próprio `sort_order` (índice dentro da sua variante) e
// `variant` ('default' | 'empty'), dizendo ao backend a qual das duas listas
// ela pertence.
// ════════════════════════════════════════════════
export interface CommandLinePayload {
  sort_order: number;
  line_type: CommandLine['line_type'];
  prompt: string | null;
  content: string;
  export_template: string | null;
  image_data: string | null;
  variant: 'default' | 'empty';
}

export interface CommandPayload {
  topics: string[];
  placeholder_resolver: string | null;
  name: string;
  name_empty: string | null;
  desc: string;
  desc_empty: string | null;
  details: string;
  vendors: string[];
  systems: string[];
  versions: string[];
  environments: string[];
  lines: CommandLinePayload[];
}

// invalidateCommandsCache() sempre roda num `finally` — mesmo padrão do JS
// original: tanto sucesso quanto falha invalidam o cache, porque mesmo uma
// falha (ex.: 409/403 depois de o backend já ter validado outra coisa) não
// garante que o estado no servidor não mudou; um próximo fetchCommands()
// sempre busca dados frescos em vez de arriscar servir uma lista desatualizada.
// `asSystem` (opcional, só o import CSV usa — ImportCommandsModal.tsx): quando
// true envia o header X-Save-As-System, como js/api-client.js::createCommand.
// O servidor reconfere a role (só admin) antes de gravar created_by='System'.
export async function createCommand(payload: CommandPayload, asSystem?: boolean): Promise<Command> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (asSystem) headers['X-Save-As-System'] = '1';
    const res = await fetch('/api/commands', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await parseErrorBody(res);
      throw new ApiError(res.status, body.message || 'Failed to save the command. Please try again.', body.error);
    }
    return res.json();
  } finally {
    invalidateCommandsCache();
  }
}

export async function updateCommand(id: number, payload: CommandPayload): Promise<Command> {
  try {
    const res = await fetch(`/api/commands/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await parseErrorBody(res);
      throw new ApiError(res.status, body.message || 'Failed to save the command. Please try again.', body.error);
    }
    return res.json();
  } finally {
    invalidateCommandsCache();
  }
}

export async function deleteCommand(id: number): Promise<void> {
  try {
    const res = await fetch(`/api/commands/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await parseErrorBody(res);
      throw new ApiError(res.status, body.message || 'Failed to delete the command. Please try again.', body.error);
    }
  } finally {
    invalidateCommandsCache();
  }
}
