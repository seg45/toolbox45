// ════════════════════════════════════════════════
// Dropdown de filtro multi-seleção da sidebar (Vendor/System/Version/
// Environment/Topic) — porta genérica de bindMultiSelect()/toggleDropdown()/
// updateVendorDDLabel() (e equivalentes) em js/state.js, um componente só
// reaproveitado 5x em vez de 5 blocos de HTML quase idênticos + 5 pares de
// funções JS específicas por filtro.
//
// Ainda SEM efeito de filtragem real (ccRefreshCascade()/render() só
// existem a partir da fatia 3) — clicar aqui só atualiza a seleção
// (persistida via useSettings(), a mesma fonte que o espelho no modal de
// Preferences lê/escreve, exatamente como ST/state.js no original).
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';

export interface FilterOption {
  key: string;
  label: string;
  color: string;
}

interface Props {
  icon: React.ReactNode;
  headingLabel: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  pluralWord?: string;
}

export function FilterDropdown({ icon, headingLabel, options, selected, onChange, pluralWord = 'selected' }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora — mesmo comportamento de closeAllDropdowns() do
  // original (document-level listener, ver js/state.js).
  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  function toggleValue(key: string) {
    const next = selected.includes(key) ? selected.filter(v => v !== key) : [...selected, key];
    onChange(next);
  }

  let labelText = 'All';
  let labelColor = '#8B949E';
  if (selected.length === 1) {
    const opt = options.find(o => o.key === selected[0]);
    if (opt) {
      labelText = opt.label;
      labelColor = opt.color;
    }
  } else if (selected.length > 1) {
    labelText = `${selected.length} ${pluralWord}`;
  }

  return (
    <div className="sb-block sb-block-filter" ref={rootRef}>
      <div className="sb-head">
        <span className="sb-head-icon">{icon}</span>
        <span className="sb-head-txt">{headingLabel}</span>
      </div>
      <div className={`dd${open ? ' open' : ''}`}>
        <button type="button" className="dd-btn" onClick={() => setOpen(o => !o)}>
          <span className="sb-pip" style={{ background: labelColor }}></span>
          <span className="dd-label">{labelText}</span>
          <span className="dd-arrow">▾</span>
        </button>
        {open && (
          <div className="dd-panel">
            {options.map(opt => (
              <div
                key={opt.key}
                className={`sb-row${selected.includes(opt.key) ? ' on' : ''}`}
                onClick={() => toggleValue(opt.key)}
              >
                <div className="sb-chk">✓</div>
                <span className="sb-pip" style={{ background: opt.color }}></span>
                <span>{opt.label}</span>
              </div>
            ))}
            <div className="dd-panel-foot">
              <button type="button" className="btn btn-ghost" onClick={() => onChange([])}>All</button>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
