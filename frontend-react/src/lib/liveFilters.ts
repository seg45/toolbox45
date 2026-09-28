// ════════════════════════════════════════════════
// FILTROS AO VIVO da sidebar (Vendor/System/Version/Environment/Topic +
// busca) — porta de ST (js/state.js) + persistSidebarFilters()/
// resolveSidebarFilters() (chave 'cpa-sidebar-filters').
//
// IMPORTANTE (bug corrigido nesta fatia — ver instruções da tarefa): antes,
// Sidebar.tsx (fatia 2) ligava Vendor/System/Version/Environment/Topic
// direto em useSettings() (cpa-settings), como se fosse estado AO VIVO. No
// original, o espelho de Vendor/System/Version/Environment/Topic no modal de
// Preferências (settings.vendor/sys/version/env/type) é só o DEFAULT usado
// na PRIMEIRA visita deste navegador (quando 'cpa-sidebar-filters' ainda não
// existe no localStorage) — depois disso, o filtro AO VIVO persiste e
// sobrevive sozinho na própria chave, independente do que o default de
// Preferências diga (o usuário espera que o filtro sobreviva a um F5, igual
// qualquer outro estado — bug relatado no original: "ao atualizar a tela os
// filtros estão sendo limpos"). Este hook implementa essa mesma regra:
// cai no default de useSettings() só quando 'cpa-sidebar-filters' está
// vazio/ausente; qualquer mudança feita aqui grava na própria chave e nunca
// mais volta a consultar o default.
// ════════════════════════════════════════════════
import { useCallback, useEffect, useState } from 'react';
import type { Settings } from './settingsStore';

const SIDEBAR_FILTERS_KEY = 'cpa-sidebar-filters';

export interface LiveFilters {
  vendor: string[];
  system: string[];
  version: string[];
  environment: string[];
  topic: string[];
  search: string;
}

interface StoredFilters {
  vd?: unknown;
  sys?: unknown;
  v?: unknown;
  e?: unknown;
  t?: unknown;
  q?: unknown;
}

function readStored(): StoredFilters | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_FILTERS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function asArray(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) ? (v as string[]) : fallback;
}

function defaultsFromSettings(settings: Settings): Omit<LiveFilters, 'search'> {
  return {
    vendor: settings.vendor,
    system: settings.sys,
    version: settings.version,
    environment: settings.env,
    topic: settings.type,
  };
}

function resolveInitial(settings: Settings): LiveFilters {
  const defaults = defaultsFromSettings(settings);
  const saved = readStored();
  if (!saved) return { ...defaults, search: '' };
  return {
    vendor: asArray(saved.vd, defaults.vendor),
    system: asArray(saved.sys, defaults.system),
    version: asArray(saved.v, defaults.version),
    environment: asArray(saved.e, defaults.environment),
    topic: asArray(saved.t, defaults.topic),
    search: typeof saved.q === 'string' ? saved.q : '',
  };
}

function persist(f: LiveFilters): void {
  try {
    localStorage.setItem(
      SIDEBAR_FILTERS_KEY,
      JSON.stringify({ vd: f.vendor, sys: f.system, v: f.version, e: f.environment, t: f.topic, q: f.search })
    );
  } catch {
    /* best-effort, igual ao original */
  }
}

export function useLiveFilters(settings: Settings) {
  const [filters, setFilters] = useState<LiveFilters>(() => resolveInitial(settings));

  const update = useCallback((patch: Partial<LiveFilters>) => {
    setFilters(prev => {
      const next = { ...prev, ...patch };
      persist(next);
      return next;
    });
  }, []);

  // Filtros ao vivo gravados em outra aba/janela — mesmo padrão de
  // tolerância a mudança externa usado em settingsStore.ts/useSettings().
  useEffect(() => {
    function onStorage(ev: StorageEvent) {
      if (ev.key !== SIDEBAR_FILTERS_KEY) return;
      const saved = readStored();
      if (!saved) return;
      setFilters(prev => ({
        vendor: asArray(saved.vd, prev.vendor),
        system: asArray(saved.sys, prev.system),
        version: asArray(saved.v, prev.version),
        environment: asArray(saved.e, prev.environment),
        topic: asArray(saved.t, prev.topic),
        search: typeof saved.q === 'string' ? saved.q : prev.search,
      }));
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return { filters, update };
}
