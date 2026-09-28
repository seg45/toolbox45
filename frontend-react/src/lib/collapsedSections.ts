// ════════════════════════════════════════════════
// SEÇÕES RECOLHIDAS (chave 'cpa-collapsed-sections') — porta de
// COLLAPSED_SECTIONS/loadCollapsedSections()/persistCollapsedSections() +
// toggleSection()/collapseAllSections()/expandAllSections() em
// js/terminal-renderer.js.
//
// Idioma React: o original guarda um Set global + manipula classList do DOM
// direto; aqui é um único estado React (Set<string>), e cada seção decide
// sozinha (via isCollapsed(key)) se renderiza seus cards ou não — o que já
// dá a mesma economia de custo que collapsibleGroupLazy()/
// _lazySectionBuilders faziam manualmente no original (ver comentário em
// CollapsibleSection.tsx), sem precisar reimplementar aquela máquina de
// builders adiados.
// ════════════════════════════════════════════════
import { useCallback, useState } from 'react';

const COLLAPSED_SECTIONS_KEY = 'cpa-collapsed-sections';

function loadCollapsedSections(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    /* localStorage indisponível — segue com Set vazio */
  }
  return new Set();
}

function persist(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...set]));
  } catch {
    /* best-effort, igual ao original */
  }
}

export function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedSections());

  const isCollapsed = useCallback((key: string) => collapsed.has(key), [collapsed]);

  const toggle = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persist(next);
      return next;
    });
  }, []);

  // `keys`: todas as chaves de seção atualmente na tela (tópicos + ambiente
  // + agrupamentos de Created by/Versão) — equivalente a
  // document.querySelectorAll('#out .section') no original, já que aqui não
  // há DOM pra consultar; quem chama (CommandsContent.tsx) calcula essa
  // lista a partir da árvore que renderPipeline.ts acabou de produzir.
  const collapseAll = useCallback((keys: string[]) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      keys.forEach(k => next.add(k));
      persist(next);
      return next;
    });
  }, []);

  const expandAll = useCallback((keys: string[]) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      keys.forEach(k => next.delete(k));
      persist(next);
      return next;
    });
  }, []);

  return { isCollapsed, toggle, collapseAll, expandAll };
}
