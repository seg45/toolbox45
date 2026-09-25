// ════════════════════════════════════════════════
// IP CALCULATOR — item "IP Calc" dentro do menu "Tools" no header (ver
// #toolsDD/#toolsDDPanel em index.html), abre um modal (#ipCalcOverlay) com:
// 1) cálculo de rede a partir de IP + máscara (CIDR "/24" ou dotted
//    "255.255.255.0") — endereço de rede, broadcast, máscara, wildcard,
//    faixa de hosts utilizáveis, classe (A/B/C/D/E) e tipo (privado
//    RFC 1918 / público / loopback / link-local / multicast / etc.);
// 2) campo opcional "move to" — um segundo prefixo/máscara que tanto faz
//    SPLIT (prefixo mais longo/específico -> lista todas as sub-redes,
//    ex.: /24 em N x /25) quanto SUPERNET (prefixo mais curto -> recalcula
//    a rede que contém o mesmo endereço com uma máscara mais larga) — os
//    dois sentidos do mesmo campo, igual à calculadora de referência que o
//    usuário pediu pra seguir de estilo (rótulos verdes, valores em azul,
//    representação binária ponto-a-ponto com a máscara em vermelho);
// 3) tabela de referência fixa com as faixas privadas da RFC 1918.
// Reaproveita ipToLong/longToIp (js/net-utils.js, já carregado antes deste
// arquivo) e o par _copyToClipboard/_doSingleCopy/COPY_BTN_ICON
// (js/terminal-renderer.js) usado pelos botões de copiar em todo o app, em
// vez de duplicar essa lógica.
// ════════════════════════════════════════════════

// ── Máscara/prefixo ──────────────────────────────
// (32 - prefix) pode valer 32 quando prefix=0 — deslocamento de bits em JS
// usa o operando módulo 32, então "x << 32" NÃO desloca nada (bug clássico);
// por isso prefix<=0 é tratado à parte, devolvendo a máscara zerada certa.
function ipcPrefixToMaskLong(prefix) {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xFFFFFFFF >>> 0;
  return (0xFFFFFFFF << (32 - prefix)) >>> 0;
}

// Aceita "/24", "24" (CIDR/prefixo) ou "255.255.255.0" (máscara decimal
// pontuada) — devolve o prefixo (0-32) ou null se inválido. Uma máscara
// pontuada só é válida se for contígua (1s seguidos de 0s, sem "buracos").
function ipcParseMaskInput(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  s = s.replace(/^\//, '');
  if (/^\d{1,2}$/.test(s)) {
    const n = parseInt(s, 10);
    return (n >= 0 && n <= 32) ? n : null;
  }
  const maskLong = ipToLong(s);
  if (maskLong === null) return null;
  const bin = (maskLong >>> 0).toString(2).padStart(32, '0');
  if (!/^1*0*$/.test(bin)) return null; // máscara não-contígua (ex.: 255.0.255.0) é inválida
  return (bin.match(/1/g) || []).length;
}

// ── Classificação do endereço ────────────────────
function ipcIpClass(ipLong) {
  const first = (ipLong >>> 24) & 255;
  if (first < 128) return 'A';
  if (first < 192) return 'B';
  if (first < 224) return 'C';
  if (first < 240) return 'D (Multicast)';
  return 'E (Experimental)';
}
// Só as faixas mais relevantes pro dia a dia de suporte — não é uma lista
// exaustiva de toda a IANA Special-Purpose Address Registry. Nomes curtos
// de propósito — aparecem entre parênteses na mesma linha do resultado.
function ipcIpType(ipLong) {
  const a = (ipLong >>> 24) & 255, b = (ipLong >>> 16) & 255;
  if (a === 10) return 'Private Internet';
  if (a === 172 && b >= 16 && b <= 31) return 'Private Internet';
  if (a === 192 && b === 168) return 'Private Internet';
  if (a === 127) return 'Loopback';
  if (a === 169 && b === 254) return 'Link-Local';
  if (a === 100 && b >= 64 && b <= 127) return 'Shared Address Space';
  if (a >= 224 && a <= 239) return 'Multicast';
  if (a >= 240) return 'Reserved';
  return 'Public Internet';
}

// ── Cálculo principal ─────────────────────────────
// Trata /31 (RFC 3021 — link ponto-a-ponto, ambos endereços são
// utilizáveis, sem conceito de rede/broadcast na prática) e /32 (host
// único) como casos especiais — a fórmula genérica (total-2) daria hosts
// negativos ou zero pra esses dois prefixos.
function ipcCalculate(ipRaw, maskRaw) {
  const ipLong = ipToLong(String(ipRaw || '').trim());
  if (ipLong === null) return { error: 'Invalid IP address.' };
  const prefix = ipcParseMaskInput(maskRaw);
  if (prefix === null) return { error: 'Invalid mask — use CIDR (e.g. /24 or 24) or a dotted mask (e.g. 255.255.255.0).' };

  const maskLong = ipcPrefixToMaskLong(prefix);
  const wildcardLong = (~maskLong) >>> 0;
  const networkLong = (ipLong & maskLong) >>> 0;
  const broadcastLong = (networkLong | wildcardLong) >>> 0;
  const totalAddresses = Math.pow(2, 32 - prefix);

  let usableHosts, firstHostLong, lastHostLong;
  if (prefix === 32) {
    usableHosts = 1;
    firstHostLong = networkLong;
    lastHostLong = networkLong;
  } else if (prefix === 31) {
    usableHosts = 2;
    firstHostLong = networkLong;
    lastHostLong = broadcastLong;
  } else {
    usableHosts = totalAddresses - 2;
    firstHostLong = networkLong + 1;
    lastHostLong = broadcastLong - 1;
  }

  return {
    ip: longToIp(ipLong),
    ipLong,
    prefix,
    networkLong,
    broadcastLong,
    firstHostLong,
    lastHostLong,
    cidr: `${longToIp(networkLong)}/${prefix}`,
    maskDotted: longToIp(maskLong),
    maskLong,
    wildcardDotted: longToIp(wildcardLong),
    wildcardLong,
    network: longToIp(networkLong),
    broadcast: longToIp(broadcastLong),
    firstHost: longToIp(firstHostLong),
    lastHost: longToIp(lastHostLong),
    totalAddresses,
    usableHosts,
    ipClass: ipcIpClass(ipLong),
    ipType: ipcIpType(ipLong),
  };
}

// ── Split de sub-rede ─────────────────────────────
// Divide a rede [networkLong, basePrefix] em blocos iguais de prefixo
// newPrefix (ex.: /24 -> N x /25, /26...). MAX_SUBNETS é um teto de
// segurança (mesmo espírito do MAX_ENUM/MAX_COMBOS em js/net-utils.js) pra
// não travar a tela caso o usuário peça algo como /8 -> /30.
const IPC_MAX_SUBNETS = 512;
function ipcSplitSubnets(networkLong, basePrefix, newPrefix) {
  if (!(newPrefix > basePrefix)) return { error: 'The new prefix must be longer (a bigger number) than the current one.' };
  if (newPrefix > 32) return { error: 'Prefix cannot exceed /32.' };
  const count = Math.pow(2, newPrefix - basePrefix);
  const genCount = Math.min(count, IPC_MAX_SUBNETS);
  const blockSize = Math.pow(2, 32 - newPrefix);
  const subnets = [];
  for (let i = 0; i < genCount; i++) {
    const subNet = (networkLong + i * blockSize) >>> 0;
    const subBcast = (subNet + blockSize - 1) >>> 0;
    let usable, first, last;
    if (newPrefix === 32) { usable = 1; first = subNet; last = subNet; }
    else if (newPrefix === 31) { usable = 2; first = subNet; last = subBcast; }
    else { usable = blockSize - 2; first = subNet + 1; last = subBcast - 1; }
    subnets.push({
      networkLong: subNet,
      broadcastLong: subBcast,
      firstHostLong: first,
      lastHostLong: last,
      cidr: `${longToIp(subNet)}/${newPrefix}`,
      network: longToIp(subNet),
      broadcast: longToIp(subBcast),
      firstHost: longToIp(first),
      lastHost: longToIp(last),
      usableHosts: usable,
      ipClass: ipcIpClass(subNet),
      ipType: ipcIpType(subNet),
    });
  }
  return { subnets, count, truncated: count > genCount, generated: genCount };
}

// ── UI: abrir/fechar modal ────────────────────────
// Pedido do usuário: o modal deve SEMPRE abrir já com um resultado
// calculado na tela (não em branco) — usa 192.168.0.1/24 como padrão na
// primeira vez; se os campos já tiverem algo de uma calculadora anterior
// (usuário fechou e reabriu), só recalcula com o que já estava lá. O
// campo Address abre com o texto TODO selecionado, pra digitar já
// substituir o valor existente em vez de precisar apagar antes.
function openIpCalcModal() {
  document.getElementById('ipCalcOverlay').classList.add('show');
  const ipEl = document.getElementById('ipcIp');
  const maskEl = document.getElementById('ipcMask');
  if (ipEl && !ipEl.value) ipEl.value = '192.168.0.1';
  if (maskEl && !maskEl.value) maskEl.value = '24';
  ipcRunCalculate();
  if (ipEl) setTimeout(() => { ipEl.focus(); ipEl.select(); }, 0);
}
function closeIpCalcModal() {
  document.getElementById('ipCalcOverlay').classList.remove('show');
}
// Pedido do usuário: fechar SOMENTE pelo botão "✕" do cabeçalho — ao
// contrário dos outros modais do app, aqui não há fechamento por clique
// fora (overlay) nem por Esc, propositalmente (evita perder os dados
// calculados/o "move to" digitado com um clique ou tecla acidental).

// Pedido do usuário: a tabela de referência de prefixo/máscara (o "i" ao
// lado do rótulo "Netmask") só deve aparecer quando o usuário CLICAR no
// ícone — não mais ao passar o mouse. Clicar de novo no ícone, ou clicar
// fora dele, fecha o popover.
//
// O popover (.ipc-info-pop) é position:fixed (não absolute) DE PROPÓSITO:
// o .modal-box do IPCalc tem overflow-y:auto/max-height, então um popover
// absolute dentro dele era cortado assim que a tabela (33 linhas) passava
// da área visível ("as informações estão cortando" — bug reportado).
// Sendo fixed, escapamos desse clipping, mas precisamos calcular a posição
// em coordenadas de tela (getBoundingClientRect) na hora do clique.
function ipcToggleNetmaskInfo(e) {
  e.stopPropagation();
  const icon = e.currentTarget;
  const pop = icon.querySelector('.ipc-info-pop');
  const wasOpen = icon.classList.contains('ipc-info-open');
  document.querySelectorAll('.ipc-info-icon.ipc-info-open').forEach(el => el.classList.remove('ipc-info-open'));
  if (wasOpen) return;
  icon.classList.add('ipc-info-open');
  if (!pop) return;
  const rect = icon.getBoundingClientRect();
  pop.style.top = (rect.bottom + 6) + 'px';
  pop.style.left = rect.left + 'px';
  // Corrige a posição horizontal/vertical depois de renderizado (agora que
  // tem display:block e dimensões reais), caso estoure a borda da tela.
  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) {
      pop.style.left = Math.max(8, window.innerWidth - pr.width - 8) + 'px';
    }
    if (pr.bottom > window.innerHeight - 8) {
      pop.style.top = Math.max(8, rect.top - pr.height - 6) + 'px';
    }
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.ipc-label-info-wrap')) {
    document.querySelectorAll('.ipc-info-icon.ipc-info-open').forEach(el => el.classList.remove('ipc-info-open'));
  }
});
// Fecha o popover se o usuário rolar qualquer área com scroll (ex.: o
// próprio .modal-box) — como agora é fixed, ele não acompanharia a rolagem
// e ficaria desalinhado do ícone "i".
document.addEventListener('scroll', () => {
  document.querySelectorAll('.ipc-info-icon.ipc-info-open').forEach(el => el.classList.remove('ipc-info-open'));
}, true);

// ── UI: saída em estilo "calculadora de terminal" ──
// Pedido do usuário: reproduzir o estilo de uma calculadora de sub-rede
// clássica (rótulo em verde + valor + a mesma dotted-quad em BINÁRIO ao
// lado, com a porção de rede/host separada por um espaço extra bem na
// fronteira do prefixo, e a máscara em vermelho) em vez da tabela simples
// usada antes.
// Cada linha é um <div class="ipc-line"> com colunas flex de largura FIXA
// em `ch` (ver .ipc-label/.ipc-val/.ipc-copy-slot em css/components.css) —
// não mais uma string monoespaçada com padEnd()/'\n'. Isso garante que a
// coluna do binário comece sempre no mesmo x em toda linha, existindo ou
// não um botão de copiar (um <button> real tem largura em pixels, não em
// caracteres — padEnd() não conseguia alinhar em torno dele, era o motivo
// do "hexadecimal" desalinhado que o usuário reportou).

function _ipcBits32(long) {
  return (long >>> 0).toString(2).padStart(32, '0');
}

// Monta a representação binária pontuada (8.8.8.8 bits) de `long`, com um
// espaço extra logo após o bit `prefix` (fronteira rede/host) — EXCETO
// quando esse bit já coincide com um dos pontos fixos entre octetos (ex.:
// /24, /16, /8): nesse caso o próprio ponto já separa visualmente os dois
// lados, então o espaço extra é pulado (pedido do usuário — sem isso a
// última fronteira ficava com um espaço duplo antes do ponto, "...0 .0...").
// Devolve { str, splitIdx } — splitIdx é o índice de caractere logo após a
// porção "de rede" dentro de `str`, usado por ipcBinHtml pra separar os
// dois pedaços (hoje ambos na mesma cor, mas a estrutura fica pronta caso
// se volte a diferenciar rede/host no futuro).
function _ipcDottedBinary(long, prefix) {
  const bits = _ipcBits32(long);
  let out = '';
  let splitIdx = (prefix <= 0) ? 0 : null;
  for (let i = 1; i <= 32; i++) {
    out += bits[i - 1];
    const atOctetBoundary = (i % 8 === 0 && i < 32);
    if (i === prefix && prefix > 0 && prefix < 32 && !atOctetBoundary) { out += ' '; splitIdx = out.length; }
    if (atOctetBoundary) out += '.';
    if (i === prefix && prefix > 0 && prefix < 32 && atOctetBoundary) { splitIdx = out.length; }
  }
  if (splitIdx === null) splitIdx = out.length; // prefix >= 32
  return { str: out, splitIdx };
}

// Pedido do usuário: uma cor só pro binário inteiro (sem vermelho na
// máscara nem destaque/esmaecido rede vs. host, como era antes). O
// parâmetro `prefix` continua recebido só pra manter a mesma assinatura
// usada em todo o arquivo — não influencia mais a cor.
function ipcBinHtml(long, prefix) {
  const { str } = _ipcDottedBinary(long, prefix);
  return `<span class="ipc-bin">${str}</span>`;
}

// Botão de copiar embutido inline no texto — os únicos valores que passam
// por aqui são IPs/CIDRs já validados (só dígitos, pontos e "/"), então é
// seguro embuti-los direto num atributo onclick com aspas simples.
// IMPORTANTE: a classe base ".copy-btn" é "display:flex" (bloco), pensada
// pro botão ficar no final de uma linha de comando isolada — dentro do
// bloco de texto monoespaçado do IPCalc (white-space:pre) isso quebrava a
// linha ao meio, empurrando o botão pra uma linha própria logo abaixo (com
// um vão vazio enorme no meio). ".copy-btn-inline" é o modificador que já
// existe no app pra isso (ver css/components.css), tornando o botão
// "inline-flex" de verdade, fluindo junto do texto sem quebrar a linha.
function ipcCopyBtnHtml(text) {
  return `<button type="button" class="copy-btn copy-btn-inline ipc-copy-btn" title="Copy" onclick="ipcCopyInline(this,'${text}')">${COPY_BTN_ICON}</button>`;
}
function ipcCopyInline(btn, text) {
  if (typeof _doSingleCopy !== 'function') return;
  btn._copyText = text;
  _doSingleCopy(btn);
}

// Uma linha "Label: valor[copiar] binário (nota)", como um <div> flex — o
// valor e o botão de copiar (quando existe) ficam juntos dentro de
// .ipc-valwrap, colados um no outro — pedido do usuário ("o botão de
// copiar deve ficar logo após os endereços"). .ipc-valwrap tem largura
// FIXA (ver css/components.css) MESMO quando não há botão, pra coluna do
// binário não deslocar entre linhas com/sem botão de copiar.
function ipcLine(label, value, binHtml, note, copyText) {
  let html = `<div class="ipc-line">`;
  html += `<span class="ipc-label">${label}:</span>`;
  html += `<span class="ipc-valwrap"><span class="ipc-val">${value}</span>`;
  if (copyText) html += ipcCopyBtnHtml(copyText);
  html += `</span>`;
  if (binHtml) html += `<span class="ipc-bin-wrap">${binHtml}</span>`;
  if (note) html += ` <span class="ipc-note">(${note})</span>`;
  html += `</div>`;
  return html;
}

// Linha "Netmask" — caso especial: pedido do usuário é mostrar a máscara
// pontuada (255.255.255.0) com o SEU PRÓPRIO botão de copiar, um espaço, e
// o prefixo (/24) com OUTRO botão de copiar independente — em vez de um
// texto único "255.255.255.0 = 24" sem botão nenhum (como as demais linhas
// via ipcLine()). Ainda usa .ipc-valwrap (mesma largura fixa reservada nas
// outras linhas) pra manter a coluna do binário alinhada.
function ipcNetmaskLine(maskDotted, prefix, binHtml) {
  let html = `<div class="ipc-line">`;
  html += `<span class="ipc-label">Netmask:</span>`;
  html += `<span class="ipc-valwrap">`;
  html += `<span class="ipc-val">${maskDotted}</span>${ipcCopyBtnHtml(maskDotted)}`;
  html += `<span class="ipc-val">/${prefix}</span>${ipcCopyBtnHtml('/' + prefix)}`;
  html += `</span>`;
  if (binHtml) html += `<span class="ipc-bin-wrap">${binHtml}</span>`;
  html += `</div>`;
  return html;
}

// Bloco de 5 linhas comum a qualquer rede já calculada (rede/base, sub-rede
// individual de um split, ou supernet) — Network/HostMin/HostMax/Broadcast/
// Hosts+tipo, com botão de copiar em todos os endereços (Network/HostMin/
// HostMax/Broadcast) — pedido do usuário. Recebe um objeto com os *Long
// (networkLong, broadcastLong, firstHostLong, lastHostLong) +
// prefix/usableHosts/ipClass/ipType/cidr. Envolto num .ipc-block, que junto
// com a linha divisória entre blocos (ver .ipc-block + .ipc-block em
// css/components.css) deixa claro onde uma sub-rede termina e a próxima
// começa num split com várias — pedido do usuário ("ficou tudo em um bloco
// só, está confuso"). `indexLabel` (opcional) é um rotulozinho tipo
// "Subnet 2 of 4", mostrado só quando há múltiplas sub-redes geradas.
// wrapBlock=true (padrão): sai como .ipc-block PRÓPRIO, com a linha
// divisória entre ele e o bloco anterior (usado nas sub-redes do split e
// no supernet, onde cada um deve ficar visualmente separado). wrapBlock=
// false: sai só com um respiro (.ipc-block-inner, sem borda) — usado pra
// "colar" este bloco dentro do MESMO .ipc-block do Address/Netmask/Wildcard
// (pedido do usuário: "remova essa linha" entre Wildcard e Network — devem
// parecer um bloco só, com espaço mas sem divisória).
function ipcRenderNetworkBlock(n, indexLabel, wrapBlock) {
  if (wrapBlock === undefined) wrapBlock = true;
  let out = wrapBlock ? '<div class="ipc-block">' : '<div class="ipc-block-inner">';
  if (indexLabel) out += `<div class="ipc-subnet-index">${indexLabel}</div>`;
  out += ipcLine('Network', n.cidr, ipcBinHtml(n.networkLong, n.prefix, 'net'), `Class ${n.ipClass}`, n.cidr);
  const _maskLong = ipcPrefixToMaskLong(n.prefix);
  out += ipcNetmaskLine(longToIp(_maskLong), n.prefix, ipcBinHtml(_maskLong, n.prefix, 'mask'));
  out += ipcLine('HostMin', longToIp(n.firstHostLong), ipcBinHtml(n.firstHostLong, n.prefix, 'net'));
  out += ipcLine('HostMax', longToIp(n.lastHostLong), ipcBinHtml(n.lastHostLong, n.prefix, 'net'));
  out += ipcLine('Broadcast', longToIp(n.broadcastLong), ipcBinHtml(n.broadcastLong, n.prefix, 'net'));
  out += ipcLine('Hosts/Net', n.usableHosts.toLocaleString('pt-BR'), '', n.ipType);
  out += '</div>';
  return out;
}

let IPC_LAST_RESULT = null;

function ipcRunCalculate() {
  const errEl = document.getElementById('ipcError');
  const moveToErrEl = document.getElementById('ipcMoveToError');
  const resultsGroup = document.getElementById('ipcResultsGroup');
  errEl.style.display = 'none'; errEl.textContent = '';
  moveToErrEl.style.display = 'none'; moveToErrEl.textContent = '';

  const ipRaw = document.getElementById('ipcIp').value;
  const maskRaw = document.getElementById('ipcMask').value;
  const moveToRaw = document.getElementById('ipcMoveTo').value;

  const r = ipcCalculate(ipRaw, maskRaw);
  if (r.error) {
    errEl.textContent = r.error;
    errEl.style.display = '';
    resultsGroup.style.display = 'none';
    return;
  }
  IPC_LAST_RESULT = r;

  // Pedido do usuário: ordem fixa Address, Network, Netmask, Wildcard,
  // HostMin, HostMax, Broadcast, Hosts/Net — tudo em UM ÚNICO bloco visual
  // (sem linha divisória interna, só o respiro de espaço normal). A
  // separação com linha/borda fica reservada para quando há split/supernet
  // (ver .ipc-subnets-section logo abaixo), que aí sim vira um segundo
  // bloco distinto.
  let out = '<div class="ipc-block">';
  out += ipcLine('Address', r.ip, ipcBinHtml(r.ipLong, r.prefix, 'net'));
  out += ipcLine('Network', r.cidr, ipcBinHtml(r.networkLong, r.prefix, 'net'), `Class ${r.ipClass}`, r.cidr);
  out += ipcNetmaskLine(r.maskDotted, r.prefix, ipcBinHtml(r.maskLong, r.prefix, 'mask'));
  out += ipcLine('Wildcard', r.wildcardDotted, ipcBinHtml(r.wildcardLong, r.prefix, 'plain'));
  out += ipcLine('HostMin', longToIp(r.firstHostLong), ipcBinHtml(r.firstHostLong, r.prefix, 'net'));
  out += ipcLine('HostMax', longToIp(r.lastHostLong), ipcBinHtml(r.lastHostLong, r.prefix, 'net'));
  out += ipcLine('Broadcast', longToIp(r.broadcastLong), ipcBinHtml(r.broadcastLong, r.prefix, 'net'));
  out += ipcLine('Hosts/Net', r.usableHosts.toLocaleString('pt-BR'), '', r.ipType);
  out += '</div>';

  // Pedido do usuário: "a supernet deve aparecer em um bloco separado,
  // assim como é o bloco da RFC" — Subnets/Supernet vai pro seu PRÓPRIO
  // .set-group (#ipcSubnetsGroup/#ipcSubnetsOutput em index.html), com
  // rótulo e caixa .ipc-term independentes da caixa do resultado
  // principal — igual ao padrão já usado pela seção RFC 1918 logo abaixo,
  // em vez de ficar dentro da MESMA caixa só separado por uma linha.
  const subnetsGroup = document.getElementById('ipcSubnetsGroup');
  const subnetsLabelEl = document.getElementById('ipcSubnetsLabel');
  let subnetsOut = '';

  const moveTo = String(moveToRaw || '').trim();
  if (moveTo) {
    const newPrefix = ipcParseMaskInput(moveTo);
    if (newPrefix === null) {
      moveToErrEl.textContent = 'Invalid netmask/prefix for "move to".';
      moveToErrEl.style.display = '';
    } else if (newPrefix === r.prefix) {
      out += `<div class="ipc-note-line"><span class="ipc-note">Same prefix as the netmask above — nothing to move to.</span></div>`;
    } else if (newPrefix > r.prefix) {
      // Prefixo mais longo/específico = SPLIT: divide a rede atual em N
      // sub-redes menores (ex.: /24 -> 4 x /26).
      const res = ipcSplitSubnets(r.networkLong, r.prefix, newPrefix);
      subnetsLabelEl.textContent = `Subnets (${res.generated.toLocaleString('pt-BR')})`;
      res.subnets.forEach((sn, i) => {
        subnetsOut += ipcRenderNetworkBlock({ ...sn, prefix: newPrefix }, `Subnet ${i + 1} of ${res.generated}`);
      });
      if (res.truncated) {
        subnetsOut += `<div class="ipc-note-line"><span class="ipc-note">Showing the first ${res.generated} of ${res.count} subnets (safety limit).</span></div>`;
      }
    } else {
      // Prefixo mais curto/genérico = SUPERNET: recalcula a rede que
      // contém o MESMO endereço, só que com uma máscara mais larga.
      // Pedido do usuário: ordem fixa Network, Netmask, HostMin, HostMax,
      // Broadcast, Hosts/Net (sem Wildcard aqui).
      const sr = ipcCalculate(r.ip, String(newPrefix));
      subnetsLabelEl.textContent = 'Supernet';
      subnetsOut += '<div class="ipc-block">';
      subnetsOut += ipcLine('Network', sr.cidr, ipcBinHtml(sr.networkLong, sr.prefix, 'net'), `Class ${sr.ipClass}`, sr.cidr);
      subnetsOut += ipcNetmaskLine(sr.maskDotted, sr.prefix, ipcBinHtml(sr.maskLong, sr.prefix, 'mask'));
      subnetsOut += ipcLine('HostMin', longToIp(sr.firstHostLong), ipcBinHtml(sr.firstHostLong, sr.prefix, 'net'));
      subnetsOut += ipcLine('HostMax', longToIp(sr.lastHostLong), ipcBinHtml(sr.lastHostLong, sr.prefix, 'net'));
      subnetsOut += ipcLine('Broadcast', longToIp(sr.broadcastLong), ipcBinHtml(sr.broadcastLong, sr.prefix, 'net'));
      subnetsOut += ipcLine('Hosts/Net', sr.usableHosts.toLocaleString('pt-BR'), '', sr.ipType);
      subnetsOut += '</div>';
    }
  }

  document.getElementById('ipcTermOutput').innerHTML = out;
  resultsGroup.style.display = '';
  document.getElementById('ipcSubnetsOutput').innerHTML = subnetsOut;
  subnetsGroup.style.display = subnetsOut ? '' : 'none';
}
