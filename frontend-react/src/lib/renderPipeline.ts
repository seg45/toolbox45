// ════════════════════════════════════════════════
// RENDER PIPELINE — porta de js/render.js (render()) + o restante de
// js/db-render-engine.js (resolveDetailsHtml/buildEmptyStateCard/
// buildCardHtmlForRow/buildEnvCards/rowWillProduceCard/buildTopicSection) —
// tudo isso, EXCETO o ramo VIEW_FOLDERS_HOME (Pastas, fora do escopo desta
// fatia — sempre tratado como false/fora-de-pastas aqui).
//
// Diferente do original (que monta HTML string / manipula o DOM direto),
// esta é uma função PURA: recebe os comandos já buscados + o estado de
// filtro/configuração atual, e devolve uma ÁRVORE DE DADOS estruturada
// (ComboBlockData[]) que os componentes em src/components/commands/
// (CommandsContent.tsx e afins) percorrem para montar o JSX/HTML de
// verdade. A construção de CardData (resolveTokens/dbLinesToTerm) é
// relativamente barata (sem escaping/tokenização de sintaxe — isso só
// acontece de fato dentro de TerminalLines.tsx via safeHL(), quando o
// componente é MONTADO) — por isso é feita aqui, eager, para toda seção;
// quem evita o custo pesado (safeHL) de uma seção recolhida é
// CollapsibleSection.tsx, que só invoca `renderBody()` (e portanto só monta
// os componentes CommandCard/TerminalLines) quando a seção NÃO está
// recolhida — o mesmo efeito de collapsibleGroupLazy()/
// _lazySectionBuilders do original, só que pelo próprio modelo do React em
// vez de uma máquina de builders adiados manual.
// ════════════════════════════════════════════════
import type { Catalogs, ParameterEntry, TopicEntry } from './catalogs';
import type { Command } from './commands';
import { dbLinesToTerm, resolveTokens, type TermLine, type Values } from './commandTemplate';
import type { LiveFilters } from './liveFilters';
import { RESOLVERS } from './resolvers';
import { stripVarMarkers } from './syntaxHighlight';
import type { Settings } from './settingsStore';

// ── Constantes de Versão/Ambiente — porta de js/state.js ──────────────────
export const VERSION_KEYS = ['R81.10', 'R81.20', 'R82', 'R82.10'];
export const ENV_KEYS = ['cluster', 'gaia', 'maestro', 'mds', 'standalone', 'vsx'];
export const FALLBACK_VERSION = 'R82';
export const FALLBACK_ENV = 'standalone';
export const MAX_COMBOS = 8;

// ════════════════════════════════════════════════
// Shape dos dados devolvidos
// ════════════════════════════════════════════════
export interface CardData {
  id: number;
  name: string;
  desc: string;
  detailsHtml: string;
  lines: TermLine[];
  folderIds: number[];
  createdBy: string | null;
  modifiedBy: string | null;
  updatedAt: string;
  isSystem: boolean;
  vendors: string[];
  systems: string[];
  versions: string[];
  environments: string[];
}

export interface SectionData {
  key: string;
  icon: string;
  title: string;
  count: number;
  cards: CardData[];
}

export interface CreatorGroupData {
  key: string;
  creator: string;
  count: number;
  sections: SectionData[];
}

export interface ComboBlockData {
  key: string;
  groupBy: Settings['groupBy'];
  showHeader: boolean; // combos.length > 1 (comboHeader "🔀 Versão / Ambiente")
  versionLabel: string;
  envLabel: string;
  envNoteHtml: string; // já em HTML (<strong>/<code> — ver envNoteHtmlFor abaixo), sem o wrapper <div class="env-note">
  sections?: SectionData[]; // groupBy 'topic' | 'version'
  creatorGroups?: CreatorGroupData[]; // groupBy 'creator'
  cardCount: number;
}

export interface RenderResult {
  comboBlocks: ComboBlockData[];
  truncatedNote: string | null;
  noResults: boolean;
  searchQuery: string;
}

// ════════════════════════════════════════════════
// values — porta do bloco `const values = {...}` em render.js
// ════════════════════════════════════════════════
// Os 9 campos hardcoded (ver SimpleQueryFields.tsx) — mesmas chaves usadas
// nos placeholders {{token}} dos comandos.
export const HARDCODED_VALUE_KEYS = ['src_ip', 'dst_ip', 'src_port', 'dst_port', 'proto', 'iface', 'vsid', 'ip', 'port'] as const;

export function buildValues(fieldValues: Record<string, string>, settings: Settings, catalogs: Catalogs | null): Values {
  const gv = (k: string) => (fieldValues[k] || '').trim();
  const values: Values = {
    src_ip: gv('src_ip'),
    dst_ip: gv('dst_ip'),
    src_port: gv('src_port') || '0',
    dst_port: gv('dst_port') || '0',
    proto: gv('proto') || '0',
    iface: gv('iface'),
    vsid: gv('vsid') || '0',
    ip: gv('ip'),
    port: gv('port'),
    // Campo de caminho de exportação (#f-log no original) ainda não tem
    // input próprio nesta fatia — fora do escopo (só os 9 campos hardcoded +
    // parâmetros customizados do catálogo, ver SimpleQueryFields.tsx). Usa o
    // mesmo valor com que o campo nasce no HTML original, para que o toggle
    // "Export" (settings.exportEnabled) continue produzindo uma linha
    // plausível até uma fatia futura trazer o campo de verdade.
    logFile: '/tmp/$(hostname).txt',
    FL: { log: settings.exportEnabled },
  };
  (catalogs?.parameters || []).forEach(p => {
    if (!(p.key in values)) values[p.key] = gv(p.key);
  });
  return values;
}

// ════════════════════════════════════════════════
// Filtros de verdade (System commands / Vendor / System) — porta do topo de
// render.js.
// ════════════════════════════════════════════════
// Exportada a partir da fatia 5a (Pastas) para o pipeline paralelo de
// Pastas (src/lib/foldersPipeline.ts) reaproveitar EXATAMENTE o mesmo
// filtro de "System commands"/Vendor/System usado pela visão normal —
// render.js aplica esse filtro uma única vez, antes de se ramificar em
// VIEW_FOLDERS_HOME ou nos modos de Group By (ver comentário no topo de
// render.js). Nenhuma mudança de comportamento aqui, só a palavra `export`.
export function filterCommands(commands: Command[], settings: Settings, filters: LiveFilters): Command[] {
  let out = commands;
  // Preferência "System commands" (sidebar, Options) — quando desligada,
  // some com os comandos de referência (created_by='System', is_system=true)
  // e mostra só os criados/duplicados por usuários. Exceção: um comando
  // System guardado em alguma pasta continua aparecendo (desde a fatia 5a,
  // Pastas, folder_ids pode de fato vir preenchido — antes disso a exceção
  // nunca disparava na prática, já que Folders não existia ainda).
  if (!settings.showSystemCommands) {
    out = out.filter(c => !c.is_system || (c.folder_ids && c.folder_ids.length));
  }
  // Vendor/System — topo da hierarquia multi-fabricante ESTRITA: seleção
  // vazia não restringe nada; um comando sem vendor/system cadastrado
  // "aplica a todos"; caso contrário precisa bater com pelo menos um item
  // marcado.
  if (filters.vendor.length) {
    out = out.filter(c => !c.vendors || !c.vendors.length || c.vendors.some(v => filters.vendor.includes(v)));
  }
  if (filters.system.length) {
    out = out.filter(c => !c.systems || !c.systems.length || c.systems.some(s => filters.system.includes(s)));
  }
  return out;
}

function resolveMultiSelection(sel: string[], allKeysOrdered: string[], defaultVal: string): { values: string[]; isAllMode: boolean } {
  if (sel.length === 0) return { values: [defaultVal], isAllMode: true };
  return { values: allKeysOrdered.filter(k => sel.includes(k)), isAllMode: false };
}

// Mesmo critério (stripLeadingSymbols + localeCompare) usado nos dropdowns
// de filtro em js/state.js, aplicado aqui pra ordenar os Tópicos.
function stripLeadingSymbols(str: string): string {
  return (str || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function envLabel(key: string, catalogs: Catalogs | null): string {
  const env = (catalogs?.environments || []).find(x => x.key === key);
  return env ? env.label : key;
}

// Texto (com <strong>/<code>) de cada nota de ambiente — porta do objeto
// envNotesText em render.js. 'vsx' interpola values.vsid, então vira função
// em vez de mapa estático.
function envNoteHtmlFor(ce: string, vsid: string): string {
  switch (ce) {
    case 'cluster':
      return 'Cluster: run on <strong>both members</strong>. Check the active member with <code>cphaprob stat</code>.';
    case 'vsx':
      return `VSX: enter the VS with <code>vsenv ${vsid}</code> before running any command. <code>vsx stat -v</code> lists all IDs.`;
    case 'maestro':
      return 'Maestro: use <code>asg_cmd "..."</code> to broadcast to all SGMs. The <code>g_*</code> prefix aggregates output from all of them.';
    case 'mds':
      return 'MDS: use <code>mdsenv &lt;CMA-NAME&gt;</code> to enter the domain. <code>mdsstat</code> lists all CMAs.';
    case 'gaia':
      return 'Gaia Clish: commands run directly in the Gaia restricted shell (prompt <code>[Gaia]&gt;</code>), without entering Expert mode. Categories with no Clish equivalent (capture, kernel debug, SecureXL, tables, licensing, policy fetch) show a note indicating you need to type <code>expert</code> to access bash.';
    default:
      return ''; // 'standalone' (e qualquer chave desconhecida) — sem nota
  }
}

// ════════════════════════════════════════════════
// Row -> CardData — porta de resolveDetailsHtml/buildEmptyStateCard/
// buildCardHtmlForRow/rowWillProduceCard/buildEnvCards/buildTopicSection em
// js/db-render-engine.js.
// ════════════════════════════════════════════════
function resolveDetailsHtml(details: string | null, values: Values, catalogParams: ParameterEntry[]): string {
  return details ? (resolveTokens(details, values, catalogParams) as string) : '';
}

function rowScope(row: Command) {
  return {
    folderIds: row.folder_ids,
    createdBy: row.created_by,
    modifiedBy: row.modified_by,
    updatedAt: row.updated_at,
    isSystem: row.is_system,
    vendors: row.vendors,
    systems: row.systems,
    versions: row.versions,
    environments: row.environments,
  };
}

function buildEmptyStateCard(row: Command, values: Values, detailsHtml: string, catalogParams: ParameterEntry[]): CardData | null {
  const emptyLines = row.lines?.empty || [];
  if (!emptyLines.length) return null; // ex.: conntable/nattable/routespecific — card omitido inteiramente
  const name = row.name_empty !== null && row.name_empty !== undefined && row.name_empty !== '' ? row.name_empty : row.name;
  const desc = row.desc_empty !== null && row.desc_empty !== undefined && row.desc_empty !== '' ? row.desc_empty : row.desc;
  return {
    id: row.id,
    name: resolveTokens(name, values, catalogParams) as string,
    desc: resolveTokens(desc, values, catalogParams) as string,
    detailsHtml,
    lines: dbLinesToTerm(emptyLines, values, catalogParams),
    ...rowScope(row),
  };
}

export function buildCardDataForRow(row: Command, values: Values, hasIPs: boolean, catalogParams: ParameterEntry[]): CardData | null {
  const detailsHtml = resolveDetailsHtml(row.details, values, catalogParams);

  // IP/Porta genéricos (sem direção): usados por comandos como "host <IP>
  // and port <PORT>" que não distinguem origem/destino, ao contrário de
  // SRC/DST. Gatilho independente de hasIPs, lido direto de values.ip/port.
  const hasIpPort = !!(values.ip && values.port);
  if (row.requires_ip_port && !hasIpPort) {
    return buildEmptyStateCard(row, values, detailsHtml, catalogParams);
  }

  let lines: TermLine[];
  const resolver = row.placeholder_resolver ? RESOLVERS[row.placeholder_resolver] : undefined;
  if (resolver && hasIPs) {
    lines = resolver(row, values).lines;
  } else {
    lines = dbLinesToTerm(row.lines.default, values, catalogParams);
  }

  return {
    id: row.id,
    name: resolveTokens(row.name, values, catalogParams) as string,
    desc: resolveTokens(row.desc, values, catalogParams) as string,
    detailsHtml,
    lines,
    ...rowScope(row),
  };
}

// Diz se uma row vai virar um card SEM montar o CardData de fato — espelha
// exatamente a única condição em que buildCardDataForRow() devolve null (row
// exige IP+porta e não tem variante "empty" com conteúdo).
function rowWillProduceCard(row: Command, values: Values): boolean {
  const hasIpPort = !!(values.ip && values.port);
  if (row.requires_ip_port && !hasIpPort) {
    return !!(row.lines && row.lines.empty && row.lines.empty.length);
  }
  return true;
}

function rowTopics(row: Command): string[] {
  return row.topics && row.topics.length ? row.topics : [row.topic];
}

// As 5 cartas "🏗️ Ambiente: X", fixadas via row.environments a um ambiente
// específico cada (topic='environment'), mostradas no topo de um bloco de
// combo quando o ambiente desse combo bate.
function buildEnvCards(rows: Command[], ce: string, values: Values, catalogParams: ParameterEntry[]): CardData[] {
  return rows
    .filter(r => rowTopics(r).includes('environment') && Array.isArray(r.environments) && r.environments.includes(ce))
    .map(r => buildCardDataForRow(r, values, true, catalogParams))
    .filter((c): c is CardData => !!c);
}

// Uma seção por Tópico (ícone + título + seus cards), espelhando os blocos
// por tópico de render.js.
function buildTopicSection(
  rows: Command[],
  topic: string,
  icon: string,
  title: string,
  values: Values,
  hasIPs: boolean,
  key: string,
  catalogParams: ParameterEntry[]
): SectionData {
  // Um comando pode pertencer a mais de um Tópico (row.topics) — aparece em
  // cada seção correspondente.
  const filtered = rows.filter(r => rowTopics(r).includes(topic)).filter(r => rowWillProduceCard(r, values));
  const cards = filtered.map(r => buildCardDataForRow(r, values, hasIPs, catalogParams)).filter((c): c is CardData => !!c);
  return { key, icon, title, count: cards.length, cards };
}

// Monta as seções (Environment + uma por Tópico) para um subconjunto de
// `commands` — reaproveitado pelos modos "Created by" (uma vez por autor) e
// "Topic"/"Version" (uma vez pro combo inteiro).
function buildSections(
  rows: Command[],
  keyPrefix: string,
  ce: string,
  values: Values,
  hasIPs: boolean,
  catalogs: Catalogs | null,
  catalogParams: ParameterEntry[],
  topicsSorted: TopicEntry[],
  topicFilter: string[]
): { sections: SectionData[]; count: number } {
  const sections: SectionData[] = [];
  let count = 0;

  const envCards = buildEnvCards(rows, ce, values, catalogParams);
  if (envCards.length) {
    sections.push({
      key: keyPrefix + 'environment',
      icon: '🏗️',
      title: `Environment: ${envLabel(ce, catalogs)}`,
      count: envCards.length,
      cards: envCards,
    });
    count += envCards.length;
  }

  // Agrupa `rows` por tópico uma vez (Map<topic, rows[]>) em vez de deixar
  // buildTopicSection escanear o array inteiro de novo a cada tópico do
  // catálogo.
  const rowsByTopic = new Map<string, Command[]>();
  rows.forEach(r => {
    rowTopics(r).forEach(tp => {
      let arr = rowsByTopic.get(tp);
      if (!arr) {
        arr = [];
        rowsByTopic.set(tp, arr);
      }
      arr.push(r);
    });
  });

  const showTopic = (tp: string) => topicFilter.length === 0 || topicFilter.includes(tp);
  topicsSorted.forEach(tp => {
    if (!showTopic(tp.key)) return;
    const sec = buildTopicSection(rowsByTopic.get(tp.key) || [], tp.key, '', tp.label, values, hasIPs, keyPrefix + tp.key, catalogParams);
    if (sec.count > 0) {
      sections.push(sec);
      count += sec.count;
    }
  });

  return { sections, count };
}

// ════════════════════════════════════════════════
// Filtro de busca (data-level) — porta de applySearchFilter() (js/folders.js,
// ~linha 1746) — mesmo casamento de substring case-insensitive contra o
// texto visível de cada card (name+desc+details+todo texto renderizado das
// linhas), escondendo cards/seções sem match e sinalizando o estado vazio
// "No commands found for ...". Portado como filtro sobre os DADOS (poda o
// array de cards) em vez de esconder elementos do DOM via style.display,
// já que aqui o React sempre re-renderiza a partir dos dados.
//
// Diferença deliberada do original: lá, uma seção RECOLHIDA nunca teve seu
// corpo construído (collapsibleGroupLazy/_lazySectionBuilders), então a
// busca na prática só enxergava cards de seções já expandidas — um efeito
// colateral da otimização de performance, não um comportamento intencional.
// Aqui, como CardData já é montado eager para toda seção (ver comentário no
// topo do arquivo — o custo pesado de verdade, safeHL(), só acontece na
// montagem de TerminalLines.tsx, que essa mesma seção recolhida evita), a
// busca cobre TODOS os comandos, inclusive os de seções recolhidas — uma
// melhoria estrita sobre a limitação acidental do original.
function cardMatchesQuery(card: CardData, query: string, catalogs: Catalogs | null): boolean {
  const parts: string[] = [card.name, card.desc, card.detailsHtml.replace(/<[^>]*>/g, ' ')];
  parts.push(scopeSearchText(card.vendors, catalogs?.vendors));
  parts.push(scopeSearchText(card.systems, catalogs?.systems));
  parts.push(scopeSearchText(card.versions, catalogs?.versions));
  parts.push(scopeSearchText(card.environments, catalogs?.environments));
  card.lines.forEach(l => {
    if ('p' in l) {
      parts.push(l.p || '');
      parts.push(stripVarMarkers(l.c));
    } else {
      parts.push(stripVarMarkers(l.c));
    }
  });
  return parts.join(' ').toLowerCase().includes(query);
}

function scopeSearchText(keys: string[], catalogArr: { key: string; label: string }[] | undefined): string {
  if (!keys || !keys.length) return '';
  return keys.map(k => (catalogArr || []).find(x => x.key === k)?.label || k).join(' ');
}

function filterSectionCards(sec: SectionData, query: string, catalogs: Catalogs | null): SectionData {
  const cards = sec.cards.filter(c => cardMatchesQuery(c, query, catalogs));
  return { ...sec, cards, count: cards.length };
}

function applySearchFilterToBlocks(blocks: ComboBlockData[], query: string, catalogs: Catalogs | null): ComboBlockData[] {
  return blocks.map(block => {
    if (block.groupBy === 'creator' && block.creatorGroups) {
      const creatorGroups = block.creatorGroups.map(g => {
        const sections = g.sections.map(s => filterSectionCards(s, query, catalogs));
        const count = sections.reduce((n, s) => n + s.count, 0);
        return { ...g, sections, count };
      });
      const cardCount = creatorGroups.reduce((n, g) => n + g.count, 0);
      return { ...block, creatorGroups, cardCount };
    }
    if (block.sections) {
      const sections = block.sections.map(s => filterSectionCards(s, query, catalogs));
      const cardCount = sections.reduce((n, s) => n + s.count, 0);
      return { ...block, sections, cardCount };
    }
    return block;
  });
}

function blockCardCount(block: ComboBlockData): number {
  return block.cardCount;
}

// ════════════════════════════════════════════════
// Pipeline principal — porta de render() em js/render.js, sem o ramo
// VIEW_FOLDERS_HOME (Pastas — sempre tratado como ausente/false nesta
// fatia).
// ════════════════════════════════════════════════
export function buildRenderTree(params: {
  commands: Command[];
  filters: LiveFilters;
  settings: Settings;
  catalogs: Catalogs | null;
  fieldValues: Record<string, string>;
}): RenderResult {
  const { commands: commandsRaw, filters, settings, catalogs } = params;
  const catalogParams = catalogs?.parameters || [];
  const values = buildValues(params.fieldValues, settings, catalogs);
  const hasIPs = !!(values.src_ip && values.dst_ip);

  const commands = filterCommands(commandsRaw, settings, filters);

  // Resolve a seleção de Versão/Ambiente numa lista de valores concretos a
  // gerar. "Group by: Version" com nada marcado trata "nada marcado" como
  // "todas marcadas" (mesmo efeito de marcar uma por uma), pra gerar um
  // combo por versão de verdade em vez de colapsar pro comportamento padrão
  // de sempre (que daria só UMA seção de versão com tudo dentro).
  const versionSel =
    settings.groupBy === 'version' && filters.version.length === 0
      ? { values: VERSION_KEYS, isAllMode: false }
      : resolveMultiSelection(filters.version, VERSION_KEYS, FALLBACK_VERSION);
  const envSel = resolveMultiSelection(filters.environment, ENV_KEYS, FALLBACK_ENV);

  let combos: Array<{ v: string; e: string }> = [];
  for (const cv of versionSel.values) {
    for (const ce of envSel.values) combos.push({ v: cv, e: ce });
  }
  let truncatedNote: string | null = null;
  if (combos.length > MAX_COMBOS) {
    combos = combos.slice(0, MAX_COMBOS);
    truncatedNote = `Too many Version × Environment combinations checked — showing the first ${MAX_COMBOS}. Narrow the selection to see the rest.`;
  }

  // Ordenado alfabeticamente pelo título da seção (não por sort_order do
  // catálogo) — mesmo critério de js/state.js. Tópico protegido
  // 'environment' fica de fora (tratado à parte por buildEnvCards).
  const topicsSorted = (catalogs?.topics || [])
    .filter(tp => !tp.is_protected)
    .slice()
    .sort((a, b) => stripLeadingSymbols(a.label).localeCompare(stripLeadingSymbols(b.label), undefined, { sensitivity: 'base' }));

  const comboBlocks: ComboBlockData[] = [];

  combos.forEach(combo => {
    const { v: cv, e: ce } = combo;
    const kp = `${cv}__${ce}__`;
    const envNoteHtml = envNoteHtmlFor(ce, values.vsid);
    // Quando Versão/Ambiente = All, a combinação usada pra gerar os
    // comandos é só um valor padrão de referência — o rótulo deve dizer
    // "All", não o valor concreto escolhido internamente.
    const cvLabel = versionSel.isAllMode ? 'All' : cv;
    const ceLabel = envSel.isAllMode ? 'All' : envLabel(ce, catalogs);
    const showHeader = combos.length > 1;

    if (settings.groupBy === 'creator') {
      // "Created by": um agrupamento recolhível por autor, cada um com as
      // mesmas seções de Ambiente/Tópico de sempre, só que com os comandos
      // daquele autor. Autores em ordem alfabética (sem caixa); "—" agrupa
      // comandos sem created_by.
      const byCreator = new Map<string, Command[]>();
      commands.forEach(c => {
        const key = c.created_by || '—';
        let arr = byCreator.get(key);
        if (!arr) {
          arr = [];
          byCreator.set(key, arr);
        }
        arr.push(c);
      });
      const creators = [...byCreator.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      const creatorGroups: CreatorGroupData[] = [];
      let comboCardCount = 0;
      creators.forEach(creator => {
        const subset = byCreator.get(creator) || [];
        // Chave "segura" (sem \, etc.) — contas antigas no formato
        // "DOMÍNIO\usuario" poderiam quebrar uma chave de seção; o nome de
        // exibição (creator) continua o original.
        const creatorKey = creator.replace(/[^a-zA-Z0-9_-]/g, '_');
        const { sections, count } = buildSections(
          subset, `${kp}${creatorKey}__`, ce, values, hasIPs, catalogs, catalogParams, topicsSorted, filters.topic
        );
        if (!count) return;
        creatorGroups.push({ key: `${cv}__${ce}__${creatorKey}`, creator, count, sections });
        comboCardCount += count;
      });
      if (!creatorGroups.length) return; // combo sem nenhum comando pra nenhum autor
      comboBlocks.push({
        key: kp, groupBy: 'creator', showHeader, versionLabel: cvLabel, envLabel: ceLabel, envNoteHtml,
        creatorGroups, cardCount: comboCardCount,
      });
      return;
    }

    const { sections, count } = buildSections(commands, kp, ce, values, hasIPs, catalogs, catalogParams, topicsSorted, filters.topic);

    if (settings.groupBy === 'version') {
      // "Agrupar por Versão": embrulha o bloco inteiro da combinação num
      // agrupamento recolhível próprio (rotulado com Versão/Ambiente), com
      // as seções de Tópico aninhadas dentro. Sempre exibido nesse modo,
      // mesmo com uma única combinação.
      if (!count) return;
      comboBlocks.push({
        key: `${cv}__${ce}`, groupBy: 'version', showHeader: true, versionLabel: cvLabel, envLabel: ceLabel,
        envNoteHtml, sections, cardCount: count,
      });
      return;
    }

    // "topic" (padrão)
    comboBlocks.push({
      key: kp, groupBy: 'topic', showHeader, versionLabel: cvLabel, envLabel: ceLabel, envNoteHtml,
      sections, cardCount: count,
    });
  });

  const query = filters.search.trim().toLowerCase();
  let finalBlocks = comboBlocks;
  let noResults = false;
  if (query) {
    finalBlocks = applySearchFilterToBlocks(comboBlocks, query, catalogs);
    const anyCards = finalBlocks.some(b => blockCardCount(b) > 0);
    noResults = !anyCards;
  }

  return { comboBlocks: finalBlocks, truncatedNote, noResults, searchQuery: filters.search };
}
