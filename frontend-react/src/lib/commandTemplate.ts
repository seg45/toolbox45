// ════════════════════════════════════════════════
// RESOLUÇÃO DE TEMPLATE {{token}} — porta de js/db-render-engine.js, linhas
// 1-114 (resolveTokens/markVar/resolveTokensMarked/dbLineToTerm/
// dbLinesToTerm/buildLineWithOverride). O restante do arquivo original
// (RESOLVERS, buildCardHtmlForRow, buildEnvCards, buildTopicSection, etc.)
// vira renderPipeline.ts, que consome estas funções puras.
// ════════════════════════════════════════════════
import type { ParameterEntry } from './catalogs';
import type { CommandLine } from './commands';
import { VAR_OPEN, VAR_CLOSE } from './syntaxHighlight';

// Chaves dos 9 campos hardcoded (ver SimpleQueryFields.tsx) + FL/logFile +
// quaisquer parâmetros customizados do catálogo (mesclados genericamente,
// ver renderPipeline.ts::buildValues). Índice de assinatura pois um
// parâmetro novo cadastrado no modo administrador vira uma chave nova aqui
// sem que este tipo precise mudar.
export interface Values {
  src_ip: string;
  dst_ip: string;
  src_port: string;
  dst_port: string;
  proto: string;
  iface: string;
  vsid: string;
  ip: string;
  port: string;
  logFile: string;
  FL: { log: boolean };
  [key: string]: unknown;
}

// Linha já resolvida no formato que TerminalLines.tsx (porta de termRender())
// espera: {p,c} para uma linha de comando, ou {type,c} para uma anotação.
export type TermLine =
  | { p: string | null; c: string }
  | { type: 'note' | 'warn' | 'info' | 'ok'; c: string }
  | { type: 'image'; c: string; imageData: string | null };

// Mesma sintaxe {{key}} usada em todos os templates. Quando um token ainda
// não tem valor (nada digitado no campo de query/parâmetro), em vez de
// colapsar pra string vazia (que lê como um comando quebrado/truncado, ex.:
// "cprinstall get "), cai num hint amigável "<Label>" — procurado no
// catálogo de parâmetros pra bater com o nome exibido lá (cai na própria
// chave se o catálogo ainda não carregou).
export function resolveTokens(
  str: string | null | undefined,
  values: Values,
  catalogParams: ParameterEntry[]
): string | null | undefined {
  if (str === null || str === undefined) return str;
  return String(str).replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v !== undefined && v !== null && v !== '') return String(v);
    const param = catalogParams.find(p => p.key === key);
    return `<${param ? param.label : key}>`;
  });
}

// Embrulha um valor dinâmico (fornecido pelo usuário, ou seu hint "<Label>")
// no sentinela VAR_OPEN/VAR_CLOSE (syntaxHighlight.ts) para que safeHL()
// renderize como um token "variável" (k-var) diferenciado, em vez de deixar
// sem cor como o resto da sintaxe literal do comando. No-op para valores
// vazios/nulos — nada para destacar.
export function markVar(v: string | null | undefined): string | null | undefined {
  return v === undefined || v === null || v === '' ? v : VAR_OPEN + v + VAR_CLOSE;
}

// Igual a resolveTokens(), mas para texto que vai ser exibido como uma linha
// de comando destacada (safeHL) em vez de copiado pro clipboard ou mostrado
// como texto plano de UI (name/desc/about/raw) — o valor resolvido (ou seu
// hint "<Label>", quando o campo ainda está vazio) é embrulhado com
// markVar() para que só a parte de fato variável da linha ganhe cor, nunca a
// sintaxe fixa do comando ao redor.
export function resolveTokensMarked(
  str: string | null | undefined,
  values: Values,
  catalogParams: ParameterEntry[]
): string | null | undefined {
  if (str === null || str === undefined) return str;
  return String(str).replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v !== undefined && v !== null && v !== '') return (markVar(String(v)) as string);
    const param = catalogParams.find(p => p.key === key);
    return (markVar(`<${param ? param.label : key}>`) as string);
  });
}

// Linha DB {line_type, prompt, content, export_template} -> linha do formato
// termRender()/card() (TermLine).
//
// Redirecionamento genérico "Exportar para arquivo": linhas com um
// export_template escolhido (catálogo Register -> Manage Exports) têm esse
// template resolvido e anexado automaticamente quando o toggle "Export" da
// sidebar (values.FL.log) está ligado — sem precisar de um resolver
// dedicado nem de tokens manuais no texto do comando.
export function dbLineToTerm(line: CommandLine, values: Values, catalogParams: ParameterEntry[]): TermLine {
  if (line.line_type === 'cmd') {
    let content = resolveTokensMarked(line.content, values, catalogParams) as string;
    if (line.export_template && values.FL && values.FL.log && values.logFile) {
      content += ` ${resolveTokensMarked(line.export_template, values, catalogParams)}`;
    }
    return { p: (resolveTokens(line.prompt, values, catalogParams) ?? null), c: content };
  }
  if (line.line_type === 'image') {
    // c = nome exibido no lugar do comando; imageData = data URI base64
    // (command_lines.image_data), mostrada em tamanho maior ao clicar (ver
    // TerminalLines.tsx — o lightbox em si, openImageLightbox/
    // closeImageLightbox, não faz parte do escopo desta fatia).
    return {
      type: 'image',
      c: (resolveTokens(line.content, values, catalogParams) as string),
      imageData: line.image_data || null,
    };
  }
  // Linhas de anotação (note/warn/info/ok) não passam por safeHL() — ver
  // TerminalLines.tsx — então usam a resolução "limpa" (sem marcadores de
  // variável, que apareceriam como caracteres de controle soltos no texto
  // corrido).
  return {
    type: line.line_type as 'note' | 'warn' | 'info' | 'ok',
    c: (resolveTokens(line.content, values, catalogParams) as string),
  };
}

export function dbLinesToTerm(lines: CommandLine[] | undefined, values: Values, catalogParams: ParameterEntry[]): TermLine[] {
  return (lines || []).map(l => dbLineToTerm(l, values, catalogParams));
}

// Para uma linha DB cujo conteúdo contém um trecho literal (ainda com seus
// próprios placeholders {{token}}) que precisa ser trocado por um valor
// computado (ex.: uma string de filtro -F completa), substitui ANTES da
// resolução de tokens para que o trecho possa ser casado literalmente, e só
// então resolve os tokens que sobrarem. Usado pelos ~10 resolvers avançados
// (RESOLVERS.logexport, fora do escopo desta fatia — ver resolvers.ts) —
// portado aqui já para a fatia 3c reaproveitar sem precisar tocar neste
// arquivo de novo.
export function buildLineWithOverride(
  line: CommandLine,
  values: Values,
  overridePairs: Array<[string, string]>,
  catalogParams: ParameterEntry[]
): TermLine {
  let content = line.content || '';
  (overridePairs || []).forEach(([pattern, replacement]) => {
    content = content.split(pattern).join(replacement);
  });
  if (line.line_type === 'cmd') {
    content = resolveTokensMarked(content, values, catalogParams) as string;
    return { p: (resolveTokens(line.prompt, values, catalogParams) ?? null), c: content };
  }
  const resolvedContent = resolveTokens(content, values, catalogParams) as string;
  return { type: line.line_type as 'note' | 'warn' | 'info' | 'ok', c: resolvedContent };
}
