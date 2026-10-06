// ════════════════════════════════════════════════
// VISÃO "Folders" (VIEW_FOLDERS_HOME) — toggle da linha "Folders" da
// sidebar — porta de VIEW_FOLDERS_HOME/viewAllFolders()/resolveFoldersHome()/
// persistLastView() em js/folders.js + js/settings.js. Mesma prioridade do
// original: a ÚLTIMA visão explicitamente escolhida nesta aba/navegador
// ('cpa-last-view', gravada só por um clique deliberado na linha "Folders")
// vence sobre a preferência "Home page" (settings.home) — só cai no default
// de Preferences na primeira visita deste navegador (localStorage ainda
// vazio). Isso resolve o mesmo bug documentado no original: "estou em
// folders e quando atualizo a página está voltando para tela de comandos".
//
// goHome() (clique no logo/nome do app, js/folders.js) fica FORA do escopo
// desta fatia — Header.tsx já documenta que esse clique é no-op por
// enquanto; só o toggle da linha "Folders" da sidebar é ligado aqui.
// ════════════════════════════════════════════════
import { useCallback, useState } from 'react';
import type { Settings } from './settingsStore';

const LAST_VIEW_KEY = 'cpa-last-view';

function persistLastView(isFolders: boolean): void {
  try {
    localStorage.setItem(LAST_VIEW_KEY, isFolders ? 'folders' : 'menu');
  } catch {
    /* best-effort, igual ao original */
  }
}

function resolveFoldersHome(settings: Settings): boolean {
  try {
    const saved = localStorage.getItem(LAST_VIEW_KEY);
    if (saved === 'folders') return true;
    if (saved === 'menu') return false;
  } catch {
    /* localStorage indisponível — segue para o default de Preferences */
  }
  return settings.home === 'folders';
}

export function useFoldersView(settings: Settings) {
  const [active, setActive] = useState<boolean>(() => resolveFoldersHome(settings));

  // Clique na linha "Folders" da sidebar — funciona como um TOGGLE: clicar
  // de novo enquanto já está ativo desliga a visão e volta pro menu normal,
  // em vez de ficar preso em Folders sem um jeito óbvio de sair (mesmo
  // comportamento de viewAllFolders() no original).
  const toggle = useCallback(() => {
    setActive(prev => {
      const next = !prev;
      persistLastView(next);
      return next;
    });
  }, []);

  // Escolha explícita da visão (ex.: salvar "Home page" nas preferências —
  // persistLastView() no original, ver saveSettingsModal() em
  // js/settings-modal.js: salvar a preferência é uma ação tão deliberada
  // quanto clicar em "Folders", então também atualiza a visão memorizada).
  const setView = useCallback((isFolders: boolean) => {
    persistLastView(isFolders);
    setActive(isFolders);
  }, []);

  return { active, toggle, setView };
}
