// ════════════════════════════════════════════════
// Card de um comando — porta de card() em js/terminal-renderer.js, SEM o
// botão de favoritar/pastas (fav-wrap/folderMenuHtml/auditPopover — fatia 5,
// Pastas) e SEM os botões de editar/duplicar (edit-btn/duplicate — fatia 4,
// Editor de comandos). `.card-actions` continua sendo renderizado (vazio)
// para o layout do CSS não pular quando esses botões chegarem.
//
// A preferência "Details" (settings.showCardDetails) não é um `if` aqui —
// no original ela liga/desliga a classe `.compact-cards` no <body>, que via
// CSS esconde `.card-desc`/`.card-about` (ver src/styles/components.css).
// Este componente sempre renderiza os dois; é CommandsContent.tsx que
// aplica `compact-cards` no elemento `.content` ancestral, exatamente como
// o original fazia no body.
// ════════════════════════════════════════════════
import type { Catalogs } from '../../lib/catalogs';
import type { CardData } from '../../lib/renderPipeline';
import { ScopeTags } from './ScopeTags';
import { TerminalLines } from './TerminalLines';

export function CommandCard({
  card,
  catalogs,
  showImages,
}: {
  card: CardData;
  catalogs: Catalogs | null;
  showImages: boolean;
}) {
  const hasDetails = !!(card.detailsHtml && card.detailsHtml.trim());
  return (
    <div className="card" data-cmd-id={card.id}>
      <div className="card-head">
        <span className="card-name">{card.name}</span>
        <ScopeTags vendors={card.vendors} systems={card.systems} versions={card.versions} environments={card.environments} catalogs={catalogs} />
        <span className="card-desc">{card.desc || ''}</span>
        {/* fav/pastas (fatia 5) e editar/duplicar (fatia 4) entram aqui depois. */}
        <span className="card-actions"></span>
      </div>
      <TerminalLines lines={card.lines} showImages={showImages} />
      {hasDetails && (
        <div className="card-about">
          <div className="about-body">
            <div className="about-heading">Details</div>
            <div dangerouslySetInnerHTML={{ __html: card.detailsHtml }} />
          </div>
        </div>
      )}
    </div>
  );
}
