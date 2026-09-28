// ════════════════════════════════════════════════
// COMANDOS (/api/commands) — tipos + fetch, porta de js/api-client.js
// (fetchCommands/invalidateCommandsCache — createCommand/updateCommand/
// deleteCommand ficam fora do escopo desta fatia, entram na fatia 4).
//
// Formato ({CommandLine}/{Command}) porta 1:1 de _shape_row/_shape_line em
// server-py/app/commands.py — já validado contra o backend real, não
// adivinhado.
// ════════════════════════════════════════════════

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
