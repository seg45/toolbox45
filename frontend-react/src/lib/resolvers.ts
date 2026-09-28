// ════════════════════════════════════════════════
// RESOLVERS — um por valor de placeholder_resolver. Cada um recebe a row da
// API (já resolvida quanto a idioma; row.lines.default ainda contém
// placeholders {{token}}) e os values atuais, e devolve { lines } no mesmo
// formato que buildCardDataForRow() (renderPipeline.ts) espera.
//
// Porta 1:1 dos ~10 resolvers avançados de js/db-render-engine.js (fw
// monitor, tcpdump, zdebug, fw log, fw logexport, fw fetchlogs, conntable,
// nattable, ip route get, fwaccel conns) — fatia 3c. Toda a lógica de
// parsing/geração de filtro de IP/porta (listas, ranges, CIDR) mora em
// ./netUtils (porta de js/net-utils.js, fatia 3c).
//
// Adaptações de porte para este projeto TS (ver instruções da fatia):
// - resolveTokens/resolveTokensMarked/dbLinesToTerm/buildLineWithOverride
//   pedem um 3º/4º argumento `catalogParams: ParameterEntry[]` que não
//   existe no original (lá o catálogo é lido de uma variável global). Os
//   resolvers abaixo sempre passam `[]`: catalogParams só afeta o hint
//   "<Label>" mostrado quando um token {{key}} não tem valor, e aqui só
//   resolvemos texto ESTÁTICO de nota/warning dos próprios templates (sem
//   placeholders de parâmetros customizados) ou tokens {{src_ip}}/
//   {{dst_ip}} que hasIPs já garante que têm valor antes do resolver ser
//   chamado (ver renderPipeline.ts::buildCardDataForRow) — nunca cai no
//   ramo de hint, então o catálogo nunca faz falta.
// - markVar() é tipado retornando `string | null | undefined`. Na prática,
//   dentro deste arquivo, ele só é chamado sobre um valor que o próprio
//   código local já garantiu não-vazio (checagem `iface ? ... : ''`,
//   `flagsStr` sempre string, etc.) — nesses pontos um `as string` documenta
//   essa garantia, mesmo padrão já usado em QueryBar.tsx/queryBar.ts.
// ════════════════════════════════════════════════
import type { Command, CommandLine } from './commands';
import {
  buildLineWithOverride,
  dbLinesToTerm,
  markVar,
  resolveTokens,
  resolveTokensMarked,
  type TermLine,
  type Values,
} from './commandTemplate';
import {
  buildFwMonitorFilters,
  combinedAddrRegex,
  expandAddrDiscrete,
  parseAddr,
  parsePorts,
  tcpdumpClause,
} from './netUtils';

const RANGE_TOO_LARGE_NOTE =
  'A range that is too large (more than 64 /24 blocks) was skipped in the filter — narrow the range or search in parts.';

// Descarta as entradas `null` de uma lista de TermLine "possivelmente
// ausente" (linha de nota estática que só existe quando o template tem uma,
// export/redirecionamento condicional, etc.) preservando o tipo —
// equivalente ao `.filter(Boolean)` do original, que o TS não tipa sozinho.
function compact(lines: (TermLine | null)[]): TermLine[] {
  return lines.filter((l): l is TermLine => l !== null);
}

function findLine(lines: CommandLine[] | undefined, type: CommandLine['line_type']): CommandLine | undefined {
  return (lines || []).find(l => l.line_type === type);
}

export const RESOLVERS: Record<string, (row: Command, values: Values) => { lines: TermLine[] }> = {};

// ── fw monitor -F ("Debug: fw monitor") ────────────────────────────────
RESOLVERS.fwmonitor = (row, values) => {
  const { src_ip: src, dst_ip: dst, src_port: sp, dst_port: dp, proto, iface } = values;
  const fwmonFilters = buildFwMonitorFilters(src, dst, sp, dp, proto);
  const ifF = iface ? ` -i ${markVar(iface) as string}` : '';
  const fwmonCmd = `fw monitor${ifF} ${markVar(fwmonFilters.flagsStr) as string}`;
  const staticNote = findLine(row.lines.default, 'note');
  const lines = compact([
    { p: '[Expert@FW]#', c: fwmonCmd },
    staticNote ? { type: 'note', c: resolveTokens(staticNote.content, values, []) as string } : null,
    ...fwmonFilters.notes.map(n => ({ type: 'warn' as const, c: n })),
  ]);
  return { lines };
};

// ── tcpdump (captura de pacotes) ───────────────────────────────────────
RESOLVERS.tcpdump = (row, values) => {
  const { src_ip: src, dst_ip: dst, src_port: sp, dst_port: dp, proto, iface } = values;
  const srcP = parseAddr(src);
  const dstP = parseAddr(dst);
  const spP = parsePorts(sp);
  const dpP = parsePorts(dp);
  const tcpProto = proto === '6' ? ' and tcp' : proto === '17' ? ' and udp' : proto === '1' ? ' and icmp' : '';
  const tcpIf = iface ? `-i ${markVar(iface) as string}` : '-i any';
  const srcClauseObj = tcpdumpClause(srcP);
  const dstClauseObj = tcpdumpClause(dstP);
  const tcpNotesArr = [...srcClauseObj.notes, ...dstClauseObj.notes];
  const spActive = spP.items.filter(p => p && p !== '0');
  const dpActive = dpP.items.filter(p => p && p !== '0');
  const spClause = spActive.length ? ` and (${spActive.map(p => `src port ${p}`).join(' or ')})` : '';
  const dpClause = dpActive.length ? ` and (${dpActive.map(p => `dst port ${p}`).join(' or ')})` : '';
  const tcpFlt = `"${srcClauseObj.clause || `host ${src}`} and ${dstClauseObj.clause || `host ${dst}`}${tcpProto}${spClause}${dpClause}"`;
  const tcpCmd = `tcpdump ${tcpIf} -nn -s 0 ${markVar(tcpFlt) as string}`;
  const staticNote = findLine(row.lines.default, 'note');
  const lines = compact([
    { p: '[Expert@FW]#', c: tcpCmd },
    staticNote ? { type: 'note', c: resolveTokens(staticNote.content, values, []) as string } : null,
    ...tcpNotesArr.map(n => ({ type: 'warn' as const, c: n })),
  ]);
  return { lines };
};

// ── fw ctl zdebug + drop ────────────────────────────────────────────────
RESOLVERS.zdebug = (row, values) => {
  const { src_ip: src, dst_ip: dst, FL } = values;
  const srcP = parseAddr(src);
  const dstP = parseAddr(dst);
  const orRegex = combinedAddrRegex([srcP, dstP]);
  const orRegexStr = orRegex.regex || `${src}|${dst}`;
  const orRegexNotes = orRegex.rangeTooLarge ? [RANGE_TOO_LARGE_NOTE] : [];
  const cmdLine = findLine(row.lines.default, 'cmd');
  const exportSuffix =
    FL.log && cmdLine && cmdLine.export_template
      ? ` ${resolveTokensMarked(cmdLine.export_template, values, []) as string}`
      : '';
  const zdCmd = `fw ctl zdebug + drop | grep -E "${markVar(orRegexStr) as string}"${exportSuffix}`;
  const warnLine = findLine(row.lines.default, 'warn');
  const lines = compact([
    { p: '[Expert@FW]#', c: zdCmd },
    warnLine ? { type: 'warn', c: resolveTokens(warnLine.content, values, []) as string } : null,
    ...orRegexNotes.map(n => ({ type: 'warn' as const, c: n })),
  ]);
  return { lines };
};

// ── fw log -n (query de logs local) ────────────────────────────────────
RESOLVERS.fwlog = (row, values) => {
  const { src_ip: src, dst_ip: dst, FL } = values;
  const srcP = parseAddr(src);
  const dstP = parseAddr(dst);
  const orRegex = combinedAddrRegex([srcP, dstP]);
  const orRegexStr = orRegex.regex || `${src}|${dst}`;
  const orRegexNotes = orRegex.rangeTooLarge ? [RANGE_TOO_LARGE_NOTE] : [];
  const cmdLine = findLine(row.lines.default, 'cmd');
  const logRedir =
    FL.log && cmdLine && cmdLine.export_template
      ? ` ${resolveTokensMarked(cmdLine.export_template, values, []) as string}`
      : '';
  const fwlogUsesFallback = srcP.isMulti || dstP.isMulti;
  const fwlogCmd = fwlogUsesFallback
    ? `fw log -n | grep -E "${markVar(orRegexStr) as string}"${logRedir}`
    : `fw log -n -s ${markVar(src) as string} -d ${markVar(dst) as string}${logRedir}`;
  const fwlogCmdDrop = fwlogUsesFallback
    ? `fw log -n -c drop | grep -E "${markVar(orRegexStr) as string}"${logRedir}`
    : `fw log -n -s ${markVar(src) as string} -d ${markVar(dst) as string} -c drop${logRedir}`;
  const staticNote = findLine(row.lines.default, 'note');
  const fallbackNote: TermLine[] = fwlogUsesFallback
    ? [
        {
          type: 'info',
          c: 'SRC/DST with a list or range: -s/-d only accept a single exact IP, so we filter with grep -E instead.',
        },
        ...orRegexNotes.map(n => ({ type: 'warn' as const, c: n })),
      ]
    : [];
  const lines = compact([
    { p: '[Expert@FW]#', c: fwlogCmd },
    { p: '[Expert@FW]#', c: fwlogCmdDrop },
    staticNote ? { type: 'note', c: resolveTokens(staticNote.content, values, []) as string } : null,
    ...fallbackNote,
  ]);
  return { lines };
};

// ── fwm logexport (exportação para CSV) ────────────────────────────────
RESOLVERS.logexport = (row, values) => {
  const { src_ip: src, dst_ip: dst, src_port: sp, dst_port: dp, FL, logFile } = values;
  const srcP = parseAddr(src);
  const dstP = parseAddr(dst);
  const spP = parsePorts(sp);
  const dpP = parsePorts(dp);
  const isMultiFilter = srcP.isMulti || dstP.isMulti || spP.isMulti || dpP.isMulti;
  const expOut = FL.log ? logFile : '/tmp/fw_export.txt';
  const dbLines = row.lines.default || [];
  const lines: TermLine[] = dbLines.map(l =>
    buildLineWithOverride(l, values, [['/tmp/fw_export.txt', markVar(expOut) as string]], [])
  );
  if (isMultiFilter) {
    lines.push({
      type: 'info',
      c: 'logexport filters a single exact IP at a time in -s/-e — for a list/range, export once without a filter and trim the CSV, or repeat per IP.',
    });
  }
  return { lines };
};

// ── fw fetchlogs (SmartCenter -> gateway) ──────────────────────────────
RESOLVERS.fetchlogs = (row, values) => {
  const { src_ip: src } = values;
  const srcP = parseAddr(src);
  const fetchX = expandAddrDiscrete(srcP, 8, 5);
  const fetchList = fetchX.list.length ? fetchX.list : fetchX.skippedRange ? [] : [src];
  const staticNote = findLine(row.lines.default, 'note');
  const lines = compact([
    ...(fetchList.length
      ? fetchList.map(ip => ({ p: '[Expert@SMS]#', c: `fw fetchlogs ${markVar(ip) as string}` }))
      : [
          {
            type: 'info' as const,
            c: 'Fill in a valid gateway IP, or a small list/range (up to 8 addresses), to generate the fw fetchlogs command(s).',
          },
        ]),
    ...(fetchList.length && staticNote ? [{ type: 'note' as const, c: resolveTokens(staticNote.content, values, []) as string }] : []),
    ...(fetchX.skippedRange
      ? [{ type: 'warn' as const, c: 'Range too large to enumerate automatically (limit of 8 addresses) — repeat fw fetchlogs manually per IP.' }]
      : []),
    ...(fetchX.truncated
      ? [{ type: 'warn' as const, c: `Showing the first ${fetchList.length} IPs — repeat the command for the rest.` }]
      : []),
  ]);
  return { lines };
};

// ── fw tab -t connections (busca substituindo {{src_ip}}/{{dst_ip}} pelo
// regex OR quando há lista/range) ──────────────────────────────────────
RESOLVERS.conntable = (row, values) => {
  const { src_ip: src, dst_ip: dst } = values;
  const srcP = parseAddr(src);
  const dstP = parseAddr(dst);
  const srcRes = combinedAddrRegex([srcP]);
  const dstRes = combinedAddrRegex([dstP]);
  const srcTerm = srcRes.regex || src;
  const dstTerm = dstRes.regex || dst;
  const notes: TermLine[] = srcRes.rangeTooLarge || dstRes.rangeTooLarge ? [{ type: 'warn', c: RANGE_TOO_LARGE_NOTE }] : [];
  const subValues: Values = { ...values, src_ip: srcTerm, dst_ip: dstTerm };
  const lines = [...dbLinesToTerm(row.lines.default, subValues, []), ...notes];
  return { lines };
};

// ── fw tab -t connections (variante NAT) — mesma lógica de substituição de
// conntable, comando diferente já vem do template (row.lines.default) ────
RESOLVERS.nattable = (row, values) => {
  const { src_ip: src, dst_ip: dst } = values;
  const srcP = parseAddr(src);
  const dstP = parseAddr(dst);
  const srcRes = combinedAddrRegex([srcP]);
  const dstRes = combinedAddrRegex([dstP]);
  const srcTerm = srcRes.regex || src;
  const dstTerm = dstRes.regex || dst;
  const notes: TermLine[] = srcRes.rangeTooLarge || dstRes.rangeTooLarge ? [{ type: 'warn', c: RANGE_TOO_LARGE_NOTE }] : [];
  const subValues: Values = { ...values, src_ip: srcTerm, dst_ip: dstTerm };
  const lines = [...dbLinesToTerm(row.lines.default, subValues, []), ...notes];
  return { lines };
};

// ── ip route get / arp -n (rota específica para um destino) ───────────
RESOLVERS.routespecific = (row, values) => {
  const { dst_ip: dst } = values;
  const dstP = parseAddr(dst);
  const routeX = expandAddrDiscrete(dstP, 8, 5);
  const routeList = routeX.list.length ? routeX.list : routeX.skippedRange ? [] : [dst];
  const routeNotes: TermLine[] = [];
  if (routeX.skippedRange) {
    routeNotes.push({ type: 'warn', c: 'Range too large to enumerate automatically (limit of 8 addresses) — repeat ip route get manually per IP.' });
  }
  if (routeX.truncated) {
    routeNotes.push({ type: 'warn', c: `Showing the first ${routeList.length} IPs — repeat the command for the rest.` });
  }
  const routeNetstatGrep = routeList.length
    ? `netstat -rn | grep ${markVar(routeList[0].split('.').slice(0, 3).join('.')) as string}`
    : 'netstat -rn';
  const dbLines = row.lines.default || [];
  const netstatNote = dbLines.find(l => l.line_type === 'note' && /netstat/.test(l.content || ''));
  const gaiaLines = dbLines.filter(l => l.prompt === '[Gaia]>');
  const lines = compact([
    ...(routeList.length
      ? routeList.flatMap(ip => [
          { p: '[Expert@FW]#', c: `ip route get ${markVar(ip) as string}` },
          { p: '[Expert@FW]#', c: `arp -n | grep ${markVar(ip) as string}` },
        ])
      : [
          {
            type: 'info' as const,
            c: 'Fill in a valid destination IP, or a small list/range (up to 8 addresses), to generate the ip route get command(s).',
          },
        ]),
    { p: '[Expert@FW]#', c: routeNetstatGrep },
    netstatNote ? { type: 'note', c: resolveTokens(netstatNote.content, values, []) as string } : null,
    ...gaiaLines.map(l => ({ p: l.prompt, c: resolveTokensMarked(l.content, values, []) as string })),
    ...routeNotes,
  ]);
  return { lines };
};

// ── fwaccel conns (conexões aceleradas pelo SecureXL) ──────────────────
RESOLVERS.fwaccelconns = (row, values) => {
  const { src_ip: src, dst_ip: dst } = values;
  const srcP = parseAddr(src);
  const dstP = parseAddr(dst);
  const orRes = combinedAddrRegex([srcP, dstP]);
  const orRegexStr = orRes.regex || `${src}|${dst}`;
  const notes: TermLine[] = orRes.rangeTooLarge ? [{ type: 'warn', c: RANGE_TOO_LARGE_NOTE }] : [];
  const fwaccelCmd = `fwaccel conns | grep -E "${markVar(orRegexStr) as string}"`;
  const staticNote = findLine(row.lines.default, 'note');
  const lines = compact([
    { p: '[Expert@FW]#', c: fwaccelCmd },
    staticNote ? { type: 'note', c: resolveTokens(staticNote.content, values, []) as string } : null,
    ...notes,
  ]);
  return { lines };
};
