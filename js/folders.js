// ════════════════════════════════════════════════
// FOLDERS — substitui a antiga feature "Favorites" (ver server/index.js:
// folders/folder_commands, e a migração de dados em server/db.js). Cada
// usuário organiza comandos em pastas PRÓPRIAS (nome livre) e um mesmo
// comando pode estar em várias pastas ao mesmo tempo. Diferente do antigo
// esquema de favoritos, pastas são privadas — não existe mais uma contagem/
// lista de "quem mais favoritou" visível entre usuários (ver
// server/index.js: shapeCommand()'s folder_ids, que só reflete as pastas do
// usuário que está olhando a tela).
//
// FOLDERS é um array vivo (não um Set, já que cada item carrega nome/id além
// da membership): [{ id, name, sort_order, command_ids: Set<string> }, ...].
// Carregado do servidor (reloadFoldersFromServer(), chamado por
// js/user-sync.js depois que o usuário é identificado) e mantido atualizado
// localmente de forma otimista a cada criação/renomeação/exclusão de pasta
// ou mudança de membership — sem esperar round-trip do servidor para a UI
// responder (mesmo princípio do antigo toggleFavorite()).
// ════════════════════════════════════════════════
let FOLDERS = [];

// Converte uma lista PLANA de pastas (cada uma com `parent_id`, ver
// reloadFoldersFromServer/reloadAllUsersFoldersFromServer) numa árvore —
// usada por render.js para desenhar cada subpasta ANINHADA dentro da seção
// da sua pasta-mãe (aninhamento ilimitado, pedido do usuário), em vez de uma
// lista plana onde só um campo escondido indicaria o pai. `roots` são as
// pastas de topo (parent_id nulo OU cujo "pai" não está nesta mesma lista —
// isso importa no ramo "user:<username>"/"all" de FOLDER_SCOPE, ver
// render.js, onde `list` já vem filtrada para as pastas de UM dono: uma
// subpasta cujo pai pertencesse a outro dono nunca deveria existir de
// verdade — parent_id só é setado entre pastas do MESMO usuário, ver POST
// /api/folders em server/index.js — mas a checagem aqui evita que a pasta
// suma da tela por engano caso isso algum dia aconteça). `childrenOf(id)`
// devolve os filhos diretos de uma pasta, já ordenados, prontos para a
// chamada recursiva de quem está montando a seção.
//
// Ordenação (pedido do usuário, ver print anexado): as pastas de TOPO
// (roots) mostram sempre "Favorites" primeiro (mesma pasta padrão protegida
// de FAVORITES_FOLDER_NAME em server/index.js — aqui não dá pra importar
// essa constante, então repetimos o literal), e as demais em ordem
// alfabética — independente de sort_order, que pra pastas de topo nem é
// gerenciado pelo usuário. Já as SUBPASTAS (qualquer grupo com pid != null)
// usam sort_order (ordem manual, arraste-e-solte — ver _fldArmDrag/
// persistFolderContainerOrder abaixo, e PUT /api/folders/:id/reorder com
// type:'folder' em server/index.js): uma subpasta nova entra com
// sort_order NEGATIVO (MIN-1, ver POST /api/folders) pra aparecer no topo
// da pasta-mãe, e o usuário pode reordenar as demais livremente depois. O
// desempate por nome (quando sort_order é igual, ex.: instalações
// existentes antes desta feature, todas com sort_order 0) mantém um
// resultado previsível em vez de depender da ordem de retorno do banco.
function buildFolderTree(list) {
  const ids = new Set((list || []).map(f => f.id));
  const byParent = new Map();
  (list || []).forEach(f => {
    const pid = (f.parent_id && ids.has(f.parent_id)) ? f.parent_id : null;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(f);
  });
  const roots = byParent.get(null) || [];
  roots.sort((a, b) => {
    const aFav = a.name === 'Favorites', bFav = b.name === 'Favorites';
    if (aFav !== bFav) return aFav ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  byParent.forEach((arr, pid) => {
    if (pid === null) return; // roots já ordenadas acima (regra diferente: Favorites-primeiro)
    arr.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  });
  return { roots, childrenOf: id => byParent.get(id) || [] };
}

// VIEW_FOLDERS_HOME = visão "Folders" ativa (home page ou clique em
// #foldersNavRow) — mostra todo comando que esteja em QUALQUER pasta do
// usuário, uma seção recolhível por pasta (ver buildFolderSection em
// db-render-engine.js), mesmo estilo visual dos Tópicos. Não existe mais
// navegação por pasta individual pela sidebar (ela não lista mais as pastas
// — a pedido do usuário; renomear/excluir uma pasta agora é feito no
// cabeçalho da própria seção, ver .sec-folder-actions em components.css).
// resolveFoldersHome() (js/settings.js) prioriza a última visão memorizada
// (localStorage 'cpa-last-view', gravada por viewAllFolders()/goHome()
// abaixo) sobre a preferência "Home page" — bug reportado: "estou em
// folders e quando atualizo a página está voltando para tela de comandos".
let VIEW_FOLDERS_HOME = resolveFoldersHome(loadSettings());
(() => { const row = document.getElementById('foldersNavRow'); if (row) row.classList.toggle('on', VIEW_FOLDERS_HOME); })();

// FOLDER_SCOPE precisa existir ANTES de updateGroupByOptionsForFoldersScope()
// ser definida/chamada mais abaixo — bug reportado: "atualizo a tela em
// Folders e pastas/comandos somem, e alternar não volta a mostrar". Causa:
// updateGroupByOptionsForFoldersScope() é chamada uma vez, incondicionalmente,
// no carregamento do script (ver mais abaixo); com VIEW_FOLDERS_HOME já true
// no boot (ver resolveFoldersHome()/'cpa-last-view' acima), ela entra no `if
// (VIEW_FOLDERS_HOME)` e chama renderFolderScopeOptions() de forma SÍNCRONA
// — que lê `FOLDER_SCOPE` diretamente. Como esse `let` estava declarado
// bem mais abaixo no arquivo (dead zone temporal até sua própria linha
// rodar), isso lançava "ReferenceError: Cannot access 'FOLDER_SCOPE' before
// initialization" e abortava o resto da execução do script — deixando toda
// função declarada depois (viewAllFolders, toggleCommandInFolder, editor de
// notas/comandos etc.) indefinida pro resto da sessão, até um F5 sem
// VIEW_FOLDERS_HOME=true no boot rodar o arquivo inteiro de novo sem cair
// nesse ramo. Declarar aqui, antes de qualquer função que a use, resolve.
// Valor inicial vem de resolveFolderScope() (js/settings.js, 'cpa-folder-
// scope') — bug reportado: "estou em folders exibindo todas as pastas, mas
// quando atualizo a página está voltando o filtro para my folders". Ver
// persistFolderScope() em setFolderScope() mais abaixo.
let FOLDER_SCOPE = resolveFolderScope();

// Busca as pastas reais do usuário atual no servidor e substitui FOLDERS —
// chamado uma vez no boot (via user-sync.js) depois que o usuário é
// identificado; pode ser chamado de novo a qualquer momento para
// re-sincronizar (ex.: mesma pessoa com duas abas abertas).
async function reloadFoldersFromServer() {
  try {
    const res = await fetch('/api/folders');
    const data = await res.json();
    // `order` (task #458, estendido pela task Notes) já vem do servidor
    // como um array combinado {type:'command'|'note', id} na ordem certa
    // (ver GET /api/folders em server/index.js) — comandos E notas
    // intercalados, não mais só command_ids. `notes` (task Notes) é a
    // lista de notas da pasta, cada uma já com folder_id/title/description.
    // `command_ids` continua um Set (checagem de membership O(1), usada em
    // toda parte) — Sets não preservam posição, por isso `order` é mantido
    // separado.
    FOLDERS = (data || []).map(f => ({
      id: f.id, name: f.name, sort_order: f.sort_order, parent_id: f.parent_id || null,
      command_ids: new Set(f.command_ids || []),
      notes: f.notes || [],
      order: (f.order || []).slice(),
    }));
    if (typeof render === 'function') render();
  } catch (e) {
    console.warn('Não foi possível carregar as pastas do servidor', e);
  }
}

// ALL_USERS_FOLDERS = pastas de TODOS os usuários (cross-user, ver
// GET /api/folders/all em server/index.js) — usada pelo seletor de escopo de
// pastas dentro de Folders (#folderScopeDD: "All"/um usuário escolhido, ver
// FOLDER_SCOPE abaixo). Diferente de FOLDERS acima (privado, só as pastas do
// usuário atual), aqui cada item já vem com `username` do dono. Carregada
// sob demanda (ao entrar em Folders, ver updateGroupByOptionsForFoldersScope())
// em vez de sempre no boot, já que a maioria fica em "My folders" (padrão).
let ALL_USERS_FOLDERS = [];
async function reloadAllUsersFoldersFromServer() {
  try {
    const res = await fetch('/api/folders/all');
    const data = await res.json();
    ALL_USERS_FOLDERS = (data || []).map(f => ({
      id: f.id, username: f.username, name: f.name, sort_order: f.sort_order, parent_id: f.parent_id || null,
      command_ids: new Set(f.command_ids || []),
      notes: f.notes || [],
      order: (f.order || []).slice(),
    }));
    // Re-renderiza se o seletor de escopo de pastas dentro de Folders
    // depende desses dados (qualquer escopo diferente de "My folders", ver
    // FOLDER_SCOPE abaixo) — só carrega ALL_USERS_FOLDERS sob demanda,
    // então precisa de um render() depois que a resposta chega.
    const needsRender = typeof VIEW_FOLDERS_HOME !== 'undefined' && VIEW_FOLDERS_HOME
      && typeof FOLDER_SCOPE !== 'undefined' && FOLDER_SCOPE !== 'mine';
    if (typeof render === 'function' && needsRender) render();
    if (typeof renderFolderScopeOptions === 'function') renderFolderScopeOptions();
  } catch (e) {
    console.warn('Não foi possível carregar as pastas de todos os usuários', e);
  }
}

// "Created by" e "User folders" são visões cross-user — não fazem sentido
// dentro de Folders (VIEW_FOLDERS_HOME), que já é o recorte privado das
// PRÓPRIAS pastas do usuário (pedido do usuário: dentro de Folders, o Group
// by só deve oferecer Topic/Folders/Version). Escondidos via style.display
// direto nos botões (mesmos .seg-btn usados no dropdown da toolbar E no
// modal de Configurações — document.querySelectorAll pega os dois de uma
// vez). Se a opção escondida estava ativa, volta pra Topic. Chamada sempre
// que VIEW_FOLDERS_HOME muda (viewAllFolders/goHome) e uma vez no boot,
// logo depois de VIEW_FOLDERS_HOME ser inicializado acima.
// "Folders" e "User folders" (agrupar por pasta própria / cross-user) foram
// REMOVIDOS do Group by — essas duas visões já são cobertas por inteiro
// pela seção "Folders" da sidebar + o seletor de escopo (#folderScopeDD:
// My folders/usuário escolhido/All), então mantê-las como opções
// duplicadas no Group by só confundia. 'creator' ("Created by") continua
// existindo, só escondido enquanto o usuário está em Folders (ali o
// dropdown inteiro já é substituído pelo seletor de escopo, ver abaixo).
const GROUP_BY_HIDDEN_IN_FOLDERS = ['creator'];
// Dentro de Folders, o controle "Group by" da toolbar (#groupByDD) é
// substituído por inteiro pelo seletor de ESCOPO de pastas (#folderScopeDD
// — ver renderFolderScopeOptions()/setFolderScope() mais abaixo): "My
// folders" (padrão) / um usuário escolhido / "All". Os dois dropdowns
// nunca ficam visíveis ao mesmo tempo — só um "style.display" complementar,
// mesmo padrão já usado pelos seg-btns escondidos abaixo. O rótulo
// compartilhado (#ctbGroupByLabel, ver index.html) troca de texto junto:
// "Group by" fora de Folders, "Filter by" dentro (ali o dropdown não
// agrupa nada, só filtra de quem são as pastas exibidas).
function updateGroupByOptionsForFoldersScope() {
  document.querySelectorAll('.seg-btn[data-val]').forEach(b => {
    if (GROUP_BY_HIDDEN_IN_FOLDERS.includes(b.dataset.val)) {
      b.style.display = VIEW_FOLDERS_HOME ? 'none' : '';
    }
  });
  if (VIEW_FOLDERS_HOME && GROUP_BY_HIDDEN_IN_FOLDERS.includes(GROUP_BY) && typeof setGroupBy === 'function') {
    setGroupBy('topic');
  }
  const groupByDD = document.getElementById('groupByDD');
  const folderScopeDD = document.getElementById('folderScopeDD');
  if (groupByDD) groupByDD.style.display = VIEW_FOLDERS_HOME ? 'none' : '';
  if (folderScopeDD) folderScopeDD.style.display = VIEW_FOLDERS_HOME ? '' : 'none';
  const groupByLabelEl = document.getElementById('ctbGroupByLabel');
  if (groupByLabelEl) groupByLabelEl.textContent = VIEW_FOLDERS_HOME ? 'Filter by' : 'Group by';
  if (VIEW_FOLDERS_HOME) {
    // O seletor de usuário precisa da lista cross-user (ALL_USERS_FOLDERS)
    // pronta — carrega (ou refresca) sob demanda ao entrar em Folders, em
    // vez de manter isso sempre quente no boot pra todo mundo.
    if (typeof reloadAllUsersFoldersFromServer === 'function') reloadAllUsersFoldersFromServer();
    if (typeof renderFolderScopeOptions === 'function') renderFolderScopeOptions();
  }
}
updateGroupByOptionsForFoldersScope();

// ── Seletor de ESCOPO de pastas dentro de Folders (substitui Group by lá —
// ver comentário acima) ──
// FOLDER_SCOPE: 'mine' (padrão) | 'all' | 'user:<username>'. Persistido
// (cpa-folder-scope, ver resolveFolderScope()/persistFolderScope() em
// js/settings.js) — diferente de FOLDER_EDIT_MODE (modo transitório de
// edição, esse sim só em memória de propósito), este é um FILTRO de
// verdade, e o usuário espera que sobreviva a um F5 como qualquer outro.
// (declarada mais acima, junto de VIEW_FOLDERS_HOME — ver comentário lá.)
function folderScopeLabel(scope) {
  if (scope === 'all') return 'All';
  if (scope && scope.startsWith('user:')) return scope.slice('user:'.length);
  return 'My folders';
}
// Lista de usuários pra escolher = quem tem pelo menos uma pasta hoje (ver
// ALL_USERS_FOLDERS), exceto o próprio usuário atual — "My folders" já
// cobre esse caso, não faz sentido duplicar na lista de "outro usuário".
function folderScopeUsernames() {
  const all = typeof ALL_USERS_FOLDERS !== 'undefined' ? ALL_USERS_FOLDERS : [];
  const usernames = [...new Set(all.map(f => f.username))]
    .filter(u => typeof CURRENT_USER === 'undefined' || u !== CURRENT_USER)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return usernames;
}
function renderFolderScopeOptions() {
  // Também mantém o rótulo do botão (#folderScopeDDBtn .dd-label) em dia com
  // FOLDER_SCOPE, não só a lista de opções — bug reportado: "estou na pasta
  // do usuário metalab, ao atualizar a página continua exibindo as pastas
  // do usuário metalab, mas no filtro mostra my folders". O HTML nasce com
  // ".dd-label">My folders" fixo (index.html) e, até esta função existir
  // sozinha responsável pelo rótulo, só era atualizado dentro de
  // setFolderScope() — nunca no boot. No boot, FOLDER_SCOPE já vem
  // corretamente restaurado (resolveFolderScope()) e os cards filtrados já
  // saem certos (por isso "continua exibindo as pastas do usuário
  // metalab"), mas updateGroupByOptionsForFoldersScope() (chamada no
  // carregamento do script) só chamava esta função para reconstruir a
  // LISTA (com o ".on" certo) — o texto do botão fechado ficava
  // desatualizado até o usuário abrir/escolher algo no dropdown de novo.
  const btn = document.getElementById('folderScopeDDBtn');
  const label = btn && btn.querySelector('.dd-label');
  if (label) label.textContent = folderScopeLabel(FOLDER_SCOPE);
  const panel = document.getElementById('folderScopeToggle');
  if (!panel) return;
  const usernames = folderScopeUsernames();
  const userRows = usernames.map(u => {
    const jsEsc = typeof jsAttrEscapeCmdSearch === 'function' ? jsAttrEscapeCmdSearch(u) : u;
    const safe = typeof escapeCmdSearchHistoryHtml === 'function' ? escapeCmdSearchHistoryHtml(u) : u;
    return `<button type="button" class="seg-btn${FOLDER_SCOPE === 'user:' + u ? ' on' : ''}" data-user="${safe}" onclick="setFolderScope('user:${jsEsc}')">${safe}</button>`;
  }).join('');
  // Pedido do usuário: "se a lista estiver grande vai ficar ruim procurar em
  // usuário. incluir a opção de poder digitar e pesquisar o nome" — caixa de
  // busca fixa no topo (sticky, ver .dd-search-input em css/components.css)
  // que filtra só os botões de usuário (data-user) por substring, mantendo
  // "My folders"/"All" sempre visíveis (não são usernames, não faz sentido
  // escondê-los numa busca). innerHTML é reconstruído a cada
  // renderFolderScopeOptions(), então o texto digitado zera quando o escopo
  // muda — aceitável, já que nesse ponto o dropdown está fechando de qualquer
  // forma (ver setFolderScope()).
  panel.innerHTML = `
    <input type="text" class="dd-search-input" id="folderScopeSearch" placeholder="Search user..." autocomplete="off" oninput="filterFolderScopeOptions(this.value)">
    <button type="button" class="seg-btn${FOLDER_SCOPE === 'mine' ? ' on' : ''}" onclick="setFolderScope('mine')">My folders</button>
    ${userRows}
    <button type="button" class="seg-btn${FOLDER_SCOPE === 'all' ? ' on' : ''}" onclick="setFolderScope('all')">All</button>
  `;
}
// Filtra os botões de usuário (data-user) do dropdown de escopo de pastas
// por substring, case-insensitive, conforme o usuário digita na busca.
function filterFolderScopeOptions(query) {
  const panel = document.getElementById('folderScopeToggle');
  if (!panel) return;
  const q = (query || '').trim().toLowerCase();
  panel.querySelectorAll('.seg-btn[data-user]').forEach(btn => {
    const name = (btn.getAttribute('data-user') || '').toLowerCase();
    btn.style.display = !q || name.includes(q) ? '' : 'none';
  });
}
// Foca a busca ao abrir o dropdown (chamado direto no onclick do botão,
// junto de toggleDropdown) — setTimeout(0) porque a classe ".open" (que
// exibe o painel via CSS) só é aplicada pelo toggleDropdown chamado logo
// antes, no mesmo evento de clique.
function focusFolderScopeSearch() {
  setTimeout(() => {
    const dd = document.getElementById('folderScopeDD');
    const input = document.getElementById('folderScopeSearch');
    if (dd && dd.classList.contains('open') && input) input.focus();
  }, 0);
}
function setFolderScope(scope) {
  FOLDER_SCOPE = scope || 'mine';
  if (typeof persistFolderScope === 'function') persistFolderScope(FOLDER_SCOPE);
  renderFolderScopeOptions(); // reconstrói a lista (".on" certo) e o rótulo do botão
  const dd = document.getElementById('folderScopeDD');
  if (dd) dd.classList.remove('open');
  if (FOLDER_SCOPE !== 'mine' && typeof ALL_USERS_FOLDERS !== 'undefined' && !ALL_USERS_FOLDERS.length && typeof reloadAllUsersFoldersFromServer === 'function') {
    reloadAllUsersFoldersFromServer();
  }
  if (typeof render === 'function') render();
}

// ── Navegação: visão combinada de Folders / home ──
// Clique no cabeçalho "Folders" da sidebar — funciona como um toggle: clicar
// de novo enquanto já está ativo desliga a visão e volta para o menu normal
// (todos os comandos, agrupados por Tópico/etc. de novo), em vez de ficar
// preso em Folders sem um jeito óbvio de sair. Mesmo easter egg de sempre
// (Ctrl+Alt+clique, ver _q7 em js/state.js) preservado aqui no lugar de
// toggleFavoritesView(), que cumpria o mesmo papel antes.
function viewAllFolders() {
  if (_q7 === 3) return _rvl9();
  VIEW_FOLDERS_HOME = !VIEW_FOLDERS_HOME;
  persistLastView(VIEW_FOLDERS_HOME);
  const nav = document.getElementById('foldersNavRow');
  if (nav) nav.classList.toggle('on', VIEW_FOLDERS_HOME);
  updateGroupByOptionsForFoldersScope();
  render();
}
// Clique no nome/logo do app: volta para a página inicial configurada
// (Folders ou Command menu — ver "Home page" em Configurações). Diferente
// de um F5 (que deve manter a visão atual — ver resolveFoldersHome()), este
// é um clique deliberado pra "ir pra tela inicial", então também grava o
// resultado como a nova visão atual (persistLastView) — senão um F5 logo
// depois de clicar em "voltar pro início" poderia jogar o usuário de volta
// pra Folders, se ele estivesse navegando lá antes.
function goHome() {
  const s = loadSettings();
  VIEW_FOLDERS_HOME = s.home === 'folders';
  persistLastView(VIEW_FOLDERS_HOME);
  const nav = document.getElementById('foldersNavRow');
  if (nav) nav.classList.toggle('on', VIEW_FOLDERS_HOME);
  updateGroupByOptionsForFoldersScope();
  render();
}

// ── Membership: adicionar/remover um comando de uma pasta (chamado pelo
// dropdown de pastas de cada card — ver folderMenuHtml()/toggleFolderMenu()
// em js/terminal-renderer.js) ──
//
// Navegando por Folders (VIEW_FOLDERS_HOME) ou com Group By = "My folders"
// (ver js/render.js: buildSections()), a tela é organizada em seções POR
// PASTA — um comando marcado/desmarcado muda quais cards aparecem em quais
// seções, o que exige reconstruir o HTML (render() completo), não só trocar
// uma classe. Fora desses casos (navegando normalmente por Tópico/Versão/
// Created by, com o dropdown de pastas aberto no próprio card), a
// atualização é otimista — marca/desmarca só o item clicado e o botão de
// pasta do card, SEM re-renderizar — para o dropdown continuar aberto e
// permitir marcar várias pastas em sequência.
async function toggleCommandInFolder(cmdId, folderId, itemEl) {
  const folder = FOLDERS.find(f => f.id === folderId);
  if (!folder) return;
  const wasOn = folder.command_ids.has(cmdId);
  if (wasOn) folder.command_ids.delete(cmdId); else folder.command_ids.add(cmdId);
  // Mantém folder.order (task #458, agora um array de {type,id} — task
  // Notes — usado só pra RENDERIZAR na ordem certa — ver buildFolderSection
  // em db-render-engine.js) sincronizado com o Set acima: remove do meio se
  // saiu, ou entra no FIM se entrou (mesmo critério do backend — ver POST
  // /api/folders/:id/commands/:commandId em server/index.js, que dá
  // sort_order = MAX+1 cross-table pro novo membership).
  if (!folder.order) folder.order = [...folder.command_ids].map(id => ({ type: 'command', id }));
  if (wasOn) {
    const idx = folder.order.findIndex(o => o.type === 'command' && o.id === cmdId);
    if (idx !== -1) folder.order.splice(idx, 1);
  } else if (!folder.order.some(o => o.type === 'command' && o.id === cmdId)) {
    folder.order.push({ type: 'command', id: cmdId });
  }
  // Mantém o snapshot cross-user (ALL_USERS_FOLDERS, ver seletor de escopo
  // dentro de Folders) coerente com a própria pasta do usuário atual — sem
  // isso, a seção dele no escopo "All"/outro usuário ficaria com a
  // contagem/ordem antiga até o próximo reload (F5 ou re-escolher o escopo).
  const ownInAllUsers = ALL_USERS_FOLDERS.find(f => f.id === folderId);
  if (ownInAllUsers) {
    if (wasOn) ownInAllUsers.command_ids.delete(cmdId); else ownInAllUsers.command_ids.add(cmdId);
    if (!ownInAllUsers.order) ownInAllUsers.order = [...ownInAllUsers.command_ids].map(id => ({ type: 'command', id }));
    if (wasOn) {
      const idx2 = ownInAllUsers.order.findIndex(o => o.type === 'command' && o.id === cmdId);
      if (idx2 !== -1) ownInAllUsers.order.splice(idx2, 1);
    } else if (!ownInAllUsers.order.some(o => o.type === 'command' && o.id === cmdId)) {
      ownInAllUsers.order.push({ type: 'command', id: cmdId });
    }
  }

  // Mantém o cache de comandos (fetchCommands(), ver js/api-client.js) em
  // dia — buildFolderSection (js/db-render-engine.js) filtra pelas PRÓPRIAS
  // c.folder_ids do comando (o que veio do servidor), não pelo
  // FOLDERS[].command_ids atualizado acima. Sem isso, a seção só refletia o
  // toggle depois de um F5 (que reseta o cache e busca folder_ids frescos do
  // servidor) — bug reportado pelo usuário.
  try {
    const cmds = await fetchCommands();
    const cmd = cmds.find(c => c.id === cmdId);
    if (cmd) {
      const ids = new Set(cmd.folder_ids || []);
      if (wasOn) ids.delete(folderId); else ids.add(folderId);
      cmd.folder_ids = [...ids];
    }
  } catch (e) { /* cache vazio/erro — o próximo render() tenta buscar de novo */ }

  if (VIEW_FOLDERS_HOME) {
    // render() reconstrói #out inteiro (o comando pode migrar de seção ao
    // marcar/desmarcar uma pasta), o que destruiria o dropdown aberto sem
    // nenhum feedback de que o clique registrou — reabre o MESMO dropdown
    // (agora com o card, possivelmente em outra seção) logo em seguida, em
    // vez de simplesmente deixá-lo sumir.
    await render();
    const pop = document.querySelector(`.card[data-cmd-id="${CSS.escape(cmdId)}"] .folder-menu-pop`);
    if (pop) {
      document.querySelectorAll('.folder-menu-pop.open').forEach(p => { if (p !== pop) p.classList.remove('open'); });
      pop.classList.add('open');
    }
  } else if (itemEl) {
    itemEl.classList.toggle('on', !wasOn);
    const chk = itemEl.querySelector('.folder-menu-chk');
    if (chk) chk.textContent = wasOn ? '' : '✓';
    const card = document.querySelector(`.card[data-cmd-id="${CSS.escape(cmdId)}"]`);
    if (card) {
      const inAnyFolder = FOLDERS.some(f => f.command_ids.has(cmdId));
      const btn = card.querySelector('.fav-wrap .fav-btn');
      if (btn) {
        btn.classList.toggle('on', inAnyFolder);
        // Bug reportado: ícone ficava "vazado" (contorno, fill="none") mesmo
        // já marcado numa pasta — só a cor (.on) era atualizada aqui, o SVG
        // em si (gerado uma única vez na montagem do card, ver folderIcon()
        // em js/terminal-renderer.js) nunca era trocado nessa atualização
        // otimista (sem re-render completo). Um comando que passasse por
        // render() de novo (ex.: F5, ou dentro de Folders) já mostrava certo
        // — daí a inconsistência entre cards. Refazer o innerHTML do botão
        // com o ícone certo resolve os dois casos da mesma forma.
        if (typeof folderIcon === 'function') btn.innerHTML = folderIcon(inAnyFolder);
        btn.title = inAnyFolder ? 'In folders' : 'Add to folder';
      }
    }
  }

  const method = wasOn ? 'DELETE' : 'POST';
  fetch(`/api/folders/${folderId}/commands/${encodeURIComponent(cmdId)}`, { method }).catch(e => {
    console.warn('Falha ao atualizar pasta no servidor (mantido localmente)', e);
  });
}

// ── CRUD de pastas — modal de nome compartilhado (create/rename), ver
// #folderPromptOverlay em index.html ──
// Reaproveitado também pra perguntar a URL de um link (ver neInsertLink
// abaixo, modo 'link') — é só um prompt de texto genérico (título/rótulo/
// texto do botão variam por `mode`), então dá pra usar pro mesmo fim em vez
// de duplicar mais um modal quase idêntico ou usar o prompt() nativo do
// navegador (sem estilo do tema, mostra o host da página).
let _folderPromptResolve = null;
let _folderPromptMode = 'create';
const _FOLDER_PROMPT_CONFIG = {
  create: { title: 'New folder', label: 'Name', ok: 'Create', type: 'text', placeholder: '', err: 'Enter a folder name.' },
  rename: { title: 'Rename folder', label: 'Name', ok: 'Rename', type: 'text', placeholder: '', err: 'Enter a folder name.' },
  subfolder: { title: 'New subfolder', label: 'Name', ok: 'Create', type: 'text', placeholder: '', err: 'Enter a folder name.' },
  link: { title: 'Insert link', label: 'URL', ok: 'Insert', type: 'url', placeholder: 'https://example.com', err: 'Enter a URL.' },
};
function openFolderPromptModal(mode, currentName) {
  return new Promise(resolve => {
    _folderPromptResolve = resolve;
    _folderPromptMode = mode;
    const cfg = _FOLDER_PROMPT_CONFIG[mode] || _FOLDER_PROMPT_CONFIG.create;
    document.getElementById('folderPromptTitle').textContent = cfg.title;
    document.getElementById('folderPromptOkBtn').textContent = cfg.ok;
    const labelEl = document.getElementById('folderPromptLabel');
    if (labelEl) labelEl.textContent = cfg.label;
    const input = document.getElementById('folderPromptInput');
    input.type = cfg.type;
    input.placeholder = cfg.placeholder;
    input.value = currentName || '';
    const errBox = document.getElementById('folderPromptError');
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    document.getElementById('folderPromptOverlay').classList.add('show');
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}
function closeFolderPromptModal(result) {
  document.getElementById('folderPromptOverlay').classList.remove('show');
  if (_folderPromptResolve) { const r = _folderPromptResolve; _folderPromptResolve = null; r(result); }
}
function submitFolderPromptModal() {
  const value = (document.getElementById('folderPromptInput').value || '').trim();
  const errBox = document.getElementById('folderPromptError');
  if (!value) {
    const cfg = _FOLDER_PROMPT_CONFIG[_folderPromptMode] || _FOLDER_PROMPT_CONFIG.create;
    if (errBox) { errBox.textContent = cfg.err; errBox.style.display = ''; }
    return;
  }
  closeFolderPromptModal(value);
}
document.getElementById('folderPromptInput') && document.getElementById('folderPromptInput').addEventListener('keydown', ev => {
  if (ev.key === 'Enter') submitFolderPromptModal();
});
document.getElementById('folderPromptOverlay') && document.getElementById('folderPromptOverlay').addEventListener('click', ev => {
  if (ev.target.id === 'folderPromptOverlay') closeFolderPromptModal(null);
});

// `cmdIdToAddAfter` (opcional): quando a pasta é criada a partir do "+ New
// folder" dentro do dropdown de um card (ver folderMenuHtml() em
// terminal-renderer.js), o comando já entra automaticamente na pasta nova,
// sem precisar reabrir o dropdown e marcar de novo.
async function promptCreateFolder(cmdIdToAddAfter) {
  return _createFolderInternal('create', null, cmdIdToAddAfter);
}

// ── Subpastas (aninhamento ilimitado) ──
// Chamada a partir do dropdown "+ Add" no cabeçalho de uma seção de pasta
// própria (ver rightAction em buildFolderSectionFromCards, db-render-engine.js)
// — mesma mecânica de promptCreateFolder acima, só que gravando `parentId` na
// nova pasta (POST /api/folders aceita `parent_id`, ver server/index.js).
// Reaproveita o MESMO modal de nome (openFolderPromptModal) com o modo
// 'subfolder' (título "New subfolder") em vez de duplicar toda a lógica de
// criação — só muda o payload enviado e onde a pasta nova entra no array
// FOLDERS local (ela some da tela até o próximo render() de qualquer forma,
// que reconstrói a árvore a partir de FOLDERS/parent_id — ver render.js).
async function promptCreateSubfolder(parentId) {
  return _createFolderInternal('subfolder', parentId, null);
}
async function _createFolderInternal(mode, parentId, cmdIdToAddAfter) {
  const name = await openFolderPromptModal(mode);
  if (!name) return;
  try {
    const body = { name };
    if (parentId) body.parent_id = parentId;
    const res = await fetch('/api/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      alert(errBody.message || 'Failed to create folder.');
      return;
    }
    const folder = await res.json();
    const commandIds = new Set(folder.command_ids || []);
    const order = (folder.command_ids || []).map(id => ({ type: 'command', id }));
    if (cmdIdToAddAfter) {
      commandIds.add(cmdIdToAddAfter);
      order.push({ type: 'command', id: cmdIdToAddAfter });
      fetch(`/api/folders/${folder.id}/commands/${encodeURIComponent(cmdIdToAddAfter)}`, { method: 'POST' }).catch(e => {
        console.warn('Falha ao adicionar o comando à nova pasta no servidor (mantido localmente)', e);
      });
    }
    FOLDERS.push({ id: folder.id, name: folder.name, sort_order: folder.sort_order, parent_id: folder.parent_id || null, command_ids: commandIds, notes: [], order });
    render(); // reconstrói os cards para o dropdown de pastas (e a seção da pasta/subpasta, se estiver em Folders) já refletirem a pasta nova
  } catch (e) {
    alert('Failed to create folder. Please try again.');
  }
}
// ── Renomear pasta: nome editável inline no cabeçalho (dentro do modo de
// edição) ──
// Antes exigia clicar num botão "✎ Rename" separado, que abria um modal
// (openFolderPromptModal('rename', ...)) por cima da tela. Agora, dentro do
// modo de edição, o próprio nome no cabeçalho é um <input> (ver
// buildFolderSectionFromCards em db-render-engine.js) — o usuário clica
// direto nele e digita, sem etapa extra. Salva no blur ou Enter; Escape
// cancela sem salvar.
// `ev` (opcional em outras funções deste bloco): quando chamadas a partir do
// cabeçalho de uma seção de pasta (.sec-folder-actions, ver
// buildFolderSectionFromCards em db-render-engine.js), stopPropagation()
// evita que o clique também recolha/expanda a seção (o cabeçalho inteiro tem
// onclick="toggleSection(...)").
function _folderNameInputKeydown(ev) {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    ev.target.blur(); // dispara _folderNameInputBlur, que salva
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.target.value = ev.target.defaultValue; // reverte sem salvar
    ev.target.blur();
  }
}
async function _folderNameInputBlur(ev) {
  const input = ev.target;
  const id = Number(input.dataset.folderId);
  const oldName = input.defaultValue;
  const newName = input.value.trim();
  if (!newName || newName === oldName) { input.value = oldName; return; } // vazio ou sem mudança: não chama a API
  try {
    const res = await fetch(`/api/folders/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.message || 'Failed to rename folder.');
      input.value = oldName;
      return;
    }
    const folder = FOLDERS.find(f => f.id === id);
    if (folder) folder.name = newName;
    render(); // o nome da pasta aparece no título da sua seção — precisa reconstruir
  } catch (e) {
    alert('Failed to rename folder. Please try again.');
    input.value = oldName;
  }
}
// Reúne o id da pasta + de TODA a árvore de subpastas abaixo dela (recursivo,
// aninhamento ilimitado) — usado tanto pro texto de confirmação (avisar que
// subpastas também somem) quanto pra limpar o estado local otimista sem
// esperar o próximo reloadFoldersFromServer(). O servidor já cuida disso
// sozinho via ON DELETE CASCADE em folders.parent_id (ver schema.sql); isto
// aqui é só o espelho no array FOLDERS em memória.
function _collectFolderAndDescendantIds(id, list) {
  const ids = [id];
  (list || FOLDERS).filter(f => f.parent_id === id).forEach(child => {
    ids.push(..._collectFolderAndDescendantIds(child.id, list));
  });
  return ids;
}
function deleteFolderConfirm(id, name, ev) {
  if (ev) ev.stopPropagation();
  const descendantCount = _collectFolderAndDescendantIds(id).length - 1;
  const subfolderWarning = descendantCount
    ? ` This also deletes ${descendantCount} subfolder${descendantCount > 1 ? 's' : ''} inside it (and their notes).`
    : '';
  openConfirmModal(`Delete folder "${name}"? Commands inside it are not deleted — they just leave this folder. Notes inside it ARE deleted along with the folder (notes only exist inside a folder).${subfolderWarning} This action cannot be undone.`).then(ok => {
    if (!ok) return;
    const idsToRemove = new Set(_collectFolderAndDescendantIds(id));
    FOLDERS = FOLDERS.filter(f => !idsToRemove.has(f.id));
    idsToRemove.forEach(fid => FOLDER_EDIT_MODE.delete(fid)); // não deixa "vazando" um modo de edição pra um id de pasta que não existe mais
    fetch(`/api/folders/${id}`, { method: 'DELETE' }).catch(e => {
      console.warn('Falha ao excluir pasta no servidor (mantida localmente)', e);
    });
    render();
  });
}

// ── Modo de edição da pasta (task #461, consolidado na task #463) ──
// Um único botão "⚙ Edit folder" no cabeçalho liga/desliga esse modo por
// pasta — SÓ dentro dele é que aparecem Renomear (✎)/Excluir (✕) e os
// itens (cards E subpastas) ficam arrastáveis (embrulhados em
// .folder-item-row, ver wrapItemForFolderDrag em db-render-engine.js). Fora desse modo, mesmo
// numa pasta própria, a seção mostra só os cards + os botões "+ Note"/"⚙
// Edit" sempre visíveis — renomear/excluir/reordenar por acidente (rolar a
// tela, clicar num card) não deveria ser possível sem entrar deliberadamente
// no modo de edição. `FOLDER_EDIT_MODE` é um Set de folderIds — cada pasta
// liga/desliga o próprio modo independentemente das outras; não persiste
// entre reloads (mesma decisão de sempre pra esse tipo de estado de UI).
let FOLDER_EDIT_MODE = new Set();
// `ev` (opcional): chamado a partir do cabeçalho da seção (.sec-folder-
// actions, ver buildFolderSectionFromCards em db-render-engine.js) —
// mesmo motivo de stopPropagation() de promptRenameFolder/deleteFolderConfirm.
function toggleFolderEditMode(folderId, ev) {
  if (ev) ev.stopPropagation();
  if (FOLDER_EDIT_MODE.has(folderId)) FOLDER_EDIT_MODE.delete(folderId);
  else FOLDER_EDIT_MODE.add(folderId);
  render();
}

// ── Reordenar/mover comandos, notas E subpastas dentro da árvore de uma
// pasta (task #458, estendida) ── pedido do usuário: "poder reordenar as
// subpastas entre os comandos e notas" e "pode arrastar comandos, notas e
// subpastas para dentro e fora da subpasta. A subpastas e seus itens não
// podem sair da pasta pai". Um único mecanismo substitui os dois que
// existiam antes (um pra cards, outro pra subpastas) — todo item (card OU
// seção de subpasta inteira) vira um `.folder-item-row` (ver
// wrapItemForFolderDrag em db-render-engine.js) com `data-container-id`
// (pasta que o contém AGORA — muda se o item for movido), `data-item-type`
// ('command'|'note'|'folder'), `data-item-id` e `data-root-folder-id` (raiz
// da árvore inteira, NUNCA muda — usado só pra bloquear soltar fora dela).
// `draggable` só é setado no mousedown do handle (⠿), não na row inteira,
// pra não interferir com cliques nos botões/links dentro do card. Só existe
// handle em pastas do PRÓPRIO usuário — a pasta de outro usuário (Group by
// "User folders") é só leitura, e o backend recusaria a requisição de
// qualquer forma.
function _fldArmDrag(handle) {
  const row = handle.closest('.folder-item-row');
  if (row) row.setAttribute('draggable', 'true');
}
document.addEventListener('mouseup', () => {
  document.querySelectorAll('.folder-item-row[draggable="true"]').forEach(r => r.removeAttribute('draggable'));
});
let _fldDragRow = null;
let _fldOriginContainerId = null;
let _fldTargetContainerId = null;
document.addEventListener('dragstart', ev => {
  const row = ev.target.closest && ev.target.closest('.folder-item-row');
  if (!row || !row.hasAttribute('draggable')) return;
  _fldDragRow = row;
  _fldOriginContainerId = row.dataset.containerId;
  _fldTargetContainerId = row.dataset.containerId;
  row.classList.add('dragging');
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', ''); // exigido pelo Firefox para permitir o drag
});
document.addEventListener('dragover', ev => {
  if (!_fldDragRow) return;
  const rootId = _fldDragRow.dataset.rootFolderId;
  const draggedType = _fldDragRow.dataset.itemType;
  const draggedId = _fldDragRow.dataset.itemId;

  // Alvo A (mais específico): o CABEÇALHO de uma pasta (a própria pasta-mãe
  // raiz OU qualquer subpasta visível na tela) — soltar aqui manda o item
  // pra DENTRO dela, no fim da lista — é o jeito de mirar uma subpasta
  // vazia/recolhida (ou a própria raiz) sem precisar acertar uma row
  // específica dentro dela.
  const header = ev.target.closest && ev.target.closest('[data-folder-header-id]');
  if (header) {
    const targetFolderId = header.dataset.folderHeaderId;
    const targetSection = header.closest('[data-folder-id]');
    if (!targetSection || targetSection.dataset.rootFolderId !== rootId) return; // fora da árvore — recusa
    if (draggedType === 'folder' && String(targetFolderId) === String(draggedId)) return; // não entra em si mesma
    if (draggedType === 'folder' && _fldDragRow.contains(header)) return; // nem em uma de suas próprias descendentes (cicraria)
    const bodyEl = targetSection.querySelector(`:scope > .sec-body[data-folder-body-id="${targetFolderId}"]`);
    // Bug reportado pelo usuário: "estou tentando mover um serviço da
    // subpasta para pasta pai e não está movendo" — `bodyEl.contains(...)`
    // (Node.contains) dá match em QUALQUER descendente, não só filho direto.
    // Um item dentro de uma subpasta É descendente do corpo da pasta-mãe
    // (a seção da subpasta mora dentro do corpo dela), então soltar no
    // cabeçalho da pasta-mãe era sempre visto como "já está lá dentro" e
    // ignorado silenciosamente. O que importa é se já é FILHO DIRETO deste
    // corpo — daí `parentElement === bodyEl`.
    if (!bodyEl || _fldDragRow.parentElement === bodyEl) return; // já está lá dentro — nada a fazer
    ev.preventDefault();
    bodyEl.appendChild(_fldDragRow);
    _fldTargetContainerId = targetFolderId;
    return;
  }

  // Alvo B: outra row — reordena por posição (antes/depois dela). Pode ser
  // da MESMA pasta (reorder simples) ou de OUTRA pasta dentro da MESMA
  // árvore (move) — `overRow.dataset.containerId` vira o novo container.
  const overRow = ev.target.closest && ev.target.closest('.folder-item-row');
  if (!overRow || overRow === _fldDragRow || _fldDragRow.contains(overRow)) return;
  if (overRow.dataset.rootFolderId !== rootId) return; // fora da árvore — recusa
  ev.preventDefault();
  const rect = overRow.getBoundingClientRect();
  const before = (ev.clientY - rect.top) < rect.height / 2;
  overRow.parentElement.insertBefore(_fldDragRow, before ? overRow : overRow.nextSibling);
  _fldTargetContainerId = overRow.dataset.containerId;
});
document.addEventListener('drop', ev => { if (_fldDragRow) ev.preventDefault(); });
document.addEventListener('dragend', ev => {
  const row = _fldDragRow;
  if (row) {
    row.classList.remove('dragging');
    row.removeAttribute('draggable');
    const newContainerId = Number(_fldTargetContainerId || row.dataset.containerId);
    const oldContainerId = Number(_fldOriginContainerId);
    const itemType = row.dataset.itemType;
    const rawId = row.dataset.itemId;
    // commands.id agora é INTEGER (igual notes/folders) — não há mais motivo
    // pra manter 'command' como string aqui (era TEXT antes da migração para
    // SERIAL, ver schema.sql/server/db.js: migrateCommandsIdToSerial).
    const itemId = Number(rawId);

    if (!newContainerId || newContainerId === oldContainerId) {
      // Reorder simples: mesma pasta, só mudou de posição entre os irmãos.
      persistFolderContainerOrder(oldContainerId || newContainerId);
    } else {
      // Mover pra OUTRA pasta (dentro/fora de uma subpasta) — pedido do
      // usuário. Captura a ordem final do DESTINO a partir do DOM AGORA
      // (antes de qualquer reload substituir esses elementos) — é
      // exatamente onde o usuário soltou. Depois muda a membership/parent
      // de verdade no backend, recarrega FOLDERS/ALL_USERS_FOLDERS (fonte
      // da verdade, evita reimplementar a cirurgia de estado local à mão) e
      // só então persiste essa ordem — server/index.js já garante que o
      // "mover" nunca sai da árvore de topo (getRootAncestorId), então o
      // pior caso de uma tentativa inválida é o item simplesmente voltar
      // pro lugar de origem depois do reload.
      const orderedTagged = _fldReadContainerOrderFromDom(newContainerId);
      _fldMoveItemAcrossFolders(itemType, itemId, oldContainerId, newContainerId)
        .catch(e => console.warn('Falha ao mover item entre pastas', e))
        .then(async () => {
          // Bug reportado pelo usuário: "notas consigo movimentar
          // normalmente, mas continuo com problema para movimentar os
          // comandos dentro das pastas" — no ramo "mine" de render()
          // (js/render.js), a seção de CADA pasta lista seus comandos a
          // partir de `c.folder_ids` (um campo por-COMANDO, vindo do cache
          // de fetchCommands() em js/api-client.js), não a partir de
          // FOLDERS[].order/command_ids. reloadFoldersFromServer() (abaixo)
          // só atualiza FOLDERS/ALL_USERS_FOLDERS — nunca esse cache de
          // comandos — então o comando movido continuava aparecendo só na
          // pasta de ORIGEM até um F5 (que reseta o cache e busca
          // folder_ids frescos). Notes não sofrem disso porque vêm direto
          // de folder.notes, já recarregado abaixo. Mesmo ajuste já feito
          // antes pro toggle via dropdown do card — ver
          // toggleCommandInFolder acima, comentário idêntico.
          if (itemType === 'command') {
            try {
              const cmds = await fetchCommands();
              const cmd = cmds.find(c => c.id === itemId);
              if (cmd) {
                const ids = new Set(cmd.folder_ids || []);
                ids.delete(oldContainerId);
                ids.add(newContainerId);
                cmd.folder_ids = [...ids];
              }
            } catch (e) { /* cache vazio/erro — reloadFoldersFromServer abaixo ainda corrige FOLDERS */ }
          }
        })
        .then(() => Promise.all([
          reloadFoldersFromServer(),
          typeof reloadAllUsersFoldersFromServer === 'function' ? reloadAllUsersFoldersFromServer() : Promise.resolve(),
        ]))
        .then(() => {
          if (orderedTagged.length) reorderFolderItems(newContainerId, orderedTagged);
          render();
        });
    }
  }
  _fldDragRow = null;
  _fldOriginContainerId = null;
  _fldTargetContainerId = null;
});
// Lê a ordem ATUAL (pós-drag) dos itens diretos do corpo de uma pasta a
// partir do DOM — `:scope >` importa aqui: sem ele, pegaria também os itens
// de uma subpasta ANINHADA dentro de um dos irmãos (uma subpasta é ela
// mesma embrulhada num .folder-item-row, cujo corpo interno tem seus
// PRÓPRIOS .folder-item-row — sem escopar, ambos os níveis bateriam no
// mesmo seletor).
function _fldReadContainerOrderFromDom(containerId) {
  const container = document.querySelector(`.sec-body[data-folder-body-id="${containerId}"]`);
  if (!container) return [];
  return [...container.querySelectorAll(':scope > .folder-item-row')]
    .map(r => {
      const type = r.dataset.itemType;
      const rawId = r.dataset.itemId;
      if (!type) return null;
      // Mesmo motivo do comentário em dragend acima — commands.id é INTEGER
      // agora, então todos os 3 tipos convertem pra Number igual.
      return { type, id: Number(rawId) };
    })
    .filter(Boolean);
}
function persistFolderContainerOrder(containerId) {
  const orderedTagged = _fldReadContainerOrderFromDom(containerId);
  if (orderedTagged.length) reorderFolderItems(containerId, orderedTagged);
}
// Muda de verdade, no backend, a "casa" de um item — comando (membership
// N:N, ver folder_commands em schema.sql: "mover" = tirar da origem e pôr
// no destino), nota (folder_id único, PUT /api/notes/:id/move) ou subpasta
// (parent_id, PUT /api/folders/:id/move). Os dois últimos endpoints
// recusam (400) se o destino estiver fora da árvore de topo de onde o item
// já estava — ver getRootAncestorId em server/index.js.
function _fldMoveItemAcrossFolders(itemType, itemId, oldContainerId, newContainerId) {
  if (itemType === 'note') {
    return fetch(`/api/notes/${itemId}/move`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder_id: newContainerId }),
    }).then(res => { if (!res.ok) throw new Error('move note failed: ' + res.status); });
  }
  if (itemType === 'folder') {
    return fetch(`/api/folders/${itemId}/move`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: newContainerId }),
    }).then(res => { if (!res.ok) throw new Error('move folder failed: ' + res.status); });
  }
  return Promise.all([
    fetch(`/api/folders/${newContainerId}/commands/${encodeURIComponent(itemId)}`, { method: 'POST' }),
    fetch(`/api/folders/${oldContainerId}/commands/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
  ]).then(([addRes, delRes]) => {
    if (!addRes.ok) throw new Error('add command to folder failed: ' + addRes.status);
    if (!delRes.ok) throw new Error('remove command from folder failed: ' + delRes.status);
  });
}
// Persiste a nova ordem (comandos, notas E subpastas, task Notes/subpastas)
// — otimista (atualiza FOLDERS/ALL_USERS_FOLDERS local na hora; a UI já
// está com a ordem certa, já que veio de um reorder no próprio DOM) + PUT
// em segundo plano. Não chama render() — reconstruir o HTML aqui destruiria
// a própria row que acabou de ser soltada (só o caminho de "mover entre
// pastas", acima, chama render() depois — nesse caso o reload já trocou o
// DOM de qualquer forma). `orderedTagged` é um array de {type, id}.
function reorderFolderItems(folderId, orderedTagged) {
  const folder = FOLDERS.find(f => f.id === folderId);
  if (folder) folder.order = orderedTagged.slice();
  const ownInAllUsers = ALL_USERS_FOLDERS.find(f => f.id === folderId);
  if (ownInAllUsers) ownInAllUsers.order = orderedTagged.slice();
  fetch(`/api/folders/${folderId}/reorder`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: orderedTagged }),
  }).catch(e => {
    console.warn('Falha ao salvar a nova ordem da pasta no servidor (mantida localmente)', e);
  });
}

// ── Copiar uma pasta de OUTRO usuário para a própria lista (task #459) ──
// Só aparece no Group by "User folders" (ver render.js), na pasta de
// alguém que não seja CURRENT_USER (ver buildFolderSectionFromCards:
// `copyable` é passado como !isOwn). O backend (POST /api/folders/:id/copy)
// cria uma pasta NOVA com os mesmos comandos/ordem — a pasta original de
// quem copiamos não é alterada nem removida.
function copyFolderFromUser(folderId, folderName, ev) {
  if (ev) ev.stopPropagation();
  openConfirmModal(`Copy folder "${folderName}" to your own Folders? This creates a new folder with the same commands — it won't affect the original.`).then(async ok => {
    if (!ok) return;
    try {
      const res = await fetch(`/api/folders/${folderId}/copy`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.message || 'Failed to copy folder.');
        return;
      }
      const folder = await res.json();
      // /copy agora também duplica as notas da pasta original (a pedido do
      // usuário — antes só trazia os comandos) e já devolve `notes`/`order`
      // prontos (ver POST /api/folders/:id/copy, server/index.js), então
      // basta usar o que veio da resposta em vez de derivar. As notas
      // copiadas já chegam com username = quem copiou (nunca o autor
      // original), então já são totalmente editáveis/clonáveis/excluíveis
      // por este usuário como qualquer outra nota própria.
      FOLDERS.push({
        id: folder.id, name: folder.name, sort_order: folder.sort_order,
        command_ids: new Set(folder.command_ids || []),
        notes: folder.notes || [],
        order: folder.order || [],
      });
      render(); // a pasta nova precisa aparecer nos dropdowns de pasta de cada card, e em "Folders"/"My folders" se o usuário for lá depois
    } catch (e) {
      alert('Failed to copy folder. Please try again.');
    }
  });
}

// ── Notes (task Notes) — anotações livres dentro de uma pasta própria ──
// 3º redesign (pedido: "ajuste para que a edição de nota na pasta Folders
// seja feita na mesma tela, sem abrir o popup") — não existe mais um modal
// compartilhado (#noteEditorOverlay, removido de index.html): a edição
// acontece dentro do próprio card, gerado por buildNoteCardHtml em
// js/db-render-engine.js. O estado de "quais notas estão em edição agora"
// mora aqui, no mesmo espírito de FOLDER_EDIT_MODE (acima):
//   NOTE_EDIT_MODE       — Set de note.id sendo editadas (notas EXISTENTES)
//   NOTE_CREATE_FOLDER_ID — id da pasta com uma nota NOVA em edição (rascunho
//                           que ainda não existe no servidor), ou null
// Só pode haver, no máximo, o conjunto de notas abertas simultaneamente —
// não há exclusividade global (o usuário pode, em tese, deixar mais de uma
// aberta); render() reconstrói cada card no estado certo a cada chamada.
let NOTE_EDIT_MODE = new Set();
let NOTE_CREATE_FOLDER_ID = null;
// Rascunho local do HTML de cada editor aberto, indexado por uma chave
// própria ("edit:<id>" ou "create:<folderId>", ver draftKey em
// buildNoteCardHtml) — existe só pra PROTEGER contra perda de digitação: como
// a edição agora mora dentro do HTML gerado por render(), qualquer render()
// disparado por outro motivo enquanto o usuário digita (busca com debounce,
// troca de pasta em outra aba do mesmo Folders, etc.) reconstruiria o card
// do zero a partir de note.description (o valor salvo no servidor, que
// ainda não tem o que foi digitado) e o texto em andamento seria perdido —
// isso não existia no design anterior (modal fora do ciclo de render). O
// listener de 'input' abaixo mantém esse objeto atualizado a cada tecla;
// buildNoteCardHtml consulta-o com prioridade sobre note.description.
let NOTE_EDIT_DRAFTS = {};
// Deriva um "título" curto a partir do texto puro da nota — só usado
// internamente (mensagem de confirmação ao excluir, sufixo " (copy)" ao
// clonar), nunca mostrado como campo próprio.
function _deriveNoteTitle(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  const text = (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? text.slice(0, 80).trim() + '…' : text;
}
// Foca o <div contenteditable> do editor recém-aberto — precisa de um
// setTimeout(0) porque o card só existe no DOM depois que innerHTML é
// reatribuído por render() (ver js/render.js), que ainda não rodou no
// instante em que startCreateNote/startEditNote chamam render().
function _neFocusEditor(editorId) {
  setTimeout(() => {
    const el = document.getElementById(editorId);
    if (el) el.focus();
  }, 0);
}
function startCreateNote(folderId, ev) {
  if (ev) ev.stopPropagation();
  NOTE_CREATE_FOLDER_ID = folderId;
  delete NOTE_EDIT_DRAFTS[`create:${folderId}`];
  render();
  _neFocusEditor(`noteEditorNew_${folderId}`);
}
function startEditNote(noteId, ev) {
  if (ev) ev.stopPropagation();
  NOTE_EDIT_MODE.add(noteId);
  delete NOTE_EDIT_DRAFTS[`edit:${noteId}`];
  render();
  _neFocusEditor(`noteEditorEdit_${noteId}`);
}
// Cancelar descarta o rascunho (local e no NOTE_EDIT_DRAFTS) sem tocar no
// servidor — para uma nota existente, note.description (já salvo) volta a
// ser exibido; para uma nota nova, o card de rascunho simplesmente some.
function cancelNoteEdit(noteId, folderId, ev) {
  if (ev) ev.stopPropagation();
  if (noteId) {
    NOTE_EDIT_MODE.delete(noteId);
    delete NOTE_EDIT_DRAFTS[`edit:${noteId}`];
  } else {
    if (NOTE_CREATE_FOLDER_ID === folderId) NOTE_CREATE_FOLDER_ID = null;
    delete NOTE_EDIT_DRAFTS[`create:${folderId}`];
  }
  render();
}
// Botões da barra de formatação (negrito/itálico/sublinhado/alinhamento) do
// editor — document.execCommand está deprecated mas continua funcionando em
// todos os navegadores relevantes pra formatar um <div contenteditable>
// local; é a mesma abordagem simples já usada pra colar/redimensionar
// imagem aqui (sem editor de terceiros). O onmousedown="event.preventDefault()"
// no botão (ver db-render-engine.js) evita que o clique tire o foco/seleção
// de texto do editor antes do comando rodar — sem isso, a seleção seria
// perdida e nada seria formatado.
// Agora existe potencialmente MAIS DE UM editor de nota na tela ao mesmo
// tempo (uma nota nova + uma existente sendo editada, por exemplo) — por
// isso `neExec`/`neSetFontSize`/`neSetColor` recebem o próprio elemento
// clicado (`btn`/`selectEl`/`el`) e localizam o editor mais próximo via
// `.closest('.note-flat-body-editing')`, em vez de um id fixo único.
function neExec(btn, cmd) {
  const wrap = btn.closest('.note-flat-body-editing');
  const body = wrap && wrap.querySelector('.note-editor-body');
  if (body) body.focus();
  document.execCommand(cmd, false, null);
  // Atualiza o próprio botão clicado (e o resto da barra) imediatamente —
  // pedido do usuário: "ao clicar ou selecionar um texto a barra de
  // configurações deve mostrar as configurações atuais" (o botão Bold/
  // Italic/Underline/alinhamento precisa refletir o estado já no clique,
  // sem esperar um próximo mouseup/keyup).
  if (body) { _neSaveSelectionFor(body); _neUpdateToolbarState(body); }
}

// Tamanho de fonte e cor (5 cores fixas, ver colorSwatches em
// buildNoteCardHtml) usam o mesmo dropdown .ne-fmt-dd (botão + painel de
// opções, ver index.html/Details) — pedido do usuário: "deixar o menu de
// formatação em notes de folder igual dos comandos". Como cada opção do
// dropdown é um botão com onmousedown="event.preventDefault()" (nunca ganha
// foco), guardamos a última seleção real feita dentro de cada
// `.note-editor-body` (_neSaveSelectionFor, disparado em mouseup/keyup
// delegados abaixo) como uma propriedade no PRÓPRIO elemento
// (`editor._neLastRange`, não uma variável global única — precisa ser
// por-editor, já que pode haver mais de um editor aberto ao mesmo tempo) e a
// restauramos (_neRestoreSelectionFor) antes de aplicar o comando — sem
// isso, escolher um tamanho/cor formataria uma seleção vazia/errada (ou
// nenhuma).
function _neSaveSelectionFor(editor) {
  const sel = window.getSelection();
  if (editor && sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    editor._neLastRange = sel.getRangeAt(0).cloneRange();
  }
}
function _neRestoreSelectionFor(editor) {
  if (!editor) return;
  editor.focus();
  if (editor._neLastRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(editor._neLastRange);
  }
}
// Delegados (em vez de um listener fixo por id) porque cada `.note-editor-
// body` é criado/destruído dinamicamente pelo ciclo de render() — um
// addEventListener direto no elemento, feito uma única vez no carregamento
// do script (como na versão anterior, baseada em modal estático), só
// funcionaria pro PRIMEIRO editor que existisse, nunca mais depois de um
// render() reconstruir o DOM.
document.addEventListener('mouseup', ev => {
  const editor = ev.target.closest && ev.target.closest('.note-editor-body');
  if (editor) { _neSaveSelectionFor(editor); _neUpdateToolbarState(editor); }
});
document.addEventListener('keyup', ev => {
  const editor = ev.target.closest && ev.target.closest('.note-editor-body');
  if (editor) { _neSaveSelectionFor(editor); _neUpdateToolbarState(editor); }
});
// "Estilo Word" (pedido do usuário no Details do editor de comandos): ao
// clicar/mover o cursor dentro do texto, o campo de tamanho de fonte deve
// refletir o tamanho vigente naquele ponto, em vez de ficar sempre com um
// valor fixo. Sobe a árvore a partir do nó da seleção procurando o primeiro
// font-size inline explícito (aplicado por neSetFontSize abaixo); se não
// achar nenhum, assume o tamanho padrão do editor (12px, ver .note-editor-
// body em css/components.css).
function _neCurrentFontSizeAt(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return 12;
  let node = sel.anchorNode;
  if (node.nodeType === 3) node = node.parentElement;
  while (node && node !== editor && editor.contains(node)) {
    if (node.style && node.style.fontSize) {
      const n = parseInt(node.style.fontSize, 10);
      if (!isNaN(n)) return n;
    }
    node = node.parentElement;
  }
  return 12;
}
// Mesma ideia de _neCurrentFontSizeAt, mas pra cor do texto: sobe a árvore a
// partir do nó da seleção procurando o primeiro `color` inline explícito
// (aplicado por neSetColor abaixo, via style ou o <font color> legado que
// document.execCommand('foreColor') às vezes usa) — se não achar nenhum,
// assume a cor padrão do editor (preto). Devolve sempre um hex em minúsculas
// pra poder comparar direto com os data-color dos swatches.
function _neCurrentColorAt(editor) {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    let node = sel.anchorNode;
    if (node.nodeType === 3) node = node.parentElement;
    while (node && node !== editor && editor.contains(node)) {
      if (node.style && node.style.color) return _neRgbToHex(node.style.color);
      if (node.tagName === 'FONT' && node.getAttribute('color')) return node.getAttribute('color').toLowerCase();
      node = node.parentElement;
    }
  }
  return '#000000';
}
// Navegadores normalizam `style.color` pra "rgb(r, g, b)" ao ler de volta
// mesmo quando o valor foi setado como hex (ver neSetColor) — sem esta
// conversão, comparar contra os data-color dos swatches (sempre hex) nunca
// bateria.
function _neRgbToHex(value) {
  if (!value) return '#000000';
  if (value[0] === '#') return value.toLowerCase();
  const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return '#000000';
  const toHex = n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
  return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
}
// Atualiza TODA a barra de formatação pro estado vigente no ponto do cursor/
// seleção — pedido do usuário: "ao clicar ou selecionar um texto a barra de
// configurações deve mostrar as configurações atuais" (relatou que só o
// tamanho da fonte refletia corretamente; negrito/itálico/cor ficavam
// sempre no estado padrão do botão, mesmo com o texto selecionado já
// formatado diferente). Cobre, em ambos os editores (Notes e Details do
// editor de comandos, mesmo toolbar compartilhada):
//  - tamanho de fonte: rótulo do dropdown + opção destacada (.on), como já
//    era em _neUpdateFontSizeDisplay (função renomeada);
//  - negrito/itálico/sublinhado/alinhamento: destaca (.on) cada botão
//    marcado com data-ne-cmd cujo document.queryCommandState(cmd) esteja
//    ativo no ponto atual — a mesma técnica usada por qualquer editor
//    baseado em execCommand pra saber "o texto sob o cursor já está em
//    negrito?";
//  - cor do texto: atualiza o swatch de preview (.ne-fmt-color-trigger-
//    swatch) e destaca (.on) o swatch correspondente na lista.
// `forceSize`/`forceColor`: quando informados, usam esse valor em vez de
// redetectar via _neCurrentFontSizeAt/_neCurrentColorAt (ver neSetFontSize/
// neSetColor abaixo). Necessário pro tamanho porque, logo depois de aplicar,
// a seleção é recriada com setStartBefore/setEndAfter sobre o(s)
// elemento(s) afetado(s) — isso posiciona o nó-âncora da seleção no
// elemento PAI dos spans recém-formatados (com um offset apontando pra
// eles), não DENTRO de um deles; _neCurrentFontSizeAt/_neCurrentColorAt só
// sobem a árvore a partir do nó-âncora (nunca descem pros filhos), então
// nesse caso específico nunca alcançariam o style aplicado e sempre
// "achariam" o valor herdado do pai — foi o que o usuário reportou antes
// pro tamanho ("alterei o tamanho para 18, mas no menu continua exibindo
// 12"); o mesmo se aplicaria à cor sem forceColor.
function _neUpdateToolbarState(editor, forceSize, forceColor) {
  const wrap = editor.closest('.note-flat-body-editing');
  if (!wrap) return;
  const size = (typeof forceSize === 'number') ? forceSize : _neCurrentFontSizeAt(editor);
  const label = wrap.querySelector('.ne-fmt-dd-btn-label');
  if (label) label.textContent = size;
  wrap.querySelectorAll('.ne-fmt-size-opt').forEach(b => {
    b.classList.toggle('on', Number(b.dataset.size) === size);
  });
  wrap.querySelectorAll('.ne-fmt-btn[data-ne-cmd]').forEach(btn => {
    let active = false;
    try { active = document.queryCommandState(btn.dataset.neCmd); } catch (e) { /* comando não suportado neste navegador */ }
    btn.classList.toggle('on', active);
  });
  const color = (typeof forceColor === 'string') ? forceColor.toLowerCase() : _neCurrentColorAt(editor);
  const trigger = wrap.querySelector('.ne-fmt-color-trigger-swatch');
  if (trigger) trigger.style.background = color;
  wrap.querySelectorAll('.ne-fmt-color-swatch').forEach(b => {
    b.classList.toggle('on', (b.dataset.color || '').toLowerCase() === color);
  });
}
// Usado por _ceResetForm/_cePopulateForm (js/command-editor.js) pra devolver
// o dropdown de tamanho ao padrão (12) quando o modal reaproveitado é
// reaberto — sem isso o botão/lista continuariam mostrando o último
// tamanho clicado na edição anterior.
function _neResetFontSizeUI(labelId, listId) {
  const label = document.getElementById(labelId);
  if (label) label.textContent = 12;
  const list = document.getElementById(listId);
  if (list) list.querySelectorAll('.ne-fmt-size-opt').forEach(b => b.classList.toggle('on', b.dataset.size === '12'));
}

// ── Dropdowns de tamanho/cor do toolbar (ver .ne-fmt-dd em index.html) ──
// Mesmo espírito do toggleFolderMenu() acima (botão e painel resolvidos por
// proximidade via closest/querySelector, não por id fixo) — necessário aqui
// porque pode haver mais de um editor de nota aberto na tela ao mesmo tempo
// (cada um com seu próprio par tamanho/cor), então um id global não serviria.
// Diferente do antigo <input type="number"> dentro do painel, a lista de
// tamanhos (.ne-fmt-size-opt) é só botões com onmousedown="event.
// preventDefault()" — abrir o dropdown NUNCA move o foco pra dentro dele,
// então a seleção de texto no editor permanece visível o tempo todo (bug
// relatado pelo usuário: "quando clico no tamanho da fonte a seleção do
// texto está sendo removida" — a causa era justamente o antigo .focus()
// chamado aqui embaixo pra permitir digitar no <input>).
function _neToggleFmtDropdown(btn) {
  const wrap = btn.closest('.ne-fmt-dd');
  const panel = wrap && wrap.querySelector('.ne-fmt-dd-panel');
  if (!panel) return;
  const willOpen = !panel.classList.contains('open');
  _neCloseFmtDropdowns();
  panel.classList.toggle('open', willOpen);
}
function _neCloseFmtDropdowns() {
  document.querySelectorAll('.ne-fmt-dd-panel.open').forEach(p => p.classList.remove('open'));
}
document.addEventListener('click', ev => {
  if (ev.target.closest('.ne-fmt-dd')) return;
  _neCloseFmtDropdowns();
});
// Mantém NOTE_EDIT_DRAFTS (ver comentário acima) sincronizado a cada tecla/
// edição — é o que protege o texto em andamento de um render() disparado
// por outro motivo enquanto o usuário ainda está escrevendo/formatando.
document.addEventListener('input', ev => {
  const editor = ev.target.closest && ev.target.closest('.note-editor-body');
  if (editor && editor.dataset.noteDraftKey) {
    NOTE_EDIT_DRAFTS[editor.dataset.noteDraftKey] = editor.innerHTML;
  }
});

// document.execCommand('fontSize', ...) só aceita a escala legada de 1 a 7
// (sem controle em pixels) — o truque padrão (sem precisar de nenhuma lib)
// é aplicar o tamanho 7 (usado só como marcador único, fácil de achar
// depois) e então trocar cada <font size="7"> resultante por um `style`
// inline com o tamanho em px de verdade, removendo o atributo `size`. Para
// o <select> das Notes, o próprio elemento volta pro placeholder ("Size")
// depois de aplicar (ver onchange em db-render-engine.js), pra poder
// escolher o MESMO tamanho de novo em seguida sem precisar trocar de opção
// primeiro — isso é feito no HTML, não aqui dentro. Já o novo <input
// type="number"> "estilo Word" (Details do editor de comandos, ver
// index.html) faz o oposto: mantém o valor exibido (não faz sentido limpar
// um número que o usuário acabou de digitar), e esta função o corrige de
// volta pro intervalo permitido (8–24) caso ele tenha digitado algo fora
// da faixa.
// Bug relatado pelo usuário: "quando seleciono o texto e clico em diminuir o
// tamanho a seleção está sendo removida. para aumentar dois tamanhos tenho
// que selecionar duas vezes". Causa: document.execCommand('fontSize') troca
// o(s) nó(s) de texto selecionado(s) por novos elementos <font> — a Range
// salva em editor._neLastRange ANTES da troca (pelo mouseup/keyup no editor)
// passa a apontar pros nós antigos, que não existem mais no DOM depois da
// troca. Se o usuário aplicar o tamanho de novo em seguida (sem re-selecionar
// manualmente o texto), _neRestoreSelectionFor tenta restaurar essa Range
// stale — o navegador não consegue e a seleção visualmente some/fica vazia,
// então o segundo ajuste não aplica em nada. A correção: depois de trocar os
// <font size="7"> por spans com o style novo, resseleciona o texto recém-
// formatado (do início do primeiro elemento afetado ao fim do último) e
// GRAVA essa Range fresca de volta em _neLastRange — assim tanto a seleção
// visual quanto um próximo ajuste imediato (aumentar/diminuir de novo sem
// reselecionar) continuam funcionando corretamente. `el` é um dos botões da
// lista .ne-fmt-size-opt (ver index.html) — nunca ganha foco (onmousedown
// preventDefault), então a seleção no editor nem chega a piscar/sumir ao
// clicar numa opção, diferente do antigo <input type="number">.
function neSetFontSize(el, px) {
  let n = parseInt(px, 10);
  if (isNaN(n)) return;
  n = Math.max(8, Math.min(24, n));
  const wrap = el.closest('.note-flat-body-editing');
  const body = wrap && wrap.querySelector('.note-editor-body');
  if (!body) return;
  _neRestoreSelectionFor(body);
  document.execCommand('fontSize', false, '7');
  const affected = Array.from(body.querySelectorAll('font[size="7"]'));
  affected.forEach(f => {
    f.removeAttribute('size');
    f.style.fontSize = n + 'px';
  });
  if (affected.length) {
    const range = document.createRange();
    range.setStartBefore(affected[0]);
    range.setEndAfter(affected[affected.length - 1]);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    _neSaveSelectionFor(body);
  }
  if (el && el.tagName === 'INPUT') el.value = n; // <select>/<input> legados das Notes, se algum dia usados aqui
  // Passa `n` (o tamanho que ACABAMOS de aplicar) em vez de deixar
  // _neUpdateToolbarState redetectar sozinha — ver comentário na função
  // sobre por que a redetecção falha logo após aplicar (nó-âncora fica no
  // elemento pai dos spans afetados, não dentro deles).
  _neUpdateToolbarState(body, n);
  // Fecha o dropdown ao escolher um tamanho — mesmo padrão de "fechar ao
  // selecionar" da cor, ver neSetColor abaixo.
  if (el && el.closest('.ne-fmt-dd')) _neCloseFmtDropdowns();
}
function neSetColor(el, color) {
  const wrap = el.closest('.note-flat-body-editing');
  const body = wrap && wrap.querySelector('.note-editor-body');
  if (!body) return;
  _neRestoreSelectionFor(body);
  document.execCommand('foreColor', false, color);
  // Fecha o dropdown de cor (se o swatch estiver dentro de um, ver
  // index.html — pedido do usuário: "deixe... cores em opção dropdown").
  if (el.closest('.ne-fmt-dd')) _neCloseFmtDropdowns();
  _neSaveSelectionFor(body);
  // Passa `color` (a cor que ACABAMOS de aplicar) em vez de deixar
  // _neUpdateToolbarState redetectar sozinha via _neCurrentColorAt — mesmo
  // motivo do forceSize em neSetFontSize acima (a seleção pode não cair
  // exatamente dentro do nó recém-colorido). Atualiza tanto o preview do
  // botão quanto o destaque (.on) do swatch escolhido.
  _neUpdateToolbarState(body, undefined, color);
}
// Inserir link — pedido do usuário: "inclua uma opção para inserir link no
// menu de detalhes e em notas também" (Details do editor de comandos e
// Notes, mesmo botão/toolbar compartilhados — ver index.html/
// db-render-engine.js). Diferente de bold/italic/tamanho/cor, este botão
// NÃO usa onmousedown="event.preventDefault()": pedir a URL abre um modal
// (openFolderPromptModal, reaproveitado — ver mode 'link' lá), que
// necessariamente tira o foco do editor pra poder receber o texto digitado.
// Por isso a seleção é lida de body._neLastRange (a mesma Range guardada
// pelos listeners de mouseup/keyup do editor, delegados no topo deste
// arquivo) ANTES de abrir o modal, em vez de depender do foco ainda estar no
// editor no momento do clique — mesmo mecanismo já usado pelo <select> de
// cor/tamanho das Notes, que também precisa ganhar foco.
async function neInsertLink(btn) {
  const wrap = btn.closest('.note-flat-body-editing');
  const body = wrap && wrap.querySelector('.note-editor-body');
  if (!body) return;
  const savedRange = body._neLastRange ? body._neLastRange.cloneRange() : null;
  const hasSelection = !!(savedRange && !savedRange.collapsed);
  let url = await openFolderPromptModal('link');
  if (!url) return;
  url = url.trim();
  // Sem esquema (ex.: usuário digitou "checkpoint.com") — assume https://,
  // mesmo comportamento que a maioria dos editores de texto rico faz, pra
  // não depender do usuário lembrar de digitar o protocolo. Mantém como está
  // se já vier com um esquema (http/https/mailto/etc.) — sanitizeNoteHtml no
  // servidor (ver server/index.js) só aceita http(s):// de qualquer forma,
  // então um esquema diferente vira '#' lá, mas não é papel do front-end
  // impedir o usuário de tentar.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
  body.focus();
  const sel = window.getSelection();
  if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
  if (hasSelection) {
    document.execCommand('createLink', false, url);
  } else if (savedRange) {
    // Sem texto selecionado: insere a própria URL como texto do link, na
    // posição do cursor (via DOM/Range direto — não via execCommand
    // insertHTML/string concatenada — não precisa escapar nada e não corre
    // risco de quebrar com aspas/caracteres especiais na URL).
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    savedRange.deleteContents();
    savedRange.insertNode(a);
    const after = document.createRange();
    after.setStartAfter(a);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  } else {
    // Nunca houve uma posição de cursor registrada neste editor (ex.:
    // clicou direto no botão sem nunca ter clicado dentro do texto) —
    // acrescenta o link no final do conteúdo em vez de falhar silenciosamente.
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    body.appendChild(a);
  }
  _neSaveSelectionFor(body);
  if (btn.closest('.ne-fmt-dd')) _neCloseFmtDropdowns();
}
// Substitui saveNoteEditor() — salva a nota (nova OU existente) a partir do
// PRÓPRIO card em edição, localizado pelo id previsível do seu editor
// (noteEditorEdit_<id> / noteEditorNew_<folderId>, ver buildNoteCardHtml),
// em vez do antigo #noteBodyEditor fixo do modal.
async function acceptNoteEdit(noteId, folderId, ev) {
  if (ev) ev.stopPropagation();
  const editorId = noteId ? `noteEditorEdit_${noteId}` : `noteEditorNew_${folderId}`;
  const bodyEl = document.getElementById(editorId);
  const description = bodyEl ? bodyEl.innerHTML : '';
  // "Vazia" = sem texto E sem nenhuma imagem colada — uma nota só com
  // imagem (sem nenhum texto) ainda é válida, então não basta checar se
  // sobra texto depois de tirar as tags (isso descartaria uma nota só de
  // imagem, já que <img> também some nesse strip).
  const hasText = !!((bodyEl && bodyEl.textContent) || '').trim();
  const hasImage = !!(bodyEl && bodyEl.querySelector('img'));
  if (!hasText && !hasImage) {
    alert('Write something in the note.');
    return;
  }
  const title = _deriveNoteTitle(description);
  try {
    const res = noteId
      ? await fetch(`/api/notes/${noteId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description }) })
      : await fetch(`/api/folders/${folderId}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description }) });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      alert(errBody.message || 'Failed to save note.');
      return;
    }
    const note = await res.json();
    const folder = FOLDERS.find(f => f.id === note.folder_id);
    if (folder) {
      if (!folder.notes) folder.notes = [];
      const idx = folder.notes.findIndex(n => n.id === note.id);
      if (idx !== -1) folder.notes[idx] = note; else folder.notes.push(note);
      if (!folder.order) folder.order = [];
      if (!folder.order.some(o => o.type === 'note' && o.id === note.id)) folder.order.push({ type: 'note', id: note.id });
    }
    if (noteId) { NOTE_EDIT_MODE.delete(noteId); delete NOTE_EDIT_DRAFTS[`edit:${noteId}`]; }
    else { if (NOTE_CREATE_FOLDER_ID === folderId) NOTE_CREATE_FOLDER_ID = null; delete NOTE_EDIT_DRAFTS[`create:${folderId}`]; }
    render();
  } catch (e) {
    alert('Failed to save note. Please try again.');
  }
}
// Excluir (pedido: "exiba o botão de excluir nota somente quando estiver
// editando") — só é chamado a partir do botão Delete dentro do modo de
// edição agora (ver buildNoteCardHtml), mas a lógica de exclusão em si não
// muda.
function deleteNoteConfirm(noteId, title, ev) {
  if (ev) ev.stopPropagation();
  openConfirmModal(`Delete note "${title}"? This action cannot be undone.`).then(ok => {
    if (!ok) return;
    NOTE_EDIT_MODE.delete(noteId);
    delete NOTE_EDIT_DRAFTS[`edit:${noteId}`];
    FOLDERS.forEach(f => {
      if (f.notes) f.notes = f.notes.filter(n => n.id !== noteId);
      if (f.order) f.order = f.order.filter(o => !(o.type === 'note' && o.id === noteId));
    });
    render();
    fetch(`/api/notes/${noteId}`, { method: 'DELETE' }).catch(e => {
      console.warn('Falha ao excluir nota no servidor (mantida localmente)', e);
    });
  });
}
// Clona uma nota PRÓPRIA na MESMA pasta (título com sufixo " (copy)", ver
// POST /api/notes/:id/clone em server/index.js) — mesmo espírito do
// "Duplicate command", mas sem precisar abrir editor: já cria a cópia
// direto e a tela reflete na hora.
async function cloneNote(noteId, ev) {
  if (ev) ev.stopPropagation();
  try {
    const res = await fetch(`/api/notes/${noteId}/clone`, { method: 'POST' });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      alert(errBody.message || 'Failed to clone note.');
      return;
    }
    const note = await res.json();
    const folder = FOLDERS.find(f => f.id === note.folder_id);
    if (folder) {
      if (!folder.notes) folder.notes = [];
      folder.notes.push(note);
      if (!folder.order) folder.order = [];
      folder.order.push({ type: 'note', id: note.id });
    }
    render();
  } catch (e) {
    alert('Failed to clone note. Please try again.');
  }
}

// ── Colar/redimensionar imagens dentro da nota (task Notes) ──
// Cola uma imagem (Ctrl+V com uma imagem na área de transferência) dentro
// do editor: intercepta o evento de paste, lê o arquivo via FileReader
// (mesma técnica já usada pra linhas de comando tipo 'image', ver
// _ceHandleImageFileInput em js/command-editor.js) e insere um <img> no
// ponto do cursor como data URI base64 — sem upload nem endpoint próprio de
// arquivo, a imagem vira parte do próprio HTML da nota. Colar texto normal
// continua funcionando do jeito padrão do navegador (contenteditable).
// `editor` agora é passado explicitamente (delegado, ver listener abaixo) em
// vez de buscado por id fixo, pelo mesmo motivo de _neSaveSelectionFor.
function _neHandlePaste(ev, editor) {
  const items = (ev.clipboardData && ev.clipboardData.items) || [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type && item.type.startsWith('image/')) {
      ev.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => _neInsertImage(reader.result, editor);
      reader.readAsDataURL(file);
      return;
    }
  }
}
function _neInsertImage(dataUrl, editor) {
  if (!editor) return;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.width = 320; // largura inicial razoável — arrastável depois pelo canto (ver _neArmImageResize)
  editor.focus();
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editor.appendChild(img);
  }
  _neArmImageResize(img);
}
// Redimensiona arrastando o canto inferior-direito da imagem (últimos 16px
// x16px) — só altera a largura (atributo `width`, o mesmo que
// sanitizeNoteHtml preserva no servidor); a altura acompanha
// proporcionalmente sozinha (comportamento padrão do navegador pra um
// <img width="N"> sem height fixado).
function _neArmImageResize(img) {
  img.style.cursor = 'nwse-resize';
  img.addEventListener('mousedown', ev => {
    const rect = img.getBoundingClientRect();
    const nearCorner = (ev.clientX > rect.right - 16) && (ev.clientY > rect.bottom - 16);
    if (!nearCorner) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = rect.width;
    function onMove(moveEv) {
      const newWidth = Math.max(40, Math.min(900, startWidth + (moveEv.clientX - startX)));
      img.width = Math.round(newWidth);
      img.removeAttribute('height');
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
// Ao abrir um editor com conteúdo já existente (nota que já tinha imagens),
// as imagens que vieram no HTML salvo também precisam da alça de
// redimensionar — só as coladas na hora (via _neInsertImage) ganham isso
// automaticamente pelo próprio fluxo de colar.
function _neArmExistingImages(container) {
  container.querySelectorAll('img').forEach(img => _neArmImageResize(img));
}
document.addEventListener('paste', ev => {
  const editor = ev.target.closest && ev.target.closest('.note-editor-body');
  if (editor) _neHandlePaste(ev, editor);
});
// Chamado por js/render.js logo depois de reconstruir #out — rearma a alça
// de redimensionar em TODAS as imagens de TODOS os editores de nota
// atualmente na tela (existentes ou rascunho novo), já que innerHTML
// recriou os elementos <img> do zero e qualquer listener anterior neles se
// perdeu junto. Nome com `_ne` (mesmo prefixo das demais funções de Notes
// Editor) e `_re` de "rearm", pra não colidir com nada.
function _neRearmActiveEditors() {
  document.querySelectorAll('.note-editor-body').forEach(_neArmExistingImages);
}
// Antes (modal), clicar fora da caixa fechava o editor e descartava tudo
// que o usuário tinha escrito — pedido do usuário, em outra ocasião:
// "quando estou editando uma nota ou comando, e clico fora da janela eu
// perco tudo que tinha feito. mantenha na tela aberta até que eu salve ou
// feche a janela". Não existe mais um "fora da caixa" (não há mais overlay
// modal) — a nota só fecha/descarta via "✕ Cancel" (cancelNoteEdit(), sem
// salvar) ou "✓ Accept" (acceptNoteEdit()), igual ao padrão de edição de
// pastas (FOLDER_EDIT_MODE, ver acima).

// Filtra os cards pelo texto digitado no campo de pesquisa (nome, descrição, tags e o
// próprio texto dos comandos). Roda depois do filtro de pastas, então só esconde
// mais — nunca reexibe um card que o filtro de pastas já escondeu.
// Chamado a cada tecla digitada no campo de pesquisa: mostra/esconde o "x" de limpar
// na hora (feedback imediato) e reaplica o filtro de texto com um pequeno debounce.
//
// Antes chamava render() completo a cada tecla — que reconstrói TODO o #out
// (innerHTML com o HTML de cada card, de novo, do zero) mesmo sem nenhum dado
// ter mudado, só porque render() também chama applySearchFilter() no final
// (ver js/render.js). Mas applySearchFilter() é um filtro 100% em cima do DOM
// já existente (mostra/esconde .card via textContent, não usa nada que só um
// render() novo produziria) — então bastava chamar só ela. Ficou muito
// perceptível depois do import de 1452 comandos: cada tecla digitada
// disparava um rebuild de ~1452 cards de HTML só para no fim aplicar um
// filtro que nem olha pro HTML novo.
let _cmdSearchDebounceTimer = null;
function onSearchInput() {
  updateSearchClearBtn();
  if (_cmdSearchDebounceTimer) clearTimeout(_cmdSearchDebounceTimer);
  _cmdSearchDebounceTimer = setTimeout(() => {
    _cmdSearchDebounceTimer = null;
    applySearchFilter();
  }, 120);
}
function updateSearchClearBtn() {
  const btn = document.getElementById('cmdSearchClear');
  if (!btn) return;
  const hasText = !!(gv('cmdSearch') || '').length;
  btn.style.display = hasText ? 'flex' : 'none';
}
function clearCommandSearch() {
  const input = document.getElementById('cmdSearch');
  if (!input) return;
  saveCmdSearchHistoryEntry(input.value); // preserva o texto no histórico antes de limpar
  input.value = '';
  updateSearchClearBtn();
  if (_cmdSearchDebounceTimer) { clearTimeout(_cmdSearchDebounceTimer); _cmdSearchDebounceTimer = null; }
  applySearchFilter(); // mesmo motivo de onSearchInput() — não precisa de um render() completo
  input.focus();
}

// ── Histórico da pesquisa de comandos (sidebar "Search commands...") ──
// Independente do histórico da barra de parâmetros (query-bar.js) — chave própria no
// localStorage, mesma janela de 7 dias e mesmo limite de ~10 itens visíveis com scroll.
// Como aqui é um único texto livre (sem tags/labels), o salvamento acontece só ao sair
// do campo (blur/clique fora) ou ao limpar — nunca a cada tecla digitada.
// A chave inclui o usuário atual (CURRENT_USER, ver js/user-sync.js) —
// mesmo motivo/mesma técnica do histórico de query-bar.js: sem isso, dois
// usuários que fazem login/logout local no mesmo navegador (js/auth.js)
// veriam o histórico de busca um do outro, já que o localStorage é do
// navegador, não da sessão lógica da aplicação. Enquanto CURRENT_USER
// ainda não foi resolvido, load/save não fazem nada (falha fechada, nunca
// um balde "anônimo" compartilhado entre usuários).
function cmdSearchHistoryKey() {
  return 'cpa-cmdsearch-history:' + CURRENT_USER;
}
const CMD_SEARCH_HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CMD_SEARCH_HISTORY_MAX_ITEMS = 200;

function loadCmdSearchHistoryRaw() {
  if (typeof CURRENT_USER === 'undefined' || !CURRENT_USER) return [];
  try {
    const raw = localStorage.getItem(cmdSearchHistoryKey());
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveCmdSearchHistoryRaw(arr) {
  if (typeof CURRENT_USER === 'undefined' || !CURRENT_USER) return;
  try { localStorage.setItem(cmdSearchHistoryKey(), JSON.stringify(arr)); } catch (e) {}
}
function loadCmdSearchHistory() {
  const now = Date.now();
  const all = loadCmdSearchHistoryRaw();
  const fresh = all.filter(e => e && typeof e.text === 'string' && (now - e.ts) < CMD_SEARCH_HISTORY_MAX_AGE_MS);
  if (fresh.length !== all.length) saveCmdSearchHistoryRaw(fresh);
  return fresh.sort((a, b) => b.ts - a.ts);
}
function saveCmdSearchHistoryEntry(text) {
  text = (text || '').trim();
  if (!text) return;
  const now = Date.now();
  let all = loadCmdSearchHistoryRaw().filter(e => e && e.text !== text && (now - e.ts) < CMD_SEARCH_HISTORY_MAX_AGE_MS);
  all.unshift({ text, ts: now });
  if (all.length > CMD_SEARCH_HISTORY_MAX_ITEMS) all = all.slice(0, CMD_SEARCH_HISTORY_MAX_ITEMS);
  saveCmdSearchHistoryRaw(all);
  renderCmdSearchHistoryUI();
}
function removeCmdSearchHistoryEntry(text) {
  const all = loadCmdSearchHistoryRaw().filter(e => e.text !== text);
  saveCmdSearchHistoryRaw(all);
  renderCmdSearchHistoryUI();
}
function clearCmdSearchHistory() {
  saveCmdSearchHistoryRaw([]);
  renderCmdSearchHistoryUI();
}
function formatCmdSearchHistoryTime(ts) {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}
function applyCmdSearchHistoryEntry(text) {
  const input = document.getElementById('cmdSearch');
  if (input) input.value = text;
  updateSearchClearBtn();
  render();
  if (input) input.focus();
}
function escapeCmdSearchHistoryHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
// Ver jsAttrEscape em query-bar.js para a explicação da ordem de escape (JS primeiro,
// depois HTML) — necessária para embutir texto do usuário com segurança dentro de um
// atributo onclick="...('TEXTO')".
function jsAttrEscapeCmdSearch(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
// ── Agrupamento por dia (Hoje/Ontem/dd-mm), com expandir/recolher por grupo — ver
// query-bar.js para a versão irmã (mesma lógica, chave própria em memória). ──
function cmdSearchHistoryDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function cmdSearchHistoryDayLabel(ts) {
  const startOfDay = t => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  // dd/mm fixo (não depende do locale do navegador) — mesmo padrão de
  // formatAuditDate (terminal-renderer.js) e queryHistoryDayLabel (query-bar.js).
  const d = new Date(ts);
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
}
const CMD_SEARCH_HISTORY_COLLAPSED_DAYS = new Set();
function toggleCmdSearchHistoryDay(key) {
  const el = document.querySelector(`#cmdSearchHistoryList .cpq-history-day[data-day-key="${key}"]`);
  if (!el) return;
  const willCollapse = !el.classList.contains('collapsed');
  el.classList.toggle('collapsed', willCollapse);
  if (willCollapse) CMD_SEARCH_HISTORY_COLLAPSED_DAYS.add(key); else CMD_SEARCH_HISTORY_COLLAPSED_DAYS.delete(key);
}
function cmdSearchHistoryItemRowHtml(e) {
  return `<div class="cpq-history-item" onmousedown="event.preventDefault()" onclick="applyCmdSearchHistoryEntry('${jsAttrEscapeCmdSearch(e.text)}')">
    <span class="cpq-history-item-txt" title="${escapeCmdSearchHistoryHtml(e.text)}">${escapeCmdSearchHistoryHtml(e.text)}</span>
    <span class="cpq-history-item-time">${formatCmdSearchHistoryTime(e.ts)}</span>
    <button type="button" class="cpq-history-item-x" onmousedown="event.preventDefault()" onclick="event.stopPropagation(); removeCmdSearchHistoryEntry('${jsAttrEscapeCmdSearch(e.text)}')" title="Remove from history">✕</button>
  </div>`;
}
function renderCmdSearchHistoryUI() {
  const list = document.getElementById('cmdSearchHistoryList');
  if (!list) return;
  const entries = loadCmdSearchHistory(); // já vem ordenado do mais recente para o mais antigo
  const clearBtn = document.getElementById('cmdSearchHistoryClearBtn');
  if (clearBtn) clearBtn.style.display = entries.length ? '' : 'none';
  if (!entries.length) {
    list.innerHTML = `<div class="cpq-history-empty">No recent searches.</div>`;
    return;
  }
  const groups = [];
  entries.forEach(e => {
    const key = cmdSearchHistoryDayKey(e.ts);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(e);
    else groups.push({ key, label: cmdSearchHistoryDayLabel(e.ts), items: [e] });
  });
  list.innerHTML = groups.map(g => {
    const collapsed = CMD_SEARCH_HISTORY_COLLAPSED_DAYS.has(g.key);
    return `<div class="cpq-history-day${collapsed ? ' collapsed' : ''}" data-day-key="${g.key}">
      <div class="cpq-history-day-head" onmousedown="event.preventDefault()" onclick="toggleCmdSearchHistoryDay('${g.key}')">
        <svg class="cpq-history-day-chevron" width="8" height="8" viewBox="0 0 10 10" fill="none"><path d="M1 2l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${g.label}</span>
        <span class="cpq-history-day-count">${g.items.length}</span>
      </div>
      <div class="cpq-history-day-body">${g.items.map(cmdSearchHistoryItemRowHtml).join('')}</div>
    </div>`;
  }).join('');
}
function openCmdSearchHistoryPanel() {
  const panel = document.getElementById('cmdSearchHistoryPanel');
  if (panel) panel.classList.add('open');
  renderCmdSearchHistoryUI();
}
function closeCmdSearchHistoryPanel() {
  const panel = document.getElementById('cmdSearchHistoryPanel');
  if (panel) panel.classList.remove('open');
  saveCmdSearchHistoryEntry(gv('cmdSearch'));
}
document.addEventListener('click', ev => {
  const wrap = ev.target.closest('.cmd-search-wrap');
  if (!wrap) closeCmdSearchHistoryPanel();
});
function applySearchFilter() {
  const out = document.getElementById('out');
  const query = (gv('cmdSearch') || '').trim().toLowerCase();
  const cards = [...out.querySelectorAll('.card')];
  // Bug reportado: "as pastas sem comandos não estão sendo exibidas" — o
  // loop que esconde `.section` sem NENHUM `.card` visível (mais abaixo)
  // rodava incondicionalmente, mesmo sem busca nenhuma ativa (query vazia).
  // Uma pasta vazia (0 comandos/0 notas) já nasce sem nenhum `.card` dentro
  // — então esse loop escondia ela sempre, não só durante uma pesquisa sem
  // resultado (que era a intenção original). Seções normais (Tópico/etc.)
  // nunca são geradas com 0 cards em primeiro lugar (já filtradas na hora
  // de montar o HTML — ver render.js), então esse "esconder seção vazia" só
  // fazia sentido mesmo como resultado de uma busca ativa filtrando os
  // cards de dentro. Sem query, não mexe em .section nenhuma — inclusive
  // restaura qualquer .section que uma busca ANTERIOR tenha escondido (ex.:
  // usuário digitou algo, viu 0 resultados, depois apagou a busca).
  if (!query) {
    out.querySelectorAll('.section').forEach(sec => { sec.style.display = ''; });
    return;
  }
  cards.forEach(c => {
    if (c.style.display === 'none') return;
    if (!c.textContent.toLowerCase().includes(query)) c.style.display = 'none';
  });
  out.querySelectorAll('.section').forEach(sec => {
    const visible = [...sec.querySelectorAll('.card')].some(c => c.style.display !== 'none');
    sec.style.display = visible ? '' : 'none';
  });
  const anyVisible = cards.some(c => c.style.display !== 'none');
  if (!anyVisible && !out.querySelector('.empty')) {
    const safe = query.replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    out.insertAdjacentHTML('beforeend', `<div class="empty"><div class="empty-ico">🔍</div><p>No commands found for "${safe}".</p></div>`);
  }
}

// ── Dropdown de pastas de cada card (ver folderMenuHtml() em
// terminal-renderer.js) — abre/fecha como os .dd da sidebar (mesmo padrão de
// fechar-os-outros do toggleDropdown/closeAllDropdowns em js/state.js), só
// que não é um .dd porque vive dentro de .card-actions, não da sidebar. ──
function toggleFolderMenu(ev, btn) {
  ev.stopPropagation();
  const pop = btn.parentElement.querySelector('.folder-menu-pop');
  if (!pop) return;
  const willOpen = !pop.classList.contains('open');
  document.querySelectorAll('.folder-menu-pop.open').forEach(p => { if (p !== pop) p.classList.remove('open'); });
  // Fecha qualquer flyout de subpasta (.folder-menu-submenu.show) que tenha
  // ficado aberto da última vez que ESTE MESMO pop foi usado — sem isso, ao
  // reabrir o dropdown ele apareceria com o flyout já expandido (herdado da
  // classe .show anterior), sem o usuário precisar passar o mouse de novo.
  pop.querySelectorAll('.folder-menu-submenu.show').forEach(sm => sm.classList.remove('show'));
  pop.classList.toggle('open', willOpen);
}
document.addEventListener('click', ev => {
  if (ev.target.closest('.folder-menu-pop') || ev.target.closest('.fav-btn')) return;
  document.querySelectorAll('.folder-menu-pop.open').forEach(p => p.classList.remove('open'));
});

// ── Subpastas no dropdown "Add to folder" de cada card (ver folderMenuHtml()
// em js/terminal-renderer.js) — pedido do usuário: "quando for adicionar um
// comando em uma subpasta, exiba a subpasta dentro da pasta pai. Coloque um
// menu estilo seta nas pastas que tiverem subpastas, e exiba as subpastas
// quando parar o mouse na pasta pai". Delegado em vez de um listener por item
// porque o dropdown inteiro (.folder-menu-pop) é reconstruído a cada
// render() — um listener preso a um elemento específico não sobreviveria a
// isso. `mouseover`/`mouseout` (que borbulham) em vez de `mouseenter`/
// `mouseleave` (que não borbulham) — só assim dá pra delegar num único par de
// listeners no `document`.
let _folderMenuSubmenuCloseTimer = null;
function _folderMenuShowSubmenu(item) {
  clearTimeout(_folderMenuSubmenuCloseTimer);
  const submenu = item.querySelector(':scope > .folder-menu-submenu');
  if (!submenu) return;
  // Só um caminho aberto por vez no MESMO nível (fecha os outros flyouts
  // irmãos) — igual um submenu nativo de sistema operacional.
  const parent = item.parentElement;
  if (parent) {
    parent.querySelectorAll(':scope > .folder-menu-item > .folder-menu-submenu.show').forEach(sm => {
      if (sm !== submenu) sm.classList.remove('show');
    });
  }
  // position:fixed (ver comentário em css/components.css) — recalculado a
  // cada hover porque a linha pode estar em qualquer posição da lista
  // rolável (.folder-menu-pop tem overflow-y:auto).
  const rect = item.getBoundingClientRect();
  submenu.style.top = `${Math.round(rect.top)}px`;
  submenu.style.left = `${Math.round(rect.right) + 2}px`;
  submenu.classList.add('show');
  // Se o flyout nasceu perto demais da borda direita da tela (nome de pasta
  // com muitas subpastas aninhadas, várias colunas de flyout empilhadas),
  // abre pra ESQUERDA da linha em vez de pra direita — mesmo espírito do
  // "o menu de adicionar o comando na pasta está ficando cortado" que já
  // motivou o .folder-menu-pop principal a abrir pra esquerda (right:0).
  const submenuRect = submenu.getBoundingClientRect();
  if (submenuRect.right > window.innerWidth - 8) {
    submenu.style.left = `${Math.round(rect.left) - submenuRect.width - 2}px`;
  }
}
function _folderMenuScheduleHideSubmenu(item) {
  const submenu = item.querySelector(':scope > .folder-menu-submenu');
  if (!submenu) return;
  clearTimeout(_folderMenuSubmenuCloseTimer);
  _folderMenuSubmenuCloseTimer = setTimeout(() => {
    // Só fecha se o mouse não estiver nem sobre a linha que abriu o flyout
    // nem sobre o flyout em si — dá tempo do usuário "atravessar" o espaço
    // entre os dois (mesmo em diagonal) sem o menu sumir no meio do caminho.
    if (!submenu.matches(':hover') && !item.querySelector(':scope > .folder-menu-row').matches(':hover')) {
      submenu.classList.remove('show');
    }
  }, 200);
}
document.addEventListener('mouseover', ev => {
  const item = ev.target.closest && ev.target.closest('.folder-menu-item.has-children');
  if (item) _folderMenuShowSubmenu(item);
});
document.addEventListener('mouseout', ev => {
  const item = ev.target.closest && ev.target.closest('.folder-menu-item.has-children');
  if (item) _folderMenuScheduleHideSubmenu(item);
});

// ════════════════════════════════════════════════
// Import/Export de uma pasta inteira (Settings → System → Folders) — pedido
// do usuário: "criar opção para importar e exportar a pasta folders. incluir
// todas subfolders, comandos e anotações." Formato: um .json auto-contido
// (ver GET /api/folders/:id/export + POST /api/folders/import em
// server/index.js) — cada comando vai por INTEIRO no arquivo, não só uma
// referência por id (o id só faz sentido no banco de origem). Pensado
// sobretudo para levar uma pasta de uma instalação do Toolbox45 para outra;
// dentro da MESMA instalação, "Copy folder" (copyFolderFromUser acima) já
// resolve, só que sem subpastas.
// ════════════════════════════════════════════════

// Lista de <option> com toda a árvore de pastas do usuário atual, indentada
// por profundidade — reaproveitada tanto pelo seletor "qual pasta exportar"
// quanto por "importar pasta para dentro de" (mesma árvore, dois contextos).
function _folderTreeOptionsHtml() {
  const tree = buildFolderTree(FOLDERS);
  let html = '';
  const walk = (list, depth) => {
    list.forEach(f => {
      const indent = '    '.repeat(depth) + (depth ? '↳ ' : '');
      const label = typeof escapeCmdSearchHistoryHtml === 'function' ? escapeCmdSearchHistoryHtml(f.name) : f.name;
      html += `<option value="${f.id}">${indent}${label}</option>`;
      walk(tree.childrenOf(f.id), depth + 1);
    });
  };
  walk(tree.roots, 0);
  return html;
}

function openFolderExportModal() {
  if (!FOLDERS.length) { alert("You don't have any folders yet."); return; }
  const overlay = document.getElementById('folderExportOverlay');
  const select = document.getElementById('folderExportSelect');
  if (!overlay || !select) return;
  select.innerHTML = _folderTreeOptionsHtml();
  overlay.classList.add('show');
}
function closeFolderExportModal() {
  const overlay = document.getElementById('folderExportOverlay');
  if (overlay) overlay.classList.remove('show');
}

// Baixa o .json da pasta escolhida (+ toda a subárvore) — mesma técnica de
// "Blob + <a download> sintético" já usada por exportCommandsCsv()
// (js/csv-export.js), só que gerando JSON em vez de CSV.
async function confirmExportFolder() {
  const select = document.getElementById('folderExportSelect');
  const id = select && select.value;
  if (!id) return;
  const btn = document.getElementById('folderExportConfirmBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/folders/${id}/export`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.message || 'Failed to export the folder.');
      return;
    }
    const folderName = (data.root && data.root.name) || 'folder';
    const slug = folderName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'folder';
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `toolbox45-folder-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeFolderExportModal();
  } catch (e) {
    alert('Failed to export the folder. Please try again.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Soma comandos/notes/subpastas de toda a árvore lida do arquivo — só para
// mostrar um resumo ("X folders, Y commands, Z notes") antes de confirmar o
// import, mesmo espírito do relatório "N imported, M failed" do import de
// CSV (js/csv-import.js).
function _countFolderExportNode(node) {
  let folders = 1;
  let commands = (node.commands || []).length;
  let notes = (node.notes || []).length;
  (node.children || []).forEach(c => {
    if (!c || !c.folder) return;
    const sub = _countFolderExportNode(c.folder);
    folders += sub.folders; commands += sub.commands; notes += sub.notes;
  });
  return { folders, commands, notes };
}

// Guarda o arquivo já lido/validado (o objeto "root" pronto para mandar em
// POST /api/folders/import) enquanto o modal está aberto — só populado por
// onFolderImportFileChosen(), lido por confirmImportFolder().
let _folderImportParsed = null;

function openFolderImportModal() {
  const overlay = document.getElementById('folderImportOverlay');
  if (!overlay) return;
  _folderImportParsed = null;
  const fileInput = document.getElementById('folderImportFile');
  if (fileInput) fileInput.value = '';
  const parentSelect = document.getElementById('folderImportParentSelect');
  if (parentSelect) parentSelect.innerHTML = '<option value="">Top level</option>' + _folderTreeOptionsHtml();
  const preview = document.getElementById('folderImportPreview');
  if (preview) { preview.style.display = 'none'; preview.textContent = ''; }
  const confirmBtn = document.getElementById('folderImportConfirmBtn');
  if (confirmBtn) confirmBtn.disabled = true;
  overlay.classList.add('show');
}
function closeFolderImportModal() {
  const overlay = document.getElementById('folderImportOverlay');
  if (overlay) overlay.classList.remove('show');
}

// Lê e valida o arquivo escolhido assim que o <input type="file"> muda —
// FileReader (mesmo padrão de leitura de imagem colada/enviada no editor de
// comandos, ver command-editor.js) em vez de mandar o arquivo cru pro
// servidor: assim a gente já mostra um resumo (contagem de pastas/comandos/
// notes) e barra arquivos claramente inválidos ANTES do usuário clicar em
// "Import".
function onFolderImportFileChosen() {
  const fileInput = document.getElementById('folderImportFile');
  const preview = document.getElementById('folderImportPreview');
  const confirmBtn = document.getElementById('folderImportConfirmBtn');
  _folderImportParsed = null;
  if (confirmBtn) confirmBtn.disabled = true;
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!file) { if (preview) { preview.style.display = 'none'; preview.textContent = ''; } return; }
  const reader = new FileReader();
  reader.onload = () => {
    let parsed = null;
    try { parsed = JSON.parse(reader.result); } catch (e) { parsed = null; }
    if (!parsed || parsed.type !== 'toolbox45-folder-export' || !parsed.root || typeof parsed.root.name !== 'string') {
      if (preview) {
        preview.style.display = 'block';
        preview.textContent = "This doesn't look like a folder export file (or it's from an incompatible version).";
      }
      return;
    }
    _folderImportParsed = parsed;
    const counts = _countFolderExportNode(parsed.root);
    if (preview) {
      preview.style.display = 'block';
      preview.textContent = `"${parsed.root.name}" — ${counts.folders} folder(s), ${counts.commands} command(s), ${counts.notes} note(s).`;
    }
    if (confirmBtn) confirmBtn.disabled = false;
  };
  reader.onerror = () => {
    if (preview) { preview.style.display = 'block'; preview.textContent = 'Failed to read the file.'; }
  };
  reader.readAsText(file);
}

// Envia a árvore já lida/validada pro servidor, que recria tudo (pasta +
// subpastas + comandos + notes) como NOVO, sempre pertencendo ao usuário
// atual (mesmo espírito de copyFolderFromUser acima) — nunca sobrescreve
// nada que já existe. invalidateCommandsCache() (js/api-client.js) garante
// que os comandos recém-criados apareçam na tela principal também, não só
// dentro da pasta.
async function confirmImportFolder() {
  if (!_folderImportParsed) return;
  const parentSelect = document.getElementById('folderImportParentSelect');
  const parentId = parentSelect && parentSelect.value ? Number(parentSelect.value) : null;
  const btn = document.getElementById('folderImportConfirmBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/folders/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: _folderImportParsed.root, parent_id: parentId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(body.message || 'Failed to import the folder.');
      if (btn) btn.disabled = false;
      return;
    }
    closeFolderImportModal();
    if (typeof invalidateCommandsCache === 'function') invalidateCommandsCache();
    await reloadFoldersFromServer();
    let msg = `Imported ${body.folders} folder(s), ${body.commands} command(s) and ${body.notes} note(s).`;
    if (body.commandsFailed) msg += ` ${body.commandsFailed} command(s) failed to import — check that their Vendor/System/Version/Environment exist in this installation's catalog.`;
    alert(msg);
  } catch (e) {
    alert('Failed to import the folder. Please try again.');
    if (btn) btn.disabled = false;
  }
}

// Click-outside-to-close + Escape, mesmo padrão de backup.js/csv-export.js.
(() => {
  const exportOverlay = document.getElementById('folderExportOverlay');
  if (exportOverlay) exportOverlay.addEventListener('click', ev => { if (ev.target.id === 'folderExportOverlay') closeFolderExportModal(); });
  const importOverlay = document.getElementById('folderImportOverlay');
  if (importOverlay) importOverlay.addEventListener('click', ev => { if (ev.target.id === 'folderImportOverlay') closeFolderImportModal(); });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    const eo = document.getElementById('folderExportOverlay');
    if (eo && eo.classList.contains('show')) closeFolderExportModal();
    const io = document.getElementById('folderImportOverlay');
    if (io && io.classList.contains('show')) closeFolderImportModal();
  });
})();
