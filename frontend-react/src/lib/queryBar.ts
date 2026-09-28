// ════════════════════════════════════════════════
// QUERY BAR — funções puras, porta de js/query-bar.js (a parte de dados —
// parsing/tags/insertFieldToken/typeahead; a parte de DOM/render vira
// QueryBar.tsx, que consome estas funções). Sem estado de módulo (o
// original usa `let queryTags = []`/`let QUERY_FIELD_DEFS = []` globais);
// aqui tudo é parâmetro/retorno, e o componente React é quem guarda o
// estado (tags/liveText) — mesmo idioma já usado por renderPipeline.ts
// (função pura que consome o estado, não o guarda).
// ════════════════════════════════════════════════
import type { ParameterEntry } from './catalogs';

// Linha fixa sempre visível no painel (8 parâmetros + "Others:") — porta de
// CPQ_FIXED_PARAM_ORDER em js/catalogs.js.
export const CPQ_FIXED_PARAM_ORDER = ['src_ip', 'dst_ip', 'src_port', 'dst_port', 'user', 'host', 'license', 'signature'] as const;

// Lista completa (painel "Others"), sempre alfabética por label/key — mesmo
// critério (localeCompare, sensitivity 'base') usado em renderCatalogUI()
// (js/catalogs.js) pra ordenar a lista antes de montar os chips.
export function sortParametersAlphabetically(parameters: ParameterEntry[]): ParameterEntry[] {
  return parameters
    .slice()
    .sort((a, b) => (a.label || a.key).localeCompare(b.label || b.key, undefined, { sensitivity: 'base' }));
}

// Mapa reverso "chave digitada (minúscula) -> token do catálogo" — porta de
// QUERY_ALIAS_MAP (rebuildQueryFieldDefs em js/query-bar.js). O original
// simplificou o catálogo de parâmetros pra não ter mais aliases além da
// própria key (1:1); preservamos essa mesma simplicidade aqui — o único
// alias de cada parâmetro é ele mesmo. Diferença deliberada (fortalecimento,
// não mudança de comportamento pra dados reais): o original guarda a chave
// do mapa exatamente como veio do catálogo (QUERY_ALIAS_MAP[a] = def, sem
// lowercase), mas o parser SEMPRE consulta com `.toLowerCase()` — um
// parâmetro cadastrado com alguma letra maiúscula na key nunca seria
// encontrado. Como toda key de parâmetro observada no catálogo já é
// minúscula (snake_case), isso nunca se manifestou, mas para não herdar
// essa armadilha silenciosa, construímos o mapa já com a chave em
// minúsculas dos dois lados.
export function buildQueryAliasMap(parameters: ParameterEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  parameters.forEach(p => {
    map[p.key.toLowerCase()] = p.key;
  });
  return map;
}

// Extrai pares "chave:valor" de um texto — porta de parseQueryTokens(). Sem
// espaço necessário entre pares (valores nunca contêm espaço); aceita "_" na
// chave. Ocorrência mais à direita da string vence (mesmo laço `while
// ((m = re.exec(...)))` sobrescrevendo found[def.token] a cada match).
export function parseQueryTokens(query: string, aliasMap: Record<string, string>): Record<string, string> {
  const found: Record<string, string> = {};
  const re = /([a-zA-Z_]+):(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query || ''))) {
    const token = aliasMap[m[1].toLowerCase()];
    if (token) found[token] = m[2];
  }
  return found;
}

// "Texto completo considerado" — tags confirmadas + o que está sendo digitado
// agora — porta de getComposedQuery().
export function getComposedQuery(tags: string[], liveText: string): string {
  return tags.concat(liveText ? [liveText] : []).join(' ');
}

// Divide um texto em um ou mais tokens "campo:valor" (separados por espaço) e
// confirma cada um como uma tag separada — porta de confirmQueryTagsFromText().
// Nunca duplica o mesmo campo (a ocorrência mais à direita da linha vence,
// mesmo critério usado tanto para Enter/paste quanto para aplicar uma
// entrada do histórico). Pura: recebe as tags existentes, devolve as novas —
// o original mutava `queryTags` (variável de módulo) diretamente.
export function confirmTagsFromText(existingTags: string[], text: string): string[] {
  let tags = existingTags.slice();
  (text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .forEach(tok => {
      const field = tok.split(':')[0];
      tags = tags.filter(t => t.split(':')[0] !== field);
      tags.push(tok);
    });
  return tags;
}

// Aplica o texto composto (tags + o que está sendo digitado) a um
// Record<string,string> plano com TODAS as chaves do catálogo de
// parâmetros (default '' quando ausente) — porta de
// applyQueryToHiddenInputs(), só que devolvendo um objeto em vez de mexer em
// <input type="hidden">. Esse objeto é exatamente o shape que
// CommandsContent.tsx/renderPipeline.ts (buildValues) já esperavam de
// SimpleQueryFields.tsx — nenhuma mudança rio abaixo.
export function computeFieldValues(tags: string[], liveText: string, catalogParams: ParameterEntry[]): Record<string, string> {
  const aliasMap = buildQueryAliasMap(catalogParams);
  const composed = getComposedQuery(tags, liveText);
  const found = parseQueryTokens(composed, aliasMap);
  const values: Record<string, string> = {};
  catalogParams.forEach(p => {
    values[p.key] = Object.prototype.hasOwnProperty.call(found, p.key) ? found[p.key] : '';
  });
  return values;
}

// Insere "campo:" no texto do campo — porta de insertFieldToken() (só a
// mecânica de substituição de string; foco/seleção de cursor é feito pelo
// componente via ref, já que aqui não há DOM). Separa o texto atual em
// `prefix` (tudo até o último espaço, incluindo ele) e `lastFragment` (a
// "palavra" sendo digitada agora, sem espaço) — se essa palavra ainda não
// tem ':', o clique SUBSTITUI só ela pelo token escolhido (evita o bug
// original "digitar 'src' e clicar em 'src_ip' resultava em 'src src_ip:'");
// caso contrário, ACRESCENTA um novo token separado por espaço.
export function insertFieldTokenValue(current: string, token: string): string {
  const m = current.match(/^(.*[\s])?(\S*)$/);
  const prefix = (m && m[1]) || '';
  const lastFragment = (m && m[2]) || '';
  if (lastFragment.includes(':')) {
    const sep = current.length && !/\s$/.test(current) ? ' ' : '';
    return current + sep + token + ':';
  }
  return prefix + token + ':';
}

// Fragmento de nome de campo sendo digitado agora, usado pelo typeahead do
// painel "Others" — porta de currentTypedFieldFragment(). Só filtra por
// texto enquanto o usuário ainda está ESCOLHENDO o campo (a parte antes do
// ':'); assim que já tem ':', ele escolheu o campo e está digitando o VALOR,
// e o filtro de texto para de fazer sentido.
export function currentTypedFieldFragment(liveText: string): string {
  if (liveText.includes(':')) return '';
  return liveText.trim().toLowerCase();
}
