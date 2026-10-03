// ════════════════════════════════════════════════
// HISTÓRICO DE BUSCA GENÉRICO (últimos 7 dias, ~200 itens, persistido em
// localStorage, agrupado por dia) — camada de dados reutilizável para os
// DOIS históricos quase idênticos do original: js/query-bar.js
// (queryHistory*, chave 'cpa-query-history:<user>', entradas "field:value
// field:value") e js/folders.js (cmdSearchHistory*, chave
// 'cpa-cmdsearch-history:<user>', entradas de texto livre).
//
// Desvio DELIBERADO do original (documentado, mesmo espírito das
// divergências já documentadas na fatia 3a): lá, os dois mecanismos são
// funções copy-pasted lado a lado (loadQueryHistoryRaw/loadCmdSearchHistoryRaw,
// saveQueryHistoryEntry/saveCmdSearchHistoryEntry, etc.) — mesmíssima janela
// de 7 dias, mesmo teto de 200 itens, mesmo agrupamento por dia
// Hoje/Ontem/dd-mm, mesma técnica de sufixar a chave com CURRENT_USER. Em
// vez de portar as duas cópias, este hook único (useSearchHistory) serve as
// duas UIs (QueryBar.tsx e a caixa de busca da sidebar), parametrizado só
// pelo prefixo de chave — a única coisa que de fato distingue os dois no
// original.
//
// CURRENT_USER (js/user-sync.js) -> aqui é `currentUser` (string do
// username, tipicamente `auth.me?.username`, ver AuthState em lib/auth.tsx),
// passado explicitamente por quem usa o hook (em vez do hook chamar
// useAuth() ele mesmo) para manter a peça de dados agnóstica do Context de
// autenticação. Enquanto currentUser ainda não foi resolvido (auth.loading
// === true), este hook se comporta exatamente como o original enquanto
// CURRENT_USER estava indefinido: load/save são no-ops (falha fechada,
// nunca um balde "anônimo" compartilhado entre usuários — pedido explícito
// do usuário original: "o histórico não pode aparecer para outros
// usuários").
// ════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface HistoryEntry {
  text: string;
  ts: number;
}

export interface HistoryDayGroup {
  key: string; // data local YYYY-MM-DD (chave estável de agrupamento/collapse)
  label: string; // 'Today' | 'Yesterday' | 'dd/mm'
  items: HistoryEntry[];
  collapsed: boolean;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 200;

function storageKey(prefix: string, user: string): string {
  return `${prefix}:${user}`;
}

function loadRaw(key: string | null): HistoryEntry[] {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveRaw(key: string | null, arr: HistoryEntry[]): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    /* best-effort, igual ao original */
  }
}

// Filtra pela janela de 7 dias + ordena do mais recente pro mais antigo —
// mesmo critério de loadQueryHistory()/loadCmdSearchHistory() no original.
function freshSorted(all: HistoryEntry[]): HistoryEntry[] {
  const now = Date.now();
  return all
    .filter(e => e && typeof e.text === 'string' && typeof e.ts === 'number' && now - e.ts < MAX_AGE_MS)
    .sort((a, b) => b.ts - a.ts);
}

// Data local (não UTC) — mesmo critério de queryHistoryDayKey/
// cmdSearchHistoryDayKey.
function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabelOf(ts: number): string {
  const startOfDay = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
}

// "Xmin ago" / "Xh ago" / "Xd ago" — mesmo formatQueryHistoryTime/
// formatCmdSearchHistoryTime do original.
export function formatHistoryTime(ts: number): string {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function useSearchHistory(storageKeyPrefix: string, currentUser: string | null | undefined) {
  const key = currentUser ? storageKey(storageKeyPrefix, currentUser) : null;
  const [entries, setEntries] = useState<HistoryEntry[]>(() => freshSorted(loadRaw(key)));
  // Estado de dias recolhidos — só em memória (dura enquanto a página está
  // aberta; reabrir o app volta tudo expandido), mesmo critério do
  // QUERY_HISTORY_COLLAPSED_DAYS/CMD_SEARCH_HISTORY_COLLAPSED_DAYS (Set
  // em memória de módulo) do original — aqui é estado do próprio hook, uma
  // instância por caixa de busca (query-bar e sidebar têm cada uma a sua).
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(() => new Set());
  const keyRef = useRef(key);
  keyRef.current = key;

  // currentUser pode passar de undefined/null para o username de verdade
  // depois que /api/me resolve (auth.loading true -> false) — quando isso
  // acontece, a chave muda e precisamos reler do localStorage sob a chave
  // certa (antes disso, load/save eram no-ops — ver comentário no topo).
  useEffect(() => {
    setEntries(freshSorted(loadRaw(key)));
  }, [key]);

  // Fatia 8 (user-data sync, ver lib/userDataSync.ts) — reage a um
  // StorageEvent (nativo, de outra aba, OU sintético, disparado por
  // initUserDataSync() depois de semear 'cpa-query-history:<user>'/
  // 'cpa-cmdsearch-history:<user>' vindos do servidor) relendo o histórico
  // sob a chave atual (via keyRef, sempre em dia — ver atribuição acima).
  // Registrado uma única vez (deps vazias): o listener em si não depende de
  // `key` mudar, só o confere no momento do evento.
  useEffect(() => {
    function onStorage(ev: StorageEvent) {
      if (keyRef.current && ev.key === keyRef.current) {
        setEntries(freshSorted(loadRaw(keyRef.current)));
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const persistAndSet = useCallback((arr: HistoryEntry[]) => {
    // fresh+re-persist entradas expiradas removidas — mesmo efeito colateral
    // de loadQueryHistory()/loadCmdSearchHistory() (limpa e regrava quando
    // encontra entradas velhas).
    const fresh = freshSorted(arr);
    saveRaw(keyRef.current, fresh);
    setEntries(fresh);
  }, []);

  const save = useCallback(
    (text: string) => {
      const t = (text || '').trim();
      if (!t || !keyRef.current) return;
      const now = Date.now();
      let all = loadRaw(keyRef.current).filter(e => e && e.text !== t && now - e.ts < MAX_AGE_MS);
      all.unshift({ text: t, ts: now });
      if (all.length > MAX_ITEMS) all = all.slice(0, MAX_ITEMS);
      persistAndSet(all);
    },
    [persistAndSet]
  );

  const remove = useCallback(
    (text: string) => {
      if (!keyRef.current) return;
      const all = loadRaw(keyRef.current).filter(e => e.text !== text);
      persistAndSet(all);
    },
    [persistAndSet]
  );

  const clear = useCallback(() => {
    if (!keyRef.current) return;
    persistAndSet([]);
  }, [persistAndSet]);

  const toggleDay = useCallback((dayKey: string) => {
    setCollapsedDays(prev => {
      const next = new Set(prev);
      if (next.has(dayKey)) next.delete(dayKey);
      else next.add(dayKey);
      return next;
    });
  }, []);

  const groupedByDay = useMemo<HistoryDayGroup[]>(() => {
    const groups: HistoryDayGroup[] = [];
    entries.forEach(e => {
      const dk = dayKeyOf(e.ts);
      const last = groups[groups.length - 1];
      if (last && last.key === dk) last.items.push(e);
      else groups.push({ key: dk, label: dayLabelOf(e.ts), items: [e], collapsed: collapsedDays.has(dk) });
    });
    return groups;
  }, [entries, collapsedDays]);

  return { entries, groupedByDay, save, remove, clear, toggleDay };
}
