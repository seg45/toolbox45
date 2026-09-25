// ════════════════════════════════════════════════
// SINCRONIZAÇÃO POR USUÁRIO (multiusuário)
// Identifica o usuário atual (sessão local ou Google — ver server/index.js)
// e sincroniza suas preferências (tema, configurações, históricos) com o
// servidor, para que a mesma pessoa tenha os mesmos dados em qualquer
// navegador/máquina onde acesse a aplicação.
//
// Estratégia: localStorage continua sendo a fonte "instantânea" usada por
// theme.js/settings.js/query-bar.js (evita a tela piscar enquanto a rede não
// respondeu) — mas ao carregar a página ela é semeada com o que o servidor
// tem para este usuário, e toda escrita nas chaves relevantes é replicada de
// volta ao servidor (best-effort, silenciosa). Folders são um caso à parte
// (ver folders.js): vivem só no servidor, sem cache local, porque são um
// recurso privado por usuário sem necessidade de pintura instantânea.
//
// Este script é o PRIMEIRO <script> da página para que a requisição ao servidor
// comece o quanto antes — mas como fetch() é assíncrono, os demais scripts (que
// definem applyTheme/etc.) já terão rodado por completo antes da resposta
// chegar, então é seguro chamá-los de volta aqui.
// ════════════════════════════════════════════════
const USER_SYNCED_KEYS = new Set(['cpa-settings', 'cpa-theme']);
// Os dois históricos (busca de comandos / parâmetros) agora usam uma chave
// DINÂMICA por usuário — 'cpa-query-history:<username>' / 'cpa-cmdsearch-
// history:<username>' (ver js/query-bar.js e js/folders.js) — em vez da
// chave fixa antiga, pra impedir que o histórico de um usuário apareça
// pra outro que faça login local (js/auth.js) no mesmo navegador. Por
// isso a checagem abaixo usa prefixo em vez de comparar a chave inteira.
const USER_SYNCED_KEY_PREFIXES = ['cpa-query-history:', 'cpa-cmdsearch-history:'];
function isUserSyncedKey(key) {
  return USER_SYNCED_KEYS.has(key) || USER_SYNCED_KEY_PREFIXES.some(p => key.startsWith(p));
}

let CURRENT_USER = null;

// Nota: sobrescrever localStorage.setItem por atribuição direta (localStorage.setItem = fn)
// NÃO funciona de forma confiável — Storage é um objeto especial (named properties),
// então a atribuição direta é ignorada silenciosamente. A forma correta e portável é
// sobrescrever o método no PROTÓTIPO compartilhado (Storage.prototype), que todo
// navegador resolve normalmente via a cadeia de protótipos.
const _origLSSetItem = Storage.prototype.setItem;
let _pendingUserDataSync = {};
let _userDataSyncTimer = null;
Storage.prototype.setItem = function (key, value) {
  _origLSSetItem.call(this, key, value);
  if (isUserSyncedKey(key)) {
    _pendingUserDataSync[key] = value;
    clearTimeout(_userDataSyncTimer);
    _userDataSyncTimer = setTimeout(flushUserDataSync, 400);
  }
};
function flushUserDataSync() {
  if (!Object.keys(_pendingUserDataSync).length) return;
  const payload = _pendingUserDataSync;
  _pendingUserDataSync = {};
  fetch('/api/user-data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {}); // best-effort: a UI local já foi atualizada via localStorage
}
window.addEventListener('beforeunload', flushUserDataSync);

// Recebe o texto já resolvido pra exibir (handle, de preferência — ver
// chamador abaixo) — esta função só põe no DOM, não decide o quê mostrar.
function renderCurrentUserUI(label) {
  const el = document.getElementById('currentUserLabel');
  if (el) el.textContent = label || '';
}

// Reaplica, ao vivo, tudo que os módulos já carregaram de forma síncrona a partir
// do localStorage "frio" (antes da resposta do servidor chegar) — chamado uma vez,
// assim que os dados reais do usuário chegam, para não atrasar a primeira pintura
// da tela esperando essa requisição.
//
// Precisa ser `async` e usar `await` no reloadFoldersFromServer() abaixo —
// bug reportado: "com a home page definida com a folders nenhum comando nem
// pasta são carregados". Causa: depois do fix de VIEW_FOLDERS_HOME (ver
// applyDefaultsFromSettings() em settings.js), quando a Home page é
// "Folders" a tela entra direto no ramo VIEW_FOLDERS_HOME de render.js, que
// usa a variável global FOLDERS (js/folders.js) pra montar as seções. Antes
// deste fix, reloadFoldersFromServer() era disparado (fetch assíncrono, sem
// aguardar) e o render() logo em seguida rodava ANTES do fetch resolver —
// com FOLDERS ainda vazio ([], valor inicial em folders.js), o ramo
// VIEW_FOLDERS_HOME monta 0 seções e a função de combo retorna '' (ver
// render.js: "if (!folderGroups) return '';"), deixando a tela em branco
// até reloadFoldersFromServer() completar e chamar render() de novo por
// conta própria — o que deveria acontecer, mas na prática ficava sujeito a
// condição de corrida (o próprio render() daqui também é assíncrono, por
// causa do fetchCommands() dentro dele, então a ordem de quem termina
// primeiro não era garantida). Aguardar aqui garante que FOLDERS já está
// populado (ou definitivamente vazio, se o fetch falhar — reloadFoldersFromServer
// trata esse erro internamente) antes do render() final rodar.
async function reapplyAfterUserSync() {
  // BUG relatado pelo usuário: "ao trocar o tema default em systems
  // somente a tela de login está sendo alterada para os usuários que não
  // definiram o tema". Causa raiz: esta função reaplicava o tema com
  // `localStorage.getItem('cpa-theme') || 'light'` — fallback FIXO em
  // 'light', diferente do fallback pro default do admin já usado em
  // initTheme() (js/theme.js, `_cpaOrgDefault('cpa-org-theme', 'light')`)
  // e em _appearanceBoot() (js/appearance-settings.js). Pior: applyTheme()
  // sempre PERSISTE em 'cpa-theme' (é o que a torna útil pro toggle Dark
  // mode de verdade) — então, todo carregamento da página, um usuário SEM
  // preferência pessoal tinha 'cpa-theme'='light' gravado aqui como se
  // fosse uma escolha pessoal de verdade, vindo do 'light' fixo acima. A
  // partir daí ele passava a "ter" preferência pessoal (mesmo nunca tendo
  // tocado no toggle), e tanto _cpaOrgDefault() (initTheme) quanto o novo
  // fallback ao vivo de _appearanceBoot() passavam a ignorá-lo pra sempre
  // — só a tela de login (que nunca olha preferência pessoal) continuava
  // acompanhando trocas do default do admin.
  //
  // Fix: só reaplica/persiste tema aqui quando existe preferência PESSOAL
  // de verdade — já estava salva neste navegador, ou acabou de chegar do
  // servidor agora mesmo (Object.keys(data).forEach acima, ex.: usuário
  // abrindo num navegador novo mas que já tinha escolhido tema em outro).
  // Sem preferência pessoal, não faz nada aqui — o tema já foi aplicado
  // corretamente por initTheme()/_appearanceBoot() a partir do default do
  // admin, e essa é a fonte que deve continuar valendo.
  if (typeof applyTheme === 'function') {
    let personalTheme = null;
    try { personalTheme = localStorage.getItem('cpa-theme'); } catch (e) {}
    if (personalTheme) {
      applyTheme(personalTheme);
      if (typeof syncThemeToggleUI === 'function') syncThemeToggleUI(personalTheme);
    }
  }
  if (typeof applyDefaultsFromSettings === 'function') applyDefaultsFromSettings();
  if (typeof reloadFoldersFromServer === 'function') await reloadFoldersFromServer();
  if (typeof render === 'function') render();
}

// Busca /api/me com UMA tentativa extra se a primeira falhar — bug
// reportado: "botão logout não aparece para usuário local", mesmo após
// login local bem-sucedido e containers recém reconstruídos. Investigação:
// a lógica de login/sessão/`/api/me` está correta (testada isoladamente
// contra um Postgres real simulando login → sessão → checagem do botão,
// inclusive casos de borda como sessão expirada/usuário desabilitado — ver
// test_local_login_authmethod.js). O sintoma relatado (linha de role/
// método VAZIA no dropdown, não só o botão Log out sumindo) só acontece
// quando este catch abaixo é executado (fetch()/`.json()` falhando) —
// deixando os elementos no estado "cru" do HTML (vazio/display:none) sem
// nenhuma indicação de erro. Isso bate com o cenário de logo após um
// rebuild: nginx pode responder com um 502/503 (corpo não-JSON, então
// `.json()` lança) enquanto o container do backend ainda está terminando
// de subir — mesma margem de segurança que já existe em server/db.js
// (initDb() tenta reconectar ao Postgres por até ~60s). Uma única
// retentativa aqui, com um pequeno atraso, cobre esse caso sem precisar de
// reload manual da página.
//
// (Havia aqui também um retry específico para authMethod==='anonymous',
// ligado à instabilidade conhecida do login do Windows/NTLM atrás do proxy
// reverso — removido junto com o NTLM: GET /api/me nunca mais devolve
// 'anonymous' com 200, só 401, tratado à parte abaixo.)
async function fetchMeWithRetry() {
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const meRes = await fetch('/api/me');
      if (meRes.status === 401) {
        // Sessão inválida/expirada no servidor (cookie tb45_session vencido
        // ou nunca existiu) mas a marca 'cpa-authenticated' ainda estava no
        // localStorage — ver LOGIN_FLAG_KEY em js/auth.js/js/login.js.
        // GET /api/me agora EXIGE sessão local ou Google (removido o login
        // do Windows/NTLM que antes sempre identificava "alguém" mesmo sem
        // login algum — ver o gate de login obrigatório em
        // server/index.js) — trata isso como "precisa logar de novo", não
        // como erro transitório: limpa a marca e manda direto pra
        // login.html, sem gastar a outra tentativa/retry abaixo.
        try { localStorage.removeItem('cpa-authenticated'); } catch (e) { /* ver comentário equivalente no gate de index.html */ }
        location.replace('login.html');
        return new Promise(() => {}); // nunca resolve — a navegação acima já está em andamento
      }
      if (!meRes.ok) throw new Error(`/api/me respondeu ${meRes.status}`);
      return await meRes.json();
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) throw e;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
}
// Raiz do bug "continuo com problema de exibição do menu de admin. tenho
// que ficar atualizando a página várias vezes para aparecer": confirmado
// via DevTools (o usuário mandou o Response de /api/me) que o servidor JÁ
// respondia isAdmin:true corretamente — o retry acima não era o problema.
// O bug real está aqui: js/user-sync.js é o PRIMEIRO <script> da página
// (de propósito, pra começar o fetch cedo — ver comentário no topo do
// arquivo), mas js/auth.js — onde updateAccountUI()/applyAdminGating()
// são DEFINIDAS — é o PENÚLTIMO. Em conexões rápidas (intranet local), a
// resposta de /api/me às vezes chega ANTES do navegador terminar de
// carregar/executar todos os <script src> entre user-sync.js e auth.js;
// naquele momento `typeof updateAccountUI === 'function'` dá false, o `if`
// abaixo não chama nada, e como nada mais nesta página re-tenta depois,
// o menu de admin fica faltando pro resto daquele carregamento — só um F5
// (nova corrida, às vezes ganha) resolve. safeUpdateAccountUI() cobre essa
// janela: se a função ainda não existir agora, tenta de novo no evento
// 'load' da janela — que só dispara depois que TODOS os <script> da
// página já rodaram (garantia da própria especificação do HTML, ao
// contrário do timing do fetch acima), então essa 2ª tentativa é 100%
// confiável.
function safeUpdateAccountUI(me) {
  if (typeof updateAccountUI === 'function') { updateAccountUI(me); return true; }
  return false;
}
async function initUserSync() {
  try {
    const me = await fetchMeWithRetry();
    CURRENT_USER = me.username; // identidade REAL (username/e-mail) — usada em todo o app pras comparações "isOwn"/posse; nunca muda
    // No header mostramos o HANDLE (ver users.handle em server/schema.sql),
    // não o username/e-mail — pedido do usuário: "mude para exibir o nome
    // do usuário" (o "nome de usuário" da feature de compartilhamento,
    // trocável em Settings → System → Sharing). Fallback pro username só
    // pro caso (não deveria acontecer numa sessão de navegador normal) de
    // `handle` vir nulo.
    renderCurrentUserUI(me.handle || me.upn || me.username);
    if (!safeUpdateAccountUI(me)) {
      window.addEventListener('load', () => safeUpdateAccountUI(me), { once: true });
    }
  } catch (e) {
    console.warn('Não foi possível identificar o usuário atual', e);
    renderCurrentUserUI(null);
    // Antes disto o dropdown de conta ficava com a linha de role/método em
    // branco e SEM nenhuma pista de que algo falhou — indistinguível, pro
    // usuário, de "Log out não aparece porque a sessão não é local".
    // Mostrar um aviso explícito (e um jeito de tentar de novo sem F5) deixa
    // o problema óbvio em vez de silencioso.
    const roleLine = document.getElementById('hdrUserRoleLine');
    if (roleLine) roleLine.textContent = 'Could not verify your account — reload the page to try again.';
  }

  try {
    const dataRes = await fetch('/api/user-data');
    const data = await dataRes.json();
    Object.keys(data).forEach(k => {
      if (data[k] != null) _origLSSetItem.call(localStorage, k, data[k]);
    });
  } catch (e) {
    console.warn('Não foi possível sincronizar preferências do usuário — usando cópia local', e);
  }

  // Espera os catálogos de Versão/Ambiente/Tópico (js/catalogs.js) ficarem prontos
  // antes do primeiro render() de verdade (disparado dentro de
  // reapplyAfterUserSync) — sem isso, o primeiro render poderia rodar com
  // VERSION_KEYS/ENV_KEYS/TYPE_KEYS ainda nos valores estáticos do HTML.
  if (window.CATALOGS_READY) {
    try { await window.CATALOGS_READY; } catch (e) {}
  }

  reapplyAfterUserSync();
}
initUserSync();
