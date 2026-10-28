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
      // composedPath() em vez de contains(target): ao clicar em "New …" o
      // conteúdo do painel é trocado e o alvo do clique já saiu do DOM quando
      // este listener (no document) roda — contains() fecharia o seletor.
      const wrap = ref.current;
      if (wrap && !ev.composedPath().includes(wrap)) close();
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open, close]);
  return ref;
}

// ════════════════════════════════════════════════
// Pesquisa dentro do painel — listas grandes (variáveis, sistemas, tópicos…)
// ganham uma caixa de busca no topo (sticky, mesmo `.dd-search-input` do
// seletor de pastas). Só aparece a partir de SEARCH_MIN_OPTIONS opções: em
// listas curtas (Type/Category, Home page…) seria ruído.
// ════════════════════════════════════════════════
export const SEARCH_MIN_OPTIONS = 6;

function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Sem caixa/acentos; cada palavra digitada precisa aparecer no rótulo.
export function filterOptionsByQuery<T extends { label: string }>(options: T[], query: string): T[] {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter(o => {
    const hay = normalizeSearch(o.label);
    return words.every(w => hay.includes(w));
  });
}

export function OptionSearch({
  query,
  onChange,
  onEnter,
}: {
  query: string;
  onChange: (q: string) => void;
  onEnter?: () => void;
}) {
  return (
    <input
      type="text"
      className="dd-search-input"
      placeholder="Search…"
      autoComplete="off"
      autoFocus
      value={query}
      onChange={ev => onChange(ev.target.value)}
      onKeyDown={ev => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          onEnter?.();
        }
      }}
    />
  );
}

export function NoMatches() {
  return <div className="dd-empty">No matches</div>;
}

// ════════════════════════════════════════════════
// Cadastro rápido ("＋ New vendor…") dentro do próprio seletor — usado pelo
// editor de comandos para o admin criar Vendor/System/Version/Environment/
// Topic/Prompt/Export sem sair do wizard. `onCreate` cria o item (POST) e
// devolve o valor que o seletor deve passar a ter selecionado.
// ════════════════════════════════════════════════
export interface QuickCreateConfig {
  noun: string; // "vendor", "system"…
  withColor?: boolean;
  blockedReason?: string; // ex.: "Choose a vendor first" — mostra o aviso no lugar do botão
  onCreate: (label: string, color: string) => Promise<string>;
}

const QC_DEFAULT_COLOR = '#8B949E';

function QuickCreate({
  config,
  creating,
  setCreating,
  onCreated,
}: {
  config: QuickCreateConfig;
  creating: boolean;
  setCreating: (v: boolean) => void;
  onCreated: (value: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [color, setColor] = useState(QC_DEFAULT_COLOR);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (creating) return;
    setLabel('');
    setColor(QC_DEFAULT_COLOR);
    setErr('');
  }, [creating]);

  async function submit() {
    if (busy) return;
    const text = label.trim();
    if (!text) {
      setErr('Fill in the name.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const value = await config.onCreate(text, color);
      setCreating(false);
      onCreated(value);
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : `Failed to create ${config.noun}.`);
    } finally {
      setBusy(false);
    }
  }

  if (config.blockedReason && !creating) {
    return <div className="qc-blocked">{config.blockedReason} to add a new {config.noun}.</div>;
  }
  if (!creating) {
    return (
      <button type="button" className="seg-btn qc-new-btn" onClick={() => setCreating(true)}>
        ＋ New {config.noun}…
      </button>
    );
  }
  return (
    <div
      className="qc-form"
      onKeyDown={ev => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          void submit();
        } else if (ev.key === 'Escape') {
          ev.stopPropagation();
          setCreating(false);
        }
      }}
    >
      <label className="qc-label">
        New {config.noun}
        <span className="qc-row">
          <input
            className="set-input"
            autoFocus
            placeholder="Name"
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
          {config.withColor && (
            <input type="color" className="cat-color-input" value={color} onChange={e => setColor(e.target.value)} title="Color" />
          )}
        </span>
      </label>
      {err && <div className="qc-err">{err}</div>}
      <div className="qc-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setCreating(false)}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Creating…' : 'Create & select'}
        </button>
      </div>
    </div>
  );
}

export function SegSingle({
  label,
  options,
  value,
  onChange,
  quickCreate,
  placeholder = '',
}: {
  label: string;
  options: SegOption[];
  value: string;
  onChange: (val: string) => void;
  quickCreate?: QuickCreateConfig;
  placeholder?: string; // texto do botão quando nenhum valor está escolhido
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useCloseOnOutsideClick(open, () => setOpen(false));
  useEffect(() => {
    if (!open) {
      setCreating(false);
      setQuery('');
    }
  }, [open]);
  const current = options.find(o => o.val === value);
  const showSearch = !creating && options.length >= SEARCH_MIN_OPTIONS;
  const visible = showSearch ? filterOptionsByQuery(options, query) : options;
  return (
    <div className={`dd${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="dd-btn" onClick={() => setOpen(o => !o)}>
        <span className={`dd-label${!current && placeholder ? ' dd-placeholder' : ''}`}>{current ? current.label : placeholder}</span>
        <span className="dd-arrow">▾</span>
      </button>
      {open && (
        <div className="dd-panel seg">
          {showSearch && (
            <OptionSearch
              query={query}
              onChange={setQuery}
              onEnter={() => {
                if (visible.length) {
                  onChange(visible[0].val);
                  setOpen(false);
                }
              }}
            />
          )}
          {showSearch && visible.length === 0 && <NoMatches />}
          {!creating &&
            visible.map(opt => (
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
          {quickCreate && (
            <QuickCreate
              config={quickCreate}
              creating={creating}
              setCreating={setCreating}
              onCreated={v => {
                onChange(v);
                setOpen(false);
              }}
            />
          )}
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
  quickCreate,
  emptyLabel = 'All',
}: {
  options: SegOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  pluralWord?: string;
  quickCreate?: QuickCreateConfig;
  // O que o botão mostra com NADA marcado. Nos filtros "nada marcado" = todos
  // ("All"); no editor de comando é só "nada escolhido ainda" e "All" enganava
  // (parecia uma opção já selecionada).
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useCloseOnOutsideClick(open, () => setOpen(false));
  useEffect(() => {
    if (!open) {
      setCreating(false);
      setQuery('');
    }
  }, [open]);
  const showSearch = !creating && options.length >= SEARCH_MIN_OPTIONS;
  const visible = showSearch ? filterOptionsByQuery(options, query) : options;

  let labelText = emptyLabel;
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
          {showSearch && (
            <OptionSearch
              query={query}
              onChange={setQuery}
              onEnter={() => {
                if (visible.length === 1) toggleValue(visible[0].val);
              }}
            />
          )}
          {showSearch && visible.length === 0 && <NoMatches />}
          {!creating &&
            visible.map(opt => (
              <button
                key={opt.val}
                type="button"
                className={`seg-btn${selected.includes(opt.val) ? ' on' : ''}`}
                onClick={() => toggleValue(opt.val)}
              >
                {opt.label}
              </button>
            ))}
          {quickCreate && (
            <QuickCreate
              config={quickCreate}
              creating={creating}
              setCreating={setCreating}
              onCreated={v => onChange(selected.includes(v) ? selected : [...selected, v])}
            />
          )}
          {!creating && (
            <div className="dd-panel-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Close</button>
            </div>
          )}
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
