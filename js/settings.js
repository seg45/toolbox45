// ════════════════════════════════════════════════
// CONFIGURAÇÕES DO USUÁRIO (persistidas em localStorage)
// ════════════════════════════════════════════════
const SETTINGS_KEY = 'cpa-settings';
const DEFAULT_SETTINGS = {
  home: 'menu', vendor: [], sys: [], version: [], env: [], type: [],
  // Padrão usa $(hostname) — substituição de shell resolvida pelo próprio
  // gateway Check Point ao rodar o comando exportado (não pelo app), então
  // já nasce nomeando o arquivo por equipamento (pedido do usuário).
  logFile: '/tmp/$(hostname).txt',
  showCardDetails: false,
  enableCommandEditing: false,
  exportEnabled: false,
  showImages: false,
  showSidebar: true,
  groupBy: 'topic',
  // Sempre desabilitado por padrão para quem ainda não tem preferência
  // própria salva (ver applyGlobalDefaultsIfNeeded() mais abaixo) — não é
  // mais configurável por um default de organização; quem quiser habilitar
  // faz isso na própria tela de User preferences. Todas as 4 preferências
  // do grupo "Default settings" do modal (Dark mode, Details, Export, System
  // commands) começam desabilitadas por padrão, a pedido do usuário.
  showSystemCommands: false,
};

// Ligado/desligado ao vivo por terminal-renderer.js (card()) para decidir se mostra o
// ícone de editar em cada card — atualizado só por applyCommandEditingSetting().
// O antigo toggle "Admin mode" foi removido: este flag agora é sempre `true`
// (ver applyDefaultsFromSettings() mais abaixo), mantido só para não quebrar
// a checagem defensiva já existente em js/catalog-admin.js (openCatalogAdmin).
let COMMAND_EDITING_ENABLED = true;

// Lido por render.js para decidir a unidade de agrupamento recolhível: 'topic' (padrão —
// uma seção por Tópico, comportamento de sempre) ou 'version' (um bloco recolhível por
// combinação Versão/Ambiente, com as seções de Tópico aninhadas dentro).
let GROUP_BY = 'topic';

// Normaliza um valor de configuração multi-seleção: aceita string única (formato antigo,
// pré-multi-seleção) ou array. Também remove a sentinela 'all' (formato antigo, de antes
// da remoção do item mestre 'Todos' das listas — ver js/state.js) de qualquer valor já
// salvo no localStorage de uma sessão anterior: hoje ela não existe mais, e o
// equivalente exato é a seleção vazia (sem filtro, mostra tudo).
function normalizeMultiSetting(val, fallback) {
  if (val === undefined || val === null) return fallback.slice();
  if (!Array.isArray(val)) return val ? [val] : []; // string única (formato antigo) vira array
  return val.filter(v => v !== 'all'); // já é array — respeita como está, inclusive vazio (seleção vazia é válida)
}
// LAST_VIEW_KEY — memoriza a visão de navegação atual (Folders vs. menu
// normal de comandos), separada da preferência "Home page" (`s.home`) do
// modal de Configurações. Bug reportado: "estou em folders e quando
// atualizo a página está voltando para tela de comandos" — antes disso,
// VIEW_FOLDERS_HOME (js/folders.js) só existia derivada de `s.home`, tanto
// na leitura fria inicial (folders.js) quanto em applyDefaultsFromSettings()
// abaixo (chamada de novo por reapplyAfterUserSync() em user-sync.js) — ou
// seja, um F5 sempre voltava pra "Home page" configurada, mesmo que o
// usuário estivesse navegando em Folders só naquela sessão (sem ter mudado
// a preferência permanente). Agora, toda vez que o usuário entra/sai de
// Folders por uma ação explícita (clique em "Folders" na sidebar —
// viewAllFolders() — ou no nome/logo do app — goHome()), a visão resultante
// é gravada aqui; resolveFoldersHome() prioriza esse valor sobre `s.home`
// sempre que ele existir, e só cai pro "Home page" configurado na
// primeira visita (localStorage ainda vazio neste navegador).
const LAST_VIEW_KEY = 'cpa-last-view';
function persistLastView(isFolders) {
  try { localStorage.setItem(LAST_VIEW_KEY, isFolders ? 'folders' : 'menu'); } catch (e) {}
}
function resolveFoldersHome(s) {
  try {
    const saved = localStorage.getItem(LAST_VIEW_KEY);
    if (saved === 'folders') return true;
    if (saved === 'menu') return false;
  } catch (e) {}
  return s.home === 'folders';
}

// FOLDER_SCOPE_KEY — memoriza o escopo de pastas escolhido dentro de Folders
// ("My folders" / "All" / um usuário específico — ver #folderScopeDD e
// setFolderScope() em js/folders.js), pelo mesmo motivo de LAST_VIEW_KEY
// acima. Bug reportado: "estou em folders exibindo todas as pastas, mas
// quando atualizo a página está voltando o filtro para my folders" — antes,
// FOLDER_SCOPE era deliberadamente só em memória (comentário original: "não
// precisa sobreviver a um reload da página", mesma decisão que ainda vale
// para FOLDER_EDIT_MODE, que é um modo transitório de edição, não um
// filtro). Diferente de FOLDER_EDIT_MODE, o usuário pode legitimamente
// querer continuar vendo "All" (ou as pastas de um colega específico) depois
// de um F5 — então persiste, mesmo padrão de LAST_VIEW_KEY.
const FOLDER_SCOPE_KEY = 'cpa-folder-scope';
function persistFolderScope(scope) {
  try { localStorage.setItem(FOLDER_SCOPE_KEY, scope || 'mine'); } catch (e) {}
}
function resolveFolderScope() {
  try {
    const saved = localStorage.getItem(FOLDER_SCOPE_KEY);
    if (saved) return saved;
  } catch (e) {}
  return 'mine';
}
function loadSettings() {
  let s = Object.assign({}, DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) s = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (e) {}
  // Compatibilidade: versões antigas salvavam version/env/type como string única — normaliza para array.
  s.type = normalizeMultiSetting(s.type, DEFAULT_SETTINGS.type);
  s.version = normalizeMultiSetting(s.version, DEFAULT_SETTINGS.version);
  s.env = normalizeMultiSetting(s.env, DEFAULT_SETTINGS.env);
  s.vendor = normalizeMultiSetting(s.vendor, DEFAULT_SETTINGS.vendor);
  s.sys = normalizeMultiSetting(s.sys, DEFAULT_SETTINGS.sys);
  return s;
}
function persistSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}
function setActiveRow(listId, attr, val) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.querySelectorAll('.sb-row').forEach(r => r.classList.remove('on'));
  const row = list.querySelector(`[${attr}="${val}"]`);
  if (row) row.classList.add('on');
}
// Marca como ativas todas as linhas cujo valor esteja no array `vals` (multi-seleção,
// sem item mestre 'all' — ver js/state.js).
function setActiveRowsMulti(listId, attr, vals) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.querySelectorAll('.sb-row').forEach(r => {
    r.classList.toggle('on', vals.includes(r.getAttribute(attr)));
  });
}
function gvSet(id, val) { const el = document.getElementById(id); if (el) el.value = val; }

// ── Preferências de commit instantâneo (aplicam e persistem na hora, sem esperar
// o botão 'Salvar' do modal — mesmo padrão já usado por tema e idioma) ──────────

// Mostra/oculta descrição curta, bloco 'about' (finalidade/quando usar/observação) e tags
// do cabeçalho de cada card, conforme a preferência 'showCardDetails' (tela menos poluída).
function applyCardDetailsSetting(show) {
  document.body.classList.toggle('compact-cards', !show);
}
// Reflete o estado atual (ligado/desligado) no toggle da sidebar E no toggle compacto
// equivalente do modal de Configurações (mDescToggle).
function syncShowDetailsToggleUI(show) {
  const side = document.getElementById('tog-details');
  if (side) side.classList.toggle('on', show);
  const modal = document.getElementById('mDescToggle');
  if (modal) modal.classList.toggle('on', show);
}
function setShowCardDetails(show) {
  applyCardDetailsSetting(show);
  syncShowDetailsToggleUI(show);
  const s = loadSettings();
  s.showCardDetails = show;
  persistSettings(s);
}
function toggleShowCardDetails() {
  setShowCardDetails(!(loadSettings().showCardDetails === true));
}
// Toggle compacto (Descrição) do modal de Configurações — mesma preferência do
// toggle 'Descrição' da sidebar (tog-details), só que com commit instantâneo aqui também.
function toggleModalDesc() {
  setShowCardDetails(!(loadSettings().showCardDetails === true));
}

// Mostra/oculta os comandos System (created_by='System' — ver is_system em
// server/index.js: shapeCommand) da tela, conforme a preferência
// 'showSystemCommands' (toggle "System commands" na sidebar, seção Options).
// A filtragem de verdade acontece em render.js, sobre o array vindo de
// fetchCommands(); aqui só guardamos a flag viva e refletimos no toggle.
let SHOW_SYSTEM_COMMANDS = false;
function applyShowSystemCommandsSetting(show) {
  SHOW_SYSTEM_COMMANDS = show !== false;
  if (typeof render === 'function') render();
}
// Reflete o estado atual no toggle da sidebar E no espelho do modal de
// Configurações (mSystemCommandsToggle) — mesmo padrão de
// syncShowDetailsToggleUI/mDescToggle acima.
function syncShowSystemCommandsToggleUI(show) {
  const side = document.getElementById('tog-system-commands');
  if (side) side.classList.toggle('on', show !== false);
  const modal = document.getElementById('mSystemCommandsToggle');
  if (modal) modal.classList.toggle('on', show !== false);
}
function setShowSystemCommands(show) {
  applyShowSystemCommandsSetting(show);
  syncShowSystemCommandsToggleUI(show);
  const s = loadSettings();
  s.showSystemCommands = show !== false;
  persistSettings(s);
}
function toggleShowSystemCommands() {
  setShowSystemCommands(!(loadSettings().showSystemCommands !== false));
}
// Toggle compacto (System commands) do modal de Configurações — mesma
// preferência pessoal do toggle "System commands" da sidebar (tog-system-
// commands), com commit instantâneo aqui também (igual toggleModalDesc()).
function toggleModalSystemCommands() {
  setShowSystemCommands(!(loadSettings().showSystemCommands !== false));
}

// Liga/desliga o redirecionamento (template escolhido no catalogo Exports)
// anexado as linhas de comando com export_template definido -- ver
// dbLineToTerm em db-render-engine.js, que le values.FL.log/values.logFile.
// Antes era um flag puramente de sessao (FL.log via togFlag('log'), em
// js/state.js); agora e uma preferencia persistida igual a
// Description/System commands -- FL.log continua sendo o valor "ao vivo"
// que o motor de render consome, so que
// inicializado e mantido a partir daqui em vez de sempre começar em false.
function applyExportSetting(enabled) {
  FL.log = !!enabled;
  const fw = document.getElementById('fw-log');
  if (fw) fw.classList.toggle('show', FL.log);
  if (typeof render === 'function') render();
}
// Reflete o estado atual no toggle da sidebar E no espelho do modal de
// Configurações (mExportToggle) — mesmo padrão de
// syncShowDetailsToggleUI/syncShowSystemCommandsToggleUI acima.
function syncExportToggleUI(enabled) {
  const side = document.getElementById('tog-log');
  if (side) side.classList.toggle('on', !!enabled);
  const modal = document.getElementById('mExportToggle');
  if (modal) modal.classList.toggle('on', !!enabled);
}
function setExportEnabled(enabled) {
  applyExportSetting(enabled);
  syncExportToggleUI(enabled);
  const s = loadSettings();
  s.exportEnabled = !!enabled;
  persistSettings(s);
}
function toggleExportEnabled() {
  setExportEnabled(!(loadSettings().exportEnabled === true));
}
// Toggle compacto (Export) do modal de Configurações — mesma preferência
// pessoal do toggle "Export" da sidebar (tog-log), com commit instantâneo
// aqui também (igual toggleModalDesc()/toggleModalSystemCommands()).
function toggleModalExport() {
  setExportEnabled(!(loadSettings().exportEnabled === true));
}

// Mostra/oculta a miniatura das linhas do tipo 'image' direto no card (ver
// .ln-image-inline em components.css e a renderização condicional em
// termRender(), js/terminal-renderer.js), conforme a preferência
// 'showImages' — quando desligada (padrão), a imagem só aparece ao clicar
// no badge "[Image]# ...", como já era antes desta preferência existir.
let SHOW_IMAGES = false;
function applyShowImagesSetting(show) {
  SHOW_IMAGES = show === true;
  if (typeof render === 'function') render();
}
// Reflete o estado atual no toggle da sidebar (tog-show-images, seção
// Options) E no espelho do modal de Configurações (mShowImagesToggle) —
// mesmo padrão de syncShowDetailsToggleUI/syncExportToggleUI/
// syncShowSystemCommandsToggleUI acima.
function syncShowImagesToggleUI(show) {
  const side = document.getElementById('tog-show-images');
  if (side) side.classList.toggle('on', show === true);
  const modal = document.getElementById('mShowImagesToggle');
  if (modal) modal.classList.toggle('on', show === true);
}
function setShowImages(show) {
  applyShowImagesSetting(show);
  syncShowImagesToggleUI(show);
  const s = loadSettings();
  s.showImages = show === true;
  persistSettings(s);
}
// Toggle da sidebar (Options) — mesma preferência do espelho no modal
// (toggleModalShowImages), commit instantâneo igual aos demais toggles
// desta seção (toggleShowCardDetails/toggleExportEnabled/
// toggleShowSystemCommands).
function toggleShowImages() {
  setShowImages(!(loadSettings().showImages === true));
}
// Toggle compacto (Show images) do modal de Configurações — mesma
// preferência pessoal do toggle "Show images" da sidebar (tog-show-images).
function toggleModalShowImages() {
  setShowImages(!(loadSettings().showImages === true));
}

// Fixa ou colapsa a barra lateral esquerda (nav.sidebar) — preferência
// 'showSidebar': true = fixa (pinned, largura normal, como sempre foi);
// false = COLAPSADA numa barra estreita só com ícones por seção (ver
// .sb-head-icon em css/layout.css). Não expande mais ao passar o mouse
// (flyout removido a pedido do usuário) — fica colapsada até o botão ser
// clicado de novo. Aplica/remove a classe 'sidebar-collapsed' em
// <div class="app"> (ver css/layout.css). Acionada só pelo botão único
// #sbDividerToggle (ver index.html/.sb-divider-toggle em css/layout.css),
// sentado em cima da linha de divisão entre sidebar e conteúdo — não tem
// espelho no modal de Configurações (removido a pedido do usuário: não fazia
// sentido duplicar um controle que já é sempre visível e de um clique só).
let SHOW_SIDEBAR = true;
function applyShowSidebarSetting(show) {
  SHOW_SIDEBAR = show === true;
  const app = document.querySelector('.app');
  if (app) app.classList.toggle('sidebar-collapsed', !SHOW_SIDEBAR);
}
function setShowSidebar(show) {
  applyShowSidebarSetting(show);
  const s = loadSettings();
  s.showSidebar = show === true;
  persistSettings(s);
}
// Botão único #sbDividerToggle chama isto direto (ver index.html).
function toggleShowSidebar() {
  setShowSidebar(!(loadSettings().showSidebar === true));
}

// ── Default para "System commands" de quem AINDA não tem preferência
// própria salva ─────────────────────────────────────────────────────────
// Antes era configurável por um toggle de "default de organização" (Settings
// → System, salvo via GET/PUT /api/global-settings) — removido a pedido do
// usuário: agora é sempre `false` (desabilitado). Quem quiser ligar decide
// isso na própria tela de User preferences (ver hasExplicitSetting abaixo —
// depois que a pessoa mexe no toggle da sidebar, a escolha dela passa a
// valer sempre, independente deste default).
function hasExplicitSetting(key) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return false;
    return Object.prototype.hasOwnProperty.call(JSON.parse(raw), key);
  } catch (e) { return false; }
}
// Chamado uma vez no boot (ver fim deste arquivo).
function applyGlobalDefaultsIfNeeded() {
  if (!hasExplicitSetting('showSystemCommands')) {
    setShowSystemCommands(false);
  }
}

// Botão '+ Adicionar comando' e o ícone de editar de cada card ficam sempre
// visíveis para todo usuário — o antigo toggle "Admin mode" que controlava
// isso (enableCommandEditing) foi removido; esta função é chamada uma única
// vez no boot (ver applyDefaultsFromSettings()) só para manter
// COMMAND_EDITING_ENABLED coerente com a classe do body.
function applyCommandEditingSetting(enabled) {
  COMMAND_EDITING_ENABLED = !!enabled;
  document.body.classList.toggle('hide-command-editing', !enabled);
  if (typeof render === 'function') render(); // reconstrói os cards para (des)aparecer o lápis de editar
}

// Agrupamento do resultado: 'topic' (uma seção recolhível por Tópico —
// padrão), 'version' (um bloco recolhível por Versão/Ambiente, com as seções
// de Tópico aninhadas), ou 'creator' (um bloco recolhível por quem cadastrou
// o comando — created_by —, também com as mesmas seções de Tópico aninhadas
// dentro de cada autor; ver uso em js/render.js). 'creator' fica escondido
// do dropdown enquanto o usuário está em Folders (VIEW_FOLDERS_HOME — ver
// updateGroupByOptionsForFoldersScope() em js/folders.js), então não precisa
// de tratamento especial aqui.
// 'my-folders'/'user-folders' (rotulados "Folders"/"User folders") EXISTIRAM
// aqui — removidos (a pedido do usuário): a mesma visão hoje é só a seção
// "Folders" da sidebar + o seletor de escopo, então normalizeGroupBy()
// migra qualquer preferência salva com esses valores antigos de volta pra
// 'topic' automaticamente (mesmo mecanismo de fallback de sempre pra
// qualquer valor não reconhecido).
function normalizeGroupBy(mode) {
  return ['version', 'creator'].includes(mode) ? mode : 'topic';
}
function applyGroupBySetting(mode) {
  GROUP_BY = normalizeGroupBy(mode);
  if (typeof render === 'function') render();
}
// Texto mostrado no botão dropdown "Group by" (barra de ferramentas) —
// mantido em sincronia com GROUP_BY sempre que ele muda.
function groupByLabel(mode) {
  return mode === 'version' ? 'Version' : mode === 'creator' ? 'Created by' : 'Topic';
}
function syncGroupByToggleUI(mode) {
  const wrap = document.getElementById('groupByToggle');
  if (wrap) wrap.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b.dataset.val === mode));
  const btn = document.getElementById('groupByDDBtn');
  const label = btn && btn.querySelector('.dd-label');
  if (label) label.textContent = groupByLabel(mode);
}
function setGroupBy(mode) {
  applyGroupBySetting(mode);
  syncGroupByToggleUI(mode);
  // Dropdown de seleção única (barra de ferramentas) — fecha ao escolher,
  // mesmo padrão já usado pelo dropdown equivalente do modal de Configurações
  // (ver ['mHome','mGroupBy'].forEach em js/settings-modal.js).
  const dd = document.getElementById('groupByDD');
  if (dd) dd.classList.remove('open');
  if (typeof setSegActive === 'function') setSegActive('mGroupBy', GROUP_BY);
  if (typeof updateModalSingleLabel === 'function') updateModalSingleLabel('mGroupBy', 'mGroupByDDBtn');
  const s = loadSettings();
  s.groupBy = GROUP_BY;
  persistSettings(s);
}

// Aplica as preferências salvas ao estado vivo da ferramenta (chamado no boot)
function applyDefaultsFromSettings() {
  const s = loadSettings();
  // resolveSidebarFilters() (js/state.js) prioriza o filtro AO VIVO que o
  // usuário deixou selecionado na sidebar (localStorage 'cpa-sidebar-filters')
  // sobre o "default" configurado aqui em s.vendor/s.sys/s.version/s.env/
  // s.type — bug reportado: "ao atualizar a tela os filtros estão sendo
  // limpos". Só cai pro default quando não há nada salvo ainda (primeira
  // visita deste navegador). Mesmo valor também traz de volta o texto da
  // busca de comandos (#cmdSearch), se houver.
  const filters = typeof resolveSidebarFilters === 'function'
    ? resolveSidebarFilters({ vd: s.vendor, sys: s.sys, v: s.version, e: s.env, t: s.type })
    : { vd: s.vendor, sys: s.sys, v: s.version, e: s.env, t: s.type, q: '' };
  ST.vd = filters.vd; ST.sys = filters.sys; ST.v = filters.v; ST.e = filters.e; ST.t = filters.t;
  setActiveRowsMulti('vendorList', 'data-vd', filters.vd);
  setActiveRowsMulti('sysList', 'data-sys', filters.sys);
  setActiveRowsMulti('vList', 'data-v', filters.v);
  setActiveRowsMulti('eList', 'data-e', filters.e);
  setActiveRowsMulti('tList', 'data-t', filters.t);
  updateVendorDDLabel();
  updateSystemDDLabel();
  updateVersionDDLabel();
  updateEnvDDLabel();
  updateTypeDDLabel();
  if (filters.q) {
    gvSet('cmdSearch', filters.q);
    if (typeof updateSearchClearBtn === 'function') updateSearchClearBtn();
    // Dispara o mesmo caminho de uma digitação normal (onSearchInput ->
    // applySearchFilter debounced) em vez de chamar applySearchFilter()
    // direto — nesse ponto do boot os comandos ainda podem não ter chegado
    // do servidor (fetch assíncrono), então o debounce de 120ms dá tempo do
    // primeiro render() já ter colocado os cards no DOM antes do filtro
    // rodar. Mesmo espírito "best-effort" já usado pelo resto do boot.
    const input = document.getElementById('cmdSearch');
    if (input && typeof onSearchInput === 'function') input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (typeof ccRefreshCascade === 'function') ccRefreshCascade();
  gvSet('f-log', s.logFile);
  applyCardDetailsSetting(s.showCardDetails === true);
  syncShowDetailsToggleUI(s.showCardDetails === true);
  applyShowSystemCommandsSetting(s.showSystemCommands !== false);
  syncShowSystemCommandsToggleUI(s.showSystemCommands !== false);
  applyExportSetting(s.exportEnabled === true);
  syncExportToggleUI(s.exportEnabled === true);
  applyShowImagesSetting(s.showImages === true);
  syncShowImagesToggleUI(s.showImages === true);
  applyShowSidebarSetting(s.showSidebar !== false);
  // Admin mode removido — incluir/duplicar/editar comandos, catálogos e
  // import/export ficam sempre disponíveis, independente de qualquer
  // preferência salva (ver DEFAULT_SETTINGS acima e Configurações → System).
  applyCommandEditingSetting(true);
  GROUP_BY = normalizeGroupBy(s.groupBy); // sem render() aqui — render() inicial ainda vai rodar
  syncGroupByToggleUI(GROUP_BY);
  // Home page = "Folders" (bug reportado: configurar isso não abria a visão
  // de pastas). VIEW_FOLDERS_HOME (js/folders.js) só era calculada a partir
  // de `s.home` UMA vez, na leitura "fria" do localStorage feita no parse de
  // folders.js (antes de qualquer resposta de rede) — quando o usuário
  // acessa de um navegador/máquina diferente daquele onde salvou a
  // preferência, esse localStorage local ainda está vazio/default ('menu'),
  // e quando os dados reais do servidor chegam (ver reapplyAfterUserSync()
  // em js/user-sync.js, que chama esta função de novo) nada recalculava
  // VIEW_FOLDERS_HOME — ela ficava congelada em `false`. `typeof` guard: na
  // primeira chamada (fim deste arquivo, síncrona) folders.js ainda não
  // rodou e a variável não existe ainda; a chamada de user-sync.js roda
  // depois de todo script já ter carregado, e antes do render()/
  // reloadFoldersFromServer() que a usam. resolveFoldersHome() (acima)
  // prioriza a visão atual memorizada (LAST_VIEW_KEY) sobre `s.home` — sem
  // isso, esta chamada feita por reapplyAfterUserSync() a cada F5 sempre
  // sobrescrevia de volta pro "Home page" configurado, mesmo que o usuário
  // estivesse em Folders só por navegação (bug: "estou em folders e quando
  // atualizo a página está voltando para tela de comandos").
  if (typeof VIEW_FOLDERS_HOME !== 'undefined') {
    VIEW_FOLDERS_HOME = resolveFoldersHome(s);
    const nav = document.getElementById('foldersNavRow');
    if (nav) nav.classList.toggle('on', VIEW_FOLDERS_HOME);
    if (typeof updateGroupByOptionsForFoldersScope === 'function') updateGroupByOptionsForFoldersScope();
  }
}
applyDefaultsFromSettings();
// Assíncrono, best-effort — não atrasa a primeira pintura da tela (mesmo
// espírito de initUserSync() em user-sync.js); só ajusta e re-renderiza
// depois se este usuário ainda não tiver escolhido "System commands" por
// conta própria (ver hasExplicitSetting).
applyGlobalDefaultsIfNeeded();
