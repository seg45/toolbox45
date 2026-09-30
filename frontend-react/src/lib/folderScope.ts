// ════════════════════════════════════════════════
// ESCOPO de pastas dentro da visão "Folders" (fatia 5b) — porta de
// FOLDER_SCOPE/setFolderScope()/folderScopeLabel()/folderScopeUsernames()
// (js/folders.js) + FOLDER_SCOPE_KEY/persistFolderScope()/
// resolveFolderScope() (js/settings.js). 'mine' (padrão) | 'all' |
// `user:${username}` — persistido em localStorage (MESMA chave
// 'cpa-folder-scope' do original) pra sobreviver a um F5: diferente de
// `folderEditRoots` (CommandsContent.tsx, esse sim só em memória de
// propósito), este é um FILTRO de verdade, e o usuário espera continuar
// vendo "All"/as pastas de um colega específico depois de atualizar a
// página — mesmo motivo já documentado em src/lib/foldersView.ts pra
// 'cpa-last-view'.
// ════════════════════════════════════════════════
import { useCallback, useState } from 'react';
import type { FolderWithOwner } from './folders';

export type FolderScope = 'mine' | 'all' | `user:${string}`;

const FOLDER_SCOPE_KEY = 'cpa-folder-scope';

function persistFolderScope(scope: FolderScope): void {
  try {
    localStorage.setItem(FOLDER_SCOPE_KEY, scope);
  } catch {
    /* best-effort, igual ao original */
  }
}

function resolveFolderScope(): FolderScope {
  try {
    const saved = localStorage.getItem(FOLDER_SCOPE_KEY);
    if (saved) return saved as FolderScope;
  } catch {
    /* localStorage indisponível — segue para o default */
  }
  return 'mine';
}

// Rótulo do botão fechado do dropdown (#folderScopeDDBtn .dd-label no
// original) — mesma função pura de folderScopeLabel() em js/folders.js.
export function folderScopeLabel(scope: FolderScope): string {
  if (scope === 'all') return 'All';
  if (scope.startsWith('user:')) return scope.slice('user:'.length);
  return 'My folders';
}

// Lista de usuários pra escolher no dropdown = todo `username` distinto em
// `allUsersFolders` (GET /api/folders/all), exceto o usuário atual — "My
// folders" já cobre esse caso, não faz sentido duplicar na lista de "outro
// usuário" (mesmo critério de folderScopeUsernames() no original).
export function folderScopeUsernames(allUsersFolders: FolderWithOwner[], currentUsername: string | undefined): string[] {
  const usernames = [...new Set(allUsersFolders.map(f => f.username))].filter(u => u !== currentUsername);
  return usernames.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function useFolderScope() {
  const [scope, setScopeState] = useState<FolderScope>(() => resolveFolderScope());

  const setScope = useCallback((next: FolderScope) => {
    setScopeState(next);
    persistFolderScope(next);
  }, []);

  return { scope, setScope };
}
