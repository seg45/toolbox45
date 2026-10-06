// ════════════════════════════════════════════════
// Card de uma NOTE (task Notes) — fatia 5c — porta de buildNoteCardHtml()
// (js/db-render-engine.js), 3º redesign do original (edição acontece dentro
// do PRÓPRIO card, sem popup/modal separado).
//
// Dois modos: visualização (mostra note.description — HTML já sanitizado no
// servidor, ver sanitize_note_html em app/sanitize.py — com um mini-toolbar
// hover Clonar/Editar) e edição (cabeçalho "New note"/"Editing note" +
// Accept/Cancel/Delete + <RichTextEditor>, fatia 4, reaproveitado tal como
// pedido nas instruções da tarefa — nenhuma lógica de toolbar/rich-text é
// reimplementada aqui).
//
// NOTE_EDIT_DRAFTS do original (proteção manual contra perda de rascunho
// quando um render() por outro motivo reconstrói o card enquanto o usuário
// ainda digita — ver comentário extenso em folders.js) NÃO tem equivalente
// aqui, DE PROPÓSITO: RichTextEditor é uncontrolled (lê/escreve .innerHTML
// via ref, nunca a partir de uma prop React) e este componente é montado com
// uma `key` ESTÁVEL por nota (`note-${id}`/`note-draft-${folderId}`, ver
// FolderSection.tsx) — um re-render do componente pai (CommandsContent.tsx)
// nunca desmonta/remonta este card só porque algo não relacionado mudou
// (busca com debounce, outra pasta reordenada etc.), então o texto sendo
// digitado nunca é jogado fora. `initedRef` só garante que `setHtml` seja
// chamado UMA VEZ (na entrada em modo de edição) — se ele rodasse a cada
// render, sobrescreveria o que o usuário já digitou com `note.description`
// (o valor ainda salvo no servidor) a cada tecla, recriando exatamente o
// bug que o original evita com NOTE_EDIT_DRAFTS.
// ════════════════════════════════════════════════
import { useEffect, useRef } from 'react';
import { RichTextEditor, type RichTextEditorHandle } from '../RichTextEditor';
import { sanitizeRichHtml } from '../../lib/safeHtml';
import { SafeHtml } from '../SafeHtml';

const CLONE_ICON = (
  <svg width="11" height="11" fill="none" viewBox="0 0 16 16">
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
    <path d="M3.2 10.5H2.3a.8.8 0 01-.8-.8v-7A.8.8 0 012.3 2h7a.8.8 0 01.8.8v.9" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
const EDIT_ICON = (
  <svg width="11" height="11" fill="none" viewBox="0 0 16 16">
    <path d="M11.3 1.7l3 3L5 14H2v-3l9.3-9.3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

// "Vazia" = sem texto E sem nenhuma <img> — porte 1:1 da checagem em
// acceptNoteEdit() (js/folders.js): uma nota só com imagem colada (sem texto
// nenhum) ainda é válida, então não basta olhar pro textContent.
function isEmptyNoteHtml(html: string): boolean {
  const tmp = document.createElement('div');
  tmp.innerHTML = sanitizeRichHtml(html);
  const hasText = !!(tmp.textContent || '').trim();
  const hasImage = !!tmp.querySelector('img');
  return !hasText && !hasImage;
}

export interface NoteCardNote {
  id: number | null; // null = rascunho ainda não salvo (nota nova)
  folder_id: number;
  description: string;
}

export function NoteCard({
  note,
  isNew,
  editing,
  isOwn,
  onStartEdit,
  onClone,
  onAccept,
  onCancel,
  onDelete,
}: {
  note: NoteCardNote;
  isNew: boolean;
  editing: boolean;
  isOwn: boolean;
  onStartEdit: () => void;
  onClone: () => void;
  // Recebe o HTML já lido do editor (getHtml()) — o chamador (CommandsContent.tsx)
  // decide create vs. update (note.id null ou não) e faz o merge no estado
  // local; este componente só valida "vazia" antes de disparar.
  onAccept: (html: string) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const editorRef = useRef<RichTextEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const initedRef = useRef(false);

  // Popula o editor com o valor salvo UMA ÚNICA VEZ ao entrar em modo de
  // edição (ver comentário do arquivo sobre por que isso substitui
  // NOTE_EDIT_DRAFTS) — nunca de novo enquanto `editing` continuar true.
  useEffect(() => {
    if (editing && !initedRef.current) {
      editorRef.current?.setHtml(note.description || '');
      initedRef.current = true;
    }
    if (!editing) initedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Foca o editor recém-aberto — porta de _neFocusEditor() (js/folders.js),
  // que precisa de um setTimeout(0) lá porque o card só existe no DOM depois
  // do innerHTML ser reatribuído por render(); aqui o equivalente é esperar
  // o próprio efeito de montagem/troca de modo assentar antes de focar.
  useEffect(() => {
    if (!editing) return;
    const t = setTimeout(() => {
      rootRef.current?.querySelector<HTMLElement>('.note-editor-body')?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [editing]);

  function handleAccept() {
    const html = editorRef.current?.getHtml() || '';
    if (isEmptyNoteHtml(html)) {
      window.alert('Write something in the note.');
      return;
    }
    onAccept(html);
  }

  if (editing) {
    return (
      <div className="card" data-note-id={note.id ?? ''} data-note-editing="1" ref={rootRef}>
        <div className="note-edit-head">
          <span className="note-edit-label">{isNew ? 'New note' : 'Editing note'}</span>
          <span className="note-edit-actions">
            <button
              type="button"
              className="sec-folder-pill-btn pill-accept"
              onMouseDown={ev => ev.preventDefault()}
              onClick={handleAccept}
              title="Save note"
            >
              ✓ Accept
            </button>
            <button
              type="button"
              className="sec-folder-pill-btn pill-cancel"
              onMouseDown={ev => ev.preventDefault()}
              onClick={onCancel}
              title="Discard changes"
            >
              ✕ Cancel
            </button>
            {!isNew && (
              <button
                type="button"
                className="sec-folder-pill-btn pill-delete"
                onMouseDown={ev => ev.preventDefault()}
                onClick={onDelete}
                title="Delete note"
              >
                ✕ Delete Note
              </button>
            )}
          </span>
        </div>
        <RichTextEditor ref={editorRef} ariaLabel="Note" />
      </div>
    );
  }

  const hasContent = !!(note.description || '').trim();
  return (
    // `class="card"` SEM sufixo extra, de propósito — mesma nota do original
    // (db-render-engine.js): o visual próprio de uma nota (fundo, padding do
    // corpo) é aplicado via seletor de ATRIBUTO (`.card[data-note-id]`, ver
    // components.css), não via classe extra. Não existe, neste port React,
    // nenhuma contagem baseada em regex sobre `class="card"` cru (a
    // contagem de cards aqui é sempre via `cardCount`, calculado em
    // foldersPipeline.ts a partir da árvore de dados, nunca via texto/HTML)
    // — a classe extra não quebraria nada funcional se fosse adicionada,
    // mas mantém-se ausente por fidelidade ao original e porque não há
    // necessidade real de um seletor a mais.
    <div className="card" data-note-id={note.id ?? ''}>
      {isOwn && (
        <span className="note-flat-actions">
          <button type="button" className="edit-btn" onClick={onClone} title="Clone note">
            {CLONE_ICON}
          </button>
          <button type="button" className="edit-btn" onClick={onStartEdit} title="Edit note">
            {EDIT_ICON}
          </button>
        </span>
      )}
      <div className="note-flat-body">
        {hasContent ? (
          <SafeHtml html={note.description} />
        ) : (
          <span className="note-flat-empty">(empty note)</span>
        )}
      </div>
    </div>
  );
}
