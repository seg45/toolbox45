// ════════════════════════════════════════════════
// "Import commands" (Settings → Database → Commands) — porta de
// js/csv-import.js (openImportCommandsModal/handleImportFileSelected/
// applyImportResolutions/runImportCommands) + markup de #importCommandsOverlay
// (index.html). Lógica pura (parser, template, buildImportPayload, coleta de
// pendências) em lib/csv.ts; o painel "Resolve unmatched values" em
// ImportResolutionPanel.tsx.
//
// Estado que no original era global de módulo (CATALOGS, _importParsedRows,
// _importResolutionMap) e leitura de DOM por id agora é estado deste
// componente:
//  - catalogs: o modal mantém seu PRÓPRIO estado (fetchCatalogs() ao abrir) e o
//    recarrega depois de criar itens no painel (o original relia a global
//    CATALOGS após catAdminRefreshCatalogs()), além de avisar o resto do app
//    via onCatalogsChanged(). Evita closure obsoleta.
//  - rows / resMap: linhas parseadas e mapa de resoluções, zerados a cada
//    arquivo novo (e a cada abertura — o componente remonta).
// ════════════════════════════════════════════════
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { createCatalogItemReturningKey, type CatalogItemPayload } from '../../lib/catalogAdmin';
import { fetchCatalogs, type Catalogs } from '../../lib/catalogs';
import { createCommand } from '../../lib/commands';
import {
  IMPORT_RES_META,
  IMPORT_RES_ORDER,
  IMPORT_TEMPLATE_FILE_NAME,
  buildImportPayload,
  buildImportTemplateCsv,
  collectUnresolvedRefs,
  csvRowsToObjects,
  emptyResolutionMap,
  getCell,
  importAnyUnresolved,
  parseCsvText,
  rewriteParameterTokens,
  type ImportRow,
  type ResolutionMap,
  type UnresolvedRefs,
} from '../../lib/csv';
import { notifyFoldersChanged } from '../../lib/folders';
import { DEFAULT_RES_COLOR, ImportResolutionPanel, getResItemState, type ResItemState } from './ImportResolutionPanel';

// Texto que o usuário de fato vê (openImportCommandsModal sobrescreve o
// texto estático longo do index.html por este, mais curto) — copiado literal
// de js/csv-import.js.
const IMPORT_HINT =
  "Bulk-create commands from a .csv file. Not sure how to fill it in? Download the template below — it has the exact columns expected, with a filled-in example row. If Vendor/System/Version/Environment/Topics don't match anything registered yet, you'll be able to create them or map them to an existing item right here before importing. Imported commands are created as your own by default and can be edited/deleted normally afterwards.";

// O que a caixa #importPreviewBox mostra.
type Preview =
  | { kind: 'none' }
  | { kind: 'msg'; text: string } // aviso laranja (arquivo vazio/ilegível)
  | { kind: 'panel'; unresolved: UnresolvedRefs; errors: string[] } // painel de resolução
  | { kind: 'ready'; errors: string[]; count: number }; // "N row(s) ready" + botão Import liberado (count fixado, como o HTML do original, que sobrevive ao import)

interface ReportRow {
  rowNum: number;
  name: string;
  ok: boolean;
  message: string;
}

// Baixa o template (BOM + cabeçalho IMPORT_HEADERS + linha de exemplo).
function downloadImportTemplate() {
  const blob = new Blob([buildImportTemplateCsv()], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = IMPORT_TEMPLATE_FILE_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function ErrorList({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <div className="imp-res-errors">
      {errors.map((e, i) => (
        <div key={i}>{e}</div>
      ))}
    </div>
  );
}

export function ImportCommandsModal({ onClose, onCatalogsChanged }: { onClose: () => void; onCatalogsChanged: () => void | Promise<unknown> }) {
  const { isAdmin } = useAuth();
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  // Espelho de `catalogs` para o callback assíncrono do FileReader (que
  // fecharia sobre o valor de quando o arquivo foi escolhido).
  const catalogsRef = useRef<Catalogs | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [resMap, setResMap] = useState<ResolutionMap>(emptyResolutionMap);
  const [preview, setPreview] = useState<Preview>({ kind: 'none' });
  const [panelRound, setPanelRound] = useState(0); // remonta o painel (zera as escolhas) a cada "Apply"
  const [applying, setApplying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<ReportRow[] | null>(null);
  // Só renderizado para admin; reabre SEMPRE desmarcado (o componente
  // remonta a cada abertura).
  const [asSystemChecked, setAsSystemChecked] = useState(false);
  const fileSeq = useRef(0); // descarta leitura de arquivo obsoleta (escolheu outro antes de terminar)

  function updateCatalogs(next: Catalogs) {
    catalogsRef.current = next;
    setCatalogs(next);
  }

  // Carrega o catálogo ao abrir (o original dependia da global CATALOGS já
  // carregada no boot do app).
  useEffect(() => {
    let alive = true;
    fetchCatalogs()
      .then(c => {
        if (alive) updateCatalogs(c);
      })
      .catch(() => {
        /* tratado na hora de ler o arquivo (handleFileChange tenta de novo) */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // ── Escolha do arquivo (handleImportFileSelected) ──
  function handleFileChange(ev: ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files && ev.target.files[0];
    const seq = ++fileSeq.current;
    setReport(null);
    setResMap(emptyResolutionMap());
    if (!file) {
      setRows(null);
      setPreview({ kind: 'none' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (seq === fileSeq.current) void processFileText(String(reader.result || ''), file.name, seq);
    };
    reader.onerror = () => {
      if (seq !== fileSeq.current) return;
      setRows(null);
      setPreview({ kind: 'msg', text: 'Could not read the file.' });
    };
    reader.readAsText(file, 'utf-8');
  }

  async function processFileText(text: string, fileName: string, seq: number) {
    let parsed: ImportRow[];
    try {
      parsed = csvRowsToObjects(parseCsvText(text));
    } catch (e) {
      console.error(e);
      setRows(null);
      setPreview({ kind: 'msg', text: 'Could not read this file as CSV.' });
      return;
    }
    setRows(parsed);
    if (!parsed.length) {
      setPreview({ kind: 'msg', text: `No rows found in "${fileName}".` });
      return;
    }
    let cats = catalogsRef.current;
    if (!cats) {
      // O carregamento inicial falhou/ainda não terminou — tenta de novo.
      try {
        cats = await fetchCatalogs();
        updateCatalogs(cats);
      } catch (e) {
        console.error(e);
        if (seq !== fileSeq.current) return;
        setRows(null);
        setPreview({ kind: 'msg', text: 'Could not load the catalog. Please try again.' });
        return;
      }
      if (seq !== fileSeq.current) return;
    }
    const unresolved = collectUnresolvedRefs(parsed, cats, emptyResolutionMap());
    if (importAnyUnresolved(unresolved)) {
      setPanelRound(r => r + 1);
      setPreview({ kind: 'panel', unresolved, errors: [] });
    } else {
      setPreview({ kind: 'ready', errors: [], count: parsed.length });
    }
  }

  // ── "Apply & continue" (applyImportResolutions) ──
  // Por item: mapear (grava a key escolhida) ou CRIAR via API, na ordem
  // vendor -> system -> version -> environment -> topic (para que o dropdown de
  // vínculo de System/Version/Environment já tenha o pai recém-criado), depois
  // parameters. Erros acumulam e aparecem acima do painel.
  async function handleApply(states: Record<string, ResItemState>) {
    if (preview.kind !== 'panel' || !rows || !catalogs) return;
    const unresolved = preview.unresolved;
    setApplying(true);
    const errors: string[] = [];
    // Cópia de trabalho do mapa (mutada ao longo da aplicação, como o original
    // mutava a global); só vira estado no final.
    const map: ResolutionMap = {
      vendor: { ...resMap.vendor },
      system: { ...resMap.system },
      version: { ...resMap.version },
      environment: { ...resMap.environment },
      topic: { ...resMap.topic },
      parameter: { ...resMap.parameter },
    };
    const networkMsg = 'something went wrong — check your connection and try again';

    for (const type of IMPORT_RES_ORDER) {
      const meta = IMPORT_RES_META[type];
      for (const [rawKey, info] of unresolved[type]) {
        const st = getResItemState(states, type, rawKey, info);
        if (st.choice !== '__new__') {
          map[type][rawKey] = st.choice;
          continue;
        }
        // `|| rawKey` (já em minúsculas) e não info.raw: igual ao original, que
        // caía no data-raw do select.
        const label = st.label.trim() || rawKey;
        const color = st.color || DEFAULT_RES_COLOR;
        const body: CatalogItemPayload = { label, color };
        if (meta.parent) {
          if (!st.parent) {
            errors.push(`Choose a ${IMPORT_RES_META[meta.parent].label} for "${label}"`);
            continue;
          }
          let parentKey = st.parent;
          if (st.parent.startsWith('key:')) {
            parentKey = st.parent.slice(4);
          } else if (st.parent.startsWith('new:')) {
            parentKey = map[meta.parent][st.parent.slice(4)];
            if (!parentKey) {
              errors.push(`"${label}" depends on a new ${meta.parent} that wasn't created — resolve it first`);
              continue;
            }
          }
          body[meta.parent] = parentKey;
        }
        try {
          const created = await createCatalogItemReturningKey(meta.kind, body);
          map[type][rawKey] = created.key;
        } catch (e) {
          errors.push(e instanceof ApiError ? `"${label}": ${e.message}` : `"${label}": ${networkMsg}`);
        }
      }
    }

    // Parâmetros — sem "pai"; a key na criação é sempre o próprio token.
    for (const [token, info] of unresolved.parameter) {
      const st = getResItemState(states, 'parameter', token, info);
      if (st.choice !== '__new__') {
        map.parameter[token] = st.choice;
        continue;
      }
      const label = st.label.trim() || token;
      try {
        const created = await createCatalogItemReturningKey('parameters', { key: token, label });
        map.parameter[token] = created.key; // sempre === token
      } catch (e) {
        errors.push(e instanceof ApiError ? `"{{${token}}}": ${e.message}` : `"{{${token}}}": ${networkMsg}`);
      }
    }

    // Token mapeado pra parâmetro existente com key diferente: reescreve
    // {{token}} -> {{chaveExistente}} nas linhas afetadas (ver
    // rewriteParameterTokens em lib/csv.ts).
    const newRows = rewriteParameterTokens(rows, map.parameter);

    // Recarrega o catálogo local (a lista de pendências abaixo precisa ver os
    // itens recém-criados) e avisa o resto do app. Usa o valor retornado, não
    // o state (que só atualiza no próximo render).
    let freshCatalogs = catalogs;
    try {
      freshCatalogs = await fetchCatalogs();
      updateCatalogs(freshCatalogs);
    } catch (e) {
      console.error(e);
      errors.push('Failed to reload the catalog — check your connection and try again');
    }
    try {
      await onCatalogsChanged();
    } catch (e) {
      console.error(e);
    }

    setRows(newRows);
    setResMap(map);
    const stillUnresolved = collectUnresolvedRefs(newRows, freshCatalogs, map);
    if (importAnyUnresolved(stillUnresolved)) {
      // Painel de novo, só com o que sobrou (+ erros), sem as escolhas antigas.
      setPanelRound(r => r + 1);
      setPreview({ kind: 'panel', unresolved: stillUnresolved, errors });
    } else {
      setPreview({ kind: 'ready', errors, count: newRows.length });
    }
    setApplying(false);
  }

  // "Import anyway" — mantém o comportamento antigo (valores não reconhecidos
  // entram como aviso por linha, ou rejeitam a linha se forem obrigatórios e
  // ficarem vazios).
  function handleSkip() {
    setPreview({ kind: 'ready', errors: [], count: rows ? rows.length : 0 });
  }

  // ── Import em lote (runImportCommands): uma linha por vez, na ordem ──
  async function handleImport() {
    if (!rows || !rows.length || !catalogs) return;
    setImporting(true);
    // Lido uma vez para o lote todo; o servidor reconfere a role de novo antes
    // de honrar o header X-Save-As-System.
    const asSystem = isAdmin && asSystemChecked;
    const reportRows: ReportRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2; // +1 de base 1, +1 da linha de cabeçalho
      const obj = rows[i];
      const built = buildImportPayload(obj, catalogs, resMap);
      if ('error' in built) {
        reportRows.push({ rowNum, name: getCell(obj, 'Name') || '(no name)', ok: false, message: built.error });
        continue;
      }
      try {
        await createCommand(built.payload, asSystem);
        reportRows.push({
          rowNum,
          name: built.payload.name,
          ok: true,
          message: built.warnings.length ? `Imported — ${built.warnings.join('; ')}` : 'Imported',
        });
      } catch (err) {
        // ApiError já traz a mensagem do servidor (body.message).
        reportRows.push({ rowNum, name: built.payload.name, ok: false, message: (err instanceof Error && err.message) || 'Failed to create' });
      }
    }
    setReport(reportRows);
    setRows(null); // zera as linhas parseadas -> botão Import volta a ficar desabilitado
    setImporting(false);
    // Equivalente ao render() final do original: o AppShell/CommandsContent
    // assina este canal e recarrega pastas + comandos.
    if (reportRows.some(r => r.ok)) notifyFoldersChanged();
  }

  const okCount = report ? report.filter(r => r.ok).length : 0;
  const failCount = report ? report.length - okCount : 0;
  const importDisabled = importing || !(preview.kind === 'ready' && rows && rows.length > 0);

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
              <path d="M8 10.5V3M4.5 6.5L8 3l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Import commands</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <span className="set-hint">{IMPORT_HINT}</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={downloadImportTemplate}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ marginRight: 4, verticalAlign: '-1px' }}>
              <path d="M8 2v7.5M4.5 6.5L8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Download template (.csv)
          </button>
          <div className="set-group" style={{ marginTop: 14 }}>
            <span className="set-label">CSV file</span>
            <input type="file" accept=".csv,text/csv" onChange={handleFileChange} />
          </div>
          {/* Admin-only (no original: importAsSystemRow + applyAdminGating). Marcado,
              os comandos são gravados como created_by='System' via header
              X-Save-As-System (reconferido no servidor). */}
          {isAdmin && (
            <label className="set-check-row">
              <input type="checkbox" checked={asSystemChecked} onChange={ev => setAsSystemChecked(ev.target.checked)} />
              <span>Import as System commands</span>
            </label>
          )}

          <div>
            {preview.kind === 'msg' && (
              <span className="set-hint" style={{ display: 'block', marginTop: 10, color: 'var(--orange)' }}>
                {preview.text}
              </span>
            )}
            {preview.kind === 'panel' && catalogs && (
              <>
                <ErrorList errors={preview.errors} />
                <ImportResolutionPanel
                  key={panelRound}
                  unresolved={preview.unresolved}
                  catalogs={catalogs}
                  applying={applying}
                  onSkip={handleSkip}
                  onApply={handleApply}
                />
              </>
            )}
            {preview.kind === 'ready' && (
              <>
                <ErrorList errors={preview.errors} />
                <span className="set-hint" style={{ display: 'block', marginTop: 10 }}>
                  {`${preview.count} row${preview.count === 1 ? '' : 's'} ready. Click Import to create ${preview.count === 1 ? 'it' : 'them'}.`}
                </span>
              </>
            )}
          </div>

          <div>
            {report && (
              <div className="set-group" style={{ marginTop: 14 }}>
                <span className="set-label">
                  {okCount} imported{failCount ? `, ${failCount} failed` : ''}
                </span>
                <div className="imp-report-list">
                  {report.map(r => (
                    <div key={r.rowNum} className={`imp-report-row${r.ok ? '' : ' imp-report-row-err'}`}>
                      <span className="imp-report-line">Row {r.rowNum}</span>
                      <span className="imp-report-name">{r.name}</span>
                      <span className="imp-report-msg">{r.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={importDisabled}
            onClick={handleImport}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 10.5V3M4.5 6.5L8 3l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Import</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
