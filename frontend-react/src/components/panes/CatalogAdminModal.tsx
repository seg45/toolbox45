// ════════════════════════════════════════════════
// "Manage Vendors/Systems/Versions/Environments/Topics/Parameters/Prompts/
// Exports" — as 8 janelas de catalog-admin (js/catalog-admin.js, 733 linhas
// no original), porta de admin-only. UM componente genérico parametrizado
// por `kind` (ver KIND_META abaixo, no espírito de CAT_ADMIN_BULK do
// original) em vez de 8 componentes quase-duplicados — mesma decisão de
// arquitetura pedida na tarefa.
//
// Estrutura comum às 8 janelas: busca client-side sobre a lista já
// carregada (de `catalogs`, a prop — não há endpoint de listagem próprio,
// ver lib/catalogAdmin.ts) + linhas editáveis inline (os próprios
// inputs/selects da lista já carregam o valor atual, sem um "modo de
// edição" separado) + linha "+ Add" (POST imediato, fora do mecanismo de
// dirty-tracking) + rodapé Cancel/Save changes (habilitados só quando há
// edição pendente; Save só envia PUT das linhas que mudaram de verdade).
//
// `rows` é reconstruído a partir de `catalogs` sempre que essa prop muda
// (abertura inicial E depois de qualquer mutação bem-sucedida, via
// onCatalogsChanged -> AppShell.refreshCatalogs -> novo objeto `catalogs`)
// — isso TAMBÉM cobre o "Cancel" explícito (que re-deriva de `catalogs`
// sem esperar uma nova busca, já que não editou nada no servidor). A
// mensagem de status (`message`) é deliberadamente MANTIDA nesse reset
// (reage só a `kind`, não a `catalogs`) — senão o refresh disparado pelo
// próprio Save apagaria "Changes saved." antes do usuário conseguir ler.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfirm } from '../../lib/useConfirm';
import { ApiError } from '../../lib/api';
import type { Catalogs } from '../../lib/catalogs';
import { createCatalogItem, deleteCatalogItem, updateCatalogItem, type CatalogItemPayload, type CatalogKind } from '../../lib/catalogAdmin';

// Mesmo SVG de lixeira do original (CAT_TRASH_SVG, js/catalog-admin.js),
// reproduzido como ícone inline — ver .cat-delete-btn em components.css
// (reaproveita a base visual de .edit-btn + hover vermelho).
const TRASH_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <path d="M3 4h10M6.5 4V2.7c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7V4M4.5 4l.6 9c.05.6.5 1 1.1 1h3.6c.6 0 1.05-.4 1.1-1l.6-9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6.7 7v4M9.3 7v4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

type FieldName = 'label' | 'color' | 'vendor' | 'system';

interface RowFields {
  label: string;
  color: string;
  vendor: string;
  system: string;
}

interface Row {
  id: string; // chave de DOM/estado — `${system}::${key}` só para versions (PK composta), senão `key`
  key: string;
  system?: string; // system ORIGINAL (identidade) — só relevante/definido para versions, usado na URL de PUT/DELETE
  protected?: boolean; // topics com is_protected
  searchText: string;
  fields: RowFields;
  original: RowFields;
}

interface KindMeta {
  title: string;
  addLabel: string; // singular, usado em "+ Add {addLabel}" e nas mensagens de erro
  fields: FieldName[]; // campos editáveis desta janela, na ordem de exibição
  parentField?: 'vendor' | 'system';
  hasKey?: boolean; // só parameters — key definida na criação, nunca editável depois
  helpText?: string;
  searchPlaceholder: string;
  newLabelPlaceholder: string;
}

const KIND_META: Record<CatalogKind, KindMeta> = {
  vendors: { title: '🏢 Manage Vendors', addLabel: 'vendor', fields: ['label', 'color'], searchPlaceholder: 'Search vendors…', newLabelPlaceholder: 'Vendor' },
  systems: {
    title: '💻 Manage Systems',
    addLabel: 'system',
    fields: ['vendor', 'label', 'color'],
    parentField: 'vendor',
    searchPlaceholder: 'Search systems…',
    newLabelPlaceholder: 'System',
  },
  versions: {
    title: '🏷️ Manage Versions',
    addLabel: 'version',
    fields: ['system', 'label', 'color'],
    parentField: 'system',
    searchPlaceholder: 'Search versions…',
    newLabelPlaceholder: 'Version',
  },
  environments: {
    title: '🌎 Manage Environments',
    addLabel: 'environment',
    fields: ['system', 'label', 'color'],
    parentField: 'system',
    searchPlaceholder: 'Search environments…',
    newLabelPlaceholder: 'Environment',
  },
  topics: { title: '📁 Manage Topics', addLabel: 'topic', fields: ['label', 'color'], searchPlaceholder: 'Search topics…', newLabelPlaceholder: 'Topic' },
  parameters: {
    title: '🔧 Manage Parameters',
    addLabel: 'parameter',
    fields: ['label'],
    hasKey: true,
    helpText: 'The key (used as {{key}} in commands) can never be changed after creation.',
    searchPlaceholder: 'Search parameters…',
    newLabelPlaceholder: 'Description',
  },
  prompts: {
    title: '➡️ Manage Prompts',
    addLabel: 'prompt',
    fields: ['label'],
    helpText: 'Reusable values for the "Prompt" field of each command line (used instead of typing free text every time).',
    searchPlaceholder: 'Search prompts…',
    newLabelPlaceholder: 'Prompt',
  },
  exports: {
    title: '➡️ Manage Exports',
    addLabel: 'export',
    fields: ['label'],
    helpText: 'Output redirection templates offered in the "Export" field of each command line, e.g. "> {{logFile}}". Supports the same {{token}} placeholders as command templates.',
    searchPlaceholder: 'Search exports…',
    newLabelPlaceholder: 'Export template, e.g. > {{logFile}}',
  },
};

const PARAMETER_KEY_RE = /^[A-Za-z0-9._-]{1,40}$/;

function localeCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function emptyFields(): RowFields {
  return { label: '', color: '#8B949E', vendor: '', system: '' };
}

// Opções do <select> de pai (vendor para systems; system para versions/
// environments) — ordenadas alfabeticamente pelo próprio label, mesma regra
// usada pra ordenar as linhas que dependem desse pai.
function parentOptions(kind: CatalogKind, catalogs: Catalogs): { key: string; label: string }[] {
  if (kind === 'systems') return [...catalogs.vendors].sort((a, b) => localeCmp(a.label, b.label));
  if (kind === 'versions' || kind === 'environments') return [...catalogs.systems].sort((a, b) => localeCmp(a.label, b.label));
  return [];
}

// Réplica de _catSortByParentThenLabel do original: agrupa pelo LABEL do pai
// (resolvido via Map key->label), depois alfabético pelo próprio label — não
// pela key do pai, que pode não ter nada a ver com a ordem alfabética do
// rótulo exibido.
function buildRows(kind: CatalogKind, catalogs: Catalogs): Row[] {
  switch (kind) {
    case 'vendors':
      return [...catalogs.vendors]
        .sort((a, b) => localeCmp(a.label, b.label))
        .map(v => {
          const fields: RowFields = { ...emptyFields(), label: v.label, color: v.color };
          return { id: v.key, key: v.key, searchText: `${v.key} ${v.label}`.toLowerCase(), fields, original: { ...fields } };
        });
    case 'systems': {
      const vendorLabel = new Map(catalogs.vendors.map(v => [v.key, v.label]));
      return [...catalogs.systems]
        .sort((a, b) => localeCmp(vendorLabel.get(a.vendor) || '', vendorLabel.get(b.vendor) || '') || localeCmp(a.label, b.label))
        .map(s => {
          const fields: RowFields = { ...emptyFields(), label: s.label, color: s.color, vendor: s.vendor };
          return { id: s.key, key: s.key, searchText: `${s.key} ${s.label}`.toLowerCase(), fields, original: { ...fields } };
        });
    }
    case 'versions': {
      const systemLabel = new Map(catalogs.systems.map(s => [s.key, s.label]));
      return [...catalogs.versions]
        .sort((a, b) => localeCmp(systemLabel.get(a.system) || '', systemLabel.get(b.system) || '') || localeCmp(a.label, b.label))
        .map(v => {
          const fields: RowFields = { ...emptyFields(), label: v.label, color: v.color, system: v.system };
          const parentLabel = systemLabel.get(v.system) || '';
          return {
            id: `${v.system}::${v.key}`,
            key: v.key,
            system: v.system,
            searchText: `${v.key} ${v.label} ${parentLabel}`.toLowerCase(),
            fields,
            original: { ...fields },
          };
        });
    }
    case 'environments': {
      const systemLabel = new Map(catalogs.systems.map(s => [s.key, s.label]));
      return [...catalogs.environments]
        .sort((a, b) => localeCmp(systemLabel.get(a.system) || '', systemLabel.get(b.system) || '') || localeCmp(a.label, b.label))
        .map(e => {
          const fields: RowFields = { ...emptyFields(), label: e.label, color: e.color, system: e.system };
          const parentLabel = systemLabel.get(e.system) || '';
          return { id: e.key, key: e.key, searchText: `${e.key} ${e.label} ${parentLabel}`.toLowerCase(), fields, original: { ...fields } };
        });
    }
    case 'topics':
      return [...catalogs.topics]
        .sort((a, b) => localeCmp(a.label, b.label))
        .map(t => {
          const fields: RowFields = { ...emptyFields(), label: t.label, color: t.color };
          return { id: t.key, key: t.key, protected: !!t.is_protected, searchText: `${t.key} ${t.label}`.toLowerCase(), fields, original: { ...fields } };
        });
    case 'parameters':
      return [...catalogs.parameters]
        .sort((a, b) => localeCmp(a.label, b.label))
        .map(p => {
          const fields: RowFields = { ...emptyFields(), label: p.label };
          return { id: p.key, key: p.key, searchText: `${p.key} ${p.label}`.toLowerCase(), fields, original: { ...fields } };
        });
    case 'prompts':
      return [...catalogs.prompts]
        .sort((a, b) => localeCmp(a.label, b.label))
        .map(p => {
          const fields: RowFields = { ...emptyFields(), label: p.label };
          return { id: p.key, key: p.key, searchText: `${p.key} ${p.label}`.toLowerCase(), fields, original: { ...fields } };
        });
    case 'exports':
      return [...catalogs.exports]
        .sort((a, b) => localeCmp(a.label, b.label))
        .map(x => {
          const fields: RowFields = { ...emptyFields(), label: x.label };
          return { id: x.key, key: x.key, searchText: `${x.key} ${x.label}`.toLowerCase(), fields, original: { ...fields } };
        });
  }
}

// Pai da linha "+ Add" começa SEMPRE vazio (placeholder desabilitado
// selecionado, ver JSX abaixo) — mesmo comportamento do original
// (_catPopulateSelect(..., null, placeholder): o <option> placeholder só
// fica desmarcado quando já existe um `selectedValue` real, nunca para uma
// linha nova). Força o usuário a escolher explicitamente o Vendor/System,
// em vez de herdar silenciosamente o primeiro item em ordem alfabética —
// e mantém alcançável a validação "Choose a vendor."/"Choose a system." em
// handleAdd() abaixo.
function defaultNewValues(): RowFields & { key: string } {
  return { key: '', label: '', color: '#8B949E', vendor: '', system: '' };
}

export function CatalogAdminModal({
  kind,
  catalogs,
  onClose,
  onCatalogsChanged,
}: {
  kind: CatalogKind;
  catalogs: Catalogs;
  onClose: () => void;
  onCatalogsChanged: () => void;
}) {
  const confirm = useConfirm();
  const meta = KIND_META[kind];

  const [rows, setRows] = useState<Row[]>(() => buildRows(kind, catalogs));
  const [search, setSearch] = useState('');
  const [newValues, setNewValues] = useState<RowFields & { key: string }>(() => defaultNewValues());
  const [addBusy, setAddBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'ok' | 'err' | null }>({ text: '', type: null });

  // Reconstrói as linhas sempre que `catalogs` muda — cobre tanto a carga
  // inicial quanto o refresh pós-mutação (ver comentário no topo do
  // arquivo). Deliberadamente SEM `message` aqui — ver mesmo comentário.
  useEffect(() => {
    setRows(buildRows(kind, catalogs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, catalogs]);

  useEffect(() => {
    setMessage({ text: '', type: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const term = search.trim().toLowerCase();
  const filtered = term ? rows.filter(r => r.searchText.includes(term)) : rows;

  function rowDiff(row: Row): CatalogItemPayload | null {
    const diff: CatalogItemPayload = {};
    let changed = false;
    for (const f of meta.fields) {
      if (row.fields[f] !== row.original[f]) {
        (diff as Record<string, string>)[f] = row.fields[f];
        changed = true;
      }
    }
    return changed ? diff : null;
  }

  const isDirty = rows.some(r => rowDiff(r) !== null);

  function setFieldValue(rowId: string, field: FieldName, value: string) {
    setRows(rs => rs.map(r => (r.id === rowId ? { ...r, fields: { ...r.fields, [field]: value } } : r)));
  }

  async function handleAdd() {
    // Validação client-side ANTES do POST, mesma ordem/mensagens do
    // original (catAdminAddVendor/catAdminAddSystem/etc. em
    // js/catalog-admin.js: key -> label -> pai), pra dar feedback imediato
    // em vez de depender só do 400 do backend.
    if (meta.hasKey) {
      const k = newValues.key.trim();
      if (!PARAMETER_KEY_RE.test(k)) {
        setMessage({ text: 'Enter a valid key (letters, numbers, dot, hyphen).', type: 'err' });
        return;
      }
    }
    if (meta.fields.includes('label') && !newValues.label.trim()) {
      setMessage({ text: 'Fill in the required label(s).', type: 'err' });
      return;
    }
    if (meta.parentField && !newValues[meta.parentField]) {
      setMessage({ text: meta.parentField === 'vendor' ? 'Choose a vendor.' : 'Choose a system.', type: 'err' });
      return;
    }
    const payload: CatalogItemPayload = {};
    if (meta.hasKey) payload.key = newValues.key.trim();
    if (meta.fields.includes('label')) payload.label = newValues.label.trim();
    if (meta.fields.includes('color')) payload.color = newValues.color;
    if (meta.fields.includes('vendor')) payload.vendor = newValues.vendor;
    if (meta.fields.includes('system')) payload.system = newValues.system;

    setAddBusy(true);
    try {
      await createCatalogItem(kind, payload);
      setNewValues(defaultNewValues());
      setMessage({ text: 'Added.', type: 'ok' });
      onCatalogsChanged();
    } catch (e) {
      setMessage({ text: e instanceof ApiError ? e.message : `Failed to add ${meta.addLabel}.`, type: 'err' });
    } finally {
      setAddBusy(false);
    }
  }

  async function handleSaveAll() {
    setSaveBusy(true);
    let successCount = 0;
    const errors: string[] = [];
    for (const row of rows) {
      const diff = rowDiff(row);
      if (!diff) continue;
      const label = row.original.label || row.key;
      if ('label' in diff && (diff.label as string).trim() === '') {
        errors.push(`"${label}": label cannot be empty.`);
        continue;
      }
      try {
        await updateCatalogItem(kind, row.key, diff, row.system);
        successCount++;
      } catch (e) {
        errors.push(`"${label}": ${e instanceof ApiError ? e.message : 'Failed to save.'}`);
      }
    }
    setSaveBusy(false);
    if (successCount > 0) onCatalogsChanged();
    if (errors.length > 0) setMessage({ text: errors.join(' '), type: 'err' });
    else if (successCount > 0) setMessage({ text: 'Changes saved.', type: 'ok' });
    else setMessage({ text: 'No changes to save.', type: null });
  }

  function handleCancel() {
    setRows(buildRows(kind, catalogs));
    setMessage({ text: '', type: null });
  }

  async function handleDeleteRow(row: Row) {
    const ok = await confirm(`Delete "${row.key}"? This action cannot be undone.`, { danger: true });
    if (!ok) return;
    try {
      await deleteCatalogItem(kind, row.key, row.system);
      setMessage({ text: 'Deleted.', type: 'ok' });
      onCatalogsChanged();
    } catch (e) {
      setMessage({ text: e instanceof ApiError ? e.message : 'Failed to delete item.', type: 'err' });
    }
  }

  const parentOpts = meta.parentField ? parentOptions(kind, catalogs) : [];

  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box modal-wide">
        <div className="modal-head">
          <span className="modal-title">{meta.title}</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="cat-panel">
            <div className={`cat-admin-msg${message.type ? ' ' + message.type : ''}`}>{message.text}</div>
            {meta.helpText && <span className="set-hint">{meta.helpText}</span>}
            <input type="text" className="set-input" placeholder={meta.searchPlaceholder} value={search} onChange={ev => setSearch(ev.target.value)} />
            <div className="list-editor" style={{ maxHeight: '40vh', overflowY: 'auto' }}>
              {filtered.map(row => (
                <div className="cat-row" key={row.id}>
                  {meta.parentField && (
                    <select
                      className="set-input"
                      style={{ maxWidth: 150 }}
                      value={row.fields[meta.parentField]}
                      onChange={ev => setFieldValue(row.id, meta.parentField!, ev.target.value)}
                    >
                      {parentOpts.map(o => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {row.protected && <span className="cat-protected-badge">protected</span>}
                  {meta.hasKey && (
                    <span className="cat-key-badge" title={row.key}>
                      {row.key}
                    </span>
                  )}
                  <input
                    className="set-input"
                    style={{ flex: 1, minWidth: 120 }}
                    value={row.fields.label}
                    onChange={ev => setFieldValue(row.id, 'label', ev.target.value)}
                  />
                  {meta.fields.includes('color') && (
                    <input type="color" className="cat-color-input" value={row.fields.color} onChange={ev => setFieldValue(row.id, 'color', ev.target.value)} />
                  )}
                  {!row.protected && (
                    <div className="cat-row-actions">
                      <button type="button" className="edit-btn cat-delete-btn" title={`Delete ${meta.addLabel}`} onClick={() => handleDeleteRow(row)}>
                        {TRASH_ICON}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {filtered.length === 0 && <div className="audit-log-empty">{term ? 'No items match your search.' : 'No items yet.'}</div>}
            </div>
            <div className="cat-row">
              {meta.parentField && (
                <select
                  className="set-input"
                  style={{ maxWidth: 150 }}
                  value={newValues[meta.parentField]}
                  onChange={ev => setNewValues(v => ({ ...v, [meta.parentField!]: ev.target.value }))}
                >
                  {/* Placeholder desabilitado, selecionado só quando nada foi
                      escolhido ainda — mesmo padrão de _catPopulateSelect()
                      do original: força o usuário a escolher explicitamente
                      (ver defaultNewValues() acima). */}
                  <option value="" disabled>
                    {meta.parentField === 'vendor' ? 'Vendor' : 'System'}
                  </option>
                  {parentOpts.map(o => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              {meta.hasKey && (
                <input
                  className="set-input"
                  style={{ maxWidth: 110 }}
                  placeholder="Key (used as {{key}})"
                  value={newValues.key}
                  onChange={ev => setNewValues(v => ({ ...v, key: ev.target.value }))}
                />
              )}
              <input
                className="set-input"
                style={{ flex: 1, minWidth: 120 }}
                placeholder={meta.newLabelPlaceholder}
                value={newValues.label}
                onChange={ev => setNewValues(v => ({ ...v, label: ev.target.value }))}
              />
              {meta.fields.includes('color') && (
                <input type="color" className="cat-color-input" value={newValues.color} onChange={ev => setNewValues(v => ({ ...v, color: ev.target.value }))} />
              )}
            </div>
            <div className="cat-add-actions">
              <button type="button" className="btn btn-sm" disabled={addBusy} onClick={handleAdd}>
                + Add {meta.addLabel}
              </button>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <div></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={!isDirty || saveBusy} onClick={handleCancel}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!isDirty || saveBusy} onClick={handleSaveAll}>
              Save changes
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
