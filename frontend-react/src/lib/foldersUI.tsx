// ════════════════════════════════════════════════
// Contexto compartilhado do dropdown "Add to folder" de cada card
// (.fav-wrap/.folder-menu-pop, ver src/components/commands/FolderMenu.tsx)
// — evita passar `folders`/callbacks de membership por prop através de
// CommandCard/CollapsibleSection/FolderSection/etc., que não têm nada a ver
// com Pastas. Mesmo espírito de useConfirm.tsx/useFolderPrompt.tsx
// (Context + hook); a diferença é que o "estado" de verdade (lista de
// pastas, criação/toggle otimistas) mora em CommandsContent.tsx, que já é o
// orquestrador de commands/folders desta tela — este arquivo só declara o
// contrato do Context e o hook de acesso.
//
// `openCommandId` (id do comando cujo dropdown de pastas está aberto, ou
// null) substitui o querySelectorAll('.folder-menu-pop.open') do original
// (fechar os outros ao abrir um novo) por um único estado React: só um
// dropdown pode estar aberto por vez em toda a árvore, esteja o card na
// visão normal (Tópico/Versão/Created by) ou dentro de uma seção de pasta.
// ════════════════════════════════════════════════
import { createContext, useContext } from 'react';
import type { Folder } from './folders';

export interface FoldersUIState {
  folders: Folder[] | null;
  openCommandId: number | null;
  setOpenCommandId: (id: number | null) => void;
  toggleCommandFolder: (commandId: number, folderId: number) => void;
  createRootFolder: (commandId: number) => Promise<void>;
}

export const FoldersUIContext = createContext<FoldersUIState | null>(null);

export function useFoldersUI(): FoldersUIState {
  const ctx = useContext(FoldersUIContext);
  if (!ctx) throw new Error('useFoldersUI() precisa estar dentro do Provider montado em CommandsContent.tsx');
  return ctx;
}
