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
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useSettings } from '../lib/settingsStore';
import { fetchCatalogs, type Catalogs } from '../lib/catalogs';
import { useFoldersView } from '../lib/foldersView';
import { useLiveFilters } from '../lib/liveFilters';
import { useLogo } from '../lib/useLogo';
import { usePersonalTheme } from '../lib/theme';
import { useUserDataSync } from '../lib/userDataSync';
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
  // Elevado pra este nível (fatia 8) — antes vivia inteiramente dentro de
  // Header.tsx (useLogo() chamado lá dentro, sem nenhum prop-drilling).
  // LogoSettingsModal (Settings → System → Logo) precisa poder empurrar um
  // `refresh` até o <img> do header depois de salvar/resetar — mas mora numa
  // outra ramificação da árvore (dentro de SettingsModal, não dentro de
  // Header), então as duas pontas só se encontram aqui, no ancestral comum.
  // Mesmo caminho já usado por catalogs/refreshCatalogs logo acima.
  const logo = useLogo();
  // Elevado pra este nível pelo MESMO motivo de `logo` acima (fatia 8): o
  // listener de 'storage' que usePersonalTheme() usa pra reagir ao
  // user-data sync (ver lib/theme.ts/lib/userDataSync.ts) só tem efeito
  // enquanto o hook está montado. Antes da fatia 8 ele só era chamado
  // dentro de PreferencesPane.tsx — um tema sincronizado de outro
  // navegador só era aplicado visualmente quando o usuário abria essa aba
  // por acaso. Elevado aqui (montado a sessão inteira, independente de
  // qual pane de Configurações está aberta, ou se alguma está), o tema
  // sincronizado é aplicado ao app assim que GET /api/user-data resolve —
  // achado e corrigido durante a verificação dos testes desta fatia.
  const personalTheme = usePersonalTheme();
  // Instala o lado "seed" do mecanismo de sincronização cross-browser (ver
  // lib/userDataSync.ts) — o monkey-patch de Storage.prototype.setItem já
  // foi instalado como import side-effect desse módulo; este hook só
  // dispara o GET /api/user-data inicial assim que o username resolve.
  useUserDataSync();

  // Extraída de dentro do useEffect (fatia 7) pra poder ser reaproveitada
  // tanto pela carga inicial quanto por um callback passado adiante até
  // CatalogAdminModal (SettingsModal -> CatalogPane -> CatalogAdminModal) —
  // qualquer mutação no catálogo (criar/editar/excluir vendor/system/etc.)
  // dispara esta mesma função de novo, atualizando IMEDIATAMENTE os dados
  // que alimentam a sidebar, o editor de comando e o resto do app. Mesmo
  // efeito de catAdminRefreshCatalogs() no original.
  const refreshCatalogs = useCallback(() => {
    return fetchCatalogs()
      .then(data => {
        setCatalogs(data);
      })
      .catch(e => {
        console.warn('Não foi possível carregar o catálogo', e);
      });
  }, []);

  useEffect(() => {
    refreshCatalogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <Header onOpenSettings={setSettingsOpen} logo={logo} />
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
            onCatalogsChanged={refreshCatalogs}
            settings={settings}
            updateSettings={update}
            onLogoChanged={logo.refresh}
            theme={personalTheme.theme}
            accent={personalTheme.accent}
            toggleTheme={personalTheme.toggleTheme}
            setAccent={personalTheme.setAccent}
          />
        )}
      </FolderPromptProvider>
    </ConfirmProvider>
  );
}
