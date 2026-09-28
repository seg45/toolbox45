// ════════════════════════════════════════════════
// CONFIGURAÇÕES DO USUÁRIO (persistidas em localStorage, chave 'cpa-
// settings') — porta de DEFAULT_SETTINGS/loadSettings/persistSettings em
// js/settings.js.
//
// Nesta fatia (App shell) as 5 seleções de filtro (vendor/sys/version/
// env/type) e os 4 toggles (Details/Export/Images/System commands) já
// são lidos/gravados de verdade aqui — os componentes de UI (sidebar e o
// espelho no modal de Preferences) ficam em sincronia um com o outro,
// exatamente como no original — mas ainda NÃO disparam nenhuma
// filtragem/render de comandos: isso é o motor de render.js/
// ccRefreshCascade(), que só existe a partir da fatia 3 (Comandos
// núcleo). `groupBy`/`home` (Home page) também são só persistidos por
// enquanto, pelo mesmo motivo.
// ════════════════════════════════════════════════
import { useCallback, useEffect, useState } from 'react';

const SETTINGS_KEY = 'cpa-settings';

export interface Settings {
  home: 'menu' | 'folders';
  vendor: string[];
  sys: string[];
  version: string[];
  env: string[];
  type: string[];
  showCardDetails: boolean;
  exportEnabled: boolean;
  showImages: boolean;
  showSidebar: boolean;
  groupBy: 'creator' | 'topic' | 'version';
  showSystemCommands: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  home: 'menu',
  vendor: [],
  sys: [],
  version: [],
  env: [],
  type: [],
  showCardDetails: false,
  exportEnabled: false,
  showImages: false,
  showSidebar: true,
  groupBy: 'topic',
  showSystemCommands: false,
};

// Aceita string única (formato antigo) ou array, e remove a sentinela
// 'all' (formato antigo de antes da remoção do item mestre "Todos" — ver
// js/state.js) de qualquer valor salvo por uma sessão anterior.
function normalizeMultiSetting(val: unknown, fallback: string[]): string[] {
  if (val === undefined || val === null) return fallback.slice();
  if (!Array.isArray(val)) return val ? [val as string] : [];
  return (val as string[]).filter(v => v !== 'all');
}

export function loadSettings(): Settings {
  let s: Settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) s = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* localStorage indisponível — segue com o default */
  }
  s.vendor = normalizeMultiSetting(s.vendor, DEFAULT_SETTINGS.vendor);
  s.sys = normalizeMultiSetting(s.sys, DEFAULT_SETTINGS.sys);
  s.version = normalizeMultiSetting(s.version, DEFAULT_SETTINGS.version);
  s.env = normalizeMultiSetting(s.env, DEFAULT_SETTINGS.env);
  s.type = normalizeMultiSetting(s.type, DEFAULT_SETTINGS.type);
  return s;
}

export function persistSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* best-effort, igual ao original */
  }
}

// Hook idiomático que substitui o padrão imperativo do original (ler/
// gravar localStorage a cada toggle + reaplicar manualmente em vários
// elementos do DOM): um único estado React, atualizado via `update`, que
// já persiste sozinho a cada mudança. Qualquer componente que precise
// ler OU escrever uma preferência (sidebar, modal de Preferences) usa
// este mesmo hook, o que os mantém em sincronia automaticamente (mesma
// garantia do ST/state.js original, só que sem precisar de nenhum código
// de "espelhamento" manual entre os dois lugares).
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      persistSettings(next);
      return next;
    });
  }, []);

  // Preferências gravadas em outra aba/janela (mesmo navegador) —
  // mantém esta aba em dia, mesmo padrão de tolerância a mudança externa
  // já usado noutros pontos do app.
  useEffect(() => {
    function onStorage(ev: StorageEvent) {
      if (ev.key === SETTINGS_KEY) setSettings(loadSettings());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return { settings, update };
}
