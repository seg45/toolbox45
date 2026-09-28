// Suite de validação manual (Playwright) da Fase 3, fatia 3c (Comandos
// avançados / RESOLVERS + net-utils) — mesmo padrão de mocking de /api/*
// usado em test/login.spec.mjs, test/appshell.spec.mjs, test/commands.spec.mjs
// e test/querybar.spec.mjs.
//
// Nota de escopo: `values.proto`/`values.iface` não são alimentados por
// nenhum input na UI desta fatia (campos "mortos", preexistentes — ver
// instruções da fatia). O ramo de tcpdump que decide " and tcp"/"udp"/"icmp"
// a partir de `proto` e o `-i <iface>` de fwmonitor/tcpdump por isso não são
// exercitáveis via interação real na UI aqui; essa parte da lógica foi
// validada separadamente com chamadas diretas às funções de netUtils.ts/
// resolvers.ts fora do browser (ver relatório da fatia). Os cenários abaixo
// cobrem tudo que É alimentável via QueryBar (src_ip/dst_ip/src_port/dst_port)
// e via o toggle "Export" da sidebar (FL.log).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = 'http://localhost:4173';
const SHOTS = '/tmp/fase3-fatia3c-shots';
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('FALHOU:', msg);
  } else {
    console.log('ok:', msg);
  }
}

async function assertEventually(fn, msg, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) {
      assert(true, msg);
      return;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  assert(false, msg);
}

async function withPage(browser, fn, opts = {}) {
  const ctx = await browser.newContext();
  if (opts.clipboard) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  }
  const page = await ctx.newPage();
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}

// ════════════════════════════════════════════════
// FIXTURES
// ════════════════════════════════════════════════
const CATALOGS = {
  vendors: [],
  systems: [],
  versions: [],
  environments: [],
  topics: [{ key: 'advanced', label: 'Advanced', color: '#A78BFA', sort_order: 0, is_protected: 0 }],
  // Só os 8 parâmetros de fato cadastrados por padrão (CPQ_FIXED_PARAM_ORDER)
  // — proto/iface/vsid/ip/port NÃO são parâmetros de catálogo (ver nota de
  // escopo no topo do arquivo e nas instruções da fatia).
  parameters: [
    { key: 'src_ip', label: 'Source IP', sort_order: 0 },
    { key: 'dst_ip', label: 'Destination IP', sort_order: 1 },
    { key: 'src_port', label: 'Source Port', sort_order: 2 },
    { key: 'dst_port', label: 'Destination Port', sort_order: 3 },
    { key: 'user', label: 'User', sort_order: 4 },
    { key: 'host', label: 'Host', sort_order: 5 },
    { key: 'license', label: 'License', sort_order: 6 },
    { key: 'signature', label: 'Signature', sort_order: 7 },
  ],
};

function line(overrides) {
  return { line_type: 'cmd', prompt: null, content: '', export_template: null, image_data: null, ...overrides };
}
function note(content) {
  return { line_type: 'note', prompt: null, content, export_template: null, image_data: null };
}

function advCommand(id, resolver, name, lines) {
  return {
    id, topic: 'advanced', topics: ['advanced'], folder_ids: [], icon: null, sort_order: id,
    requires_ip_port: false, placeholder_resolver: resolver,
    name, name_empty: null, desc: `Advanced command: ${name}`, desc_empty: null, details: null,
    vendors: [], systems: [], versions: [], environments: [],
    lines: { default: lines, empty: [] },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    created_by: 'admin', modified_by: 'admin', is_system: false,
  };
}

const COMMANDS = [
  advCommand(101, 'fwmonitor', 'fw monitor capture', [
    line({ prompt: '[Expert@FW]#', content: 'fw monitor -F "{{src_ip}},{{src_port}},{{dst_ip}},{{dst_port}},{{proto}}"' }),
    note('Filter matches traffic between {{src_ip}} and {{dst_ip}} in both directions.'),
  ]),
  advCommand(102, 'tcpdump', 'tcpdump capture', [
    line({ prompt: '[Expert@FW]#', content: 'tcpdump -i any -nn -s 0 "host {{src_ip}} and host {{dst_ip}}"' }),
    note('tcpdump does not require Expert privileges beyond capture rights; use -w file.pcap to save for Wireshark.'),
  ]),
  advCommand(103, 'zdebug', 'fw ctl zdebug + drop', [
    line({ prompt: '[Expert@FW]#', content: 'fw ctl zdebug + drop | grep -E "{{src_ip}}|{{dst_ip}}"', export_template: '| tee {{logFile}}' }),
    { line_type: 'warn', prompt: null, content: 'This command can impact performance on busy gateways — stop it with fw ctl zdebug -x when done.', export_template: null, image_data: null },
  ]),
  advCommand(104, 'fwlog', 'fw log -n query', [
    line({ prompt: '[Expert@FW]#', content: 'fw log -n -s {{src_ip}} -d {{dst_ip}}', export_template: '> {{logFile}}' }),
    note('fw log reads from the current active log file; use -f to follow, -c to filter by action.'),
  ]),
  advCommand(105, 'logexport', 'fwm logexport to CSV', [
    line({ prompt: '[Expert@FW]#', content: 'fwm logexport -i $FWDIR/log/fw.log -o /tmp/fw_export.txt -n -s {{src_ip}} -e {{dst_ip}}' }),
  ]),
  advCommand(106, 'fetchlogs', 'fw fetchlogs from gateway', [
    line({ prompt: '[Expert@SMS]#', content: 'fw fetchlogs {{src_ip}}' }),
    note('Pulls the current active log file from the gateway to the Security Management Server.'),
  ]),
  advCommand(107, 'conntable', 'fw tab connections lookup', [
    line({ prompt: '[Expert@FW]#', content: 'fw tab -t connections -f | grep -E "({{src_ip}}).*({{dst_ip}})|({{dst_ip}}).*({{src_ip}})"' }),
  ]),
  advCommand(108, 'nattable', 'fw tab NAT lookup', [
    line({ prompt: '[Expert@FW]#', content: 'fw tab -t fwx_alloc -f | grep -E "({{src_ip}}).*({{dst_ip}})"' }),
  ]),
  advCommand(109, 'routespecific', 'ip route get / arp lookup', [
    line({ prompt: '[Expert@FW]#', content: 'ip route get {{dst_ip}}' }),
    note('netstat -rn lists the full kernel routing table; the grep narrows it to this /24.'),
    { line_type: 'cmd', prompt: '[Gaia]>', content: 'show route', export_template: null, image_data: null },
    { line_type: 'cmd', prompt: '[Gaia]>', content: 'show arp', export_template: null, image_data: null },
  ]),
  advCommand(110, 'fwaccelconns', 'fwaccel conns lookup', [
    line({ prompt: '[Expert@FW]#', content: 'fwaccel conns | grep -E "{{src_ip}}|{{dst_ip}}"' }),
    note('fwaccel conns lists only SecureXL-accelerated connections; unaccelerated ones need conntable instead.'),
  ]),
];

async function mockLoggedInAdmin(page) {
  await page.addInitScript(() => {
    localStorage.setItem('cpa-authenticated', '1');
  });
  await page.route('**/api/me', route =>
    route.fulfill({
      json: { username: 'admin', upn: 'admin', handle: 'admin', role: 'super_admin', isAdmin: true, isSuperAdmin: true, authMethod: 'local' },
    })
  );
  await page.route('**/api/catalogs', route => route.fulfill({ json: CATALOGS }));
  await page.route('**/api/commands', route => route.fulfill({ json: COMMANDS }));
  await page.route('**/api/system/logo', route => route.fulfill({ json: { imageData: null, imageDataDark: null } }));
}

// Mesmo helper usado em test/commands.spec.mjs: digita "key:value ..." no
// campo único da QueryBar e confirma com Enter.
async function setQueryFields(page, pairs) {
  const text = Object.entries(pairs)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  const input = page.locator('.cpq-input');
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

async function termText(page, id) {
  return page.locator(`.card[data-cmd-id="${id}"] .term`).innerText();
}

const browser = await chromium.launch();

// ── Cenário 1: fwmonitor — IP único, lista pequena, range grande demais ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="101"]');

  await setQueryFields(page, { src_ip: '10.9.8.7', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 101)).includes('10.9.8.7,0,10.9.8.8,0,0'), 'fwmonitor: IP único monta o -F "src,sp,dst,dp,proto"');
  let t = await termText(page, 101);
  assert((t.match(/-F "/g) || []).length === 2, 'fwmonitor: IP único gera exatamente 2 flags -F (direto + invertido)');

  await setQueryFields(page, { src_ip: '10.9.8.10,10.9.8.11', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 101)).includes('10.9.8.11,0,10.9.8.8'), 'fwmonitor: lista pequena em src aplicada');
  t = await termText(page, 101);
  assert((t.match(/-F "/g) || []).length === 4, 'fwmonitor: lista de 2 IPs em src (1 dst) gera 4 flags -F (2 combinações x 2)');

  await setQueryFields(page, { src_ip: '10.9.8.1-10.9.8.20', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 101)).includes('too large to enumerate'), 'fwmonitor: range > 4 endereços produz a nota "too large to enumerate"');
  t = await termText(page, 101);
  assert(!t.includes('-F "'), 'fwmonitor: range grande demais não produz nenhuma flag -F');
  await page.screenshot({ path: `${SHOTS}/1-fwmonitor.png` });
});

// ── Cenário 2: tcpdump — IP único, range CIDR-alinhado, range pequeno não-CIDR, portas ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="102"]');

  await setQueryFields(page, { src_ip: '10.9.8.7', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 102)).includes('host 10.9.8.7'), 'tcpdump: IP único pré-condição aplicada');
  let t = await termText(page, 102);
  assert(t.includes('host 10.9.8.7') && t.includes('host 10.9.8.8'), 'tcpdump: IP único produz "host SRC and host DST"');

  await setQueryFields(page, { src_ip: '10.9.8.0-10.9.8.255', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 102)).includes('net 10.9.8.0/24'), 'tcpdump: range alinhado a /24 produz "net 10.9.8.0/24"');

  await setQueryFields(page, { src_ip: '10.9.8.10-10.9.8.12', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 102)).includes('host 10.9.8.10 or host 10.9.8.11 or host 10.9.8.12'), 'tcpdump: range pequeno não-CIDR vira OR de hosts');

  await setQueryFields(page, { src_ip: '10.9.8.7', dst_ip: '10.9.8.8', src_port: '80', dst_port: '22' });
  await assertEventually(async () => (await termText(page, 102)).includes('src port 80'), 'tcpdump: src_port aplicado');
  t = await termText(page, 102);
  assert(t.includes('src port 80') && t.includes('dst port 22'), 'tcpdump: cláusulas "src port"/"dst port" presentes juntas');
  await page.screenshot({ path: `${SHOTS}/2-tcpdump.png` });
});

// ── Cenário 3: zdebug — regex OR de src+dst; export toggle anexa o export_template ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="103"]');

  await setQueryFields(page, { src_ip: '10.9.8.7', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 103)).includes('10\\.9\\.8\\.7'), 'zdebug: regex OR contém src_ip escapado');
  let t = await termText(page, 103);
  assert(t.includes('10\\.9\\.8\\.7') && t.includes('10\\.9\\.8\\.8'), 'zdebug: regex OR contém src_ip E dst_ip escapados');
  assert(!t.includes('tee'), 'zdebug: sem o toggle Export, nenhum redirecionamento é anexado');

  await page.locator('.sb-toggle', { hasText: 'Export' }).click();
  await assertEventually(async () => (await termText(page, 103)).includes('tee /tmp/$(hostname).txt'), 'zdebug: toggle Export liga o redirecionamento do export_template resolvido');
  await page.screenshot({ path: `${SHOTS}/3-zdebug.png` });
});

// ── Cenário 4: fwlog — IP único usa -s/-d direto; lista/range cai no fallback grep -E; export toggle anexa aos dois comandos ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="104"]');

  await setQueryFields(page, { src_ip: '10.9.8.7', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 104)).includes('-s 10.9.8.7 -d 10.9.8.8'), 'fwlog: IP único usa -s/-d direto');
  assert(!(await page.isVisible('.card[data-cmd-id="104"] .ln-info')), 'fwlog: sem lista/range, nenhuma nota de fallback aparece');

  await setQueryFields(page, { src_ip: '10.9.8.10,10.9.8.11', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 104)).includes('grep -E'), 'fwlog: lista em src cai no fallback grep -E');
  assert(await page.isVisible('.card[data-cmd-id="104"] .ln-info'), 'fwlog: nota "info" do fallback visível quando há lista/range');
  // 2, não 3: as DUAS linhas .cmd-line (normal e -c drop) usam grep -E — a
  // nota .ln-info também contém a substring "grep -E" no seu próprio texto
  // explicativo, então a contagem tem que ser restrita às linhas de comando.
  let cmdLinesWithGrep = await page.locator('.card[data-cmd-id="104"] .cmd-line', { hasText: 'grep -E' }).count();
  assert(cmdLinesWithGrep === 2, 'fwlog: fallback gera os dois comandos (normal e -c drop) com grep -E');

  await setQueryFields(page, { src_ip: '10.9.8.7', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 104)).includes('-s 10.9.8.7 -d 10.9.8.8'), 'fwlog: volta ao caminho direto com IP único');
  await page.locator('.sb-toggle', { hasText: 'Export' }).click();
  await assertEventually(async () => (await termText(page, 104)).includes('> /tmp/$(hostname).txt'), 'fwlog: toggle Export anexa o redirecionamento');
  const t104 = await termText(page, 104);
  assert((t104.match(/> \/tmp\/\$\(hostname\)\.txt/g) || []).length === 2, 'fwlog: redirecionamento anexado às DUAS linhas de comando (normal e -c drop)');
  await page.screenshot({ path: `${SHOTS}/4-fwlog.png` });
});

// ── Cenário 5: logexport — sem toggle usa /tmp/fw_export.txt; com toggle troca para o logFile fixo; lista/range adiciona nota "info" ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="105"]');

  await setQueryFields(page, { src_ip: '10.9.8.7', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 105)).includes('-o /tmp/fw_export.txt'), 'logexport: sem toggle Export, mantém o caminho fixo /tmp/fw_export.txt');
  assert(!(await page.isVisible('.card[data-cmd-id="105"] .ln-info')), 'logexport: sem lista/range, nenhuma nota "info" aparece');

  await page.locator('.sb-toggle', { hasText: 'Export' }).click();
  await assertEventually(async () => (await termText(page, 105)).includes('-o /tmp/$(hostname).txt'), 'logexport: toggle Export troca o caminho de saída para o logFile fixo');
  let t = await termText(page, 105);
  assert(!t.includes('/tmp/fw_export.txt'), 'logexport: o caminho antigo /tmp/fw_export.txt não sobra depois da troca');

  await setQueryFields(page, { src_ip: '10.9.8.10,10.9.8.11', dst_ip: '10.9.8.8' });
  await assertEventually(async () => page.isVisible('.card[data-cmd-id="105"] .ln-info'), 'logexport: lista/range em src ativa a nota "info" sobre filtrar 1 IP por vez');
  await page.screenshot({ path: `${SHOTS}/5-logexport.png` });
});

// ── Cenário 6: fetchlogs — IP único gera 1 linha; lista pequena enumera; range grande produz nota de "skipped" ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="106"]');

  await setQueryFields(page, { src_ip: '10.9.8.7', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 106)).includes('fw fetchlogs 10.9.8.7'), 'fetchlogs: IP único pré-condição aplicada');
  let cmdLines = await page.locator('.card[data-cmd-id="106"] .cmd-line').count();
  assert(cmdLines === 1, 'fetchlogs: IP único gera exatamente 1 linha de comando');

  await setQueryFields(page, { src_ip: '10.9.8.10,10.9.8.11', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await page.locator('.card[data-cmd-id="106"] .cmd-line').count()) === 2, 'fetchlogs: lista pequena (2 IPs) enumera 2 linhas de comando');
  let t = await termText(page, 106);
  assert(t.includes('fw fetchlogs 10.9.8.10') && t.includes('fw fetchlogs 10.9.8.11'), 'fetchlogs: as 2 linhas têm os 2 IPs da lista');

  await setQueryFields(page, { src_ip: '10.9.8.1-10.9.8.20', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 106)).includes('Range too large to enumerate automatically'), 'fetchlogs: range grande (>8) produz a nota de "too large"/"skipped"');
  await page.screenshot({ path: `${SHOTS}/6-fetchlogs.png` });
});

// ── Cenário 7: conntable e nattable — {{src_ip}}/{{dst_ip}} no template viram o REGEX quando há lista/range; range grande gera warning ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="107"]');
  await page.waitForSelector('.card[data-cmd-id="108"]');

  await setQueryFields(page, { src_ip: '10.9.8.10,10.9.8.11', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 107)).includes('10\\.9\\.8\\.10'), 'conntable: {{src_ip}} substituído pelo regex (escapado), não pela lista crua');
  let t107 = await termText(page, 107);
  assert(!t107.includes('10.9.8.10,10.9.8.11'), 'conntable: valor cru "10.9.8.10,10.9.8.11" não aparece — foi convertido em regex');
  let t108 = await termText(page, 108);
  assert(t108.includes('10\\.9\\.8\\.10') && t108.includes('10\\.9\\.8\\.11'), 'nattable: {{src_ip}} também substituído pelo regex (mesma lógica de conntable)');

  await setQueryFields(page, { src_ip: '10.0.0.0-10.255.255.255', dst_ip: '10.9.8.8' });
  await assertEventually(async () => page.isVisible('.card[data-cmd-id="107"] .ln-warn'), 'conntable: range grande demais (>64 blocos /24) gera nota de warning');
  await assertEventually(async () => page.isVisible('.card[data-cmd-id="108"] .ln-warn'), 'nattable: range grande demais (>64 blocos /24) gera nota de warning');
  await page.screenshot({ path: `${SHOTS}/7-conntable-nattable.png` });
});

// ── Cenário 8: routespecific — IP único gera ip route get + arp -n; lista pequena enumera pares; netstat usa o 1º IP; linhas [Gaia]> sem substituição ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="109"]');

  // routespecific só usa dst_ip, mas o gatilho hasIPs do renderPipeline
  // (que decide SE chamar qualquer resolver) exige src_ip E dst_ip
  // preenchidos (`hasIPs = !!(values.src_ip && values.dst_ip)`, ver
  // renderPipeline.ts) — por isso src_ip precisa estar preenchido aqui
  // também, mesmo sem nenhum efeito no comando gerado.
  await setQueryFields(page, { src_ip: '0.0.0.0', dst_ip: '10.9.8.9' });
  await assertEventually(async () => (await termText(page, 109)).includes('ip route get 10.9.8.9'), 'routespecific: IP único gera "ip route get IP"');
  let t = await termText(page, 109);
  assert(t.includes('arp -n | grep 10.9.8.9'), 'routespecific: IP único também gera "arp -n | grep IP"');
  assert(t.includes('netstat -rn | grep 10.9.8'), 'routespecific: netstat usa os 3 primeiros octetos do (único) IP');
  assert(t.includes('show route') && t.includes('show arp'), 'routespecific: linhas [Gaia]> (show route/show arp) presentes sem depender de src/dst');
  const gaiaPrompts = await page.locator('.card[data-cmd-id="109"] .cmd-line .pr').allInnerTexts();
  assert(gaiaPrompts.filter(p => p.trim() === '[Gaia]>').length === 2, 'routespecific: 2 linhas com prompt [Gaia]>');

  await setQueryFields(page, { src_ip: '0.0.0.0', dst_ip: '10.9.8.10,10.9.8.11' });
  await assertEventually(async () => (await termText(page, 109)).includes('ip route get 10.9.8.11'), 'routespecific: lista pequena aplicada');
  t = await termText(page, 109);
  assert(t.includes('ip route get 10.9.8.10') && t.includes('ip route get 10.9.8.11'), 'routespecific: lista pequena enumera "ip route get" para cada IP');
  assert(t.includes('netstat -rn | grep 10.9.8'), 'routespecific: netstat usa os 3 primeiros octetos do PRIMEIRO IP da lista');
  await page.screenshot({ path: `${SHOTS}/8-routespecific.png` });
});

// ── Cenário 9: fwaccelconns — regex OR de src|dst; nota de range grande ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="110"]');

  await setQueryFields(page, { src_ip: '10.9.8.7', dst_ip: '10.9.8.8' });
  await assertEventually(async () => (await termText(page, 110)).includes('10\\.9\\.8\\.7'), 'fwaccelconns: regex OR contém src_ip escapado');
  let t = await termText(page, 110);
  assert(t.includes('10\\.9\\.8\\.7') && t.includes('10\\.9\\.8\\.8'), 'fwaccelconns: regex OR contém src_ip E dst_ip escapados');

  await setQueryFields(page, { src_ip: '10.0.0.0-10.255.255.255', dst_ip: '10.9.8.8' });
  await assertEventually(async () => page.isVisible('.card[data-cmd-id="110"] .ln-warn'), 'fwaccelconns: range grande demais gera nota de warning');
  await page.screenshot({ path: `${SHOTS}/9-fwaccelconns.png` });
});

// ── Cenário 10: SEM src_ip+dst_ip (hasIPs=false) os 10 comandos caem no caminho dbLinesToTerm normal (substituição simples, sem lógica avançada) ──
await withPage(browser, async page => {
  await mockLoggedInAdmin(page);
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('.card[data-cmd-id="101"]');

  // Nenhum src_ip/dst_ip preenchido — hasIPs é false, RESOLVERS nunca é
  // chamado (ver renderPipeline.ts::buildCardDataForRow), então o texto cru
  // do template (com hints "<Label>" no lugar de {{token}}) deve aparecer.
  const t101 = await termText(page, 101);
  assert(!/\{\{\w+\}\}/.test(t101), 'sem IPs: fwmonitor não deixa {{token}} cru (cai no fallback simples com hints)');
  assert(t101.includes('Source IP') && t101.includes('Destination IP'), 'sem IPs: fwmonitor mostra os hints "<Source IP>"/"<Destination IP>" do catálogo, não o -F calculado');
  // O template cru já contém um único -F "..." literal (é só substituição
  // simples de token, não o resolver) — o que confirma que a lógica
  // avançada NÃO rodou é a ausência de MÚLTIPLAS flags -F (que só o
  // resolver, com combinações src x dst x portas, produziria).
  assert((t101.match(/-F "/g) || []).length === 1, 'sem IPs: fwmonitor mantém só a flag -F literal do template (nenhuma combinação calculada pelo resolver)');

  const t103 = await termText(page, 103);
  assert(!/\{\{\w+\}\}/.test(t103), 'sem IPs: zdebug não deixa {{token}} cru');
  assert(!/[\x01\x02]/.test(t103), 'sem IPs: zdebug não deixa sentinelas de variável soltas');

  const t107 = await termText(page, 107);
  assert(!t107.includes('([^0-9]|$)'), 'sem IPs: conntable não gera o regex avançado (fica na substituição simples de token)');

  for (const id of [101, 102, 103, 104, 105, 106, 107, 108, 109, 110]) {
    const t = await termText(page, id);
    assert(!/\{\{\w+\}\}/.test(t), `sem IPs: comando ${id} não deixa nenhum {{token}} cru`);
  }
  await page.screenshot({ path: `${SHOTS}/10-no-ips-fallback.png` });
});

await browser.close();

console.log(`\n${failures === 0 ? 'TODOS OS CENÁRIOS PASSARAM' : `${failures} CENÁRIO(S) FALHARAM`}`);
process.exit(failures === 0 ? 0 : 1);
