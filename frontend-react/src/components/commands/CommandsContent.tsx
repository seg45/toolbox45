// ════════════════════════════════════════════════
// Área principal de comandos — substitui o placeholder
// `<div class="content" id="out">{/* Preenchido pela fatia 3 */}</div>` de
// AppShell.tsx (este componente É o `.content#out`, não um filho dele).
//
// Orquestra: SimpleQueryFields (stopgap dos 9 campos + parâmetros
// customizados) + ContentToolbar (Group by / Expand all / Collapse all) +
// fetchCommands() (loading/erro) + renderPipeline.buildRenderTree() +
// a árvore de comboBlocks/sections/cards + a nota de truncamento de
// MAX_COMBOS + o estado vazio final de busca sem resultado.
//
// Porta de render() em js/render.js (a parte de orquestração/DOM — a lógica
// de dados já foi portada em renderPipeline.ts).
// ════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import type { Catalogs } from '../../lib/catalogs';
import { useCollapsedSections } from '../../lib/collapsedSections';
import { fetchCommands, type Command } from '../../lib/commands';
import type { useLiveFilters } from '../../lib/liveFilters';
import { buildRenderTree, type ComboBlockData, type SectionData } from '../../lib/renderPipeline';
import type { Settings } from '../../lib/settingsStore';
import { CollapsibleSection } from './CollapsibleSection';
import { CommandCard } from './CommandCard';
import { ContentToolbar } from './ContentToolbar';
import { SimpleQueryFields } from './SimpleQueryFields';

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
  // Os 9 campos hardcoded + parâmetros customizados (ver SimpleQueryFields.tsx) —
  // estado "lifted" simples, sem tags/histórico (isso é a fatia 3b).
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const collapsedSections = useCollapsedSections();

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
        renderBody={() => sec.cards.map(c => <CommandCard key={c.id} card={c} catalogs={catalogs} showImages={settings.showImages} />)}
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
      <SimpleQueryFields values={fieldValues} onChange={(k, v) => setFieldValues(prev => ({ ...prev, [k]: v }))} catalogs={catalogs} />
      <ContentToolbar
        groupBy={settings.groupBy}
        onChangeGroupBy={v => updateSettings({ groupBy: v })}
        onExpandAll={() => collapsedSections.expandAll(allSectionKeys)}
        onCollapseAll={() => collapsedSections.collapseAll(allSectionKeys)}
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
    </div>
  );
}
