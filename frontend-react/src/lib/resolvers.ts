// ════════════════════════════════════════════════
// RESOLVERS — um por valor de placeholder_resolver. Cada um recebe a row da
// API (já resolvida quanto a idioma; row.lines.default ainda contém
// placeholders {{token}}) e os values atuais, e devolve { lines } no mesmo
// formato que buildCardDataForRow() (renderPipeline.ts) espera.
//
// ESCOPO DESTA FATIA (3a): os ~10 comandos "avançados" (fw monitor, tcpdump,
// zdebug, fw log, fwm logexport, fw fetchlogs, conntable, nattable,
// ip route get, fwaccel conns) dependem de js/net-utils.js
// (parseAddr/parsePorts/tcpdumpClause/combinedAddrRegex/
// buildFwMonitorFilters/expandAddrDiscrete) — fora do escopo desta fatia,
// entram na fatia 3c. Até lá RESOLVERS fica vazio de propósito.
//
// Isso não precisa de nenhum tratamento especial em renderPipeline.ts: o
// mesmo comportamento de fallback do original já se aplica sozinho —
// `row.placeholder_resolver && RESOLVERS[row.placeholder_resolver]` dá
// undefined (chave inexistente), então `resolver` fica falsy e o código cai
// no caminho normal (dbLinesToTerm sobre row.lines.default), que já faz a
// substituição simples de {{tokens}} — só sem a lógica avançada de parsing
// de lista/range/CIDR de IP. Essas ~10 linhas de comando aparecem com o
// texto do template ainda cru substituído ingenuamente até a fatia 3c
// implementar os resolvers de verdade.
// ════════════════════════════════════════════════
import type { Command } from './commands';
import type { TermLine, Values } from './commandTemplate';

export const RESOLVERS: Record<string, (row: Command, values: Values) => { lines: TermLine[] }> = {};
