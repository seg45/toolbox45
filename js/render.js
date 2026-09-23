// ════════════════════════════════════════════════
// RENDER — now backed by /api/commands (api-client.js + db-render-engine.js)
// instead of the hardcoded buildStatic()/buildCmds() in commands.js.
// ════════════════════════════════════════════════

// Debounce de 120ms para o campo "Export to" (id="f-log", index.html) — mesmo
// motivo do debounce em onQueryInput() (js/query-bar.js): oninput="render()"
// direto disparava uma reconstrução completa do DOM a cada tecla digitada no
// caminho do arquivo, o que ficou lento com o catálogo grande de comandos.
let _exportPathDebounceTimer = null;
function onExportPathInput() {
  if (_exportPathDebounceTimer) clearTimeout(_exportPathDebounceTimer);
  _exportPathDebounceTimer = setTimeout(() => {
    _exportPathDebounceTimer = null;
    render();
  }, 120);
}

async function render() {
  const src  = gv('src_ip'), dst = gv('dst_ip');
  const sp   = gv('src_port') || '0', dp = gv('dst_port') || '0';
  const proto = gv('proto') || '0', iface = gv('iface'), vsid = gv('vsid') || '0';
  const logFile = gv('f-log') || '/tmp/fw_export.txt';
  const ip = gv('ip'), port = gv('port'); // genéricos, sem direção (ver query-bar.js) — "host X and port Y"
  const { v, e, t: topicSel } = ST;
  const hasIPs = !!(src && dst);
  // Chaves do objeto `values` = os próprios nomes de placeholder {{token}} usados
  // nos comandos (src_ip/dst_ip/src_port/dst_port — renomeados de src/dst/sp/dp
  // para ficarem autoexplicativos na tela de administração de Parâmetros).
  const values = { src_ip: src, dst_ip: dst, src_port: sp, dst_port: dp, proto, iface, vsid, ip, port, logFile, FL };
  // Parâmetros novos cadastrados no modo administrador (js/catalog-admin.js) —
  // os 9 originais acima ficam hardcoded de propósito (os ~10 comandos
  // "avançados" com placeholder_resolver e as flags requires_ips/
  // requires_ip_port em render.js/db-render-engine.js leem essas variáveis
  // diretamente, não o objeto values; ver server/index.js:
  // parameterStructuralDependencyCount). Um parâmetro novo só participa da
  // substituição genérica {{key}} feita por resolveTokens() nos comandos
  // "simples" (sem placeholder_resolver). Desde a simplificação do catálogo,
  // `key` é sempre o próprio id do <input type="hidden"> — sem input_id/
  // default_value separados.
  (CATALOGS.parameters || []).forEach(p => {
    if (!(p.key in values)) values[p.key] = gv(p.key) || '';
  });

  const out = document.getElementById('out');

  let commands;
  try {
    commands = await fetchCommands();
  } catch (err) {
    console.error('Failed to load commands from API', err);
    out.innerHTML = `<div class="empty"><div class="empty-ico">⚠️</div><p>Failed to load commands from the server. Check whether the backend (server/index.js) is running.</p></div>`;
    return;
  }

  // Preferência "System commands" (sidebar, seção Options — ver js/settings.js)
  // — quando desligada, some com os comandos de referência (created_by='System',
  // is_system=true) e mostra só os criados/duplicados por usuários. Exceção:
  // um comando System que o usuário guardou em alguma pasta continua aparecendo
  // mesmo assim — "desligar System commands" é para reduzir ruído, não para
  // esconder algo que a própria pessoa organizou como importante.
  if (typeof SHOW_SYSTEM_COMMANDS !== 'undefined' && !SHOW_SYSTEM_COMMANDS) {
    commands = commands.filter(c => !c.is_system || (c.folder_ids && c.folder_ids.length));
  }

  // Filtro real por Vendor/Sistema (topo da hierarquia multi-fabricante ESTRITA)
  // — ao contrário de Versão/Ambiente (que só parametrizam qual combo-block é
  // gerado, ver resolveMultiSelection abaixo), Vendor/Sistema já nascem com
  // comportamento de filtro de verdade (mesma semântica de Tópico): seleção
  // vazia (padrão — sem item mestre 'all' na lista, ver js/state.js) não
  // restringe nada; um comando sem vendor/sistema cadastrado
  // (command.vendors/systems vazio) "aplica a todos" (mesma convenção de
  // command_versions/command_environments); caso contrário precisa bater com
  // pelo menos um item marcado.
  if (ST.vd.length) {
    commands = commands.filter(c => !c.vendors || !c.vendors.length || c.vendors.some(v => ST.vd.includes(v)));
  }
  if (ST.sys.length) {
    commands = commands.filter(c => !c.systems || !c.systems.length || c.systems.some(s => ST.sys.includes(s)));
  }

  // "Folders" (clique em #foldersNavRow na sidebar, ver js/folders.js) é só
  // um FILTRO DE ESCOPO — restringe a tela aos comandos que estão em
  // QUALQUER pasta do usuário — e não mais uma organização própria que
  // ignorava o "Group by" selecionado. Antes, entrar em Folders sempre
  // forçava uma seção por pasta mesmo com Group by = Topic marcado, o que
  // deixava os dois controles conflitando (dropdown dizendo "Topic" mas a
  // tela mostrando pastas). Agora os dois eixos são independentes: Folders
  // decide QUAIS comandos aparecem, Group by decide COMO organizá-los —
  // "My folders" (ver mais abaixo) segue sendo a única opção que agrupa por
  // pasta, esteja o usuário em Folders ou não.
  // Só filtra `commands` pelas pastas do usuário ATUAL quando o escopo
  // dentro de Folders é "My folders" (padrão, FOLDER_SCOPE indefinido ou
  // 'mine') — nos escopos "All"/usuário escolhido (ver FOLDER_SCOPE em
  // js/folders.js) o ramo VIEW_FOLDERS_HOME mais abaixo precisa da lista
  // COMPLETA de comandos pra achar os cards das pastas de QUALQUER
  // usuário (mesma necessidade que o Group by "User folders" já tinha fora
  // de Folders, que nunca passou por este filtro porque VIEW_FOLDERS_HOME é
  // false lá).
  const folderScopeIsMine = typeof FOLDER_SCOPE === 'undefined' || !FOLDER_SCOPE || FOLDER_SCOPE === 'mine';
  if (VIEW_FOLDERS_HOME && folderScopeIsMine) {
    commands = commands.filter(c => c.folder_ids && c.folder_ids.length);
  }

  // Resolve a seleção de Versão/Ambiente numa lista de valores concretos a gerar. Nada
  // marcado (padrão — sem item mestre 'all' na lista, ver js/state.js) mantém o
  // comportamento único de sempre: gera com o padrão (R82 / Standalone), expandindo os
  // diffs de versão / avisando sobre a sintaxe por ambiente — sem explodir em vários
  // blocos. Um subconjunto específico marcado (mesmo que sejam todos os itens,
  // marcados um a um ou pelo botão "All" do rodapé) empilha um bloco completo de
  // comandos por item marcado (produto cartesiano Versão × Ambiente, com teto de segurança).
  function resolveMultiSelection(sel, allKeysOrdered, defaultVal) {
    if (sel.length === 0) return { values: [defaultVal], isAllMode: true };
    const values = allKeysOrdered.filter(k => sel.includes(k));
    return { values, isAllMode: false };
  }
  // Group by "Version" pede uma seção por versão com os tópicos dentro (ver
  // branch GROUP_BY === 'version' mais abaixo) — mas resolveMultiSelection()
  // sozinha, sem NENHUMA versão marcada no filtro da sidebar (o estado mais
  // comum), colapsa pro comportamento padrão de sempre: um único combo com
  // FALLBACK_VERSION ('R82'), então só aparecia UMA seção de versão com tudo
  // dentro — visualmente indistinguível de "sem agrupamento" (bug relatado
  // pelo usuário, com screenshot: "a ordem por versão não está sendo
  // exibida"). Enquanto agrupando por versão, tratamos "nada marcado" como
  // "todas marcadas" (mesmo efeito de marcar uma por uma ou clicar em 'All'
  // no rodapé do filtro), gerando um combo por versão de verdade.
  const versionSel = (GROUP_BY === 'version' && v.length === 0)
    ? { values: VERSION_KEYS, isAllMode: false }
    : resolveMultiSelection(v, VERSION_KEYS, FALLBACK_VERSION);
  const envSel = resolveMultiSelection(e, ENV_KEYS, FALLBACK_ENV);

  const MAX_COMBOS = 8;
  let combos = [];
  for (const cv of versionSel.values) {
    for (const ce of envSel.values) combos.push({ v: cv, e: ce });
  }
  let combosTruncatedNote = '';
  if (combos.length > MAX_COMBOS) {
    combos = combos.slice(0, MAX_COMBOS);
    combosTruncatedNote = `<div class="env-note" style="border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.06);color:var(--yellow);">⚠️ <span>Too many Version × Environment combinations checked — showing the first ${MAX_COMBOS}. Narrow the selection to see the rest.</span></div>`;
  }

  // Rótulo de Ambiente vem do catálogo administrável (js/catalogs.js), não
  // mais de mapas fixos aqui — assim um ambiente novo cadastrado aparece
  // corretamente em qualquer lugar sem editar este arquivo.
  function envLabel(key) {
    const env = (CATALOGS.environments || []).find(x => x.key === key);
    return env ? env.label : key;
  }
  const show = tp => topicSel.length === 0 || topicSel.includes(tp);

  const envNotesText = {
    all: 'All (all environments): commands are generated using the <strong>Standalone</strong> default. Switch the Environment to Cluster HA / VSX / Maestro / MDS when you need the specific syntax (<code>vsenv</code>, <code>asg_cmd</code>, <code>mdsenv</code>, etc.).',
    cluster: 'Cluster: run on <strong>both members</strong>. Check the active member with <code>cphaprob stat</code>.',
    vsx: `VSX: enter the VS with <code>vsenv ${vsid}</code> before running any command. <code>vsx stat -v</code> lists all IDs.`,
    maestro: 'Maestro: use <code>asg_cmd "..."</code> to broadcast to all SGMs. The <code>g_*</code> prefix aggregates output from all of them.',
    mds: 'MDS: use <code>mdsenv &lt;CMA-NAME&gt;</code> to enter the domain. <code>mdsstat</code> lists all CMAs.',
    gaia: 'Gaia Clish: commands run directly in the Gaia restricted shell (prompt <code>[Gaia]&gt;</code>), without entering Expert mode. Categories with no Clish equivalent (capture, kernel debug, SecureXL, tables, licensing, policy fetch) show a note indicating you need to type <code>expert</code> to access bash.',
    standalone: '',
  };

  // Um bloco completo de comandos por combinação Versão × Ambiente selecionada (normalmente 1).
  const comboBlocks = combos.map(combo => {
  const cv = combo.v, ce = combo.e;
  // Prefixo de chave dá identidade estável à seção de cada Tópico mesmo quando o mesmo
  // Tópico se repete em blocos de Versão/Ambiente empilhados (evita que o recolher/expandir
  // de um bloco afete o mesmo Tópico em outro bloco).
  const kp = `${cv}__${ce}__`;

  const envNote = envNotesText[ce] ? `<div class="env-note">ℹ️ <span>${envNotesText[ce]}</span></div>` : '';

  // Uma seção por Tópico do catálogo (js/catalogs.js) — antes eram 18 chamadas
  // fixas aqui; agora um tópico novo cadastrado no modo administrador já aparece
  // automaticamente, sem editar este arquivo. O tópico protegido 'environment'
  // fica de fora (tratado à parte, ver buildEnvSections abaixo). Ordenado
  // alfabeticamente pelo título da seção (não mais por sort_order do catálogo)
  // — mesmo critério (stripLeadingSymbols + localeCompare) já usado nos
  // dropdowns de filtro em js/state.js. Tópicos não têm mais ícone próprio
  // (removido do cadastro a pedido do usuário) — 2º arg '' em vez de tp.icon.
  const topicsSorted = (CATALOGS.topics || []).filter(tp => !tp.is_protected).slice().sort((a, b) =>
    stripLeadingSymbols(a.label).localeCompare(
      stripLeadingSymbols(b.label), undefined, { sensitivity: 'base' }
    )
  );
  // Monta as seções (Environment + uma por Tópico) para um subconjunto de
  // `commands` — extraído para função porque os modos "Created by" e "My
  // folders" repetem isso uma vez por grupo (ver mais abaixo), com
  // `keyPrefix` distinto para manter o recolher/expandir de cada seção
  // independente entre grupos. Usada sempre que o Group by NÃO for "My
  // folders" — inclusive dentro de Folders (VIEW_FOLDERS_HOME só filtra
  // QUAIS comandos chegam aqui, ver acima; não muda como são organizados).
  function buildSections(rows, keyPrefix) {
    const sections = [];
    const envCards = buildEnvCards(rows, ce, values);
    if (envCards.length) sections.push(section('🏗️', `Environment: ${envLabel(ce)}`, envCards, keyPrefix + 'environment'));
    // Agrupa `rows` por tópico UMA VEZ (Map<topic, rows[]>) em vez de deixar
    // buildTopicSection (js/db-render-engine.js) escanear o array `rows`
    // INTEIRO de novo a cada tópico do catálogo — combos (Versão×Ambiente) ×
    // tópicos passadas completas sobre 1452 comandos ficou perceptível
    // depois do import grande. buildTopicSection ainda re-filtra o
    // subconjunto recebido (agora já pequeno) por segurança — comportamento
    // idêntico, só que sem repetir o scan caro sobre o array completo.
    const rowsByTopic = new Map();
    rows.forEach(r => {
      (r.topics || [r.topic]).forEach(tp => {
        let arr = rowsByTopic.get(tp);
        if (!arr) { arr = []; rowsByTopic.set(tp, arr); }
        arr.push(r);
      });
    });
    topicsSorted.forEach(tp => {
      if (show(tp.key)) {
        sections.push(buildTopicSection(rowsByTopic.get(tp.key) || [], tp.key, '', tp.label, values, hasIPs, keyPrefix + tp.key));
      }
    });
    return sections.join('');
  }

  // Rótulo do bloco Versão/Ambiente: quando Versão/Ambiente = All, a combinação
  // usada para gerar os comandos é só um valor padrão de referência (a maioria
  // dos comandos não muda entre versões/ambientes — ver command_versions vazio
  // no schema) — então o rótulo deve dizer "All", não o valor concreto
  // escolhido internamente (ex.: "R82"), para não sugerir um filtro que não existe.
  const cvLabel = versionSel.isAllMode ? 'All' : cv;
  const ceLabel = envSel.isAllMode ? 'All' : envLabel(ce);

  // Dentro de "Folders" (VIEW_FOLDERS_HOME), o Group by de sempre (Tópico/
  // Versão/Created by) dá lugar a um seletor próprio de ESCOPO de pastas —
  // "My folders" (padrão) / um usuário escolhido / "All" (ver
  // #folderScopeDD em index.html e FOLDER_SCOPE em js/folders.js). Esse
  // seletor decide DE QUEM são as pastas mostradas; Group by continua
  // controlando a organização fora de Folders (inclusive "Folders"/"User
  // folders" lá, que seguem funcionando como sempre — ver ramos abaixo).
  // Sempre retorna aqui (nunca cai nos ramos de GROUP_BY abaixo) enquanto
  // VIEW_FOLDERS_HOME estiver ativo.
  if (VIEW_FOLDERS_HOME) {
    const scope = (typeof FOLDER_SCOPE !== 'undefined' && FOLDER_SCOPE) || 'mine';
    let folderGroups = '';
    if (scope === 'mine') {
      // Mesma otimização de buildSections() acima: agrupa `commands` por
      // pasta UMA VEZ (Map<folderId, rows[]>) em vez de deixar
      // buildFolderSection escanear o array inteiro de novo a cada pasta do
      // usuário — um comando pode estar em mais de uma pasta (folder_ids),
      // então entra na lista de cada uma.
      const commandsByFolder = new Map();
      commands.forEach(c => {
        (c.folder_ids || []).forEach(fid => {
          let arr = commandsByFolder.get(fid);
          if (!arr) { arr = []; commandsByFolder.set(fid, arr); }
          arr.push(c);
        });
      });
      // Subpastas (aninhamento ilimitado, ver buildFolderTree em
      // js/folders.js): monta a árvore a partir de FOLDERS (cada pasta com
      // seu parent_id) e desenha só as RAÍZES aqui — cada nó desenha suas
      // próprias subpastas recursivamente (renderFolderNode abaixo) e
      // devolve pra quem a chamou um Map<childId, htmlDaSeção> em vez de uma
      // string já concatenada — é isso que permite ao pai intercalar cada
      // subpasta na posição CERTA dentro da ordem combinada de comandos/
      // notas/subpastas (ver buildFolderItemsCards em db-render-engine.js),
      // em vez de sempre jogá-las no fim. `rootFolderId` (mesmo valor em
      // toda a recursão, = o id da própria RAIZ) viaja junto só pra marcar
      // até onde o drag-and-drop pode mover um item (não pode sair da
      // árvore, pedido do usuário).
      // `rootEditMode` (pedido do usuário: "a edição de subpastas e ordem
      // dos comandos e notas deve ficar somente na pasta pai") é calculado
      // UMA VEZ por raiz, a partir de FOLDER_EDIT_MODE.has(RAIZ.id), e viaja
      // sem mudar pra toda a recursão — nenhuma subpasta consulta
      // FOLDER_EDIT_MODE com o próprio id. Isso, combinado com o `editBtn`
      // só aparecer em depth 0 (ver buildFolderSectionFromCards em
      // db-render-engine.js), garante que só a pasta pai liga/desliga o modo
      // de edição da árvore inteira — mas uma vez ligado, toda subpasta
      // abaixo também fica com nome editável, Excluir e itens arrastáveis
      // (drag continua podendo mover itens/subpastas entre si livremente,
      // só nunca pra fora da árvore — ver rootFolderId acima, regra que não
      // muda aqui).
      const tree = buildFolderTree(typeof FOLDERS !== 'undefined' ? FOLDERS : []);
      const renderFolderNode = (folder, depth, rootFolderId, rootEditMode) => {
        const childSectionById = new Map(
          tree.childrenOf(folder.id).map(child => [child.id, renderFolderNode(child, depth + 1, rootFolderId, rootEditMode)])
        );
        return buildFolderSection(commandsByFolder.get(folder.id) || [], folder.id, folder.name, values, hasIPs, `${kp}folder${folder.id}`, folder.notes, folder.order, rootEditMode, childSectionById, depth, rootFolderId);
      };
      folderGroups = tree.roots.map(folder => {
        const rootEditMode = typeof FOLDER_EDIT_MODE !== 'undefined' && FOLDER_EDIT_MODE.has(folder.id);
        return renderFolderNode(folder, 0, folder.id, rootEditMode);
      }).join('');
    } else {
      const allFolders = typeof ALL_USERS_FOLDERS !== 'undefined' ? ALL_USERS_FOLDERS : [];
      const targetUsername = scope.startsWith('user:') ? scope.slice('user:'.length) : null;
      const relevant = targetUsername ? allFolders.filter(f => f.username === targetUsername) : allFolders;
      if (scope === 'all') {
        // Agrupamento por usuário (dono da pasta) — esta é a única forma de
        // ver pastas de todos os usuários agrupadas por dono; o antigo Group
        // by "User folders" (fora de Folders) foi removido, então este bloco
        // não reaproveita nada de fora — monta o agrupamento por conta própria.
        const byUser = new Map();
        relevant.forEach(f => { if (!byUser.has(f.username)) byUser.set(f.username, []); byUser.get(f.username).push(f); });
        const usernames = [...byUser.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        folderGroups = usernames.map(username => {
          const isOwn = typeof CURRENT_USER !== 'undefined' && CURRENT_USER === username;
          // Renomear/excluir uma pasta é SEMPRE restrito ao dono, mesmo para
          // admin (pedido do usuário: "cada usuário só pode alterar ou
          // excluir a sua própria pasta" — diferente da regra de comandos,
          // que continua dando exceção a admins; ver PUT/DELETE
          // /api/folders/:id em server/index.js, que recusa com 404 quando
          // quem pediu não é o dono, sem exceção de role).
          const canManage = isOwn;
          const userKey = username.replace(/[^a-zA-Z0-9_-]/g, '_');
          // Subpastas (aninhamento ilimitado) dentro do bloco de UM usuário —
          // a árvore só faz sentido calculada por dono (parent_id nunca
          // aponta pra pasta de outro usuário, ver POST /api/folders em
          // server/index.js), então buildFolderTree roda sobre userFolders,
          // não sobre `relevant`/`allFolders` inteiro.
          const tree = buildFolderTree(byUser.get(username));
          // `rootEditMode` (mesma regra do ramo 'mine' acima — "a edição de
          // subpastas e ordem dos comandos e notas deve ficar somente na
          // pasta pai"): calculado uma vez por pasta de TOPO deste usuário,
          // nunca por subpasta.
          const renderFolderNode = (f, depth, rootFolderId, rootEditMode) => {
            const cmdById = new Map(commands.filter(c => f.command_ids.has(c.id)).map(c => [c.id, c]));
            const notesById = new Map((f.notes || []).map(n => [n.id, n]));
            const childSectionById = new Map(
              tree.childrenOf(f.id).map(child => [child.id, renderFolderNode(child, depth + 1, rootFolderId, rootEditMode)])
            );
            const items = buildFolderItemsCards(cmdById, notesById, childSectionById, f.order, values, hasIPs, isOwn);
            return buildFolderSectionFromCards(items, f.id, f.name, `${kp}scope_${userKey}__folder${f.id}`, canManage, !isOwn, rootEditMode, depth, rootFolderId);
          };
          const folderSections = tree.roots.map(f => {
            const rootEditMode = canManage && typeof FOLDER_EDIT_MODE !== 'undefined' && FOLDER_EDIT_MODE.has(f.id);
            return renderFolderNode(f, 0, f.id, rootEditMode);
          }).join('');
          const cardCount = (folderSections.match(/<div class="card"/g) || []).length;
          // Mesma correção do bug "pasta vazia não aparece" (buildFolderSectionFromCards):
          // uma pasta PRÓPRIA vazia ainda tem o botão "+ Add" (só pastas
          // próprias o têm) mesmo com cardCount=0 — sem essa checagem extra,
          // o bloco do usuário inteiro (👤 <nome>) desapareceria se a única
          // pasta dele visível aqui estivesse vazia.
          const hasOwnEmptyFolder = folderSections.includes('sec-folder-add-btn');
          if (!cardCount && !hasOwnEmptyFolder) return '';
          return collapsibleGroup(`${cv}__${ce}__scopeuser${userKey}`, `👤 <strong>${escAttr(username)}</strong> <span class="sec-count">${cardCount}</span>`, folderSections, 'section-creator');
        }).join('');
      } else {
        // scope = 'user:<username>' — as pastas DESSA pessoa direto, sem o
        // agrupamento "👤 username" (só faz sentido pra "All", que mistura
        // várias pessoas na mesma tela).
        const isOwn = typeof CURRENT_USER !== 'undefined' && CURRENT_USER === targetUsername;
        // Mesma regra do ramo "all" acima: sem bypass de admin.
        const canManage = isOwn;
        // Subpastas: mesma árvore por dono do ramo "all" acima — `relevant`
        // já é só as pastas dessa pessoa (filtro logo no início do bloco).
        const tree = buildFolderTree(relevant);
        // `rootEditMode` — mesma regra dos dois ramos acima ("a edição de
        // subpastas e ordem dos comandos e notas deve ficar somente na
        // pasta pai").
        const renderFolderNode = (f, depth, rootFolderId, rootEditMode) => {
          const cmdById = new Map(commands.filter(c => f.command_ids.has(c.id)).map(c => [c.id, c]));
          const notesById = new Map((f.notes || []).map(n => [n.id, n]));
          const childSectionById = new Map(
            tree.childrenOf(f.id).map(child => [child.id, renderFolderNode(child, depth + 1, rootFolderId, rootEditMode)])
          );
          const items = buildFolderItemsCards(cmdById, notesById, childSectionById, f.order, values, hasIPs, isOwn);
          return buildFolderSectionFromCards(items, f.id, f.name, `${kp}scopeuser__folder${f.id}`, canManage, !isOwn, rootEditMode, depth, rootFolderId);
        };
        folderGroups = tree.roots.map(f => {
          const rootEditMode = canManage && typeof FOLDER_EDIT_MODE !== 'undefined' && FOLDER_EDIT_MODE.has(f.id);
          return renderFolderNode(f, 0, f.id, rootEditMode);
        }).join('');
      }
    }
    if (!folderGroups) return '';
    const comboHeader = combos.length > 1
      ? `<div class="combo-header">🔀 <strong>${cvLabel}</strong> / <strong>${ceLabel}</strong></div>`
      : '';
    return comboHeader + envNote + folderGroups;
  }

  // "Created by": um agrupamento recolhível por autor (created_by), cada um
  // com as mesmas seções de Ambiente/Tópico de sempre, mas só com os comandos
  // daquele autor. Autores em ordem alfabética (comparação sem caixa); "—"
  // agrupa comandos sem created_by (registros antigos/sem autoria).
  if (GROUP_BY === 'creator') {
    // Mesma otimização de buildSections()/pastas acima: agrupa `commands`
    // por autor UMA VEZ em vez de filtrar o array inteiro de novo a cada
    // autor da lista.
    const commandsByCreator = new Map();
    commands.forEach(c => {
      const key = c.created_by || '—';
      let arr = commandsByCreator.get(key);
      if (!arr) { arr = []; commandsByCreator.set(key, arr); }
      arr.push(c);
    });
    const creators = [...commandsByCreator.keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
    const creatorGroups = creators.map(creator => {
      const subset = commandsByCreator.get(creator) || [];
      // Chave da seção precisa ser um identificador "seguro" (sem \, ', etc.) —
      // contas antigas do login do Windows/NTLM (removido, mas ainda podem
      // existir na tabela users) vêm no formato "DOMÍNIO\usuario", e um
      // backslash dentro do onclick="toggleSection('...')" gerado por
      // collapsibleGroup() quebraria a string JS (\u, \r etc. são sequências de
      // escape válidas). O nome de exibição continua o original (escAttr(creator)).
      const creatorKey = creator.replace(/[^a-zA-Z0-9_-]/g, '_');
      const body = buildSections(subset, `${kp}${creatorKey}__`);
      const cardCount = (body.match(/<div class="card"/g) || []).length;
      if (!cardCount) return '';
      return collapsibleGroup(`${cv}__${ce}__${creatorKey}`, `👤 <strong>${escAttr(creator)}</strong> <span class="sec-count">${cardCount}</span>`, body, 'section-creator');
    }).join('');
    if (!creatorGroups) return '';
    const comboHeader = combos.length > 1
      ? `<div class="combo-header">🔀 <strong>${cvLabel}</strong> / <strong>${ceLabel}</strong></div>`
      : '';
    return comboHeader + envNote + creatorGroups;
  }

  // "Folders"/"User folders" existiram aqui como opções de Group by — foram
  // REMOVIDAS (a pedido do usuário): a mesma visão (pastas do próprio
  // usuário / cross-user por dono) já é coberta por inteiro pela seção
  // "Folders" da sidebar (VIEW_FOLDERS_HOME, ver ramo acima) + o seletor de
  // escopo (My folders/usuário escolhido/All), então mantê-las como opções
  // duplicadas no Group by só confundia. `buildFolderSection`/
  // `buildFolderItemsCards`/`buildFolderSectionFromCards` continuam em uso
  // — agora só pelo ramo VIEW_FOLDERS_HOME acima.

  const bodyHtml = envNote + buildSections(commands, kp);

  // "Agrupar por Versão": embrulha o bloco inteiro da combinação num agrupamento recolhível
  // próprio (rotulado com Versão/Ambiente), com as seções de Tópico aninhadas dentro. Sempre
  // exibido nesse modo — mesmo com uma única combinação — para dar o mesmo resultado visual
  // de agrupamento que o usuário teria com várias Versões marcadas.
  if (GROUP_BY === 'version') {
    const cardCount = (bodyHtml.match(/<div class="card"/g) || []).length;
    if (!cardCount) return '';
    const label = `<strong>${cvLabel}</strong> / <strong>${ceLabel}</strong>`;
    return collapsibleGroup(`${cv}__${ce}`, `🔀 ${label} <span class="sec-count">${cardCount}</span>`, bodyHtml, 'section-version');
  }

  const comboHeader = combos.length > 1
    ? `<div class="combo-header">🔀 <strong>${cvLabel}</strong> / <strong>${ceLabel}</strong></div>`
    : '';
  return comboHeader + bodyHtml;
  }); // fim do map de combos

  out.innerHTML = [combosTruncatedNote, ...comboBlocks].join('');
  // Folders (VIEW_FOLDERS_HOME) já filtrou `commands` lá em cima para só os
  // que estão em alguma pasta — se isso zerar a lista (ou o usuário ainda
  // não tiver nenhuma pasta) para os filtros/Group by atuais, nenhuma seção
  // é gerada e a tela fica em branco sem esse aviso.
  if (VIEW_FOLDERS_HOME && !out.querySelector('.section')) {
    out.insertAdjacentHTML('beforeend', `<div class="empty"><div class="empty-ico">${folderIcon(false, 40)}</div><p>No commands in any folder yet for the current filters.</p></div>`);
  }
  // Notes (task Notes, 3º redesign): innerHTML acima recriou do zero
  // qualquer `.note-editor-body` que estivesse em edição — inclusive as
  // <img> já existentes nele — então as alças de redimensionar (ver
  // _neArmImageResize em js/folders.js) precisam ser rearmadas depois de
  // cada render(), senão ficam mortas até o usuário reabrir a nota.
  if (typeof _neRearmActiveEditors === 'function') _neRearmActiveEditors();
  // Links em Details/Notes: sempre nova guia + botão de copiar ao lado (ver
  // enhanceRenderedLinks em js/terminal-renderer.js) — roda depois do
  // innerHTML acima, senão os <a> ainda nem existem no DOM.
  if (typeof enhanceRenderedLinks === 'function') enhanceRenderedLinks(out);
  applySearchFilter();
}

render().catch(err => console.error('render() failed', err));
