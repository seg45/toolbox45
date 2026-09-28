// ════════════════════════════════════════════════
// App shell (Fase 3, fatia 2 + fatia 3a) — compõe Header + `.app` (Sidebar +
// área de conteúdo) + modal de Configurações. Mesma estrutura de DOM do
// index.html original: <header class="hdr"> é irmã de <div class="app">,
// não filha dela.
//
// A área principal (barra de parâmetros, toolbar "Group by"/"Add",
// `<div class="content" id="out">`) agora é CommandsContent.tsx (fatia 3a —
// motor de comandos, porta de js/query-bar.js (stopgap)/js/db-render-
// engine.js/js/render.js). CommandsContent É o próprio `.content#out`, não
// um filho dele.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useSettings } from '../lib/settingsStore';
import { fetchCatalogs, type Catalogs } from '../lib/catalogs';
import { useLiveFilters } from '../lib/liveFilters';
import { CommandsContent } from './commands/CommandsContent';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { SettingsModal, type SettingsPane } from './SettingsModal';

export function AppShell() {
  const auth = useAuth();
  const { settings, update } = useSettings();
  const liveFilters = useLiveFilters(settings);
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<SettingsPane | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCatalogs()
      .then(data => {
        if (!cancelled) setCatalogs(data);
      })
      .catch(e => {
        console.warn('Não foi possível carregar o catálogo', e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Enquanto /api/me não confirma a sessão, não renderiza nada do app —
  // mesma garantia "fail closed" do gate original (index.html só decide
  // deixar passar depois de saber que 'cpa-authenticated' está de
  // acordo), só que aqui cobre também o intervalo até a PRÓPRIA resposta
  // de /api/me chegar (o original não tinha essa segunda checagem — ver
  // comentário em lib/auth.tsx).
  if (auth.loading) {
    return <div style={{ padding: 32, color: 'var(--dim)' }}>Loading…</div>;
  }

  return (
    <>
      <Header onOpenSettings={setSettingsOpen} />
      <div className={`app${!settings.showSidebar ? ' sidebar-collapsed' : ''}`}>
        <Sidebar
          catalogs={catalogs}
          settings={settings}
          update={update}
          liveFilters={liveFilters}
          onToggleCollapsed={() => update({ showSidebar: !settings.showSidebar })}
        />
        <div className="main">
          <CommandsContent settings={settings} updateSettings={update} catalogs={catalogs} liveFilters={liveFilters} />
        </div>
      </div>
      {settingsOpen && (
        <SettingsModal
          pane={settingsOpen}
          onChangePane={setSettingsOpen}
          onClose={() => setSettingsOpen(null)}
          catalogs={catalogs}
          settings={settings}
          updateSettings={update}
        />
      )}
    </>
  );
}
