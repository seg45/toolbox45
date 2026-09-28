// ════════════════════════════════════════════════
// NET UTILS — porta 1:1 de js/net-utils.js. Funções puras de parsing/
// geração de filtros de IP/porta (listas, ranges, CIDR) consumidas pelos
// ~10 resolvers avançados em resolvers.ts (fatia 3c — ver comentário no
// topo daquele arquivo). Nenhuma dependência de DOM/React aqui.
//
// Preserva a lógica e os "números mágicos" EXATAMENTE como no original:
// MAX_ENUM=4/MAX_COMBOS=6 em buildFwMonitorFilters; maxBlocks default 5 em
// ipRangeTerms só é usado quando ipRangeTerms é chamada diretamente sem
// segundo argumento — na cadeia normal (combinedAddrRegex -> buildAddrTerms
// -> ipRangeTerms), buildAddrTerms sempre passa `maxBlocks || 64`, então o
// limite efetivo de blocos /24 numa chamada normal (combinedAddrRegex sem
// segundo argumento) é 64, não 5.
// ════════════════════════════════════════════════

export interface ParsedAddr {
  items: string[];
  ranges: { start: string; end: string }[];
  raw: string;
  isMulti: boolean;
  isRange: boolean;
}

export interface ParsedPorts {
  items: string[];
  raw: string;
  isMulti: boolean;
}

export interface AddrTermsResult {
  terms: string[];
  rangeTooLarge: boolean;
}

export interface IpRangeTermsResult {
  terms: string[];
  tooLarge: boolean;
  invalid?: boolean;
  blockCount?: number;
}

export interface CombinedAddrRegexResult {
  regex: string | null;
  rangeTooLarge: boolean;
}

export interface ExpandAddrDiscreteResult {
  list: string[];
  skippedRange: boolean;
  truncated: boolean;
}

export interface SmallestEnclosingCidrResult {
  blockStart: number;
  blockSize: number;
  prefix: number;
}

export interface TcpdumpClauseResult {
  clause: string | null;
  notes: string[];
}

export interface FwMonitorFiltersResult {
  flagsStr: string;
  notes: string[];
}

export function ipToLong(ip: string): number | null {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

export function longToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function parseAddr(raw: string | null | undefined): ParsedAddr {
  const s = (raw || '').trim();
  if (!s) return { items: [], ranges: [], raw: s, isMulti: false, isRange: false };
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  const items: string[] = [];
  const ranges: { start: string; end: string }[] = [];
  parts.forEach(part => {
    const dashIdx = part.indexOf('-', 1); // ignora hífen inicial (não deveria ocorrer em IP)
    if (dashIdx > 0) {
      const a = part.slice(0, dashIdx).trim();
      const b = part.slice(dashIdx + 1).trim();
      if (ipToLong(a) !== null && ipToLong(b) !== null) {
        ranges.push({ start: a, end: b });
        return;
      }
    }
    items.push(part);
  });
  return { items, ranges, raw: s, isMulti: items.length > 1 || ranges.length > 0, isRange: ranges.length > 0 };
}

export function parsePorts(raw: string | null | undefined): ParsedPorts {
  const s = (raw || '').trim();
  if (!s) return { items: [], raw: s, isMulti: false };
  const items = s.split(',').map(x => x.trim()).filter(Boolean);
  return { items, raw: s, isMulti: items.length > 1 };
}

export function octetRangeToRegex(minIn: number, maxIn: number): string {
  let min = minIn;
  let max = maxIn;
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  min = Math.max(0, Math.min(255, min));
  max = Math.max(0, Math.min(255, max));
  const alts: string[] = [];
  let n = min;
  while (n <= max) {
    if (n % 10 === 0 && n + 9 <= max) {
      const tens = Math.floor(n / 10);
      alts.push(tens === 0 ? '[0-9]' : `${tens}[0-9]`);
      n += 10;
    } else {
      const blockEnd = Math.min(max, Math.floor(n / 10) * 10 + 9);
      if (n === blockEnd) {
        alts.push(String(n));
      } else {
        const tens = Math.floor(n / 10);
        const loU = n % 10;
        const hiU = blockEnd % 10;
        alts.push(tens === 0 ? `[${loU}-${hiU}]` : `${tens}[${loU}-${hiU}]`);
      }
      n = blockEnd + 1;
    }
  }
  return alts.join('|');
}

export function cidrFromRange(startIp: string, endIp: string): string | null {
  const s = ipToLong(startIp);
  const e = ipToLong(endIp);
  if (s === null || e === null) return null;
  const lo = Math.min(s, e);
  const hi = Math.max(s, e);
  const size = hi - lo + 1;
  if ((size & (size - 1)) !== 0) return null;
  if (lo % size !== 0) return null;
  const prefix = 32 - Math.log2(size);
  return `${longToIp(lo)}/${prefix}`;
}

export function ipRangeTerms(startIp: string, endIp: string, maxBlocksIn?: number): IpRangeTermsResult {
  const maxBlocks = maxBlocksIn || 5;
  const s = ipToLong(startIp);
  const e = ipToLong(endIp);
  if (s === null || e === null) return { terms: [], tooLarge: false, invalid: true };
  const lo = Math.min(s, e);
  const hi = Math.max(s, e);
  const loBlock = Math.floor(lo / 256);
  const hiBlock = Math.floor(hi / 256);
  const blockCount = hiBlock - loBlock + 1;
  if (blockCount > maxBlocks) return { terms: [], tooLarge: true, blockCount };
  const terms: string[] = [];
  for (let b = loBlock; b <= hiBlock; b++) {
    const blockStart = b * 256;
    const blockEnd = b * 256 + 255;
    const rangeLo = Math.max(lo, blockStart) - blockStart;
    const rangeHi = Math.min(hi, blockEnd) - blockStart;
    const prefix = longToIp(blockStart).split('.').slice(0, 3).join('\\.');
    const octRegex = octetRangeToRegex(rangeLo, rangeHi);
    terms.push(`${prefix}\\.(${octRegex})`);
  }
  return { terms, tooLarge: false, blockCount };
}

export function ipLiteralTerm(ip: string): string {
  return ip.trim().replace(/\./g, '\\.') + '([^0-9]|$)';
}

export function buildAddrTerms(parsed: ParsedAddr, maxBlocks?: number): AddrTermsResult {
  const terms: string[] = [];
  let rangeTooLarge = false;
  parsed.items.forEach(ip => terms.push(ipLiteralTerm(ip)));
  parsed.ranges.forEach(r => {
    const res = ipRangeTerms(r.start, r.end, maxBlocks || 64);
    if (res.tooLarge || res.invalid) {
      rangeTooLarge = true;
      return;
    }
    res.terms.forEach(t => terms.push(`${t}([^0-9]|$)`));
  });
  return { terms, rangeTooLarge };
}

export function combinedAddrRegex(parsedList: ParsedAddr[], maxBlocks?: number): CombinedAddrRegexResult {
  let terms: string[] = [];
  let rangeTooLarge = false;
  parsedList.forEach(p => {
    const r = buildAddrTerms(p, maxBlocks);
    terms = terms.concat(r.terms);
    if (r.rangeTooLarge) rangeTooLarge = true;
  });
  return { regex: terms.length ? terms.join('|') : null, rangeTooLarge };
}

export function expandAddrDiscrete(parsed: ParsedAddr, maxEnumIn?: number, capTotalIn?: number): ExpandAddrDiscreteResult {
  const maxEnum = maxEnumIn || 8;
  const capTotal = capTotalIn || 5;
  const list: string[] = [...parsed.items];
  let skippedRange = false;
  parsed.ranges.forEach(r => {
    const a = ipToLong(r.start);
    const b = ipToLong(r.end);
    if (a === null || b === null) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo + 1 <= maxEnum) {
      for (let n = lo; n <= hi; n++) list.push(longToIp(n));
    } else {
      skippedRange = true;
    }
  });
  const truncated = list.length > capTotal;
  return { list: list.slice(0, capTotal), skippedRange, truncated };
}

export function smallestEnclosingCidr(lo: number, hi: number): SmallestEnclosingCidrResult {
  let blockSize = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const blockStart = Math.floor(lo / blockSize) * blockSize;
    if (blockStart + blockSize - 1 >= hi) return { blockStart, blockSize, prefix: 32 - Math.log2(blockSize) };
    blockSize *= 2;
    if (blockSize > 4294967296) return { blockStart: 0, blockSize: 4294967296, prefix: 0 };
  }
}

export function tcpdumpClause(parsed: ParsedAddr, maxOrListIn?: number): TcpdumpClauseResult {
  const maxOrList = maxOrListIn || 16;
  const hostTerms = parsed.items.map(ip => `host ${ip}`);
  const notes: string[] = [];
  parsed.ranges.forEach(r => {
    const cidr = cidrFromRange(r.start, r.end);
    if (cidr) {
      hostTerms.push(`net ${cidr}`);
      return;
    }
    const a = ipToLong(r.start) as number;
    const b = ipToLong(r.end) as number;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const size = hi - lo + 1;
    if (size <= maxOrList) {
      for (let n = lo; n <= hi; n++) hostTerms.push(`host ${longToIp(n)}`);
    } else {
      const { blockStart, prefix } = smallestEnclosingCidr(lo, hi);
      hostTerms.push(`net ${longToIp(blockStart)}/${prefix}`);
      notes.push(
        `Range ${r.start}-${r.end} is not an exact block — filter widened to subnet ${longToIp(blockStart)}/${prefix} (broader than requested; refine in Wireshark if you need the exact range).`
      );
    }
  });
  return { clause: hostTerms.length ? '(' + hostTerms.join(' or ') + ')' : null, notes };
}

export function buildFwMonitorFilters(
  srcRaw: string,
  dstRaw: string,
  spRaw: string,
  dpRaw: string,
  proto: string
): FwMonitorFiltersResult {
  const MAX_ENUM = 4;
  const MAX_COMBOS = 6;
  const srcP = parseAddr(srcRaw);
  const dstP = parseAddr(dstRaw);
  const spP = parsePorts(spRaw);
  const dpP = parsePorts(dpRaw);
  const srcX = expandAddrDiscrete(srcP, MAX_ENUM, 999);
  const dstX = expandAddrDiscrete(dstP, MAX_ENUM, 999);
  const srcList = srcX.list.length ? srcX.list : srcX.skippedRange ? [] : [srcRaw];
  const dstList = dstX.list.length ? dstX.list : dstX.skippedRange ? [] : [dstRaw];
  const spList = spP.items.length ? spP.items : [spRaw || '0'];
  const dpList = dpP.items.length ? dpP.items : [dpRaw || '0'];

  if (srcList.length === 0 || dstList.length === 0) {
    return {
      flagsStr: '',
      notes: [
        'fw monitor -F requires exact IPs and does not accept a range/subnet — the given range is too large to enumerate (limit of 4 addresses). No -F filter generated; use tcpdump (accepts net/CIDR) or narrow the range to up to 4 IPs.',
      ],
    };
  }

  const combos: { s: string; d: string; sp: string; dp: string }[] = [];
  outer: for (const s of srcList) {
    for (const d of dstList) {
      for (const sp2 of spList) {
        for (const dp2 of dpList) {
          if (combos.length >= MAX_COMBOS) break outer;
          combos.push({ s, d, sp: sp2, dp: dp2 });
        }
      }
    }
  }

  const flags: string[] = [];
  combos.forEach(c => {
    flags.push(`-F "${c.s},${c.sp},${c.d},${c.dp},${proto}"`);
    flags.push(`-F "${c.d},${c.dp},${c.s},${c.sp},${proto}"`);
  });

  const totalPossible = srcList.length * dstList.length * spList.length * dpList.length;
  const notes: string[] = [];
  if (srcX.skippedRange || dstX.skippedRange) {
    notes.push(
      'fw monitor -F requires exact IPs — it does not accept a range/subnet. A range too large to enumerate was skipped; capture without this filter and refine with tcpdump -r + Wireshark, or repeat the command per IP.'
    );
  }
  if (totalPossible > MAX_COMBOS) {
    notes.push(`Generated ${combos.length} of ${totalPossible} possible combinations (safety limit) — duplicate the -F pairs manually if you need the rest.`);
  }
  return { flagsStr: flags.join(' '), notes };
}
