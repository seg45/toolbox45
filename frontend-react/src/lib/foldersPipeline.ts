// ════════════════════════════════════════════════
// PASTAS — pipeline de dados da visão "Folders" — porta de
// buildFolderItemsCards()/buildFolderSectionFromCards()/buildFolderSection()
// (js/db-render-engine.js) + o ramo VIEW_FOLDERS_HOME de render()
// (js/render.js), os 3 sub-ramos de escopo incluídos (mine/all/user:<x>,
// ver buildFolderSectionTreeForOwner mais abaixo, fatia 5b).
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
// SEM notas (entradas `order` do tipo 'note' são descartadas — ver
// comentário em src/lib/folders.ts), em qualquer escopo — ainda fora do
// escopo de qualquer fatia até agora.
//
// Reordenar (fatia 5b, drag-and-drop) NÃO mexe neste arquivo: a ordem
// exibida aqui sempre vem de folder.order tal como está no estado React
// (`folders`/`allUsersFolders` em CommandsContent.tsx) — é esse ESTADO que
// muda (otimisticamente, no dragend) quando o usuário arrasta um item; a
// função pura aqui só REFLETE o que já está no estado, nunca reordena por
// conta própria. Ver src/lib/useFolderDrag.ts para o mecanismo de
// drag-and-drop em si.
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
  // Fatia 5b: true pra uma pasta do usuário ATUAL (editável/arrastável),
  // false pra uma pasta de outro usuário (só leitura, com um botão "⧉ Copy"
  // em vez dos controles de edição — ver FolderSection.tsx). Uniforme em
  // toda uma mesma árvore (uma subpasta nunca pertence a um dono diferente
  // da raiz — parent_id só liga pastas do MESMO usuário, ver server-py),
  // então viaja sem mudar pela recursão, igual rootFolderId. Sempre `true`
  // em buildFolderSectionTree() (escopo "mine", única forma que existia até
  // a fatia 5a); buildFolderSectionTreeForOwner() (novo, 5b) é quem de fato
  // varia este valor por chamada.
  isOwn: boolean;
  cardCount: number; // só comandos desta pasta (não conta subpastas) — mesmo critério do original
  items: FolderItemNode[];
}

export type FolderItemNode = { type: 'command'; card: CardData } | { type: 'folder'; section: FolderSectionNode };

// Monta recursivamente UM nó da árvore (pasta + suas subpastas diretas) —
// extraído de buildFolderSectionTree (fatia 5a) pra ser reaproveitado
// também por buildFolderSectionTreeForOwner (fatia 5b, escopos cross-user)
// em vez de duplicar a intercalação de folder.order — ver comentário de
// buildFolderSectionTree logo abaixo sobre a única diferença de verdade
// entre as duas chamadas (de onde vem `commandsByFolder`).
//
// `isOwn` decide o que acontece quando a pasta fica vazia (0 comandos, 0
// subpastas restantes após a poda): uma pasta PRÓPRIA sempre aparece, mesmo
// vazia (mesmo comportamento de buildFolderSectionFromCards original,
// `withActions` — dá pra ver o botão "+ Add" e começar a usá-la); uma pasta
// de OUTRO usuário vazia é PODADA por completo (devolve `null`, removida da
// árvore) — mesmo critério de `if (!items.length && !withActions) return
// '';` no original. A poda é recursiva: uma subpasta de outro usuário que
// ficou vazia não aparece nem como ITEM dentro do `items` da pasta-mãe
// (diferente de uma pasta própria vazia, que sempre aparece como seção
// própria quando é a raiz sendo iterada por quem chama).
function buildFolderNode(
  folder: Folder,
  depth: number,
  rootFolderId: number,
  isOwn: boolean,
  childrenOf: (id: number) => Folder[],
  commandsByFolder: Map<number, Command[]>,
  values: Values,
  hasIPs: boolean,
  catalogParams: ParameterEntry[]
): FolderSectionNode | null {
  // Recursão nas subpastas DIRETAS primeiro (mesma ordem de
  // renderFolderNode em render.js) — cada uma vira, ela mesma, um
  // FolderSectionNode aninhado, intercalado na posição certa dentro do
  // corpo desta pasta via folder.order (ver abaixo). Subpastas podadas (só
  // acontece com isOwn=false, ver comentário acima) simplesmente não
  // entram em `childNodes` — ficam de fora de `folder.order` na hora de
  // montar `items` mais abaixo, exatamente como se nunca tivessem existido.
  const childFolders = childrenOf(folder.id);
  const childNodes = new Map<number, FolderSectionNode>();
  childFolders.forEach(child => {
    const node = buildFolderNode(child, depth + 1, rootFolderId, isOwn, childrenOf, commandsByFolder, values, hasIPs, catalogParams);
    if (node) childNodes.set(child.id, node);
  });

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

  if (!isOwn && items.length === 0) return null; // pasta de outro usuário, vazia — nunca aparece (mesmo critério de buildFolderSectionFromCards original)

  return {
    folderId: folder.id,
    name: folder.name,
    depth,
    rootFolderId,
    isFavorites: folder.name === 'Favorites',
    isOwn,
    cardCount: items.filter(it => it.type === 'command').length,
    items,
  };
}

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
  // cada uma. Escopo "mine" (único chamador desta função): deriva a
  // membership a partir de `command.folder_ids` (o que o backend já filtrou
  // pro usuário atual, ver server-py) — mesmo critério do original pro
  // ramo `scope === 'mine'` de render.js.
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

  return tree.roots
    .map(folder => buildFolderNode(folder, 0, folder.id, true, tree.childrenOf, commandsByFolder, values, hasIPs, catalogParams))
    .filter((n): n is FolderSectionNode => !!n); // isOwn=true nunca poda (buildFolderNode só devolve null quando !isOwn) — filter só por segurança de tipo
}

// Fatia 5b: árvore de pastas de UM dono qualquer (próprio OU outro usuário)
// — porta dos ramos `scope === 'all'`/`scope === 'user:<username>'` de
// render.js (a parte de MONTAR a árvore de uma pessoa; o agrupamento "👤
// <username>" do escopo "all" é responsabilidade de quem chama —
// CommandsContent.tsx —, que invoca esta função UMA VEZ POR USUÁRIO e
// decide como envolver o resultado).
//
// Diferença deliberada de arquitetura em relação a buildFolderSectionTree
// (5a) — ver instruções da tarefa ("generalizar... ou criar uma função
// irmã, a seu critério"): optei por uma função IRMÃ em vez de generalizar
// buildFolderSectionTree com mais parâmetros, porque a fonte da membership
// muda de verdade entre os dois escopos, não é só um "flag a mais" — dentro
// de "mine", `command.folder_ids` (o que o backend devolve, já filtrado pro
// usuário atual) é a fonte certa; pra QUALQUER outro dono (mesmo o próprio
// usuário atual, quando aparece dentro do escopo "all"), `command.folder_ids`
// não serve (só reflete as pastas do usuário que está OLHANDO a tela, nunca
// as de quem a pasta pertence) — é preciso usar `folder.commandIds` (o
// Set de membership que a própria pasta carrega, vindo de GET
// /api/folders/all) pra saber quais comandos entram nela. Isso bate 1:1 com
// o original, que também usa `commands.filter(c => f.command_ids.has(c.id))`
// em vez de `c.folder_ids` dentro dos ramos `scope !== 'mine'` de render.js
// — inclusive pra pastas do PRÓPRIO usuário quando elas aparecem dentro do
// escopo "all" (ver comentário lá: "cada usuário só pode alterar ou excluir
// a sua própria pasta", mas a MEMBERSHIP ainda é lida via f.command_ids
// mesmo sendo o dono atual). A lógica de intercalar order/podar pasta vazia
// (buildFolderNode, compartilhada acima) é idêntica nos dois casos — só a
// fonte de `commandsByFolder` muda, por isso a extração em função comum.
export function buildFolderSectionTreeForOwner(params: {
  commands: Command[];
  folders: Folder[]; // já filtradas pra UM dono só (ver comentário acima) — parent_id dentro desta lista nunca aponta pra fora dela
  values: Values;
  hasIPs: boolean;
  catalogParams: ParameterEntry[];
  isOwn: boolean; // true quando este dono É o usuário atual (mesmo que a visão seja "all"/"user:<ele mesmo>")
}): FolderSectionNode[] {
  const { commands, folders, values, hasIPs, catalogParams, isOwn } = params;
  const tree = buildFolderTree(folders);

  const commandsByFolder = new Map<number, Command[]>();
  folders.forEach(f => {
    commandsByFolder.set(
      f.id,
      commands.filter(c => f.commandIds.has(c.id))
    );
  });

  return tree.roots
    .map(folder => buildFolderNode(folder, 0, folder.id, isOwn, tree.childrenOf, commandsByFolder, values, hasIPs, catalogParams))
    .filter((n): n is FolderSectionNode => !!n);
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
