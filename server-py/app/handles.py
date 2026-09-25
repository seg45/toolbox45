"""Geracao de handle (apelido unico e publico) -- porta exata de
slugifyHandle()/generateUniqueHandle() em server/db.js. Usado no auto-
cadastro (POST /api/auth/register) pra dar um handle unico a cada conta
nova, sem nunca expor o username real (email) pra outros usuarios.
"""
import re
import secrets

import asyncpg

_SLUG_INVALID_RE = re.compile(r"[^a-z0-9._-]+")
_SLUG_TRIM_RE = re.compile(r"^[._\-]+|[._\-]+$")
_SLUG_COLLAPSE_RE = re.compile(r"[._-]{2,}")


def slugify_handle(raw: str) -> str:
    s = (raw or "").strip().lower()
    at = s.find("@")
    if at > 0:
        s = s[:at]  # e-mail -> so a parte local
    s = _SLUG_INVALID_RE.sub("-", s)
    s = _SLUG_TRIM_RE.sub("", s)
    s = _SLUG_COLLAPSE_RE.sub("-", s)
    if len(s) < 2:
        s = ("user-" + s).rstrip("-") or "user"
    return s[:28]


# ════════════════════════════════════════════════
# Normalizacao/validacao de um handle ESCOLHIDO pelo usuario (PUT
# /api/me/handle) -- diferente de slugify_handle() acima, que so gera um
# candidato AUTOMATICO na criacao da conta. Porta exata de HANDLE_RE/
# normalizeHandle() em server/index.js (linhas 998-1001).
# ════════════════════════════════════════════════
HANDLE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$")


def normalize_handle(raw) -> str:
    return str(raw or "").strip().lower()


async def generate_unique_handle(conn: asyncpg.Connection, raw_base: str) -> str:
    base = slugify_handle(raw_base)
    for i in range(1000):
        candidate = base if i == 0 else f"{base}-{i + 1}"
        exists = await conn.fetchval("SELECT 1 FROM users WHERE handle = $1", candidate)
        if not exists:
            return candidate
    # Praticamente inatingivel (1000 colisoes seguidas) -- sufixo aleatorio
    # como ultimo recurso, so pra nunca travar a criacao de uma conta.
    return f"{base}-{secrets.token_hex(3)}"
