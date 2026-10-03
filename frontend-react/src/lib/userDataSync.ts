// ════════════════════════════════════════════════
// SINCRONIZAÇÃO DE DADOS DO USUÁRIO ENTRE NAVEGADORES/DISPOSITIVOS — porta
// de js/user-sync.js (nunca portado em nenhuma fatia anterior até agora;
// escopo novo aprovado pelo usuário na fatia 8).
//
// Mecanismo (idêntico ao original): um monkey-patch único em
// Storage.prototype.setItem intercepta TODA escrita em localStorage feita
// pelo app (de qualquer hook) e, quando a chave é uma das "sincronizadas"
// (isUserSyncedKey), agenda um PUT /api/user-data debounced (400ms) com o
// valor novo. Os 3 hooks que gravam nessas chaves (useSettings::
// persistSettings, usePersonalTheme::setTheme/setAccent,
// useSearchHistory::saveRaw) TODOS chamam localStorage.setItem(...)
// diretamente — um único patch no protótipo basta para capturar os três,
// sem precisar tocar na lógica de escrita de nenhum deles (mesma técnica
// do original, não uma reinvenção com callbacks espalhados).
//
// Na outra direção (boot), initUserDataSync() busca o que o SERVIDOR tem
// (GET /api/user-data) e semeia o localStorage local com esses valores —
// usando a função ORIGINAL (não-patchada) de setItem, pra não ecoar de
// volta um PUT dos próprios dados que acabou de receber do servidor — e
// dispara um StorageEvent sintético por chave escrita, pra que os hooks já
// montados (que agora escutam 'storage', ver theme.ts/searchHistory.ts/
// settingsStore.ts) releiam e resincronizem seu estado React. Isso
// substitui fielmente reapplyAfterUserSync() do original, de forma
// idiomática a React (sem precisar de um render() manual).
// ════════════════════════════════════════════════
import { useEffect, useRef } from 'react';
import { fetchUserData, putUserData } from './api';
import { useAuth } from './auth';

// Mesmos valores do original — NÃO inclui 'cpa-accent' (só 'cpa-theme').
// Os dois prefixos de histórico foram conferidos contra o literal usado de
// fato pelos dois lugares que chamam useSearchHistory(...) nesta Fase 3
// (QueryBar.tsx e CmdSearchBox.tsx: 'cpa-query-history' e
// 'cpa-cmdsearch-history', sem o ":user" — isso é concatenado dentro do
// próprio hook) — coincidem com os prefixos do original, então nenhuma
// adaptação foi necessária.
const USER_SYNCED_KEYS = new Set(['cpa-settings', 'cpa-theme']);
const USER_SYNCED_KEY_PREFIXES = ['cpa-query-history:', 'cpa-cmdsearch-history:'];

export function isUserSyncedKey(key: string): boolean {
  return USER_SYNCED_KEYS.has(key) || USER_SYNCED_KEY_PREFIXES.some(p => key.startsWith(p));
}

// Referência à função ORIGINAL (não-patchada) de setItem — guardada ANTES
// de instalar o patch, exatamente como `_origLSSetItem` no original.
// Também usada por initUserDataSync() pra semear sem reentrar no patch.
const origSetItem = Storage.prototype.setItem;

let pendingUserDataSync: Record<string, string> = {};
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function flushUserDataSync(): void {
  if (!Object.keys(pendingUserDataSync).length) return;
  const payload = pendingUserDataSync;
  pendingUserDataSync = {};
  putUserData(payload).catch(() => {
    // best-effort, igual ao original — uma falha de rede aqui nunca pode
    // interromper o uso do app; o valor já está salvo no localStorage
    // local, só o espelho no servidor que não foi atualizado desta vez.
  });
}

// Instala o monkey-patch uma única vez por carregamento da página — uma
// flag no próprio protótipo (não module-level) garante isso mesmo que este
// módulo seja reavaliado mais de uma vez (HMR em dev, ou StrictMode
// remontando componentes que o importam), sem duplicar o patch nem
// empilhar handlers.
function installPatch(): void {
  const proto = Storage.prototype as Storage & { __cpaPatched?: boolean };
  if (proto.__cpaPatched) return;
  proto.setItem = function (this: Storage, key: string, value: string) {
    origSetItem.call(this, key, value);
    if (isUserSyncedKey(key)) {
      pendingUserDataSync[key] = value;
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushUserDataSync, 400);
    }
  };
  proto.__cpaPatched = true;
  window.addEventListener('beforeunload', flushUserDataSync);
}

// Import side-effect (igual ao original, que rodava initUserSync() solto no
// topo do arquivo) — instala o patch assim que este módulo é importado, não
// só quando o hook abaixo roda. Isso garante que escritas feitas ANTES do
// username resolver (ex.: enquanto auth.loading ainda é true) também sejam
// capturadas, em vez de só a partir do momento em que initUserDataSync()
// de fato chamar a API.
installPatch();

// Busca o que o servidor já tem e semeia o localStorage local — chamada
// uma única vez por sessão, depois que o username resolve (ver
// useUserDataSync() abaixo). Grava cada chave com a função ORIGINAL
// (não-patchada) — gravar com a patchada ecoaria um PUT de volta pro
// servidor dos mesmos dados que acabou de vir DELE — e dispara um
// StorageEvent sintético por chave, pra notificar qualquer hook já montado
// que esteja escutando 'storage' nesta mesma aba (o evento nativo do
// browser só dispara em OUTRAS abas; disparando manualmente aqui, o mesmo
// listener serve os dois casos).
//
// `_username` não é usado no corpo (GET/PUT /api/user-data são escopados
// pela sessão/cookie, não por um parâmetro explícito) — mantido na
// assinatura só pelo paralelo com CURRENT_USER no original e porque quem
// chama (useUserDataSync() em AppShell.tsx) só deve disparar isto depois
// que o username já resolveu, então exigir o argumento aqui também deixa
// essa precondição visível no próprio tipo da função.
export async function initUserDataSync(_username: string): Promise<void> {
  let data: Record<string, string>;
  try {
    data = await fetchUserData();
  } catch {
    return; // best-effort — sem dados do servidor, segue só com o que já havia local
  }
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    origSetItem.call(localStorage, key, value);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, storageArea: localStorage }));
  }
}

// Monta a MESMA chamada de initUserDataSync() uma única vez por sessão —
// guardada via useRef (não um useEffect com `[]` sozinho, porque aqui
// precisamos esperar auth.loading virar false antes de disparar, o que
// pode levar mais de um render). Chamado de dentro de AppShell.tsx, no
// mesmo nível de useLogo()/ConfirmProvider/etc. O monkey-patch em si (ver
// installPatch() acima) já foi instalado na importação deste módulo —
// este hook só cuida da ponta de SEED (servidor -> local), não da
// instalação do patch.
export function useUserDataSync(): void {
  const auth = useAuth();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    if (auth.loading || !auth.me?.username) return;
    startedRef.current = true;
    initUserDataSync(auth.me.username);
  }, [auth.loading, auth.me?.username]);
}
