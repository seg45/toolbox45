// index.js — Express app: expõe SÓ a API REST /api/* (PostgreSQL via
// server/db.js, node-postgres). Não serve mais o frontend estático — isso
// agora é responsabilidade do container toolbox45-frontend (nginx), que
// também faz proxy reverso de /api/* para este backend (toolbox45-backend)
// — ver docker-compose.yml e frontend/nginx.conf. O browser nunca fala
// direto com este processo.
//
// Autenticação/identificação de quem está chamando a API, em ordem de
// prioridade:
//   1) Header `X-API-Key` — acesso programático externo (integrações,
//      scripts). Ver api_keys em schema.sql e a seção "API keys" abaixo.
//   2) Sessão (cookie `tb45_session`) — login local (usuário/senha) OU
//      login com Google (OAuth) — ver "Login local e usuários" e "Login com
//      Google" abaixo. `users.auth_provider` distingue os dois, mas ambos
//      usam a MESMA sessão/cookie.
// Sem API key nem sessão válida, a chamada é recusada (401 unauthorized) —
// pedido do usuário: "deixar somente autenticação local e com Google" (o
// login do Windows/NTLM que existia aqui foi removido; ver o middleware de
// autenticação obrigatória logo abaixo do de sessão). Rotas públicas
// (health check, as próprias telas/fluxos de login) estão explicitamente
// isentas — ver REQUIRE_AUTH_PUBLIC_ROUTES abaixo.
//
// Regra de PERMISSÃO (atualizada — pedido do usuário):
//   - EDITAR (PUT /api/commands/:id): qualquer usuário autenticado pode
//     editar o PRÓPRIO comando OU um comando de referência
//     (created_by='System'). Não pode editar o comando de OUTRO usuário —
//     precisa duplicar (POST normal) e editar a cópia.
//   - EXCLUIR (DELETE /api/commands/:id): um usuário comum só exclui o
//     PRÓPRIO comando; comandos System ou de outro usuário exigem admin.
//   - Pastas (folders) seguem a mesma lógica de "só o dono, admin faz tudo"
//     (ver PUT/DELETE /api/folders/:id abaixo) — não existe pasta "System",
//     então aqui não há exceção equivalente.
// Admins não têm nenhuma dessas restrições (podem editar/excluir qualquer
// comando ou pasta). `modified_by` sempre registra quem fez a última
// alteração, e toda criação/edição/exclusão relevante fica no audit_log
// (ver logAudit()).
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const { pool, initDb, withTransaction, getConnectionString } = require('./db');
const { hashPassword, verifyPassword, generateSessionToken } = require('./auth');

const app = express();

const PORT = process.env.PORT || process.env.HTTP_PORT || 3000;

// Limite maior que o padrão do Express (100kb) para caber o payload de um
// comando com uma ou mais linhas de imagem (screenshots de configuração,
// ver command_lines.image_data em schema.sql) — a imagem viaja em base64
// dentro do JSON, ~33% maior que o arquivo original.
app.use(express.json({ limit: '15mb' }));

// Healthcheck simples e público (sem auth) — usado pelo HEALTHCHECK do
// Dockerfile/docker-compose.yml para o toolbox45-frontend só iniciar
// (depends_on condition:service_healthy) depois que este processo já
// terminou o boot (initDb() + ensureTlsBootstrap(), ver o final deste
// arquivo) — sem isso, o frontend podia tentar escutar na porta 443 antes
// do certificado autoassinado default existir no volume compartilhado.
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ════════════════════════════════════════════════
// API keys — autenticação para acesso programático externo (ver api_keys em
// schema.sql e a seção CRUD mais abaixo). Verificado ANTES de qualquer
// sessão — uma chamada com X-API-Key nunca depende de cookie/login.
// ════════════════════════════════════════════════
function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}
function generateApiKey() {
  // Prefixo "tb45_" (Toolbox45) só facilita reconhecer o tipo de segredo em
  // logs/scanners — o valor que importa é o restante, aleatório (32 bytes).
  return 'tb45_' + crypto.randomBytes(32).toString('hex');
}
async function authenticateApiKey(rawKey) {
  const hash = hashApiKey(rawKey);
  // expires_at IS NULL => "Never" (nunca expira); do contrário só autentica
  // enquanto expires_at ainda estiver no futuro (ver api_keys.expires_at em
  // schema.sql e a validade escolhida em POST /api/api-keys abaixo).
  const { rows } = await pool.query(
    `SELECT * FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
    [hash]
  );
  if (!rows.length) return null;
  // Best-effort — não bloqueia a resposta por causa disso.
  pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [rows[0].id]).catch(() => {});
  return rows[0];
}

app.use(async (req, res, next) => {
  const provided = req.headers['x-api-key'];
  if (!provided) return next();
  try {
    const keyRow = await authenticateApiKey(String(provided));
    if (!keyRow) return res.status(401).json({ error: 'invalid_api_key', message: 'Invalid, revoked, or expired API key' });
    req.apiKey = keyRow;
    req.currentUser = `api:${keyRow.name}`;
    next();
  } catch (err) {
    console.error('API key auth failed:', err);
    res.status(500).json({ error: 'internal_error', message: 'Failed to validate API key' });
  }
});

// ════════════════════════════════════════════════
// Sessão (cookie `tb45_session`) — login local (usuário/senha) OU login com
// Google; ver users/sessions em schema.sql e server/auth.js. Mesma tabela/
// cookie para os dois — só `users.auth_provider` diz qual foi (ver login
// com Google mais abaixo).
// ════════════════════════════════════════════════
const SESSION_COOKIE_NAME = 'tb45_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function setSessionCookie(res, token) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

app.use(async (req, res, next) => {
  if (req.currentUser) return next(); // já autenticado por API key acima
  const token = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!token) return next();
  try {
    const { rows } = await pool.query(
      `SELECT s.username, u.role, u.disabled, u.auth_provider FROM sessions s
       JOIN users u ON u.username = s.username
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    if (rows.length && !rows[0].disabled) {
      req.currentUser = rows[0].username;
      req.userRole = rows[0].role;
      // Sessão local (usuário/senha) e sessão Google usam a MESMA tabela
      // sessions/o MESMO cookie tb45_session — só users.auth_provider diz
      // qual dos dois foi (ver login com Google abaixo e getAuthMethod()).
      req.authMethod = rows[0].auth_provider === 'google' ? 'google' : 'local';
    }
  } catch (err) {
    console.error('Session lookup failed:', err);
  }
  next();
});

// ════════════════════════════════════════════════
// Login obrigatório — pedido do usuário: "deixar somente autenticação local
// e com Google" (removeu o login do Windows/NTLM que existia aqui, e o
// fallback dev x-dev-user/usuário do SO que valia quando ele estava
// desligado). Sem isso, uma chamada sem API key nem sessão válida seria
// identificada como um usuário "convidado" qualquer e tratada como
// legítima — o próprio buraco que "somente local e Google" pede pra
// fechar. `REQUIRE_AUTH_PUBLIC_ROUTES` é a única exceção: as rotas que
// PRECISAM funcionar sem sessão (senão ninguém conseguiria logar) — health
// check e o fluxo de login em si (local e Google). Tudo o mais exige
// req.currentUser já resolvido pelos middlewares acima (API key ou sessão).
// ════════════════════════════════════════════════
const REQUIRE_AUTH_PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/auth/providers',
  'GET /api/auth/google',
  'GET /api/auth/google/callback',
]);
app.use((req, res, next) => {
  if (req.currentUser) return next(); // já autenticado por API key ou sessão (acima)
  if (REQUIRE_AUTH_PUBLIC_ROUTES.has(`${req.method} ${req.path}`)) return next();
  res.status(401).json({ error: 'unauthorized', message: 'Login required' });
});
function getCurrentUsername(req) {
  // req.currentUser está SEMPRE resolvido aqui (API key ou sessão local/
  // Google) — o middleware de login obrigatório acima já barrou (401)
  // qualquer chamada que chegasse até uma rota de negócio sem isso.
  return req.currentUser;
}
// ════════════════════════════════════════════════
// AUDIT LOG — uma linha por criação/edição/exclusão feita por um usuário, em
// QUALQUER entidade organizacional (comandos, pastas, notas, catálogos de
// Vendor/System/Version/Environment/Topic/Parameter, usuários, API keys —
// ver audit_log em schema.sql). Chamado em cada rota POST/PUT/DELETE
// relevante abaixo. `details` é um resumo curto de O QUE foi feito (ex.:
// "Changed: name, topic" numa edição de comando, "Renamed from X to Y" numa
// pasta) — pedido do usuário: "registrar... inclusive o que foi feito".
// Deliberadamente FORA do escopo deste log: preferências pessoais por
// usuário (tema, buscas recentes, filtros — PUT /api/user-data/
// /api/global-settings) e reordenar itens dentro de uma pasta (drag-and-
// drop) — mudam a cada interação trivial da UI, e logar cada uma inundaria
// o log de auditoria (limite de 1000 linhas/30 dias) sem agregar sinal de
// segurança/rastreabilidade real.
// Retenção de 30 dias: toda gravação também apaga linhas mais antigas que
// isso, sem precisar de job/cron separado.
// ════════════════════════════════════════════════
const AUDIT_LOG_RETENTION_DAYS = 30;
// Nome fixo da pasta padrão criada automaticamente pra todo usuário (ver
// ensureDefaultFolder() abaixo e o backfill em server/db.js::runMigrations()).
// PUT/DELETE /api/folders/:id recusam alterar essa pasta — pedido do
// usuário: "a pasta Favorites do sistema não pode ser alterada o nome nem
// excluída". Como UNIQUE(username, name) garante no máximo UMA pasta com
// esse nome por usuário, e ela só é criada pelo próprio backend (nunca por
// um POST do usuário renomeando algo pra "Favorites" depois — nesse caso já
// existiria e o INSERT bateria em 409), o nome sozinho identifica a pasta
// protegida sem precisar de uma coluna extra tipo `is_protected`.
const FAVORITES_FOLDER_NAME = 'Favorites';

// Sobe a cadeia de parent_id até achar a pasta de TOPO (raiz) da árvore de
// uma pasta — usado pra validar "arrastar comando/nota/subpasta para dentro
// ou fora de uma subpasta, mas sem deixar sair da pasta-mãe" (pedido do
// usuário): tanto a origem quanto o destino de um "mover" (PUT
// /api/folders/:id/move, PUT /api/notes/:id/move abaixo) precisam resolver
// pra MESMA raiz. Limite de 100 saltos só por segurança (nunca deveria
// ciclar de verdade — POST /api/folders já valida posse do pai na criação,
// e o próprio PUT /api/folders/:id/move abaixo recusa criar um ciclo).
async function getRootAncestorId(folderId) {
  let current = folderId;
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query('SELECT parent_id FROM folders WHERE id = $1', [current]);
    if (!rows.length || rows[0].parent_id === null) return current;
    current = rows[0].parent_id;
  }
  return current;
}
async function logAudit(username, action, entityType, entityId, entityName, details) {
  try {
    await pool.query(
      'INSERT INTO audit_log (username, action, entity_type, entity_id, entity_name, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [username || null, action, entityType || 'command', entityId || null, entityName || null, details || null]
    );
    await pool.query(`DELETE FROM audit_log WHERE ts < NOW() - INTERVAL '${AUDIT_LOG_RETENTION_DAYS} days'`);
  } catch (e) {
    console.error('logAudit failed:', e);
  }
}
// Compara campos escalares de duas versões de uma entidade e devolve um
// resumo tipo "Changed: name, topic" com os RÓTULOS (não os valores — texto
// livre como "about_obs"/descrição de nota pode ser longo, e o valor em si
// já não importa tanto quanto SABER que aquele campo mudou) dos campos cujo
// valor mudou. `fieldLabels` é um objeto { chave: 'Rótulo' }. Retorna null
// quando nada mudou (evita um details vazio/enganoso tipo "Changed: ").
function summarizeChangedFields(before, after, fieldLabels) {
  const changed = [];
  for (const [key, label] of Object.entries(fieldLabels)) {
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    const na = a === undefined || a === null ? '' : String(a);
    const nb = b === undefined || b === null ? '' : String(b);
    if (na !== nb) changed.push(label);
  }
  return changed.length ? `Changed: ${changed.join(', ')}` : null;
}

// ════════════════════════════════════════════════
// Permissões (users.role) — ver users/sessions em schema.sql. Toda conta
// nova (local, criada por um admin, ou Google, provisionada sozinha no
// primeiro login — ver login com Google mais abaixo) começa com
// role='user'; só um admin promove depois (Settings → System → Manage
// users). API keys continuam com acesso total (bypass deste gate) — são um
// canal de integração externa separado, já protegido pela posse da própria
// key. Instalações antigas podem ainda ter contas com auth_provider='ntlm'
// (do login do Windows, removido — ver histórico) listadas em Manage
// users; um admin pode desabilitá-las/excluí-las quando não forem mais
// necessárias.
// ════════════════════════════════════════════════
// Garante que TODO usuário tenha uma pasta "Favorites" desde o primeiro
// momento (pedido do usuário: "definir como padrão que todos usuários
// tenham as pastas Favoritos") — chamada logo após criar a linha em `users`
// pela primeira vez, tanto pra contas locais (criadas por um admin em
// POST /api/users) quanto pra contas Google (auto-provisionadas no 1º
// login — ver login com Google mais abaixo). `ON CONFLICT (username, name)
// DO NOTHING` (mesma
// constraint única já usada pela migração legada de favoritos, ver
// server/db.js) torna isto seguro mesmo sob corrida entre abas/instâncias —
// nunca duplica a pasta, e não falha se ela já existir (ex.: usuário que já
// tinha renomeado/recriado a própria "Favorites" antes). Usuários já
// existentes na instalação (de antes deste recurso existir) recebem a
// pasta via backfill em runMigrations() (server/db.js), não aqui.
async function ensureDefaultFolder(username) {
  try {
    await pool.query(
      `INSERT INTO folders (username, name) VALUES ($1, 'Favorites') ON CONFLICT (username, name) DO NOTHING`,
      [username]
    );
  } catch (err) {
    console.error('[folders] Falha ao garantir pasta Favorites padrão para', username, err.message);
  }
}

async function getCurrentRole(req) {
  // Ver api_keys.role em schema.sql — keys criadas antes deste campo existir
  // ficam com o DEFAULT 'admin' (mesmo acesso total de sempre); keys novas
  // escolhem 'admin' ou 'user' na criação (ver POST /api/api-keys abaixo).
  if (req.apiKey) return req.apiKey.role || 'admin';
  // Sempre já resolvido pelo middleware de sessão local/Google acima — o
  // gate de login obrigatório (ver comentário lá) garante que uma rota de
  // negócio só é alcançada com API key OU sessão válida, nunca sem
  // nenhuma das duas.
  return req.userRole || 'user';
}

async function requireAdmin(req, res, next) {
  try {
    const role = await getCurrentRole(req);
    if (role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Admin role required for this action' });
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
}

// Impede que uma ação deixe a aplicação sem NENHUM admin habilitado (evita
// lockout total — sem um admin, ninguém mais consegue acessar Manage users
// para corrigir isso). `excludeUsername` é o usuário sendo rebaixado/
// desabilitado/excluído — não conta ele mesmo na checagem.
async function countEnabledAdmins(excludeUsername) {
  const sql = "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0" + (excludeUsername ? ' AND username != $1' : '');
  const { rows } = await pool.query(sql, excludeUsername ? [excludeUsername] : []);
  return Number(rows[0].n);
}

// ════════════════════════════════════════════════
// Login/logout local (usuário/senha) — ver seção de cookie/sessão acima.
// Quem já tem uma sessão ativa (local ou Google) pode fazer login com uma
// conta local diferente a qualquer momento — isso simplesmente troca qual
// sessão está ativa nesta aba/navegador.
// ════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'validation_error', message: '"username" and "password" are required' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND is_local = 1', [String(username).trim()]);
    const user = rows[0];
    if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Invalid username or password' });
    }
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query('INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, $3)', [token, user.username, expiresAt]);
    setSessionCookie(res, token);
    res.json({ username: user.username, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE_NAME];
    if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Login com Google (OAuth 2.0 Authorization Code) — pedido do usuário:
// "crie integração para permitir autenticação com google. o usuário poderá
// logar com a conta do google". Mesma sessão local de sempre por baixo
// (cookie `tb45_session`, tabela `sessions`) — só o jeito de CHEGAR nela é
// diferente; users.auth_provider ('google') é o que distingue uma conta
// Google de uma conta local por senha (ver middleware de sessão acima e
// getAuthMethod()). Sem restrição de domínio Google Workspace (decisão do
// usuário) — qualquer conta Google pode tentar entrar; a primeira vez que um
// e-mail aparece, uma conta é criada automaticamente com role 'user'
// (decisão do usuário) — um admin promove depois em Manage users.
//
// Só usa `fetch`/`crypto` nativos do Node (sem SDK do Google) — mesma
// filosofia de server/auth.js (evitar dependência nova/binário nativo na
// imagem Docker). Verificação de identidade não depende de validar a
// assinatura de um ID token: o e-mail/perfil vem de uma chamada HTTPS
// SERVIDOR-A-SERVIDOR direto ao Google (userinfo endpoint, autenticada com
// o access_token que acabamos de trocar pelo `code`) — o navegador nunca
// manipula esse dado, então já é confiável pela própria cadeia HTTPS.
//
// Variáveis de ambiente (mesmo padrão de AD_DOMAIN_CONTROLLER etc. abaixo):
//   GOOGLE_CLIENT_ID      Client ID OAuth do Google Cloud Console
//   GOOGLE_CLIENT_SECRET  Client Secret correspondente
//   GOOGLE_REDIRECT_URI   URL pública EXATA de GET /api/auth/google/callback
//                         (ex.: https://toolbox45.seg45.com.br/api/auth/google/callback)
//                         — precisa bater com o registrado no Google Cloud
//                         Console, caractere por caractere.
// Sem as 3, o login com Google fica desligado (botão escondido no
// login.html via GET /api/auth/providers) — nunca trava a aplicação.
// ════════════════════════════════════════════════
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || null;
const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
// Cookie curto (5min), só durante a ida-e-volta do consentimento do Google —
// protege contra CSRF no callback (state precisa bater com o que foi
// gravado aqui antes do redirect pro Google). Nada sensível dentro dele.
const OAUTH_STATE_COOKIE = 'tb45_oauth_state';

// Público (sem auth) — login.html usa isto pra decidir se mostra o botão
// "Sign in with Google" (ver js/login.js).
app.get('/api/auth/providers', (req, res) => {
  res.json({ google: GOOGLE_ENABLED });
});

app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_ENABLED) {
    return res.status(503).send('Google login is not configured on this server.');
  }
  const state = crypto.randomBytes(24).toString('hex');
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const clearOauthStateCookie = () => {
    res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  };
  // login.html é quem realmente mostra o erro pro usuário (ver
  // _lpHandleGoogleRedirectResult() em js/login.js) — isto aqui é sempre um
  // full-page redirect (veio de accounts.google.com), nunca um fetch, então
  // não dá pra devolver um JSON de erro direto.
  const failure = (reason) => {
    clearOauthStateCookie();
    res.redirect(`/login.html?google=error&reason=${encodeURIComponent(reason)}`);
  };

  if (!GOOGLE_ENABLED) return failure('not_configured');
  const { code, state, error: googleError } = req.query;
  if (googleError) return failure('access_denied');
  const cookieState = parseCookies(req)[OAUTH_STATE_COOKIE];
  if (!state || !cookieState || state !== cookieState) return failure('invalid_state');
  if (!code) return failure('missing_code');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      console.error('[google-auth] token exchange failed:', tokenRes.status, await tokenRes.text().catch(() => ''));
      return failure('token_exchange_failed');
    }
    const tokens = await tokenRes.json();

    // Perfil confirmado com uma chamada autenticada direto ao Google com o
    // access_token recém-obtido — ver comentário no topo desta seção sobre
    // por que isso já é confiável sem verificar assinatura de JWT à parte.
    const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileRes.ok) return failure('profile_fetch_failed');
    const profile = await profileRes.json();

    if (!profile.email || (profile.email_verified !== true && profile.email_verified !== 'true')) {
      return failure('email_not_verified');
    }
    const email = String(profile.email).toLowerCase();

    const { rows: existingRows } = await pool.query('SELECT * FROM users WHERE username = $1', [email]);
    let user = existingRows[0];
    if (user) {
      if (user.auth_provider !== 'google') {
        // Esse username (e-mail) já pertence a uma conta local ou NTLM —
        // recusa entrar "como" ela via Google (evitaria um account takeover
        // se alguém tiver/criar uma conta Google com esse mesmo e-mail).
        return failure('account_exists_other_method');
      }
      if (user.disabled) return failure('account_disabled');
    } else {
      // Primeira vez que este e-mail Google aparece — provisiona
      // automaticamente com role 'user' (decisão do usuário); um admin
      // promove depois em Manage users.
      await pool.query(
        `INSERT INTO users (username, role, is_local, created_by, auth_provider)
         VALUES ($1, 'user', 0, 'google-oauth', 'google')
         ON CONFLICT (username) DO NOTHING`,
        [email]
      );
      await ensureDefaultFolder(email);
      const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [email]);
      user = rows[0];
      if (!user) return failure('provisioning_failed');
    }

    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query('INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, $3)', [token, user.username, expiresAt]);
    clearOauthStateCookie();
    setSessionCookie(res, token);
    res.redirect('/login.html?google=success');
  } catch (err) {
    console.error('[google-auth] callback failed:', err);
    failure('internal_error');
  }
});

// ════════════════════════════════════════════════
// Helpers de leitura de comandos
// ════════════════════════════════════════════════
// `username` é usado só para calcular folder_ids (pastas do usuário ATUAL que
// contêm este comando — pastas são privadas, ver comentário acima de
// GET /api/folders). Opcional: chamadores que não têm um usuário resolvido
// (não deveria acontecer em uso normal, getCurrentUsername sempre devolve
// algo) simplesmente recebem folder_ids: [].
async function shapeCommand(row, username) {
  const [vendorsQ, systemsQ, versionsQ, envQ, topicsQ, folderQ, linesQ] = await Promise.all([
    pool.query('SELECT vendor FROM command_vendors WHERE command_id = $1 ORDER BY vendor', [row.id]),
    pool.query('SELECT system FROM command_systems WHERE command_id = $1 ORDER BY system', [row.id]),
    pool.query('SELECT version FROM command_versions WHERE command_id = $1 ORDER BY version', [row.id]),
    pool.query('SELECT environment FROM command_environments WHERE command_id = $1 ORDER BY environment', [row.id]),
    pool.query('SELECT topic FROM command_topics WHERE command_id = $1 ORDER BY topic', [row.id]),
    username
      ? pool.query(
          `SELECT fc.folder_id FROM folder_commands fc
           JOIN folders f ON f.id = fc.folder_id
           WHERE fc.command_id = $1 AND f.username = $2
           ORDER BY fc.folder_id`,
          [row.id, username]
        )
      : Promise.resolve({ rows: [] }),
    pool.query('SELECT variant, sort_order, line_type, prompt, content, supports_export, image_data FROM command_lines WHERE command_id = $1 ORDER BY variant, sort_order, id', [row.id]),
  ]);

  const vendors = vendorsQ.rows.map(v => v.vendor);
  const systemList = systemsQ.rows.map(s => s.system);
  const versions = versionsQ.rows.map(v => v.version);
  const environments = envQ.rows.map(e => e.environment);
  const topics = topicsQ.rows.map(t => t.topic);
  const folderIds = folderQ.rows.map(f => f.folder_id);

  const shapeLine = l => ({
    line_type: l.line_type,
    prompt: l.prompt,
    content: l.content,
    supports_export: !!l.supports_export,
    image_data: l.image_data || null,
  });

  const lines = {
    default: linesQ.rows.filter(l => l.variant === 'default').map(shapeLine),
    empty: linesQ.rows.filter(l => l.variant === 'empty').map(shapeLine),
  };

  return {
    id: row.id,
    topic: row.topic,
    topics: topics.length ? topics : [row.topic],
    folder_ids: folderIds,
    icon: row.icon,
    sort_order: row.sort_order,
    requires_ip_port: !!row.requires_ip_port,
    placeholder_resolver: row.placeholder_resolver,
    name: row.name,
    name_empty: row.name_empty,
    desc: row.desc,
    desc_empty: row.desc_empty,
    details: row.details,
    vendors,
    systems: systemList,
    versions,
    environments,
    lines,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by || null,
    modified_by: row.modified_by || row.created_by || null,
    is_system: row.created_by === 'System',
  };
}

// Agrupa `rows` (cada um com uma coluna `keyField`) num Map<valor, array de
// linhas> — usado por shapeCommandsBatch() abaixo para distribuir o
// resultado de UMA query batched entre os N comandos que ela cobre, sem
// precisar de uma query por comando.
function _groupRowsBy(rows, keyField) {
  const map = new Map();
  for (const r of rows) {
    const key = r[keyField];
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(r);
  }
  return map;
}

// Versão em lote de shapeCommand() — usada só por GET /api/commands (a
// listagem completa). shapeCommand() faz várias queries (uma por comando) para
// vendors/systems/versions/environments/topics/pastas/lines — ótimo para 1
// comando (GET/POST/PUT /api/commands/:id, que continuam usando
// shapeCommand() normalmente),
// péssimo para a lista inteira: com N comandos vira ~8N+ round-trips ao
// Postgres (N=1452 → mais de 11 mil), competindo pelo pool de conexões
// (server/db.js: max=10) e serializando o que deveria ser meia dúzia de
// queries. Aqui cada tabela relacionada é buscada UMA vez para TODOS os
// comandos de uma vez (`WHERE command_id = ANY($1)`) e distribuída em
// memória — mesmo formato de saída de shapeCommand(), só que O(1) queries
// por tabela em vez de O(N).
async function shapeCommandsBatch(rows, username) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);

  const [vendorsQ, systemsQ, versionsQ, envQ, topicsQ, folderQ, linesQ] = await Promise.all([
    pool.query('SELECT command_id, vendor FROM command_vendors WHERE command_id = ANY($1) ORDER BY command_id, vendor', [ids]),
    pool.query('SELECT command_id, system FROM command_systems WHERE command_id = ANY($1) ORDER BY command_id, system', [ids]),
    pool.query('SELECT command_id, version FROM command_versions WHERE command_id = ANY($1) ORDER BY command_id, version', [ids]),
    pool.query('SELECT command_id, environment FROM command_environments WHERE command_id = ANY($1) ORDER BY command_id, environment', [ids]),
    pool.query('SELECT command_id, topic FROM command_topics WHERE command_id = ANY($1) ORDER BY command_id, topic', [ids]),
    username
      ? pool.query(
          `SELECT fc.command_id, fc.folder_id FROM folder_commands fc
           JOIN folders f ON f.id = fc.folder_id
           WHERE fc.command_id = ANY($1) AND f.username = $2
           ORDER BY fc.command_id, fc.folder_id`,
          [ids, username]
        )
      : Promise.resolve({ rows: [] }),
    pool.query('SELECT command_id, variant, sort_order, line_type, prompt, content, supports_export, image_data FROM command_lines WHERE command_id = ANY($1) ORDER BY command_id, variant, sort_order, id', [ids]),
  ]);

  const vendorsBy = _groupRowsBy(vendorsQ.rows, 'command_id');
  const systemsBy = _groupRowsBy(systemsQ.rows, 'command_id');
  const versionsBy = _groupRowsBy(versionsQ.rows, 'command_id');
  const envBy = _groupRowsBy(envQ.rows, 'command_id');
  const topicsBy = _groupRowsBy(topicsQ.rows, 'command_id');
  const folderBy = _groupRowsBy(folderQ.rows, 'command_id');
  const linesBy = _groupRowsBy(linesQ.rows, 'command_id');

  const shapeLine = l => ({
    line_type: l.line_type,
    prompt: l.prompt,
    content: l.content,
    supports_export: !!l.supports_export,
    image_data: l.image_data || null,
  });

  return rows.map(row => {
    const vendors = (vendorsBy.get(row.id) || []).map(v => v.vendor);
    const systemList = (systemsBy.get(row.id) || []).map(s => s.system);
    const versions = (versionsBy.get(row.id) || []).map(v => v.version);
    const environments = (envBy.get(row.id) || []).map(e => e.environment);
    const topics = (topicsBy.get(row.id) || []).map(t => t.topic);
    const folderIds = (folderBy.get(row.id) || []).map(f => f.folder_id);
    const rowLines = linesBy.get(row.id) || [];
    const lines = {
      default: rowLines.filter(l => l.variant === 'default').map(shapeLine),
      empty: rowLines.filter(l => l.variant === 'empty').map(shapeLine),
    };

    return {
      id: row.id,
      topic: row.topic,
      topics: topics.length ? topics : [row.topic],
      folder_ids: folderIds,
      icon: row.icon,
      sort_order: row.sort_order,
      requires_ip_port: !!row.requires_ip_port,
      placeholder_resolver: row.placeholder_resolver,
      name: row.name,
      name_empty: row.name_empty,
      desc: row.desc,
      desc_empty: row.desc_empty,
      details: row.details,
      vendors,
      systems: systemList,
      versions,
      environments,
      lines,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by || null,
      modified_by: row.modified_by || row.created_by || null,
      is_system: row.created_by === 'System',
    };
  });
}

async function findCommand(id) {
  const { rows } = await pool.query('SELECT * FROM commands WHERE id = $1', [id]);
  return rows[0] || null;
}

// Mantido para compatibilidade com os poucos lugares que só precisam saber SE
// o comando existe (ex.: POST /api/folders/:id/commands/:commandId).
async function getCommandRow(id) {
  return findCommand(id);
}

// ════════════════════════════════════════════════
// GET /api/commands
// ════════════════════════════════════════════════
app.get('/api/commands', async (req, res) => {
  try {
    const { topic, version, environment, vendor, system: systemParam, sort } = req.query;

    let sql = 'SELECT * FROM commands WHERE 1=1';
    const params = [];
    if (topic) {
      params.push(topic);
      // Um comando pode ter vários tópicos (command_topics) — casa se QUALQUER um bater.
      sql += ` AND EXISTS (SELECT 1 FROM command_topics ct WHERE ct.command_id = commands.id AND ct.topic = $${params.length})`;
    }
    if (vendor) {
      params.push(vendor);
      sql += ` AND (
        NOT EXISTS (SELECT 1 FROM command_vendors cv WHERE cv.command_id = commands.id)
        OR EXISTS (SELECT 1 FROM command_vendors cv WHERE cv.command_id = commands.id AND cv.vendor = $${params.length})
      )`;
    }
    if (systemParam) {
      params.push(systemParam);
      sql += ` AND (
        NOT EXISTS (SELECT 1 FROM command_systems cs WHERE cs.command_id = commands.id)
        OR EXISTS (SELECT 1 FROM command_systems cs WHERE cs.command_id = commands.id AND cs.system = $${params.length})
      )`;
    }
    if (version) {
      params.push(version);
      sql += ` AND (
        NOT EXISTS (SELECT 1 FROM command_versions cv WHERE cv.command_id = commands.id)
        OR EXISTS (SELECT 1 FROM command_versions cv WHERE cv.command_id = commands.id AND cv.version = $${params.length})
      )`;
    }
    if (environment) {
      params.push(environment);
      sql += ` AND (
        NOT EXISTS (SELECT 1 FROM command_environments ce WHERE ce.command_id = commands.id)
        OR EXISTS (SELECT 1 FROM command_environments ce WHERE ce.command_id = commands.id AND ce.environment = $${params.length})
      )`;
    }
    // Ordenação padrão é a curatorial (sort_order/id) de sempre. `?sort=creator`
    // reordena a lista por quem cadastrou o comando (created_by).
    sql += (sort === 'creator') ? ' ORDER BY created_by, sort_order, id' : ' ORDER BY sort_order, id';

    const { rows } = await pool.query(sql, params);
    const username = getCurrentUsername(req);
    // shapeCommandsBatch() em vez de Promise.all(rows.map(shapeCommand)) — ver
    // comentário na função: evita ~8 queries POR COMANDO (N+1) nesta listagem
    // completa, que ficou perceptivelmente lenta depois do import de 1452
    // comandos.
    const shaped = await shapeCommandsBatch(rows, username);
    res.json(shaped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// GET /api/commands/:id
// ════════════════════════════════════════════════
app.get('/api/commands/:id', async (req, res) => {
  try {
    const row = await findCommand(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found', message: `Command '${req.params.id}' not found` });
    res.json(await shapeCommand(row, getCurrentUsername(req)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// `authMethod` distingue como esta requisição foi identificada — usado pela
// página de login (login.html/js/login.js) e pelo header (js/auth.js) pra
// saber se a sessão atual é local ou Google. Sob o gate de login
// obrigatório (ver comentário acima), uma requisição só chega até aqui com
// API key OU sessão válida — nunca "anônima".
function getAuthMethod(req) {
  if (req.apiKey) return 'api_key';
  return req.authMethod === 'google' ? 'google' : 'local';
}

// ════════════════════════════════════════════════
// GET /api/me — usuário identificado (sessão local/Google, ou API key)
// ════════════════════════════════════════════════
app.get('/api/me', async (req, res) => {
  const username = getCurrentUsername(req);
  let role = 'admin';
  try { role = await getCurrentRole(req); } catch (e) { console.error('getCurrentRole failed:', e); }
  res.json({
    username,
    upn: username, // mantido por compatibilidade com o front-end (js/user-sync.js) — sem NTLM/AD, username já é o identificador "de verdade" (e-mail, no caso do Google)
    role,
    isAdmin: role === 'admin',
    authMethod: getAuthMethod(req),
  });
});

// ════════════════════════════════════════════════
// Folders — substitui a antiga feature "Favorites" (ver migração de dados em
// server/db.js::runMigrations()). Cada usuário organiza comandos em pastas
// PRÓPRIAS (nome livre) e um mesmo comando pode estar em várias pastas ao
// mesmo tempo (folder_commands, N:N — ver schema.sql). Diferente de
// favoritos, pastas são privadas: não existe uma view "quem mais tem este
// comando" — ver shapeCommand()'s folder_ids, que só reflete as pastas do
// usuário que está fazendo a requisição.
// ════════════════════════════════════════════════

// Junta folder_commands + notes + SUBPASTAS DIRETAS de um conjunto de
// pastas num único array `order` por pasta — {type:'command'|'note'|
// 'folder', id} na sequência de sort_order (a MESMA escala numérica pras
// TRÊS fontes dentro de uma pasta — ver comentário em schema.sql e em
// POST/PUT /api/folders/:id/reorder abaixo) — é assim que o front-end sabe
// intercalar comandos, notas E subpastas na ordem que o usuário definiu
// (pedido do usuário: "poder reordenar as subpastas entre os comandos e
// notas"), em vez de sempre mostrar as subpastas separadas no fim.
// `notesById` sai já pronto pra virar o campo `notes` de cada pasta na
// resposta.
async function loadFolderOrderAndNotes(folderIds) {
  if (!folderIds.length) return { orderByFolder: new Map(), notesByFolder: new Map() };
  const [itemsQ, notesQ] = await Promise.all([
    pool.query(
      `SELECT folder_id, command_id AS item_id, sort_order, 'command' AS item_type FROM folder_commands WHERE folder_id = ANY($1)
       UNION ALL
       SELECT folder_id, id AS item_id, sort_order, 'note' AS item_type FROM notes WHERE folder_id = ANY($1)
       UNION ALL
       SELECT parent_id AS folder_id, id AS item_id, sort_order, 'folder' AS item_type FROM folders WHERE parent_id = ANY($1)
       ORDER BY folder_id, sort_order, item_type`,
      [folderIds]
    ),
    pool.query(
      `SELECT id, folder_id, username, title, description, sort_order, created_at, updated_at
       FROM notes WHERE folder_id = ANY($1) ORDER BY folder_id, sort_order, id`,
      [folderIds]
    ),
  ]);
  const orderByFolder = new Map();
  itemsQ.rows.forEach(r => {
    if (!orderByFolder.has(r.folder_id)) orderByFolder.set(r.folder_id, []);
    orderByFolder.get(r.folder_id).push({
      // command_id, notes.id e folders.id são todos INTEGER agora — não há
      // mais necessidade de tratar 'command' como caso especial (era TEXT
      // antes, por isso o item_id vinha ::text e só os outros dois tipos
      // eram convertidos de volta pra Number aqui).
      type: r.item_type,
      id: r.item_id,
    });
  });
  const notesByFolder = new Map();
  notesQ.rows.forEach(r => {
    if (!notesByFolder.has(r.folder_id)) notesByFolder.set(r.folder_id, []);
    notesByFolder.get(r.folder_id).push({
      id: r.id, folder_id: r.folder_id, title: r.title, description: r.description, sort_order: r.sort_order,
      created_at: r.created_at, updated_at: r.updated_at,
    });
  });
  return { orderByFolder, notesByFolder };
}

// Lista as pastas do usuário atual, cada uma já com a lista de command_ids
// que contém, as próprias notas (task Notes) e o array `order` combinado
// (comandos + notas intercalados, ver loadFolderOrderAndNotes acima) — evita
// 1 request por pasta no front-end.
app.get('/api/folders', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const { rows } = await pool.query(
      `SELECT f.id, f.name, f.sort_order, f.parent_id,
              COALESCE(array_agg(fc.command_id ORDER BY fc.sort_order, fc.created_at) FILTER (WHERE fc.command_id IS NOT NULL), '{}') AS command_ids
       FROM folders f
       LEFT JOIN folder_commands fc ON fc.folder_id = f.id
       WHERE f.username = $1
       GROUP BY f.id
       ORDER BY f.sort_order, f.name`,
      [username]
    );
    const { orderByFolder, notesByFolder } = await loadFolderOrderAndNotes(rows.map(r => r.id));
    res.json(rows.map(r => ({
      id: r.id, name: r.name, sort_order: r.sort_order, parent_id: r.parent_id, command_ids: r.command_ids,
      notes: notesByFolder.get(r.id) || [],
      order: orderByFolder.get(r.id) || [],
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Lista as pastas de TODOS os usuários (cross-user) — usada pelo Group by
// "User folders" (fora de Folders) E pelo novo seletor de escopo de pastas
// dentro de Folders ("My folders" / escolher um usuário / "All" — ver
// js/folders.js), uma visão de equipe para ver o que cada colega organizou,
// no mesmo espírito do "Created by" (que já é cross-user). Diferente de GET
// /api/folders acima, que é privado ao usuário da requisição — aqui não há
// filtro por username. Comandos em si já são visíveis a todo mundo (ver
// "Created by"); o que era privado era só a ORGANIZAÇÃO em pastas. Notas de
// outro usuário aparecem aqui também, só que sem nenhuma ação disponível no
// front-end (edição/clone/exclusão exige username === CURRENT_USER).
app.get('/api/folders/all', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.username, f.name, f.sort_order, f.parent_id,
              COALESCE(array_agg(fc.command_id ORDER BY fc.sort_order, fc.created_at) FILTER (WHERE fc.command_id IS NOT NULL), '{}') AS command_ids
       FROM folders f
       LEFT JOIN folder_commands fc ON fc.folder_id = f.id
       GROUP BY f.id
       ORDER BY f.username, f.sort_order, f.name`
    );
    const { orderByFolder, notesByFolder } = await loadFolderOrderAndNotes(rows.map(r => r.id));
    res.json(rows.map(r => ({
      id: r.id, username: r.username, name: r.name, sort_order: r.sort_order, parent_id: r.parent_id, command_ids: r.command_ids,
      notes: notesByFolder.get(r.id) || [],
      order: orderByFolder.get(r.id) || [],
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Cria uma pasta nova para o usuário atual. 409 se ele já tiver uma pasta com
// esse nome (UNIQUE(username, name), ver schema.sql — err.code 23505 é o
// código padrão do Postgres para violação de constraint única).
// `parent_id` (opcional, subpastas): quando informado, precisa apontar para
// uma pasta que já existe E pertence ao MESMO usuário — uma FK sozinha (ver
// schema.sql) não expressa "mesmo dono", então checamos aqui, com 404 se o id
// não existir/for de outro usuário (mesma convenção "não vaza a distinção"
// usada no resto destes endpoints). Aninhamento é ilimitado — a subpasta pode
// por sua vez ganhar suas próprias subpastas, então não há checagem de
// profundidade nem risco de ciclo aqui (um ciclo só seria possível trocando o
// parent_id de uma pasta JÁ existente para um de seus próprios descendentes,
// operação que este endpoint — só criação — não oferece).
app.post('/api/folders', async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const parentIdRaw = req.body && req.body.parent_id;
  const parentId = (parentIdRaw === undefined || parentIdRaw === null || parentIdRaw === '') ? null : Number(parentIdRaw);
  try {
    if (!name) return res.status(400).json({ error: 'validation_error', message: '"name" is required' });
    if (parentIdRaw != null && parentIdRaw !== '' && !Number.isInteger(parentId)) {
      return res.status(400).json({ error: 'validation_error', message: '"parent_id" must be an integer' });
    }
    const username = getCurrentUsername(req);
    // Nova subpasta entra logo ABAIXO da pasta-mãe (pedido do usuário: "a
    // posição inicial da subpasta deve ser logo abaixo da pasta pai") — ou
    // seja, no TOPO da lista combinada de itens da pasta-mãe (comandos +
    // notas + subpastas, MESMA escala de sort_order — ver
    // loadFolderOrderAndNotes acima), não só entre as demais subpastas.
    // sort_order menor que o menor já existente entre QUALQUER um dos três
    // tipos, em vez do padrão 0. Só se aplica a subpastas de verdade
    // (parentId != null); pasta de topo continua com sort_order 0 (ordem de
    // raiz é Favorites-primeiro + alfabética, decidida em buildFolderTree,
    // js/folders.js — não depende de sort_order).
    let sortOrder = 0;
    if (parentId !== null) {
      const parent = await pool.query('SELECT id FROM folders WHERE id = $1 AND username = $2', [parentId, username]);
      if (!parent.rows.length) return res.status(404).json({ error: 'not_found', message: `Parent folder '${parentId}' not found` });
      const minRes = await pool.query(
        `SELECT COALESCE(MIN(sort_order), 0) AS m FROM (
           SELECT sort_order FROM folder_commands WHERE folder_id = $1
           UNION ALL
           SELECT sort_order FROM notes WHERE folder_id = $1
           UNION ALL
           SELECT sort_order FROM folders WHERE parent_id = $1
         ) combined`,
        [parentId]
      );
      sortOrder = minRes.rows[0].m - 1;
    }
    const { rows } = await pool.query(
      'INSERT INTO folders (username, name, parent_id, sort_order) VALUES ($1, $2, $3, $4) RETURNING id, name, sort_order, parent_id',
      [username, name, parentId, sortOrder]
    );
    await logAudit(username, 'create', 'folder', String(rows[0].id), name);
    res.status(201).json({ id: rows[0].id, name: rows[0].name, sort_order: rows[0].sort_order, parent_id: rows[0].parent_id, command_ids: [] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'conflict', message: `You already have a folder named "${name}"` });
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Renomeia uma pasta. SÓ o dono renomeia a própria pasta — admin NÃO tem
// mais bypass aqui (pedido do usuário: "cada usuário só pode alterar ou
// excluir a sua própria pasta"; diferente da regra de comandos, que continua
// dando exceção a admins). 404 tanto se o id não existir quanto se existir
// mas for de outro usuário — não vazamos a distinção nesse caso. A pasta
// "Favorites" (padrão, ver FAVORITES_FOLDER_NAME acima) nunca pode ser
// renomeada, nem pelo próprio dono.
app.put('/api/folders/:id', async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  try {
    if (!name) return res.status(400).json({ error: 'validation_error', message: '"name" is required' });
    const username = getCurrentUsername(req);
    // Nome/dono ANTES da renomeação — usado tanto pra checar posse/proteção
    // quanto pro audit_log ("Renamed from X to Y"), já que o UPDATE abaixo
    // não devolve o valor antigo.
    const { rows: beforeRows } = await pool.query('SELECT name, username FROM folders WHERE id = $1', [req.params.id]);
    if (!beforeRows.length || beforeRows[0].username !== username) {
      return res.status(404).json({ error: 'not_found', message: `Folder '${req.params.id}' not found` });
    }
    if (beforeRows[0].name === FAVORITES_FOLDER_NAME) {
      return res.status(403).json({ error: 'forbidden', message: `The "${FAVORITES_FOLDER_NAME}" folder cannot be renamed.` });
    }
    const { rows } = await pool.query(
      'UPDATE folders SET name = $1 WHERE id = $2 AND username = $3 RETURNING id, name, sort_order',
      [name, req.params.id, username]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: `Folder '${req.params.id}' not found` });
    const oldName = beforeRows[0].name;
    const details = oldName !== name ? `Renamed from "${oldName}" to "${name}"` : null;
    await logAudit(username, 'update', 'folder', String(rows[0].id), rows[0].name, details);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'conflict', message: `A folder named "${name}" already exists for that folder's owner` });
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Move (reparenta) uma SUBPASTA para dentro de outra pasta do mesmo dono —
// pedido do usuário: "pode arrastar ... subpastas para dentro e fora da
// subpasta. A subpastas e seus itens não podem sair da pasta pai". Só
// aceita mover uma subpasta que JÁ TEM um pai (parent_id não nulo) — pastas
// de topo não usam esta rota (não há como arrastá-las na UI, ver
// wrapItemForFolderDrag em db-render-engine.js, só usado dentro do corpo de
// uma pasta-mãe). `parent_id` no body é o novo pai (obrigatório, precisa
// existir e ser do mesmo usuário). Duas validações extras, além da posse:
// (1) não pode virar pai de si mesma nem de um dos próprios descendentes
// (cicraria um ciclo na árvore — checado subindo a cadeia de parent_id do
// novo pai até achar :id ou a raiz); (2) a raiz (topo da árvore) do novo pai
// tem que ser a MESMA raiz de onde a subpasta já estava — é isso que
// impede o usuário de arrastar uma subpasta (e os itens dela) pra fora da
// pasta-mãe original, mesmo que arraste para outra pasta seguramente
// própria (ver getRootAncestorId acima). sort_order do novo pai é só um
// valor provisório (MAX+1) — o front-end sempre manda um PUT
// /api/folders/:novoPai/reorder logo em seguida com a posição exata em que
// o usuário soltou (ver moveFolderItem em js/folders.js).
app.put('/api/folders/:id/move', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const { id } = req.params;
    const newParentId = Number(req.body && req.body.parent_id);
    if (!Number.isInteger(newParentId)) {
      return res.status(400).json({ error: 'validation_error', message: '"parent_id" must be an integer' });
    }
    const folderRes = await pool.query('SELECT id, parent_id, username FROM folders WHERE id = $1', [id]);
    if (!folderRes.rows.length || folderRes.rows[0].username !== username) {
      return res.status(404).json({ error: 'not_found', message: `Folder '${id}' not found` });
    }
    if (folderRes.rows[0].parent_id === null) {
      return res.status(400).json({ error: 'validation_error', message: 'Only subfolders (folders with a parent) can be moved this way' });
    }
    const newParentRes = await pool.query('SELECT id, username FROM folders WHERE id = $1', [newParentId]);
    if (!newParentRes.rows.length || newParentRes.rows[0].username !== username) {
      return res.status(404).json({ error: 'not_found', message: `Parent folder '${newParentId}' not found` });
    }
    if (newParentId === Number(id)) {
      return res.status(400).json({ error: 'validation_error', message: 'A folder cannot be its own parent' });
    }
    // Ciclo: o novo pai não pode ser um DESCENDENTE de :id (senão :id
    // passaria a ser ancestral de si mesma através dele).
    let cursor = newParentId;
    for (let i = 0; i < 100; i++) {
      if (cursor === Number(id)) {
        return res.status(400).json({ error: 'validation_error', message: 'Cannot move a folder into one of its own subfolders' });
      }
      const r = await pool.query('SELECT parent_id FROM folders WHERE id = $1', [cursor]);
      if (!r.rows.length || r.rows[0].parent_id === null) break;
      cursor = r.rows[0].parent_id;
    }
    const [oldRoot, newRoot] = await Promise.all([
      getRootAncestorId(folderRes.rows[0].parent_id),
      getRootAncestorId(newParentId),
    ]);
    if (oldRoot !== newRoot) {
      return res.status(400).json({ error: 'validation_error', message: 'Cannot move a subfolder outside of its top-level parent folder' });
    }
    const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM folders WHERE parent_id = $1', [newParentId]);
    const { rows } = await pool.query(
      'UPDATE folders SET parent_id = $1, sort_order = $2 WHERE id = $3 AND username = $4 RETURNING id, name, sort_order, parent_id',
      [newParentId, maxRes.rows[0].m + 1, id, username]
    );
    await logAudit(username, 'update', 'folder', String(rows[0].id), rows[0].name, `Moved into folder #${newParentId}`);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Apaga uma pasta — mesma regra do PUT acima: SÓ o dono, sem bypass de
// admin. folder_commands é limpo sozinho via ON DELETE CASCADE (ver
// schema.sql); os comandos em si e as OUTRAS pastas do dono não são
// afetados. A pasta "Favorites" nunca pode ser excluída, nem pelo dono.
app.delete('/api/folders/:id', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    // Nome/dono ANTES de excluir — a linha some depois do DELETE, então
    // precisamos disso agora pra checar posse/proteção e pro audit_log
    // (entity_name fica denormalizado).
    const { rows: beforeRows } = await pool.query('SELECT name, username FROM folders WHERE id = $1', [req.params.id]);
    if (!beforeRows.length || beforeRows[0].username !== username) {
      return res.status(404).json({ error: 'not_found', message: `Folder '${req.params.id}' not found` });
    }
    if (beforeRows[0].name === FAVORITES_FOLDER_NAME) {
      return res.status(403).json({ error: 'forbidden', message: `The "${FAVORITES_FOLDER_NAME}" folder cannot be deleted.` });
    }
    const { rowCount } = await pool.query('DELETE FROM folders WHERE id = $1 AND username = $2', [req.params.id, username]);
    if (!rowCount) return res.status(404).json({ error: 'not_found', message: `Folder '${req.params.id}' not found` });
    await logAudit(username, 'delete', 'folder', req.params.id, beforeRows[0].name, null);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Adiciona um comando a uma pasta do usuário atual — idempotente (marcar de
// novo não dá erro, ON CONFLICT DO NOTHING). 404 se a pasta não existir/não
// for do usuário, ou se o comando não existir.
app.post('/api/folders/:id/commands/:commandId', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const { id, commandId } = req.params;
    const folder = await pool.query('SELECT id, name FROM folders WHERE id = $1 AND username = $2', [id, username]);
    if (!folder.rows.length) return res.status(404).json({ error: 'not_found', message: `Folder '${id}' not found` });
    const cmdRow = await getCommandRow(commandId);
    if (!cmdRow) return res.status(404).json({ error: 'not_found', message: `Command '${commandId}' not found` });
    // Comando novo entra no FIM da ordem da pasta (task #458) — MAX(sort_order)+1
    // em vez de 0 fixo, senão toda inclusão nova empataria na primeira posição.
    // GREATEST entre folder_commands E notes (task Notes) — as duas tabelas
    // compartilham a MESMA escala de sort_order dentro da pasta (ver
    // comentário em schema.sql), então o "fim" de verdade pode estar
    // marcado numa nota, não só num comando. COALESCE(...,-1)+1 cobre a
    // pasta ainda totalmente vazia (MAX de zero linhas nas duas é NULL).
    await pool.query(
      `INSERT INTO folder_commands (folder_id, command_id, sort_order)
       VALUES ($1, $2, (
         SELECT COALESCE(GREATEST(
           (SELECT MAX(sort_order) FROM folder_commands WHERE folder_id = $1),
           (SELECT MAX(sort_order) FROM notes WHERE folder_id = $1)
         ), -1) + 1
       ))
       ON CONFLICT DO NOTHING`,
      [id, commandId]
    );
    await logAudit(username, 'update', 'folder', id, folder.rows[0].name, `Added command "${cmdRow.name}"`);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Remove um comando de uma pasta do usuário atual — não afeta o comando em
// si nem sua presença em outras pastas.
app.delete('/api/folders/:id/commands/:commandId', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const { id, commandId } = req.params;
    const folder = await pool.query('SELECT id, name FROM folders WHERE id = $1 AND username = $2', [id, username]);
    if (!folder.rows.length) return res.status(404).json({ error: 'not_found', message: `Folder '${id}' not found` });
    const cmdRow = await getCommandRow(commandId);
    await pool.query('DELETE FROM folder_commands WHERE folder_id = $1 AND command_id = $2', [id, commandId]);
    await logAudit(username, 'update', 'folder', id, folder.rows[0].name, `Removed command "${cmdRow ? cmdRow.name : commandId}"`);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Reordena os itens DENTRO de uma pasta do usuário atual (task #458,
// estendido pela task Notes e depois por subpastas) — body
// { order: [{type, id}, ...] } é a lista COMPLETA na nova ordem desejada
// (type: 'command'|'note'|'folder'); o índice de cada item no array vira o
// novo sort_order. 'command'/'note'/'folder' compartilham a MESMA escala
// dentro de uma pasta (ver loadFolderOrderAndNotes acima e schema.sql) —
// pedido do usuário: "poder reordenar as subpastas entre os comandos e
// notas" — então o front-end manda a lista COMBINADA dos três tipos numa
// única chamada (ver persistFolderContainerOrder/reorderFolderItems em
// js/folders.js). 404 se a pasta não existir/não for do usuário (mesmo
// tratamento das outras rotas de folder).
// Mantém compatibilidade com o formato antigo { command_ids: [...] } (só
// comandos) — front-ends antigos ou chamadas externas via API key continuam
// funcionando. IDs que não pertencerem de fato à pasta (ou, no caso de
// 'folder', que não forem subpasta DIRETA desta pasta e do mesmo usuário)
// são ignorados silenciosamente (a query composta simplesmente não bate com
// nada para eles) — o front-end sempre manda a lista completa e correta
// (deriva da ordem atual do DOM), então isso só protege contra uma chamada
// manual malformada.
app.put('/api/folders/:id/reorder', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const { id } = req.params;
    let order = Array.isArray(req.body && req.body.order) ? req.body.order : null;
    if (!order && Array.isArray(req.body && req.body.command_ids)) {
      order = req.body.command_ids.map(cid => ({ type: 'command', id: cid }));
    }
    if (!order || !order.length) {
      return res.status(400).json({ error: 'validation_error', message: '"order" must be a non-empty array of {type, id}' });
    }
    const folder = await pool.query('SELECT id FROM folders WHERE id = $1 AND username = $2', [id, username]);
    if (!folder.rows.length) return res.status(404).json({ error: 'not_found', message: `Folder '${id}' not found` });

    await withTransaction(async client => {
      for (let i = 0; i < order.length; i++) {
        const item = order[i];
        if (item && item.type === 'note') {
          await client.query(
            'UPDATE notes SET sort_order = $1 WHERE folder_id = $2 AND id = $3 AND username = $4',
            [i, id, item.id, username]
          );
        } else if (item && item.type === 'folder') {
          await client.query(
            'UPDATE folders SET sort_order = $1 WHERE id = $2 AND parent_id = $3 AND username = $4',
            [i, item.id, id, username]
          );
        } else if (item) {
          await client.query(
            'UPDATE folder_commands SET sort_order = $1 WHERE folder_id = $2 AND command_id = $3',
            [i, id, item.id]
          );
        }
      }
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Copia uma pasta de QUALQUER usuário (inclusive a própria) para uma pasta
// NOVA do usuário atual, com a mesma lista de comandos E notas, na mesma
// ordem combinada (task #459, estendida pela task Notes a pedido do
// usuário) — os comandos em si não são duplicados (já são
// cross-user-visíveis, ver "Created by"), só a membership em
// folder_commands é recriada; as notas SÃO duplicadas de verdade (linhas
// novas em `notes`), porque são texto/imagem que só existe dentro da pasta
// original — copiar a pasta sem elas deixaria a curadoria incompleta. As
// notas copiadas passam a pertencer a QUEM COPIOU (username = usuário
// atual, nunca o autor original) — mantém o invariante "dona da nota ==
// dona da pasta" (ver Notes abaixo) e o direito de editar/clonar/excluir só
// da própria cópia, nunca da nota de outra pessoa. Como `notes.sort_order`
// e `folder_commands.sort_order` compartilham a mesma escala DENTRO de uma
// pasta (ver schema.sql), basta copiar os valores de sort_order tal como
// estão — a ordem combinada (order, ver loadFolderOrderAndNotes) sai
// correta na pasta nova sem precisar remapear nada. Resolve automaticamente
// conflito de nome (UNIQUE(username, name)) acrescentando "(copy)", "(copy 2)", etc.
app.post('/api/folders/:id/copy', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const src = await pool.query('SELECT id, name FROM folders WHERE id = $1', [req.params.id]);
    if (!src.rows.length) return res.status(404).json({ error: 'not_found', message: `Folder '${req.params.id}' not found` });
    const baseName = src.rows[0].name;

    let name = baseName;
    let suffix = 1;
    for (;;) {
      const exists = await pool.query('SELECT 1 FROM folders WHERE username = $1 AND name = $2', [username, name]);
      if (!exists.rows.length) break;
      suffix++;
      name = suffix === 2 ? `${baseName} (copy)` : `${baseName} (copy ${suffix - 1})`;
    }

    const newFolder = await withTransaction(async client => {
      const { rows: newFolderRows } = await client.query(
        'INSERT INTO folders (username, name) VALUES ($1, $2) RETURNING id, name, sort_order',
        [username, name]
      );
      const folder = newFolderRows[0];
      await client.query(
        `INSERT INTO folder_commands (folder_id, command_id, sort_order)
         SELECT $1, fc.command_id, fc.sort_order FROM folder_commands fc WHERE fc.folder_id = $2`,
        [folder.id, req.params.id]
      );
      await client.query(
        `INSERT INTO notes (folder_id, username, title, description, sort_order)
         SELECT $1, $2, n.title, n.description, n.sort_order FROM notes n WHERE n.folder_id = $3`,
        [folder.id, username, req.params.id]
      );
      return folder;
    });
    await logAudit(username, 'create', 'folder', String(newFolder.id), newFolder.name, `Copied from folder "${baseName}"`);
    const { rows: cmdRows } = await pool.query(
      'SELECT command_id FROM folder_commands WHERE folder_id = $1 ORDER BY sort_order, created_at',
      [newFolder.id]
    );
    const { orderByFolder, notesByFolder } = await loadFolderOrderAndNotes([newFolder.id]);
    res.status(201).json({
      id: newFolder.id, name: newFolder.name, sort_order: newFolder.sort_order,
      command_ids: cmdRows.map(r => r.command_id),
      notes: notesByFolder.get(newFolder.id) || [],
      order: orderByFolder.get(newFolder.id) || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Export / Import de uma pasta inteira (pedido do usuário: "criar opção para
// importar e exportar a pasta folders. incluir todas subfolders, comandos e
// anotações.") — pensado para levar uma pasta (com toda a árvore de
// subpastas, os comandos que ela contém e as notes) de uma instalação para
// outra (ex.: entre ambientes de clientes diferentes do Toolbox45), não só
// entre usuários da MESMA instalação (isso já existia via "copy" acima, mas
// só uma pasta única, sem subpastas). Formato do arquivo: um JSON
// auto-contido — cada comando vai por INTEIRO (mesmo shape de
// GET /api/commands/:id, ver shapeCommand acima), não só uma referência por
// id, já que o id só faz sentido dentro do banco de origem.
// ════════════════════════════════════════════════

// Converte o formato de LEITURA de `lines` (shapeCommand: {default:[...],
// empty:[...]}) de volta para o formato de ESCRITA que insertChildren()
// espera (array única, achatada, com `variant` explícito em cada linha) —
// os dois lados dessa mesma informação já existiam antes desta feature (ver
// nota em POST /api/commands acima sobre essa assimetria GET vs POST), só
// não havia ainda um conversor de um para o outro.
function flattenCommandLinesForImport(lines) {
  const out = [];
  ((lines && lines.default) || []).forEach(l => out.push(Object.assign({}, l, { variant: 'default' })));
  ((lines && lines.empty) || []).forEach(l => out.push(Object.assign({}, l, { variant: 'empty' })));
  return out;
}

// Monta recursivamente a árvore de exportação de uma pasta: seu nome, suas
// notes, seus comandos (sort_order dentro da pasta + definição COMPLETA via
// shapeCommand) e suas subpastas (mesma estrutura, recursivamente) —
// espelha o que GET /api/folders já devolve para uma pasta (command_ids +
// notes + order), só que resolvendo cada command_id para o comando inteiro
// (em vez de só o id) e caminhando por parent_id para trazer as subpastas.
async function buildFolderExportNode(folderId, username) {
  const { rows: folderRows } = await pool.query('SELECT id, name FROM folders WHERE id = $1', [folderId]);
  if (!folderRows.length) return null;
  const name = folderRows[0].name;

  const { rows: noteRows } = await pool.query(
    'SELECT title, description, sort_order FROM notes WHERE folder_id = $1 ORDER BY sort_order, id',
    [folderId]
  );

  const { rows: fcRows } = await pool.query(
    'SELECT command_id, sort_order FROM folder_commands WHERE folder_id = $1 ORDER BY sort_order, created_at',
    [folderId]
  );
  const commands = [];
  for (const fc of fcRows) {
    const cmdRow = await findCommand(fc.command_id);
    if (!cmdRow) continue; // comando pode ter sido excluído sem a membership ainda ter sido limpa — ignora silenciosamente
    commands.push({ sort_order: fc.sort_order, command: await shapeCommand(cmdRow, username) });
  }

  const { rows: childRows } = await pool.query(
    'SELECT id, sort_order FROM folders WHERE parent_id = $1 ORDER BY sort_order, name',
    [folderId]
  );
  const children = [];
  for (const cf of childRows) {
    const childNode = await buildFolderExportNode(cf.id, username);
    if (childNode) children.push({ sort_order: cf.sort_order, folder: childNode });
  }

  return { name, notes: noteRows, commands, children };
}

// Exporta uma pasta (+ toda a subárvore) do usuário atual. 404 tanto se o id
// não existir quanto se pertencer a outro usuário — mesma convenção "não
// vaza a distinção" do resto destes endpoints (folders são dados privados do
// usuário, ver PUT/DELETE /api/folders/:id acima).
app.get('/api/folders/:id/export', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const owned = await pool.query('SELECT id FROM folders WHERE id = $1 AND username = $2', [req.params.id, username]);
    if (!owned.rows.length) return res.status(404).json({ error: 'not_found', message: `Folder '${req.params.id}' not found` });
    const root = await buildFolderExportNode(Number(req.params.id), username);
    res.json({ type: 'toolbox45-folder-export', version: 1, exported_at: new Date().toISOString(), root });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Acha um nome de pasta livre para `username` a partir de `baseName`, dentro
// da MESMA transação/client do import abaixo — mesmo algoritmo de sufixo
// "(copy)"/"(copy N)" já usado por POST /api/folders/:id/copy (mais acima),
// só que reescrito para aceitar um `client` de transação em vez do `pool`
// direto (o import inteiro roda dentro de uma única transação — ver
// POST /api/folders/import abaixo).
async function findAvailableFolderName(client, username, baseName) {
  let name = baseName;
  let suffix = 1;
  for (;;) {
    const exists = await client.query('SELECT 1 FROM folders WHERE username = $1 AND name = $2', [username, name]);
    if (!exists.rows.length) return name;
    suffix++;
    name = suffix === 2 ? `${baseName} (copy)` : `${baseName} (copy ${suffix - 1})`;
  }
}

// Recria recursivamente um nó da árvore de exportação (pasta + notes +
// comandos + subpastas) para `username`, dentro de `parentId` (null = pasta
// de topo) — usado por POST /api/folders/import abaixo. `stats` é acumulado
// por referência (mesma convenção de contadores/relatório usada no import de
// CSV, ver js/csv-import.js: "N imported, M failed"). Devolve o id da pasta
// recém-criada (usado só para o log de auditoria do endpoint acima dela).
async function importFolderTreeNode(client, node, username, parentId, stats) {
  const baseName = String((node && node.name) || 'Imported folder').trim() || 'Imported folder';
  const name = await findAvailableFolderName(client, username, baseName);
  const { rows } = await client.query(
    'INSERT INTO folders (username, name, parent_id) VALUES ($1, $2, $3) RETURNING id',
    [username, name, parentId]
  );
  const folderId = rows[0].id;
  stats.folders++;

  for (const n of (node.notes || [])) {
    await client.query(
      'INSERT INTO notes (folder_id, username, title, description, sort_order) VALUES ($1, $2, $3, $4, $5)',
      [folderId, username, String((n && n.title) || ''), sanitizeNoteHtml((n && n.description) || ''), Number.isInteger(n && n.sort_order) ? n.sort_order : 0]
    );
    stats.notes++;
  }

  for (const c of (node.commands || [])) {
    const cmd = c && c.command;
    if (!cmd) continue;
    const body = Object.assign({}, cmd, { lines: flattenCommandLinesForImport(cmd.lines) });
    const errors = validateBody(body);
    if (errors.length) {
      stats.commandsFailed++;
      stats.errors.push(`"${cmd.name || '?'}": ${errors.join('; ')}`);
      continue;
    }
    const cols = buildCommandColumns(body);
    cols.created_by = username;
    cols.modified_by = username;
    const { rows: cmdRows } = await client.query(
      `INSERT INTO commands (
        topic, icon, sort_order, requires_ip_port, placeholder_resolver,
        name, name_empty, "desc", desc_empty,
        details,
        created_by, modified_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id`,
      [
        cols.topic, cols.icon, cols.sort_order, cols.requires_ip_port,
        cols.placeholder_resolver,
        cols.name, cols.name_empty, cols.desc, cols.desc_empty,
        cols.details,
        cols.created_by, cols.modified_by,
      ]
    );
    const newCmdId = cmdRows[0].id;
    await insertChildren(client, newCmdId, body);
    await client.query(
      'INSERT INTO folder_commands (folder_id, command_id, sort_order) VALUES ($1, $2, $3)',
      [folderId, newCmdId, Number.isInteger(c && c.sort_order) ? c.sort_order : 0]
    );
    stats.commands++;
  }

  for (const child of (node.children || [])) {
    if (child && child.folder) await importFolderTreeNode(client, child.folder, username, folderId, stats);
  }

  return folderId;
}

// Importa um arquivo exportado por GET /api/folders/:id/export acima — body:
// { tree: <o mesmo objeto "root" do export>, parent_id?: <pasta de destino
// já existente, opcional> }. Toda a árvore (pasta + subpastas + comandos +
// notes) é recriada como NOVA (novos ids, sempre pertencendo ao usuário
// atual — mesmo espírito de POST /api/folders/:id/copy), numa ÚNICA
// transação: como nenhuma das 5 colunas "soft" de escopo de um comando
// (vendor/system/version/environment/topic — ver schema.sql, sem FK formal
// por design) pode falhar por violação de integridade referencial, uma
// falha real aqui só pode vir de dado malformado no próprio arquivo — nesse
// caso é melhor desfazer tudo (all-or-nothing) do que deixar a árvore pela
// metade.
// Observação (não é um erro, é só uma limitação a documentar pro usuário):
// se o Vendor/Sistema/Versão/Ambiente de um comando importado não existir no
// catálogo da instalação de DESTINO, o comando é criado normalmente mas pode
// não aparecer nos filtros até esses catálogos serem cadastrados lá também.
app.post('/api/folders/import', async (req, res) => {
  try {
    const tree = req.body && req.body.tree;
    if (!tree || typeof tree !== 'object' || typeof tree.name !== 'string') {
      return res.status(400).json({ error: 'validation_error', message: 'Invalid or missing "tree" (expected the "root" object from a folder export file)' });
    }
    const parentIdRaw = req.body && req.body.parent_id;
    const parentId = (parentIdRaw === undefined || parentIdRaw === null || parentIdRaw === '') ? null : Number(parentIdRaw);
    if (parentIdRaw != null && parentIdRaw !== '' && !Number.isInteger(parentId)) {
      return res.status(400).json({ error: 'validation_error', message: '"parent_id" must be an integer' });
    }
    const username = getCurrentUsername(req);
    if (parentId !== null) {
      const parent = await pool.query('SELECT id FROM folders WHERE id = $1 AND username = $2', [parentId, username]);
      if (!parent.rows.length) return res.status(404).json({ error: 'not_found', message: `Parent folder '${parentId}' not found` });
    }

    const stats = { folders: 0, notes: 0, commands: 0, commandsFailed: 0, errors: [] };
    let rootFolderId;
    await withTransaction(async client => {
      rootFolderId = await importFolderTreeNode(client, tree, username, parentId, stats);
    });
    await logAudit(username, 'create', 'folder', String(rootFolderId), tree.name, `Imported folder tree: ${stats.folders} folder(s), ${stats.commands} command(s), ${stats.notes} note(s)${stats.commandsFailed ? `, ${stats.commandsFailed} command(s) failed` : ''}`);
    res.status(201).json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Notes — anotações livres (título + descrição em HTML) que só existem
// DENTRO de uma pasta (ver notes em schema.sql). Mesma filosofia de
// permissão do resto de "Folders": só o dono da pasta (username ===
// usuário atual) pode criar/editar/clonar/excluir; qualquer outro usuário
// só VÊ a nota (GET /api/folders/all, Group by "User folders", ou o
// seletor de escopo de pastas dentro de Folders) — sem nenhuma ação
// disponível no front-end nem aceita pelo backend (todas as rotas abaixo
// filtram por WHERE ... AND (via folder) username = usuário atual).
// ════════════════════════════════════════════════

// Allow-list de tags para o corpo da nota (contenteditable no front-end,
// ver startCreateNote()/startEditNote() em js/folders.js) — sanitização própria por regex (sem
// dependência de HTML parser/DOMPurify) porque o conteúdo é sempre gerado
// pelo NOSSO editor (colar imagem -> <img>, texto -> <b>/<i>/<br>/<div>/etc.),
// nunca HTML arbitrário de fora; ainda assim nunca confiamos no que o
// cliente manda — <script>/<style> são removidos por inteiro (tag +
// conteúdo), qualquer tag fora da allow-list é removida (mantendo o texto
// de dentro), atributos on*="..." nunca sobrevivem (só um conjunto fixo de
// atributos é reconstruído por tag, o resto do atributo original é
// descartado), e <img>/<a> só aceitam src/href com esquema seguro
// (data:image/ ou http(s):// — nunca javascript:).
const NOTE_ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'br', 'p', 'div', 'span', 'ul', 'ol', 'li', 'a', 'img']);
// Allow-list de propriedades CSS preservadas no atributo `style` de
// span/div/p/li — são exatamente as 3 que a barra de formatação da nota
// aplica (ver neSetFontSize/neSetColor/neExec('justifyLeft'|'justifyCenter'|
// 'justifyRight') em js/folders.js). Bug reportado pelo usuário: "criei uma
// nota mas não salvou a formatação que eu fiz" — o branch genérico abaixo
// (`return '<${lower}>'`) descartava TODOS os atributos de toda tag exceto
// img/a, inclusive `style`, então qualquer <span style="color:...">/
// <span style="font-size:...px">/<div style="text-align:...">  virava uma
// tag "pelada" e a formatação de cor/tamanho/alinhamento se perdia
// silenciosamente ao salvar (ficava visível só até o próximo reload). Cada
// valor é validado com uma allow-list/regex própria — nunca aceito cru —
// pra não abrir uma porta de CSS injection (ex.: `background:url(...)`,
// `position:fixed`, etc.) só porque o nome da propriedade bateu.
function _sanitizeNoteStyle(styleAttr) {
  if (!styleAttr) return '';
  const kept = [];
  String(styleAttr).split(';').forEach(decl => {
    const m = /^\s*([a-zA-Z-]+)\s*:\s*(.+?)\s*$/.exec(decl);
    if (!m) return;
    const prop = m[1].toLowerCase();
    const val = m[2].trim();
    if (prop === 'color' && /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(val)) {
      kept.push(`color:${val}`);
    } else if (prop === 'font-size' && /^\d{1,3}px$/.test(val)) {
      kept.push(`font-size:${val}`);
    } else if (prop === 'text-align' && ['left', 'center', 'right', 'justify'].includes(val.toLowerCase())) {
      kept.push(`text-align:${val.toLowerCase()}`);
    }
  });
  return kept.join(';');
}
function sanitizeNoteHtml(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*)?)\s*\/?>/g, (m, closing, tag, attrs) => {
    const lower = tag.toLowerCase();
    // <font ...>/</font>: alguns navegadores ainda emitem isso pra
    // document.execCommand('foreColor', ...) em vez de um <span
    // style="color:...">  — convertido pra <span> (com a cor preservada via
    // style, nunca via atributo legado `color`) pra não perder a formatação
    // nem precisar admitir `font` na allow-list de tags.
    if (lower === 'font') {
      if (closing) return '</span>';
      const colorAttrM = /\bcolor\s*=\s*"([^"]*)"/i.exec(attrs) || /\bcolor\s*=\s*'([^']*)'/i.exec(attrs);
      const styleM = /\bstyle\s*=\s*"([^"]*)"/i.exec(attrs) || /\bstyle\s*=\s*'([^']*)'/i.exec(attrs);
      let styleOut = _sanitizeNoteStyle(styleM ? styleM[1] : '');
      if (!styleOut && colorAttrM && /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(colorAttrM[1])) {
        styleOut = `color:${colorAttrM[1]}`;
      }
      return styleOut ? `<span style="${styleOut}">` : '<span>';
    }
    if (!NOTE_ALLOWED_TAGS.has(lower)) return '';
    if (closing) return `</${lower}>`;
    if (lower === 'img') {
      const srcM = /\bsrc\s*=\s*"([^"]*)"/i.exec(attrs) || /\bsrc\s*=\s*'([^']*)'/i.exec(attrs);
      const widthM = /\bwidth\s*=\s*"?(\d+)/i.exec(attrs);
      const heightM = /\bheight\s*=\s*"?(\d+)/i.exec(attrs);
      let src = srcM ? srcM[1] : '';
      if (!/^data:image\//i.test(src) && !/^https?:\/\//i.test(src)) return '';
      let out = `<img src="${src.replace(/"/g, '&quot;')}"`;
      if (widthM) out += ` width="${parseInt(widthM[1], 10)}"`;
      if (heightM) out += ` height="${parseInt(heightM[1], 10)}"`;
      return out + '>';
    }
    if (lower === 'a') {
      const hrefM = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs) || /\bhref\s*=\s*'([^']*)'/i.exec(attrs);
      let href = hrefM ? hrefM[1] : '';
      if (!/^https?:\/\//i.test(href)) href = '#';
      return `<a href="${href.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">`;
    }
    // span/div/p/li/ul/ol/b/strong/i/em/u/br: só `style` sobrevive (validado
    // e restrito às 3 propriedades acima) — qualquer outro atributo original
    // (inclusive on*="...") continua descartado, igual antes.
    const styleM = /\bstyle\s*=\s*"([^"]*)"/i.exec(attrs) || /\bstyle\s*=\s*'([^']*)'/i.exec(attrs);
    const styleOut = _sanitizeNoteStyle(styleM ? styleM[1] : '');
    return styleOut ? `<${lower} style="${styleOut}">` : `<${lower}>`;
  });
  return s;
}

// Cria uma nota nova DENTRO de uma pasta do usuário atual — 404 se a pasta
// não existir/não for do usuário (mesma checagem de POST .../commands/:id).
// sort_order = fim da pasta na escala COMPARTILHADA com folder_commands
// (ver comentário em GREATEST acima, mesma fórmula).
app.post('/api/folders/:id/notes', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const { id } = req.params;
    const title = String((req.body && req.body.title) || '').trim();
    const description = sanitizeNoteHtml((req.body && req.body.description) || '');
    const folder = await pool.query('SELECT id FROM folders WHERE id = $1 AND username = $2', [id, username]);
    if (!folder.rows.length) return res.status(404).json({ error: 'not_found', message: `Folder '${id}' not found` });
    const { rows } = await pool.query(
      `INSERT INTO notes (folder_id, username, title, description, sort_order)
       VALUES ($1, $2, $3, $4, (
         SELECT COALESCE(GREATEST(
           (SELECT MAX(sort_order) FROM folder_commands WHERE folder_id = $1),
           (SELECT MAX(sort_order) FROM notes WHERE folder_id = $1)
         ), -1) + 1
       ))
       RETURNING id, folder_id, title, description, sort_order, created_at, updated_at`,
      [id, username, title, description]
    );
    await logAudit(username, 'create', 'note', String(rows[0].id), title || '(untitled)');
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Edita título/descrição de uma nota — só o autor (username = usuário
// atual). 404 tanto se não existir quanto se for de outro usuário (mesmo
// não-vazamento de distinção usado em folders/commands).
app.put('/api/notes/:id', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const title = String((req.body && req.body.title) || '').trim();
    const description = sanitizeNoteHtml((req.body && req.body.description) || '');
    const { rows } = await pool.query(
      `UPDATE notes SET title = $1, description = $2, updated_at = NOW()
       WHERE id = $3 AND username = $4
       RETURNING id, folder_id, title, description, sort_order, created_at, updated_at`,
      [title, description, req.params.id, username]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: `Note '${req.params.id}' not found` });
    // Sem diff de conteúdo (description é HTML rico, pode ser longo — ver
    // sanitizeNoteHtml acima) — só registra que a nota foi editada.
    await logAudit(username, 'update', 'note', String(rows[0].id), title || '(untitled)');
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Move uma nota para outra pasta (própria) — usado pelo drag-and-drop de
// "arrastar para dentro/fora de uma subpasta" (pedido do usuário). Mesma
// regra de raiz do PUT /api/folders/:id/move acima: só deixa mover entre a
// pasta-mãe e suas subpastas (ou entre subpastas irmãs), nunca pra fora da
// árvore de topo onde a nota já estava — senão o usuário poderia "vazar"
// uma nota de uma pasta pra outra completamente sem relação por engano
// durante um drag. sort_order fica provisório (MAX+1); o front-end sempre
// manda um PUT /api/folders/:novaPasta/reorder logo em seguida com a
// posição exata (ver moveFolderItem em js/folders.js).
app.put('/api/notes/:id/move', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const newFolderId = Number(req.body && req.body.folder_id);
    if (!Number.isInteger(newFolderId)) {
      return res.status(400).json({ error: 'validation_error', message: '"folder_id" must be an integer' });
    }
    const noteRes = await pool.query('SELECT id, folder_id, username FROM notes WHERE id = $1', [req.params.id]);
    if (!noteRes.rows.length || noteRes.rows[0].username !== username) {
      return res.status(404).json({ error: 'not_found', message: `Note '${req.params.id}' not found` });
    }
    const newFolderRes = await pool.query('SELECT id, username FROM folders WHERE id = $1', [newFolderId]);
    if (!newFolderRes.rows.length || newFolderRes.rows[0].username !== username) {
      return res.status(404).json({ error: 'not_found', message: `Folder '${newFolderId}' not found` });
    }
    const [oldRoot, newRoot] = await Promise.all([
      getRootAncestorId(noteRes.rows[0].folder_id),
      getRootAncestorId(newFolderId),
    ]);
    if (oldRoot !== newRoot) {
      return res.status(400).json({ error: 'validation_error', message: 'Cannot move a note outside of its top-level parent folder' });
    }
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) AS m FROM (
         SELECT sort_order FROM folder_commands WHERE folder_id = $1
         UNION ALL
         SELECT sort_order FROM notes WHERE folder_id = $1
         UNION ALL
         SELECT sort_order FROM folders WHERE parent_id = $1
       ) combined`,
      [newFolderId]
    );
    const { rows } = await pool.query(
      `UPDATE notes SET folder_id = $1, sort_order = $2, updated_at = NOW()
       WHERE id = $3 AND username = $4
       RETURNING id, folder_id, title, description, sort_order, created_at, updated_at`,
      [newFolderId, maxRes.rows[0].m + 1, req.params.id, username]
    );
    await logAudit(username, 'update', 'note', String(rows[0].id), rows[0].title || '(untitled)', `Moved into folder #${newFolderId}`);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Exclui uma nota — só o autor.
app.delete('/api/notes/:id', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const before = await pool.query('SELECT title FROM notes WHERE id = $1 AND username = $2', [req.params.id, username]);
    const { rowCount } = await pool.query('DELETE FROM notes WHERE id = $1 AND username = $2', [req.params.id, username]);
    if (!rowCount) return res.status(404).json({ error: 'not_found', message: `Note '${req.params.id}' not found` });
    await logAudit(username, 'delete', 'note', req.params.id, (before.rows[0] && before.rows[0].title) || '(untitled)');
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Clona uma nota PRÓPRIA — cria uma cópia nova na MESMA pasta, título com
// sufixo " (copy)", no fim da ordem da pasta. Só o autor (a nota de outro
// usuário nem aparece com esse botão no front-end — ver buildNoteCardHtml
// em js/db-render-engine.js — e o backend recusaria de qualquer forma).
app.post('/api/notes/:id/clone', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const src = await pool.query('SELECT folder_id, title, description FROM notes WHERE id = $1 AND username = $2', [req.params.id, username]);
    if (!src.rows.length) return res.status(404).json({ error: 'not_found', message: `Note '${req.params.id}' not found` });
    const { folder_id: folderId, title, description } = src.rows[0];
    const { rows } = await pool.query(
      `INSERT INTO notes (folder_id, username, title, description, sort_order)
       VALUES ($1, $2, $3, $4, (
         SELECT COALESCE(GREATEST(
           (SELECT MAX(sort_order) FROM folder_commands WHERE folder_id = $1),
           (SELECT MAX(sort_order) FROM notes WHERE folder_id = $1)
         ), -1) + 1
       ))
       RETURNING id, folder_id, title, description, sort_order, created_at, updated_at`,
      [folderId, username, `${title} (copy)`, description]
    );
    await logAudit(username, 'create', 'note', String(rows[0].id), rows[0].title || '(untitled)', `Cloned from note "${title || '(untitled)'}"`);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// GET /api/audit-log — lista as alterações (criar/editar/excluir, em
// qualquer entidade — ver comentário em logAudit() acima) dos últimos 30
// dias, mais recente primeiro. Teto de 1000 linhas. `command_id`/
// `command_name` continuam no JSON de resposta (apontando para os mesmos
// valores de entity_id/entity_name) só para não quebrar nenhum consumidor
// externo (API key) que já lia esses nomes de campo antes desta mudança.
// ════════════════════════════════════════════════
app.get('/api/audit-log', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ts, username, action, entity_type, entity_id, entity_name, details
       FROM audit_log
       WHERE ts >= NOW() - INTERVAL '${AUDIT_LOG_RETENTION_DAYS} days'
       ORDER BY ts DESC, id DESC
       LIMIT 1000`
    );
    res.json(rows.map(r => ({ ...r, command_id: r.entity_id, command_name: r.entity_name })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Dados genéricos por usuário (tema, idioma, configurações, históricos — ver
// user_data e js/user-sync.js). GET devolve tudo que existe para o usuário atual
// num único objeto {chave: valor}; PUT faz upsert parcial (só as chaves enviadas).
// ════════════════════════════════════════════════
app.get('/api/user-data', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const { rows } = await pool.query('SELECT data_key, value FROM user_data WHERE username = $1', [username]);
    const out = {};
    rows.forEach(r => { out[r.data_key] = r.value; });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.put('/api/user-data', async (req, res) => {
  try {
    const username = getCurrentUsername(req);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'validation_error', message: 'Request body must be a JSON object of {key: value}' });
    }
    await withTransaction(async client => {
      for (const key of Object.keys(body)) {
        const val = body[key];
        if (val === null || val === undefined) continue;
        await client.query(
          `INSERT INTO user_data (username, data_key, value, updated_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (username, data_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [username, key, String(val)]
        );
      }
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Configurações padrão do administrador ("Admin mode" no modal de
// Configurações) — reaproveita a MESMA tabela user_data sob um username
// reservado/sentinela que nunca corresponde a um login de verdade.
// ════════════════════════════════════════════════
const GLOBAL_SETTINGS_USER = '__global_defaults__';

app.get('/api/global-settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT data_key, value FROM user_data WHERE username = $1', [GLOBAL_SETTINGS_USER]);
    const out = {};
    rows.forEach(r => { out[r.data_key] = r.value; });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.put('/api/global-settings', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'validation_error', message: 'Request body must be a JSON object of {key: value}' });
    }
    await withTransaction(async client => {
      for (const key of Object.keys(body)) {
        const val = body[key];
        if (val === null || val === undefined) continue;
        await client.query(
          `INSERT INTO user_data (username, data_key, value, updated_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (username, data_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          [GLOBAL_SETTINGS_USER, key, String(val)]
        );
      }
    });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// API keys — acesso programático externo (ver api_keys em schema.sql e o
// middleware de autenticação no topo deste arquivo). Gerenciável pela UI em
// Settings → System → API access (ver js/api-keys.js). A key em texto puro só
// existe na resposta do POST — depois disso só o hash (SHA-256) fica
// guardado; perder a key mostrada significa revogar e criar uma nova.
// ════════════════════════════════════════════════
app.get('/api/api-keys', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, key_prefix, role, created_by, created_at, expires_at, last_used_at, revoked_at
       FROM api_keys ORDER BY (revoked_at IS NULL) DESC, created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Mesmo modelo de permissões (admin|user) dos usuários locais/Google — ver
// users.role em schema.sql e ADMIN_ROLES abaixo. Padrão 'user' (menor
// privilégio) quando o campo não é enviado.
const API_KEY_ROLES = ['admin', 'user'];

// Validade escolhida na criação (ver seletor "Validity" em js/api-keys.js) —
// convertida para uma data absoluta em expires_at. 'never' => null (nunca
// expira, preserva o comportamento anterior a este campo existir). Usa
// aritmética de calendário (setMonth/setFullYear) em vez de somar ms fixos,
// para "1 month"/"1 year" caírem no mesmo dia do mês/ano seguinte mesmo
// atravessando meses de tamanho diferente ou anos bissextos.
const API_KEY_VALIDITIES = ['1d', '1w', '1m', '1y', 'never'];
function computeApiKeyExpiresAt(validity) {
  if (validity === 'never') return null;
  const d = new Date();
  switch (validity) {
    case '1d': d.setDate(d.getDate() + 1); break;
    case '1w': d.setDate(d.getDate() + 7); break;
    case '1m': d.setMonth(d.getMonth() + 1); break;
    case '1y': d.setFullYear(d.getFullYear() + 1); break;
    default: return undefined; // valor inválido — ver checagem em POST abaixo
  }
  return d;
}

app.post('/api/api-keys', requireAdmin, async (req, res) => {
  const { name, role, validity } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'validation_error', message: '"name" is required' });
  }
  const finalRole = role || 'user';
  if (!API_KEY_ROLES.includes(finalRole)) {
    return res.status(400).json({ error: 'validation_error', message: `"role" must be one of: ${API_KEY_ROLES.join(', ')}` });
  }
  const finalValidity = validity || 'never';
  if (!API_KEY_VALIDITIES.includes(finalValidity)) {
    return res.status(400).json({ error: 'validation_error', message: `"validity" must be one of: ${API_KEY_VALIDITIES.join(', ')}` });
  }
  const expiresAt = computeApiKeyExpiresAt(finalValidity);
  try {
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12);
    const createdBy = getCurrentUsername(req);
    const { rows } = await pool.query(
      `INSERT INTO api_keys (name, key_prefix, key_hash, role, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, key_prefix, role, created_by, created_at, expires_at, last_used_at, revoked_at`,
      [name.trim(), keyPrefix, keyHash, finalRole, createdBy, expiresAt]
    );
    // Nunca grava a key em si (rawKey) no audit_log — só nome/role/validade.
    await logAudit(createdBy, 'create', 'api_key', String(rows[0].id), name.trim(), `Role: ${finalRole}, validity: ${finalValidity}`);
    res.status(201).json({ ...rows[0], key: rawKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Exclusão permanente (antes era um soft-delete — ver revoked_at legado em
// schema.sql). A ação "Delete" na UI agora remove a linha de fato: uma key
// apagada não pode mais ser recuperada nem reaparece na lista.
app.delete('/api/api-keys/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'validation_error', message: 'Invalid id' });
  try {
    const before = await pool.query('SELECT name FROM api_keys WHERE id = $1', [id]);
    const { rows } = await pool.query('DELETE FROM api_keys WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: `API key '${id}' not found` });
    await logAudit(getCurrentUsername(req), 'delete', 'api_key', String(id), before.rows[0] && before.rows[0].name);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Usuários e permissões (Settings → System → Manage users) — ver users em
// schema.sql. Só admin acessa (requireAdmin abaixo). Contas Google aparecem
// aqui assim que forem vistas pela primeira vez (login com Google, mais
// abaixo) — um admin pode promovê-las, mas não pode dar/trocar senha nelas
// (só contas locais, is_local=1, têm senha). Instalações antigas ainda
// podem ter contas auth_provider='ntlm' do login do Windows (removido) —
// um admin pode desabilitá-las/excluí-las. Nunca devolve password_hash.
// ════════════════════════════════════════════════
const USERS_PUBLIC_COLUMNS = 'username, role, is_local, disabled, created_at, created_by, auth_provider';

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${USERS_PUBLIC_COLUMNS} FROM users ORDER BY is_local DESC, username`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'validation_error', message: '"username" is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'validation_error', message: '"password" must be at least 4 characters' });
  }
  const roleVal = role === 'admin' ? 'admin' : 'user';
  try {
    const trimmed = username.trim();
    const { rows: existing } = await pool.query('SELECT username FROM users WHERE username = $1', [trimmed]);
    if (existing.length) return res.status(409).json({ error: 'conflict', message: `User '${trimmed}' already exists` });
    await pool.query(
      "INSERT INTO users (username, password_hash, role, is_local, created_by, auth_provider) VALUES ($1, $2, $3, 1, $4, 'local')",
      [trimmed, hashPassword(password), roleVal, getCurrentUsername(req)]
    );
    await ensureDefaultFolder(trimmed);
    const { rows } = await pool.query(`SELECT ${USERS_PUBLIC_COLUMNS} FROM users WHERE username = $1`, [trimmed]);
    // Nunca grava a senha (nem o hash) no audit_log — só o role atribuído.
    await logAudit(getCurrentUsername(req), 'create', 'user', trimmed, trimmed, `Role: ${roleVal}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.put('/api/users/:username', requireAdmin, async (req, res) => {
  const username = req.params.username;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `User '${username}' not found` });

    const newRole = req.body.role != null ? (req.body.role === 'admin' ? 'admin' : 'user') : existing.role;
    const newDisabled = req.body.disabled != null ? !!req.body.disabled : !!existing.disabled;

    // Guarda contra lockout total: se esta mudança tiraria o role admin ou
    // desabilitaria a última conta admin habilitada, recusa.
    const wasEnabledAdmin = existing.role === 'admin' && !existing.disabled;
    const willStillBeEnabledAdmin = newRole === 'admin' && !newDisabled;
    if (wasEnabledAdmin && !willStillBeEnabledAdmin) {
      const remaining = await countEnabledAdmins(username);
      if (remaining < 1) return res.status(409).json({ error: 'conflict', message: 'At least one enabled admin must remain' });
    }

    let passwordHash = existing.password_hash;
    if (req.body.password) {
      if (!existing.is_local) return res.status(400).json({ error: 'validation_error', message: 'Only local users have a password' });
      if (typeof req.body.password !== 'string' || req.body.password.length < 4) {
        return res.status(400).json({ error: 'validation_error', message: '"password" must be at least 4 characters' });
      }
      passwordHash = hashPassword(req.body.password);
    }

    await pool.query(
      'UPDATE users SET role = $1, disabled = $2, password_hash = $3 WHERE username = $4',
      [newRole, newDisabled ? 1 : 0, passwordHash, username]
    );
    const { rows } = await pool.query(`SELECT ${USERS_PUBLIC_COLUMNS} FROM users WHERE username = $1`, [username]);
    // Nunca grava senha/hash no audit_log — só sinaliza QUE ela mudou (sem o
    // valor), junto de role/disabled reais via summarizeChangedFields.
    const changedLabels = [];
    if (existing.role !== newRole) changedLabels.push('role');
    if (!!existing.disabled !== !!newDisabled) changedLabels.push('disabled');
    if (req.body.password) changedLabels.push('password');
    await logAudit(getCurrentUsername(req), 'update', 'user', username, username, changedLabels.length ? `Changed: ${changedLabels.join(', ')}` : null);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.delete('/api/users/:username', requireAdmin, async (req, res) => {
  const username = req.params.username;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `User '${username}' not found` });
    if (existing.role === 'admin' && !existing.disabled) {
      const remaining = await countEnabledAdmins(username);
      if (remaining < 1) return res.status(409).json({ error: 'conflict', message: 'At least one enabled admin must remain' });
    }
    await pool.query('DELETE FROM users WHERE username = $1', [username]); // cascades sessions (ON DELETE CASCADE)
    await logAudit(getCurrentUsername(req), 'delete', 'user', username, username);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Validation + write helpers
// ════════════════════════════════════════════════
function resolveTopics(body) {
  if (Array.isArray(body.topics) && body.topics.length) return body.topics;
  if (body.topic && typeof body.topic === 'string') return [body.topic];
  return [];
}

function isNonEmptyArray(val) {
  return Array.isArray(val) && val.length > 0;
}

function validateBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Request body must be a JSON object'];
  // `id` NÃO é mais validado/aceito aqui — pedido do usuário: "implementar
  // ID sequencial de verdade". O id é sempre atribuído pelo Postgres na
  // criação (INSERT ... RETURNING id, ver POST /api/commands abaixo), nunca
  // lido do body (mesmo que um cliente antigo/CSV reaproveitado ainda mande
  // um — é simplesmente ignorado, igual ao id do template de import).
  if (!isNonEmptyArray(body.vendors)) errors.push('"vendors" is required (exactly one vendor)');
  else if (body.vendors.length > 1) errors.push('"vendors" must contain exactly one vendor (a command belongs to a single vendor)');
  if (!isNonEmptyArray(body.systems)) errors.push('"systems" is required (at least one system)');
  if (!isNonEmptyArray(body.versions)) errors.push('"versions" is required (at least one version)');
  if (!isNonEmptyArray(body.environments)) errors.push('"environments" is required (at least one environment)');
  if (!resolveTopics(body).length) errors.push('"topics" is required (at least one topic)');
  if (!body.name || typeof body.name !== 'string') errors.push('"name" is required');
  return errors;
}

const NULLABLE_TEXT_FIELDS = ['name_empty', 'desc_empty'];
const REQUIRED_TEXT_FIELDS = ['name', 'desc'];

function buildCommandColumns(body) {
  const topics = resolveTopics(body);
  // Guarda estrutural: requires_ip_port faz buildCardHtmlForRow
  // (js/db-render-engine.js) trocar para um "empty state" quando IP/Porta
  // genéricos não estão preenchidos — se não existir NENHUMA linha
  // variant='empty' cadastrada, o card desaparece da tela sem erro visível.
  // Por isso o server nunca aceita requires_ip_port=1 sem pelo
  // menos uma linha empty com conteúdo.
  const hasEmptyLines = Array.isArray(body.lines) && body.lines.some(l => l && l.variant === 'empty' && String(l.content || '').trim());
  const cols = {
    topic: topics[0],
    icon: body.icon || '📄',
    sort_order: Number.isInteger(body.sort_order) ? body.sort_order : 0,
    requires_ip_port: (body.requires_ip_port && hasEmptyLines) ? 1 : 0,
    placeholder_resolver: body.placeholder_resolver || null,
    // `details` substitui about_purpose/about_when/about_obs (removidos) —
    // conteúdo rico (HTML) vindo do editor contenteditable de Details (ver
    // js/command-editor.js), sanitizado aqui igual à descrição de uma Note
    // (mesma função, mesma allow-list de tags/estilo — ver sanitizeNoteHtml
    // acima), nunca confiado cru só porque veio autenticado.
    details: sanitizeNoteHtml(body.details || ''),
  };
  for (const f of REQUIRED_TEXT_FIELDS) cols[f] = body[f] != null ? body[f] : '';
  for (const f of NULLABLE_TEXT_FIELDS) cols[f] = body[f] != null ? body[f] : null;
  return cols;
}

// Insere todas as tabelas filhas de um comando, dentro da MESMA transação
// (client) do INSERT/UPDATE de `commands` que chamou isto.
async function insertChildren(client, id, body) {
  for (const tp of resolveTopics(body)) {
    await client.query('INSERT INTO command_topics (command_id, topic) VALUES ($1, $2)', [id, tp]);
  }
  for (const v of (body.vendors || [])) {
    await client.query('INSERT INTO command_vendors (command_id, vendor) VALUES ($1, $2)', [id, v]);
  }
  for (const s of (body.systems || [])) {
    await client.query('INSERT INTO command_systems (command_id, system) VALUES ($1, $2)', [id, s]);
  }
  for (const v of (body.versions || [])) {
    await client.query('INSERT INTO command_versions (command_id, version) VALUES ($1, $2)', [id, v]);
  }
  for (const e of (body.environments || [])) {
    await client.query('INSERT INTO command_environments (command_id, environment) VALUES ($1, $2)', [id, e]);
  }

  const lines = body.lines || [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    await client.query(
      `INSERT INTO command_lines (command_id, variant, sort_order, line_type, prompt, content, supports_export, image_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        line.variant || 'default',
        Number.isInteger(line.sort_order) ? line.sort_order : i,
        line.line_type || 'cmd',
        line.prompt || null,
        line.content || '',
        line.supports_export ? 1 : 0,
        line.line_type === 'image' ? (line.image_data || null) : null,
      ]
    );
  }
}

// ════════════════════════════════════════════════
// POST /api/commands — create
// ════════════════════════════════════════════════
app.post('/api/commands', async (req, res) => {
  try {
    const errors = validateBody(req.body);
    if (errors.length) return res.status(400).json({ error: 'validation_error', message: errors.join('; ') });

    const cols = buildCommandColumns(req.body);
    // Todo comando criado por esta API é atribuído ao usuário atual
    // (created_by = modified_by = quem está autenticado) — EXCETO quando o
    // chamador é admin e envia o header X-Save-As-System (ver "Import as
    // System commands" em js/csv-import.js): nesse caso o comando é gravado
    // como created_by=modified_by='System', igual aos comandos de referência
    // trazidos de fábrica. Ignorado silenciosamente para não-admins — não é
    // um erro, o comando simplesmente é criado como próprio (comportamento
    // padrão), já que confiar num header vindo do cliente para elevar
    // privilégio seria inseguro sem essa checagem de role no servidor.
    const username = getCurrentUsername(req);
    const wantsSystem = req.headers['x-save-as-system'] === '1' || req.headers['x-save-as-system'] === 'true';
    const isAdmin = wantsSystem && (await getCurrentRole(req)) === 'admin';
    cols.created_by = isAdmin ? 'System' : username;
    cols.modified_by = isAdmin ? 'System' : username;

    // id não é mais lido do body — o Postgres atribui um INTEGER sequencial
    // sozinho (commands.id SERIAL, ver schema.sql) e devolve pelo RETURNING
    // abaixo; nunca mais colide (era só o slug baseado no Name que podia
    // colidir antes), então a checagem de conflito 409 que existia aqui
    // (findCommand(id) antes de inserir) deixou de fazer sentido e foi
    // removida.
    let id;
    await withTransaction(async client => {
      const { rows } = await client.query(
        `INSERT INTO commands (
          topic, icon, sort_order, requires_ip_port, placeholder_resolver,
          name, name_empty, "desc", desc_empty,
          details,
          created_by, modified_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id`,
        [
          cols.topic, cols.icon, cols.sort_order, cols.requires_ip_port,
          cols.placeholder_resolver,
          cols.name, cols.name_empty, cols.desc, cols.desc_empty,
          cols.details,
          cols.created_by, cols.modified_by,
        ]
      );
      id = rows[0].id;
      await insertChildren(client, id, req.body);
    });

    await logAudit(username, 'create', 'command', id, cols.name);
    const row = await findCommand(id);
    res.status(201).json(await shapeCommand(row, username));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// PUT /api/commands/:id — full update (replace children)
// ════════════════════════════════════════════════
app.put('/api/commands/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const found = await findCommand(id);
    if (!found) return res.status(404).json({ error: 'not_found', message: `Command '${id}' not found` });

    const currentUser = getCurrentUsername(req);
    // Um usuário comum pode editar o PRÓPRIO comando OU um comando de
    // referência (created_by='System') — pedido do usuário: "todos usuários
    // podem alterar os comandos do sistema". Não pode editar o comando de
    // OUTRO usuário — precisa duplicar primeiro (POST normal, cria um
    // comando novo em nome dele) e editar a cópia. Admins não têm essa
    // restrição: podem alterar qualquer comando.
    const isSystemCommand = found.created_by === 'System';
    if ((await getCurrentRole(req)) !== 'admin' && found.created_by !== currentUser && !isSystemCommand) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'You can only edit your own commands (or System commands). Duplicate it to create your own editable copy.',
      });
    }

    // id não é mais um campo do body (é sempre o INTEGER da URL, gerado uma
    // única vez na criação) — não há mais o que mesclar/comparar aqui.
    const errors = validateBody(req.body);
    if (errors.length) return res.status(400).json({ error: 'validation_error', message: errors.join('; ') });

    const cols = buildCommandColumns(req.body);
    cols.modified_by = currentUser;

    await withTransaction(async client => {
      await client.query(
        `UPDATE commands SET
          topic = $1, icon = $2, sort_order = $3,
          requires_ip_port = $4,
          placeholder_resolver = $5,
          name = $6, name_empty = $7, "desc" = $8, desc_empty = $9,
          details = $10,
          modified_by = $11,
          updated_at = NOW()
        WHERE id = $12`,
        [
          cols.topic, cols.icon, cols.sort_order,
          cols.requires_ip_port,
          cols.placeholder_resolver,
          cols.name, cols.name_empty, cols.desc, cols.desc_empty,
          cols.details,
          cols.modified_by,
          id,
        ]
      );

      await client.query('DELETE FROM command_topics WHERE command_id = $1', [id]);
      await client.query('DELETE FROM command_vendors WHERE command_id = $1', [id]);
      await client.query('DELETE FROM command_systems WHERE command_id = $1', [id]);
      await client.query('DELETE FROM command_versions WHERE command_id = $1', [id]);
      await client.query('DELETE FROM command_environments WHERE command_id = $1', [id]);
      await client.query('DELETE FROM command_lines WHERE command_id = $1', [id]);

      await insertChildren(client, id, req.body);
    });

    // Resumo de "o que foi feito" nesta edição (pedido do usuário) — compara
    // só os campos ESCALARES do comando (não tenta diffar as linhas/tags/
    // vendors/etc., que são sempre apagadas e reinseridas por inteiro a cada
    // PUT — ver DELETEs acima — então "mudaram" seria sempre verdadeiro e
    // sem sinal real).
    const changeDetails = summarizeChangedFields(found, cols, {
      name: 'name', topic: 'topic', desc: 'description',
      details: 'details',
      requires_ip_port: 'IP+Port pairing',
    });
    await logAudit(currentUser, 'update', 'command', id, cols.name, changeDetails);
    const row = await findCommand(id);
    res.json(await shapeCommand(row, currentUser));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// DELETE /api/commands/:id
// ════════════════════════════════════════════════
app.delete('/api/commands/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const found = await findCommand(id);
    if (!found) return res.status(404).json({ error: 'not_found', message: `Command '${id}' not found` });

    const currentUser = getCurrentUsername(req);
    // Mesma regra do PUT acima: um usuário comum só exclui o PRÓPRIO
    // comando (created_by === currentUser, seja criado do zero ou
    // copiado/duplicado de outro usuário — a cópia já nasce com
    // created_by = quem copiou, ver POST /api/commands). Comandos
    // 'System' e de outros usuários exigem admin. Admins não têm
    // restrição (pedido do usuário: "admins continuam podendo fazer tudo").
    if ((await getCurrentRole(req)) !== 'admin' && found.created_by !== currentUser) {
      const message = found.created_by === 'System'
        ? 'Only admins can delete System commands.'
        : 'You can only delete your own commands.';
      return res.status(403).json({ error: 'forbidden', message });
    }
    // command_id em folder_commands tem FK ON DELETE CASCADE (ver schema.sql)
    // — apagar o comando já limpa sozinho sua presença em qualquer pasta.
    await pool.query('DELETE FROM commands WHERE id = $1', [id]);
    await logAudit(currentUser, 'delete', 'command', id, found.name);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Catálogos administráveis — Vendor / Sistema / Versão / Ambiente / Tópico /
// Parâmetro. `key` nunca é editável depois de criado — só label/cor/ordem.
// Exclusão é bloqueada com 409 quando o valor está em uso por pelo menos um
// comando, ou (só para tópicos) quando é protegido (is_protected=1).
// ════════════════════════════════════════════════
const CATALOG_KEY_RE = /^[A-Za-z0-9._-]{1,40}$/;

// `key` de Vendor/System/Version/Environment/Topic é sempre gerado no servidor
// a partir do `label` (slug) — o usuário nunca digita/vê um "ID" separado.
function slugifyCatalogKey(label) {
  let s = String(label == null ? '' : label).trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!s) s = 'item';
  return s.slice(0, 40);
}
// Acrescenta -2/-3/... até `existsFn(candidate)` (async) retornar false.
async function uniqueCatalogKey(base, existsFn) {
  let candidate = base;
  let n = 2;
  while (await existsFn(candidate)) {
    const suffix = '-' + n;
    candidate = base.slice(0, Math.max(1, 40 - suffix.length)) + suffix;
    n++;
  }
  return candidate;
}
async function keyExists(table, key) {
  const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE key = $1`, [key]);
  return rows.length > 0;
}

// Conta quantos comandos usam uma versão/ambiente/tópico/vendor/sistema.
// COUNT(*) volta como bigint (string) no driver `pg` — Number() normaliza.
async function countUsage(table, column, key) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = $1`, [key]);
  return Number(rows[0].n);
}

// GET /api/catalogs — todos os catálogos de uma vez (usado no boot do
// front-end e para recarregar a UI depois de qualquer criação/edição/exclusão).
app.get('/api/catalogs', async (req, res) => {
  try {
    const [vendors, systems, versions, environments, topics, parameters, prompts, versionEnvironments, environmentTopics] = await Promise.all([
      pool.query('SELECT * FROM vendors ORDER BY sort_order, key'),
      pool.query('SELECT * FROM systems ORDER BY sort_order, key'),
      pool.query('SELECT * FROM versions ORDER BY sort_order, key'),
      pool.query('SELECT * FROM environments ORDER BY sort_order, key'),
      pool.query('SELECT * FROM topics ORDER BY sort_order, key'),
      pool.query('SELECT * FROM parameters ORDER BY sort_order, key'),
      pool.query('SELECT * FROM prompts ORDER BY sort_order, key'),
      pool.query('SELECT version, environment FROM version_environments'),
      pool.query('SELECT environment, topic FROM environment_topics'),
    ]);
    res.json({
      vendors: vendors.rows,
      systems: systems.rows,
      versions: versions.rows,
      environments: environments.rows,
      topics: topics.rows,
      parameters: parameters.rows,
      prompts: prompts.rows,
      version_environments: versionEnvironments.rows,
      environment_topics: environmentTopics.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Substitui (delete+insert) o conjunto de pais vinculados a um item filho —
// usado pela cascata N:N Versão ↔ Ambiente / Ambiente ↔ Tópico.
async function replaceScopeLinks(joinTable, childCol, childKey, parentCol, parentKeys) {
  await pool.query(`DELETE FROM ${joinTable} WHERE ${childCol} = $1`, [childKey]);
  for (const pk of (Array.isArray(parentKeys) ? parentKeys : [])) {
    await pool.query(`INSERT INTO ${joinTable} (${childCol}, ${parentCol}) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [childKey, pk]);
  }
}

// ── Fabricantes (Vendor) ──────────────────────────
app.post('/api/vendors', async (req, res) => {
  const { label, color } = req.body || {};
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
  try {
    const key = await uniqueCatalogKey(slugifyCatalogKey(label), k => keyExists('vendors', k));
    const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM vendors');
    await pool.query('INSERT INTO vendors (key, label, color, sort_order) VALUES ($1, $2, $3, $4)', [key, label, color || '#8B949E', maxRes.rows[0].m + 1]);
    const { rows } = await pool.query('SELECT * FROM vendors WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'create', 'vendor', key, label);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.put('/api/vendors/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM vendors WHERE key = $1', [key]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `Vendor '${key}' not found` });
    const label = req.body.label != null ? req.body.label : existing.label;
    const color = req.body.color != null ? req.body.color : existing.color;
    const sortOrder = Number.isInteger(req.body.sort_order) ? req.body.sort_order : existing.sort_order;
    if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
    await pool.query('UPDATE vendors SET label = $1, color = $2, sort_order = $3 WHERE key = $4', [label, color, sortOrder, key]);
    const { rows } = await pool.query('SELECT * FROM vendors WHERE key = $1', [key]);
    const details = summarizeChangedFields(existing, { label, color, sort_order: sortOrder }, { label: 'label', color: 'color', sort_order: 'order' });
    await logAudit(getCurrentUsername(req), 'update', 'vendor', key, label, details);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.delete('/api/vendors/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM vendors WHERE key = $1', [key]);
    if (!existingRows.length) return res.status(404).json({ error: 'not_found', message: `Vendor '${key}' not found` });
    const count = await countUsage('command_vendors', 'vendor', key);
    if (count > 0) return res.status(409).json({ error: 'in_use', message: `Vendor '${key}' is used by ${count} command(s)`, count });
    await pool.query('DELETE FROM vendors WHERE key = $1', [key]); // cascades systems (and, por sua vez, versions)
    await logAudit(getCurrentUsername(req), 'delete', 'vendor', key, existingRows[0].label);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ── Sistemas ───────────────────────────────────────
// Hierarquia estrita: um Sistema pertence a exatamente um Vendor.
app.post('/api/systems', async (req, res) => {
  const { label, color, vendor } = req.body || {};
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
  if (!vendor || typeof vendor !== 'string') return res.status(400).json({ error: 'validation_error', message: '"vendor" is required' });
  try {
    if (!(await keyExists('vendors', vendor))) return res.status(400).json({ error: 'validation_error', message: `Vendor '${vendor}' not found` });
    const key = await uniqueCatalogKey(slugifyCatalogKey(label), k => keyExists('systems', k));
    const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM systems');
    await pool.query('INSERT INTO systems (key, vendor, label, color, sort_order) VALUES ($1, $2, $3, $4, $5)', [key, vendor, label, color || '#8B949E', maxRes.rows[0].m + 1]);
    const { rows } = await pool.query('SELECT * FROM systems WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'create', 'system', key, label);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.put('/api/systems/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM systems WHERE key = $1', [key]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `System '${key}' not found` });
    const label = req.body.label != null ? req.body.label : existing.label;
    const color = req.body.color != null ? req.body.color : existing.color;
    const vendor = req.body.vendor != null ? req.body.vendor : existing.vendor;
    const sortOrder = Number.isInteger(req.body.sort_order) ? req.body.sort_order : existing.sort_order;
    if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
    if (!vendor || typeof vendor !== 'string') return res.status(400).json({ error: 'validation_error', message: '"vendor" is required' });
    if (!(await keyExists('vendors', vendor))) return res.status(400).json({ error: 'validation_error', message: `Vendor '${vendor}' not found` });
    await pool.query('UPDATE systems SET label = $1, color = $2, vendor = $3, sort_order = $4 WHERE key = $5', [label, color, vendor, sortOrder, key]);
    // Reatribuir o vendor do Sistema mantém versions.vendor em sincronia.
    await pool.query('UPDATE versions SET vendor = $1 WHERE system = $2', [vendor, key]);
    const { rows } = await pool.query('SELECT * FROM systems WHERE key = $1', [key]);
    const details = summarizeChangedFields(existing, { label, color, vendor, sort_order: sortOrder }, { label: 'label', color: 'color', vendor: 'vendor', sort_order: 'order' });
    await logAudit(getCurrentUsername(req), 'update', 'system', key, label, details);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.delete('/api/systems/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM systems WHERE key = $1', [key]);
    if (!existingRows.length) return res.status(404).json({ error: 'not_found', message: `System '${key}' not found` });
    const count = await countUsage('command_systems', 'system', key);
    if (count > 0) return res.status(409).json({ error: 'in_use', message: `System '${key}' is used by ${count} command(s)`, count });
    await pool.query('DELETE FROM systems WHERE key = $1', [key]); // cascades versions (system FK)
    await logAudit(getCurrentUsername(req), 'delete', 'system', key, existingRows[0].label);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ── Vínculos N:N Versão ↔ Ambiente / Ambiente ↔ Tópico ──
app.put('/api/environments/:key/versions', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: envRows } = await pool.query('SELECT * FROM environments WHERE key = $1', [key]);
    const env = envRows[0];
    if (!env) return res.status(404).json({ error: 'not_found', message: `Environment '${key}' not found` });
    // Só faz sentido vincular Ambiente a Versões do MESMO Sistema (environments.system,
    // ver schema.sql) — filtra silenciosamente qualquer versão de outro Sistema que
    // porventura venha no body, em vez de recusar a chamada inteira por isso.
    const requested = Array.isArray(req.body && req.body.versions) ? req.body.versions : [];
    let allowed = requested;
    if (env.system && requested.length) {
      const { rows: validRows } = await pool.query('SELECT key FROM versions WHERE system = $1 AND key = ANY($2)', [env.system, requested]);
      allowed = validRows.map(r => r.key);
    }
    await replaceScopeLinks('version_environments', 'environment', key, 'version', allowed);
    const { rows } = await pool.query('SELECT version FROM version_environments WHERE environment = $1', [key]);
    res.json({ environment: key, versions: rows.map(r => r.version) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.put('/api/topics/:key/environments', async (req, res) => {
  const key = req.params.key;
  try {
    if (!(await keyExists('topics', key))) return res.status(404).json({ error: 'not_found', message: `Topic '${key}' not found` });
    await replaceScopeLinks('environment_topics', 'topic', key, 'environment', req.body && req.body.environments);
    const { rows } = await pool.query('SELECT environment FROM environment_topics WHERE topic = $1', [key]);
    res.json({ topic: key, environments: rows.map(r => r.environment) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ── Versões ──────────────────────────────────────
// `key` sozinho não é globalmente único — a PK real é composta (system, key).
app.post('/api/versions', async (req, res) => {
  const { label, color, system } = req.body || {};
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
  if (!system || typeof system !== 'string') return res.status(400).json({ error: 'validation_error', message: '"system" is required' });
  try {
    const { rows: systemRows } = await pool.query('SELECT * FROM systems WHERE key = $1', [system]);
    const systemRow = systemRows[0];
    if (!systemRow) return res.status(400).json({ error: 'validation_error', message: `System '${system}' not found` });
    // UNIQUE(vendor, key) — a checagem de unicidade precisa cobrir todo o vendor.
    const key = await uniqueCatalogKey(slugifyCatalogKey(label), async k => {
      const { rows } = await pool.query('SELECT 1 FROM versions WHERE vendor = $1 AND key = $2', [systemRow.vendor, k]);
      return rows.length > 0;
    });
    const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM versions');
    await pool.query(
      'INSERT INTO versions (system, vendor, key, label, color, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
      [system, systemRow.vendor, key, label, color || '#8B949E', maxRes.rows[0].m + 1]
    );
    const { rows } = await pool.query('SELECT * FROM versions WHERE system = $1 AND key = $2', [system, key]);
    await logAudit(getCurrentUsername(req), 'create', 'version', key, label, `System: ${system}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.put('/api/versions/:system/:key', async (req, res) => {
  const { system, key } = req.params;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM versions WHERE system = $1 AND key = $2', [system, key]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `Version '${key}' not found under system '${system}'` });
    const label = req.body.label != null ? req.body.label : existing.label;
    const color = req.body.color != null ? req.body.color : existing.color;
    const sortOrder = Number.isInteger(req.body.sort_order) ? req.body.sort_order : existing.sort_order;
    const newSystem = req.body.system != null ? req.body.system : system;
    if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
    let newVendor = existing.vendor;
    if (newSystem !== system) {
      const { rows: systemRows } = await pool.query('SELECT * FROM systems WHERE key = $1', [newSystem]);
      const systemRow = systemRows[0];
      if (!systemRow) return res.status(400).json({ error: 'validation_error', message: `System '${newSystem}' not found` });
      newVendor = systemRow.vendor;
      const { rows: dupRows1 } = await pool.query('SELECT 1 FROM versions WHERE system = $1 AND key = $2', [newSystem, key]);
      if (dupRows1.length) return res.status(409).json({ error: 'conflict', message: `Version '${key}' already exists under system '${newSystem}'` });
      const { rows: dupRows2 } = await pool.query('SELECT 1 FROM versions WHERE vendor = $1 AND key = $2 AND system != $3', [newVendor, key, system]);
      if (dupRows2.length) return res.status(409).json({ error: 'conflict', message: `Version '${key}' already exists under another system of vendor '${newVendor}'` });
    }
    await pool.query(
      'UPDATE versions SET label = $1, color = $2, sort_order = $3, system = $4, vendor = $5 WHERE system = $6 AND key = $7',
      [label, color, sortOrder, newSystem, newVendor, system, key]
    );
    const { rows } = await pool.query('SELECT * FROM versions WHERE system = $1 AND key = $2', [newSystem, key]);
    const details = summarizeChangedFields(existing, { label, color, sort_order: sortOrder, system: newSystem }, { label: 'label', color: 'color', sort_order: 'order', system: 'system' });
    await logAudit(getCurrentUsername(req), 'update', 'version', key, label, details);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.delete('/api/versions/:system/:key', async (req, res) => {
  const { system, key } = req.params;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM versions WHERE system = $1 AND key = $2', [system, key]);
    if (!existingRows.length) return res.status(404).json({ error: 'not_found', message: `Version '${key}' not found under system '${system}'` });
    const count = await countUsage('command_versions', 'version', key);
    if (count > 0) return res.status(409).json({ error: 'in_use', message: `Version '${key}' is used by ${count} command(s)`, count });
    await pool.query('DELETE FROM versions WHERE system = $1 AND key = $2', [system, key]);
    await logAudit(getCurrentUsername(req), 'delete', 'version', key, existingRows[0].label, `System: ${system}`);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ── Ambientes ────────────────────────────────────
// `system` é obrigatório (mesmo padrão de POST /api/versions) — `vendor` é
// sempre derivado do Sistema escolhido (denormalizado, mantido em sincronia
// pelo backend, nunca aceito diretamente do body).
app.post('/api/environments', async (req, res) => {
  const { label, color, system } = req.body || {};
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
  if (!system || typeof system !== 'string') return res.status(400).json({ error: 'validation_error', message: '"system" is required' });
  try {
    const { rows: systemRows } = await pool.query('SELECT * FROM systems WHERE key = $1', [system]);
    const systemRow = systemRows[0];
    if (!systemRow) return res.status(400).json({ error: 'validation_error', message: `System '${system}' not found` });
    const key = await uniqueCatalogKey(slugifyCatalogKey(label), k => keyExists('environments', k));
    const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM environments');
    await pool.query(
      'INSERT INTO environments (key, system, vendor, label, color, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
      [key, system, systemRow.vendor, label, color || '#8B949E', maxRes.rows[0].m + 1]
    );
    const { rows } = await pool.query('SELECT * FROM environments WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'create', 'environment', key, label, `System: ${system}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.put('/api/environments/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM environments WHERE key = $1', [key]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `Environment '${key}' not found` });
    const label = req.body.label != null ? req.body.label : existing.label;
    const color = req.body.color != null ? req.body.color : existing.color;
    const sortOrder = Number.isInteger(req.body.sort_order) ? req.body.sort_order : existing.sort_order;
    const newSystem = req.body.system != null ? req.body.system : existing.system;
    if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
    if (!newSystem || typeof newSystem !== 'string') return res.status(400).json({ error: 'validation_error', message: '"system" is required' });
    let newVendor = existing.vendor;
    const systemChanged = newSystem !== existing.system;
    if (systemChanged) {
      const { rows: systemRows } = await pool.query('SELECT * FROM systems WHERE key = $1', [newSystem]);
      const systemRow = systemRows[0];
      if (!systemRow) return res.status(400).json({ error: 'validation_error', message: `System '${newSystem}' not found` });
      newVendor = systemRow.vendor;
    }
    await pool.query('UPDATE environments SET label = $1, color = $2, sort_order = $3, system = $4, vendor = $5 WHERE key = $6', [label, color, sortOrder, newSystem, newVendor, key]);
    if (systemChanged) {
      // Os vínculos Versão↔Ambiente existentes (version_environments) foram
      // registrados sob o Sistema ANTERIOR — trocar o Sistema do ambiente os
      // deixaria "soltos"/inconsistentes (versões de outro Sistema vinculadas
      // a este ambiente). Mais seguro resetar e deixar o administrador
      // revincular pela tela de Register do que manter um vínculo que não
      // faz mais sentido.
      await pool.query('DELETE FROM version_environments WHERE environment = $1', [key]);
    }
    const { rows } = await pool.query('SELECT * FROM environments WHERE key = $1', [key]);
    const details = summarizeChangedFields(existing, { label, color, sort_order: sortOrder, system: newSystem }, { label: 'label', color: 'color', sort_order: 'order', system: 'system' });
    await logAudit(getCurrentUsername(req), 'update', 'environment', key, label, details);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.delete('/api/environments/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM environments WHERE key = $1', [key]);
    if (!existingRows.length) return res.status(404).json({ error: 'not_found', message: `Environment '${key}' not found` });
    const count = await countUsage('command_environments', 'environment', key);
    if (count > 0) return res.status(409).json({ error: 'in_use', message: `Environment '${key}' is used by ${count} command(s)`, count });
    await pool.query('DELETE FROM environments WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'delete', 'environment', key, existingRows[0].label);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ── Tópicos ──────────────────────────────────────
app.post('/api/topics', async (req, res) => {
  const { label, color } = req.body || {};
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
  try {
    const key = await uniqueCatalogKey(slugifyCatalogKey(label), k => keyExists('topics', k));
    const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM topics WHERE is_protected = 0');
    await pool.query(
      `INSERT INTO topics (key, label, color, sort_order, is_protected) VALUES ($1, $2, $3, $4, 0)`,
      [key, label, color || '#8B949E', maxRes.rows[0].m + 1]
    );
    const { rows } = await pool.query('SELECT * FROM topics WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'create', 'topic', key, label);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.put('/api/topics/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM topics WHERE key = $1', [key]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `Topic '${key}' not found` });
    const label = req.body.label != null ? req.body.label : existing.label;
    const color = req.body.color != null ? req.body.color : existing.color;
    const sortOrder = Number.isInteger(req.body.sort_order) ? req.body.sort_order : existing.sort_order;
    if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
    // is_protected nunca é alterável por esta API.
    await pool.query('UPDATE topics SET label = $1, color = $2, sort_order = $3 WHERE key = $4', [label, color, sortOrder, key]);
    const { rows } = await pool.query('SELECT * FROM topics WHERE key = $1', [key]);
    const details = summarizeChangedFields(existing, { label, color, sort_order: sortOrder }, { label: 'label', color: 'color', sort_order: 'order' });
    await logAudit(getCurrentUsername(req), 'update', 'topic', key, label, details);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.delete('/api/topics/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM topics WHERE key = $1', [key]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `Topic '${key}' not found` });
    if (existing.is_protected) return res.status(409).json({ error: 'protected', message: `Topic '${key}' is a protected system topic and cannot be deleted` });
    const count = await countUsage('command_topics', 'topic', key);
    if (count > 0) return res.status(409).json({ error: 'in_use', message: `Topic '${key}' is used by ${count} command(s)`, count });
    await pool.query('DELETE FROM topics WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'delete', 'topic', key, existing.label);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ── Parâmetros (campo de busca unificado + botão "Inserir variável") ──
// Conta em quantos comandos DISTINTOS o placeholder {{key}} aparece de verdade
// (linhas normais) — usado para bloquear exclusão de um parâmetro que algum
// comando ainda referencia no texto.
async function countParameterTemplateUsage(key) {
  const needle = `{{${key}}}`;
  const usedBy = new Set();
  const lines = await pool.query('SELECT command_id, content FROM command_lines');
  lines.rows.forEach(r => { if (r.content && r.content.includes(needle)) usedBy.add(r.command_id); });
  return usedBy.size;
}
// 'ip'/'port' são lidos DIRETO (não via {{token}}) pela lógica de estado
// vazio do card (requires_ip_port em commands) — excluí-los quebraria essa
// lógica para todo comando marcado com a flag, mesmo que nenhum {{ip}}
// literal apareça no texto.
async function parameterStructuralDependencyCount(key) {
  if (key === 'ip' || key === 'port') return countUsage('commands', 'requires_ip_port', 1);
  return 0;
}

app.post('/api/parameters', async (req, res) => {
  const { key, label, sort_order } = req.body || {};
  if (!key || !CATALOG_KEY_RE.test(key)) return res.status(400).json({ error: 'validation_error', message: '"key" is required (letters, numbers, dot, underscore, hyphen only)' });
  if (!label) return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
  try {
    if (await keyExists('parameters', key)) return res.status(409).json({ error: 'conflict', message: `Parameter '${key}' already exists` });
    const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM parameters');
    const order = Number.isInteger(sort_order) ? sort_order : maxRes.rows[0].m + 1;
    await pool.query('INSERT INTO parameters (key, label, sort_order) VALUES ($1, $2, $3)', [key, label, order]);
    const { rows } = await pool.query('SELECT * FROM parameters WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'create', 'parameter', key, label);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.put('/api/parameters/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM parameters WHERE key = $1', [key]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `Parameter '${key}' not found` });
    const label = req.body.label != null ? req.body.label : existing.label;
    const sortOrder = Number.isInteger(req.body.sort_order) ? req.body.sort_order : existing.sort_order;
    if (!label) return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
    // `key` nunca é alterável por esta API.
    await pool.query('UPDATE parameters SET label = $1, sort_order = $2 WHERE key = $3', [label, sortOrder, key]);
    const { rows } = await pool.query('SELECT * FROM parameters WHERE key = $1', [key]);
    const details = summarizeChangedFields(existing, { label, sort_order: sortOrder }, { label: 'label', sort_order: 'order' });
    await logAudit(getCurrentUsername(req), 'update', 'parameter', key, label, details);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.delete('/api/parameters/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM parameters WHERE key = $1', [key]);
    if (!existingRows.length) return res.status(404).json({ error: 'not_found', message: `Parameter '${key}' not found` });
    const structCount = await parameterStructuralDependencyCount(key);
    if (structCount > 0) {
      return res.status(409).json({
        error: 'structural_dependency',
        message: `Parameter '${key}' is read directly by ${structCount} command(s)' empty-state logic (requires_ip_port) and cannot be deleted`,
        count: structCount,
      });
    }
    const usage = await countParameterTemplateUsage(key);
    if (usage > 0) return res.status(409).json({ error: 'in_use', message: `Parameter '${key}' is used by ${usage} command(s)`, count: usage });
    await pool.query('DELETE FROM parameters WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'delete', 'parameter', key, existingRows[0].label);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ── Prompts (campo "Prompt" de cada linha tipo 'cmd' no editor de comandos —
// antes texto livre, ver comentário em server/schema.sql) ──
// `key` é sempre gerado no servidor a partir do `label` (mesmo padrão de
// vendors/environments/topics, ver slugifyCatalogKey acima) — o usuário só
// digita o texto do prompt em si (ex.: "[Expert@FW]#"), nunca uma chave
// separada. Sem contagem de uso no DELETE: command_lines.prompt é só texto
// solto (não uma FK) — excluir um prompt do catálogo nunca altera comandos
// já salvos, só tira a opção do <select> do editor dali em diante.
app.post('/api/prompts', async (req, res) => {
  const { label } = req.body || {};
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
  try {
    const key = await uniqueCatalogKey(slugifyCatalogKey(label), k => keyExists('prompts', k));
    const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM prompts');
    await pool.query('INSERT INTO prompts (key, label, sort_order) VALUES ($1, $2, $3)', [key, label, maxRes.rows[0].m + 1]);
    const { rows } = await pool.query('SELECT * FROM prompts WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'create', 'prompt', key, label);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.put('/api/prompts/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM prompts WHERE key = $1', [key]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'not_found', message: `Prompt '${key}' not found` });
    const label = req.body.label != null ? req.body.label : existing.label;
    const sortOrder = Number.isInteger(req.body.sort_order) ? req.body.sort_order : existing.sort_order;
    if (!label || typeof label !== 'string') return res.status(400).json({ error: 'validation_error', message: '"label" is required' });
    // `key` nunca é alterável por esta API (mesma regra de parameters/vendors/etc.).
    await pool.query('UPDATE prompts SET label = $1, sort_order = $2 WHERE key = $3', [label, sortOrder, key]);
    const { rows } = await pool.query('SELECT * FROM prompts WHERE key = $1', [key]);
    const details = summarizeChangedFields(existing, { label, sort_order: sortOrder }, { label: 'label', sort_order: 'order' });
    await logAudit(getCurrentUsername(req), 'update', 'prompt', key, label, details);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});
app.delete('/api/prompts/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM prompts WHERE key = $1', [key]);
    if (!existingRows.length) return res.status(404).json({ error: 'not_found', message: `Prompt '${key}' not found` });
    await pool.query('DELETE FROM prompts WHERE key = $1', [key]);
    await logAudit(getCurrentUsername(req), 'delete', 'prompt', key, existingRows[0].label);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Backup e restauração do banco de dados (menu Configurações → "Backup &
// Restore" — ver js/backup.js). Convertido para usar `pg_dump`/`pg_restore`
// (CLI do PostgreSQL — precisa estar instalada na imagem do backend, ver
// Dockerfile: pacote `postgresql-client`) em vez do antigo Database#backup()
// do better-sqlite3. Os arquivos ficam num volume dedicado (BACKUP_DIR, por
// padrão /app/backups no Docker — ver docker-compose.yml), fora do container
// da própria aplicação, então sobrevivem a rebuild/restart.
//
// Diferente da versão SQLite antiga, restaurar NÃO precisa derrubar o
// processo: pg_restore --clean recria as tabelas via uma conexão própria
// (fora do pool do Node), então basta a resposta HTTP confirmar sucesso — o
// próprio pool já enxerga os dados novos na próxima query.
//
// O agendamento (diário/semanal/mensal + horário) continua guardado nas
// MESMAS chaves de /api/global-settings (tabela user_data, username
// sentinela GLOBAL_SETTINGS_USER).
// ════════════════════════════════════════════════
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backup');

function runCli(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

function pad2(n) { return String(n).padStart(2, '0'); }

function backupTimestamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

async function performBackup(prefix = 'backup') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const filename = `${prefix}-${backupTimestamp()}.dump`;
  const full = path.join(BACKUP_DIR, filename);
  // Formato "custom" (-F c): comprimido e restaurável com pg_restore
  // (permite --clean/--if-exists na restauração, ao contrário do -F p).
  await runCli('pg_dump', ['-d', getConnectionString(), '-F', 'c', '-f', full]);
  return filename;
}

function listBackupFiles() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.dump'))
    .map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Só aceita um nome de arquivo puro (sem separadores/"..") que já exista
// dentro de BACKUP_DIR — impede path traversal via parâmetro de rota.
function resolveBackupPath(filename) {
  const base = path.basename(String(filename || ''));
  if (!base || base !== filename) return null;
  const full = path.join(BACKUP_DIR, base);
  if (!fs.existsSync(full)) return null;
  return full;
}

async function readGlobalSetting(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM user_data WHERE username = $1 AND data_key = $2', [GLOBAL_SETTINGS_USER, key]);
  return rows.length ? rows[0].value : fallback;
}

async function writeGlobalSetting(key, value) {
  await pool.query(
    `INSERT INTO user_data (username, data_key, value, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (username, data_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [GLOBAL_SETTINGS_USER, key, String(value)]
  );
}

app.get('/api/backups', requireAdmin, (req, res) => {
  try {
    res.json(listBackupFiles());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.post('/api/backups', requireAdmin, async (req, res) => {
  try {
    const filename = await performBackup('backup');
    res.status(201).json({ filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.stderr || err.message });
  }
});

app.get('/api/backups/:filename/download', requireAdmin, (req, res) => {
  const full = resolveBackupPath(req.params.filename);
  if (!full) return res.status(404).json({ error: 'not_found' });
  res.download(full, req.params.filename);
});

app.delete('/api/backups/:filename', requireAdmin, (req, res) => {
  const full = resolveBackupPath(req.params.filename);
  if (!full) return res.status(404).json({ error: 'not_found' });
  try {
    fs.unlinkSync(full);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Restaura um backup existente. Por segurança, tira uma foto do banco ATUAL
// antes de sobrescrever (prefixo "pre-restore-"), para permitir desfazer.
app.post('/api/backups/:filename/restore', requireAdmin, async (req, res) => {
  const full = resolveBackupPath(req.params.filename);
  if (!full) return res.status(404).json({ error: 'not_found' });
  try {
    await performBackup('pre-restore');
    await runCli('pg_restore', ['--clean', '--if-exists', '--no-owner', '-d', getConnectionString(), full]);
    res.json({ ok: true, message: 'Restore complete. Reload the page to see the restored data.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.stderr || err.message });
  }
});

app.get('/api/backup-schedule', requireAdmin, async (req, res) => {
  try {
    res.json({
      enabled: (await readGlobalSetting('backupScheduleEnabled', '0')) === '1',
      frequency: await readGlobalSetting('backupScheduleFrequency', 'daily'),
      weeklyDays: ((await readGlobalSetting('backupScheduleWeeklyDays', '')) || '').split(',').map(s => s.trim()).filter(Boolean).map(Number),
      monthlyDay: parseInt(await readGlobalSetting('backupScheduleMonthlyDay', '1'), 10) || 1,
      time: await readGlobalSetting('backupScheduleTime', '02:00'),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.put('/api/backup-schedule', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const frequency = ['daily', 'weekly', 'monthly'].includes(body.frequency) ? body.frequency : 'daily';
    const weeklyDays = Array.isArray(body.weeklyDays) ? body.weeklyDays.map(Number).filter(n => n >= 0 && n <= 6) : [];
    const monthlyDay = Math.min(31, Math.max(1, parseInt(body.monthlyDay, 10) || 1));
    const time = /^\d{2}:\d{2}$/.test(body.time) ? body.time : '02:00';
    await writeGlobalSetting('backupScheduleEnabled', body.enabled ? '1' : '0');
    await writeGlobalSetting('backupScheduleFrequency', frequency);
    await writeGlobalSetting('backupScheduleWeeklyDays', weeklyDays.join(','));
    await writeGlobalSetting('backupScheduleMonthlyDay', String(monthlyDay));
    await writeGlobalSetting('backupScheduleTime', time);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// Checagem a cada minuto — dispara o backup automático quando o horário
// configurado bate com o horário atual, respeitando a frequência.
// backupScheduleLastRunDate evita rodar mais de uma vez no mesmo dia.
function checkScheduledBackup() {
  (async () => {
    try {
      if ((await readGlobalSetting('backupScheduleEnabled', '0')) !== '1') return;
      const time = await readGlobalSetting('backupScheduleTime', '02:00');
      const now = new Date();
      if (`${pad2(now.getHours())}:${pad2(now.getMinutes())}` !== time) return;

      const todayKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      if ((await readGlobalSetting('backupScheduleLastRunDate', '')) === todayKey) return;

      const frequency = await readGlobalSetting('backupScheduleFrequency', 'daily');
      if (frequency === 'weekly') {
        const days = ((await readGlobalSetting('backupScheduleWeeklyDays', '')) || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
        if (!days.includes(now.getDay())) return;
      } else if (frequency === 'monthly') {
        const configuredDay = parseInt(await readGlobalSetting('backupScheduleMonthlyDay', '1'), 10) || 1;
        const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        if (now.getDate() !== Math.min(configuredDay, lastDayOfMonth)) return;
      }

      const filename = await performBackup('scheduled');
      await writeGlobalSetting('backupScheduleLastRunDate', todayKey);
      console.log(`[backup] Backup agendado criado: ${filename}`);
    } catch (err) {
      console.error('[backup] Erro ao checar agendamento de backup:', err);
    }
  })();
}
// ════════════════════════════════════════════════
// Certificado SSL/TLS (Settings → System → SSL Certificate) — pedido do
// usuário: "crie um menu que permita importar, substituir ou excluir um
// certificado ssl para ser utilizado na aplicação em HTTPS". Quem realmente
// TERMINA o TLS é o toolbox45-frontend (nginx, ver frontend/nginx.conf,
// bloco "listen 443 ssl") — este backend só possui/valida os arquivos, que
// moram num volume Docker COMPARTILHADO entre os dois containers (TLS_DIR,
// por padrão /app/tls aqui e /etc/nginx/tls no frontend — ver
// docker-compose.yml). Salvar aqui já basta pro nginx enxergar o arquivo
// novo: o container do frontend tem um vigia de arquivos (inotifywait, ver
// frontend/docker-entrypoint.sh) que detecta a mudança e roda
// "nginx -s reload" sozinho — nenhum container precisa de acesso ao Docker
// (/var/run/docker.sock) pra isso (o antigo serviço "updater" que tinha
// esse acesso foi removido na migração pra Postgres, por incompatibilidade
// de arquitetura — ver git log).
//
// O bloco 443 do nginx não SOBE se o arquivo de certificado não existir
// (diretiva ssl_certificate exige o arquivo já lá) — por isso
// ensureTlsBootstrap() abaixo gera um certificado autoassinado na primeira
// vez que o backend sobe, ANTES de aceitar conexões (ver app.listen no
// final deste arquivo), garantindo que o volume compartilhado nunca fica
// vazio. DELETE reverte para esse mesmo autoassinado (não desliga o HTTPS).
// ════════════════════════════════════════════════
const TLS_DIR = process.env.TLS_DIR || path.join(__dirname, 'tls');
const TLS_CERT_PATH = path.join(TLS_DIR, 'cert.pem');
const TLS_KEY_PATH = path.join(TLS_DIR, 'key.pem');
const TLS_BACKUP_DIR = path.join(TLS_DIR, 'backup');

async function generateSelfSignedCert() {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  await runCli('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', TLS_KEY_PATH, '-out', TLS_CERT_PATH,
    '-days', '825', '-subj', '/CN=toolbox45',
  ]);
}

async function ensureTlsBootstrap() {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  if (!fs.existsSync(TLS_CERT_PATH) || !fs.existsSync(TLS_KEY_PATH)) {
    console.log('[tls] No SSL certificate found — generating a default self-signed certificate...');
    await generateSelfSignedCert();
  }
}

// Guarda uma cópia com timestamp do certificado ATUAL antes de sobrescrever
// (mesmo espírito do backup automático antes de restaurar o banco, ver
// performBackup acima) — não aparece na UI nem é baixável; é só uma rede de
// segurança manual (recuperável via acesso ao volume/host, se precisar).
function backupCurrentTlsFiles() {
  if (!fs.existsSync(TLS_CERT_PATH) && !fs.existsSync(TLS_KEY_PATH)) return;
  const dir = path.join(TLS_BACKUP_DIR, backupTimestamp());
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(TLS_CERT_PATH)) fs.copyFileSync(TLS_CERT_PATH, path.join(dir, 'cert.pem'));
  if (fs.existsSync(TLS_KEY_PATH)) fs.copyFileSync(TLS_KEY_PATH, path.join(dir, 'key.pem'));
}

function readCertInfo() {
  const pem = fs.readFileSync(TLS_CERT_PATH, 'utf8');
  const x509 = new crypto.X509Certificate(pem);
  return {
    subject: x509.subject,
    issuer: x509.issuer,
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    fingerprint256: x509.fingerprint256,
    serialNumber: x509.serialNumber,
    isSelfSigned: x509.subject === x509.issuer,
    isExpired: new Date(x509.validTo) < new Date(),
  };
}

// Confere se a chave privada enviada realmente forma um par com o
// certificado enviado — compara as chaves PÚBLICAS (formato SPKI/DER) em
// vez de assinar/verificar um payload de teste; funciona igual pra RSA/EC
// sem precisar de lógica específica por algoritmo.
function certKeyMatch(certPem, keyPem) {
  const certPub = new crypto.X509Certificate(certPem).publicKey;
  const derivedPub = crypto.createPublicKey(crypto.createPrivateKey(keyPem));
  return certPub.export({ type: 'spki', format: 'der' }).equals(derivedPub.export({ type: 'spki', format: 'der' }));
}

app.get('/api/system/ssl-certificate', requireAdmin, (req, res) => {
  try {
    res.json(readCertInfo());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.post('/api/system/ssl-certificate', requireAdmin, async (req, res) => {
  const { cert, key, chain } = req.body || {};
  if (!cert || !key || typeof cert !== 'string' || typeof key !== 'string') {
    return res.status(400).json({ error: 'validation_error', message: '"cert" and "key" (PEM text) are required' });
  }
  let x509;
  try {
    x509 = new crypto.X509Certificate(cert);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_cert', message: 'Could not parse the certificate — make sure it is a valid PEM-encoded X.509 certificate.' });
  }
  try {
    crypto.createPrivateKey(key);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_key', message: 'Could not parse the private key — make sure it is a valid, UNENCRYPTED PEM-encoded private key (no passphrase).' });
  }
  let matches = false;
  try { matches = certKeyMatch(cert, key); } catch (e) { matches = false; }
  if (!matches) {
    return res.status(400).json({ error: 'mismatch', message: 'This certificate and private key do not match each other.' });
  }
  if (new Date(x509.validTo) < new Date()) {
    return res.status(400).json({ error: 'expired', message: `This certificate already expired on ${x509.validTo}.` });
  }
  try {
    backupCurrentTlsFiles();
    fs.mkdirSync(TLS_DIR, { recursive: true });
    const fullChain = chain && typeof chain === 'string' && chain.trim()
      ? `${cert.trim()}\n${chain.trim()}\n`
      : `${cert.trim()}\n`;
    fs.writeFileSync(TLS_CERT_PATH, fullChain, { mode: 0o644 });
    fs.writeFileSync(TLS_KEY_PATH, key.trim() + '\n', { mode: 0o600 });
    await logAudit(getCurrentUsername(req), 'import', 'ssl_certificate', null, x509.subject, `Imported SSL certificate, valid until ${x509.validTo}`);
    res.json(readCertInfo());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.delete('/api/system/ssl-certificate', requireAdmin, async (req, res) => {
  try {
    backupCurrentTlsFiles();
    await generateSelfSignedCert();
    await logAudit(getCurrentUsername(req), 'delete', 'ssl_certificate', null, null, 'Removed custom SSL certificate — reverted to a self-signed default');
    res.json(readCertInfo());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ════════════════════════════════════════════════
// Startup — aguarda o Postgres (toolbox45-db) responder e o schema ser
// aplicado antes de começar a aceitar requisições HTTP. O agendamento de
// backup (setInterval) só é registrado DEPOIS disso — chamá-lo antes faria
// checkScheduledBackup() consultar `user_data` numa corrida contra o CREATE
// TABLE do initDb() (mesmo processo, mesma tabela), gerando um erro
// "relation does not exist" inofensivo mas ruidoso no primeiro boot.
// ensureTlsBootstrap() (ver seção "Certificado SSL/TLS" acima) também
// precisa rodar ANTES do app.listen — só depois disso GET /api/health
// responde 200, e só depois disso o toolbox45-frontend (que depende deste
// healthcheck, ver docker-compose.yml) sobe seu bloco 443 sabendo que o
// volume compartilhado de certificados já tem um arquivo válido.
// ════════════════════════════════════════════════
(async () => {
  try {
    await initDb();
    await ensureTlsBootstrap();
    setInterval(checkScheduledBackup, 60 * 1000);
    checkScheduledBackup();
    app.listen(PORT, () => {
      console.log(`Toolbox45 backend listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start: could not connect to the database.', err);
    process.exit(1);
  }
})();
