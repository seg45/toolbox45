// ════════════════════════════════════════════════
// Painel "Resolve unmatched values" do import CSV — porta de
// renderImportResolutionPanel/_impResToggleExtra em js/csv-import.js.
//
// Diferença estrutural: o original montava HTML com ids (`impres-<tipo>-<idx>-
// choice|label|color|parent`) e lia as escolhas DE VOLTA do DOM em
// applyImportResolutions. Aqui o estado de cada item é estado do componente
// (React) — chaveado por `<tipo>:<rawKey>` (mais estável que o índice) — e o
// painel só entrega esse estado ao pai via onApply(); quem chama a API de
// criação e reavalia as pendências é ImportCommandsModal.tsx.
// ════════════════════════════════════════════════
import { useState } from 'react';
import type { Catalogs } from '../../lib/catalogs';
import {
  IMPORT_RES_META,
  IMPORT_RES_ORDER,
  importCatalogItemsFor,
  importCatalogOptionLabel,
  type ResKind,
  type UnresolvedInfo,
  type UnresolvedRefs,
} from '../../lib/csv';

// Decisão do usuário para UM valor não resolvido.
//  - choice: '__new__' (criar) ou a key de um item existente (mapear)
//  - label/color: só usados quando choice === '__new__'
//  - parent: 'key:<k>' | 'new:<rawLower>' | '' (só system/version/environment)
export interface ResItemState {
  choice: string;
  label: string;
  color: string;
  parent: string;
}

// Minúsculas de propósito: o original lia `colorInput.value`, e o navegador
// sempre devolve o valor de <input type="color"> em minúsculas.
export const DEFAULT_RES_COLOR = '#8b949e';

export function resItemKey(kind: ResKind, rawKey: string): string {
  return `${kind}:${rawKey}`;
}

// Padrão de um item ainda não tocado: "criar novo", rótulo = valor digitado
// (parâmetros começam com o rótulo VAZIO, só o placeholder — a key é o token
// e o rótulo cai no token se continuar vazio, ver applyResolutions).
export function defaultResItemState(kind: ResKind, info: UnresolvedInfo): ResItemState {
  return { choice: '__new__', label: kind === 'parameter' ? '' : info.raw, color: DEFAULT_RES_COLOR, parent: '' };
}

// Estado efetivo de um item: o que o usuário mexeu, ou o padrão.
export function getResItemState(states: Record<string, ResItemState>, kind: ResKind, rawKey: string, info: UnresolvedInfo): ResItemState {
  return states[resItemKey(kind, rawKey)] || defaultResItemState(kind, info);
}

function countText(count: number): string {
  return ` — used in ${count} command${count === 1 ? '' : 's'}`;
}

export function ImportResolutionPanel({
  unresolved,
  catalogs,
  applying,
  onSkip,
  onApply,
}: {
  unresolved: UnresolvedRefs;
  catalogs: Catalogs;
  applying: boolean;
  onSkip: () => void;
  onApply: (states: Record<string, ResItemState>) => void;
}) {
  // Só guarda o que o usuário alterou; o resto vem de defaultResItemState.
  // O pai remonta o painel (key) depois de cada "Apply", como o original
  // re-renderizava o HTML do zero só com o que sobrou.
  const [states, setStates] = useState<Record<string, ResItemState>>({});

  function patch(kind: ResKind, rawKey: string, info: UnresolvedInfo, change: Partial<ResItemState>) {
    setStates(prev => ({ ...prev, [resItemKey(kind, rawKey)]: { ...getResItemState(prev, kind, rawKey, info), ...change } }));
  }

  const paramMap = unresolved.parameter;

  return (
    <div className="imp-res-panel">
      <span className="set-hint" style={{ display: 'block', marginBottom: 10 }}>
        Some values in this file don't match anything registered yet. For each one below, create it as a new catalog item or map it to the existing
        one it should use instead.
      </span>

      {IMPORT_RES_ORDER.map(type => {
        const map = unresolved[type];
        if (!map.size) return null;
        const meta = IMPORT_RES_META[type];
        const existingItems = importCatalogItemsFor(type, catalogs);
        const parentType = meta.parent;
        const parentExistingItems = parentType ? importCatalogItemsFor(parentType, catalogs) : [];
        const parentPending = parentType ? [...unresolved[parentType].entries()] : [];

        return (
          <div key={type} className="set-group imp-res-section">
            <span className="set-label">
              {meta.label}
              {map.size > 1 ? 's' : ''} not found ({map.size})
            </span>
            {[...map.entries()].map(([rawKey, info]) => {
              const st = getResItemState(states, type, rawKey, info);
              return (
                <div key={rawKey} className="imp-res-row">
                  <div className="imp-res-raw">
                    {`"${info.raw}"`}
                    <span className="imp-res-count">{countText(info.count)}</span>
                  </div>
                  <select className="set-input imp-res-choice" value={st.choice} onChange={ev => patch(type, rawKey, info, { choice: ev.target.value })}>
                    <option value="__new__">{`➕ Create new ${meta.label.toLowerCase()}: "${info.raw}"`}</option>
                    {existingItems.length > 0 && <option disabled>──────────</option>}
                    {existingItems.map((it, i) => (
                      <option key={`${it.key}|${i}`} value={it.key}>
                        {importCatalogOptionLabel(type, it, catalogs)}
                      </option>
                    ))}
                  </select>
                  {st.choice === '__new__' && (
                    <div className="imp-res-extra">
                      <input
                        className="set-input"
                        value={st.label}
                        placeholder={`${meta.label} name`}
                        style={{ flex: 1, minWidth: 120 }}
                        onChange={ev => patch(type, rawKey, info, { label: ev.target.value })}
                      />
                      <input type="color" className="cat-color-input" value={st.color} onChange={ev => patch(type, rawKey, info, { color: ev.target.value })} />
                      {parentType && (
                        <select className="set-input imp-res-parent" value={st.parent} onChange={ev => patch(type, rawKey, info, { parent: ev.target.value })}>
                          <option value="">— choose {IMPORT_RES_META[parentType].label} —</option>
                          {parentExistingItems.map((it, i) => (
                            <option key={`key:${it.key}|${i}`} value={`key:${it.key}`}>
                              {importCatalogOptionLabel(parentType, it, catalogs)}
                            </option>
                          ))}
                          {parentPending.map(([praw, pinfo]) => (
                            <option key={`new:${praw}`} value={`new:${praw}`}>
                              {pinfo.raw} (new, from this file)
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Parâmetros ({{token}}) — mesmo painel, layout próprio: sem "pai", e a
          key NUNCA é editável na criação (É o token já usado no arquivo); só o
          rótulo/descrição é editável. */}
      {paramMap.size > 0 && (
        <div className="set-group imp-res-section">
          <span className="set-label">
            Parameter{paramMap.size > 1 ? 's' : ''} not registered ({paramMap.size})
          </span>
          {[...paramMap.entries()].map(([token, info]) => {
            const st = getResItemState(states, 'parameter', token, info);
            return (
              <div key={token} className="imp-res-row">
                <div className="imp-res-raw">
                  {`"{{${info.raw}}}"`}
                  <span className="imp-res-count">{countText(info.count)}</span>
                </div>
                <select className="set-input imp-res-choice" value={st.choice} onChange={ev => patch('parameter', token, info, { choice: ev.target.value })}>
                  <option value="__new__">{`➕ Create new parameter: {{${token}}}`}</option>
                  {(catalogs.parameters || []).length > 0 && <option disabled>──────────</option>}
                  {(catalogs.parameters || []).map(p => (
                    <option key={p.key} value={p.key}>
                      {`${p.label} ({{${p.key}}})`}
                    </option>
                  ))}
                </select>
                {st.choice === '__new__' && (
                  <div className="imp-res-extra">
                    <span className="imp-res-param-key">
                      Key: <code>{`{{${token}}}`}</code> (fixed — matches the token used in this file)
                    </span>
                    <input
                      className="set-input"
                      value={st.label}
                      placeholder="Parameter description (e.g. Source IP)"
                      style={{ flex: 1, minWidth: 140 }}
                      onChange={ev => patch('parameter', token, info, { label: ev.target.value })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="imp-res-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSkip}>
          Import anyway (skip unresolved)
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={applying} onClick={() => onApply(states)}>
          {applying ? 'Applying…' : 'Apply & continue'}
        </button>
      </div>
    </div>
  );
}
