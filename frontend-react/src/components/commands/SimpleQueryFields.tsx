// ════════════════════════════════════════════════
// STOPGAP desta fatia (3a) para a barra de query completa (chips/histórico/
// typeahead — js/query-bar.js), que é escopo da fatia 3b. Aqui é só uma
// barra simples de <input> rotulados: os 9 campos hardcoded (mesmos
// placeholders {{token}} usados nos comandos — ver renderPipeline.ts::
// buildValues) + qualquer parâmetro customizado cadastrado no catálogo
// (CATALOGS.parameters, ver catalogs.ts) que não seja um dos 9. Sem
// tags/histórico/typeahead — estado local simples, lifted para
// CommandsContent.tsx (que repassa pro pipeline de render).
//
// Rótulos dos 9 campos hardcoded: usa o `label` cadastrado no catálogo de
// parâmetros quando existe uma entrada pra essa chave (mesma prioridade do
// original — os chips da query-bar derivam o rótulo do catálogo); cai num
// rótulo em inglês razoável hardcoded quando não há entrada correspondente.
// ════════════════════════════════════════════════
import type { CSSProperties } from 'react';
import type { Catalogs } from '../../lib/catalogs';
import { HARDCODED_VALUE_KEYS } from '../../lib/renderPipeline';

const HARDCODED_LABELS: Record<string, string> = {
  src_ip: 'Source IP',
  dst_ip: 'Destination IP',
  src_port: 'Source Port',
  dst_port: 'Destination Port',
  proto: 'Protocol',
  iface: 'Interface',
  vsid: 'VSID',
  ip: 'IP',
  port: 'Port',
};

const inputStyle: CSSProperties = {
  background: 'var(--surf2)',
  border: '1px solid var(--bdr)',
  borderRadius: 5,
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  padding: '5px 8px',
  outline: 'none',
  minWidth: 90,
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 9,
  color: 'var(--dim)',
};

const labelTextStyle: CSSProperties = {
  textTransform: 'uppercase',
  letterSpacing: '.4px',
  fontWeight: 700,
};

export function SimpleQueryFields({
  values,
  onChange,
  catalogs,
}: {
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  catalogs: Catalogs | null;
}) {
  const catalogParams = catalogs?.parameters || [];
  const customParams = catalogParams.filter(p => !(HARDCODED_VALUE_KEYS as readonly string[]).includes(p.key));

  const fields: { key: string; label: string }[] = [
    ...HARDCODED_VALUE_KEYS.map(key => ({
      key,
      label: catalogParams.find(p => p.key === key)?.label || HARDCODED_LABELS[key],
    })),
    ...customParams.map(p => ({ key: p.key, label: p.label })),
  ];

  return (
    <div
      className="sqf-bar"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px', background: 'var(--surf)', borderBottom: '1px solid var(--bdr)' }}
    >
      {fields.map(f => (
        <label key={f.key} style={labelStyle}>
          <span style={labelTextStyle}>{f.label}</span>
          <input type="text" autoComplete="off" value={values[f.key] || ''} onChange={e => onChange(f.key, e.target.value)} style={inputStyle} />
        </label>
      ))}
    </div>
  );
}
