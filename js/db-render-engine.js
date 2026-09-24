// ════════════════════════════════════════════════
// DB RENDER ENGINE — turns /api/commands rows (already language-resolved by
// the server: name/desc/about text is in the requested language)
// into the same card()/section() HTML terminal-renderer.js has always produced.
//
// Two rendering paths:
//   1) ~24 plain commands (placeholder_resolver = null): straightforward
//      {{token}} substitution on the DB row's lines/name/desc.
//   2) 10 "advanced" commands (placeholder_resolver set): dispatched to
//      RESOLVERS[id](row, values), which calls the exact same net-utils.js
//      helpers (buildFwMonitorFilters, combinedAddrRegex, tcpdumpClause,
//      expandAddrDiscrete, ...) the pre-migration commands.js used, so
//      list/range/CIDR-aware filter generation is preserved exactly.
//
// Scope note: the DB migration (server/seed.js) only captured the
// "standalone environment" default rendering — the per-environment dynamic
// wrapping commands.js used to do (cluster A/B duplication, vsx `vsenv`
// prefix, maestro `asg_cmd`, mds `mdsenv`) is NOT reproduced here for the
// ~24 plain commands or for the 10 resolvers; only the 5 dedicated
// "Ambiente: X" cards (topic='environment') still vary by environment.
// ════════════════════════════════════════════════

// Same {{key}} token syntax used throughout the templates. When a token has
// no value yet (nothing typed in the query bar / command parameter field),
// instead of collapsing to an empty string (which reads as a broken/truncated
// command, e.g. "cprinstall get "), fall back to a friendly "<Label>" hint —
// looked up from the parameters catalog so it matches whatever the field is
// called there (falls back to the raw key if the catalog hasn't loaded yet).
function resolveTokens(str, values) {
  if (str === null || str === undefined) return str;
  return String(str).replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = values[key];
    if (v !== undefined && v !== null && v !== '') return v;
    const catalogParams = (typeof CATALOGS !== 'undefined' && CATALOGS.parameters) || [];
    const param = catalogParams.find(p => p.key === key);
    return `<${param ? param.label : key}>`;
  });
}

// Wraps a dynamic (user-supplied, or its "<Label>" hint) value in the
// VAR_OPEN/VAR_CLOSE sentinel (declared in js/syntax-highlight.js, loaded
// before this file) so safeHL() renders it as a distinct "variable" (k-var)
// token instead of leaving it uncoloured like the rest of the literal
// command syntax. No-op for empty/nullish values — nothing to highlight.
function markVar(v) {
  return (v === undefined || v === null || v === '') ? v : (VAR_OPEN + v + VAR_CLOSE);
}

// Same as resolveTokens(), but for text that will be displayed as a
// highlighted command line (safeHL) rather than copied to the clipboard or
// shown as plain UI text (name/desc/about/raw) — the resolved value (or its
// "<Label>" hint, when the field is still empty) is wrapped with markVar() so
// only the actual variable part of the line gets coloured, never the fixed
// command syntax around it.
function resolveTokensMarked(str, values) {
  if (str === null || str === undefined) return str;
  return String(str).replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = values[key];
    if (v !== undefined && v !== null && v !== '') return markVar(v);
    const catalogParams = (typeof CATALOGS !== 'undefined' && CATALOGS.parameters) || [];
    const param = catalogParams.find(p => p.key === key);
    return markVar(`<${param ? param.label : key}>`);
  });
}

// DB line {line_type, prompt, content, export_template} -> termRender()/card() line
// shape: {p, c} for a command line, {type, c} for an annotation line.
//
// Redirecionamento generico "Exportar para arquivo": linhas com um
// export_template escolhido (catalogo Register -> Manage Exports, ver
// server/schema.sql -- antes um simples flag supports_export=1, agora o
// TEXTO do template em si, ex.: '> {{logFile}}' ou '-w {{logFile}}') tem
// esse template resolvido e anexado automaticamente quando o toggle da
// sidebar (FL.log) esta ligado -- sem precisar de um resolver dedicado nem
// de tokens manuais no texto do comando.
//
// Os comandos com placeholder_resolver (fw monitor, tcpdump, zdebug, fw
// log, fwm logexport) montam suas proprias linhas em JS em vez de passar
// pela funcao acima, entao nao ha conflito/duplicacao -- mas zdebug e fw
// log (RESOLVERS.zdebug/RESOLVERS.fwlog abaixo) leem o export_template da
// linha 'cmd' do proprio row DIRETO (mesmo cadastro do Register), pra nao
// ficar com um caminho fixo hardcoded. fwm logexport (RESOLVERS.logexport)
// e fw fetchlogs (RESOLVERS.fetchlogs) ficam de fora dessa troca: logexport
// já usa um mecanismo proprio de substituicao inline (troca um trecho fixo
// do comando, '-o /tmp/fw_export.txt', por values.logFile) que nao mapeia
// bem pra um export_template tipo '> {{logFile}}'/'-w {{logFile}}'; e
// fetchlogs nunca usou logFile/FL.log pra comecar.
function dbLineToTerm(line, values) {
  if (line.line_type === 'cmd') {
    let content = resolveTokensMarked(line.content, values);
    if (line.export_template && values.FL && values.FL.log && values.logFile) {
      content += ` ${resolveTokensMarked(line.export_template, values)}`;
    }
    return { p: resolveTokens(line.prompt, values), c: content };
  }
  if (line.line_type === 'image') {
    // c = nome exibido no lugar do comando; imageData = data URI base64
    // (command_lines.image_data) mostrada em tamanho maior ao clicar (ver
    // openImageLightbox em terminal-renderer.js).
    return { type: 'image', c: resolveTokens(line.content, values), imageData: line.image_data || null };
  }
  // Linhas de anotação (note/warn/info/ok) não passam por safeHL — ver
  // termRender() em terminal-renderer.js — então usam a resolução "limpa"
  // (sem marcadores de variável, que apareceriam como caracteres de controle
  // soltos no texto corrido).
  return { type: line.line_type, c: resolveTokens(line.content, values) };
}
function dbLinesToTerm(lines, values) {
  return (lines || []).map(l => dbLineToTerm(l, values));
}
// For a DB line whose content contains a literal substring (still holding
// its own {{token}} placeholders) that needs to be swapped for a computed
// value (e.g. a full -F filter string), replace BEFORE token resolution so
// the substring can be matched literally, then resolve whatever tokens remain.
function buildLineWithOverride(line, values, overridePairs) {
  let content = line.content || '';
  (overridePairs || []).forEach(([pattern, replacement]) => {
    content = content.split(pattern).join(replacement);
  });
  if (line.line_type === 'cmd') {
    content = resolveTokensMarked(content, values);
    return { p: resolveTokens(line.prompt, values), c: content };
  }
  content = resolveTokens(content, values);
  return { type: line.line_type, c: content };
}

const RANGE_TOO_LARGE_NOTE = 'A range that is too large (more than 64 /24 blocks) was skipped in the filter — narrow the range or search in parts.';

// ════════════════════════════════════════════════
// RESOLVERS — one per placeholder_resolver value. Each receives the API row
// (already language-resolved; row.lines.default still contains {{token}}
// placeholders) and the current filter values, and returns { lines } in the
// exact shape card() expects.
// ════════════════════════════════════════════════
const RESOLVERS = {};

RESOLVERS.fwmonitor = function (row, values) {
  const { src_ip: src, dst_ip: dst, src_port: sp, dst_port: dp, proto, iface } = values;
  const fwmonFilters = buildFwMonitorFilters(src, dst, sp, dp, proto);
  const ifF = iface ? ` -i ${markVar(iface)}` : '';
  const fwmonCmd = `fw monitor${ifF} ${markVar(fwmonFilters.flagsStr)}`;
  const staticNote = (row.lines.default || []).find(l => l.line_type === 'note');
  const lines = [
    { p: '[Expert@FW]#', c: fwmonCmd },
    staticNote ? { type: 'note', c: resolveTokens(staticNote.content, values) } : null,
    ...fwmonFilters.notes.map(n => ({ type: 'warn', c: n })),
  ].filter(Boolean);

  return { lines };
};

RESOLVERS.tcpdump = function (row, values) {
  const { src_ip: src, dst_ip: dst, src_port: sp, dst_port: dp, proto, iface } = values;
  const srcP = parseAddr(src), dstP = parseAddr(dst);
  const spP = parsePorts(sp), dpP = parsePorts(dp);
  const tcpProto = proto === '6' ? ' and tcp' : proto === '17' ? ' and udp' : proto === '1' ? ' and icmp' : '';
  const tcpIf = iface ? `-i ${markVar(iface)}` : '-i any';
  const srcClauseObj = tcpdumpClause(srcP);
  const dstClauseObj = tcpdumpClause(dstP);
  const tcpNotesArr = [...srcClauseObj.notes, ...dstClauseObj.notes];
  const spActive = spP.items.filter(p => p && p !== '0');
  const dpActive = dpP.items.filter(p => p && p !== '0');
  const spClause = spActive.length ? ` and (${spActive.map(p => `src port ${p}`).join(' or ')})` : '';
  const dpClause = dpActive.length ? ` and (${dpActive.map(p => `dst port ${p}`).join(' or ')})` : '';
  const tcpFlt = `"${srcClauseObj.clause || `host ${src}`} and ${dstClauseObj.clause || `host ${dst}`}${tcpProto}${spClause}${dpClause}"`;
  const tcpCmd = `tcpdump ${tcpIf} -nn -s 0 ${markVar(tcpFlt)}`;
  const staticNote = (row.lines.default || []).find(l => l.line_type === 'note');
  const lines = [
    { p: '[Expert@FW]#', c: tcpCmd },
    staticNote ? { type: 'note', c: resolveTokens(staticNote.content, values) } : null,
    ...tcpNotesArr.map(n => ({ type: 'warn', c: n })),
  ].filter(Boolean);
  return { lines };
};

RESOLVERS.zdebug = function (row, values) {
  const { src_ip: src, dst_ip: dst, FL } = values;
  const srcP = parseAddr(src), dstP = parseAddr(dst);
  const orRegex = combinedAddrRegex([srcP, dstP]);
  const orRegexStr = orRegex.regex || `${src}|${dst}`;
  const orRegexNotes = orRegex.rangeTooLarge ? [RANGE_TOO_LARGE_NOTE] : [];
  // Redirecionamento vem do export_template cadastrado em Register -> Manage
  // Exports (mesmo cadastro que os demais comandos usam via dbLineToTerm),
  // nao mais de um caminho fixo/global -- pedido do usuario: "utilize no
  // comandos o export somente do que esta em register" + "Também ligar os 4
  // comandos avançados ao Register".
  const cmdLine = (row.lines.default || []).find(l => l.line_type === 'cmd');
  const exportSuffix = (FL.log && cmdLine && cmdLine.export_template)
    ? ` ${resolveTokensMarked(cmdLine.export_template, values)}`
    : '';
  const zdCmd = `fw ctl zdebug + drop | grep -E "${markVar(orRegexStr)}"${exportSuffix}`;
  const warnLine = (row.lines.default || []).find(l => l.line_type === 'warn');
  const lines = [
    { p: '[Expert@FW]#', c: zdCmd },
    warnLine ? { type: 'warn', c: resolveTokens(warnLine.content, values) } : null,
    ...orRegexNotes.map(n => ({ type: 'warn', c: n })),
  ].filter(Boolean);

  return { lines };
};

RESOLVERS.fwlog = function (row, values) {
  const { src_ip: src, dst_ip: dst, FL } = values;
  const srcP = parseAddr(src), dstP = parseAddr(dst);
  const orRegex = combinedAddrRegex([srcP, dstP]);
  const orRegexStr = orRegex.regex || `${src}|${dst}`;
  const orRegexNotes = orRegex.rangeTooLarge ? [RANGE_TOO_LARGE_NOTE] : [];
  // Mesmo redirecionamento cadastrado em Register -> Manage Exports (ver
  // comentario em RESOLVERS.zdebug acima) -- os dois comandos abaixo
  // (fwlogCmd/fwlogCmdDrop) compartilham o mesmo export_template.
  const cmdLine = (row.lines.default || []).find(l => l.line_type === 'cmd');
  const logRedir = (FL.log && cmdLine && cmdLine.export_template)
    ? ` ${resolveTokensMarked(cmdLine.export_template, values)}`
    : '';
  const fwlogUsesFallback = srcP.isMulti || dstP.isMulti;
  const fwlogCmd = fwlogUsesFallback
    ? `fw log -n | grep -E "${markVar(orRegexStr)}"${logRedir}`
    : `fw log -n -s ${markVar(src)} -d ${markVar(dst)}${logRedir}`;
  const fwlogCmdDrop = fwlogUsesFallback
    ? `fw log -n -c drop | grep -E "${markVar(orRegexStr)}"${logRedir}`
    : `fw log -n -s ${markVar(src)} -d ${markVar(dst)} -c drop${logRedir}`;
  const staticNote = (row.lines.default || []).find(l => l.line_type === 'note');
  const fallbackNote = fwlogUsesFallback
    ? [
        { type: 'info', c: 'SRC/DST with a list or range: -s/-d only accept a single exact IP, so we filter with grep -E instead.' },
        ...orRegexNotes.map(n => ({ type: 'warn', c: n })),
      ]
    : [];
  const lines = [
    { p: '[Expert@FW]#', c: fwlogCmd },
    { p: '[Expert@FW]#', c: fwlogCmdDrop },
    staticNote ? { type: 'note', c: resolveTokens(staticNote.content, values) } : null,
    ...fallbackNote,
  ].filter(Boolean);
  return { lines };
};

RESOLVERS.logexport = function (row, values) {
  const { src_ip: src, dst_ip: dst, src_port: sp, dst_port: dp, FL, logFile } = values;
  const srcP = parseAddr(src), dstP = parseAddr(dst);
  const spP = parsePorts(sp), dpP = parsePorts(dp);
  const isMultiFilter = srcP.isMulti || dstP.isMulti || spP.isMulti || dpP.isMulti;
  const expOut = FL.log ? logFile : '/tmp/fw_export.txt';
  const dbLines = row.lines.default || [];
  const lines = dbLines.map(l => buildLineWithOverride(l, values, [['/tmp/fw_export.txt', markVar(expOut)]]));
  if (isMultiFilter) {
    lines.push({ type: 'info', c: 'logexport filters a single exact IP at a time in -s/-e — for a list/range, export once without a filter and trim the CSV, or repeat per IP.' });
  }
  return { lines };
};

RESOLVERS.fetchlogs = function (row, values) {
  const { src_ip: src } = values;
  const srcP = parseAddr(src);
  const fetchX = expandAddrDiscrete(srcP, 8, 5);
  const fetchList = fetchX.list.length ? fetchX.list : (fetchX.skippedRange ? [] : [src]);
  const staticNote = (row.lines.default || []).find(l => l.line_type === 'note');
  const lines = [
    ...(fetchList.length
      ? fetchList.map(ip => ({ p: '[Expert@SMS]#', c: `fw fetchlogs ${markVar(ip)}` }))
      : [{ type: 'info', c: 'Fill in a valid gateway IP, or a small list/range (up to 8 addresses), to generate the fw fetchlogs command(s).' }]),
    ...(fetchList.length && staticNote ? [{ type: 'note', c: resolveTokens(staticNote.content, values) }] : []),
    ...(fetchX.skippedRange ? [{ type: 'warn', c: 'Range too large to enumerate automatically (limit of 8 addresses) — repeat fw fetchlogs manually per IP.' }] : []),
    ...(fetchX.truncated ? [{ type: 'warn', c: `Showing the first ${fetchList.length} IPs — repeat the command for the rest.` }] : []),
  ];
  return { lines };
};

RESOLVERS.conntable = function (row, values) {
  const { src_ip: src, dst_ip: dst } = values;
  const srcP = parseAddr(src), dstP = parseAddr(dst);
  const srcRes = combinedAddrRegex([srcP]);
  const dstRes = combinedAddrRegex([dstP]);
  const srcTerm = srcRes.regex || src;
  const dstTerm = dstRes.regex || dst;
  const notes = (srcRes.rangeTooLarge || dstRes.rangeTooLarge) ? [{ type: 'warn', c: RANGE_TOO_LARGE_NOTE }] : [];
  const subValues = Object.assign({}, values, { src_ip: srcTerm, dst_ip: dstTerm });
  const lines = [...dbLinesToTerm(row.lines.default, subValues), ...notes];
  return { lines };
};

RESOLVERS.nattable = function (row, values) {
  const { src_ip: src, dst_ip: dst } = values;
  const srcP = parseAddr(src), dstP = parseAddr(dst);
  const srcRes = combinedAddrRegex([srcP]);
  const dstRes = combinedAddrRegex([dstP]);
  const srcTerm = srcRes.regex || src;
  const dstTerm = dstRes.regex || dst;
  const notes = (srcRes.rangeTooLarge || dstRes.rangeTooLarge) ? [{ type: 'warn', c: RANGE_TOO_LARGE_NOTE }] : [];
  const subValues = Object.assign({}, values, { src_ip: srcTerm, dst_ip: dstTerm });
  const lines = [...dbLinesToTerm(row.lines.default, subValues), ...notes];
  return { lines };
};

RESOLVERS.routespecific = function (row, values) {
  const { dst_ip: dst } = values;
  const dstP = parseAddr(dst);
  const routeX = expandAddrDiscrete(dstP, 8, 5);
  const routeList = routeX.list.length ? routeX.list : (routeX.skippedRange ? [] : [dst]);
  const routeNotes = [];
  if (routeX.skippedRange) routeNotes.push({ type: 'warn', c: 'Range too large to enumerate automatically (limit of 8 addresses) — repeat ip route get manually per IP.' });
  if (routeX.truncated) routeNotes.push({ type: 'warn', c: `Showing the first ${routeList.length} IPs — repeat the command for the rest.` });
  const routeNetstatGrep = routeList.length ? `netstat -rn | grep ${markVar(routeList[0].split('.').slice(0, 3).join('.'))}` : 'netstat -rn';
  const dbLines = row.lines.default || [];
  const netstatNote = dbLines.find(l => l.line_type === 'note' && /netstat/.test(l.content || ''));
  const gaiaLines = dbLines.filter(l => l.prompt === '[Gaia]>');
  const lines = [
    ...(routeList.length
      ? routeList.flatMap(ip => [{ p: '[Expert@FW]#', c: `ip route get ${markVar(ip)}` }, { p: '[Expert@FW]#', c: `arp -n | grep ${markVar(ip)}` }])
      : [{ type: 'info', c: 'Fill in a valid destination IP, or a small list/range (up to 8 addresses), to generate the ip route get command(s).' }]),
    { p: '[Expert@FW]#', c: routeNetstatGrep },
    netstatNote ? { type: 'note', c: resolveTokens(netstatNote.content, values) } : null,
    ...gaiaLines.map(l => ({ p: l.prompt, c: resolveTokensMarked(l.content, values) })),
    ...routeNotes,
  ].filter(Boolean);
  return { lines };
};

RESOLVERS.fwaccelconns = function (row, values) {
  const { src_ip: src, dst_ip: dst } = values;
  const srcP = parseAddr(src), dstP = parseAddr(dst);
  const orRes = combinedAddrRegex([srcP, dstP]);
  const orRegexStr = orRes.regex || `${src}|${dst}`;
  const notes = orRes.rangeTooLarge ? [{ type: 'warn', c: RANGE_TOO_LARGE_NOTE }] : [];
  const fwaccelCmd = `fwaccel conns | grep -E "${markVar(orRegexStr)}"`;
  const staticNote = (row.lines.default || []).find(l => l.line_type === 'note');
  const lines = [
    { p: '[Expert@FW]#', c: fwaccelCmd },
    staticNote ? { type: 'note', c: resolveTokens(staticNote.content, values) } : null,
    ...notes,
  ].filter(Boolean);
  return { lines };
};

// ════════════════════════════════════════════════
// Row -> card() HTML
// ════════════════════════════════════════════════
// `details` substitui about.purpose/when/obs (campo único de rich text HTML,
// ver server/schema.sql e js/command-editor.js) — só precisa passar pelo
// resolveTokens() de {{ip}}/{{port}}/etc., igual ao texto plano de antes.
function resolveDetailsHtml(details, values) {
  return details ? resolveTokens(details, values) : '';
}

// Bloco "placeholder" usado por requires_ip_port (IP/Porta genéricos vazios)
// — mostra nome/desc/linhas alternativos quando o comando ainda não tem
// IP/Porta preenchidos.
function buildEmptyStateCard(row, values, detailsHtml) {
  const emptyLines = (row.lines && row.lines.empty) || [];
  if (!emptyLines.length) return null; // e.g. conntable/nattable/routespecific: card omitido inteiramente
  const name = (row.name_empty !== null && row.name_empty !== undefined && row.name_empty !== '') ? row.name_empty : row.name;
  const desc = (row.desc_empty !== null && row.desc_empty !== undefined && row.desc_empty !== '') ? row.desc_empty : row.desc;
  return card({
    id: row.id,
    name: resolveTokens(name, values),
    desc: resolveTokens(desc, values),
    details: detailsHtml,
    lines: dbLinesToTerm(emptyLines, values),
    folderIds: row.folder_ids,
    createdBy: row.created_by, modifiedBy: row.modified_by, updatedAt: row.updated_at, isSystem: row.is_system,
    vendors: row.vendors, systems: row.systems, versions: row.versions, environments: row.environments,
  });
}

function buildCardHtmlForRow(row, values, hasIPs) {
  const detailsHtml = resolveDetailsHtml(row.details, values);

  // IP/Porta genéricos (sem direção — ver query-bar.js): usados por comandos como
  // "host <IP> and port <PORT>" que não distinguem origem/destino, ao contrário de
  // SRC/DST. Gatilho independente de hasIPs, lido direto de values.ip/values.port.
  const hasIpPort = !!(values.ip && values.port);
  if (row.requires_ip_port && !hasIpPort) {
    return buildEmptyStateCard(row, values, detailsHtml);
  }

  let lines;
  const resolver = row.placeholder_resolver && RESOLVERS[row.placeholder_resolver];
  if (resolver && hasIPs) {
    const res = resolver(row, values);
    lines = res.lines;
  } else {
    lines = dbLinesToTerm(row.lines.default, values);
  }

  return card({
    id: row.id,
    name: resolveTokens(row.name, values),
    desc: resolveTokens(row.desc, values),
    details: detailsHtml, lines,
    folderIds: row.folder_ids,
    createdBy: row.created_by, modifiedBy: row.modified_by, updatedAt: row.updated_at, isSystem: row.is_system,
    vendors: row.vendors, systems: row.systems, versions: row.versions, environments: row.environments,
  });
}

// The 5 "🏗️ Ambiente: X" cards — pinned via row.environments to one specific
// environment each (topic='environment'), shown at the top of a combo block
// when that combo's environment matches.
function buildEnvCards(rows, ce, values) {
  return rows
    .filter(r => (r.topics || [r.topic]).includes('environment') && Array.isArray(r.environments) && r.environments.includes(ce))
    .map(r => buildCardHtmlForRow(r, values, true))
    .filter(Boolean);
}

// One topic section (icon + title + its cards), mirroring render.js's per-topic blocks.
// `key` (optional) gives the collapsible section a stable identity — see section() in
// terminal-renderer.js — needed so collapse state doesn't collide across stacked
// Versão/Ambiente combo blocks that repeat the same topic.
function buildTopicSection(rows, topic, icon, title, values, hasIPs, key) {
  // Um comando pode pertencer a mais de um Tópico (row.topics) — aparece em cada
  // seção correspondente. `row.topic` (singular) é o fallback para linhas antigas
  // que por algum motivo não tragam o array `topics` do backend.
  const cards = rows
    .filter(r => (r.topics || [r.topic]).includes(topic))
    .map(r => buildCardHtmlForRow(r, values, hasIPs))
    .filter(Boolean);
  return section(icon, title, cards, key);
}

// Envolve um item (card de comando/nota OU a seção HTML inteira de uma
// SUBPASTA) num ".folder-item-row" com alça de arrastar (⠿) — usado dentro
// de uma pasta do PRÓPRIO usuário (reordenar/mover na pasta de outra pessoa
// não é permitido pelo backend). Unifica o que antes eram dois mecanismos
// separados (wrapCardsForFolderDrag para cards + wrapFolderChildForDrag
// para subpastas) — pedido do usuário: "poder reordenar as subpastas entre
// os comandos e notas" e "arrastar comandos, notas e subpastas para dentro
// e fora da subpasta". Com os três tipos usando o MESMO wrapper, um único
// mecanismo de drag (ver _fldArmDrag/dragover/dragend em js/folders.js)
// resolve tanto reordenar (soltar entre irmãos do mesmo `containerId`)
// quanto mover entre pasta-mãe/subpasta (soltar num item de OUTRO
// container, ou diretamente no cabeçalho de uma subpasta — ver
// data-folder-header-id em buildFolderSectionFromCards abaixo).
// `containerId` = id da pasta cujo corpo contém esta row AGORA (pode mudar
// depois de um "mover"). `itemType`/`itemId` identificam o item (command_id
// é string; note/folder id são number). `rootFolderId` é o id da pasta de
// TOPO da árvore inteira — usado só pra IMPEDIR que o drag solte um item
// fora dela (pedido do usuário: "a subpastas e seus itens não podem sair da
// pasta pai"), nunca muda entre pai/filhas da mesma árvore.
function wrapItemForFolderDrag(html, containerId, itemType, itemId, rootFolderId) {
  return `<div class="folder-item-row" data-container-id="${containerId}" data-item-type="${itemType}" data-item-id="${itemId}" data-root-folder-id="${rootFolderId}">
    <span class="folder-drag-handle" onmousedown="_fldArmDrag(this)" title="Drag to reorder">⠿</span>
    <div class="folder-item-row-body">${html}</div>
  </div>`;
}

// Card de uma NOTE (task Notes) — 3º redesign (pedido: "ajuste para que a
// edição de nota na pasta Folders seja feita na mesma tela, sem abrir o
// popup"). Continua um bloco ÚNICO (sem cabeçalho/título separado) com fundo
// branco/cinza igual ao comando (var(--surf), sem borda visível) — a
// diferença agora é que o PRÓPRIO card alterna entre visualização e edição,
// em vez de abrir um modal (#noteEditorOverlay, removido de index.html).
// A "descrição" É o próprio conteúdo (HTML já sanitizado no servidor — ver
// sanitizeNoteHtml em server/index.js — então pode ser inserido cru aqui,
// inclusive <img> coladas/redimensionadas e <span style="..."> de tamanho de
// fonte/cor/alinhamento, todos aplicados pela barra de formatação do editor
// — ver neExec/neSetFontSize/neSetColor em js/folders.js).
// `note.title` (campo do banco, ver schema.sql) não é mostrado na tela —
// é só um resumo em texto puro derivado automaticamente do conteúdo (ver
// _deriveNoteTitle em js/folders.js), mantido só pra mensagens internas
// (confirmação de exclusão, sufixo " (copy)" ao clonar).
// `ownFolder` (= withActions da seção que contém a nota, sempre verdadeiro
// quando é uma pasta do usuário atual e falso quando é de outro usuário)
// decide se aparecem os botões de clonar/editar — uma nota só pode ser
// alterada por quem a escreveu, e como uma nota só existe dentro de uma
// pasta que já é sua (não há como criar nota na pasta de outra pessoa), a
// posse da PASTA já equivale à posse da nota — não precisa comparar
// note.username com CURRENT_USER separadamente.
// `editing` (novo): quando true, renderiza o template de EDIÇÃO em vez do de
// visualização — controlado por NOTE_EDIT_MODE (notas existentes) ou por
// NOTE_CREATE_FOLDER_ID (nota nova, ver js/folders.js). Uma nota "nova" (uso
// interno, só existe no cliente até o primeiro Accept) é representada por um
// objeto `note` com `id: null` e `folder_id` preenchido — chamado
// diretamente por buildFolderSectionFromCards quando NOTE_CREATE_FOLDER_ID
// bate com a pasta sendo montada.
// Excluir (pedido: "exiba o botão de excluir nota somente quando estiver
// editando. Faça igual a edição de pastas com os mesmos botões") só aparece
// dentro do modo de edição, reaproveitando as MESMAS classes .sec-folder-
// pill-btn/.pill-accept/.pill-cancel/.pill-delete já usadas na edição de
// pastas (ver buildFolderSectionFromCards abaixo) — fora dele, só
// Clonar/Editar (mini-toolbar flutuante, hover — ver .note-flat-actions em
// components.css).
function buildNoteCardHtml(note, ownFolder, editing) {
  if (!note) return '';
  const isNew = note.id == null;
  const jsEsc = typeof jsAttrEscapeCmdSearch === 'function' ? jsAttrEscapeCmdSearch(note.title || '') : escAttr(note.title || '');

  if (editing) {
    // Rascunho local (ver NOTE_EDIT_DRAFTS em js/folders.js) tem prioridade
    // sobre note.description — preserva o que o usuário já digitou/formatou
    // caso um render() por outro motivo (busca, outra pasta etc.) reconstrua
    // este card enquanto ele ainda está editando (sem isso, o texto digitado
    // seria perdido no meio da edição).
    const draftKey = isNew ? `create:${note.folder_id}` : `edit:${note.id}`;
    const liveDescription = (typeof NOTE_EDIT_DRAFTS !== 'undefined' && Object.prototype.hasOwnProperty.call(NOTE_EDIT_DRAFTS, draftKey))
      ? NOTE_EDIT_DRAFTS[draftKey]
      : (note.description || '');
    const editorId = isNew ? `noteEditorNew_${note.folder_id}` : `noteEditorEdit_${note.id}`;
    const acceptArg = isNew ? 'null' : note.id;
    const cancelArg = isNew ? 'null' : note.id;
    const deleteBtn = !isNew
      ? `<button type="button" class="sec-folder-pill-btn pill-delete" onmousedown="event.preventDefault()" onclick="deleteNoteConfirm(${note.id}, '${jsEsc}', event)" title="Delete note">✕ Delete Note</button>`
      : '';
    // Ordem alfabética (pelo nome em inglês do title/tooltip, mesmo idioma
    // do resto da UI): Black, Blue, Green, Red, Yellow — pedido do usuário:
    // "na opções de cores deixe apenas preto, verde, azul, amarela e
    // vermelha em ordem alfabética" (5 cores fixas, não mais paleta livre).
    const colorSwatches = [
      ['#000000', 'Black'], ['#1565c0', 'Blue'], ['#2e7d32', 'Green'],
      ['#c62828', 'Red'], ['#f9a825', 'Yellow'],
    ].map(([hex, label]) => `<button type="button" class="ne-fmt-color-swatch" data-color="${hex}" style="background:${hex}" onmousedown="event.preventDefault()" onclick="neSetColor(this, '${hex}')" title="${label}"></button>`).join('');
    return `<div class="card" data-note-id="${note.id || ''}" data-note-editing="1">
      <div class="note-edit-head">
        <span class="note-edit-label">${isNew ? 'New note' : 'Editing note'}</span>
        <span class="note-edit-actions">
          <button type="button" class="sec-folder-pill-btn pill-accept" onmousedown="event.preventDefault()" onclick="acceptNoteEdit(${acceptArg}, ${note.folder_id}, event)" title="Save note">✓ Accept</button>
          <button type="button" class="sec-folder-pill-btn pill-cancel" onmousedown="event.preventDefault()" onclick="cancelNoteEdit(${cancelArg}, ${note.folder_id}, event)" title="Discard changes">✕ Cancel</button>
          ${deleteBtn}
        </span>
      </div>
      <div class="note-flat-body note-flat-body-editing">
        <div class="note-editor-toolbar">
          <button type="button" class="ne-fmt-btn" data-ne-cmd="bold" onmousedown="event.preventDefault()" onclick="neExec(this, 'bold')" title="Bold (Ctrl+B)"><b>B</b></button>
          <button type="button" class="ne-fmt-btn" data-ne-cmd="italic" onmousedown="event.preventDefault()" onclick="neExec(this, 'italic')" title="Italic (Ctrl+I)"><i>I</i></button>
          <button type="button" class="ne-fmt-btn" data-ne-cmd="underline" onmousedown="event.preventDefault()" onclick="neExec(this, 'underline')" title="Underline (Ctrl+U)"><u>U</u></button>
          <span class="ne-fmt-sep"></span>
          <!-- Tamanho/cor em dropdown — mesmo padrão do Details do editor de
               comandos (ver index.html/.ne-fmt-dd), pedido do usuário: "deixar
               o menu de formatação em notes de folder igual dos comandos".
               Sem id fixo (diferente do #cmdDetailsFontSizeLabel do Details):
               pode haver vários editores de nota abertos ao mesmo tempo, e
               _neToggleFmtDropdown/neSetFontSize/neSetColor/
               _neUpdateToolbarState (js/folders.js) já resolvem tudo via
               closest()/querySelector() a partir do próprio editor, sem
               precisar de id. -->
          <span class="ne-fmt-dd">
            <button type="button" class="ne-fmt-dd-btn" onmousedown="event.preventDefault()" onclick="_neToggleFmtDropdown(this)" title="Font size">
              <span class="ne-fmt-dd-btn-label">12</span><span class="ne-fmt-dd-arrow">▾</span>
            </button>
            <span class="ne-fmt-dd-panel ne-fmt-dd-panel-sizes">
              <button type="button" class="ne-fmt-size-opt" data-size="8" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 8)">8</button>
              <button type="button" class="ne-fmt-size-opt" data-size="9" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 9)">9</button>
              <button type="button" class="ne-fmt-size-opt" data-size="10" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 10)">10</button>
              <button type="button" class="ne-fmt-size-opt" data-size="11" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 11)">11</button>
              <button type="button" class="ne-fmt-size-opt on" data-size="12" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 12)">12</button>
              <button type="button" class="ne-fmt-size-opt" data-size="14" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 14)">14</button>
              <button type="button" class="ne-fmt-size-opt" data-size="16" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 16)">16</button>
              <button type="button" class="ne-fmt-size-opt" data-size="18" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 18)">18</button>
              <button type="button" class="ne-fmt-size-opt" data-size="20" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 20)">20</button>
              <button type="button" class="ne-fmt-size-opt" data-size="22" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 22)">22</button>
              <button type="button" class="ne-fmt-size-opt" data-size="24" onmousedown="event.preventDefault()" onclick="neSetFontSize(this, 24)">24</button>
            </span>
          </span>
          <span class="ne-fmt-dd">
            <button type="button" class="ne-fmt-dd-btn" onmousedown="event.preventDefault()" onclick="_neToggleFmtDropdown(this)" title="Text color">
              <span class="ne-fmt-color-trigger-swatch" style="background:#000000"></span><span class="ne-fmt-dd-arrow">▾</span>
            </button>
            <span class="ne-fmt-dd-panel ne-fmt-dd-panel-colors">${colorSwatches}</span>
          </span>
          <span class="ne-fmt-sep"></span>
          <button type="button" class="ne-fmt-btn" data-ne-cmd="justifyLeft" onmousedown="event.preventDefault()" onclick="neExec(this, 'justifyLeft')" title="Align left">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M1 3h14M1 7h9M1 11h14M1 15h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
          <button type="button" class="ne-fmt-btn" data-ne-cmd="justifyCenter" onmousedown="event.preventDefault()" onclick="neExec(this, 'justifyCenter')" title="Align center">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M1 3h14M3.5 7h9M1 11h14M3.5 15h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
          <button type="button" class="ne-fmt-btn" data-ne-cmd="justifyRight" onmousedown="event.preventDefault()" onclick="neExec(this, 'justifyRight')" title="Align right">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M1 3h14M6 7h9M1 11h14M6 15h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
          <span class="ne-fmt-sep"></span>
          <!-- Inserir link — mesmo botão/mecânica do Details do editor de
               comandos (ver index.html + neInsertLink em js/folders.js). -->
          <button type="button" class="ne-fmt-btn" onmousedown="event.preventDefault()" onclick="neInsertLink(this)" title="Insert link">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6.5 9.5l3-3M7 4.5l1.3-1.3a2.6 2.6 0 013.7 3.7L10.5 8M9 11.5l-1.3 1.3a2.6 2.6 0 01-3.7-3.7L5.5 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div class="note-editor-body" id="${editorId}" data-note-draft-key="${draftKey}" contenteditable="true" data-placeholder="Write the note here — select text to format it, paste an image (Ctrl+V) to attach it.">${liveDescription}</div>
      </div>
    </div>`;
  }

  const actions = ownFolder ? `<span class="note-flat-actions">
    <button type="button" class="edit-btn" onclick="cloneNote(${note.id}, event)" title="Clone note">
      <svg width="11" height="11" fill="none" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="9" height="9" rx="1.3" stroke="currentColor" stroke-width="1.4"/><path d="M3.2 10.5H2.3a.8.8 0 01-.8-.8v-7A.8.8 0 012.3 2h7a.8.8 0 01.8.8v.9" stroke="currentColor" stroke-width="1.4"/></svg>
    </button>
    <button type="button" class="edit-btn" onclick="startEditNote(${note.id}, event)" title="Edit note">
      <svg width="11" height="11" fill="none" viewBox="0 0 16 16"><path d="M11.3 1.7l3 3L5 14H2v-3l9.3-9.3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
    </button>
  </span>` : '';
  const content = (note.description || '').trim()
    ? note.description
    : '<span class="note-flat-empty">(empty note)</span>';
  // `class="card"` SEM sufixo próprio de propósito — várias contagens de
  // cards pela tela inteira (ver render.js: cardCount) casam com o texto
  // EXATO `<div class="card"` via regex; um classname extra aqui (ex.:
  // "card note-flat") quebraria esse match (a regex não acha a aspa de
  // fechamento logo depois de "card"), fazendo notas sumirem da contagem e,
  // em casos de pasta só com notas, a seção inteira sumir (cardCount==0).
  // O visual (ver .card[data-note-id] em components.css) é aplicado via
  // atributo `[data-note-id]`, não via classe extra — já dá seletor
  // específico o bastante sem mexer na classe.
  // `data-note-id` (em vez de data-cmd-id) também já é suficiente pra
  // distinguir nota de comando em qualquer seletor/handler que precise (ver
  // wrapItemForFolderDrag/_fldArmDrag em js/folders.js).
  return `<div class="card" data-note-id="${note.id}">
    ${actions}
    <div class="note-flat-body">${content}</div>
  </div>`;
}

// Intercala comandos, notes E SUBPASTAS de UMA pasta na ordem combinada que
// o usuário definiu — `orderTagged` é o array {type:'command'|'note'|
// 'folder', id} que o servidor já devolve pronto (ver
// loadFolderOrderAndNotes em server/index.js, e folder.order em
// js/folders.js) — subpastas entraram nessa MESMA escala a pedido do
// usuário: "a posição inicial da subpasta deve ser logo abaixo da pasta
// pai" e "poder reordenar as subpastas entre os comandos e notas". Itens
// sem posição salva (comando/nota/subpasta nova, ou pasta antiga de antes
// desta feature) vão pro FIM, nunca desaparecem — mesmo critério que já
// existia só para comandos/notas antes desta mudança.
// `cmdById`/`notesById` são Maps já filtrados para o conteúdo desta pasta
// especificamente (quem chama decide o que entra); `childSectionById` é um
// Map<folderId, htmlDaSeçãoJáMontada> das subpastas DIRETAS desta pasta
// (montadas recursivamente por quem chama — ver renderFolderNode em
// js/render.js). Devolve objetos {type, id, html} (não só a string) — quem
// chama (buildFolderSectionFromCards) precisa do type/id pra embrulhar cada
// item com wrapItemForFolderDrag.
function buildFolderItemsCards(cmdById, notesById, childSectionById, orderTagged, values, hasIPs, ownFolder) {
  const seenCmd = new Set(), seenNote = new Set(), seenFolder = new Set();
  (orderTagged || []).forEach(o => {
    if (!o) return;
    if (o.type === 'note') seenNote.add(o.id);
    else if (o.type === 'folder') seenFolder.add(o.id);
    else seenCmd.add(o.id);
  });
  const extra = [
    ...[...cmdById.keys()].filter(id => !seenCmd.has(id)).map(id => ({ type: 'command', id })),
    ...[...notesById.keys()].filter(id => !seenNote.has(id)).map(id => ({ type: 'note', id })),
    ...[...(childSectionById ? childSectionById.keys() : [])].filter(id => !seenFolder.has(id)).map(id => ({ type: 'folder', id })),
  ];
  const finalOrder = (orderTagged || [])
    .filter(o => o && (
      o.type === 'note' ? notesById.has(o.id) :
      o.type === 'folder' ? !!(childSectionById && childSectionById.has(o.id)) :
      cmdById.has(o.id)
    ))
    .concat(extra);
  return finalOrder.map(o => {
    let html;
    if (o.type === 'note') html = buildNoteCardHtml(notesById.get(o.id), ownFolder, NOTE_EDIT_MODE.has(o.id));
    else if (o.type === 'folder') html = childSectionById.get(o.id);
    else html = buildCardHtmlForRow(cmdById.get(o.id), values, hasIPs);
    return html ? { type: o.type, id: o.id, html } : null;
  }).filter(Boolean);
}

// Cabeçalho + corpo de uma seção de PASTA a partir de uma lista de CARDS já
// prontos (comando OU nota — não filtra por folder_ids, quem chama já
// decidiu quais cards entram, e em que ORDEM). Extraído de
// buildFolderSection() para ser reaproveitado também pelo Group by "User
// folders" (cross-user, ver render.js) e pelo novo seletor de escopo de
// pastas dentro de Folders ("My folders" / escolher usuário / "All"), que
// montam os cards de uma pasta de OUTRO usuário a partir de
// ALL_USERS_FOLDERS em vez de folder_ids (que só reflete as pastas do
// usuário atual — ver server/index.js: shapeCommand()). `folderName` é
// texto livre cadastrado pelo usuário — passa por escAttr() antes de virar
// título (inserido como HTML cru) para não permitir HTML injection via nome
// de pasta malicioso.
// `withActions` controla se aparece o botão único "Edit folder" (task
// #463 — consolida o antigo trio ⇕/✎/✕ num só) e o botão "+ Add note" —
// só fazem sentido numa pasta que pertence ao usuário atual (o backend
// recusa as operações numa pasta de outra pessoa, e nem deixa criar nota
// fora da própria pasta). `copyable` (task #459) mostra em vez disso um
// único botão de copiar a pasta — usado quando é a pasta de OUTRO usuário;
// nunca junto com withActions. Notas de outro usuário aparecem no corpo
// (buildFolderItemsCards já foi chamado com ownFolder=false por quem monta
// `cards`), só que sem NENHUM botão de ação — ver buildNoteCardHtml.
// `editMode` (task #461/#463, restrito à raiz numa task posterior — "a
// edição de subpastas e ordem dos comandos e notas deve ficar somente na
// pasta pai") — só dentro desse modo (toggle "✎ Edit folder", que só existe
// no cabeçalho da RAIZ da árvore, depth 0 — ver `editBtn` abaixo) é que: (a)
// os cards E subpastas ficam arrastáveis em qualquer profundidade
// (embrulhados em .folder-item-row, ver wrapItemForFolderDrag), e (b)
// aparece Excluir/nome editável em qualquer profundidade. Fora desse modo,
// mesmo numa pasta própria, a seção mostra só os cards + os botões sempre
// visíveis (✎ Edit, só na raiz / + Add) — arrastar/excluir por acidente não
// deveria ser possível sem o usuário ter entrado deliberadamente no modo de
// edição. Quem chama (renderFolderNode em js/render.js) já resolve o valor
// de `editMode` como o estado da RAIZ, replicado sem mudança pra toda a
// árvore abaixo dela — uma subpasta nunca liga/desliga esse modo sozinha.
//
// Layout do cabeçalho (a pedido do usuário, ver mockup/print anexado): o
// botão de editar é um lápis (✎, antes uma engrenagem ⚙) um pouco maior que
// os demais (.sec-folder-edit-btn); Excluir usa o mesmo componente visual
// "tag" vermelha dos badges dos comandos (.tag.t-red) em vez de um ícone
// discreto, pra deixar a ação destrutiva mais chamativa; e o botão do canto
// direito (+ Add note na pasta própria, ⧉ Copy na de outro usuário) fica
// encostado na borda direita do cabeçalho — igual ao botão sólido "Add" da
// toolbar principal — separado dos botões da esquerda por um divisor
// explícito (`.sec-title-divider`, substitui o ::after padrão de
// `.sec-title` só nas seções de pasta, ver `.section-folder` em
// components.css) em vez de ficar espremido do lado do nome/contagem.
// `items` (comandos + notas + subpastas, TODOS já intercalados na ordem
// certa — ver buildFolderItemsCards acima): array de {type, id, html}.
// `depth` (0 = pasta de topo) só controla a indentação visual (margin-left
// inline — ver o wrapper abaixo), simples o bastante pra funcionar em
// qualquer profundidade sem precisar de uma classe CSS por nível.
// `rootFolderId` (opcional, default = o próprio folderId — usado quando
// ESTA seção É a raiz) identifica a pasta de TOPO da árvore inteira, pra
// que o mecanismo de drag (_fldArmDrag/js/folders.js) recuse soltar um item
// fora dela (pedido do usuário: "a subpastas e seus itens não podem sair da
// pasta pai").
function buildFolderSectionFromCards(items, folderId, folderName, key, withActions, copyable, editMode, depth, rootFolderId) {
  items = items || [];
  depth = depth || 0;
  rootFolderId = rootFolderId || folderId;
  // Pastas do próprio usuário (withActions) SEMPRE aparecem, mesmo vazias
  // (0 comandos, 0 notas, 0 subpastas) — antes voltavam '' e a pasta recém-
  // criada simplesmente não aparecia em lugar nenhum até o usuário
  // adicionar algo a ela, o que parecia um bug ("criei a pasta e ela não
  // aparece"). Pastas de OUTRO usuário (copyable, só leitura) continuam
  // escondidas quando vazias — não haveria nada útil pra fazer com elas ali.
  if (!items.length && !withActions) return '';
  const nameEsc = escAttr(folderName);
  const jsEsc = typeof jsAttrEscapeCmdSearch === 'function' ? jsAttrEscapeCmdSearch(folderName) : nameEsc;

  // "Favorites" é a pasta padrão criada automaticamente pra todo usuário
  // (ver ensureDefaultFolder() em server/index.js) — pedido do usuário: "a
  // pasta Favorites do sistema não pode ser alterada o nome nem excluída".
  // Continua podendo entrar em modo de edição pra reordenar comandos/notas
  // dentro dela (drag-and-drop); só o campo de nome (nameHtml abaixo) e o
  // botão ✕ Delete ficam suprimidos. O servidor recusa com 403 mesmo que
  // essa checagem de UI seja contornada (ver PUT/DELETE /api/folders/:id em
  // server/index.js, FAVORITES_FOLDER_NAME).
  const isFavorites = withActions && folderName === 'Favorites';

  // Pedido do usuário: "a edição de subpastas e ordem dos comandos e notas
  // deve ficar somente na pasta pai". Antes, CADA pasta (raiz ou subpasta,
  // qualquer profundidade) tinha seu próprio botão ✎ e seu próprio estado em
  // FOLDER_EDIT_MODE — dava pra entrar/sair do modo de edição de uma
  // subpasta independente da pasta-mãe. Agora só a RAIZ (depth 0) mostra o
  // botão ✎ — `editMode`, recebido de quem chama (ver renderFolderNode em
  // js/render.js), já vem como o estado da RAIZ da árvore inteira, replicado
  // sem mudança pra todas as subpastas abaixo dela (nunca mais lido por
  // FOLDER_EDIT_MODE.has(id-da-subpasta)). Isso faz o modo de edição ligar/
  // desligar em bloco para a árvore toda de uma vez: quando a raiz entra em
  // edição, TODAS as subpastas abaixo também mostram nome editável e ✕
  // Delete (linhas abaixo, que continuam olhando só pra `editMode`, sem
  // checar depth) e seus itens ficam arrastáveis (ver `active` mais abaixo)
  // — mas nenhuma subpasta tem um botão próprio pra ligar/desligar isso.
  // Pedido do usuário (com print do cabeçalho atual): "vamos ajustar esses
  // botões durante a edição de pastas. deixe um botão para Accept, Cancel e
  // Delete Folder. deixe os botões no mesmo estilo atual do botão delete."
  // Fora do modo de edição, a RAIZ mostra só o ✎ (entra no modo). DENTRO do
  // modo de edição, o ✎ dá lugar a dois botões — "✓ Accept" e "✕ Cancel" —
  // ambos no mesmo componente visual "pill" do Delete (.sec-folder-pill-btn,
  // ver css/components.css), só com cor diferente por modificador
  // (.pill-accept/.pill-cancel). Os dois só chamam toggleFolderEditMode
  // pra sair do modo de edição — não existe "desfazer" de verdade porque
  // renomear (blur/Enter) e reordenar (drag) já salvam ao vivo, sem nenhum
  // estado pendente pra descartar; a distinção Accept/Cancel é só pra dar
  // uma saída clara e não deixar um único botão ambíguo (era um "✎"/"Done
  // editing" só, meio escondido). Só existem na RAIZ (depth 0), igual o ✎
  // que substituem.
  const editControls = (withActions && depth === 0)
    ? (editMode
        ? `<button type="button" class="sec-folder-pill-btn pill-accept" onmousedown="event.preventDefault()" onclick="toggleFolderEditMode(${folderId}, event)" title="Accept and finish editing">✓ Accept</button>`
          + `<button type="button" class="sec-folder-pill-btn pill-cancel" onmousedown="event.preventDefault()" onclick="toggleFolderEditMode(${folderId}, event)" title="Cancel editing">✕ Cancel</button>`
        : `<button type="button" class="sec-folder-btn sec-folder-edit-btn" onmousedown="event.preventDefault()" onclick="toggleFolderEditMode(${folderId}, event)" title="Edit folder">✎</button>`)
    : '';
  // Delete Folder continua em QUALQUER profundidade (cada subpasta exclui só
  // a si mesma — herda editMode da raiz, mas não o botão Accept/Cancel
  // acima, que só existe nela); mesmo componente .sec-folder-pill-btn,
  // modificador .pill-delete (cores iguais ao antigo .sec-folder-delete-btn).
  const deleteTag = (withActions && editMode && !isFavorites)
    ? `<button type="button" class="sec-folder-pill-btn pill-delete" onmousedown="event.preventDefault()" onclick="deleteFolderConfirm(${folderId}, '${jsEsc}', event)" title="Delete folder">✕ Delete Folder</button>`
    : '';
  const leftActions = (editControls || deleteTag) ? `<span class="sec-folder-actions">${editControls}${deleteTag}</span>` : '';

  // "+ Add note" voltou pro cabeçalho (2º giro: tinha saído pro corpo da
  // seção por ser pouco visível como botão pequeno "+" no canto — virou um
  // botão de linha inteira ABAIXO do nome; pedido mais recente do usuário:
  // "mover o botão de add note para o final da linha, na mesma direção do
  // add" — ou seja, de volta ao cabeçalho, colado na borda direita, igual
  // ⧉ Copy/posição do botão "Add" da toolbar principal). Fica no canto
  // direito do cabeçalho (rightAction), empurrado até a borda pelo mesmo
  // divisor explícito (.sec-title-divider) que já separava ✎ Edit/✕ Delete
  // de ⧉ Copy — nunca aparece junto com ⧉ Copy (mutuamente exclusivos:
  // withActions é sempre a pasta PRÓPRIA, copyable é sempre a de OUTRO
  // usuário). "Cores invertidas do Add conforme cada tema" (outro pedido
  // do usuário): o Add da toolbar é sólido (fundo --teal cheio, texto
  // branco — ver .ctb-cmd-btn.admin-highlight em layout.css); este aqui usa
  // o padrão "tintado" oposto (fundo --teal-bg translúcido, texto e borda
  // --teal) — mesma cor de destaque em ambos, só com fundo/texto trocados,
  // e já correto em claro/escuro porque --teal-bg é um rgba() sobre --teal
  // (não uma cor fixa) — ver .sec-folder-add-btn em components.css.
  //
  // 3º giro (subpastas): virou de novo um dropdown — igual ao "Add" da
  // toolbar principal (#addDD/#addDDPanel em index.html), MESMO componente
  // .dd/.dd-panel/.sb-row (toggleDropdown/closeAllDropdowns em js/state.js,
  // sem JS novo) — oferecendo "Note" (o que já existia) e a opção nova
  // "Subfolder" (promptCreateSubfolder(), js/folders.js). O id do dropdown
  // precisa ser único por pasta (várias seções de pasta na mesma tela ao
  // mesmo tempo) — usa o próprio folderId.
  let rightAction = '';
  if (withActions) {
    const addDdId = `addDD-folder-${folderId}`;
    rightAction = `<div class="dd sec-folder-add-dd" id="${addDdId}">
      <button type="button" class="btn sec-folder-add-btn" onmousedown="event.preventDefault()" onclick="event.stopPropagation(); toggleDropdown('${addDdId}')">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <span>Add</span><span class="dd-arrow">▾</span>
      </button>
      <div class="dd-panel" id="${addDdId}Panel">
        <div class="sb-row" onclick="event.stopPropagation(); closeAllDropdowns(); startCreateNote(${folderId}, event)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          <span>Note</span>
        </div>
        <div class="sb-row" onclick="event.stopPropagation(); closeAllDropdowns(); promptCreateSubfolder(${folderId})">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" style="flex-shrink:0;"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.2h8.5A1.5 1.5 0 0 1 21 8.7v9.8A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5v-12z"/></svg>
          <span>Subfolder</span>
        </div>
      </div>
    </div>`;
  } else if (copyable) {
    rightAction = `<button type="button" class="sec-folder-btn" onmousedown="event.preventDefault()" onclick="copyFolderFromUser(${folderId}, '${jsEsc}', event)" title="Copy this folder to your own Folders">⧉</button>`;
  }
  const divider = (leftActions || rightAction) ? '<span class="sec-title-divider"></span>' : '';

  // Dentro do modo de edição, o nome deixa de ser texto estático e passa a
  // ser um <input> editável direto no cabeçalho (em vez de precisar clicar
  // num botão "✎ Rename" que abria um modal — ver _folderNameInputBlur/
  // _folderNameInputKeydown em js/folders.js). onclick/onmousedown
  // stopPropagation() evita que o clique pra focar o campo dispare o
  // toggle de recolher/expandir da seção (.sec-title tem
  // onclick="toggleSection(...)" — ver collapsibleGroup em
  // terminal-renderer.js). Enter salva (blur), Escape cancela e reverte.
  const nameHtml = (withActions && editMode && !isFavorites)
    ? `<input type="text" class="sec-folder-name-input" value="${nameEsc}" data-folder-id="${folderId}" onclick="event.stopPropagation()" onmousedown="event.stopPropagation()" onkeydown="_folderNameInputKeydown(event)" onblur="_folderNameInputBlur(event)">`
    : nameEsc;
  // Contagem no cabeçalho: só comandos/notas PRÓPRIOS desta pasta (não conta
  // subpastas — cada subpasta já mostra a contagem dela própria no cabeçalho
  // dela, contar de novo aqui ficaria redundante/confuso).
  const cardCount = items.filter(it => it.type !== 'folder').length;
  const headerHtml = `${folderIcon(true, 12)} ${nameHtml} <span class="sec-count">${cardCount}</span>${leftActions}${divider}${rightAction}`;
  // Rascunho de nota NOVA em edição (startCreateNote, ver js/folders.js) —
  // não é um item de `items` (não existe no servidor ainda, não tem posição
  // em folder.order) — entra sempre no TOPO do corpo, fora do mecanismo de
  // drag (uma nota que ainda não foi salva não tem o que reordenar).
  const draftNoteHtml = (withActions && NOTE_CREATE_FOLDER_ID === folderId)
    ? buildNoteCardHtml({ id: null, folder_id: folderId, description: '' }, true, true)
    : '';
  // Pasta própria recém-criada, ainda sem nenhum comando/nota/subpasta —
  // mostra um aviso discreto em vez de deixar o corpo da seção parecendo
  // vazio/quebrado (o botão "+ Add" agora mora no cabeçalho, não mais aqui
  // no corpo). Não mostra esse aviso quando já existe um rascunho de nota
  // nova ocupando o corpo (draftNoteHtml) — mostrar "Empty folder." ao lado
  // do editor de uma nota que o próprio usuário acabou de abrir ficaria
  // contraditório.
  const emptyMsg = (withActions && !items.length && !draftNoteHtml)
    ? `<p class="sec-folder-empty-msg">Empty folder.</p>`
    : '';
  const active = withActions && editMode;
  const body = draftNoteHtml + emptyMsg + items.map(it => active
    ? wrapItemForFolderDrag(it.html, folderId, it.type, it.id, rootFolderId)
    : it.html
  ).join('');
  // Indentação por profundidade (subpastas, aninhamento ilimitado) — inline
  // em vez de uma classe CSS por nível, já que a profundidade não tem limite
  // fixo. depth=0 (pasta de topo) não recebe margin extra, mas TODAS as
  // profundidades ganham os atributos data-folder-id/data-folder-header-id/
  // data-folder-body-id abaixo — o mecanismo de drag (js/folders.js) precisa
  // deles tanto pra soltar DENTRO de uma subpasta (via o cabeçalho ou o
  // corpo dela) quanto pra soltar de volta na pasta-mãe (que pode ser a
  // própria raiz, depth 0).
  const style = depth > 0 ? ` style="margin-left:${depth * 18}px"` : '';
  const extraClass = active ? 'section-folder section-editing' : 'section-folder';
  let html = collapsibleGroup(key || `folder${folderId}`, headerHtml, body, extraClass);
  // `data-root-folder-id` também vai no próprio wrapper da seção (não só nos
  // itens dentro dela) — necessário pro drag detectar a raiz mesmo quando o
  // alvo é o CABEÇALHO da seção raiz (depth 0), que não está dentro de
  // nenhum .folder-item-row (só itens ANINHADOS ficam dentro de um).
  html = html.replace('<div class="section', `<div data-folder-id="${folderId}" data-root-folder-id="${rootFolderId}"${style} class="section`);
  html = html.replace('<div class="sec-title">', `<div class="sec-title" data-folder-header-id="${folderId}">`);
  html = html.replace('<div class="sec-body">', `<div class="sec-body" data-folder-body-id="${folderId}">`);
  return html;
}

// Uma seção de PASTA do usuário ATUAL (ícone de pasta + nome + seus
// comandos/notas) — mesmo papel de buildTopicSection acima, só que
// agrupando pela pasta do usuário (ver js/folders.js) em vez de um Tópico
// do catálogo. Usada quando a visão atual é Folders (VIEW_FOLDERS_HOME, ver
// render.js) com o escopo "My folders", para que cada pasta apareça como
// uma seção recolhível no mesmo estilo visual dos Tópicos.
//
// `notes` (task Notes, opcional): array de notas da pasta (folder.notes, ver
// js/folders.js). `order` (opcional, task #458, estendido pela task Notes):
// array combinado {type,id} na ordem própria da pasta (folder.order) — ver
// buildFolderItemsCards acima para os detalhes de fallback.
//
// A sidebar não lista mais as pastas individualmente (só o item combinado
// "Folders" — a pedido do usuário), então renomear/excluir/reordenar uma
// pasta só é possível aqui: os botões (+ / ⚙ sempre, ✎ / ✕ só em modo de
// edição) embutidos no próprio cabeçalho da seção (ver
// buildFolderSectionFromCards acima), visíveis só no hover (exceto ⚙
// quando já ativo — ver .section-editing em components.css).
// `editMode` (task #461/#463, opcional): repassado direto pra
// buildFolderSectionFromCards — ver comentário lá. `childSectionById`/
// `depth`/`rootFolderId` (subpastas, opcionais): idem, ver comentário em
// buildFolderItemsCards/buildFolderSectionFromCards.
function buildFolderSection(rows, folderId, folderName, values, hasIPs, key, notes, order, editMode, childSectionById, depth, rootFolderId) {
  const cmdById = new Map(rows.filter(r => (r.folder_ids || []).includes(folderId)).map(r => [r.id, r]));
  const notesById = new Map((notes || []).map(n => [n.id, n]));
  const items = buildFolderItemsCards(cmdById, notesById, childSectionById, order, values, hasIPs, true);
  return buildFolderSectionFromCards(items, folderId, folderName, key, true, false, editMode, depth, rootFolderId);
}
