// ════════════════════════════════════════════════
// PASTAS — pipeline de dados da visão "Folders" (escopo "My folders", único
// suportado nesta fatia — cross-user/#folderScopeDD fica pra uma fatia
// futura) — porta de buildFolderItemsCards()/buildFolderSectionFromCards()/
// buildFolderSection() (js/db-render-engine.js) + o ramo
// VIEW_FOLDERS_HOME/scope==='mine' de render() (js/render.js).
//
// Função PURA, PARALELA a buildRenderTree() (renderPipeline.ts) — mesmo
// espírito (recebe comandos+valores já resolvidos, devolve uma ÁRVORE DE
// DADOS que os componentes percorrem para montar o JSX), mas com sua
// PRÓPRIA forma de resultado (FolderSectionNode), já que a visão de Pastas
// não usa ComboBlockData/SectionData (Tópico/Versão/Created by) — ela
// ignora "Group by" por completo. Isso replica o comentário de render.js:
// "Sempre retorna aqui (nunca cai nos ramos de GROUP_BY abaixo) enquanto
// VIEW_FOLDERS_HOME estiver ativo" — CommandsContent.tsx nunca chama
// buildRenderTree() enquanto a visão de Pastas está ativa; chama esta
// função em vez disso.
//
// Escopo desta fatia (5a): SEM notas (entradas `order` do tipo 'note' são
// descartadas — ver comentário em src/lib/folders.ts) e SEM drag-and-drop —
// a ORDEM vem só de folder.order + o fallback de itens sem posição salva
// (sempre no fim), nunca é reordenada aqui.
// ════════════════════════════════════════════════
import type { Catalogs, ParameterEntry } from './catalogs';
import type { Values } from './commandTemplate';
import type { Command } from './commands';
import { buildFolderTree, type Folder } from './folders';
import { buildCardDataForRow, type CardData } from './renderPipeline';
import { stripVarMarkers } from './syntaxHighlight';

export interface FolderSectionNode {
  folderId: number;
  name: string;
  depth: number;
  rootFolderId: number;
  isFavorites: boolean;
  cardCount: number; // só comandos desta pasta (não conta subpastas) — mesmo critério do original
  items: FolderItemNode[];
}

export type FolderItemNode = { type: 'command'; card: CardData } | { type: 'folder'; section: FolderSectionNode };

export function buildFolderSectionTree(params: {
  commands: Command[];
  folders: Folder[];
  values: Values;
  hasIPs: boolean;
  catalogParams: ParameterEntry[];
}): FolderSectionNode[] {
  const { commands, folders, values, hasIPs, catalogParams } = params;
  const tree = buildFolderTree(folders);

  // Mesma otimização de buildSections() (renderPipeline.ts)/render.js:
  // agrupa `commands` por pasta UMA VEZ (Map<folderId, Command[]>) em vez de
  // escanear o array inteiro de novo a cada pasta do usuário — um comando
  // pode estar em mais de uma pasta (folder_ids), então entra na lista de
  // cada uma.
  const commandsByFolder = new Map<number, Command[]>();
  commands.forEach(c => {
    (c.folder_ids || []).forEach(fid => {
      let arr = commandsByFolder.get(fid);
      if (!arr) {
        arr = [];
        commandsByFolder.set(fid, arr);
      }
      arr.push(c);
    });
  });

  function buildNode(folder: Folder, depth: number, rootFolderId: number): FolderSectionNode {
    // Recursão nas subpastas DIRETAS primeiro (mesma ordem de
    // renderFolderNode em render.js) — cada uma vira, ela mesma, um
    // FolderSectionNode aninhado, intercalado na posição certa dentro do
    // corpo desta pasta via folder.order (ver abaixo).
    const childFolders = tree.childrenOf(folder.id);
    const childNodes = new Map<number, FolderSectionNode>();
    childFolders.forEach(child => childNodes.set(child.id, buildNode(child, depth + 1, rootFolderId)));

    const rows = commandsByFolder.get(folder.id) || [];
    const cmdById = new Map(rows.map(r => [r.id, r]));

    // Intercala comandos + subpastas na posição salva em folder.order (porta
    // de buildFolderItemsCards) — itens sem posição salva (comando/subpasta
    // nova, ou pasta antiga de antes desta feature) vão pro FIM, nunca
    // desaparecem. Entradas {type:'note',...} são descartadas por completo
    // (fora do escopo desta fatia — ver comentário no topo do arquivo).
    const seenCmd = new Set<number>();
    const seenFolder = new Set<number>();
    folder.order.forEach(o => {
      if (o.type === 'command') seenCmd.add(o.id);
      else if (o.type === 'folder') seenFolder.add(o.id);
    });
    const extra: { type: 'command' | 'folder'; id: number }[] = [
      ...[...cmdById.keys()].filter(id => !seenCmd.has(id)).map(id => ({ type: 'command' as const, id })),
      ...[...childNodes.keys()].filter(id => !seenFolder.has(id)).map(id => ({ type: 'folder' as const, id })),
    ];
    const finalOrder: { type: 'command' | 'folder'; id: number }[] = folder.order
      .filter((o): o is { type: 'command' | 'folder'; id: number } =>
        o.type === 'folder' ? childNodes.has(o.id) : o.type === 'command' ? cmdById.has(o.id) : false
      )
      .concat(extra);

    const items: FolderItemNode[] = [];
    finalOrder.forEach(o => {
      if (o.type === 'folder') {
        const section = childNodes.get(o.id);
        if (section) items.push({ type: 'folder', section });
        return;
      }
      const row = cmdById.get(o.id);
      if (!row) return;
      // buildCardDataForRow pode devolver null (comando exige IP+porta e não
      // tem variante "empty" com conteúdo) — mesmo filtro .filter(Boolean)
      // do original em buildFolderItemsCards.
      const card = buildCardDataForRow(row, values, hasIPs, catalogParams);
      if (card) items.push({ type: 'command', card });
    });

    return {
      folderId: folder.id,
      name: folder.name,
      depth,
      rootFolderId,
      isFavorites: folder.name === 'Favorites',
      cardCount: items.filter(it => it.type === 'command').length,
      items,
    };
  }

  return tree.roots.map(folder => buildNode(folder, 0, folder.id));
}

// ── Filtro de busca (mesmo espírito de applySearchFilterToBlocks em
// renderPipeline.ts — ver o comentário lá sobre a diferença deliberada do
// original, que escondia .card individuais via DOM). Aqui: filtra os CARDS
// recursivamente, preservando a seção da pasta (e de qualquer subpasta,
// mesmo que fique vazia por causa do filtro) — diferença deliberada
// adicional desta fatia: o original nunca escondia a SEÇÃO de uma pasta por
// causa da busca, só os cards individuais dentro dela; manter a hierarquia
// de pastas visível mesmo com 0 resultados evita "sumiço" confuso da árvore
// inteira. `cardCount` de cada nó é recalculado após o filtro. ──
function cardMatchesQuery(card: CardData, query: string): boolean {
  const parts: string[] = [card.name, card.desc, card.detailsHtml.replace(/<[^>]*>/g, ' ')];
  card.lines.forEach(l => {
    if ('p' in l) {
      parts.push(l.p || '');
      parts.push(stripVarMarkers(l.c));
    } else {
      parts.push(stripVarMarkers(l.c));
    }
  });
  return parts.join(' ').toLowerCase().includes(query);
}

export function filterFolderTree(nodes: FolderSectionNode[], query: string, _catalogs: Catalogs | null): FolderSectionNode[] {
  function filterNode(node: FolderSectionNode): FolderSectionNode {
    const items: FolderItemNode[] = node.items
      .map(it =>
        it.type === 'command'
          ? cardMatchesQuery(it.card, query)
            ? it
            : null
          : ({ type: 'folder', section: filterNode(it.section) } as const)
      )
      .filter((it): it is FolderItemNode => !!it);
    return { ...node, items, cardCount: items.filter(it => it.type === 'command').length };
  }
  return nodes.map(filterNode);
}

// Soma de cardCount em TODA a árvore (raízes + subpastas, recursivo) — usada
// pra decidir se mostra o estado vazio "No commands found for ..." quando a
// busca não bate com nenhum comando em nenhuma pasta.
export function folderTreeCardCount(nodes: FolderSectionNode[]): number {
  let total = 0;
  nodes.forEach(n => {
    total += n.cardCount;
    const subfolders = n.items
      .filter((it): it is { type: 'folder'; section: FolderSectionNode } => it.type === 'folder')
      .map(it => it.section);
    total += folderTreeCardCount(subfolders);
  });
  return total;
}
