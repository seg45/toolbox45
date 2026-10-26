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
export function filterCommands(commands: Command[], settings: Settings, filters: LiveFilters, currentUser?: string | null): Command[] {
  let out = commands;
  // Preferência "All commands" (sidebar, Options; a chave persistida segue
  // `showSystemCommands`, para não perder a escolha já salva):
  //   - ligada: comandos de TODOS os usuários (dentro do que o servidor libera
  //     para o papel) e também os de referência (System);
  //   - desligada: SÓ os comandos do próprio usuário (created_by = ele).
  // Exceção: um comando guardado em alguma pasta do usuário continua
  // aparecendo (ele o guardou de propósito). Sem o usuário carregado ainda
  // (currentUser vazio) cai na regra antiga — só esconde os de sistema —
  // para não piscar a lista vazia no primeiro render.
  if (!settings.showSystemCommands) {
    const me = (currentUser || '').toLowerCase();
    out = out.filter(c => {
      if (c.folder_ids && c.folder_ids.length) return true;
      return me ? (c.created_by || '').toLowerCase() === me : !c.is_system;
    });
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
  // Version/Environment — mesma regra de Vendor/System: seleção vazia ("All")
  // não restringe nada; comando sem versão/ambiente cadastrado "aplica a
  // todos"; caso contrário precisa bater com pelo menos um item marcado.
  if (filters.version.length) {
    out = out.filter(c => scopeMatches(c.versions, filters.version));
  }
  if (filters.environment.length) {
    out = out.filter(c => scopeMatches(c.environments, filters.environment));
  }
  // Topic — mesma regra: vazio ("All") não restringe; o comando aparece se
  // QUALQUER um dos seus tópicos estiver marcado. Os cartões do tópico
  // protegido 'environment' (notas do ambiente) ficam de fora do filtro.
  if (filters.topic.length) {
    out = out.filter(c => {
      const tps = rowTopics(c);
      return tps.includes('environment') || tps.some(t => filters.topic.includes(t));
    });
  }
  return out;
}

function scopeMatches(scope: string[] | null | undefined, selected: string[]): boolean {
  return !scope || !scope.length || scope.some(x => selected.includes(x));
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

// Uma seção por COMBINAÇÃO de Tópicos (ícone + título + seus cards). Um
// comando com mais de um tópico aparece UMA vez só, numa seção cujo título lista
// os tópicos separados por vírgula, em ordem alfabética ("Diagnóstico, System").
function buildTopicSection(
  rows: Command[],
  icon: string,
  title: string,
  values: Values,
  hasIPs: boolean,
  key: string,
  catalogParams: ParameterEntry[]
): SectionData {
  const filtered = rows.filter(r => rowWillProduceCard(r, values));
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

  // Agrupa `rows` pela combinação de tópicos (já ordenados alfabeticamente em
  // `topicsSorted`): cada comando entra em UM grupo só. Tópicos fora do catálogo
  // (ou o protegido 'environment') não contam; sem nenhum tópico visível o
  // comando não aparece aqui (igual a antes).
  const topicIndex = new Map<string, number>();
  topicsSorted.forEach((tp, i) => topicIndex.set(tp.key, i));
  const groups = new Map<string, { idxs: number[]; rows: Command[] }>();
  rows.forEach(r => {
    const idxs = Array.from(new Set(rowTopics(r).map(t => topicIndex.get(t)).filter((i): i is number => i !== undefined))).sort((x, y) => x - y);
    if (!idxs.length) return;
    // Filtro de tópico: aparece se QUALQUER um dos seus tópicos passar.
    if (topicFilter.length && !idxs.some(i => topicFilter.includes(topicsSorted[i].key))) return;
    const gk = idxs.join('+');
    let g = groups.get(gk);
    if (!g) {
      g = { idxs, rows: [] };
      groups.set(gk, g);
    }
    g.rows.push(r);
  });

  const groupList = Array.from(groups.values()).map(g => ({
    ...g,
    title: g.idxs.map(i => topicsSorted[i].label).join(', '),
    gkey: g.idxs.map(i => topicsSorted[i].key).join('+'),
  }));
  groupList.sort((a, b) => stripLeadingSymbols(a.title).localeCompare(stripLeadingSymbols(b.title), undefined, { sensitivity: 'base' }));
  groupList.forEach(g => {
    const sec = buildTopicSection(g.rows, '', g.title, values, hasIPs, keyPrefix + g.gkey, catalogParams);
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

// Durante a busca, seção sem nenhum card que case some (como no original, que
// escondia as seções sem match) — senão o usuário vê todos os Tópicos/Versões
// do catálogo com contador 0.
function filterSections(sections: SectionData[], query: string, catalogs: Catalogs | null): SectionData[] {
  return sections.map(s => filterSectionCards(s, query, catalogs)).filter(s => s.count > 0);
}

function applySearchFilterToBlocks(blocks: ComboBlockData[], query: string, catalogs: Catalogs | null): ComboBlockData[] {
  return blocks.map(block => {
    if (block.groupBy === 'creator' && block.creatorGroups) {
      const creatorGroups = block.creatorGroups
        .map(g => {
          const sections = filterSections(g.sections, query, catalogs);
          const count = sections.reduce((n, s) => n + s.count, 0);
          return { ...g, sections, count };
        })
        .filter(g => g.count > 0);
      const cardCount = creatorGroups.reduce((n, g) => n + g.count, 0);
      return { ...block, creatorGroups, cardCount };
    }
    if (block.sections) {
      const sections = filterSections(block.sections, query, catalogs);
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
  currentUser?: string | null;
}): RenderResult {
  const { commands: commandsRaw, filters, settings, catalogs } = params;
  const catalogParams = catalogs?.parameters || [];
  const values = buildValues(params.fieldValues, settings, catalogs);
  const hasIPs = !!(values.src_ip && values.dst_ip);

  const commandsFiltered = filterCommands(commandsRaw, settings, filters, params.currentUser);

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
    // Cada combinação mostra só os comandos que valem para ela (o filtro
    // global acima já tirou o que não bate com NENHUMA das marcadas). Sem
    // seleção ("All") e fora de "Group by: Version" nada é restringido.
    const commands = commandsFiltered.filter(
      c =>
        (versionSel.isAllMode || scopeMatches(c.versions, [cv])) &&
        (envSel.isAllMode || scopeMatches(c.environments, [ce]))
    );
    const kp = `${cv}__${ce}__`;
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
        key: kp, groupBy: 'creator', showHeader, versionLabel: cvLabel, envLabel: ceLabel,
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
        sections, cardCount: count,
      });
      return;
    }

    // "topic" (padrão)
    comboBlocks.push({
      key: kp, groupBy: 'topic', showHeader, versionLabel: cvLabel, envLabel: ceLabel,
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
