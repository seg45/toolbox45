// ════════════════════════════════════════════════
// SAFE SYNTAX HIGHLIGHT — porta 1:1 de js/syntax-highlight.js.
// Tokeniza a string do comando em spans rotulados. Regra: conteúdo dentro de
// strings entre aspas duplas NUNCA é tokenizado de novo — sai como está
// dentro de um span k-str.
// Só as "variáveis" de verdade (valores resolvidos de placeholders {{token}}
// — ver markVar()/VAR_OPEN/VAR_CLOSE em commandTemplate.ts) ganham cor
// própria (k-var); sintaxe literal do comando (nomes de comando, flags,
// caminhos, pipes, strings entre aspas, números) é renderizada como texto
// plano — ver src/styles/components.css.
//
// Retorna uma string HTML já escapada, pensada para ser injetada via
// dangerouslySetInnerHTML — igual ao original, que escapa texto de TEMPLATE
// de comando (não input arbitrário do usuário), então isso é intencional/
// seguro, no mesmo modelo do original.
// ════════════════════════════════════════════════

// Sentinelas que commandTemplate.ts usa para embrulhar um valor de parâmetro
// resolvido, de forma que safeHL() consiga isolar esse trecho como uma
// "variável" sem re-tokenizar seu conteúdo (mesma ideia da regra de string
// entre aspas abaixo). Nunca aparecem em texto de comando de verdade, então
// isso é inequívoco.
export const VAR_OPEN = '\x01';
export const VAR_CLOSE = '\x02';

// Remove as marcações de sentinela de volta — usado onde o texto marcado é
// copiado literalmente em vez de renderizado (ex.: o botão de copiar).
export function stripVarMarkers(s: string | null | undefined): string {
  return typeof s === 'string' ? s.replace(/[\x01\x02]/g, '') : (s as unknown as string);
}

const CMD_WORDS = new Set([
  'fw', 'fw6', 'g_fw', 'fwaccel', 'g_fwaccel', 'tcpdump', 'cpstat', 'cpview',
  'cphaprob', 'vsenv', 'vsx', 'mdsenv', 'mdsstat', 'asg_cmd', 'asg_cpstat',
  'asg', 'g_all', 'g_allc', 'cpinfo', 'cpconfig', 'clusterXL_admin',
  'netstat', 'ip', 'arp', 'cpstart', 'cpstop', 'cprestart', 'cpwd_admin',
  'fwm', 'service', 'cat', 'ls', 'tail', 'grep', 'vi', 'clish', 'gclish',
  'fwm', 'logexport', 'show', 'set', 'save', 'reboot', 'asg_cp2blades',
]);

export function safeHL(raw: string): string {
  // Tokenizamos caractere a caractere para nunca fazer parsing errado de
  // regiões entre aspas.
  const out: string[] = [];
  let i = 0;
  const len = raw.length;

  function peek(): string {
    return i < len ? raw[i] : '';
  }

  function esc(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function flushText(text: string): void {
    if (!text) return;
    out.push(esc(text));
  }
  function span(cls: string, text: string): void {
    out.push(`<span class="${cls}">${esc(text)}</span>`);
  }

  while (i < len) {
    const ch = raw[i];

    // ── variável marcada (commandTemplate.ts embrulha valores {{token}}
    // resolvidos em VAR_OPEN/VAR_CLOSE) — pega tudo de uma vez, nunca
    // re-tokeniza, então ex.: um valor de filtro entre aspas ali dentro não
    // é confundido com um k-str literal. Precisa vir antes da regra de '"'
    // abaixo por esse mesmo motivo.
    if (ch === VAR_OPEN) {
      let s = '';
      i++;
      while (i < len && raw[i] !== VAR_CLOSE) s += raw[i++];
      if (i < len) i++; // pula o marcador de fechamento
      span('k-var', s);
      continue;
    }

    // ── string entre aspas ─────────────────────────
    // Conteúdo dentro de "..." nunca é re-tokenizado como flags/caminhos/etc.
    // — é renderizado plano como k-str. A única exceção é um valor {{token}}
    // resolvido (embrulhado em VAR_OPEN/VAR_CLOSE por markVar(), ex.: o
    // template do fw monitor `"accept host({{src_ip}}) ..."`): esses bytes
    // ainda precisam virar um span k-var aninhado em vez de vazar pra página
    // como caracteres de controle literais (\x01/\x02).
    if (ch === '"') {
      i++;
      let html = '"';
      while (i < len && raw[i] !== '"') {
        if (raw[i] === VAR_OPEN) {
          i++;
          let v = '';
          while (i < len && raw[i] !== VAR_CLOSE) v += raw[i++];
          if (i < len) i++; // pula VAR_CLOSE
          html += `<span class="k-var">${esc(v)}</span>`;
        } else {
          let s = '';
          while (i < len && raw[i] !== '"' && raw[i] !== VAR_OPEN) s += raw[i++];
          html += esc(s);
        }
      }
      if (i < len) {
        html += '"';
        i++;
      }
      out.push(`<span class="k-str">${html}</span>`);
      continue;
    }

    // ── $VAR ──────────────────────────────────────
    if (ch === '$') {
      let s = '$';
      i++;
      while (i < len && /[\w]/.test(raw[i])) s += raw[i++];
      // ${...}
      if (s === '$' && peek() === '{') {
        s += '{';
        i++;
        while (i < len && raw[i] !== '}') s += raw[i++];
        if (i < len) {
          s += '}';
          i++;
        }
      }
      span('k-env', s);
      continue;
    }

    // ── /path ──────────────────────────────────────
    if (ch === '/' && (i === 0 || /\s/.test(raw[i - 1]))) {
      let s = '/';
      i++;
      while (i < len && !/\s|;|"'|&|\|/.test(raw[i])) s += raw[i++];
      span('k-path', s);
      continue;
    }

    // ── pipe / redirect / ponto-e-vírgula ──────────
    if ('|>&;'.includes(ch)) {
      span('k-pipe', ch);
      i++;
      continue;
    }

    // ── flag: -algo ─────────────────────────────────
    if (ch === '-' && i > 0 && /\s/.test(raw[i - 1])) {
      let s = '-';
      i++;
      while (i < len && /[a-zA-Z0-9_\-]/.test(raw[i])) s += raw[i++];
      // só colore se for de fato uma flag (não um traço solto)
      if (s.length > 1) {
        span('k-flag', s);
        continue;
      }
      flushText(s);
      continue;
    }

    // ── palavra ─────────────────────────────────────
    if (/[a-zA-Z_]/.test(ch)) {
      let s = '';
      const start = i;
      while (i < len && /[a-zA-Z0-9_.\-]/.test(raw[i])) s += raw[i++];
      // verifica se é uma palavra de comando conhecida no início da linha ou
      // depois de espaço
      const prev = start > 0 ? raw[start - 1] : ' ';
      if (CMD_WORDS.has(s) && /\s|;|^/.test(prev)) {
        span('k-cmd', s);
      } else {
        flushText(s);
      }
      continue;
    }

    // ── número isolado ──────────────────────────────
    if (/[0-9]/.test(ch) && (i === 0 || /\s/.test(raw[i - 1]))) {
      let s = '';
      while (i < len && /[0-9.]/.test(raw[i])) s += raw[i++];
      // não colore IPs como números; só emite
      flushText(s);
      continue;
    }

    // ── qualquer outra coisa ─────────────────────────
    out.push(raw[i] === '<' ? '&lt;' : raw[i] === '>' ? '&gt;' : raw[i] === '&' ? '&amp;' : raw[i]);
    i++;
  }

  return out.join('');
}
