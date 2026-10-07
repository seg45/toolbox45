// ════════════════════════════════════════════════
// Card de um comando — porta de card() em js/terminal-renderer.js. Os
// botões de editar/duplicar (edit-btn — fatia 4, Editor de comandos) foram
// acrescentados a `.card-actions` naquela fatia; o botão de pastas
// (fav-wrap/folderMenuHtml/auditPopover — fatia 5a, Pastas) foi acrescentado
// nesta, entre `.card-desc` e `.card-actions` (mesma posição do original).
// Este mesmo componente é reaproveitado tanto na visão normal (Tópico/
// Versão/Created by) quanto dentro de uma seção de pasta (FolderSection.tsx)
// — o botão de pastas funciona idêntico nos dois lugares (marca/desmarca
// QUALQUER pasta do usuário, não só "remover desta pasta").
//
// A preferência "Details" (settings.showCardDetails) não é um `if` aqui —
// no original ela liga/desliga a classe `.compact-cards` no <body>, que via
// CSS esconde `.card-desc`/`.card-about` (ver src/styles/components.css).
// Este componente sempre renderiza os dois; é CommandsContent.tsx que
// aplica `compact-cards` no elemento `.content` ancestral, exatamente como
// o original fazia no body.
// ════════════════════════════════════════════════
import { useAuth } from '../../lib/auth';
import { SafeHtml } from '../SafeHtml';
import type { Catalogs } from '../../lib/catalogs';
import type { CardData } from '../../lib/renderPipeline';
import { FolderButton } from './FolderMenu';
import { ScopeTags } from './ScopeTags';
import { TerminalLines } from './TerminalLines';

const EDIT_ICON = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
    <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const DUPLICATE_ICON = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
    <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M3 10H2a1 1 0 01-1-1V2a1 1 0 011-1h7a1 1 0 011 1v1" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export function CommandCard({
  card,
  catalogs,
  showImages,
  onEdit,
  onDuplicate,
}: {
  card: CardData;
  catalogs: Catalogs | null;
  showImages: boolean;
  onEdit: (id: number) => void;
  onDuplicate: (id: number) => void;
}) {
  const auth = useAuth();
  const hasDetails = !!(card.detailsHtml && card.detailsHtml.trim());
  // Mesma regra usada pela guarda de abertura do editor (ver
  // CommandEditorModal.tsx): admin, comando de sistema (qualquer usuário
  // pode editar um comando de referência), ou o próprio autor.
  const canEdit = auth.isAdmin || card.isSystem || auth.me?.username === card.createdBy;
  return (
    <div className="card" data-cmd-id={card.id}>
      <div className="card-head">
        <span className="card-name">{card.name}</span>
        <ScopeTags vendors={card.vendors} systems={card.systems} versions={card.versions} environments={card.environments} catalogs={catalogs} />
        <span className="card-desc">{card.desc || ''}</span>
        <FolderButton commandId={card.id} folderIds={card.folderIds} createdBy={card.createdBy} modifiedBy={card.modifiedBy} updatedAt={card.updatedAt} />
        <span className="card-actions">
          <button type="button" className="edit-btn" title="Duplicate command" onClick={() => onDuplicate(card.id)}>
            {DUPLICATE_ICON}
          </button>
          {canEdit && (
            <button type="button" className="edit-btn" title="Edit command" onClick={() => onEdit(card.id)}>
              {EDIT_ICON}
            </button>
          )}
        </span>
      </div>
      <TerminalLines lines={card.lines} showImages={showImages} cmdId={card.id} />
      {hasDetails && (
        <div className="card-about">
          <div className="about-body">
            <div className="about-heading">Details</div>
            <SafeHtml html={card.detailsHtml} />
          </div>
        </div>
      )}
    </div>
  );
}
