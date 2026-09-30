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
//
// ConfirmProvider (fatia 4 — Editor de comandos, ver src/lib/useConfirm.tsx)
// monta a ÚNICA instância do modal de confirmação genérico da árvore, no
// mesmo nível que já envolve o modal de Configurações, pra poder ser
// chamada de qualquer componente filho via useConfirm() (o
// CommandEditorModal precisa dela pra "fechar sem salvar" E pra "excluir
// comando"; o CommandsContent, nesta fatia, reaproveita a mesma instância
// pra "excluir pasta").
//
// FolderPromptProvider (fatia 5a — Pastas, ver src/lib/useFolderPrompt.tsx)
// monta, no mesmo espírito, a ÚNICA instância do modal de nome de pasta
// (criar pasta/subpasta) — usado tanto pelo dropdown "+ New folder" de cada
// card (FolderMenu.tsx) quanto pelo "+ Add > Subfolder" do cabeçalho de uma
// seção de pasta (FolderSection.tsx), ambos dentro de CommandsContent.tsx.
//
// useFoldersView() (fatia 5a) fica aqui, ao lado de useSettings()/
// useLiveFilters() — mesmo padrão de estado "lifted" pro nível mais alto
// que precisa compartilhá-lo: a Sidebar precisa saber se a visão está ativa
// (classe "on" da linha "Folders" + o próprio clique que a liga/desliga) e
// CommandsContent precisa saber o mesmo valor pra decidir o que renderizar.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useSettings } from '../lib/settingsStore';
import { fetchCatalogs, type Catalogs } from '../lib/catalogs';
import { useFoldersView } from '../lib/foldersView';
import { useLiveFilters } from '../lib/liveFilters';
import { ConfirmProvider } from '../lib/useConfirm';
import { FolderPromptProvider } from '../lib/useFolderPrompt';
import { CommandsContent } from './commands/CommandsContent';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { SettingsModal, type SettingsPane } from './SettingsModal';

export function AppShell() {
  const auth = useAuth();
  const { settings, update } = useSettings();
  const liveFilters = useLiveFilters(settings);
  const foldersView = useFoldersView(settings);
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
    <ConfirmProvider>
      <FolderPromptProvider>
        <Header onOpenSettings={setSettingsOpen} />
        <div className={`app${!settings.showSidebar ? ' sidebar-collapsed' : ''}`}>
          <Sidebar
            catalogs={catalogs}
            settings={settings}
            update={update}
            liveFilters={liveFilters}
            foldersView={foldersView}
            onToggleCollapsed={() => update({ showSidebar: !settings.showSidebar })}
          />
          <div className="main">
            <CommandsContent
              settings={settings}
              updateSettings={update}
              catalogs={catalogs}
              liveFilters={liveFilters}
              foldersView={foldersView}
            />
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
      </FolderPromptProvider>
    </ConfirmProvider>
  );
}
