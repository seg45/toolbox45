// ════════════════════════════════════════════════
// IP CALCULATOR — lógica pura, porta 1:1 de js/ipcalc.js (ipcPrefixToMaskLong/
// ipcParseMaskInput/ipcIpClass/ipcIpType/ipcCalculate/ipcSplitSubnets) —
// fatia 6. Sem nenhuma dependência de DOM/React aqui — a renderização
// "terminal" (ipcLine/ipcRenderNetworkBlock/etc. do original) mora em
// IpCalcModal.tsx, que consome só os dados puros devolvidos por este
// módulo. Reaproveita ipToLong/longToIp de netUtils.ts (NÃO duplicados
// aqui — já confirmados existentes e usados por resolvers.ts).
//
// Divergência deliberada do original: ipcSplitSubnets já grava `prefix` em
// cada sub-rede gerada (IpcSubnet inclui `prefix`), em vez de o chamador
// espalhar `{ ...sn, prefix: newPrefix }` na hora de renderizar (como
// ipcRunCalculate fazia) — mais simples de tipar em TS, mesmo resultado.
// ════════════════════════════════════════════════
import { ipToLong, longToIp } from './netUtils';

// ── Máscara/prefixo ──────────────────────────────
// (32 - prefix) pode valer 32 quando prefix=0 — deslocamento de bits em JS
// usa o operando módulo 32, então "x << 32" NÃO desloca nada (bug clássico);
// por isso prefix<=0 é tratado à parte, devolvendo a máscara zerada certa.
export function ipcPrefixToMaskLong(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff >>> 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

// Aceita "/24", "24" (CIDR/prefixo) ou "255.255.255.0" (máscara decimal
// pontuada) — devolve o prefixo (0-32) ou null se inválido. Uma máscara
// pontuada só é válida se for contígua (1s seguidos de 0s, sem "buracos").
export function ipcParseMaskInput(raw: string | null | undefined): number | null {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  s = s.replace(/^\//, '');
  if (/^\d{1,2}$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 0 && n <= 32 ? n : null;
  }
  const maskLong = ipToLong(s);
  if (maskLong === null) return null;
  const bin = (maskLong >>> 0).toString(2).padStart(32, '0');
  if (!/^1*0*$/.test(bin)) return null; // máscara não-contígua (ex.: 255.0.255.0) é inválida
  return (bin.match(/1/g) || []).length;
}

// ── Classificação do endereço ────────────────────
export function ipcIpClass(ipLong: number): string {
  const first = (ipLong >>> 24) & 255;
  if (first < 128) return 'A';
  if (first < 192) return 'B';
  if (first < 224) return 'C';
  if (first < 240) return 'D (Multicast)';
  return 'E (Experimental)';
}

// Só as faixas mais relevantes pro dia a dia de suporte — não é uma lista
// exaustiva de toda a IANA Special-Purpose Address Registry. Nomes curtos
// de propósito — aparecem entre parênteses na mesma linha do resultado.
export function ipcIpType(ipLong: number): string {
  const a = (ipLong >>> 24) & 255;
  const b = (ipLong >>> 16) & 255;
  if (a === 10) return 'Private Internet';
  if (a === 172 && b >= 16 && b <= 31) return 'Private Internet';
  if (a === 192 && b === 168) return 'Private Internet';
  if (a === 127) return 'Loopback';
  if (a === 169 && b === 254) return 'Link-Local';
  if (a === 100 && b >= 64 && b <= 127) return 'Shared Address Space';
  if (a >= 224 && a <= 239) return 'Multicast';
  if (a >= 240) return 'Reserved';
  return 'Public Internet';
}

export interface IpcCalcResult {
  ip: string;
  ipLong: number;
  prefix: number;
  networkLong: number;
  broadcastLong: number;
  firstHostLong: number;
  lastHostLong: number;
  cidr: string;
  maskDotted: string;
  maskLong: number;
  wildcardDotted: string;
  wildcardLong: number;
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  totalAddresses: number;
  usableHosts: number;
  ipClass: string;
  ipType: string;
}

export type IpcCalcOutcome = { error: string } | IpcCalcResult;

// ── Cálculo principal ─────────────────────────────
// Trata /31 (RFC 3021 — link ponto-a-ponto, ambos endereços são
// utilizáveis, sem conceito de rede/broadcast na prática) e /32 (host
// único) como casos especiais — a fórmula genérica (total-2) daria hosts
// negativos ou zero pra esses dois prefixos.
export function ipcCalculate(ipRaw: string, maskRaw: string): IpcCalcOutcome {
  const ipLong = ipToLong(String(ipRaw || '').trim());
  if (ipLong === null) return { error: 'Invalid IP address.' };
  const prefix = ipcParseMaskInput(maskRaw);
  if (prefix === null) return { error: 'Invalid mask — use CIDR (e.g. /24 or 24) or a dotted mask (e.g. 255.255.255.0).' };

  const maskLong = ipcPrefixToMaskLong(prefix);
  const wildcardLong = ~maskLong >>> 0;
  const networkLong = (ipLong & maskLong) >>> 0;
  const broadcastLong = (networkLong | wildcardLong) >>> 0;
  const totalAddresses = Math.pow(2, 32 - prefix);

  let usableHosts: number;
  let firstHostLong: number;
  let lastHostLong: number;
  if (prefix === 32) {
    usableHosts = 1;
    firstHostLong = networkLong;
    lastHostLong = networkLong;
  } else if (prefix === 31) {
    usableHosts = 2;
    firstHostLong = networkLong;
    lastHostLong = broadcastLong;
  } else {
    usableHosts = totalAddresses - 2;
    firstHostLong = networkLong + 1;
    lastHostLong = broadcastLong - 1;
  }

  return {
    ip: longToIp(ipLong),
    ipLong,
    prefix,
    networkLong,
    broadcastLong,
    firstHostLong,
    lastHostLong,
    cidr: `${longToIp(networkLong)}/${prefix}`,
    maskDotted: longToIp(maskLong),
    maskLong,
    wildcardDotted: longToIp(wildcardLong),
    wildcardLong,
    network: longToIp(networkLong),
    broadcast: longToIp(broadcastLong),
    firstHost: longToIp(firstHostLong),
    lastHost: longToIp(lastHostLong),
    totalAddresses,
    usableHosts,
    ipClass: ipcIpClass(ipLong),
    ipType: ipcIpType(ipLong),
  };
}

export interface IpcSubnet {
  networkLong: number;
  broadcastLong: number;
  firstHostLong: number;
  lastHostLong: number;
  prefix: number;
  cidr: string;
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  usableHosts: number;
  ipClass: string;
  ipType: string;
}

export interface IpcSplitSuccess {
  subnets: IpcSubnet[];
  count: number;
  truncated: boolean;
  generated: number;
}

export type IpcSplitOutcome = { error: string } | IpcSplitSuccess;

// Type guard único pros dois tipos de saída (cálculo principal e split) —
// parâmetro tipado como a união dos dois (em vez de um `{error?:string}`
// genérico) pra evitar o erro de "weak type" do TS (IpcCalcResult/
// IpcSplitSuccess não compartilham nenhuma propriedade com um tipo cujos
// campos são todos opcionais).
export function isIpcError(x: IpcCalcOutcome | IpcSplitOutcome): x is { error: string } {
  return 'error' in x;
}

// ── Split de sub-rede ─────────────────────────────
// Divide a rede [networkLong, basePrefix] em blocos iguais de prefixo
// newPrefix (ex.: /24 -> N x /25, /26...). IPC_MAX_SUBNETS é um teto de
// segurança pra não travar a tela caso o usuário peça algo como /8 -> /30.
export const IPC_MAX_SUBNETS = 512;

export function ipcSplitSubnets(networkLong: number, basePrefix: number, newPrefix: number): IpcSplitOutcome {
  if (!(newPrefix > basePrefix)) return { error: 'The new prefix must be longer (a bigger number) than the current one.' };
  if (newPrefix > 32) return { error: 'Prefix cannot exceed /32.' };
  const count = Math.pow(2, newPrefix - basePrefix);
  const genCount = Math.min(count, IPC_MAX_SUBNETS);
  const blockSize = Math.pow(2, 32 - newPrefix);
  const subnets: IpcSubnet[] = [];
  for (let i = 0; i < genCount; i++) {
    const subNet = (networkLong + i * blockSize) >>> 0;
    const subBcast = (subNet + blockSize - 1) >>> 0;
    let usable: number, first: number, last: number;
    if (newPrefix === 32) {
      usable = 1;
      first = subNet;
      last = subNet;
    } else if (newPrefix === 31) {
      usable = 2;
      first = subNet;
      last = subBcast;
    } else {
      usable = blockSize - 2;
      first = subNet + 1;
      last = subBcast - 1;
    }
    subnets.push({
      networkLong: subNet,
      broadcastLong: subBcast,
      firstHostLong: first,
      lastHostLong: last,
      prefix: newPrefix,
      cidr: `${longToIp(subNet)}/${newPrefix}`,
      network: longToIp(subNet),
      broadcast: longToIp(subBcast),
      firstHost: longToIp(first),
      lastHost: longToIp(last),
      usableHosts: usable,
      ipClass: ipcIpClass(subNet),
      ipType: ipcIpType(subNet),
    });
  }
  return { subnets, count, truncated: count > genCount, generated: genCount };
}
