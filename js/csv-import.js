// ════════════════════════════════════════════════
// IMPORTAÇÃO DE COMANDOS (CSV) — botão "Import commands" na barra de
// ferramentas, junto de "Export commands" (#cmdActionsAdminOnly — só
// aparece com Admin mode ligado; diferente de "Add command", que fica fora
// desse wrapper e sempre visível — ver components.css/settings.js).
//
// Fluxo: usuário baixa um template .csv (downloadImportTemplate — mesmas
// colunas usadas por Export, ver csv-export.js), preenche uma linha por
// comando, escolhe o arquivo (handleImportFileSelected) e confirma
// (runImportCommands). Cada linha vira um POST /api/commands — por padrão
// como comando do usuário atual, exatamente como o editor manual e
// "Duplicate command". Exceção: admins podem marcar o checkbox
// "Import as System commands" (importAsSystemRow, admin-only — ver
// js/auth.js) para importar o lote inteiro como comandos de referência
// (created_by='System'), via header X-Save-As-System — ver createCommand()
// em js/api-client.js e POST /api/commands em server/index.js.
//
// Escopo intencionalmente simplificado: cobre o caso comum (comando "plain",
// sem placeholder_resolver nem diffs por versão) — múltiplas linhas de
// comando são suportadas (uma por linha de texto dentro da célula "Command"),
// mas resolvers avançados e diffs continuam exclusivos do editor manual.
// ════════════════════════════════════════════════

// ── Parser CSV (RFC 4180) — mesmo delimitador/aspas usados por csv-export.js.
// Escrito à mão (sem dependência externa) porque este app não carrega
// nenhuma biblioteca de terceiros; suporta células com quebras de linha e
// aspas internas escapadas (""), que é exatamente o que csv-export.js e o
// template gerado aqui produzem. ──
function parseCsvText(text) {
  // Remove o BOM UTF-8 que o próprio app grava no início dos .csv que exporta.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === CSV_DELIMITER) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; } // normaliza CRLF -> LF abaixo
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  // última célula/linha, se o arquivo não terminar com quebra de linha.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // descarta linhas totalmente vazias (comum no fim do arquivo)
  return rows.filter(r => r.some(c => c !== ''));
}

// Primeira linha = cabeçalho (nomes de coluna); demais linhas viram objetos
// {header: valor}. Comparação de cabeçalho é tolerante a maiúsculas/espaços,
// já que o usuário pode ter editado o template.
function csvRowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] !== undefined ? r[idx] : '').trim(); });
    return obj;
  });
}
function getCell(obj, ...names) {
  for (const n of names) {
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() === n.toLowerCase()) return obj[k];
    }
  }
  return '';
}
function normKey(s) { return String(s || '').trim().toLowerCase(); }
function splitCell(cell) { return String(cell || '').split(',').map(s => s.trim()).filter(Boolean); }

// ── Template para download — mesmas colunas usadas na exportação (Topic,
// Versions, Environments, Details — ver CSV_COLUMNS em csv-export.js), mais
// as colunas específicas de importação (Prompt, Command). SEM coluna de ID —
// o id agora é um INTEGER sequencial atribuído pelo Postgres na criação (ver
// server/index.js: POST /api/commands), nunca lido do CSV nem gerado aqui —
// igual ao editor manual (ver _ceBindSingleSeg em js/command-editor.js, onde
// o ID também é oculto/auto-gerado). Uma linha de exemplo real ajuda mais que
// uma linha de instruções — os detalhes ficam no texto do modal.
// Ordem das colunas — pedido do usuário: Name, Description, Details, Vendor,
// System, Topics, Versions, Environments, Prompt, Command.
// `Details` substitui as antigas 3 colunas Purpose/When to use/Notes (agora
// um campo único de rich text — ver server/schema.sql) — texto simples numa
// célula do CSV funciona igual antes (sanitizeNoteHtml não mexe em texto sem
// tags reconhecidas), e um .csv reexportado (com HTML de verdade na célula)
// também reimporta corretamente, sem conversão adicional.
// Coluna `Note` REMOVIDA deste template (pedido do usuário) — o parser ainda
// aceita uma coluna "Note" por compatibilidade retroativa com .csv antigos/
// já preenchidos (ver getCell(obj, 'Note') abaixo), mas o arquivo baixado
// agora não a inclui mais; use `Details` para qualquer observação.
// `Exportable` — pedido do usuario original: "incluir apos o prompt o
// exportable". Hoje aplica o template padrao do catalogo Exports quando
// verdadeiro (ver CSV_DEFAULT_EXPORT_TEMPLATE abaixo) -- como uma linha do
// CSV pode virar VARIAS linhas de comando (uma por linha de texto dentro da
// celula "Command"), o mesmo valor de `Exportable` se aplica a todas elas,
// igual ao `Prompt`. Aceita yes/true/1/x (e vazio/no/false/0 = nao), sem
// diferenciar maiusculas.
const IMPORT_HEADERS = [
  'Name', 'Description', 'Details', 'Vendor', 'System', 'Topics', 'Versions', 'Environments',
  'Prompt', 'Exportable', 'Command',
];
// Vendor/System/Version/Environment/Topics são todos obrigatórios agora (ver
// buildImportPayload abaixo) — "all" não é mais um valor aceito nestas 4
// colunas, por isso o exemplo usa valores reais e concretos do catálogo.
const IMPORT_EXAMPLE_ROW = [
  'Check WatchDog process status', 'Shows whether a monitored WatchDog process is alive',
  'Confirms a critical process (fwd, cpd, etc.) is being watched and running. After a restart, or when troubleshooting a service that keeps failing.',
  'Check Point', 'Gaia',
  'System Monitoring', 'R82', 'Standalone',
  '[Expert@FW]#', 'No', 'cpwd_admin list',
];
function downloadImportTemplate() {
  const csv = '﻿' + [IMPORT_HEADERS, IMPORT_EXAMPLE_ROW]
    .map(r => r.map(csvEscapeField).join(CSV_DELIMITER))
    .join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'toolbox45-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Resolução de catálogo: aceita a KEY ou o LABEL (Tópico também aceita o
// título de seção usado na exportação), sem diferenciar maiúsculas/minúsculas
// — assim tanto um template preenchido do zero quanto um .csv reaproveitado
// do "Export commands" funcionam para reimportar. ──
function matchCatalogItem(raw, items, extraFields) {
  const needle = raw.trim().toLowerCase();
  if (!needle) return null;
  return items.find(it => {
    if ((it.key || '').toLowerCase() === needle) return true;
    if ((it.label || '').toLowerCase() === needle) return true;
    return (extraFields || []).some(f => (it[f] || '').toLowerCase() === needle);
  }) || null;
}
// Retorna as keys reconhecidas na célula (vazia ou "all" => [] — "Nenhuma
// restrição" só existe como conceito de FILTRO, ver GET /api/commands; aqui é
// só a resolução bruta da célula). O CHAMADOR (buildImportPayload abaixo) é
// quem decide se um resultado vazio é aceitável — para Vendor/System/Version/
// Environment agora NÃO é (ver validateBody em server/index.js: mesmos 4
// campos são obrigatórios no cadastro, e a importação CSV segue a mesma
// regra). Valores digitados mas não reconhecidos viram aviso, não erro fatal.
// `resType` (opcional) é a chave em _importResolutionMap a consultar quando
// matchCatalogItem não encontra nada — preenchida pelo painel "Resolve
// unmatched values" (ver mais abaixo) quando o usuário mapeia um valor
// digitado pra um item já existente com nome diferente (ex.: "CP" -> "Check
// Point"). Itens marcados como "criar novo" nesse painel já foram de fato
// criados via API antes de chegar aqui, então já batem direto no catálogo
// (CATALOGS foi recarregado) — o mapa só é mesmo necessário pro caso "mapear
// pra existente com grafia diferente".
function resolveMultiCatalog(cell, items, warnings, label, resType) {
  const raw = (cell || '').trim();
  if (!raw || raw.toLowerCase() === 'all') return [];
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const keys = [];
  parts.forEach(p => {
    const found = matchCatalogItem(p, items);
    if (found) { keys.push(found.key); return; }
    const mapped = resType && _importResolutionMap[resType] && _importResolutionMap[resType][normKey(p)];
    if (mapped) { keys.push(mapped); return; }
    warnings.push(`${label} "${p}" not found — ignored`);
  });
  return keys;
}
function resolveTopics(cell, warnings) {
  const raw = (cell || '').trim();
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const keys = [];
  parts.forEach(p => {
    const found = matchCatalogItem(p, (CATALOGS.topics || []).filter(t => !t.is_protected), ['label']);
    if (found) { keys.push(found.key); return; }
    const mapped = _importResolutionMap.topic[normKey(p)];
    if (mapped) { keys.push(mapped); return; }
    warnings.push(`Topic "${p}" not found — ignored`);
  });
  return [...new Set(keys)];
}
// Interpreta a celula `Exportable` como booleano. Aceita yes/true/1/x
// (case-insensitive); qualquer outro valor (incluindo vazio/no/false/0) e
// tratado como falso -- true aplica o template padrao do catalogo Exports
// (ver CSV_DEFAULT_EXPORT_TEMPLATE abaixo).
function parseBooleanCell(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === 'x';
}

// Export template applied when the `Exportable` cell is true -- the CSV
// stays Yes/No only (it does not record WHICH Exports catalog item was
// chosen, see csvCommandExportable in js/csv-export.js), so reimporting
// uses this fixed text, which is EXACTLY the default item seeded by
// seedDefaultExports() (server/db.js) -- matches what the old "Exportable"
// checkbox already produced before this feature existed.
const CSV_DEFAULT_EXPORT_TEMPLATE = '> {{logFile}}';

// Converte uma linha (objeto {header: valor}) no payload de POST /api/commands.
// Retorna { payload, warnings, error } — `error` != null significa que a
// linha inteira foi rejeitada (não gera payload).
// `id` não é mais um conceito de importação — commands.id é um INTEGER
// sequencial atribuído pelo Postgres em cada INSERT (ver server/index.js),
// então não há mais colisão de id pra resolver dentro do lote.
function buildImportPayload(obj) {
  const warnings = [];
  const name = getCell(obj, 'Name');
  if (!name) return { error: 'Missing "Name"' };

  const topics = resolveTopics(getCell(obj, 'Topics', 'Topic'), warnings);
  if (!topics.length) return { error: 'No valid "Topics" (must match an existing topic)' };

  // Vendor/System/Version/Environment são obrigatórios no cadastro (mesma
  // regra do editor manual — "All" só existe como filtro, nunca como valor
  // salvo num comando, ver validateBody em server/index.js) — uma célula
  // vazia, "all", ou só com valores não reconhecidos rejeita a linha inteira,
  // igual ao tratamento já existente para "Topics" logo acima.
  // A command belongs to exactly one vendor and exactly one system (unlike
  // Version/Environment/Topic below, which allow several) — mirrors the
  // single-select Vendor/System fields in the "New command" editor (see
  // _ceBindSingleSeg in js/command-editor.js).
  const vendors = resolveMultiCatalog(getCell(obj, 'Vendor', 'Vendors'), CATALOGS.vendors || [], warnings, 'Vendor', 'vendor');
  if (!vendors.length) return { error: 'No valid "Vendor" (exactly one is required — must match an existing vendor)' };
  if (vendors.length > 1) return { error: `"Vendor" must have exactly one value, found ${vendors.length} (${vendors.join(', ')}) — a command belongs to a single vendor` };
  const systems = resolveMultiCatalog(getCell(obj, 'System', 'Operating System', 'OS'), CATALOGS.systems || [], warnings, 'System', 'system');
  if (!systems.length) return { error: 'No valid "System" (exactly one is required — must match an existing system)' };
  // Same single-value rule as Vendor above (see _ceBindSingleSeg in
  // js/command-editor.js) — a command belongs to exactly one System.
  if (systems.length > 1) return { error: `"System" must have exactly one value, found ${systems.length} (${systems.join(', ')}) — a command belongs to a single system` };
  const versions = resolveMultiCatalog(getCell(obj, 'Versions', 'Version'), CATALOGS.versions || [], warnings, 'Version', 'version');
  if (!versions.length) return { error: 'No valid "Version" (at least one is required — must match an existing version)' };
  const environments = resolveMultiCatalog(getCell(obj, 'Environments', 'Environment'), CATALOGS.environments || [], warnings, 'Environment', 'environment');
  if (!environments.length) return { error: 'No valid "Environment" (at least one is required — must match an existing environment)' };
  const prompt = getCell(obj, 'Prompt') || '[Expert@FW]#';
  const exportTemplate = parseBooleanCell(getCell(obj, 'Exportable', 'Export')) ? CSV_DEFAULT_EXPORT_TEMPLATE : null;
  const commandCell = getCell(obj, 'Command');
  const noteCell = getCell(obj, 'Note');

  const cmdLines = commandCell.split('\n').map(s => s.trim()).filter(Boolean)
    .map(content => ({ line_type: 'cmd', prompt, content, export_template: exportTemplate }));
  if (!cmdLines.length) return { error: 'Missing "Command"' };
  const lines = [...cmdLines];
  // A coluna "Note" do CSV virava uma linha de texto categoria 'note'
  // (roxa) — categoria removida do editor (js/command-editor.js,
  // CMD_EDITOR_TEXT_CATEGORIES) porque conflitava com o conceito de "Notes"
  // (post-its dentro das pastas). Import passa a gerar 'info' (azul) pra
  // não continuar criando linhas na categoria retirada; comandos já
  // importados antes com 'note' continuam funcionando normalmente (ver
  // CMD_EDITOR_TEXT_CATEGORIES_LEGACY).
  if (noteCell.trim()) lines.push({ line_type: 'info', content: noteCell.trim() });

  // Aviso (não bloqueia a linha) para {{token}} sem parâmetro cadastrado —
  // só acontece se o usuário escolheu "Import anyway" no painel de resolução
  // (ver collectTokensFromRow/paramIsKnown mais abaixo no arquivo; hoisted,
  // por isso pode ser chamado aqui mesmo definido depois). Sem isso o
  // comando importa normalmente, mas o token nunca é substituído (fica como
  // "<token>" literal pra sempre, ver resolveTokens em js/db-render-engine.js).
  collectTokensFromRow(obj).forEach(tok => {
    if (!paramIsKnown(tok)) warnings.push(`Parameter "{{${tok}}}" not registered — will show as a literal placeholder until you add it via Manage Parameters`);
  });

  const payload = {
    name,
    desc: getCell(obj, 'Description', 'Desc'),
    topics, vendors, systems, versions, environments,
    // `Details` substitui Purpose/When to use/Notes — passado cru pro
    // servidor, que sanitiza via sanitizeNoteHtml (mesma allow-list de
    // Notes) em buildCommandColumns (server/index.js).
    details: getCell(obj, 'Details'),
    lines,
  };
  return { payload, warnings };
}

// ════════════════════════════════════════════════
// RESOLVER VALORES DE CATÁLOGO SEM CORRESPONDÊNCIA — quando Vendor/System/
// Versions/Environments/Topics do .csv não batem com nada já cadastrado, em
// vez de só ignorar (aviso) ou rejeitar a linha (campos obrigatórios), o
// usuário resolve cada valor direto na tela de importação: cria como novo
// item do catálogo (chamando a mesma API do "Manage → Vendors/Systems/..."),
// ou mapeia pra um item já existente com nome diferente (ex.: "CP" -> "Check
// Point"). Só depois disso o botão "Import" é liberado.
//
// Ordem de resolução: Vendor → System → Version → Environment → Topic — os
// dois primeiros pares (System depende de Vendor, Version depende de
// System) porque criar um System novo exige escolher a Vendor (e Version
// exige escolher o System), então o dropdown de vínculo de cada um lista os
// itens já cadastrados MAIS os que estão sendo criados nesta mesma tela
// (marcados "(new, from this file)") — resolvidos de fato só na hora de
// aplicar (applyImportResolutions), na mesma ordem de dependência.
// ════════════════════════════════════════════════
const IMPORT_RES_ORDER = ['vendor', 'system', 'version', 'environment', 'topic'];
// environment.parent = 'system' (igual version) — environments.system agora é
// FK obrigatória (ver server/schema.sql), então criar um Ambiente novo por
// aqui também precisa escolher o Sistema, na mesma ordem de dependência
// vendor->system->version->environment já usada por IMPORT_RES_ORDER abaixo.
const IMPORT_RES_META = {
  vendor:      { label: 'Vendor',      endpoint: '/api/vendors',      parent: null },
  system:      { label: 'System',      endpoint: '/api/systems',      parent: 'vendor' },
  version:     { label: 'Version',     endpoint: '/api/versions',     parent: 'system' },
  environment: { label: 'Environment', endpoint: '/api/environments', parent: 'system' },
  topic:       { label: 'Topic',       endpoint: '/api/topics',       parent: null },
};
// rawLower -> key já resolvida (mapeada pra existente OU criada nesta sessão
// de import). Reiniciado a cada arquivo novo escolhido / a cada abertura do
// modal — ver resetImportResolutionState abaixo.
let _importResolutionMap = { vendor: {}, system: {}, version: {}, environment: {}, topic: {}, parameter: {} };
function resetImportResolutionState() {
  _importResolutionMap = { vendor: {}, system: {}, version: {}, environment: {}, topic: {}, parameter: {} };
}

// Parâmetros ({{token}}) — diferente dos outros 5 tipos, aqui não existe uma
// coluna dedicada no CSV: o "valor" é o próprio nome do token, digitado
// direto no meio do texto livre (Command/Prompt/Note/Description/...). Por
// isso a varredura é uma busca bruta em TODAS as células da linha (mesma
// regex \w+ usada por resolveTokens em js/db-render-engine.js, pra garantir
// que "resolvido aqui" == "substituído de verdade na hora de renderizar") em
// vez de ler uma coluna específica por nome, como as outras 5 fazem via getCell.
const IMPORT_PARAM_TOKEN_RE = /\{\{(\w+)\}\}/g;
function collectTokensFromRow(obj) {
  const found = new Set();
  Object.values(obj || {}).forEach(val => {
    String(val || '').replace(IMPORT_PARAM_TOKEN_RE, (m, key) => { found.add(key); return m; });
  });
  return [...found];
}
// Match é sempre exato (case-sensitive, sem normKey) — é assim que
// resolveTokens compara contra CATALOGS.parameters, então "resolvido" aqui
// tem que usar a mesma regra, senão o token nunca seria substituído de
// verdade mesmo depois de "resolvido" nesta tela.
function paramIsKnown(token) {
  if ((CATALOGS.parameters || []).some(p => p.key === token)) return true;
  return !!_importResolutionMap.parameter[token];
}

function importCatalogItemsFor(type) {
  if (type === 'vendor') return CATALOGS.vendors || [];
  if (type === 'system') return CATALOGS.systems || [];
  if (type === 'version') return CATALOGS.versions || [];
  if (type === 'environment') return CATALOGS.environments || [];
  if (type === 'topic') return (CATALOGS.topics || []).filter(t => !t.is_protected);
  return [];
}
// Rótulo com o pai entre parênteses, pra não confundir (ex.: duas versões
// "R82" cadastradas sob systems diferentes).
function importCatalogOptionLabel(type, item) {
  if (type === 'system') {
    const vendor = (CATALOGS.vendors || []).find(v => v.key === item.vendor);
    return vendor ? `${item.label} (${vendor.label})` : item.label;
  }
  if (type === 'version') {
    const system = (CATALOGS.systems || []).find(s => s.key === item.system);
    return system ? `${item.label} (${system.label})` : item.label;
  }
  return item.label;
}

// Varre todas as linhas já parseadas e devolve, por tipo de catálogo, um Map
// rawLower -> {raw, count} com os valores digitados que não batem com nada
// (nem no catálogo vivo, nem no que já foi resolvido nesta sessão de
// import) — base do painel "Resolve unmatched values".
function collectUnresolvedRefs(rows) {
  const out = { vendor: new Map(), system: new Map(), version: new Map(), environment: new Map(), topic: new Map(), parameter: new Map() };
  const bump = (type, raw) => {
    const k = normKey(raw);
    if (!k || k === 'all') return;
    const cur = out[type].get(k);
    if (cur) cur.count++;
    else out[type].set(k, { raw: raw.trim(), count: 1 });
  };
  const isKnown = (type, raw, items, extraFields) => {
    if (matchCatalogItem(raw, items, extraFields)) return true;
    return !!_importResolutionMap[type][normKey(raw)];
  };
  (rows || []).forEach(obj => {
    splitCell(getCell(obj, 'Vendor', 'Vendors')).forEach(v => {
      if (!isKnown('vendor', v, importCatalogItemsFor('vendor'))) bump('vendor', v);
    });
    splitCell(getCell(obj, 'System', 'Operating System', 'OS')).forEach(v => {
      if (!isKnown('system', v, importCatalogItemsFor('system'))) bump('system', v);
    });
    splitCell(getCell(obj, 'Versions', 'Version')).forEach(v => {
      if (!isKnown('version', v, importCatalogItemsFor('version'))) bump('version', v);
    });
    splitCell(getCell(obj, 'Environments', 'Environment')).forEach(v => {
      if (!isKnown('environment', v, importCatalogItemsFor('environment'))) bump('environment', v);
    });
    splitCell(getCell(obj, 'Topics', 'Topic')).forEach(v => {
      if (!isKnown('topic', v, importCatalogItemsFor('topic'), ['label'])) bump('topic', v);
    });
    // Parâmetros: sem coluna própria, sem normKey (case-sensitive, ver
    // paramIsKnown acima) — não usa bump() por isso.
    collectTokensFromRow(obj).forEach(tok => {
      if (paramIsKnown(tok)) return;
      const cur = out.parameter.get(tok);
      if (cur) cur.count++;
      else out.parameter.set(tok, { raw: tok, count: 1 });
    });
  });
  return out;
}
function importAnyUnresolved(unresolved) {
  return IMPORT_RES_ORDER.some(t => unresolved[t].size > 0) || (unresolved.parameter && unresolved.parameter.size > 0);
}

// Monta o HTML do painel de resolução, uma seção por tipo (só as que têm
// pendência) — ver applyImportResolutions para o que acontece ao confirmar.
function renderImportResolutionPanel(unresolved) {
  const sections = IMPORT_RES_ORDER.map(type => {
    const map = unresolved[type];
    if (!map || !map.size) return '';
    const meta = IMPORT_RES_META[type];
    const existingItems = importCatalogItemsFor(type);
    const parentType = meta.parent;
    const parentExistingItems = parentType ? importCatalogItemsFor(parentType) : [];
    const parentPendingRaws = parentType ? [...unresolved[parentType].keys()] : [];

    const rowsHtml = [...map.entries()].map(([rawKey, info], idx) => {
      const domId = `impres-${type}-${idx}`;
      const existingOptionsHtml = existingItems.map(it =>
        `<option value="${escAttr(it.key)}">${escAttr(importCatalogOptionLabel(type, it))}</option>`).join('');
      let parentFieldHtml = '';
      if (parentType) {
        const existingParentOpts = parentExistingItems.map(it =>
          `<option value="key:${escAttr(it.key)}">${escAttr(importCatalogOptionLabel(parentType, it))}</option>`).join('');
        const pendingParentOpts = parentPendingRaws.map(praw => {
          const pinfo = unresolved[parentType].get(praw);
          return `<option value="new:${escAttr(praw)}">${escAttr(pinfo.raw)} (new, from this file)</option>`;
        }).join('');
        parentFieldHtml = `
          <select class="set-input imp-res-parent" id="${domId}-parent">
            <option value="">— choose ${escAttr(IMPORT_RES_META[parentType].label)} —</option>
            ${existingParentOpts}${pendingParentOpts}
          </select>`;
      }
      return `
        <div class="imp-res-row" id="${domId}-row">
          <div class="imp-res-raw">"${escAttr(info.raw)}"<span class="imp-res-count"> — used in ${info.count} command${info.count === 1 ? '' : 's'}</span></div>
          <select class="set-input imp-res-choice" id="${domId}-choice" data-type="${type}" data-idx="${idx}" data-raw="${escAttr(rawKey)}"
                  onchange="_impResToggleExtra('${type}', ${idx})">
            <option value="__new__">➕ Create new ${escAttr(meta.label.toLowerCase())}: "${escAttr(info.raw)}"</option>
            ${existingOptionsHtml ? `<option disabled>──────────</option>${existingOptionsHtml}` : ''}
          </select>
          <div class="imp-res-extra" id="${domId}-extra">
            <input class="set-input" id="${domId}-label" value="${escAttr(info.raw)}" placeholder="${escAttr(meta.label)} name" style="flex:1;min-width:120px;">
            <input type="color" class="cat-color-input" id="${domId}-color" value="#8B949E">
            ${parentFieldHtml}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="set-group imp-res-section">
        <span class="set-label">${escAttr(meta.label)}${map.size > 1 ? 's' : ''} not found (${map.size})</span>
        ${rowsHtml}
      </div>`;
  }).join('');

  // Parâmetros ({{token}}) — mesmo painel/mesma ideia (criar novo ou mapear
  // pra existente), mas layout próprio: sem "pai" (dependency select), e a
  // key NUNCA é editável na criação — ela É o token já usado no arquivo (ver
  // comentário em collectTokensFromRow); só o rótulo/descrição é editável.
  const paramMap = unresolved.parameter;
  let paramSection = '';
  if (paramMap && paramMap.size) {
    const existingParams = CATALOGS.parameters || [];
    const paramRowsHtml = [...paramMap.entries()].map(([token, info], idx) => {
      const domId = `impres-parameter-${idx}`;
      const existingOptionsHtml = existingParams.map(p =>
        `<option value="${escAttr(p.key)}">${escAttr(p.label)} ({{${escAttr(p.key)}}})</option>`).join('');
      return `
        <div class="imp-res-row" id="${domId}-row">
          <div class="imp-res-raw">"{{${escAttr(token)}}}"<span class="imp-res-count"> — used in ${info.count} command${info.count === 1 ? '' : 's'}</span></div>
          <select class="set-input imp-res-choice" id="${domId}-choice" data-type="parameter" data-idx="${idx}" data-raw="${escAttr(token)}"
                  onchange="_impResToggleExtra('parameter', ${idx})">
            <option value="__new__">➕ Create new parameter: {{${escAttr(token)}}}</option>
            ${existingOptionsHtml ? `<option disabled>──────────</option>${existingOptionsHtml}` : ''}
          </select>
          <div class="imp-res-extra" id="${domId}-extra">
            <span class="imp-res-param-key">Key: <code>{{${escAttr(token)}}}</code> (fixed — matches the token used in this file)</span>
            <input class="set-input" id="${domId}-label" placeholder="Parameter description (e.g. Source IP)" style="flex:1;min-width:140px;">
          </div>
        </div>`;
    }).join('');
    paramSection = `
      <div class="set-group imp-res-section">
        <span class="set-label">Parameter${paramMap.size > 1 ? 's' : ''} not registered (${paramMap.size})</span>
        ${paramRowsHtml}
      </div>`;
  }

  return `
    <div id="importResolveBox" class="imp-res-panel">
      <span class="set-hint" style="display:block;margin-bottom:10px;">
        Some values in this file don't match anything registered yet. For each one below, create it as a new catalog
        item or map it to the existing one it should use instead.
      </span>
      ${sections}${paramSection}
      <div class="imp-res-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick="_impResSkipAndPreview()">Import anyway (skip unresolved)</button>
        <button type="button" class="btn btn-primary btn-sm" id="impResApplyBtn" onclick="applyImportResolutions()">Apply &amp; continue</button>
      </div>
    </div>`;
}
function _impResToggleExtra(type, idx) {
  const domId = `impres-${type}-${idx}`;
  const choice = _impBox(`${domId}-choice`);
  const extra = _impBox(`${domId}-extra`);
  if (!choice || !extra) return;
  extra.style.display = choice.value === '__new__' ? 'flex' : 'none';
}

// Aplica as decisões do painel: pra cada item, ou grava o mapeamento direto
// (escolheu um item existente), ou cria via API (na ordem vendor->system->
// version->environment->topic, pra que o dropdown de vínculo de System/
// Version já tenha o pai recém-criado disponível) e grava o mapeamento com a
// key real devolvida pelo servidor. Ao final, recarrega CATALOGS (mesma
// função usada pela tela de Manage) e reavalia o que ainda falta — se nada
// mais, mostra o preview normal e libera o Import; se ainda faltar algo
// (ex.: erro de rede numa criação), re-renderiza o painel só com o que
// sobrou.
async function applyImportResolutions() {
  const applyBtn = _impBox('impResApplyBtn');
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying…'; }
  const box = _impBox('importResolveBox');
  const errors = [];

  for (const type of IMPORT_RES_ORDER) {
    const meta = IMPORT_RES_META[type];
    const choiceEls = box ? Array.from(box.querySelectorAll(`.imp-res-choice[data-type="${type}"]`)) : [];
    for (const choiceEl of choiceEls) {
      const idx = choiceEl.getAttribute('data-idx');
      const raw = choiceEl.getAttribute('data-raw');
      const domId = `impres-${type}-${idx}`;
      if (choiceEl.value !== '__new__') {
        _importResolutionMap[type][raw] = choiceEl.value;
        continue;
      }
      const labelInput = _impBox(`${domId}-label`);
      const colorInput = _impBox(`${domId}-color`);
      const label = (labelInput && labelInput.value.trim()) || raw;
      const color = (colorInput && colorInput.value) || '#8B949E';
      const body = { label, color };
      if (meta.parent) {
        const parentSelect = _impBox(`${domId}-parent`);
        const parentVal = parentSelect ? parentSelect.value : '';
        if (!parentVal) {
          errors.push(`Choose a ${IMPORT_RES_META[meta.parent].label} for "${label}"`);
          continue;
        }
        let parentKey = parentVal;
        if (parentVal.startsWith('key:')) {
          parentKey = parentVal.slice(4);
        } else if (parentVal.startsWith('new:')) {
          parentKey = _importResolutionMap[meta.parent][parentVal.slice(4)];
          if (!parentKey) {
            errors.push(`"${label}" depends on a new ${meta.parent} that wasn't created — resolve it first`);
            continue;
          }
        }
        body[meta.parent] = parentKey;
      }
      try {
        const res = await fetch(meta.endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          errors.push(`"${label}": ${errBody.message || 'failed to create'}`);
          continue;
        }
        const created = await res.json();
        _importResolutionMap[type][raw] = created.key;
      } catch (e) {
        errors.push(`"${label}": something went wrong — check your connection and try again`);
      }
    }
  }

  // Parâmetros — sem "pai", e a key na criação é sempre o próprio token (não
  // vem de um input editável, ver renderImportResolutionPanel acima).
  {
    const choiceEls = box ? Array.from(box.querySelectorAll('.imp-res-choice[data-type="parameter"]')) : [];
    for (const choiceEl of choiceEls) {
      const idx = choiceEl.getAttribute('data-idx');
      const token = choiceEl.getAttribute('data-raw');
      const domId = `impres-parameter-${idx}`;
      if (choiceEl.value !== '__new__') {
        _importResolutionMap.parameter[token] = choiceEl.value;
        continue;
      }
      const labelInput = _impBox(`${domId}-label`);
      const label = (labelInput && labelInput.value.trim()) || token;
      try {
        const res = await fetch('/api/parameters', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: token, label }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          errors.push(`"{{${token}}}": ${errBody.message || 'failed to create'}`);
          continue;
        }
        const created = await res.json();
        _importResolutionMap.parameter[token] = created.key; // sempre === token
      } catch (e) {
        errors.push(`"{{${token}}}": something went wrong — check your connection and try again`);
      }
    }
  }

  // Diferente dos outros 5 tipos (onde a key resolvida só entra em arrays do
  // payload), um Parâmetro precisa aparecer LITERALMENTE como {{key}} no
  // texto do comando pra ser substituído em tempo de render (ver
  // resolveTokens em js/db-render-engine.js) — por isso, quando o usuário
  // mapeia um token pra um parâmetro já existente com key diferente (ex.:
  // arquivo usa {{srcip}}, mas o catálogo já tem {{src_ip}}), é preciso
  // reescrever {{srcip}} -> {{src_ip}} em todas as células de texto das
  // linhas afetadas antes de montar os comandos. Sem isso o valor mapeado
  // nunca teria efeito nenhum na hora de renderizar.
  Object.entries(_importResolutionMap.parameter).forEach(([token, resolvedKey]) => {
    if (!resolvedKey || resolvedKey === token) return;
    const re = new RegExp(`\\{\\{${token}\\}\\}`, 'g');
    (_importParsedRows || []).forEach(obj => {
      Object.keys(obj).forEach(header => {
        if (typeof obj[header] === 'string' && obj[header].indexOf(`{{${token}}}`) !== -1) {
          obj[header] = obj[header].replace(re, `{{${resolvedKey}}}`);
        }
      });
    });
  });

  if (typeof catAdminRefreshCatalogs === 'function') await catAdminRefreshCatalogs();

  const stillUnresolved = collectUnresolvedRefs(_importParsedRows || []);
  const preview = _impBox('importPreviewBox');
  if (importAnyUnresolved(stillUnresolved)) {
    if (preview) {
      preview.innerHTML =
        (errors.length ? `<div class="imp-res-errors">${errors.map(e => `<div>${escAttr(e)}</div>`).join('')}</div>` : '') +
        renderImportResolutionPanel(stillUnresolved);
    }
  } else {
    _impResShowPreview(errors);
  }
}
function _impResShowPreview(errors) {
  const preview = _impBox('importPreviewBox');
  const btn = _impBox('importConfirmBtn');
  const n = (_importParsedRows || []).length;
  if (preview) {
    preview.innerHTML =
      (errors && errors.length ? `<div class="imp-res-errors">${errors.map(e => `<div>${escAttr(e)}</div>`).join('')}</div>` : '') +
      `<span class="set-hint" style="display:block;margin-top:10px;">${n} row${n === 1 ? '' : 's'} ready. Click Import to create ${n === 1 ? 'it' : 'them'}.</span>`;
  }
  if (btn) btn.disabled = n === 0;
}
// "Import anyway" — mantém o comportamento antigo (valores não reconhecidos
// entram como aviso por linha, ou rejeitam a linha se forem obrigatórios e
// ficarem vazios), pra quem não quiser resolver tudo antes de importar.
function _impResSkipAndPreview() { _impResShowPreview([]); }

// ── Estado do modal ──
let _importParsedRows = null; // array de objetos {header: valor}, ou null se nada carregado ainda

function _impBox(id) { return document.getElementById(id); }

function openImportCommandsModal(ev) {
  _importParsedRows = null;
  resetImportResolutionState();
  const fileInput = _impBox('importCsvFile');
  if (fileInput) fileInput.value = '';
  const preview = _impBox('importPreviewBox');
  if (preview) preview.innerHTML = '';
  const results = _impBox('importResultsBox');
  if (results) results.innerHTML = '';
  const btn = _impBox('importConfirmBtn');
  if (btn) btn.disabled = true;
  // Sempre reabre desmarcado — visibilidade em si (admin-only) é tratada por
  // applyAdminGating() em js/auth.js (ver ADMIN_ONLY_SETTINGS_GROUP_IDS).
  const asSystemChk = _impBox('importAsSystemCheckbox');
  if (asSystemChk) asSystemChk.checked = false;
  const hint = _impBox('importHint');
  if (hint) {
    hint.textContent = 'Bulk-create commands from a .csv file. Not sure how to fill it in? Download the template below — it has the exact columns expected, with a filled-in example row. If Vendor/System/Version/Environment/Topics don\'t match anything registered yet, you\'ll be able to create them or map them to an existing item right here before importing. Imported commands are created as your own by default and can be edited/deleted normally afterwards.';
  }
  const overlay = _impBox('importCommandsOverlay');
  if (overlay) overlay.classList.add('show');
}
function closeImportCommandsModal() {
  const overlay = _impBox('importCommandsOverlay');
  if (overlay) overlay.classList.remove('show');
}

function handleImportFileSelected(input) {
  const file = input.files && input.files[0];
  const preview = _impBox('importPreviewBox');
  const btn = _impBox('importConfirmBtn');
  const results = _impBox('importResultsBox');
  if (results) results.innerHTML = '';
  resetImportResolutionState();
  if (!file) {
    _importParsedRows = null;
    if (preview) preview.innerHTML = '';
    if (btn) btn.disabled = true;
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCsvText(String(reader.result || ''));
      _importParsedRows = csvRowsToObjects(rows);
      if (!_importParsedRows.length) {
        if (preview) preview.innerHTML = `<span class="set-hint" style="display:block;margin-top:10px;color:var(--orange);">No rows found in "${escAttr(file.name)}".</span>`;
        if (btn) btn.disabled = true;
        return;
      }
      const unresolved = collectUnresolvedRefs(_importParsedRows);
      if (importAnyUnresolved(unresolved)) {
        if (preview) preview.innerHTML = renderImportResolutionPanel(unresolved);
        if (btn) btn.disabled = true;
      } else {
        _impResShowPreview([]);
      }
    } catch (e) {
      console.error(e);
      _importParsedRows = null;
      if (preview) preview.innerHTML = `<span class="set-hint" style="display:block;margin-top:10px;color:var(--orange);">Could not read this file as CSV.</span>`;
      if (btn) btn.disabled = true;
    }
  };
  reader.onerror = () => {
    _importParsedRows = null;
    if (preview) preview.innerHTML = `<span class="set-hint" style="display:block;margin-top:10px;color:var(--orange);">Could not read the file.</span>`;
    if (btn) btn.disabled = true;
  };
  reader.readAsText(file, 'utf-8');
}

async function runImportCommands() {
  if (!_importParsedRows || !_importParsedRows.length) return;
  const btn = _impBox('importConfirmBtn');
  const results = _impBox('importResultsBox');
  if (btn) btn.disabled = true;
  // Lido uma vez para o lote inteiro — o checkbox só existe/é marcável por
  // admins (ver importAsSystemRow em index.html + ADMIN_ONLY_SETTINGS_GROUP_IDS
  // em js/auth.js); createCommand() manda o header X-Save-As-System, mas o
  // servidor confere a role de novo antes de honrar (ver POST /api/commands
  // em server/index.js) — um usuário comum marcando isso via DOM não elevaria
  // privilégio de verdade.
  const asSystemChk = _impBox('importAsSystemCheckbox');
  const asSystem = !!(asSystemChk && asSystemChk.checked);
  const report = [];
  for (let i = 0; i < _importParsedRows.length; i++) {
    const rowNum = i + 2; // +1 for 1-based, +1 for the header row
    const obj = _importParsedRows[i];
    const built = buildImportPayload(obj);
    if (built.error) {
      report.push({ rowNum, name: getCell(obj, 'Name') || '(no name)', ok: false, message: built.error });
      continue;
    }
    try {
      await createCommand(built.payload, asSystem);
      report.push({
        rowNum, name: built.payload.name, ok: true,
        message: built.warnings.length ? `Imported — ${built.warnings.join('; ')}` : 'Imported',
      });
    } catch (err) {
      report.push({ rowNum, name: built.payload.name, ok: false, message: (err && err.message) || 'Failed to create' });
    }
  }
  const okCount = report.filter(r => r.ok).length;
  const failCount = report.length - okCount;
  if (results) {
    results.innerHTML = `
      <div class="set-group" style="margin-top:14px;">
        <span class="set-label">${okCount} imported${failCount ? `, ${failCount} failed` : ''}</span>
        <div class="imp-report-list">
          ${report.map(r => `
            <div class="imp-report-row${r.ok ? '' : ' imp-report-row-err'}">
              <span class="imp-report-line">Row ${r.rowNum}</span>
              <span class="imp-report-name">${escAttr(r.name)}</span>
              <span class="imp-report-msg">${escAttr(r.message)}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }
  _importParsedRows = null;
  if (btn) btn.disabled = true;
  if (typeof render === 'function') render();
}

(() => {
  const overlay = document.getElementById('importCommandsOverlay');
  if (overlay) {
    overlay.addEventListener('click', ev => { if (ev.target.id === 'importCommandsOverlay') closeImportCommandsModal(); });
  }
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    const ov = document.getElementById('importCommandsOverlay');
    if (ov && ov.classList.contains('show')) closeImportCommandsModal();
  });
})();
