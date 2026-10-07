// ════════════════════════════════════════════════
// Modo de seleção múltipla de cópia — porta de MULTI_COPY_MODE em
// js/terminal-renderer.js (original). Duplo clique em QUALQUER botão de copiar
// entra no modo; daí, um clique simples em qualquer linha (do mesmo comando ou
// de outro) só marca/desmarca a linha para a cópia em lote. A barra flutuante
// (MultiCopyBar.tsx) copia tudo junto, uma linha por comando, na ordem em que
// aparecem na página. Sair: Escape, clicar fora ou Cancel/Copy na barra.
//
// O estado é um store mínimo de módulo (useSyncExternalStore) em vez de um
// contexto: os botões de copiar ficam em cards numerosos e lazy, e só o botão
// que muda precisa re-renderizar.
// ════════════════════════════════════════════════
import { useSyncExternalStore } from 'react';

export interface MultiCopyEntry {
  el: HTMLElement;
  text: string;
  cmdId?: number;
}

interface MultiCopyState {
  active: boolean;
  selected: Map<string, MultiCopyEntry>;
}

let state: MultiCopyState = { active: false, selected: new Map() };
const listeners = new Set<() => void>();

function emit(next: MultiCopyState) {
  state = next;
  listeners.forEach(l => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useMultiCopy(): MultiCopyState {
  return useSyncExternalStore(subscribe, () => state);
}

export function isMultiCopyActive(): boolean {
  return state.active;
}

export function toggleMultiCopy(key: string, entry: MultiCopyEntry) {
  const selected = new Map(state.selected);
  if (selected.has(key)) selected.delete(key);
  else selected.set(key, entry);
  emit({ active: state.active, selected });
}

// 2º clique de um duplo clique: entra no modo já marcando a linha clicada.
export function enterMultiCopy(key: string, entry: MultiCopyEntry) {
  const selected = new Map(state.selected);
  selected.set(key, entry);
  emit({ active: true, selected });
}

export function cancelMultiCopy() {
  if (!state.active && state.selected.size === 0) return;
  emit({ active: false, selected: new Map() });
}

// Entradas na ordem em que aparecem na página (ordem do DOM). Se algum botão
// já saiu do DOM (card virtualizado), cai na ordem em que foi marcado.
export function orderedSelection(): MultiCopyEntry[] {
  const list = Array.from(state.selected.values());
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (!a.e.el.isConnected || !b.e.el.isConnected) return a.i - b.i;
      const pos = a.e.el.compareDocumentPosition(b.e.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return a.i - b.i;
    })
    .map(x => x.e);
}

// IDs de comando únicos — várias linhas do MESMO comando contam como um só
// para exclusão (só existe DELETE por comando inteiro).
export function selectedCommandIds(): number[] {
  return [...new Set(Array.from(state.selected.values()).map(e => e.cmdId).filter((id): id is number => typeof id === 'number'))];
}
