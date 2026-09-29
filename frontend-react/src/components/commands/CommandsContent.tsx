// ════════════════════════════════════════════════
// Área principal de comandos — substitui o placeholder
// `<div class="content" id="out">{/* Preenchido pela fatia 3 */}</div>` de
// AppShell.tsx (este componente É o `.content#out`, não um filho dele).
//
// Orquestra: QueryBar (fatia 3b — campo de query unificado com tags,
// chips fixos/Others e histórico, ver query-bar.js; substitui o stopgap
// SimpleQueryFields.tsx da fatia 3a) + ContentToolbar (Group by / Expand
// all / Collapse all) + fetchCommands() (loading/erro) +
// renderPipeline.buildRenderTree() + a árvore de comboBlocks/sections/cards
// + a nota de truncamento de MAX_COMBOS + o estado vazio final de busca
// sem resultado.
//
// Porta de render() em js/render.js (a parte de orquestração/DOM — a lógica
// de dados já foi portada em renderPipeline.ts).
//
// Fatia 4 (Editor de comandos) acrescentou aqui: o estado de "qual editor
// está aberto" (`editor`) e uma função de refresh (invalida cache + refetch
// + setCommands) passada como callback pro modal salvar/deletar, pro
// ContentToolbar (botão Add) e pro CommandCard (botões Edit/Duplicate) —
// mesmo espírito de AppShell.tsx com settingsOpen/setSettingsOpen pro modal
// de Configurações. Mora aqui (não em AppShell.tsx) porque é aqui que o
// estado `commands`/`setCommands`/fetchCommands() já vivia.
// ════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Catalogs } from '../../lib/catalogs';
import { useCollapsedSections } from '../../lib/collapsedSections';
import { fetchCommands, invalidateCommandsCache, type Command } from '../../lib/commands';
import type { useLiveFilters } from '../../lib/liveFilters';
import { buildRenderTree, type ComboBlockData, type SectionData } from '../../lib/renderPipeline';
import type { Settings } from '../../lib/settingsStore';
import { CollapsibleSection } from './CollapsibleSection';
import { CommandCard } from './CommandCard';
import { CommandEditorModal, type EditorMode } from './CommandEditorModal';
import { ContentToolbar } from './ContentToolbar';
import { QueryBar } from './QueryBar';

type EditorState = { mode: EditorMode; id?: number };

export function CommandsContent({
  settings,
  updateSettings,
  catalogs,
  liveFilters,
}: {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  catalogs: Catalogs | null;
  liveFilters: ReturnType<typeof useLiveFilters>;
}) {
  const [commands, setCommands] = useState<Command[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Um valor por parâmetro do catálogo (não só os 9 hardcoded), resolvido
  // pela QueryBar a partir das tags confirmadas + o que está sendo
  // digitado — estado "lifted" aqui, exatamente como SimpleQueryFields.tsx
  // fazia na fatia 3a (mesmo contrato de shape; só a UI que o produz mudou).
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const collapsedSections = useCollapsedSections();
  const [editor, setEditor] = useState<EditorState | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCommands()
      .then(data => {
        if (!cancelled) {
          setCommands(data);
          setLoadError(false);
        }
      })
      .catch(err => {
        console.error('Failed to load commands from API', err);
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Callback de refresh passado pro CommandEditorModal (salvar/excluir) —
  // invalida o cache de fetchCommands() e busca a lista de novo, refletindo
  // na tela sem precisar de um reload de página.
  async function refreshCommands() {
    invalidateCommandsCache();
    try {
      const data = await fetchCommands();
      setCommands(data);
      setLoadError(false);
    } catch (err) {
      console.error('Failed to reload commands from API', err);
      setLoadError(true);
    }
  }

  const renderResult = useMemo(() => {
    if (!commands) return null;
    return buildRenderTree({ commands, filters: liveFilters.filters, settings, catalogs, fieldValues });
  }, [commands, liveFilters.filters, settings, catalogs, fieldValues]);

  // Todas as chaves de seção atualmente na árvore (tópico + ambiente +
  // agrupamentos de Created by/Versão) — usado por Expand all/Collapse all,
  // que no original recolhem/expandem TODOS os `.section` na tela
  // (collapseAllSections()/expandAllSections()), não só as seções de
  // Tópico.
  const allSectionKeys = useMemo(() => {
    if (!renderResult) return [];
    const keys: string[] = [];
    renderResult.comboBlocks.forEach(block => {
      if (block.groupBy === 'creator' && block.creatorGroups) {
        block.creatorGroups.forEach(g => {
          keys.push(g.key);
          g.sections.forEach(s => keys.push(s.key));
        });
      } else if (block.sections) {
        if (block.groupBy === 'version') keys.push(block.key);
        block.sections.forEach(s => keys.push(s.key));
      }
    });
    return keys;
  }, [renderResult]);

  function renderSection(sec: SectionData) {
    const collapsed = collapsedSections.isCollapsed(sec.key);
    const header = (
      <>
        {sec.icon ? `${sec.icon} ` : ''}
        {sec.title} <span className="sec-count">{sec.count}</span>
      </>
    );
    return (
      <CollapsibleSection
        key={sec.key}
        sectionKey={sec.key}
        headerContent={header}
        collapsed={collapsed}
        onToggleChevron={() => collapsedSections.toggle(sec.key)}
        renderBody={() =>
          sec.cards.map(c => (
            <CommandCard
              key={c.id}
              card={c}
              catalogs={catalogs}
              showImages={settings.showImages}
              onEdit={id => setEditor({ mode: 'edit', id })}
              onDuplicate={id => setEditor({ mode: 'duplicate', id })}
            />
          ))
        }
      />
    );
  }

  function renderComboBlock(block: ComboBlockData) {
    const comboHeader =
      block.showHeader && block.groupBy !== 'version' ? (
        <div className="combo-header">
          🔀 <strong>{block.versionLabel}</strong> / <strong>{block.envLabel}</strong>
        </div>
      ) : null;
    const envNote = block.envNoteHtml ? (
      <div className="env-note" dangerouslySetInnerHTML={{ __html: `ℹ️ <span>${block.envNoteHtml}</span>` }} />
    ) : null;

    if (block.groupBy === 'creator') {
      if (!block.creatorGroups || !block.creatorGroups.length) return null;
      return (
        <div key={block.key}>
          {comboHeader}
          {envNote}
          {block.creatorGroups.map(g => {
            const collapsed = collapsedSections.isCollapsed(g.key);
            return (
              <CollapsibleSection
                key={g.key}
                sectionKey={g.key}
                extraClass="section-creator"
                headerContent={
                  <>
                    👤 <strong>{g.creator}</strong> <span className="sec-count">{g.count}</span>
                  </>
                }
                collapsed={collapsed}
                onToggleChevron={() => collapsedSections.toggle(g.key)}
                renderBody={() => g.sections.map(renderSection)}
              />
            );
          })}
        </div>
      );
    }

    if (block.groupBy === 'version') {
      if (!block.cardCount) return null;
      const collapsed = collapsedSections.isCollapsed(block.key);
      return (
        <CollapsibleSection
          key={block.key}
          sectionKey={block.key}
          extraClass="section-version"
          headerContent={
            <>
              🔀 <strong>{block.versionLabel}</strong> / <strong>{block.envLabel}</strong> <span className="sec-count">{block.cardCount}</span>
            </>
          }
          collapsed={collapsed}
          onToggleChevron={() => collapsedSections.toggle(block.key)}
          renderBody={() => (
            <>
              {envNote}
              {(block.sections || []).map(renderSection)}
            </>
          )}
        />
      );
    }

    // "topic" (padrão)
    return (
      <div key={block.key}>
        {comboHeader}
        {envNote}
        {(block.sections || []).map(renderSection)}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="content" id="out">
        <div className="empty">
          <div className="empty-ico">⚠️</div>
          <p>Failed to load commands from the server. Check whether the backend is running.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`content${settings.showCardDetails ? '' : ' compact-cards'}`} id="out">
      <QueryBar onChange={setFieldValues} catalogs={catalogs} />
      <ContentToolbar
        groupBy={settings.groupBy}
        onChangeGroupBy={v => updateSettings({ groupBy: v })}
        onExpandAll={() => collapsedSections.expandAll(allSectionKeys)}
        onCollapseAll={() => collapsedSections.collapseAll(allSectionKeys)}
        onAddCommand={() => setEditor({ mode: 'create' })}
      />
      {renderResult?.truncatedNote && (
        <div className="env-note" style={{ borderColor: 'rgba(251,191,36,.3)', background: 'rgba(251,191,36,.06)', color: 'var(--yellow)' }}>
          ⚠️ <span>{renderResult.truncatedNote}</span>
        </div>
      )}
      {renderResult && renderResult.comboBlocks.map(renderComboBlock)}
      {renderResult?.noResults && (
        <div className="empty">
          <div className="empty-ico">🔍</div>
          <p>No commands found for "{liveFilters.filters.search}".</p>
        </div>
      )}
      {editor &&
        (editor.mode === 'create' || (commands && commands.some(c => c.id === editor.id))) &&
        // Portal pro <body> — `.main` (ancestral direto deste componente)
        // define `position: relative; z-index: 1` (ver comentário "─── MAIN
        // ───" em layout.css), o que cria um stacking context próprio e
        // prendia o `.modal-overlay` (z-index: 500) ABAIXO da `.sidebar`
        // (z-index: 10, num stacking context irmão) — diferente de
        // SettingsModal/ConfirmProvider, que já nascem como irmãos de
        // `.app` em AppShell.tsx, fora desse contexto. Sem o portal, a
        // sidebar ficava clicável por cima do editor (bug real, achado ao
        // rodar os testes desta fatia).
        createPortal(
          <CommandEditorModal
            mode={editor.mode}
            sourceRow={editor.mode === 'create' ? undefined : commands?.find(c => c.id === editor.id)}
            catalogs={catalogs}
            onClose={() => setEditor(null)}
            onSaved={refreshCommands}
          />,
          document.body
        )}
    </div>
  );
}
