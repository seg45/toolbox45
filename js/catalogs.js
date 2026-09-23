// ════════════════════════════════════════════════
// CATALOGS — Versão / Ambiente / Tópico / Parâmetro administráveis
// ════════════════════════════════════════════════
// Antes estas listas eram fixas no código (VERSION_KEYS/ENV_KEYS/TYPE_KEYS em
// js/state.js, QUERY_FIELD_DEFS em js/query-bar.js + blocos de HTML estático
// espalhados em index.html: sidebar, modal de Configurações, editor de
// comandos e chips da barra de busca). Agora vivem no servidor
// (server/schema.sql: tabelas versions/environments/topics/parameters) e
// podem ser cadastradas/editadas/excluídas pelo "Modo administrador"
// (js/catalog-admin.js).
//
// Este arquivo busca os 4 catálogos uma vez no boot (GET /api/catalogs),
// mantém VERSION_KEYS/ENV_KEYS/TYPE_KEYS (já declarados como const em
// state.js) atualizados MUTANDO o array em vez de reatribuir — outros
// módulos guardam a mesma referência — e substitui o innerHTML dos 9
// contêineres pelos itens vindos do servidor.
//
// IMPORTANTE sobre ordem de carregamento: todos os grupos (.sb-row dentro de
// #vList/#eList/#tList e .seg-btn dentro de #mVersion/#mEnv/#mType/
// #cmdVersionsSeg/#cmdEnvSeg/#cmdTopicSeg) usam DELEGAÇÃO DE EVENTO — o
// listener de clique fica no CONTÊINER (ver bindMultiSelect em
// state.js e _ceBindMultiSeg em command-editor.js), não em cada item. Por
// isso é seguro substituir o innerHTML destes contêineres A QUALQUER MOMENTO
// (mesmo depois que state.js/settings-modal.js/command-editor.js já
// registraram os binds no carregamento da página) sem perder a interatividade.
//
// Se o servidor estiver fora do ar, o fetch falha e o HTML estático de
// index.html (idêntico aos valores padrão de fábrica) continua funcionando
// normalmente — falha graciosa, igual ao resto do app.

let CATALOGS = {
  // Vendor → Sistema → Versão é hierarquia ESTRITA agora (FK direta: systems.vendor
  // / versions.system, ver server/schema.sql) — cada `systems`/`versions` já traz
  // o pai embutido no próprio registro, sem precisar de tabela de vínculo N:N.
  vendors: [], systems: [], versions: [], environments: [], topics: [], parameters: [], prompts: [], exports: [],
  // Vínculos N:N que continuam "soltos" (Versão ↔ Ambiente / Ambiente ↔ Tópico) —
  // ver comentário em server/schema.sql. Cada lista é plana ({parentCol, childCol}
  // pares); ccScopedKeys() abaixo monta o "quem pode aparecer dado o pai
  // selecionado" a partir delas.
  version_environments: [], environment_topics: [],
};

function ccEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Sidebar: .sb-row[data-v|data-e|data-t] dentro de #vList/#eList/#tList ──
// Sem item mestre 'all' — cada linha é um checkbox comum, todas começam
// desmarcadas (seleção vazia = sem filtro, mostra tudo; ver render.js/
// ccResolveParentSelection). O botão "All" do rodapé (toggleSidebarFilterAll,
// js/state.js) é o único jeito de marcar/desmarcar tudo de uma vez.
function ccBuildSidebarPanel(attr, items, labelFn, clearTargetId, ddId) {
  const rows = items.map(it => `<div class="sb-row" data-${attr}="${ccEsc(it.key)}"><div class="sb-chk">✓</div><span class="sb-pip" style="background:${ccEsc(it.color)}"></span>${ccEsc(labelFn(it))}</div>`).join('');
  const foot = `<div class="dd-panel-foot"><button type="button" class="btn btn-ghost" onclick="toggleSidebarFilterAll('${clearTargetId}')">All</button><button type="button" class="btn btn-ghost" onclick="toggleDropdown('${ddId}')">Close</button></div>`;
  return rows + foot;
}

// ── Modal de Configurações: .seg-btn[data-val] dentro de #mVendor/#mSys/
// #mVersion/#mEnv/#mType — mesmo princípio do sidebar panel acima: sem item
// mestre 'all', todos começam desmarcados.
function ccBuildModalSeg(items, labelFn, ddId) {
  const btns = items.map(it => `<button type="button" class="seg-btn" data-val="${ccEsc(it.key)}">${ccEsc(labelFn(it))}</button>`).join('');
  const foot = `<div class="dd-panel-foot"><button type="button" class="btn btn-ghost" onclick="toggleDropdown('${ddId}')">Close</button></div>`;
  return btns + foot;
}

// ── Editor de comandos: .seg-btn[data-val] dentro de #cmdVendorSeg/#cmdSysSeg/
// #cmdVersionsSeg/#cmdEnvSeg/#cmdTopicSeg (sem item mestre 'all' — nenhum
// marcado tem seu próprio significado ali). Sem rodapé "Close" — clicar fora
// do dropdown já fecha (ver closeAllDropdowns em js/state.js), o botão era
// redundante. `ddId` não é mais usado aqui (mantido no parâmetro só para não
// quebrar as chamadas existentes em renderCatalogUI).
function ccBuildEditorSeg(items, labelFn, ddId) {
  return items.map(it => `<button type="button" class="seg-btn" data-val="${ccEsc(it.key)}">${ccEsc(labelFn(it))}</button>`).join('');
}

// Substitui o innerHTML de um contêiner preservando quais itens estavam marcados
// (classe 'on'), identificados pelo atributo `itemAttr` (ex.: 'data-v', 'data-val').
// Importante para não perder a seleção do usuário se o idioma mudar com o modal
// de Configurações ou o editor de comandos aberto no meio de uma edição.
function ccSet(id, html, itemAttr) {
  const el = document.getElementById(id);
  if (!el) return;
  const selected = itemAttr ? new Set([...el.querySelectorAll(`[${itemAttr}].on`)].map(n => n.getAttribute(itemAttr))) : null;
  el.innerHTML = html;
  if (selected && selected.size) {
    el.querySelectorAll(`[${itemAttr}]`).forEach(n => {
      if (selected.has(n.getAttribute(itemAttr))) n.classList.add('on');
    });
  }
}

// ── Chips do campo de busca unificado ──
// data-field = nome do placeholder {{key}} (usado só pelo typeahead por texto
// em applyQueryChipsFilter, js/query-bar.js — o filtro por "parâmetros
// realmente usados pelos comandos visíveis" foi removido a pedido do
// usuário: "simplificar... pode remover o filtro dinâmico"); onclick insere
// a própria `key` como prefixo de busca (key e "palavra antes do :" são a
// mesma coisa desde a simplificação do catálogo de parâmetros — sem mais
// query_key/aliases).
//
// Lista completa (ordem alfabética) — usada dentro do painel "Others" (ver
// ccBuildQueryChipsFixedRow abaixo), mesmo estilo/comportamento de sempre
// (lista vertical de botões .cpq-chip).
function ccBuildQueryChips(parameters) {
  return parameters.map(p => {
    const label = p.label || p.key;
    return `<button type="button" class="cpq-chip" data-field="${ccEsc(p.key)}" onmousedown="event.preventDefault()" onclick="insertFieldToken('${ccEsc(p.key)}')" title="${ccEsc(label)}">${ccEsc(label)}</button>`;
  }).join('');
}

// Linha única e fixa (pedido do usuário: "ajustar o campo de parametro para
// fica em uma linha... deixar os parametros [8 chaves] fixo e na ultima
// posição ter um Others que ao clicar exiba todos os parametros
// cadastrados"). Só entra na linha o parâmetro que EXISTIR de fato no
// catálogo (evita um botão quebrado se algum administrador renomear/excluir
// uma dessas 8 keys) — a ordem abaixo é fixa, independente do sort_order do
// catálogo (que continua regendo só a lista completa dentro de "Others" e a
// tela de Register). "Others:" nunca chama insertFieldToken — abre/fecha o
// painel com TODOS os parâmetros (ver toggleQueryOthersPanel em
// js/query-bar.js), estilo texto simples (.cpq-chip-flat) para caber numa
// única linha, como no exemplo de referência do usuário.
const CPQ_FIXED_PARAM_ORDER = ['src_ip', 'dst_ip', 'src_port', 'dst_port', 'user', 'host', 'license', 'signature'];
function ccBuildQueryChipsFixedRow(parameters) {
  const byKey = new Map(parameters.map(p => [p.key, p]));
  const fixed = CPQ_FIXED_PARAM_ORDER.filter(k => byKey.has(k)).map(k => {
    const p = byKey.get(k);
    const label = p.label || p.key;
    return `<button type="button" class="cpq-chip-flat" data-field="${ccEsc(p.key)}" onmousedown="event.preventDefault()" onclick="insertFieldToken('${ccEsc(p.key)}')" title="${ccEsc(label)}">${ccEsc(label)}:</button>`;
  }).join('');
  const others = `<button type="button" class="cpq-chip-flat cpq-chip-others" onmousedown="event.preventDefault()" onclick="event.stopPropagation(); toggleQueryOthersPanel()" title="Show all registered parameters">Others:</button>`;
  return fixed + others;
}

// Garante um <input type="hidden"> para cada parâmetro do catálogo. Os 9
// parâmetros originais já têm input próprio no HTML estático, com id igual à
// própria `key` (ex.: id="src_ip"); parâmetros novos cadastrados no modo
// administrador precisam do elemento criado dinamicamente aqui.
function ccEnsureDynamicParamInputs(parameters) {
  let container = document.getElementById('dynamicParamInputs');
  if (!container) {
    container = document.createElement('div');
    container.id = 'dynamicParamInputs';
    container.style.display = 'none';
    document.body.appendChild(container);
  }
  parameters.forEach(p => {
    if (!document.getElementById(p.key)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.id = p.key;
      input.value = '';
      container.appendChild(input);
    }
  });
}

// ════════════════════════════════════════════════
// CASCATA Vendor → Sistema → Versão → Ambiente → Tópico
// ════════════════════════════════════════════════
// Vendor→Sistema e Sistema→Versão são hierarquia ESTRITA (FK direta —
// systems.vendor / versions.system, ver ccDirectFieldScoped abaixo): todo
// item sempre tem exatamente um pai, nada de "sem vínculo conhecido".
// Versão→Ambiente e Ambiente→Tópico continuam "soltos" (N:N vindos do
// servidor — version_environments/environment_topics, ver GET /api/catalogs).
// Um item SEM nenhum vínculo cadastrado nesses dois últimos é tratado como
// "sem restrição conhecida" (aparece sob qualquer pai) — evita esconder
// catálogo legado que ainda não foi vinculado por um administrador.
//
// `selectedParentKeys` é `null` quando o pai está em modo "All" (sem
// restrição alguma deve ser aplicada), ou um array das chaves concretas
// marcadas no pai.
function ccScopedAllowed(joinRows, childCol, parentCol, selectedParentKeys) {
  if (selectedParentKeys === null) return null;
  const childHasAnyLink = new Set(joinRows.map(r => r[childCol]));
  const allowedByLink = new Set(joinRows.filter(r => selectedParentKeys.includes(r[parentCol])).map(r => r[childCol]));
  return { childHasAnyLink, allowedByLink };
}
function ccIsChildAllowed(scoped, childKey) {
  if (scoped === null) return true;
  if (!scoped.childHasAnyLink.has(childKey)) return true;
  return scoped.allowedByLink.has(childKey);
}
// Mesma forma de retorno de ccScopedAllowed, mas para a hierarquia ESTRITA
// Vendor → Sistema → Versão (FK direta, sem tabela de vínculo N:N): cada item
// de `items` já carrega o pai no próprio campo `parentField` (ex.: system.vendor,
// version.system) e SEMPRE tem exatamente um pai (FK obrigatória) — por isso
// `childHasAnyLink` inclui todos os itens (nunca cai no caso "sem vínculo
// conhecido = permitido sempre" que existe para os N:N legados).
function ccDirectFieldScoped(items, parentField, selectedParentKeys) {
  if (selectedParentKeys === null) return null;
  const childHasAnyLink = new Set(items.map(it => it.key));
  const allowedByLink = new Set(items.filter(it => selectedParentKeys.includes(it[parentField])).map(it => it.key));
  return { childHasAnyLink, allowedByLink };
}
// `stArr` no formato do ST.* (lista de chaves específicas, ou vazio = sem
// filtro) → o que ccScopedAllowed espera (null = sem restrição, ou a lista concreta).
function ccResolveParentSelection(stArr) {
  return (!stArr || !stArr.length) ? null : stArr;
}

// Aplica/remove a classe visual 'scope-disabled' nos itens de um contêiner de
// filtro (sidebar .sb-row / modal e editor .seg-btn) conforme `scoped`, e
// desmarca (sem re-render — quem chama decide quando) qualquer item que
// estava marcado mas deixou de ser permitido. Retorna true se alguma marcação
// mudou (chamador deve recalcular o ST correspondente e atualizar o rótulo do
// dropdown).
// `scoped` aceita um único resultado de ccScopedAllowed/ccDirectFieldScoped OU
// um array deles — usado por Ambiente, que agora precisa satisfazer DOIS
// filtros ao mesmo tempo (Sistema, FK direta via ccDirectFieldScoped, E o N:N
// legado Versão↔Ambiente via ccScopedAllowed): um item só fica permitido se
// TODOS os `scoped` da lista o permitirem (AND).
function ccIsChildAllowedAll(scopedOrList, childKey) {
  const list = Array.isArray(scopedOrList) ? scopedOrList : [scopedOrList];
  return list.every(s => ccIsChildAllowed(s, childKey));
}
function ccApplyScopeDisabled(containerId, itemSelector, keyAttr, scoped) {
  const container = document.getElementById(containerId);
  if (!container) return false;
  let changed = false;
  container.querySelectorAll(`${itemSelector}[${keyAttr}]`).forEach(el => {
    const key = el.getAttribute(keyAttr);
    const allowed = ccIsChildAllowedAll(scoped, key);
    el.classList.toggle('scope-disabled', !allowed);
    if (!allowed && el.classList.contains('on')) {
      el.classList.remove('on');
      changed = true;
    }
  });
  return changed;
}

// Recalcula a cascata inteira a partir do estado atual (ST.vd/sys/v/e/t) —
// chamado depois de QUALQUER mudança em Vendor/Sistema/Versão/Ambiente (sidebar
// OU modal de Configurações) e também depois de recarregar os catálogos. Cobre
// os 2 lugares onde cada dropdown de FILTRO existe (sidebar, modal de
// Configurações) — o editor de comandos NÃO entra aqui: ele tem sua própria
// cascata independente (_ceApplyEditorCascade em js/command-editor.js),
// calculada a partir do que está marcado DENTRO do próprio editor, não do
// filtro da sidebar. Antes de existir CSS para 'scope-disabled' (ver
// css/layout.css) isso não fazia diferença — a classe não tinha efeito visual
// — mas agora que ela esconde o item de verdade, deixar cmdSysSeg/etc. aqui
// faria o editor herdar (incorretamente) o filtro da sidebar.
// Vendor→Sistema e Sistema→Versão usam ccDirectFieldScoped (FK direta, ver
// comentário acima); Versão→Ambiente e Ambiente→Tópico continuam "soltos"
// (N:N via ccScopedAllowed), sem hard-filter — só a mesma mecânica visual.
function ccRefreshCascade() {
  if (typeof ST === 'undefined') return;
  const vendorSel = ccResolveParentSelection(ST.vd);
  const sysScoped = ccDirectFieldScoped(CATALOGS.systems || [], 'vendor', vendorSel);
  let sysChanged = false;
  ['sysList', 'mSys'].forEach(id => { if (ccApplyScopeDisabled(id, id === 'sysList' ? '.sb-row' : '.seg-btn', id === 'sysList' ? 'data-sys' : 'data-val', sysScoped)) sysChanged = true; });
  if (sysChanged && typeof ST !== 'undefined' && typeof readMultiSelectValue === 'function' && document.getElementById('sysList')) {
    ST.sys = readMultiSelectValue('sysList', '.sb-row', 'data-sys', SYSTEM_KEYS);
    if (typeof updateSystemDDLabel === 'function') updateSystemDDLabel();
  }

  // O FK direto de Versão é Sistema, não Vendor — mas se o usuário só
  // restringiu Vendor e ainda não escolheu um Sistema específico (System
  // continua "All", ST.sys vazio), o filtro de Versão não pode ficar
  // "solto": herda, por baixo dos panos, o conjunto de sistemas já
  // restringido pelo Vendor (mesmos vendorSel/sysScoped calculados acima)
  // — senão versões ligadas a sistemas de OUTRO vendor continuam
  // aparecendo. Pedido do usuário: "selecionei Check Point em Vendor e em
  // versões está aparecendo versões da Fortinet". Quando o usuário já
  // escolheu um Sistema específico, esse continua sendo o filtro (ST.sys
  // tem prioridade sobre o vendorSel implícito).
  const sysSel = (ST.sys && ST.sys.length)
    ? ST.sys
    : (vendorSel ? (CATALOGS.systems || []).filter(s => vendorSel.includes(s.vendor)).map(s => s.key) : null);
  const versionScoped = ccDirectFieldScoped(CATALOGS.versions || [], 'system', sysSel);
  let versionChanged = false;
  ['vList', 'mVersion'].forEach(id => { if (ccApplyScopeDisabled(id, id === 'vList' ? '.sb-row' : '.seg-btn', id === 'vList' ? 'data-v' : 'data-val', versionScoped)) versionChanged = true; });
  if (versionChanged && document.getElementById('vList')) {
    ST.v = readMultiSelectValue('vList', '.sb-row', 'data-v', VERSION_KEYS);
    if (typeof updateVersionDDLabel === 'function') updateVersionDDLabel();
  }

  // Ambiente agora tem Sistema relacionado (FK direta — environments.system,
  // ver server/schema.sql), então entra no mesmo esquema "herda o Vendor
  // quando o Sistema ainda está em 'All'" usado acima para Versão — reaproveita
  // o MESMO `sysSel` já calculado (pedido do usuário: "na barra lateral quando
  // eu selecionar um vendor, deverá exibir nos demais filtros o system, version
  // e environment daquele vendor, como é feito atualmente, mas agora incluindo
  // o environment"). Combinado (AND) com o filtro N:N legado Versão↔Ambiente
  // (version_environments) que já existia, via ccApplyScopeDisabled aceitando
  // uma lista de `scoped`.
  const envSystemScoped = ccDirectFieldScoped(CATALOGS.environments || [], 'system', sysSel);
  const versionSel = ccResolveParentSelection(ST.v);
  const envVersionScoped = ccScopedAllowed(CATALOGS.version_environments || [], 'environment', 'version', versionSel);
  let envChanged = false;
  ['eList', 'mEnv'].forEach(id => { if (ccApplyScopeDisabled(id, id === 'eList' ? '.sb-row' : '.seg-btn', id === 'eList' ? 'data-e' : 'data-val', [envSystemScoped, envVersionScoped])) envChanged = true; });
  if (envChanged && document.getElementById('eList')) {
    ST.e = readMultiSelectValue('eList', '.sb-row', 'data-e', ENV_KEYS);
    if (typeof updateEnvDDLabel === 'function') updateEnvDDLabel();
  }

  const envSel = ccResolveParentSelection(ST.e);
  const topicScoped = ccScopedAllowed(CATALOGS.environment_topics || [], 'topic', 'environment', envSel);
  let topicChanged = false;
  ['tList', 'mType'].forEach(id => { if (ccApplyScopeDisabled(id, id === 'tList' ? '.sb-row' : '.seg-btn', id === 'tList' ? 'data-t' : 'data-val', topicScoped)) topicChanged = true; });
  if (topicChanged && document.getElementById('tList')) {
    ST.t = readMultiSelectValue('tList', '.sb-row', 'data-t', TYPE_KEYS);
    if (typeof updateTypeDDLabel === 'function') updateTypeDDLabel();
  }
}

// Reconstrói os blocos a partir de CATALOGS. Chamado uma vez depois do fetch
// inicial e de novo sempre que o catálogo é alterado no modo administrador
// (ver catAdminRefreshCatalogs em js/catalog-admin.js).
function renderCatalogUI() {
  const vendors = CATALOGS.vendors || [];
  const systems = CATALOGS.systems || [];
  const versions = CATALOGS.versions || [];
  const environments = CATALOGS.environments || [];
  const topicsAll = CATALOGS.topics || [];
  const topicsForFilter = topicsAll.filter(tp => !tp.is_protected);
  // Sem mais coluna de Ordem manual no admin de Parameters (removida — ver
  // js/catalog-admin.js) — a lista de chips "Command parameter" (#cpqChips)
  // é sempre alfabética por label/key, independente da ordem devolvida por
  // GET /api/catalogs (que ainda é sort_order/key no banco, mas não é mais
  // editável pela UI).
  const parameters = (CATALOGS.parameters || []).slice()
    .sort((a, b) => (a.label || a.key).localeCompare(b.label || b.key, undefined, { sensitivity: 'base' }));

  ccSet('vendorList', ccBuildSidebarPanel('vd', vendors, x => x.label, 'vendorList', 'vendorDD'), 'data-vd');
  ccSet('sysList', ccBuildSidebarPanel('sys', systems, x => x.label, 'sysList', 'sysDD'), 'data-sys');
  ccSet('vList', ccBuildSidebarPanel('v', versions, v => v.label, 'vList', 'vDD'), 'data-v');
  ccSet('eList', ccBuildSidebarPanel('e', environments, e => e.label, 'eList', 'eDD'), 'data-e');
  ccSet('tList', ccBuildSidebarPanel('t', topicsForFilter, tp => tp.label, 'tList', 'tDD'), 'data-t');

  ccSet('mVendor', ccBuildModalSeg(vendors, x => x.label, 'mVendorDD'), 'data-val');
  ccSet('mSys', ccBuildModalSeg(systems, x => x.label, 'mSysDD'), 'data-val');
  ccSet('mVersion', ccBuildModalSeg(versions, v => v.label, 'mVersionDD'), 'data-val');
  ccSet('mEnv', ccBuildModalSeg(environments, e => e.label, 'mEnvDD'), 'data-val');
  ccSet('mType', ccBuildModalSeg(topicsForFilter, tp => tp.label, 'mTypeDD'), 'data-val');

  ccSet('cmdVendorSeg', ccBuildEditorSeg(vendors, x => x.label, 'cmdVendorDD'), 'data-val');
  ccSet('cmdSysSeg', ccBuildEditorSeg(systems, x => x.label, 'cmdSysDD'), 'data-val');
  ccSet('cmdVersionsSeg', ccBuildEditorSeg(versions, v => v.label, 'cmdVersionsDD'), 'data-val');
  ccSet('cmdEnvSeg', ccBuildEditorSeg(environments, e => e.label, 'cmdEnvDD'), 'data-val');
  // No editor de comandos o tópico protegido 'environment' também aparece (é o único
  // lugar onde ele pode ser escolhido) — por isso usa topicsAll, não topicsForFilter.
  ccSet('cmdTopicSeg', ccBuildEditorSeg(topicsAll, tp => tp.label, 'cmdTopicDD'), 'data-val');
  // Versão/Ambiente/Tópico do editor agora são dropdowns — a seleção (.on) é preservada
  // pelo ccSet acima, mas o TEXTO do botão do dropdown precisa ser recalculado à parte.
  if (typeof _ceRefreshMultiSegDDLabels === 'function') _ceRefreshMultiSegDDLabels();
  // Re-applies the editor's own Vendor→System→Version hiding (see
  // _ceApplyEditorCascade in js/command-editor.js) now that the option lists
  // above were just rebuilt from scratch — otherwise a catalog reload while
  // the "New command" modal happens to be open would show every System/
  // Version again regardless of what's checked in the modal.
  if (typeof _ceApplyEditorCascade === 'function') _ceApplyEditorCascade();

  ccEnsureDynamicParamInputs(parameters);
  // Linha fixa (8 parâmetros + "Others:") sempre visível; a lista completa
  // (alfabética, como antes) fica dentro do painel "Others" — ver
  // ccBuildQueryChipsFixedRow acima e toggleQueryOthersPanel em js/query-bar.js.
  const chipsEl = document.getElementById('cpqChips');
  if (chipsEl) chipsEl.innerHTML = ccBuildQueryChipsFixedRow(parameters);
  const chipsOthersEl = document.getElementById('cpqChipsOthers');
  if (chipsOthersEl) chipsOthersEl.innerHTML = ccBuildQueryChips(parameters);
  if (typeof rebuildQueryFieldDefs === 'function') rebuildQueryFieldDefs();

  // Cascata Vendor → Sistema → Versão → Ambiente → Tópico — precisa rodar depois
  // que todo o HTML acima existe (os contêineres que ela consulta) e depois que
  // ccApplyToLegacyArrays() já rodou (VENDOR_KEYS/SYSTEM_KEYS/... precisam estar
  // atualizados). Ver loadCatalogs() logo abaixo.
  if (typeof ccRefreshCascade === 'function') ccRefreshCascade();
}

// Atualiza VERSION_KEYS/ENV_KEYS/TYPE_KEYS (const arrays declarados em
// state.js) MUTANDO o conteúdo — vários módulos (render.js, settings-modal.js,
// query-bar.js) guardam a MESMA referência de array, então reatribuir com
// '=' não propagaria; '.length = 0' + push mantém a referência.
function ccApplyToLegacyArrays() {
  if (typeof VENDOR_KEYS !== 'undefined') {
    VENDOR_KEYS.length = 0;
    (CATALOGS.vendors || []).forEach(x => VENDOR_KEYS.push(x.key));
  }
  if (typeof SYSTEM_KEYS !== 'undefined') {
    SYSTEM_KEYS.length = 0;
    (CATALOGS.systems || []).forEach(x => SYSTEM_KEYS.push(x.key));
  }
  if (typeof VERSION_KEYS !== 'undefined') {
    VERSION_KEYS.length = 0;
    (CATALOGS.versions || []).forEach(v => VERSION_KEYS.push(v.key));
  }
  if (typeof ENV_KEYS !== 'undefined') {
    ENV_KEYS.length = 0;
    (CATALOGS.environments || []).forEach(e => ENV_KEYS.push(e.key));
  }
  if (typeof TYPE_KEYS !== 'undefined') {
    TYPE_KEYS.length = 0;
    (CATALOGS.topics || []).filter(tp => !tp.is_protected).forEach(tp => TYPE_KEYS.push(tp.key));
  }
}

// Busca os catálogos do servidor. Exposto em window.CATALOGS_READY para que
// js/user-sync.js espere esta promise antes do primeiro render() real (ver
// initUserSync() lá) — garante que VERSION_KEYS/ENV_KEYS/TYPE_KEYS e o HTML
// dinâmico já estejam prontos antes de qualquer comando ser gerado na tela.
window.CATALOGS_READY = (async function loadCatalogs() {
  try {
    const res = await fetch('/api/catalogs');
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.versions) && Array.isArray(data.environments) && Array.isArray(data.topics)) {
        // vendors/systems/version_environments/environment_topics são mais
        // recentes que este fetch — um servidor antigo (sem a migração
        // multi-fabricante) não os envia; cai no [] default de CATALOGS acima
        // em vez de undefined.
        CATALOGS = Object.assign(
          { vendors: [], systems: [], prompts: [], exports: [], version_environments: [], environment_topics: [] },
          data
        );
      }
    }
  } catch (e) {
    console.warn('Não foi possível carregar catálogos de Versão/Ambiente/Tópico do servidor — usando padrões estáticos do HTML', e);
    return; // mantém VERSION_KEYS/ENV_KEYS/TYPE_KEYS e o HTML estático originais
  }
  ccApplyToLegacyArrays();
  renderCatalogUI();
  if (typeof sortAllDropdowns === 'function') sortAllDropdowns();
})();
