// ════════════════════════════════════════════════
// BARRA DE QUERY UNIFICADA (fatia 3b) — substitui o stopgap
// SimpleQueryFields.tsx (fatia 3a) pela UX real: um único campo de texto
// "campo:valor" que vira tags confirmáveis/editáveis no Enter, painel
// "Adicionar filtro" (8 chips fixos + "Others:" com typeahead) e histórico
// de 7 dias — porta de js/query-bar.js (605 linhas) + o pedaço de
// js/catalogs.js que monta os chips (ccBuildQueryChipsFixedRow/
// ccBuildQueryChips). A lógica pura (parse/tags/insertFieldToken/typeahead)
// mora em lib/queryBar.ts; o histórico genérico (compartilhado com a caixa
// de busca da sidebar) mora em lib/searchHistory.ts — este componente só
// orquestra estado local (tags/liveText/painéis) + os efeitos de foco/blur
// que no original vinham de verdade do DOM (aqui replicados via refs, já
// que não existe innerHTML/classList pra manipular).
//
// Contrato com CommandsContent.tsx (rio abaixo, sem NENHUMA mudança):
// `onChange` recebe o MESMO shape que SimpleQueryFields produzia
// (Record<string,string> com uma chave por parâmetro do catálogo) — só que
// agora computado inteiro a cada mudança (tags+texto->parse->objeto), nunca
// campo a campo, e debounced em 120ms (mesmo debounce do render() original)
// exceto ao limpar tudo (clearQuery), que aplica na hora.
//
// Desvio deliberado do original: CURRENT_USER (js/user-sync.js) aqui vem de
// useAuth() chamado diretamente neste componente (Context React já
// disponível em qualquer lugar da árvore, ver AuthProvider em
// pages/main-index.tsx) em vez de ser passado a mão através de
// AppShell->CommandsContent->QueryBar — mais simples, sem perder a mesma
// garantia "falha fechada" (useSearchHistory trata currentUser ausente
// exatamente como o original tratava CURRENT_USER indefinido: load/save
// viram no-op).
// ════════════════════════════════════════════════
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Catalogs } from '../../lib/catalogs';
import { useAuth } from '../../lib/auth';
import { formatHistoryTime, useSearchHistory } from '../../lib/searchHistory';
import {
  CPQ_FIXED_PARAM_ORDER,
  buildQueryAliasMap,
  computeFieldValues,
  confirmTagsFromText,
  currentTypedFieldFragment,
  getComposedQuery,
  insertFieldTokenValue,
  sortParametersAlphabetically,
} from '../../lib/queryBar';

const RENDER_DEBOUNCE_MS = 120;

export function QueryBar({
  onChange,
  catalogs,
}: {
  onChange: (next: Record<string, string>) => void;
  catalogs: Catalogs | null;
}) {
  const auth = useAuth();
  const catalogParams = useMemo(() => catalogs?.parameters || [], [catalogs]);
  const history = useSearchHistory('cpa-query-history', auth.me?.username);

  // ── Estado: tags confirmadas + o que está sendo digitado agora ──
  // Refs espelhando o estado mais recente — necessário porque vários
  // handlers (paste com setTimeout(0), o listener de clique fora do
  // document) precisam do valor ATUAL, não do valor capturado no closure da
  // renderização em que foram criados.
  const [tags, setTagsState] = useState<string[]>([]);
  const tagsRef = useRef<string[]>([]);
  const setTags = useCallback((next: string[]) => {
    tagsRef.current = next;
    setTagsState(next);
  }, []);

  const [liveText, setLiveTextState] = useState('');
  const liveTextRef = useRef('');
  const setLiveText = useCallback((v: string) => {
    liveTextRef.current = v;
    setLiveTextState(v);
  }, []);

  const [panelOpen, setPanelOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const othersAutoOpenedRef = useRef(false);

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const editCancelledRef = useRef(false);
  const editInputRef = useRef<HTMLInputElement>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pendingCursorToEndRef = useRef(false);

  const debounceRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(
    () => () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    []
  );

  // Porta de applyQueryToHiddenInputs()+render() — o parse em si (barato) é
  // sempre síncrono; só o disparo de onChange (equivalente ao render()
  // caro, que reconstrói toda a árvore de comandos em CommandsContent) é
  // debounced em 120ms, exceto quando `immediate` (só clearQuery()).
  const scheduleValuesUpdate = useCallback(
    (nextTags: string[], nextLiveText: string, immediate = false) => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      const values = computeFieldValues(nextTags, nextLiveText, catalogParams);
      if (immediate) {
        onChangeRef.current(values);
        return;
      }
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        onChangeRef.current(values);
      }, RENDER_DEBOUNCE_MS);
    },
    [catalogParams]
  );

  const saveHistory = useCallback(() => {
    history.save(getComposedQuery(tagsRef.current, liveTextRef.current));
  }, [history]);

  // ── Painel "Adicionar filtro": abre no focus, fecha no blur (salva
  // histórico) — mesma mecânica de onfocus="openQueryPanel()"/
  // onblur="closeQueryPanel()" no <input id="cpQuery">. ──
  const handleFocus = useCallback(() => setPanelOpen(true), []);
  const handleBlur = useCallback(() => {
    setPanelOpen(false);
    setOthersOpen(false);
    saveHistory();
  }, [saveHistory]);

  // Fallback de robustez — mesmo listener document-level do original
  // (`document.addEventListener('click', ev => { if (!ev.target.closest('.cpq-bar')) closeQueryPanel(); })`),
  // cobrindo cliques que por algum motivo não disparam blur no input.
  useEffect(() => {
    if (!panelOpen) return;
    function onDocClick(ev: MouseEvent) {
      if (barRef.current && !barRef.current.contains(ev.target as Node)) {
        setPanelOpen(false);
        setOthersOpen(false);
        saveHistory();
      }
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [panelOpen, saveHistory]);

  // ── Typeahead do painel "Others" — abre automaticamente enquanto o
  // usuário digita um fragmento de nome de campo (sem ':' ainda), fecha de
  // novo quando o campo esvazia, mas só se foi ESTE efeito quem abriu (não
  // fecha um "Others" que o usuário tenha aberto manualmente) — porta de
  // applyQueryChipsFilter(). Roda de novo quando o painel reabre (mesmo
  // openQueryPanel() chamando applyQueryChipsFilter() ao reabrir). ──
  const typedFragment = currentTypedFieldFragment(liveText);
  useEffect(() => {
    if (!panelOpen) return;
    if (typedFragment) {
      setOthersOpen(prev => {
        if (!prev) {
          othersAutoOpenedRef.current = true;
          return true;
        }
        return prev;
      });
    } else if (othersAutoOpenedRef.current) {
      othersAutoOpenedRef.current = false;
      setOthersOpen(false);
    }
  }, [typedFragment, panelOpen]);

  // Cursor no fim do campo depois de inserir "campo:" via clique num chip —
  // roda uma vez após o render que atualizou liveText por essa via (o flag
  // evita reposicionar o cursor em toda tecla digitada normal, o que
  // quebraria edição no meio do texto).
  useLayoutEffect(() => {
    if (pendingCursorToEndRef.current) {
      pendingCursorToEndRef.current = false;
      const el = inputRef.current;
      if (el) {
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      }
    }
  });

  // Foco + seleção do texto ao começar a editar uma tag — porta do trecho
  // final de startEditQueryTag() (input.focus(); input.select();).
  useEffect(() => {
    if (editingIndex !== null && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingIndex]);

  // ── Digitação no campo livre ──
  function handleInputChange(v: string) {
    setLiveText(v);
    // Bug corrigido no original ("clicava na linha... precisava clicar fora
    // e clicar de novo"): toda tecla digitada garante o painel aberto.
    setPanelOpen(true);
    scheduleValuesUpdate(tagsRef.current, v);
  }

  function handleInputKeyDown(ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const val = liveTextRef.current.trim();
      if (val) {
        const next = confirmTagsFromText(tagsRef.current, val);
        setTags(next);
        setLiveText('');
        scheduleValuesUpdate(next, '');
      }
    } else if (ev.key === 'Backspace' && !liveTextRef.current && tagsRef.current.length) {
      const next = tagsRef.current.slice(0, -1);
      setTags(next);
      scheduleValuesUpdate(next, liveTextRef.current);
    }
  }

  // Colar uma linha com vários "campo:valor" de uma vez confirma cada um
  // como tag separada na hora — porta do listener 'paste' + setTimeout(0)
  // (o texto colado só existe no <input> DEPOIS do evento 'paste' original;
  // lemos direto do DOM via ref pelo mesmo motivo do original). Um "paste"
  // de um único valor reconhecido continua caindo no fluxo normal (fica no
  // campo até o Enter).
  function handlePaste() {
    window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      const val = el.value || '';
      const tokens = val.trim().split(/\s+/).filter(Boolean);
      const aliasMap = buildQueryAliasMap(catalogParams);
      const recognized = tokens.filter(t => aliasMap[(t.split(':')[0] || '').toLowerCase()]);
      if (tokens.length > 1 && recognized.length > 1) {
        const next = confirmTagsFromText(tagsRef.current, val);
        setTags(next);
        setLiveText('');
        scheduleValuesUpdate(next, '');
      }
    }, 0);
  }

  // ── Tags: remover / editar ──
  function removeTagAt(idx: number) {
    saveHistory(); // linha completa como estava ANTES de remover
    const next = tagsRef.current.filter((_, i) => i !== idx);
    setTags(next);
    if (editingIndex === idx) setEditingIndex(null);
    scheduleValuesUpdate(next, liveTextRef.current);
    inputRef.current?.focus();
  }

  function startEdit(idx: number) {
    editCancelledRef.current = false;
    setEditingIndex(idx);
  }

  function handleEditKeyDown(ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      (ev.target as HTMLInputElement).blur();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      editCancelledRef.current = true;
      (ev.target as HTMLInputElement).blur();
    }
  }

  function handleEditBlur(idx: number) {
    const cancelled = editCancelledRef.current;
    editCancelledRef.current = false;
    const rawValue = editInputRef.current?.value ?? '';
    setEditingIndex(null);
    if (cancelled) return;
    const oldValue = tagsRef.current[idx];
    const newValue = rawValue.trim();
    if (!newValue) {
      removeTagAt(idx); // campo apagado por completo: mesmo comportamento do X
      return;
    }
    if (newValue === oldValue) return; // sem mudança de verdade: não polui o histórico
    // Salva a linha completa (com o valor ANTIGO ainda em tags[idx]) ANTES
    // de aplicar a mudança — pedido do usuário replicado do original.
    saveHistory();
    const next = tagsRef.current.slice();
    next[idx] = newValue;
    setTags(next);
    scheduleValuesUpdate(next, liveTextRef.current);
  }

  // ── Limpar tudo — única ação que aplica na hora, sem esperar o debounce ──
  function handleClear() {
    saveHistory();
    setTags([]);
    setLiveText('');
    scheduleValuesUpdate([], '', true);
    inputRef.current?.focus();
  }

  // ── Chip clicado: insere "campo:" no texto, fecha os painéis, mantém o
  // foco (o próprio chip previne blur via onMouseDown) ──
  function insertFieldToken(token: string) {
    const next = insertFieldTokenValue(liveTextRef.current, token);
    setLiveText(next);
    scheduleValuesUpdate(tagsRef.current, next);
    pendingCursorToEndRef.current = true;
    setPanelOpen(false);
    setOthersOpen(false);
  }

  // ── Histórico: aplicar uma entrada MERGEIA seus campos na busca atual
  // (nunca duplica um campo — mesmo critério de confirmTagsFromText) ──
  function applyHistoryEntry(text: string) {
    const next = confirmTagsFromText(tagsRef.current, text);
    setTags(next);
    scheduleValuesUpdate(next, liveTextRef.current);
    inputRef.current?.focus();
  }

  const fixedParams = useMemo(() => {
    const byKey = new Map(catalogParams.map(p => [p.key, p]));
    return CPQ_FIXED_PARAM_ORDER.map(k => byKey.get(k)).filter((p): p is NonNullable<typeof p> => !!p);
  }, [catalogParams]);

  const sortedOthers = useMemo(() => sortParametersAlphabetically(catalogParams), [catalogParams]);
  const othersVisible = useMemo(
    () =>
      sortedOthers.filter(
        p => !typedFragment || p.key.toLowerCase().includes(typedFragment) || (p.label || '').toLowerCase().includes(typedFragment)
      ),
    [sortedOthers, typedFragment]
  );

  const showClear = tags.length > 0 || liveText.length > 0;

  return (
    <div className="inp-bar">
      <div className="cpq-bar" ref={barRef}>
        <div className="cpq-input-wrap">
          <span className="cpq-icon" aria-hidden="true" title="Parameters used in the commands below">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path
                d="M20.6 13.4L13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <circle cx="7" cy="7" r="1.3" fill="currentColor" />
            </svg>
          </span>
          <div className="cpq-tags-box" onClick={() => inputRef.current?.focus()}>
            <span className="cpq-tags">
              {tags.map((t, i) => (
                <span className="cpq-tag" key={i}>
                  {editingIndex === i ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      className="cpq-tag-edit-input"
                      defaultValue={t}
                      size={Math.max(t.length, 4)}
                      onKeyDown={handleEditKeyDown}
                      onBlur={() => handleEditBlur(i)}
                    />
                  ) : (
                    <span
                      className="cpq-tag-txt"
                      title="Click to edit"
                      onMouseDown={ev => ev.preventDefault()}
                      onClick={ev => {
                        ev.stopPropagation();
                        startEdit(i);
                      }}
                    >
                      {t}
                    </span>
                  )}
                  <button
                    type="button"
                    className="cpq-tag-x"
                    onMouseDown={ev => ev.preventDefault()}
                    onClick={ev => {
                      ev.stopPropagation();
                      removeTagAt(i);
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </span>
            <input
              ref={inputRef}
              type="text"
              className="cpq-input"
              placeholder="Parameter"
              autoComplete="off"
              value={liveText}
              onChange={ev => handleInputChange(ev.target.value)}
              onKeyDown={handleInputKeyDown}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onPaste={handlePaste}
            />
          </div>
          {showClear && (
            <button type="button" className="cpq-clear" onClick={handleClear} title="Clear filters">
              ✕
            </button>
          )}
        </div>

        {panelOpen && (
          <div className="cpq-panel open">
            <div className="cpq-panel-label cpq-history-label">Command parameters:</div>
            <div className="cpq-chips">
              {fixedParams.map(p => (
                <button
                  key={p.key}
                  type="button"
                  className="cpq-chip-flat"
                  data-field={p.key}
                  title={p.label || p.key}
                  onMouseDown={ev => ev.preventDefault()}
                  onClick={() => insertFieldToken(p.key)}
                >
                  {(p.label || p.key) + ':'}
                </button>
              ))}
              <button
                type="button"
                className="cpq-chip-flat cpq-chip-others"
                title="Show all registered parameters"
                onMouseDown={ev => ev.preventDefault()}
                onClick={ev => {
                  ev.stopPropagation();
                  setOthersOpen(o => !o);
                }}
              >
                Others:
              </button>
            </div>
            {othersOpen && (
              <div className="cpq-chips-others open">
                {othersVisible.map(p => (
                  <button
                    key={p.key}
                    type="button"
                    className="cpq-chip"
                    data-field={p.key}
                    title={p.label || p.key}
                    onMouseDown={ev => ev.preventDefault()}
                    onClick={() => insertFieldToken(p.key)}
                  >
                    {p.label || p.key}
                  </button>
                ))}
              </div>
            )}
            {typedFragment && othersVisible.length === 0 && <div className="cpq-empty-note">No parameters match your search.</div>}
            <div className="cpq-panel-divider" />
            <div className="cpq-history-section">
              <div className="cpq-history-head">
                <span className="cpq-panel-label cpq-history-label" style={{ marginBottom: 0 }}>
                  History (last 7 days)
                </span>
                {history.entries.length > 0 && (
                  <button
                    type="button"
                    className="cpq-history-clear"
                    onMouseDown={ev => ev.preventDefault()}
                    onClick={() => history.clear()}
                  >
                    Clear history
                  </button>
                )}
              </div>
              <div className="cpq-history-list">
                {history.entries.length === 0 ? (
                  <div className="cpq-history-empty">No recent searches.</div>
                ) : (
                  history.groupedByDay.map(g => (
                    <div className={`cpq-history-day${g.collapsed ? ' collapsed' : ''}`} data-day-key={g.key} key={g.key}>
                      <div
                        className="cpq-history-day-head"
                        onMouseDown={ev => ev.preventDefault()}
                        onClick={() => history.toggleDay(g.key)}
                      >
                        <svg className="cpq-history-day-chevron" width="8" height="8" viewBox="0 0 10 10" fill="none">
                          <path d="M1 2l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>{g.label}</span>
                        <span className="cpq-history-day-count">{g.items.length}</span>
                      </div>
                      <div className="cpq-history-day-body">
                        {g.items.map(e => (
                          <div
                            className="cpq-history-item"
                            key={e.text + e.ts}
                            onMouseDown={ev => ev.preventDefault()}
                            onClick={() => applyHistoryEntry(e.text)}
                          >
                            <span className="cpq-history-item-txt" title={e.text}>
                              {e.text}
                            </span>
                            <span className="cpq-history-item-time">{formatHistoryTime(e.ts)}</span>
                            <button
                              type="button"
                              className="cpq-history-item-x"
                              title="Remove from history"
                              onMouseDown={ev => ev.preventDefault()}
                              onClick={ev => {
                                ev.stopPropagation();
                                history.remove(e.text);
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
