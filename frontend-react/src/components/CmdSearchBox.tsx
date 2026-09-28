// ════════════════════════════════════════════════
// CAIXA DE BUSCA DA SIDEBAR ("Search") + seu próprio histórico de 7 dias —
// porta de onSearchInput()/clearCommandSearch()/updateSearchClearBtn() +
// os cmdSearchHistory*()/openCmdSearchHistoryPanel()/
// closeCmdSearchHistoryPanel() de js/folders.js (~linhas 1559-1745).
//
// Histórico INDEPENDENTE do da barra de parâmetros (QueryBar.tsx) — chave
// própria no localStorage ('cpa-cmdsearch-history:<user>'), mas mesma
// camada de dados genérica (useSearchHistory, ver lib/searchHistory.ts).
// Diferença de comportamento em relação ao da QueryBar (documentada no
// original, preservada aqui): aqui é um ÚNICO texto livre (sem tags), então
// (1) salva no histórico só ao sair do campo (blur) ou ao limpar — nunca a
// cada tecla — e (2) clicar numa entrada do histórico SUBSTITUI o texto de
// busca inteiro, nunca mescla campo a campo.
//
// Debounce de 120ms antes de commitar a busca pra cima (liveFilters, que
// alimenta buildRenderTree em CommandsContent.tsx) — mesmo padrão de
// onSearchInput() (120ms) já usado pela QueryBar; a fatia 3a ainda não
// tinha esse debounce (não fazia falta sem o histórico atrelado a ele) —
// ver comentário na tarefa desta fatia.
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { formatHistoryTime, useSearchHistory } from '../lib/searchHistory';

const SEARCH_DEBOUNCE_MS = 120;

export function CmdSearchBox({ search, onSearchChange }: { search: string; onSearchChange: (next: string) => void }) {
  const auth = useAuth();
  const history = useSearchHistory('cpa-cmdsearch-history', auth.me?.username);

  // Texto exibido no <input> — pode divergir momentaneamente de `search`
  // (a busca já COMMITADA em liveFilters) por causa do debounce; também
  // resincroniza quando `search` muda por fora (outra aba, via o listener
  // 'storage' de useLiveFilters).
  const [text, setText] = useState(search);
  const textRef = useRef(search);
  const [panelOpen, setPanelOpen] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const onSearchChangeRef = useRef(onSearchChange);
  onSearchChangeRef.current = onSearchChange;

  useEffect(() => {
    setText(search);
    textRef.current = search;
  }, [search]);

  useEffect(
    () => () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    []
  );

  function commit(next: string, immediate = false) {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (immediate) {
      onSearchChangeRef.current(next);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      onSearchChangeRef.current(next);
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleChange(v: string) {
    setText(v);
    textRef.current = v;
    commit(v);
  }

  function handleFocus() {
    setPanelOpen(true);
  }
  function handleBlur() {
    setPanelOpen(false);
    history.save(textRef.current);
  }

  useEffect(() => {
    if (!panelOpen) return;
    function onDocClick(ev: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) {
        setPanelOpen(false);
        history.save(textRef.current);
      }
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [panelOpen, history]);

  function handleClear() {
    history.save(textRef.current); // preserva o texto atual no histórico antes de limpar
    setText('');
    textRef.current = '';
    commit('', true);
    inputRef.current?.focus();
  }

  // Clicar numa entrada do histórico SUBSTITUI a busca inteira e aplica na
  // hora (sem esperar o debounce) — porta de applyCmdSearchHistoryEntry().
  function applyHistoryEntry(t: string) {
    setText(t);
    textRef.current = t;
    commit(t, true);
    inputRef.current?.focus();
  }

  return (
    <div className="cmd-search-wrap" ref={wrapRef}>
      <span className="cmd-search-icon" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="text"
        className="cmd-search"
        placeholder="Search"
        autoComplete="off"
        value={text}
        onChange={ev => handleChange(ev.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
      {text && (
        <button type="button" className="cmd-search-clear" title="Clear search" onClick={handleClear}>
          ✕
        </button>
      )}
      {panelOpen && (
        <div className="cpq-panel open">
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
                  <div className="cpq-history-day-head" onMouseDown={ev => ev.preventDefault()} onClick={() => history.toggleDay(g.key)}>
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
      )}
    </div>
  );
}
