// ════════════════════════════════════════════════
// EDITOR DE COMANDO (Add/Edit/Duplicate) — porta do wizard de 3 passos
// (Identification / Scope / Command lines) que cria, edita ou duplica um
// comando do catálogo. Markup original: #cmdEditorOverlay em index.html
// (285 linhas). Lógica original: js/command-editor.js (966 linhas,
// integral) — portado abaixo campo a campo, preservando cada regra de
// negócio, mensagem de erro e caso de borda do original, incluindo:
// System como single-select (não multi — `_ceSetSingleSeg('cmdSysSeg', ...)`
// no original, apesar do rótulo plural "Systems"), a linha padrão
// pré-populada (prompt "[Expert@FW]#") ao criar um comando novo/ao clicar
// "+ Add line", os dropdowns Prompt/Export/Insert-variable só visíveis para
// linhas tipo "cmd", e os DOIS conjuntos de mensagem de validação (um mais
// brando usado por "Next", outro mais explícito usado por "Save" —
// _ceValidateStep vs. as checagens inline de cmdEditorSave no original).
//
// Backend (server-py/app/routers/commands.py) já validado em produção
// desde a Fase 1 — nenhuma mudança de API aqui, só consome o contrato
// existente (POST/PUT/DELETE /api/commands, ver src/lib/commands.ts).
// ════════════════════════════════════════════════
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Catalogs, CatalogEntry } from '../../lib/catalogs';
import { createCommand, deleteCommand, updateCommand, type Command, type CommandLine, type CommandLinePayload, type CommandPayload } from '../../lib/commands';
import { useConfirm } from '../../lib/useConfirm';
import { RichTextEditor, type RichTextEditorHandle } from '../RichTextEditor';
import { SegMulti, SegSingle, type SegOption } from '../SegControls';

export type EditorMode = 'create' | 'edit' | 'duplicate';

let _lineKeySeq = 0;
function nextLineKey(): string {
  _lineKeySeq += 1;
  return `ln${_lineKeySeq}_${Date.now().toString(36)}`;
}

interface EditorLine {
  _key: string;
  line_type: CommandLine['line_type'];
  prompt: string | null;
  content: string;
  export_template: string | null;
  image_data: string | null;
}

function toEditorLine(l: CommandLine): EditorLine {
  return { _key: nextLineKey(), line_type: l.line_type, prompt: l.prompt, content: l.content, export_template: l.export_template, image_data: l.image_data };
}

// Mesmo valor-padrão de _ceBuildLineRow(data) no original quando chamado
// sem argumento (create novo / botão "+ Add line" — cmdEditorAddLine('cmdLinesDefaultList')
// sem `data`, ver anexo A): prompt já vem preenchido com "[Expert@FW]#", não
// vazio — o usuário troca se quiser, mas o campo nunca nasce em branco.
function newEditorLine(): EditorLine {
  return { _key: nextLineKey(), line_type: 'cmd', prompt: '[Expert@FW]#', content: '', export_template: null, image_data: null };
}

// Sanitiza os campos irrelevantes ao tipo da linha — mesma filtragem que
// _ceReadLinesFrom faz no original (prompt/export_template só sobrevivem
// para linhas 'cmd'; image_data só para 'image'), aplicada tanto no
// snapshot de dirty-check quanto no payload de salvar. Sem isso, alternar o
// dropdown "Type" de uma linha (cmd→text, por exemplo) deixaria o
// prompt/export antigo "grudado" no estado e vazando pro payload salvo,
// mesmo escondido da UI.
function sanitizeLineForSave(l: EditorLine): Pick<EditorLine, 'line_type' | 'prompt' | 'content' | 'export_template' | 'image_data'> {
  return {
    line_type: l.line_type,
    prompt: l.line_type === 'cmd' ? l.prompt || null : null,
    content: l.content,
    export_template: l.line_type === 'cmd' ? l.export_template || null : null,
    image_data: l.line_type === 'image' ? l.image_data || null : null,
  };
}

// Acrescenta o valor ATUAL como uma opção extra no topo da lista quando ele
// não bate com nenhuma opção cadastrada no catálogo — preserva um valor
// legado (Prompt/Export de uma edição antiga, ou uma linha 'note' — ver
// CMD_EDITOR_TEXT_CATEGORIES_LEGACY abaixo) em vez de silenciosamente
// trocá-lo/escondê-lo do dropdown.
function withLegacyOption(options: SegOption[], value: string): SegOption[] {
  if (!value) return options;
  if (options.some(o => o.val === value)) return options;
  return [{ val: value, label: value }, ...options];
}

function sortedCatalog(entries: CatalogEntry[] | undefined): SegOption[] {
  return (entries || [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(e => ({ val: e.key, label: e.label }));
}

// ════════════════════════════════════════════════
// Payload de salvar — POST /api/commands / PUT /api/commands/:id
// ════════════════════════════════════════════════
function linesToPayload(lines: EditorLine[], variant: 'default' | 'empty'): CommandLinePayload[] {
  return lines.map((l, i) => ({
    sort_order: i,
    ...sanitizeLineForSave(l),
    variant,
  }));
}

// A variante 'empty' nunca é editada por esta UI (ver comentário no passo 3
// mais abaixo) — só precisa ser reindexada (sort_order = índice) e marcada
// com variant:'empty' pra não se perder ao salvar uma edição/duplicação.
function rawLinesToPayload(lines: CommandLine[]): CommandLinePayload[] {
  return lines.map((l, i) => ({
    sort_order: i,
    line_type: l.line_type,
    prompt: l.prompt,
    content: l.content,
    export_template: l.export_template,
    image_data: l.image_data,
    variant: 'empty',
  }));
}

interface Props {
  mode: EditorMode;
  // undefined em modo 'create'; a row original do catálogo em 'edit'/'duplicate'.
  sourceRow?: Command;
  catalogs: Catalogs | null;
  onClose: () => void;
  onSaved: () => void; // invalida cache + refetch + setCommands, ver CommandsContent.tsx
}

export function CommandEditorModal({ mode, sourceRow, catalogs, onClose, onSaved }: Props) {
  const auth = useAuth();
  const confirm = useConfirm();

  // ── Guarda de permissão ao ABRIR em modo edit (defesa em profundidade —
  // o botão Edit já não aparece no CommandCard se esta regra falhar, mas a
  // checagem é repetida aqui). Duplicar nunca precisa de permissão (sempre
  // cria uma cópia própria nova). ──
  const guardFailed = mode === 'edit' && !!sourceRow && !(auth.isAdmin || sourceRow.is_system || auth.me?.username === sourceRow.created_by);
  const guardAlerted = useRef(false);
  useEffect(() => {
    if (guardFailed && !guardAlerted.current) {
      guardAlerted.current = true;
      window.alert('You can only edit your own commands (or System commands). Duplicate it to create your own editable copy.');
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardFailed]);

  // ════════════════════════════════════════════════
  // Estado do wizard
  // ════════════════════════════════════════════════
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Em modo edit/duplicate, TODOS os passos começam desbloqueados (a row já
  // tem dados válidos em todo lugar) — só em modo create o usuário anda
  // passo a passo com validação bloqueante.
  const [maxStep, setMaxStep] = useState<1 | 2 | 3>(mode === 'create' ? 1 : 3);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // ── Passo 1 — Identification ──
  const [name, setName] = useState(sourceRow?.name || '');
  const [desc, setDesc] = useState(sourceRow?.desc || '');
  const detailsRef = useRef<RichTextEditorHandle>(null);
  // Campos "escondidos" (sem UI própria) preservados de uma edição de um
  // comando requires_ip_port — ver cmdEmptyNameRow/cmdEmptyDescRow em
  // index.html (nascem style="display:none", sem nenhum toggle de UI). Não
  // há necessidade de renderizar inputs escondidos no React (diferente do
  // DOM original) — bastam de ficarem guardados no estado e serem incluídos
  // sem alteração no payload de salvar.
  const [nameEmpty] = useState<string | null>(sourceRow?.name_empty ?? null);
  const [descEmpty] = useState<string | null>(sourceRow?.desc_empty ?? null);

  // ── Passo 2 — Scope ──
  // System também é single-select no original, apesar do rótulo plural
  // "Systems" — `_ceSetSingleSeg('cmdSysSeg', row.systems || [], 'cmdSysDDBtn')`
  // no anexo A usa o MESMO helper de seleção única do Vendor (não
  // `_ceSetMultiSeg`); o campo `systems` do payload continua um array
  // (`vendors`/`systems: string[]` no schema do backend), só com no máximo
  // 1 elemento, exatamente como `vendors` já era.
  const [vendor, setVendor] = useState(sourceRow?.vendors?.[0] || '');
  const [system, setSystem] = useState(sourceRow?.systems?.[0] || '');
  const [versions, setVersions] = useState<string[]>(sourceRow ? [...sourceRow.versions] : []);
  const [environments, setEnvironments] = useState<string[]>(sourceRow ? [...sourceRow.environments] : []);
  const [topics, setTopics] = useState<string[]>(() => {
    if (!sourceRow) return ['capture']; // create/duplicate começam com 'capture' pré-marcado
    return sourceRow.topics && sourceRow.topics.length ? [...sourceRow.topics] : [sourceRow.topic];
  });

  // ── Passo 3 — Command lines ──
  // Modo create (não duplicate — duplicate sempre tem sourceRow) começa com
  // UMA linha já presente (prompt "[Expert@FW]#") — mesmo efeito de
  // _ceResetForm() chamar cmdEditorAddLine() incondicionalmente antes de
  // (opcionalmente) _cePopulateForm() sobrescrever tudo a partir da row.
  const [lines, setLines] = useState<EditorLine[]>(() =>
    sourceRow ? sourceRow.lines.default.map(toEditorLine) : [newEditorLine()]
  );
  // Variante 'empty' (requires_ip_port) — sem UI própria nesta fatia, só
  // precisa não ser perdida ao salvar uma edição/duplicação. Guardada como
  // CommandLine[] crua (não EditorLine — nunca editada, só repassada).
  const [emptyLines] = useState<CommandLine[]>(() => (sourceRow?.lines.empty ? [...sourceRow.lines.empty] : []));
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  // ── Snapshot inicial (dirty-check pro "fechar sem salvar") ──
  const initialSnapshotRef = useRef('');
  function buildSnapshot(): string {
    return JSON.stringify({
      vendor,
      system,
      versions,
      environments,
      topics,
      name,
      nameEmpty,
      desc,
      descEmpty,
      detailsHtml: detailsRef.current?.getHtml() || '',
      lines: lines.map(sanitizeLineForSave),
    });
  }
  useEffect(() => {
    detailsRef.current?.setHtml(sourceRow?.details || '');
    detailsRef.current?.resetFontSizeUI();
    initialSnapshotRef.current = buildSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // roda uma única vez, na montagem (form já populado a partir de sourceRow acima)

  // ════════════════════════════════════════════════
  // Cascata Vendor → System → Version/Environment DENTRO do form (diferente
  // da cascata da sidebar) — implementada com useMemo computando as listas
  // de opções filtradas a partir de catalogs + seleção atual (mais
  // idiomático em React do que esconder via CSS display:none mantendo o
  // item no DOM, como o original fazia). Seleção vazia (vendor=''/
  // systems=[]) não restringe nada — mesmo critério de "seleção vazia
  // aplica a todos" usado em renderPipeline.ts::filterCommands.
  // ════════════════════════════════════════════════
  const systemOptions = useMemo<SegOption[]>(() => {
    const all = catalogs?.systems || [];
    const filtered = vendor ? all.filter(s => s.vendor === vendor) : all;
    return sortedCatalog(filtered);
  }, [catalogs, vendor]);
  useEffect(() => {
    setSystem(prev => (prev && !systemOptions.some(o => o.val === prev) ? '' : prev));
  }, [systemOptions]);

  // Version E Environment dependem de System diretamente (não de Version
  // entre si) — mesmo critério do original (_ceApplyEditorCascade lê
  // `systems` uma única vez e filtra AMBAS as listas a partir dele).
  const versionOptions = useMemo<SegOption[]>(() => {
    const all = catalogs?.versions || [];
    const filtered = system ? all.filter(v => v.system === system) : all;
    return sortedCatalog(filtered);
  }, [catalogs, system]);
  useEffect(() => {
    setVersions(prev => prev.filter(v => versionOptions.some(o => o.val === v)));
  }, [versionOptions]);

  const environmentOptions = useMemo<SegOption[]>(() => {
    const all = catalogs?.environments || [];
    const filtered = system ? all.filter(e => e.system === system) : all;
    return sortedCatalog(filtered);
  }, [catalogs, system]);
  useEffect(() => {
    setEnvironments(prev => prev.filter(v => environmentOptions.some(o => o.val === v)));
  }, [environmentOptions]);

  const vendorOptions = useMemo<SegOption[]>(() => sortedCatalog(catalogs?.vendors), [catalogs]);
  const topicOptions = useMemo<SegOption[]>(() => sortedCatalog(catalogs?.topics), [catalogs]);
  // Sem opção vazia "— No prompt —": o original (_ceBuildPromptOptions)
  // nunca oferece uma — uma linha 'cmd' sempre carrega algum prompt (o
  // padrão "[Expert@FW]#" ou um valor do catálogo); só Export tem uma opção
  // "nenhum" de verdade (_ceBuildExportOptions começa com essa option vazia
  // explícita).
  const promptOptions = useMemo<SegOption[]>(() => sortedCatalog(catalogs?.prompts), [catalogs]);
  const exportOptions = useMemo<SegOption[]>(() => [{ val: '', label: '— No export —' }, ...sortedCatalog(catalogs?.exports)], [catalogs]);
  const parameterOptions = useMemo(
    () => (catalogs?.parameters || []).slice().sort((a, b) => a.sort_order - b.sort_order),
    [catalogs]
  );

  // ════════════════════════════════════════════════
  // Validação (bloqueante só em modo create — ver comentário no topo) — o
  // original tem DOIS conjuntos de mensagem distintos para a MESMA
  // condição: um mais brando usado por "Next" (_ceValidateStep, navegação
  // do wizard) e outro mais explícito usado por "Save" (checagem inline em
  // cmdEditorSave, rede de segurança final). Preservados literalmente aqui
  // em vez de unificados, porque o texto exibido ao usuário realmente muda
  // conforme o caminho.
  // ════════════════════════════════════════════════
  const step2Incomplete = !vendor || !system || !versions.length || !environments.length || !topics.length;

  function validateStep1Next(): string {
    return name.trim() ? '' : 'Fill in the command Name before continuing.';
  }
  function validateStep2Next(): string {
    return step2Incomplete ? 'Check at least one option in Vendor, Systems, Versions, Environments and Topic before continuing.' : '';
  }
  function validateAll(): { step: 1 | 2 | 3; message: string } | null {
    if (!name.trim()) return { step: 1, message: 'Fill in the required field: Name.' };
    if (step2Incomplete) {
      return {
        step: 2,
        message:
          'Fill in the required fields: Vendor, System, Version, Environment, Topic — each list needs at least one option checked ("All" is only a filter, not a value a command can be saved with).',
      };
    }
    return null;
  }

  // ════════════════════════════════════════════════
  // Navegação do wizard — ver _ceRenderWizardState / cmdWizNext/cmdWizBack/
  // cmdWizGoTo no original (regras de visibilidade dos botões repetidas
  // literalmente no comentário de cada botão do rodapé, mais abaixo).
  // ════════════════════════════════════════════════
  function goTo(n: 1 | 2 | 3) {
    if (n > maxStep) return; // botão já vem `disabled`, checagem redundante de segurança
    setError('');
    setStep(n);
  }
  function handleBack() {
    setError('');
    setStep(s => (s === 1 ? s : ((s - 1) as 1 | 2 | 3)));
  }
  // cmdWizNext() no original SEMPRE valida o passo atual antes de avançar,
  // em QUALQUER modo (não só create) — `_ceValidateStep(CMD_WIZ_STEP)` roda
  // incondicionalmente. Em edit/duplicate isso raramente barra alguém
  // porque os dados já chegam válidos (por isso maxStep já nasce em 3), mas
  // se um usuário editando esvaziar o Name e clicar "Next →" antes de
  // clicar Save, o original bloqueia — preservado aqui sem um `if (mode ===
  // 'create')` de guarda.
  function handleNext() {
    const err = step === 1 ? validateStep1Next() : step === 2 ? validateStep2Next() : '';
    if (err) {
      setError(err);
      return;
    }
    setError('');
    const next = (step === 3 ? 3 : ((step + 1) as 1 | 2 | 3));
    setStep(next);
    setMaxStep(m => (next > m ? next : m));
  }

  function buildPayload(): CommandPayload {
    return {
      topics,
      // 'duplicate' NUNCA herda o resolver do comando original — é ligado
      // ao id antigo, não faria sentido sob um id novo. Em 'edit', preserva
      // o valor já existente (esta UI nunca deixa o usuário mudá-lo — só
      // exibido como aviso, ver .resolver-warning abaixo).
      placeholder_resolver: mode === 'edit' ? sourceRow?.placeholder_resolver ?? null : null,
      name: name.trim(),
      name_empty: nameEmpty,
      desc,
      desc_empty: descEmpty,
      details: detailsRef.current?.getHtml() || '',
      vendors: vendor ? [vendor] : [],
      systems: system ? [system] : [],
      versions,
      environments,
      lines: [...linesToPayload(lines, 'default'), ...rawLinesToPayload(emptyLines)],
    };
  }

  async function handleSave() {
    const invalid = validateAll();
    if (invalid) {
      setError(invalid.message);
      setStep(invalid.step);
      setMaxStep(m => (invalid.step > m ? invalid.step : m));
      return;
    }
    setError('');
    setSaving(true);
    try {
      const payload = buildPayload();
      if (mode === 'edit' && sourceRow) {
        await updateCommand(sourceRow.id, payload);
      } else {
        await createCommand(payload);
      }
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409) {
          setError('A command with this name already exists — try a slightly different name and save again.');
        } else if (e.status === 400) {
          setError(e.message || 'Please fill in all required fields.');
        } else if (e.status === 403) {
          setError(e.message || 'You can only edit your own commands (or System commands). Duplicate it to create your own editable copy.');
        } else {
          setError('Failed to save the command. Please try again.');
        }
      } else {
        setError('Failed to save the command. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  // Só existe em modo 'edit'. isAdmin || me.username === row.created_by —
  // note que is_system NÃO entra aqui (diferente da guarda de abertura em
  // modo edit acima): qualquer usuário pode ABRIR um comando de sistema
  // para editar, mas só um admin (ou o próprio autor) pode excluí-lo.
  const canDelete = mode === 'edit' && !!sourceRow && (auth.isAdmin || auth.me?.username === sourceRow.created_by);

  async function handleDelete() {
    if (!sourceRow) return;
    const ok = await confirm(`Delete command "${sourceRow.name}" (${sourceRow.id})? This action cannot be undone.`, { danger: true });
    if (!ok) return;
    setError('');
    try {
      await deleteCommand(sourceRow.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.message ? e.message : 'Failed to delete the command. Please try again.');
    }
  }

  async function requestClose() {
    const dirty = buildSnapshot() !== initialSnapshotRef.current;
    if (dirty) {
      const ok = await confirm('You have unsaved changes. Close without saving?', { danger: true });
      if (!ok) return;
    }
    onClose();
  }

  // ════════════════════════════════════════════════
  // Linhas de comando (passo 3)
  // ════════════════════════════════════════════════
  function updateLine(key: string, patch: Partial<EditorLine>) {
    setLines(prev => prev.map(l => (l._key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: string) {
    setLines(prev => prev.filter(l => l._key !== key));
  }
  function addLine() {
    setLines(prev => [...prev, newEditorLine()]);
  }
  function reorderTo(overKey: string) {
    if (!draggingKey || draggingKey === overKey) return;
    setLines(prev => {
      const from = prev.findIndex(l => l._key === draggingKey);
      const to = prev.findIndex(l => l._key === overKey);
      if (from === -1 || to === -1) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  if (guardFailed) return null;

  const titleText = mode === 'create' ? '➕ New command' : mode === 'duplicate' ? '📋 Duplicate command' : '✏️ Edit command';
  const showNext = mode === 'edit' || step < 3;
  const showSave = mode === 'edit' || step === 3;

  return (
    <div className="modal-overlay show" id="cmdEditorOverlay">
      <div className="modal-box modal-wide">
        <div className="modal-head">
          <span className="modal-title" id="cmdEditorTitle">{titleText}</span>
          <button className="modal-close" onClick={requestClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="cmd-editor-error show">{error}</div>}
          {mode === 'edit' && sourceRow?.placeholder_resolver && (
            <div className="resolver-warning show">
              <span>⚠️</span>
              <span>
                ⚠️ This command uses advanced code-driven logic (net-utils.js) to expand IP lists/ranges/CIDR — e.g. fw monitor, tcpdump, fw
                ctl zdebug, fw tab, ip route get, fwaccel conns, fw fetchlogs, fwm logexport. Editing the lines here only changes the display
                fallback shown when that logic does not apply — the actual computed behavior requires a code change, not just this data edit.
              </span>
            </div>
          )}

          <div className="wiz-steps" id="cmdWizSteps">
            {([1, 2, 3] as const).map((n, idx) => (
              <Fragment key={n}>
                {idx > 0 && <span className="wiz-step-sep"></span>}
                <button
                  type="button"
                  className={`wiz-step${step === n ? ' on' : ''}${n <= maxStep && n !== step ? ' done' : ''}`}
                  data-step={n}
                  disabled={n > maxStep}
                  onClick={() => goTo(n)}
                >
                  <span className="wiz-step-num">{n}</span>
                  <span className="wiz-step-label">{n === 1 ? 'Identification' : n === 2 ? 'Scope' : 'Command lines'}</span>
                </button>
              </Fragment>
            ))}
          </div>

          {/* ═══ STEP 1 — Identification ═══ Todos os 3 painéis ficam
              sempre montados (display:none nos inativos, não desmontados) —
              mesmo padrão do original (".wiz-panel visível só via inline
              style"), necessário aqui porque o <RichTextEditor> do Details é
              não-controlado: desmontá-lo ao trocar de passo perderia
              qualquer edição em andamento ainda não lida via getHtml(). */}
          <div className="wiz-panel" data-step="1" style={{ display: step === 1 ? undefined : 'none' }}>
            <div className="set-group">
              <span className="set-label">Name *</span>
              <input className="set-input" id="cmdName" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="set-group">
              <span className="set-label">Description</span>
              <input className="set-input" id="cmdDesc" value={desc} onChange={e => setDesc(e.target.value)} />
            </div>
            <div className="set-group set-group-details">
              <span className="set-label">Details</span>
              <RichTextEditor ref={detailsRef} ariaLabel="Command details" />
            </div>
          </div>

          {/* ═══ STEP 2 — Scope ═══ */}
          <div className="wiz-panel" data-step="2" style={{ display: step === 2 ? undefined : 'none' }}>
            <div className="set-group">
              <span className="set-label">Vendor</span>
              <span className="set-hint">Choose one — required (a command belongs to a single vendor; "All" is only a filter option, not a value a command can be saved with)</span>
              <SegSingle label="Vendor" options={vendorOptions} value={vendor} onChange={setVendor} />
            </div>
            <div className="set-group">
              <span className="set-label">Systems</span>
              <span className="set-hint">Choose one — required (single-select despite the plural label, same as the original editor; "All" is only a filter option, not a value a command can be saved with)</span>
              <SegSingle label="Systems" options={systemOptions} value={system} onChange={setSystem} />
            </div>
            <div className="set-group">
              <span className="set-label">Versions</span>
              <span className="set-hint">Check one or more — required ("All" is only a filter option, not a value a command can be saved with)</span>
              <SegMulti options={versionOptions} selected={versions} onChange={setVersions} pluralWord="versions" />
            </div>
            <div className="set-group">
              <span className="set-label">Environments</span>
              <span className="set-hint">Check one or more — required ("All" is only a filter option, not a value a command can be saved with)</span>
              <SegMulti options={environmentOptions} selected={environments} onChange={setEnvironments} pluralWord="environments" />
            </div>
            <div className="set-group">
              <span className="set-label">Topic</span>
              <span className="set-hint">Check one or more — a command can appear under several sections</span>
              <SegMulti options={topicOptions} selected={topics} onChange={setTopics} pluralWord="topics" />
            </div>
          </div>

          {/* ═══ STEP 3 — Command lines ═══ */}
          <div className="wiz-panel" data-step="3" style={{ display: step === 3 ? undefined : 'none' }}>
            <div className="set-section-title">Command</div>
            <span className="set-hint">
              Supports the tokens {'{{src_ip}}, {{dst_ip}}, {{src_port}}, {{dst_port}}, {{proto}}, {{iface}}, {{vsid}}, {{logFile}}'} —
              substituted at render time.
            </span>
            <div className="list-editor" id="cmdLinesDefaultList">
              {lines.map(line => (
                <LineRowEditor
                  key={line._key}
                  line={line}
                  promptOptions={promptOptions}
                  exportOptions={exportOptions}
                  parameterOptions={parameterOptions}
                  dragging={draggingKey === line._key}
                  onChange={patch => updateLine(line._key, patch)}
                  onRemove={() => removeLine(line._key)}
                  onDragStart={() => setDraggingKey(line._key)}
                  onDragOver={() => reorderTo(line._key)}
                  onDragEnd={() => setDraggingKey(null)}
                />
              ))}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={addLine}>+ Add line</button>
            {/* A variante 'empty' (requires_ip_port) não tem UI própria
                nesta fatia — sem toggle visível, só preservada no estado
                (emptyLines) e incluída sem alteração no payload de salvar
                (ver buildPayload acima). */}
          </div>
        </div>
        <div className="modal-foot" style={{ justifyContent: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" id="cmdWizBackBtn" disabled={step === 1} onClick={handleBack}>← Back</button>
            {showNext && (
              <button className="btn btn-primary" id="cmdWizNextBtn" disabled={mode === 'edit' && step === 3} onClick={handleNext}>
                Next →
              </button>
            )}
            {showSave && (
              <button className="btn btn-primary" id="cmdWizSaveBtn" disabled={saving} onClick={handleSave}>
                Save
              </button>
            )}
          </div>
          <span className="wiz-required-note">* required field</span>
          {canDelete && step === 3 && (
            <button className="btn btn-ghost" id="cmdEditorDeleteBtn" style={{ color: 'var(--red)' }} onClick={handleDelete}>
              🗑️ Delete command
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════
// Uma linha de comando (passo 3) — porta de _ceBuildLineRow (ver comentário
// em css/components.css sobre .line-row/.ln-image-dropzone/.ln-drag-handle).
// dropdown de tipo (cmd/image/text — text agrupa visualmente info/ok/warn,
// com um segundo dropdown de categoria só quando text está selecionado).
// ════════════════════════════════════════════════
const TYPE_OPTIONS: SegOption[] = [
  { val: 'cmd', label: 'Command' },
  { val: 'image', label: 'Image' },
  { val: 'text', label: 'Text' },
];
// NÃO oferece 'note' como opção nova (CMD_EDITOR_TEXT_CATEGORIES_LEGACY) —
// só é adicionada dinamicamente via withLegacyOption() quando a linha já
// existente for desse tipo, pra não perder/trocar sozinha a categoria de
// uma linha 'note' pré-existente.
const CATEGORY_OPTIONS: SegOption[] = [
  { val: 'info', label: 'Info' },
  { val: 'warn', label: 'Warning' },
  { val: 'ok', label: 'OK' },
];

function uiTypeOf(lineType: CommandLine['line_type']): 'cmd' | 'image' | 'text' {
  return lineType === 'cmd' || lineType === 'image' ? lineType : 'text';
}

function LineRowEditor({
  line,
  promptOptions,
  exportOptions,
  parameterOptions,
  dragging,
  onChange,
  onRemove,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  line: EditorLine;
  promptOptions: SegOption[];
  exportOptions: SegOption[];
  parameterOptions: { key: string; label: string }[];
  dragging: boolean;
  onChange: (patch: Partial<EditorLine>) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
}) {
  const uiType = uiTypeOf(line.line_type);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOverImg, setDragOverImg] = useState(false);
  const [varOpen, setVarOpen] = useState(false);
  const varWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!varOpen) return;
    function onDocClick(ev: MouseEvent) {
      if (varWrapRef.current && !varWrapRef.current.contains(ev.target as Node)) setVarOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [varOpen]);

  function handleTypeChange(val: string) {
    if (val === 'cmd' || val === 'image') {
      onChange({ line_type: val });
    } else {
      // Voltando para 'text': categoria padrão 'info' (a menos que já
      // estivesse em text — o próprio SegSingle não deixa escolher o valor
      // já ativo de novo, então isso só roda vindo de cmd/image).
      onChange({ line_type: 'info' });
    }
  }

  function readImageFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => onChange({ image_data: reader.result as string });
    reader.readAsDataURL(file);
  }

  function insertVariable(key: string) {
    const token = `{{${key}}}`;
    const ta = textareaRef.current;
    if (!ta) {
      onChange({ content: line.content + token });
      setVarOpen(false);
      return;
    }
    const start = ta.selectionStart ?? line.content.length;
    const end = ta.selectionEnd ?? line.content.length;
    const next = line.content.slice(0, start) + token + line.content.slice(end);
    onChange({ content: next });
    setVarOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  const categoryOptions = line.line_type === 'note' ? [{ val: 'note', label: 'Note (legacy)' }, ...CATEGORY_OPTIONS] : CATEGORY_OPTIONS;

  return (
    <div
      className={`line-row${dragging ? ' dragging' : ''}`}
      onDragOver={ev => {
        ev.preventDefault();
        onDragOver();
      }}
      onDrop={ev => ev.preventDefault()}
      onDragEnd={onDragEnd}
    >
      <div className="row-head">
        <span
          className="ln-drag-handle"
          draggable
          onDragStart={onDragStart}
          title="Drag to reorder"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <circle cx="5" cy="3" r="1.3" fill="currentColor" />
            <circle cx="11" cy="3" r="1.3" fill="currentColor" />
            <circle cx="5" cy="8" r="1.3" fill="currentColor" />
            <circle cx="11" cy="8" r="1.3" fill="currentColor" />
            <circle cx="5" cy="13" r="1.3" fill="currentColor" />
            <circle cx="11" cy="13" r="1.3" fill="currentColor" />
          </svg>
        </span>
        <SegSingle label="Type" options={TYPE_OPTIONS} value={uiType} onChange={handleTypeChange} />
        {uiType === 'text' && (
          <SegSingle label="Category" options={categoryOptions} value={line.line_type} onChange={v => onChange({ line_type: v as CommandLine['line_type'] })} />
        )}
        {/* Prompt/Insert variable/Export — visíveis SÓ para linhas tipo
            "cmd" (promptInput.style.display = isCmd ? '' : 'none', mesmo
            para exportSelect/varDD, ver syncPromptVisibility no anexo A).
            Uma linha "text"/"image" nunca tem prompt de shell nem export
            template. */}
        {uiType === 'cmd' && (
          <>
            <SegSingle label="Prompt" options={withLegacyOption(promptOptions, line.prompt || '')} value={line.prompt || ''} onChange={v => onChange({ prompt: v || null })} />
            <div className="ln-var-dd" ref={varWrapRef}>
              <div className={`dd${varOpen ? ' open' : ''}`}>
                <button type="button" className="dd-btn" onClick={() => setVarOpen(o => !o)}>
                  <span className="dd-label">Insert variable</span>
                  <span className="dd-arrow">▾</span>
                </button>
                {varOpen && (
                  <div className="dd-panel seg">
                    {parameterOptions.map(p => (
                      <button key={p.key} type="button" className="seg-btn" onClick={() => insertVariable(p.key)}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <SegSingle
              label="Export"
              options={withLegacyOption(exportOptions, line.export_template || '')}
              value={line.export_template || ''}
              onChange={v => onChange({ export_template: v || null })}
            />
          </>
        )}
        <button type="button" className="btn btn-ghost btn-sm row-remove-btn" onClick={onRemove}>✕ Remove</button>
      </div>

      {uiType === 'image' ? (
        <div className="set-group">
          <span className="set-label">Name</span>
          <input className="set-input" value={line.content} onChange={e => onChange({ content: e.target.value })} />
          <div
            className={`ln-image-dropzone${dragOverImg ? ' dragover' : ''}`}
            tabIndex={0}
            onDragOver={ev => {
              ev.preventDefault();
              setDragOverImg(true);
            }}
            onDragLeave={() => setDragOverImg(false)}
            onDrop={ev => {
              ev.preventDefault();
              setDragOverImg(false);
              const f = ev.dataTransfer.files?.[0];
              if (f) readImageFile(f);
            }}
            onPaste={ev => {
              const items = ev.clipboardData?.items;
              if (!items) return;
              for (let i = 0; i < items.length; i++) {
                if (items[i].type && items[i].type.startsWith('image/')) {
                  const f = items[i].getAsFile();
                  if (f) readImageFile(f);
                  break;
                }
              }
            }}
          >
            {line.image_data ? (
              <img className="ln-image-preview" src={line.image_data} alt="" />
            ) : (
              <span className="ln-image-placeholder">Drag an image here, paste (Ctrl+V), or choose a file</span>
            )}
            <div className="ln-image-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()}>Choose file…</button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) readImageFile(f);
              }}
            />
          </div>
        </div>
      ) : (
        <div className="set-group">
          <span className="set-label">Content</span>
          <textarea ref={textareaRef} className="set-input" value={line.content} onChange={e => onChange({ content: e.target.value })} />
        </div>
      )}
    </div>
  );
}
