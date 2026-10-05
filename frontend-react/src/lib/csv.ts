// ════════════════════════════════════════════════
// CSV de comandos (Settings → Database → Commands → Export/Import) — lógica
// PURA (sem React, sem DOM, sem fetch), porta de js/csv-export.js (parte de
// geração: colunas, escape, filtro de escopo) e js/csv-import.js (parte de
// parsing/validação: parser RFC 4180, template, resolução de catálogo,
// buildImportPayload, coleta de valores sem correspondência).
//
// Diferença estrutural em relação ao original: lá, CATALOGS (global), o mapa
// de resoluções (`_importResolutionMap`) e as linhas parseadas
// (`_importParsedRows`) eram estado global mutável de módulo. Aqui eles são
// SEMPRE parâmetros explícitos (`catalogs`, `resMap`, `rows`) — o estado vive
// no componente (ImportCommandsModal.tsx) e este módulo fica testável.
// ════════════════════════════════════════════════
import type { CatalogEntry, Catalogs } from './catalogs';
import type { CatalogKind } from './catalogAdmin';
import type { Command, CommandLine, CommandLinePayload, CommandPayload } from './commands';

// Delimitador de coluna do CSV — ponto e vírgula (padrão do Excel em PT-BR).
export const CSV_DELIMITER = ';';

// BOM UTF-8 no início do arquivo — garante acentuação correta ao abrir no Excel.
export const CSV_BOM = '\uFEFF';

// Escapa um valor para uma célula CSV (RFC 4180): entre aspas se contiver o
// delimitador (;), aspas ou quebra de linha; aspas internas dobradas.
export function csvEscapeField(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[";\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Texto final do arquivo: BOM + linhas separadas por CRLF (sem CRLF no fim).
export function buildCsvText(rows: string[][]): string {
  return CSV_BOM + rows.map(r => r.map(csvEscapeField).join(CSV_DELIMITER)).join('\r\n');
}

// ════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════

// Só as linhas de comando de fato (line_type 'cmd') — notas/avisos ficam fora
// para manter a coluna "Command" focada no que é executável no terminal. Só o
// `content` de cada linha — o prompt NÃO é embutido aqui (coluna "Prompt"
// separada), espelhando o template de import: buildImportPayload aplica um
// único Prompt a TODAS as linhas de "Command", permitindo reimportar um .csv
// exportado sem duplicar o prompt dentro do conteúdo.
export function csvCommandLines(lines: CommandLine[] | null | undefined): string {
  return (lines || [])
    .filter(l => l.line_type === 'cmd')
    .map(l => (l.content || '').trim())
    .filter(Boolean)
    .join('\n');
}

// Prompt do comando — um valor por linha 'cmd', mas normalmente compartilhado
// por todas; junta os valores ÚNICOS com ', ' caso as linhas tenham prompts
// diferentes entre si (caso raro, cadastrado manualmente no editor).
export function csvCommandPrompt(lines: CommandLine[] | null | undefined): string {
  const cmdLines = (lines || []).filter(l => l.line_type === 'cmd');
  const prompts = [...new Set(cmdLines.map(l => (l.prompt || '').trim()).filter(Boolean))];
  return prompts.join(', ');
}

// "Exportable" (export_template) agregado do comando: 'Yes' só quando TODAS as
// linhas de comando têm um template de export escolhido — evita que um
// reimport marque como exportáveis linhas que originalmente não eram (ver
// parseBooleanCell: aplica o mesmo valor da célula a todas as linhas). O CSV
// continua só Yes/No (não registra QUAL template) — reimportar aplica
// CSV_DEFAULT_EXPORT_TEMPLATE.
export function csvCommandExportable(lines: CommandLine[] | null | undefined): string {
  const cmdLines = (lines || []).filter(l => l.line_type === 'cmd');
  if (!cmdLines.length) return 'No';
  return cmdLines.every(l => !!(l.export_template && l.export_template.trim())) ? 'Yes' : 'No';
}

// Subconjunto do catálogo usado só para os RÓTULOS de vendor/system/topic na
// exportação (no original, a global CATALOGS — lida com `typeof CATALOGS`
// porque podia nem existir; aqui tudo é opcional pelo mesmo motivo).
export type CsvCatalogLabels = Partial<Pick<Catalogs, 'vendors' | 'systems' | 'topics'>>;

// Cai na própria key como fallback quando o item não existe no catálogo (ex.:
// o pseudo-tópico 'environment' — ver csvTopicLabel no original).
function labelOf(items: CatalogEntry[] | undefined, key: string): string {
  const it = (items || []).find(x => x.key === key);
  return it ? it.label : key;
}

export interface CsvColumn {
  key: string;
  header: string;
  get: (c: Command, catalogs: CsvCatalogLabels) => string;
}

// ── Definição de colunas: uma entrada por coluna do CSV, na ordem em que
// aparecem no arquivo (mesma ordem de IMPORT_HEADERS, para que um .csv
// exportado possa ser reimportado sem reordenar). `get(c, catalogs)` extrai o
// valor do comando `c`; o seletor de colunas do modal é construído a partir
// desta lista. `ID` não é exportado — o id nunca é lido do CSV (é um INTEGER
// sequencial atribuído pelo banco a cada reimport).
//
// ATENÇÃO: Vendor/System/Topics saem pelos RÓTULOS, mas Versions e
// Environments saem pelas KEYS (exatamente como o original) — o import aceita
// key ou label (matchCatalogItem), então o round-trip funciona nos dois casos.
export const CSV_COLUMNS: CsvColumn[] = [
  { key: 'name', header: 'Name', get: c => c.name || '' },
  { key: 'desc', header: 'Description', get: c => c.desc || '' },
  // `details` = campo único de rich text HTML — exportado cru (mesmo HTML
  // sanitizado que o servidor grava), volta intacto no reimport.
  { key: 'details', header: 'Details', get: c => c.details || '' },
  { key: 'vendors', header: 'Vendor', get: (c, cat) => (c.vendors || []).map(k => labelOf(cat.vendors, k)).join(', ') },
  { key: 'systems', header: 'System', get: (c, cat) => (c.systems || []).map(k => labelOf(cat.systems, k)).join(', ') },
  { key: 'topic', header: 'Topics', get: (c, cat) => (c.topics || [c.topic]).map(k => labelOf(cat.topics, k)).join(', ') },
  { key: 'versions', header: 'Versions', get: c => (c.versions || []).join(', ') },
  { key: 'environments', header: 'Environments', get: c => (c.environments || []).join(', ') },
  { key: 'prompt', header: 'Prompt', get: c => csvCommandPrompt(c.lines && c.lines.default) },
  { key: 'exportable', header: 'Exportable', get: c => csvCommandExportable(c.lines && c.lines.default) },
  { key: 'command', header: 'Command', get: c => csvCommandLines(c.lines && c.lines.default) },
];

// Quais comandos entram no .csv: todos, só System (is_system) ou só os
// criados/duplicados por usuários.
export type ExportScope = 'all' | 'system' | 'user';

// Valor vindo do localStorage: qualquer coisa que não seja 'system'/'user'
// vira 'all' (mesma regra de loadSelectedExportScope no original).
export function normalizeExportScope(v: unknown): ExportScope {
  return v === 'system' || v === 'user' ? v : 'all';
}

export function filterCommandsByExportScope(commands: Command[] | null | undefined, scope: ExportScope): Command[] {
  if (scope === 'system') return (commands || []).filter(c => c.is_system);
  if (scope === 'user') return (commands || []).filter(c => !c.is_system);
  return commands || [];
}

// Gera o texto do .csv só com as colunas em `selectedKeys` (na ordem de
// CSV_COLUMNS) e só os comandos do `scope`. `selectedKeys` vazio exporta TODAS
// as colunas (mesma "compatibilidade" de exportCommandsCsv() no original — o
// modal nunca chega a chamar com lista vazia).
export function buildExportCsv(commands: Command[], catalogs: CsvCatalogLabels, selectedKeys: string[], scope: ExportScope): string {
  const cols = selectedKeys.length ? CSV_COLUMNS.filter(col => selectedKeys.includes(col.key)) : CSV_COLUMNS;
  const filtered = filterCommandsByExportScope(commands, scope);
  const header = cols.map(col => col.header);
  const rows = filtered.map(c => cols.map(col => col.get(c, catalogs)));
  return buildCsvText([header, ...rows]);
}

// toolbox45-commands[-system|-user]-AAAA-MM-DD.csv (data ISO em UTC, como o
// original — `new Date().toISOString().slice(0, 10)`).
export function exportFileName(scope: ExportScope, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  const scopeSuffix = scope === 'system' ? '-system' : scope === 'user' ? '-user' : '';
  return `toolbox45-commands${scopeSuffix}-${stamp}.csv`;
}

// ════════════════════════════════════════════════
// IMPORT — parser
// ════════════════════════════════════════════════

// Parser CSV (RFC 4180) escrito à mão (o app não carrega bibliotecas de
// terceiros); suporta células com quebras de linha e aspas internas
// escapadas (""), que é exatamente o que o export e o template produzem.
export function parseCsvText(input: string): string[][] {
  let text = input;
  // Remove o BOM UTF-8 que o próprio app grava no início dos .csv que exporta.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === CSV_DELIMITER) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++; // normaliza CRLF -> LF abaixo
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // última célula/linha, se o arquivo não terminar com quebra de linha.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // descarta linhas totalmente vazias (comum no fim do arquivo)
  return rows.filter(r => r.some(c => c !== ''));
}

// Uma linha parseada: {cabeçalho: valor} — valores já com trim.
export type ImportRow = Record<string, string>;

// Primeira linha = cabeçalho (nomes de coluna); demais linhas viram objetos
// {header: valor}.
export function csvRowsToObjects(rows: string[][]): ImportRow[] {
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj: ImportRow = {};
    headers.forEach((h, idx) => {
      obj[h] = (r[idx] !== undefined ? r[idx] : '').trim();
    });
    return obj;
  });
}

// Comparação de cabeçalho tolerante a maiúsculas — o usuário pode ter editado
// o template. Primeiro nome que casar (na ordem de `names`) vence.
export function getCell(obj: ImportRow, ...names: string[]): string {
  for (const n of names) {
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() === n.toLowerCase()) return obj[k];
    }
  }
  return '';
}

export function normKey(s: unknown): string {
  return String(s || '').trim().toLowerCase();
}

export function splitCell(cell: unknown): string[] {
  return String(cell || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// ════════════════════════════════════════════════
// IMPORT — template
// ════════════════════════════════════════════════

// Ordem das colunas (mesma de CSV_COLUMNS). SEM coluna de ID. A coluna legada
// "Note" não é mais gerada, mas buildImportPayload ainda a aceita (.csv
// antigos/preenchidos) — use `Details` para observações.
// `Exportable` aceita yes/true/1/x (vazio/no/false/0 = não, sem diferenciar
// maiúsculas) e vale para TODAS as linhas de comando da célula "Command".
export const IMPORT_HEADERS = ['Name', 'Description', 'Details', 'Vendor', 'System', 'Topics', 'Versions', 'Environments', 'Prompt', 'Exportable', 'Command'];

// Vendor/System/Version/Environment/Topics são obrigatórios (ver
// buildImportPayload) — "all" não é aceito nestas colunas, por isso o exemplo
// usa valores reais e concretos do catálogo.
export const IMPORT_EXAMPLE_ROW = [
  'Check WatchDog process status',
  'Shows whether a monitored WatchDog process is alive',
  'Confirms a critical process (fwd, cpd, etc.) is being watched and running. After a restart, or when troubleshooting a service that keeps failing.',
  'Check Point',
  'Gaia',
  'System Monitoring',
  'R82',
  'Standalone',
  '[Expert@FW]#',
  'No',
  'cpwd_admin list',
];

export const IMPORT_TEMPLATE_FILE_NAME = 'toolbox45-template.csv';

export function buildImportTemplateCsv(): string {
  return buildCsvText([IMPORT_HEADERS, IMPORT_EXAMPLE_ROW]);
}

// ════════════════════════════════════════════════
// IMPORT — mapa de resoluções (era `_importResolutionMap`, global mutável)
// ════════════════════════════════════════════════

// Os 5 tipos resolvidos por coluna, na ORDEM de aplicação: Vendor → System →
// Version → Environment → Topic (System depende de Vendor; Version e
// Environment dependem de System — criar um item novo exige escolher o pai).
// 'parameter' é tratado à parte (depois dos 5) — ver ResKind.
export type ResType = 'vendor' | 'system' | 'version' | 'environment' | 'topic';
export type ResKind = ResType | 'parameter';

export const IMPORT_RES_ORDER: ResType[] = ['vendor', 'system', 'version', 'environment', 'topic'];

// `kind` = nome do endpoint genérico de createCatalogItemReturningKey
// (`/api/${kind}`, o `endpoint` do original). environment.parent = 'system'
// (igual version): environments.system é FK obrigatória no schema.
export const IMPORT_RES_META: Record<ResType, { label: string; kind: CatalogKind; parent: 'vendor' | 'system' | null }> = {
  vendor: { label: 'Vendor', kind: 'vendors', parent: null },
  system: { label: 'System', kind: 'systems', parent: 'vendor' },
  version: { label: 'Version', kind: 'versions', parent: 'system' },
  environment: { label: 'Environment', kind: 'environments', parent: 'system' },
  topic: { label: 'Topic', kind: 'topics', parent: null },
};

// rawLower (normKey) -> key já resolvida (mapeada pra existente OU criada
// nesta sessão de import). Para 'parameter' a chave do mapa é o próprio token
// (case-sensitive, sem normKey). Reiniciado a cada arquivo novo escolhido.
export type ResolutionMap = Record<ResKind, Record<string, string>>;

export function emptyResolutionMap(): ResolutionMap {
  return { vendor: {}, system: {}, version: {}, environment: {}, topic: {}, parameter: {} };
}

// ════════════════════════════════════════════════
// IMPORT — resolução de catálogo
// ════════════════════════════════════════════════

type CatalogLike = { key: string; label: string };

// Aceita a KEY ou o LABEL (e campos extras, ex.: Topic aceita 'label'), sem
// diferenciar maiúsculas/minúsculas — tanto um template preenchido do zero
// quanto um .csv do "Export commands" funcionam.
export function matchCatalogItem<T extends CatalogLike>(raw: string, items: readonly T[], extraFields?: string[]): T | null {
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  return (
    items.find(it => {
      if ((it.key || '').toLowerCase() === needle) return true;
      if ((it.label || '').toLowerCase() === needle) return true;
      const rec = it as unknown as Record<string, unknown>;
      return (extraFields || []).some(f => String(rec[f] || '').toLowerCase() === needle);
    }) || null
  );
}

// Retorna as keys reconhecidas na célula (vazia ou "all" => []). O CHAMADOR
// (buildImportPayload) decide se vazio é aceitável — para
// Vendor/System/Version/Environment NÃO é. Valores digitados mas não
// reconhecidos viram aviso, não erro fatal.
// `resolutions` (opcional) = a fatia de ResolutionMap do tipo (ex.:
// resMap.vendor), consultada quando matchCatalogItem não acha nada — preenchida
// pelo painel "Resolve unmatched values" quando o usuário mapeia um valor
// digitado pra um item existente com grafia diferente (ex.: "CP" -> "Check
// Point"). Itens "criar novo" já foram criados via API antes de chegar aqui e
// batem direto no catálogo recarregado.
export function resolveMultiCatalog<T extends CatalogLike>(
  cell: string,
  items: readonly T[],
  warnings: string[],
  label: string,
  resolutions?: Record<string, string>
): string[] {
  const raw = (cell || '').trim();
  if (!raw || raw.toLowerCase() === 'all') return [];
  const parts = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const keys: string[] = [];
  parts.forEach(p => {
    const found = matchCatalogItem(p, items);
    if (found) {
      keys.push(found.key);
      return;
    }
    const mapped = resolutions && resolutions[normKey(p)];
    if (mapped) {
      keys.push(mapped);
      return;
    }
    warnings.push(`${label} "${p}" not found — ignored`);
  });
  return keys;
}

// Tópicos protegidos (is_protected, ex.: 'environment') nunca são aceitos
// como destino de import.
function importableTopics(catalogs: Catalogs) {
  return (catalogs.topics || []).filter(t => !t.is_protected);
}

export function resolveTopics(cell: string, warnings: string[], catalogs: Catalogs, resMap: ResolutionMap): string[] {
  const raw = (cell || '').trim();
  const parts = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const keys: string[] = [];
  parts.forEach(p => {
    const found = matchCatalogItem(p, importableTopics(catalogs), ['label']);
    if (found) {
      keys.push(found.key);
      return;
    }
    const mapped = resMap.topic[normKey(p)];
    if (mapped) {
      keys.push(mapped);
      return;
    }
    warnings.push(`Topic "${p}" not found — ignored`);
  });
  return [...new Set(keys)];
}

// Interpreta a célula `Exportable` como booleano: yes/true/1/x
// (case-insensitive); qualquer outro valor (inclusive vazio/no/false/0) é falso.
export function parseBooleanCell(value: unknown): boolean {
  const v = String(value || '').trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === 'x';
}

// Template de export aplicado quando `Exportable` é verdadeiro — o CSV só
// guarda Yes/No (não registra QUAL item do catálogo Exports), então o reimport
// usa este texto fixo, que é EXATAMENTE o item padrão semeado pelo servidor
// (seedDefaultExports).
export const CSV_DEFAULT_EXPORT_TEMPLATE = '> {{logFile}}';

// ════════════════════════════════════════════════
// IMPORT — parâmetros ({{token}})
// ════════════════════════════════════════════════

// Parâmetros não têm coluna dedicada: o "valor" é o próprio token, digitado no
// meio do texto livre (Command/Prompt/Note/Description/...). Por isso a
// varredura é uma busca bruta em TODAS as células da linha (mesma regex \w+ de
// resolveTokens, garantindo "resolvido aqui" == "substituído de verdade na hora
// de renderizar"). Sem flag /g compartilhada: criamos a regex a cada chamada
// (o original reaproveitava uma /g global, o que funciona com String.replace
// mas é frágil com .test/.exec).
export function collectTokensFromRow(obj: ImportRow | null | undefined): string[] {
  const found = new Set<string>();
  Object.values(obj || {}).forEach(val => {
    String(val || '').replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
      found.add(key);
      return m;
    });
  });
  return [...found];
}

// Match é sempre exato (case-sensitive, sem normKey) — é assim que
// resolveTokens compara contra catalogs.parameters.
export function paramIsKnown(token: string, catalogs: Catalogs, resMap: ResolutionMap): boolean {
  if ((catalogs.parameters || []).some(p => p.key === token)) return true;
  return !!resMap.parameter[token];
}

// ════════════════════════════════════════════════
// IMPORT — linha -> payload de POST /api/commands
// ════════════════════════════════════════════════

export type BuiltImportRow = { error: string } | { payload: CommandPayload; warnings: string[] };

// Converte uma linha ({header: valor}) no payload de POST /api/commands.
// `error` != undefined significa que a linha inteira foi rejeitada (sem
// payload). Mesmas validações e MESMAS mensagens do original. O payload já sai
// no formato do React (CommandPayload): placeholder_resolver/name_empty/
// desc_empty nulos e linhas com sort_order (índice), variant 'default' e
// image_data null.
export function buildImportPayload(obj: ImportRow, catalogs: Catalogs, resMap: ResolutionMap): BuiltImportRow {
  const warnings: string[] = [];
  const name = getCell(obj, 'Name');
  if (!name) return { error: 'Missing "Name"' };

  const topics = resolveTopics(getCell(obj, 'Topics', 'Topic'), warnings, catalogs, resMap);
  if (!topics.length) return { error: 'No valid "Topics" (must match an existing topic)' };

  // Vendor/System/Version/Environment são obrigatórios no cadastro (mesma
  // regra do editor — "All" só existe como filtro, nunca como valor salvo):
  // célula vazia, "all" ou só com valores não reconhecidos rejeita a linha.
  // Um comando pertence a exatamente UM vendor e UM system (Version/
  // Environment/Topic aceitam vários).
  const vendors = resolveMultiCatalog(getCell(obj, 'Vendor', 'Vendors'), catalogs.vendors || [], warnings, 'Vendor', resMap.vendor);
  if (!vendors.length) return { error: 'No valid "Vendor" (exactly one is required — must match an existing vendor)' };
  if (vendors.length > 1) {
    return { error: `"Vendor" must have exactly one value, found ${vendors.length} (${vendors.join(', ')}) — a command belongs to a single vendor` };
  }
  const systems = resolveMultiCatalog(getCell(obj, 'System', 'Operating System', 'OS'), catalogs.systems || [], warnings, 'System', resMap.system);
  if (!systems.length) return { error: 'No valid "System" (exactly one is required — must match an existing system)' };
  if (systems.length > 1) {
    return { error: `"System" must have exactly one value, found ${systems.length} (${systems.join(', ')}) — a command belongs to a single system` };
  }
  const versions = resolveMultiCatalog(getCell(obj, 'Versions', 'Version'), catalogs.versions || [], warnings, 'Version', resMap.version);
  if (!versions.length) return { error: 'No valid "Version" (at least one is required — must match an existing version)' };
  const environments = resolveMultiCatalog(getCell(obj, 'Environments', 'Environment'), catalogs.environments || [], warnings, 'Environment', resMap.environment);
  if (!environments.length) return { error: 'No valid "Environment" (at least one is required — must match an existing environment)' };
  const prompt = getCell(obj, 'Prompt') || '[Expert@FW]#';
  const exportTemplate = parseBooleanCell(getCell(obj, 'Exportable', 'Export')) ? CSV_DEFAULT_EXPORT_TEMPLATE : null;
  const commandCell = getCell(obj, 'Command');
  const noteCell = getCell(obj, 'Note');

  const cmdContents = commandCell
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  if (!cmdContents.length) return { error: 'Missing "Command"' };
  const lines: CommandLinePayload[] = cmdContents.map((content, i) => ({
    sort_order: i,
    line_type: 'cmd',
    prompt,
    content,
    export_template: exportTemplate,
    image_data: null,
    variant: 'default',
  }));
  // A coluna legada "Note" vira uma linha de texto 'info' (azul) — a categoria
  // 'note' foi retirada do editor (conflitava com os "Notes" das pastas).
  if (noteCell.trim()) {
    lines.push({
      sort_order: lines.length,
      line_type: 'info',
      prompt: null,
      content: noteCell.trim(),
      export_template: null,
      image_data: null,
      variant: 'default',
    });
  }

  // Aviso (não bloqueia a linha) para {{token}} sem parâmetro cadastrado — só
  // acontece se o usuário escolheu "Import anyway" no painel de resolução. Sem
  // isso o comando importa, mas o token nunca é substituído.
  collectTokensFromRow(obj).forEach(tok => {
    if (!paramIsKnown(tok, catalogs, resMap)) {
      warnings.push(`Parameter "{{${tok}}}" not registered — will show as a literal placeholder until you add it via Manage Parameters`);
    }
  });

  const payload: CommandPayload = {
    topics,
    placeholder_resolver: null,
    name,
    name_empty: null,
    desc: getCell(obj, 'Description', 'Desc'),
    desc_empty: null,
    // `Details` substitui Purpose/When to use/Notes — passado cru; o servidor
    // sanitiza (mesma allow-list de Notes).
    details: getCell(obj, 'Details'),
    vendors,
    systems,
    versions,
    environments,
    lines,
  };
  return { payload, warnings };
}

// ════════════════════════════════════════════════
// IMPORT — coleta de valores sem correspondência
// ════════════════════════════════════════════════

export interface UnresolvedInfo {
  raw: string;
  count: number;
}
// Por tipo: Map rawLower -> {raw, count} (para 'parameter', a chave é o token).
export type UnresolvedRefs = Record<ResKind, Map<string, UnresolvedInfo>>;

// Qualquer item de catálogo dos 5 tipos (pai opcional) — só para o painel.
export type ImportCatalogItem = CatalogEntry & { vendor?: string; system?: string };

export function importCatalogItemsFor(type: ResType, catalogs: Catalogs): ImportCatalogItem[] {
  if (type === 'vendor') return catalogs.vendors || [];
  if (type === 'system') return catalogs.systems || [];
  if (type === 'version') return catalogs.versions || [];
  if (type === 'environment') return catalogs.environments || [];
  return importableTopics(catalogs);
}

// Rótulo com o pai entre parênteses, pra não confundir (ex.: duas versões
// "R82" cadastradas sob systems diferentes).
export function importCatalogOptionLabel(type: ResType, item: ImportCatalogItem, catalogs: Catalogs): string {
  if (type === 'system') {
    const vendor = (catalogs.vendors || []).find(v => v.key === item.vendor);
    return vendor ? `${item.label} (${vendor.label})` : item.label;
  }
  if (type === 'version') {
    const system = (catalogs.systems || []).find(s => s.key === item.system);
    return system ? `${item.label} (${system.label})` : item.label;
  }
  return item.label;
}

// Varre todas as linhas parseadas e devolve, por tipo, os valores digitados
// que não batem com nada (nem no catálogo vivo, nem no que já foi resolvido
// nesta sessão de import) — base do painel "Resolve unmatched values".
export function collectUnresolvedRefs(rows: ImportRow[] | null | undefined, catalogs: Catalogs, resMap: ResolutionMap): UnresolvedRefs {
  const out: UnresolvedRefs = {
    vendor: new Map(),
    system: new Map(),
    version: new Map(),
    environment: new Map(),
    topic: new Map(),
    parameter: new Map(),
  };
  const bump = (type: ResType, raw: string) => {
    const k = normKey(raw);
    if (!k || k === 'all') return;
    const cur = out[type].get(k);
    if (cur) cur.count++;
    else out[type].set(k, { raw: raw.trim(), count: 1 });
  };
  const isKnown = (type: ResType, raw: string, extraFields?: string[]) => {
    if (matchCatalogItem(raw, importCatalogItemsFor(type, catalogs), extraFields)) return true;
    return !!resMap[type][normKey(raw)];
  };
  (rows || []).forEach(obj => {
    splitCell(getCell(obj, 'Vendor', 'Vendors')).forEach(v => {
      if (!isKnown('vendor', v)) bump('vendor', v);
    });
    splitCell(getCell(obj, 'System', 'Operating System', 'OS')).forEach(v => {
      if (!isKnown('system', v)) bump('system', v);
    });
    splitCell(getCell(obj, 'Versions', 'Version')).forEach(v => {
      if (!isKnown('version', v)) bump('version', v);
    });
    splitCell(getCell(obj, 'Environments', 'Environment')).forEach(v => {
      if (!isKnown('environment', v)) bump('environment', v);
    });
    splitCell(getCell(obj, 'Topics', 'Topic')).forEach(v => {
      if (!isKnown('topic', v, ['label'])) bump('topic', v);
    });
    // Parâmetros: sem coluna própria, sem normKey (case-sensitive, ver
    // paramIsKnown) — não usa bump() por isso.
    collectTokensFromRow(obj).forEach(tok => {
      if (paramIsKnown(tok, catalogs, resMap)) return;
      const cur = out.parameter.get(tok);
      if (cur) cur.count++;
      else out.parameter.set(tok, { raw: tok, count: 1 });
    });
  });
  return out;
}

export function importAnyUnresolved(unresolved: UnresolvedRefs): boolean {
  return IMPORT_RES_ORDER.some(t => unresolved[t].size > 0) || unresolved.parameter.size > 0;
}

// Quando o usuário mapeia um token ({{srcip}}) para um parâmetro existente com
// key diferente ({{src_ip}}), o texto das linhas afetadas precisa ser
// reescrito literalmente — um Parâmetro só é substituído em tempo de render se
// aparecer como {{key}} no texto do comando (diferente dos outros 5 tipos,
// onde a key resolvida só entra em arrays do payload). Devolve NOVAS linhas
// (o original mutava `_importParsedRows` in place); linhas sem o token são
// devolvidas como a mesma referência.
export function rewriteParameterTokens(rows: ImportRow[], parameterMap: Record<string, string>): ImportRow[] {
  let result = rows;
  Object.entries(parameterMap).forEach(([token, resolvedKey]) => {
    if (!resolvedKey || resolvedKey === token) return;
    const re = new RegExp(`\\{\\{${token}\\}\\}`, 'g');
    result = result.map(obj => {
      let next: ImportRow = obj;
      for (const header of Object.keys(obj)) {
        const val = obj[header];
        if (typeof val === 'string' && val.indexOf(`{{${token}}}`) !== -1) {
          if (next === obj) next = { ...obj };
          next[header] = val.replace(re, `{{${resolvedKey}}}`);
        }
      }
      return next;
    });
  });
  return result;
}
