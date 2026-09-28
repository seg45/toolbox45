// ════════════════════════════════════════════════
// Controles "seg-btn" (pills) do modal de Configurações — porta genérica
// de setSegActive/getSegActive (seleção única: Home page, Group by) e
// setSegActiveMulti/getSegActiveMulti (multi-seleção: os espelhos de
// Vendor/System/Version/Environment/Topic) em js/settings-modal.js.
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';

export interface SegOption {
  val: string;
  label: string;
}

function useCloseOnOutsideClick(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) close();
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open, close]);
  return ref;
}

export function SegSingle({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SegOption[];
  value: string;
  onChange: (val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useCloseOnOutsideClick(open, () => setOpen(false));
  const current = options.find(o => o.val === value);
  return (
    <div className={`dd${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="dd-btn" onClick={() => setOpen(o => !o)}>
        <span className="dd-label">{current ? current.label : ''}</span>
        <span className="dd-arrow">▾</span>
      </button>
      {open && (
        <div className="dd-panel seg">
          {options.map(opt => (
            <button
              key={opt.val}
              type="button"
              className={`seg-btn${opt.val === value ? ' on' : ''}`}
              onClick={() => {
                onChange(opt.val);
                setOpen(false);
              }}
            >
              {opt.label}
            </button>
          ))}
          {label === 'Home page' && (
            <div className="dd-panel-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Close</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SegMulti({
  options,
  selected,
  onChange,
  pluralWord = 'selected',
}: {
  options: SegOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  pluralWord?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useCloseOnOutsideClick(open, () => setOpen(false));

  let labelText = 'All';
  if (selected.length === 1) {
    labelText = options.find(o => o.val === selected[0])?.label || selected[0];
  } else if (selected.length > 1) {
    labelText = `${selected.length} ${pluralWord}`;
  }

  function toggleValue(val: string) {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  }

  return (
    <div className={`dd${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="dd-btn" onClick={() => setOpen(o => !o)}>
        <span className="dd-label">{labelText}</span>
        <span className="dd-arrow">▾</span>
      </button>
      {open && (
        <div className="dd-panel seg">
          {options.map(opt => (
            <button
              key={opt.val}
              type="button"
              className={`seg-btn${selected.includes(opt.val) ? ' on' : ''}`}
              onClick={() => toggleValue(opt.val)}
            >
              {opt.label}
            </button>
          ))}
          <div className="dd-panel-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Toggle "sb-toggle" (usado tanto na sidebar — Options — quanto no modal —
// espelhos) — porta genérica do padrão .sb-toggle/.tog-track/.tog-knob.
export function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div className={`sb-toggle${on ? ' on' : ''}`} onClick={onClick}>
      <div className="tog-track"><div className="tog-knob"></div></div>
      <span>{label}</span>
    </div>
  );
}
