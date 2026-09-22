// auth.js — helpers de senha/sessão para contas LOCAIS (username/senha),
// usados por server/index.js (login/logout, CRUD de usuários) e server/db.js
// (seed do usuário local padrão 'admin'). Sem dependências externas: usa só
// o módulo `crypto` embutido do Node (scrypt), evitando qualquer binário
// nativo (bcrypt e afins) na imagem Docker do backend.
const crypto = require('crypto');

// Formato de armazenamento: "salt:hash", ambos hex. scryptSync com 64 bytes
// de saída é um bom equilíbrio custo/segurança para um app interno como este
// (não é um serviço público de alto tráfego).
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Comparação em tempo constante (crypto.timingSafeEqual) — evita vazar
// informação por diferença de tempo de resposta entre senhas erradas.
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  try {
    const hashBuf = Buffer.from(hashHex, 'hex');
    const testBuf = crypto.scryptSync(String(password), salt, 64);
    if (hashBuf.length !== testBuf.length) return false;
    return crypto.timingSafeEqual(hashBuf, testBuf);
  } catch (e) {
    return false;
  }
}

// Token de sessão local (cookie `tb45_session`) — 32 bytes aleatórios, guardado
// em texto puro na tabela `sessions` (não é uma senha, só uma capability
// opaca; o mesmo modelo usado para as API keys, salvo que ali é hasheado
// porque a key é de uso externo/prolongado — uma sessão expira sozinha).
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashPassword, verifyPassword, generateSessionToken };
