// ════════════════════════════════════════════════
// IP CALCULATOR — item "IP Calc" do menu "Tools" no header (#ipCalcOverlay
// no original) — fatia 6. Porta de UI de js/ipcalc.js (ipcRunCalculate/
// ipcLine/ipcNetmaskLine/ipcRenderNetworkBlock/ipcToggleNetmaskInfo) por
// cima da lógica pura já portada em src/lib/ipcalc.ts.
//
// Montado SEMPRE pelo Header (não condicionalmente) — só a classe "show" do
// overlay alterna a visibilidade (mesmo padrão de useConfirm.tsx) — porque
// o PRÓPRIO estado React dos campos (Address/Netmask/Move to) precisa
// sobreviver a fechar e reabrir o modal, igual ao original (os <input> do
// DOM mantinham o valor digitado mesmo com o modal escondido via CSS). Um
// <IpCalcModal/> condicional (open && <IpCalcModal/>) desmontaria e
// perderia esse estado a cada fechada — por isso `open` é só uma prop que
// troca a classe, nunca a existência do componente.
//
// Pedido do usuário (preservado): o modal SEMPRE abre com um resultado já
// calculado (192.168.0.1/24 na primeiríssima vez; os valores já digitados
// numa sessão anterior do modal, recalculados, da próxima vez em diante) —
// ver o useEffect de transição `false -> true` de `open` abaixo. E fecha
// SOMENTE pelo "✕" — sem onClick de overlay nem listener de Escape
// (ao contrário de todo outro modal do app), de propósito, pra não perder
// o "move to" digitado com um clique/tecla acidental.
// ════════════════════════════════════════════════
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { longToIp } from '../lib/netUtils';
import { copyToClipboard } from './commands/CopyButton';
import {
  ipcCalculate,
  ipcParseMaskInput,
  ipcPrefixToMaskLong,
  ipcSplitSubnets,
  isIpcError,
  type IpcCalcResult,
  type IpcSubnet,
} from '../lib/ipcalc';

// 33 linhas /32..0 da tabela de referência CIDR→máscara — estático, mesmo
// conteúdo do original (index.html).
const CIDR_TABLE: Array<[number, string]> = [
  [32, '255.255.255.255'], [31, '255.255.255.254'], [30, '255.255.255.252'], [29, '255.255.255.248'],
  [28, '255.255.255.240'], [27, '255.255.255.224'], [26, '255.255.255.192'], [25, '255.255.255.128'],
  [24, '255.255.255.0'], [23, '255.255.254.0'], [22, '255.255.252.0'], [21, '255.255.248.0'],
  [20, '255.255.240.0'], [19, '255.255.224.0'], [18, '255.255.192.0'], [17, '255.255.128.0'],
  [16, '255.255.0.0'], [15, '255.254.0.0'], [14, '255.252.0.0'], [13, '255.248.0.0'],
  [12, '255.240.0.0'], [11, '255.224.0.0'], [10, '255.192.0.0'], [9, '255.128.0.0'],
  [8, '255.0.0.0'], [7, '254.0.0.0'], [6, '252.0.0.0'], [5, '248.0.0.0'],
  [4, '240.0.0.0'], [3, '224.0.0.0'], [2, '192.0.0.0'], [1, '128.0.0.0'], [0, '0.0.0.0'],
];

// ── Representação binária pontuada, com um espaço extra na fronteira
// rede/host (exceto quando ela já cai num ponto de octeto) — porte 1:1 de
// _ipcDottedBinary (js/ipcalc.js). `splitIdx` do original não é usado (o
// binário inteiro já fica numa cor só, ver comentário de ipcBinHtml lá) —
// omitido aqui de propósito, sem efeito visível.
function ipcDottedBinary(long: number, prefix: number): string {
  const bits = (long >>> 0).toString(2).padStart(32, '0');
  let out = '';
  for (let i = 1; i <= 32; i++) {
    out += bits[i - 1];
    const atOctetBoundary = i % 8 === 0 && i < 32;
    if (i === prefix && prefix > 0 && prefix < 32 && !atOctetBoundary) out += ' ';
    if (atOctetBoundary) out += '.';
  }
  return out;
}

// ── Botão de copiar inline, icon-only, sem rótulo "Copied"/"Failed" —
// DELIBERADAMENTE um componente próprio em vez do <CopyButton/> genérico
// (src/components/commands/CopyButton.tsx): .ipc-valwrap tem largura FIXA
// em `ch` pensada pra um botão SEM texto (ver comentário de .ipc-valwrap em
// components.css — "a coluna do binário comece sempre no mesmo x"), que o
// <CopyButton/> quebraria ao crescer com o texto "Copied"/"Failed" no
// estado de sucesso. Reaproveita a MESMA lógica de cópia (copyToClipboard,
// exportada de CopyButton.tsx) — só a apresentação é outra: troca o ÍCONE
// por um check por um instante, nada de texto.
const COPY_ICON = (
  <svg width="10" height="10" fill="none" viewBox="0 0 16 16">
    <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M3 10H2a1 1 0 01-1-1V2a1 1 0 011-1h7a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const OK_ICON = (
  <svg width="10" height="10" fill="none" viewBox="0 0 16 16">
    <path d="M2 8.5l3.5 3.5L14 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IPC_COPY_FEEDBACK_MS = 1200;

function IpcCopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  function handleClick() {
    copyToClipboard(text)
      .then(() => {
        window.clearTimeout(timerRef.current);
        setOk(true);
        timerRef.current = window.setTimeout(() => setOk(false), IPC_COPY_FEEDBACK_MS);
      })
      .catch(() => {
        /* falha silenciosa — mesmo efeito líquido do original (ícone não muda) */
      });
  }
  return (
    <button type="button" className="copy-btn copy-btn-inline ipc-copy-btn" title={ok ? 'Copied!' : 'Copy'} onClick={handleClick}>
      {ok ? OK_ICON : COPY_ICON}
    </button>
  );
}

function IpcLine({ label, value, bin, note, copyText }: { label: string; value: string; bin?: string; note?: string; copyText?: string }) {
  return (
    <div className="ipc-line">
      <span className="ipc-label">{label}:</span>
      <span className="ipc-valwrap">
        <span className="ipc-val">{value}</span>
        {copyText && <IpcCopyBtn text={copyText} />}
      </span>
      {bin && (
        <span className="ipc-bin-wrap">
          <span className="ipc-bin">{bin}</span>
        </span>
      )}
      {note && <> <span className="ipc-note">({note})</span></>}
    </div>
  );
}

function IpcNetmaskLine({ maskDotted, prefix, bin }: { maskDotted: string; prefix: number; bin: string }) {
  return (
    <div className="ipc-line">
      <span className="ipc-label">Netmask:</span>
      <span className="ipc-valwrap">
        <span className="ipc-val">{maskDotted}</span>
        <IpcCopyBtn text={maskDotted} />
        <span className="ipc-val">/{prefix}</span>
        <IpcCopyBtn text={`/${prefix}`} />
      </span>
      <span className="ipc-bin-wrap">
        <span className="ipc-bin">{bin}</span>
      </span>
    </div>
  );
}

// Bloco de 6 linhas (Network/Netmask/HostMin/HostMax/Broadcast/Hosts) comum
// a uma sub-rede de split ou ao supernet — porte de ipcRenderNetworkBlock.
function IpcNetworkBlock({ n, indexLabel, wrap = true }: { n: IpcSubnet; indexLabel?: string; wrap?: boolean }) {
  const maskLong = ipcPrefixToMaskLong(n.prefix);
  return (
    <div className={wrap ? 'ipc-block' : 'ipc-block-inner'}>
      {indexLabel && <div className="ipc-subnet-index">{indexLabel}</div>}
      <IpcLine label="Network" value={n.cidr} bin={ipcDottedBinary(n.networkLong, n.prefix)} note={`Class ${n.ipClass}`} copyText={n.cidr} />
      <IpcNetmaskLine maskDotted={longToIp(maskLong)} prefix={n.prefix} bin={ipcDottedBinary(maskLong, n.prefix)} />
      <IpcLine label="HostMin" value={n.firstHost} bin={ipcDottedBinary(n.firstHostLong, n.prefix)} />
      <IpcLine label="HostMax" value={n.lastHost} bin={ipcDottedBinary(n.lastHostLong, n.prefix)} />
      <IpcLine label="Broadcast" value={n.broadcast} bin={ipcDottedBinary(n.broadcastLong, n.prefix)} />
      <IpcLine label="Hosts/Net" value={n.usableHosts.toLocaleString('pt-BR')} note={n.ipType} />
    </div>
  );
}

function MainResultBlock({ r }: { r: IpcCalcResult }) {
  return (
    <div className="ipc-block">
      <IpcLine label="Address" value={r.ip} bin={ipcDottedBinary(r.ipLong, r.prefix)} />
      <IpcLine label="Network" value={r.cidr} bin={ipcDottedBinary(r.networkLong, r.prefix)} note={`Class ${r.ipClass}`} copyText={r.cidr} />
      <IpcNetmaskLine maskDotted={r.maskDotted} prefix={r.prefix} bin={ipcDottedBinary(r.maskLong, r.prefix)} />
      <IpcLine label="Wildcard" value={r.wildcardDotted} bin={ipcDottedBinary(r.wildcardLong, r.prefix)} />
      <IpcLine label="HostMin" value={r.firstHost} bin={ipcDottedBinary(r.firstHostLong, r.prefix)} />
      <IpcLine label="HostMax" value={r.lastHost} bin={ipcDottedBinary(r.lastHostLong, r.prefix)} />
      <IpcLine label="Broadcast" value={r.broadcast} bin={ipcDottedBinary(r.broadcastLong, r.prefix)} />
      <IpcLine label="Hosts/Net" value={r.usableHosts.toLocaleString('pt-BR')} note={r.ipType} />
    </div>
  );
}

function SupernetBlock({ sr }: { sr: IpcCalcResult }) {
  return (
    <div className="ipc-block">
      <IpcLine label="Network" value={sr.cidr} bin={ipcDottedBinary(sr.networkLong, sr.prefix)} note={`Class ${sr.ipClass}`} copyText={sr.cidr} />
      <IpcNetmaskLine maskDotted={sr.maskDotted} prefix={sr.prefix} bin={ipcDottedBinary(sr.maskLong, sr.prefix)} />
      <IpcLine label="HostMin" value={sr.firstHost} bin={ipcDottedBinary(sr.firstHostLong, sr.prefix)} />
      <IpcLine label="HostMax" value={sr.lastHost} bin={ipcDottedBinary(sr.lastHostLong, sr.prefix)} />
      <IpcLine label="Broadcast" value={sr.broadcast} bin={ipcDottedBinary(sr.broadcastLong, sr.prefix)} />
      <IpcLine label="Hosts/Net" value={sr.usableHosts.toLocaleString('pt-BR')} note={sr.ipType} />
    </div>
  );
}

type SubnetsState =
  | null
  | { kind: 'split'; label: string; subnets: IpcSubnet[]; truncatedNote?: string }
  | { kind: 'supernet'; label: string; sr: IpcCalcResult };

export function IpCalcModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [ip, setIp] = useState('');
  const [mask, setMask] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [error, setError] = useState('');
  const [moveToError, setMoveToError] = useState('');
  const [result, setResult] = useState<IpcCalcResult | null>(null);
  const [samePrefixNote, setSamePrefixNote] = useState<string | null>(null);
  const [subnets, setSubnets] = useState<SubnetsState>(null);
  const [maskInfoOpen, setMaskInfoOpen] = useState(false);
  const [popPos, setPopPos] = useState({ top: 0, left: 0 });

  const ipInputRef = useRef<HTMLInputElement>(null);
  const infoWrapRef = useRef<HTMLSpanElement>(null);
  const infoIconRef = useRef<HTMLSpanElement>(null);
  const infoPopRef = useRef<HTMLSpanElement>(null);
  const prevOpenRef = useRef(false);

  function computeAndSet(ipVal: string, maskVal: string, moveToVal: string) {
    setError('');
    setMoveToError('');
    setSamePrefixNote(null);
    setSubnets(null);
    const r = ipcCalculate(ipVal, maskVal);
    if (isIpcError(r)) {
      setError(r.error);
      setResult(null);
      return;
    }
    setResult(r);

    const moveToTrimmed = moveToVal.trim();
    if (!moveToTrimmed) return;
    const newPrefix = ipcParseMaskInput(moveToTrimmed);
    if (newPrefix === null) {
      setMoveToError('Invalid netmask/prefix for "move to".');
      return;
    }
    if (newPrefix === r.prefix) {
      setSamePrefixNote('Same prefix as the netmask above — nothing to move to.');
    } else if (newPrefix > r.prefix) {
      const res = ipcSplitSubnets(r.networkLong, r.prefix, newPrefix);
      if (isIpcError(res)) {
        setMoveToError(res.error);
        return;
      }
      setSubnets({
        kind: 'split',
        label: `Subnets (${res.generated.toLocaleString('pt-BR')})`,
        subnets: res.subnets,
        truncatedNote: res.truncated ? `Showing the first ${res.generated} of ${res.count} subnets (safety limit).` : undefined,
      });
    } else {
      const sr = ipcCalculate(r.ip, String(newPrefix));
      if (!isIpcError(sr)) setSubnets({ kind: 'supernet', label: 'Supernet', sr });
    }
  }

  function runCalculate() {
    computeAndSet(ip, mask, moveTo);
  }

  // Pedido do usuário: o modal sempre abre já com um resultado calculado —
  // 192.168.0.1/24 na primeira vez; os campos já preenchidos de uma
  // calculadora anterior (mesma sessão do modal), só recalcula com o que já
  // estava lá. Detecta a transição false -> true de `open` (não roda de
  // novo em re-renders com o modal já aberto).
  useLayoutEffect(() => {
    if (open && !prevOpenRef.current) {
      const nextIp = ip || '192.168.0.1';
      const nextMask = mask || '24';
      if (nextIp !== ip) setIp(nextIp);
      if (nextMask !== mask) setMask(nextMask);
      computeAndSet(nextIp, nextMask, moveTo);
      requestAnimationFrame(() => {
        ipInputRef.current?.focus();
        ipInputRef.current?.select();
      });
    }
    prevOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ── Popover "i" de referência CIDR→máscara — position:fixed calculado via
  // getBoundingClientRect (ver comentário de .ipc-info-pop em
  // components.css: escapa do overflow-y:auto do .modal-box). Fecha ao
  // clicar fora de .ipc-label-info-wrap ou ao rolar qualquer coisa.
  useLayoutEffect(() => {
    if (!maskInfoOpen) return;
    const icon = infoIconRef.current;
    if (!icon) return;
    const rect = icon.getBoundingClientRect();
    const top = rect.bottom + 6;
    const left = rect.left;
    setPopPos({ top, left });
    const raf = requestAnimationFrame(() => {
      const pop = infoPopRef.current;
      if (!pop) return;
      const pr = pop.getBoundingClientRect();
      let newTop = top;
      let newLeft = left;
      if (pr.right > window.innerWidth - 8) newLeft = Math.max(8, window.innerWidth - pr.width - 8);
      if (pr.bottom > window.innerHeight - 8) newTop = Math.max(8, rect.top - pr.height - 6);
      if (newTop !== top || newLeft !== left) setPopPos({ top: newTop, left: newLeft });
    });
    return () => cancelAnimationFrame(raf);
  }, [maskInfoOpen]);

  useLayoutEffect(() => {
    if (!maskInfoOpen) return;
    function onDocClick(ev: MouseEvent) {
      if (infoWrapRef.current && !infoWrapRef.current.contains(ev.target as Node)) setMaskInfoOpen(false);
    }
    function onScroll() {
      setMaskInfoOpen(false);
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [maskInfoOpen]);

  function onEnterKey(ev: React.KeyboardEvent) {
    if (ev.key === 'Enter') runCalculate();
  }

  return createPortal(
    <div className={`modal-overlay${open ? ' show' : ''}`}>
      <div className="modal-box modal-wide">
        <div className="modal-head">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="2" width="16" height="20" rx="2" />
              <line x1="8" y1="6" x2="16" y2="6" />
              <line x1="8" y1="17.5" x2="16" y2="17.5" />
            </svg>
            <span>IP Calculator</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <div className="ipc-input-row">
              <div className="ipc-field">
                <span className="set-label">Address</span>
                <input
                  ref={ipInputRef}
                  type="text"
                  className="set-input"
                  placeholder="192.168.0.1"
                  autoComplete="off"
                  tabIndex={1}
                  value={ip}
                  onChange={ev => setIp(ev.target.value)}
                  onKeyDown={onEnterKey}
                />
              </div>
              <span className="ipc-slash">/</span>
              <div className="ipc-field">
                <span className="ipc-label-info-wrap" ref={infoWrapRef}>
                  <span className="set-label">Netmask</span>
                  <span
                    className={`ipc-info-icon${maskInfoOpen ? ' ipc-info-open' : ''}`}
                    ref={infoIconRef}
                    tabIndex={-1}
                    role="button"
                    aria-label="Subnet mask reference table"
                    onClick={ev => {
                      ev.stopPropagation();
                      setMaskInfoOpen(o => !o);
                    }}
                  >
                    i
                    <span
                      className="ipc-info-pop"
                      ref={infoPopRef}
                      style={maskInfoOpen ? { display: 'block', top: popPos.top, left: popPos.left } : undefined}
                    >
                      <table className="ipc-cidr-table">
                        <thead>
                          <tr>
                            <th>Prefix</th>
                            <th>Subnet Mask</th>
                          </tr>
                        </thead>
                        <tbody>
                          {CIDR_TABLE.map(([prefix, dotted]) => (
                            <tr key={prefix}>
                              <td>/{prefix}</td>
                              <td>{dotted}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </span>
                  </span>
                </span>
                <input
                  type="text"
                  className="set-input"
                  placeholder="24 or 255.255.255.0"
                  autoComplete="off"
                  tabIndex={2}
                  value={mask}
                  onChange={ev => setMask(ev.target.value)}
                  onKeyDown={onEnterKey}
                />
              </div>
              <div className="ipc-field">
                <span className="set-label">Move to</span>
                <input
                  type="text"
                  className="set-input"
                  placeholder="25 or 255.255.255.128"
                  autoComplete="off"
                  tabIndex={3}
                  value={moveTo}
                  onChange={ev => setMoveTo(ev.target.value)}
                  onKeyDown={onEnterKey}
                />
              </div>
              <button type="button" className="btn btn-primary ipc-calc-btn" tabIndex={4} onClick={runCalculate}>
                Calc
              </button>
            </div>
            {error && (
              <span className="set-hint" style={{ color: 'var(--red)' }}>
                {error}
              </span>
            )}
            {moveToError && (
              <span className="set-hint" style={{ color: 'var(--red)' }}>
                {moveToError}
              </span>
            )}
          </div>

          {result && (
            <div className="set-group">
              <span className="set-label">Result</span>
              <div className="ipc-term">
                <MainResultBlock r={result} />
                {samePrefixNote && (
                  <div className="ipc-note-line">
                    <span className="ipc-note">{samePrefixNote}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {subnets && (
            <div className="set-group" id="ipcSubnetsGroup">
              <span className="set-label">{subnets.label}</span>
              <div className="ipc-term">
                {subnets.kind === 'split' ? (
                  <>
                    {subnets.subnets.map((sn, i) => (
                      <IpcNetworkBlock key={sn.cidr} n={sn} indexLabel={`Subnet ${i + 1} of ${subnets.subnets.length}`} />
                    ))}
                    {subnets.truncatedNote && (
                      <div className="ipc-note-line">
                        <span className="ipc-note">{subnets.truncatedNote}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <SupernetBlock sr={subnets.sr} />
                )}
              </div>
            </div>
          )}

          <div className="set-group">
            <span className="set-label">RFC 1918 — Private address ranges</span>
            <div className="audit-log-wrap">
              <table className="audit-log-table ipc-rfc-table">
                <thead>
                  <tr>
                    <th>Range</th>
                    <th>CIDR block</th>
                    <th>Addresses</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>10.0.0.0 – 10.255.255.255</td>
                    <td>10.0.0.0/8</td>
                    <td>16.777.216</td>
                  </tr>
                  <tr>
                    <td>172.16.0.0 – 172.31.255.255</td>
                    <td>172.16.0.0/12</td>
                    <td>1.048.576</td>
                  </tr>
                  <tr>
                    <td>192.168.0.0 – 192.168.255.255</td>
                    <td>192.168.0.0/16</td>
                    <td>65.536</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
