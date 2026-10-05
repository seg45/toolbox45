// ════════════════════════════════════════════════
// "Export commands" (Settings → Database → Commands) — porta de
// js/csv-export.js (openExportColumnsModal/confirmExportColumns/
// exportCommandsCsv) + markup de #exportColumnsOverlay (index.html). A lógica
// pura (colunas, escape, filtro de escopo, texto do .csv) mora em lib/csv.ts.
//
// Preferências lembradas entre sessões em localStorage — `cpa-export-columns`
// (JSON array de keys) e `cpa-export-scope` — sempre em try/catch, como no
// original. Estas duas chaves NÃO entram no sync de localStorage do app
// (userDataSync) — igual ao original, que também as mantinha só no navegador.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchCatalogs } from '../../lib/catalogs';
import { fetchCommands } from '../../lib/commands';
import { CSV_COLUMNS, buildExportCsv, exportFileName, normalizeExportScope, type ExportScope } from '../../lib/csv';

const EXPORT_COLUMNS_KEY = 'cpa-export-columns';
const EXPORT_SCOPE_KEY = 'cpa-export-scope';

// Lê a última seleção de colunas; ignora keys inválidas; padrão = todas.
function loadSelectedExportColumns(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPORT_COLUMNS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((k: unknown) => CSV_COLUMNS.some(col => col.key === k)));
    }
  } catch {
    /* localStorage indisponível ou JSON inválido — cai no padrão */
  }
  return new Set(CSV_COLUMNS.map(col => col.key)); // padrão: todas marcadas
}

function saveSelectedExportColumns(keys: string[]) {
  try {
    localStorage.setItem(EXPORT_COLUMNS_KEY, JSON.stringify(keys));
  } catch {
    /* sem persistência — a preferência só não é lembrada */
  }
}

function loadSelectedExportScope(): ExportScope {
  try {
    return normalizeExportScope(localStorage.getItem(EXPORT_SCOPE_KEY));
  } catch {
    return 'all';
  }
}

function saveSelectedExportScope(scope: ExportScope) {
  try {
    localStorage.setItem(EXPORT_SCOPE_KEY, scope);
  } catch {
    /* idem */
  }
}

// Gera e baixa o .csv (Blob + <a download>). Função de módulo, não de
// componente: o modal FECHA antes de começar (como no original: closeModal ->
// await exportCommandsCsv), então o componente já está desmontado enquanto
// isto roda e não pode depender de estado dele. Rótulos de vendor/system/
// topic vêm de fetchCatalogs() (o original lia a global CATALOGS); se o
// catálogo não puder ser lido o export falha com o alerta, em vez de gravar
// keys no lugar dos rótulos sem avisar.
async function exportCommandsCsv(selectedKeys: string[], scope: ExportScope) {
  try {
    const [commands, catalogs] = await Promise.all([fetchCommands(), fetchCatalogs()]);
    const csv = buildExportCsv(commands, catalogs, selectedKeys, scope);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(scope);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert('Failed to export the CSV. Please try again.');
  }
}

const SCOPE_OPTIONS: { val: ExportScope; label: string }[] = [
  { val: 'all', label: 'All commands' },
  { val: 'system', label: 'System only' },
  { val: 'user', label: 'User only' },
];

export function ExportCommandsModal({ onClose }: { onClose: () => void }) {
  // Inicializadores preguiçosos: lê o localStorage uma vez, na abertura
  // (openExportColumnsModal no original).
  const [selected, setSelected] = useState<Set<string>>(loadSelectedExportColumns);
  const [scope, setScope] = useState<ExportScope>(loadSelectedExportScope);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function toggleColumn(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // setExportScopeSeg() do original salva o escopo NA HORA do clique (não só
  // ao confirmar) — mantido: fechar sem exportar ainda lembra o último escopo.
  function pickScope(next: ExportScope) {
    setScope(next);
    saveSelectedExportScope(next);
  }

  function handleConfirm() {
    // Na ordem de CSV_COLUMNS (não na ordem dos cliques) — o Set não garante
    // ordem de colunas; buildExportCsv também filtra por CSV_COLUMNS.
    const checkedKeys = CSV_COLUMNS.filter(col => selected.has(col.key)).map(col => col.key);
    if (!checkedKeys.length) {
      alert('Check at least one column to export.');
      return;
    }
    saveSelectedExportColumns(checkedKeys);
    saveSelectedExportScope(scope);
    onClose();
    void exportCommandsCsv(checkedKeys, scope);
  }

  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box">
        <div className="modal-head">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v7.5M4.5 6.5L8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Export commands</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <span className="set-hint">Which commands do you want to export?</span>
          <div className="seg ctb-seg" style={{ marginBottom: 12 }}>
            {SCOPE_OPTIONS.map(opt => (
              <button key={opt.val} type="button" className={`seg-btn${scope === opt.val ? ' on' : ''}`} onClick={() => pickScope(opt.val)}>
                {opt.label}
              </button>
            ))}
          </div>
          <span className="set-hint">Choose which columns to include in the .csv file.</span>
          <div className="exp-col-grid">
            {CSV_COLUMNS.map(col => (
              <label key={col.key} className="exp-col-row">
                <input type="checkbox" checked={selected.has(col.key)} onChange={() => toggleColumn(col.key)} />
                <span>{col.header}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <div className="cat-row-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set(CSV_COLUMNS.map(col => col.key)))}>
              Select all
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
              Deselect all
            </button>
          </div>
          <button type="button" className="btn btn-primary" onClick={handleConfirm} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v7.5M4.5 6.5L8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Export</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
