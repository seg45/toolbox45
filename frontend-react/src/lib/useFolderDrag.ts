// ════════════════════════════════════════════════
// Drag-and-drop dentro da árvore de UMA pasta (fatia 5b) — porta de
// _fldArmDrag/dragstart/dragover/drop/dragend (listeners no `document`) +
// _fldReadContainerOrderFromDom/persistFolderContainerOrder/
// _fldMoveItemAcrossFolders/reorderFolderItems em js/folders.js.
//
// Decisão de arquitetura React (documentada a pedido da tarefa, e revista
// depois de um bug real encontrado rodando os testes desta fatia — ver
// abaixo): o original manipula o DOM DIRETAMENTE durante o `dragover`, SEM
// nenhum re-render nesse meio tempo — inclusive fisicamente REPARENTANDO a
// row arrastada pra dentro de outro `.sec-body` quando o alvo é de outro
// container (`bodyEl.appendChild(_fldDragRow)`), só disparando uma mudança
// de estado "de verdade" no `dragend`. Isso funciona sem ressalvas no
// original porque `render()` ali sempre RECONSTRÓI o HTML inteiro do zero
// (`innerHTML = ...`) — não há reconciliação nenhuma pra confundir.
//
// Replicar EXATAMENTE essa mesma estratégia aqui — mover o nó real do DOM
// pra dentro de OUTRO `.sec-body` (outro componente `<FolderSection>`)
// durante o `dragover`, como uma primeira versão desta fatia tentou —
// QUEBRA o React: ao commitar o próximo estado (depois do `dragend`), o
// Fiber da pasta de ORIGEM ainda espera aquela row como sua própria filha
// e tenta desmontá-la com `parentSecBody.removeChild(row)` — mas a row já
// não é mais filha física daquele `.sec-body` (foi reparentada à mão) e o
// navegador lança `NotFoundError: Failed to execute 'removeChild' on
// 'Node': The node to be removed is not a child of this node`, derrubando
// o app inteiro. Confirmado rodando um cenário de teste desta própria
// fatia (mover um comando pra dentro de uma subpasta) ANTES desta versão
// corrigida — reproduzível com qualquer "soltar num container DIFERENTE do
// atual". Reordenar DENTRO do MESMO container, por outro lado, é seguro:
// o `insertBefore` que o React usa pra reposicionar (não remover) sempre
// funciona em cima da referência real do nó, não importa se ele já foi
// movido à mão de antemão — só o REMOVE cross-parent quebra.
//
// A solução adotada aqui, então, divide os dois casos:
//   - Reordenar DENTRO do MESMO container (`.sec-body` de origem) — segue
//     manipulando o DOM ao vivo (`insertBefore`), IGUAL ao original —
//     visualmente idêntico, sem risco nenhum (nunca cruza um `removeChild`
//     de outro pai).
//   - Mover pra OUTRO container (soltar no cabeçalho de outra pasta, ou
//     perto de uma row que pertence a outro container) — NÃO reparenta o
//     nó de verdade durante o `dragover`; só grava a posição-alvo
//     pretendida (`crossTarget`, uma ref) e aplica um destaque visual
//     (outline) no cabeçalho/row mirada, via `element.style.outline`
//     direto (nunca via `style` do React, que só mexe nas chaves que ele
//     próprio declara — não conflita com essa escrita imperativa). O
//     RESULTADO final continua batendo com o original: ao soltar
//     (`dragend`), a ordem final do destino é calculada a partir da ordem
//     ATUAL dos irmãos lá (lidos do DOM) + a posição-alvo gravada, e
//     `onMove` dispara a mesma mudança de membership/parent + persistência
//     de ordem que o original faz — só a PRÉVIA visual de "a row já está
//     fisicamente lá dentro enquanto você ainda segura o mouse" que não é
//     replicada 1:1 (vira um destaque no alvo em vez disso). O que o
//     usuário vê ao SOLTAR (onde o item aparece) e o que é persistido no
//     servidor é idêntico ao original.
// ════════════════════════════════════════════════
import { useEffect, useRef } from 'react';

export interface FolderOrderedItem {
  type: 'command' | 'folder';
  id: number;
}

// Posição-alvo pretendida quando o item está sendo arrastado pra um
// container DIFERENTE do de origem (ver comentário acima) — `beforeId ===
// null` significa "no FIM da lista" (soltar no cabeçalho de uma pasta,
// Alvo A do original); caso contrário, "logo antes deste item" (soltar
// perto de uma row específica de outro container, Alvo B do original).
interface CrossTarget {
  containerId: number;
  beforeType: 'command' | 'folder' | null;
  beforeId: number | null;
}

export function useFolderDrag(params: {
  // Mesma pasta, só mudou de posição entre os irmãos — PUT
  // /api/folders/:id/reorder com a ordem final lida do DOM.
  onReorder: (containerId: number, order: FolderOrderedItem[]) => void;
  // Mudou de pasta (dentro/fora de uma subpasta) — muda a membership/
  // parent de verdade no backend (comando: POST na nova + DELETE na
  // antiga; subpasta: PUT .../move) e, depois, persiste a ordem final do
  // DESTINO (calculada a partir da ordem atual dos irmãos lá + a
  // posição-alvo pretendida — ver CrossTarget acima).
  onMove: (itemType: 'command' | 'folder', itemId: number, oldContainerId: number, newContainerId: number, order: FolderOrderedItem[]) => void;
}) {
  // Refs pros callbacks (não os valores em si) — evita precisar
  // re-registrar os listeners do `document` a cada render só porque
  // `onReorder`/`onMove` mudou de identidade (CommandsContent.tsx os
  // recria a cada render, já que fecham sobre `folders`/`commands`
  // atuais); o efeito abaixo roda uma ÚNICA vez (mount/unmount), sempre
  // lendo a versão mais recente através da ref.
  const onReorderRef = useRef(params.onReorder);
  const onMoveRef = useRef(params.onMove);
  onReorderRef.current = params.onReorder;
  onMoveRef.current = params.onMove;

  useEffect(() => {
    // Equivalentes aos "let _fldDragRow/_fldOriginContainerId" globais do
    // original — aqui, locais ao efeito (uma só instância deste hook
    // existe por vez, montada uma vez em CommandsContent.tsx).
    let dragRow: HTMLElement | null = null;
    let originContainerId: string | null = null;
    // Não-nulo enquanto o alvo atual do hover é de OUTRO container (ver
    // comentário do arquivo) — `null` significa "ainda dentro do próprio
    // container de origem", ou seja, o caminho de reorder simples.
    let crossTarget: CrossTarget | null = null;
    let highlightEl: HTMLElement | null = null;

    function setHighlight(el: HTMLElement | null) {
      if (highlightEl === el) return;
      if (highlightEl) highlightEl.style.outline = '';
      highlightEl = el;
      if (highlightEl) highlightEl.style.outline = '2px dashed var(--teal)';
    }

    function readContainerOrderFromDom(containerId: number): FolderOrderedItem[] {
      // `:scope > .folder-item-row` importa aqui — sem ele, pegaria também
      // os itens de uma subpasta ANINHADA dentro de um dos irmãos (mesmo
      // comentário do original em _fldReadContainerOrderFromDom).
      const container = document.querySelector(`.sec-body[data-folder-body-id="${containerId}"]`);
      if (!container) return [];
      return [...container.querySelectorAll(':scope > .folder-item-row')]
        .map(r => {
          const el = r as HTMLElement;
          const type = el.dataset.itemType as 'command' | 'folder' | undefined;
          const rawId = el.dataset.itemId;
          if (!type || rawId == null) return null;
          return { type, id: Number(rawId) };
        })
        .filter((x): x is FolderOrderedItem => !!x);
    }

    function onMouseUp() {
      document.querySelectorAll('.folder-item-row[draggable="true"]').forEach(r => r.removeAttribute('draggable'));
    }

    function onDragStart(ev: DragEvent) {
      const target = ev.target as HTMLElement | null;
      const row = target?.closest?.('.folder-item-row') as HTMLElement | null;
      if (!row || !row.hasAttribute('draggable')) return;
      dragRow = row;
      originContainerId = row.dataset.containerId || null;
      crossTarget = null;
      row.classList.add('dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', ''); // exigido pelo Firefox para permitir o drag
      }
    }

    function onDragOver(ev: DragEvent) {
      if (!dragRow) return;
      const rootId = dragRow.dataset.rootFolderId;
      const draggedType = dragRow.dataset.itemType;
      const draggedId = dragRow.dataset.itemId;
      const evTarget = ev.target as HTMLElement | null;

      // Alvo A (mais específico): o CABEÇALHO de uma pasta (a raiz OU
      // qualquer subpasta visível) — soltar aqui manda o item pra DENTRO
      // dela, no fim da lista (jeito de mirar uma subpasta vazia/
      // recolhida sem precisar acertar uma row específica). SEMPRE um
      // container DIFERENTE do de origem (mesma checagem do original:
      // "já está lá dentro" só é possível comparando contra o container
      // de origem, já que a row NUNCA é reparentada de verdade aqui — ver
      // comentário do arquivo).
      const header = evTarget?.closest?.('[data-folder-header-id]') as HTMLElement | null;
      if (header) {
        const targetFolderId = header.dataset.folderHeaderId!;
        const targetSection = header.closest('[data-folder-id]') as HTMLElement | null;
        if (!targetSection || targetSection.dataset.rootFolderId !== rootId) return; // fora da árvore — recusa
        if (draggedType === 'folder' && String(targetFolderId) === String(draggedId)) return; // não entra em si mesma
        if (draggedType === 'folder' && dragRow.contains(header)) return; // nem numa de suas próprias descendentes (cicraria)
        if (String(targetFolderId) === String(originContainerId)) return; // já está lá dentro — nada a fazer
        ev.preventDefault();
        crossTarget = { containerId: Number(targetFolderId), beforeType: null, beforeId: null };
        setHighlight(header);
        return;
      }

      // Alvo B: outra row — reordena por posição (antes/depois dela). Pode
      // ser da MESMA pasta (reorder simples, com movimento de DOM ao vivo
      // — seguro) ou de OUTRA pasta da MESMA árvore (move — só grava a
      // posição-alvo em `crossTarget`, sem reparentar de verdade).
      const overRow = evTarget?.closest?.('.folder-item-row') as HTMLElement | null;
      if (!overRow || overRow === dragRow || dragRow.contains(overRow)) return;
      if (overRow.dataset.rootFolderId !== rootId) return; // fora da árvore — recusa
      ev.preventDefault();
      const rect = overRow.getBoundingClientRect();
      const before = ev.clientY - rect.top < rect.height / 2;
      const overContainerId = overRow.dataset.containerId || null;

      if (overContainerId === originContainerId) {
        // Mesma pasta de origem — seguro mover o DOM de verdade (ver
        // comentário do arquivo); volta ao modo "reorder simples" mesmo
        // que um `crossTarget` estivesse pendente de um hover anterior.
        crossTarget = null;
        setHighlight(null);
        overRow.parentElement!.insertBefore(dragRow, before ? overRow : overRow.nextSibling);
        return;
      }

      // Container diferente — só registra a posição-alvo pretendida
      // (antes/depois desta row específica) e destaca a row mirada.
      const overType = overRow.dataset.itemType as 'command' | 'folder' | undefined;
      const overId = overRow.dataset.itemId;
      if (!overType || overId == null) return;
      crossTarget = {
        containerId: Number(overContainerId),
        beforeType: before ? overType : null,
        beforeId: before ? Number(overId) : null,
      };
      // "depois desta row" (before=false) sem uma próxima row conhecida de
      // antemão — resolvido no dragend como "logo depois de overId" lendo
      // a ordem atual do destino; aqui só precisamos de ALGO que
      // identifique a posição, então guardamos a PRÓPRIA row como
      // referência "antes de" quando `before`, ou calculamos o próximo
      // irmão como referência quando não. Mais simples: quando `!before`,
      // usa o PRÓXIMO irmão de overRow (se existir) como `beforeId`; sem
      // próximo irmão, `beforeId=null` (equivale a "no fim").
      if (!before) {
        const nextSibling = overRow.nextElementSibling as HTMLElement | null;
        if (nextSibling && nextSibling.classList.contains('folder-item-row')) {
          crossTarget = {
            containerId: Number(overContainerId),
            beforeType: nextSibling.dataset.itemType as 'command' | 'folder',
            beforeId: Number(nextSibling.dataset.itemId),
          };
        } else {
          crossTarget = { containerId: Number(overContainerId), beforeType: null, beforeId: null };
        }
      }
      setHighlight(overRow);
    }

    function onDrop(ev: DragEvent) {
      if (dragRow) ev.preventDefault();
    }

    function onDragEnd() {
      const row = dragRow;
      if (row) {
        row.classList.remove('dragging');
        row.removeAttribute('draggable');
        setHighlight(null);
        const itemType = row.dataset.itemType as 'command' | 'folder';
        const itemId = Number(row.dataset.itemId);
        const oldContainerId = Number(originContainerId);

        if (!crossTarget) {
          // Reorder simples: a row já está fisicamente na posição final
          // (movida ao vivo durante o dragover) — só lê a ordem do DOM.
          const order = readContainerOrderFromDom(oldContainerId);
          if (order.length) onReorderRef.current(oldContainerId, order);
        } else {
          // Mover pra OUTRA pasta — a row NUNCA foi fisicamente
          // reparentada (ver comentário do arquivo); a ordem final do
          // DESTINO é calculada a partir dos irmãos que já estão lá
          // (lidos do DOM agora, antes de qualquer setState) + a
          // posição-alvo pretendida gravada durante o dragover.
          const target = crossTarget;
          const existing = readContainerOrderFromDom(target.containerId);
          const ownTag: FolderOrderedItem = { type: itemType, id: itemId };
          let order: FolderOrderedItem[];
          if (target.beforeId == null) {
            order = [...existing, ownTag];
          } else {
            const idx = existing.findIndex(o => o.type === target.beforeType && o.id === target.beforeId);
            order = idx === -1 ? [...existing, ownTag] : [...existing.slice(0, idx), ownTag, ...existing.slice(idx)];
          }
          onMoveRef.current(itemType, itemId, oldContainerId, target.containerId, order);
        }
      }
      dragRow = null;
      originContainerId = null;
      crossTarget = null;
    }

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', onDragEnd);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('dragstart', onDragStart);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('dragend', onDragEnd);
    };
  }, []);

  // `handle` = o próprio elemento da alça (⠿) — mesma assinatura de
  // `_fldArmDrag(handle)` no original (chamado direto do onMouseDown do
  // elemento clicado, não da row já resolvida).
  function armDrag(handle: HTMLElement | null) {
    const row = handle?.closest('.folder-item-row') as HTMLElement | null;
    if (row) row.setAttribute('draggable', 'true');
  }

  return { armDrag };
}
