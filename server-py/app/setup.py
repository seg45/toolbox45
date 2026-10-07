"""Configuracao inicial (primeiro acesso) -- a conta padrao admin/admin NAO existe
mais. A primeira visita ao login pede um e-mail e uma senha, e isso cria o
primeiro super_admin (POST /api/auth/setup).

Dois casos em que a configuracao inicial e exigida (GET /api/auth/setup-status):

  * "fresh":   nao existe nenhum super_admin (instalacao nova);
  * "migrate": instalacao ANTIGA que ainda tem a conta `admin` com a senha
               padrao `admin`. A primeira visita converte essa conta para o
               e-mail/senha informados (o usuario `admin` deixa de existir e tudo
               que era dele -- comandos, pastas, preferencias, chaves de API,
               auditoria... -- passa para a conta nova). Enquanto isso nao
               acontece, o login com admin/admin e RECUSADO (403 setup_required).
               Se a senha do `admin` ja foi trocada, nada muda.

Primeiro a chegar vence: quem abrir a tela antes do dono vira o super_admin. Por
isso o POST /setup so funciona enquanto a instalacao esta nesse estado (depois
responde 409) e e limitado por taxa no nginx.
"""
import logging
from typing import Optional

from .db import get_pool
from .security import verify_password_async

logger = logging.getLogger("toolbox45")

DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "admin"
SETUP_LOCK_KEY = 45001  # pg_advisory_xact_lock: serializa duas configuracoes simultaneas

# TODA coluna do schema que guarda um username/e-mail de usuario (nome da tabela,
# coluna). Usada para migrar o `admin` legado para o e-mail novo. tests/
# test_setup.py confere esta lista contra o information_schema -- ao criar uma
# coluna nova que referencie um usuario, inclua-a aqui.
USERNAME_REFERENCES = [
    ("commands", "created_by"), ("commands", "modified_by"),
    ("user_favorites", "username"), ("folders", "username"), ("notes", "username"),
    ("user_data", "username"), ("audit_log", "username"), ("auth_events", "username"),
    ("oauth_settings", "updated_by"), ("system_logo", "updated_by"), ("system_logo", "updated_by_dark"),
    ("api_keys", "created_by"), ("users", "created_by"),
    ("shares", "grantor_username"), ("shares", "grantee_username"),
    ("groups", "created_by"), ("group_members", "username"), ("links", "username"),
    ("sessions", "username"),
]

# Cache: a conta `admin` ainda tem a senha padrao? Calcular exige um scrypt, e o
# status e publico -- por isso so e recalculado no boot e quando a senha do
# `admin` muda (refresh_default_admin_state), nunca a cada requisicao.
_default_admin_pending = False


def default_admin_pending() -> bool:
    return _default_admin_pending


async def refresh_default_admin_state() -> None:
    global _default_admin_pending
    row = await get_pool().fetchrow(
        "SELECT password_hash FROM users WHERE username = $1 AND is_local = 1 AND disabled = 0",
        DEFAULT_ADMIN_USERNAME,
    )
    _default_admin_pending = bool(row) and await verify_password_async(DEFAULT_ADMIN_PASSWORD, row["password_hash"])
    if _default_admin_pending:
        logger.warning(
            "[setup] A conta 'admin' ainda usa a senha padrao: abra a tela de login para "
            "informar o e-mail e a senha do administrador (o login admin/admin esta bloqueado)."
        )


async def get_mode(conn=None) -> Optional[str]:
    """'migrate', 'fresh' ou None (configuracao ja feita)."""
    if _default_admin_pending:
        return "migrate"
    runner = conn or get_pool()
    n = await runner.fetchval("SELECT COUNT(*) FROM users WHERE role = 'super_admin'")
    return "fresh" if int(n) == 0 else None


async def complete_setup(email: str, password_hash: str) -> Optional[str]:
    """Cria (fresh) ou converte (migrate) o primeiro super_admin. Devolve o modo
    executado, ou None se a configuracao ja nao era necessaria. Levanta
    ValueError("email_in_use") se o e-mail ja pertence a outra conta."""
    pool = get_pool()
    try:
        mode = await _run_setup(pool, email, password_hash)
    except _NotNeeded:
        await refresh_default_admin_state()  # o cache pode estar defasado
        return None
    await refresh_default_admin_state()
    return mode


class _NotNeeded(Exception):
    pass


async def _run_setup(pool, email: str, password_hash: str) -> str:
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock($1)", SETUP_LOCK_KEY)
            mode = await get_mode(conn)
            if mode == "migrate":
                # Reconfere dentro do lock: a senha padrao ainda vale? (alguem pode ter
                # trocado entre o ultimo refresh e agora.)
                row = await conn.fetchrow(
                    "SELECT password_hash FROM users WHERE username = $1 AND is_local = 1 AND disabled = 0",
                    DEFAULT_ADMIN_USERNAME,
                )
                if not row or not await verify_password_async(DEFAULT_ADMIN_PASSWORD, row["password_hash"]):
                    mode = await get_mode_ignoring_cache(conn)
            if mode is None:
                raise _NotNeeded()
            if await conn.fetchval("SELECT 1 FROM users WHERE username = $1", email):
                raise ValueError("email_in_use")

            await conn.execute(
                """INSERT INTO users (username, password_hash, role, is_local, created_by, auth_provider, approved_at)
                   VALUES ($1, $2, 'super_admin', 1, 'setup', 'local', NOW())""",
                email, password_hash,
            )
            if mode == "migrate":
                await conn.execute("DELETE FROM sessions WHERE username = $1", DEFAULT_ADMIN_USERNAME)
                for table, column in USERNAME_REFERENCES:
                    if (table, column) == ("sessions", "username"):
                        continue
                    # nomes de tabela/coluna vem da constante acima, nunca de entrada externa
                    await conn.execute(
                        f"UPDATE {table} SET {column} = $1 WHERE {column} = $2", email, DEFAULT_ADMIN_USERNAME
                    )
                await conn.execute("DELETE FROM users WHERE username = $1", DEFAULT_ADMIN_USERNAME)
            await conn.execute(
                "INSERT INTO folders (username, name) VALUES ($1, 'Favorites') ON CONFLICT (username, name) DO NOTHING",
                email,
            )
            await conn.execute(
                "INSERT INTO audit_log (username, action, entity_type, entity_id, entity_name, details) VALUES ($1,$2,$3,$4,$5,$6)",
                email, "create", "user", email, email,
                "Initial setup: default 'admin' account replaced" if mode == "migrate" else "Initial setup: first super admin created",
            )
            return mode


async def get_mode_ignoring_cache(conn) -> Optional[str]:
    n = await conn.fetchval("SELECT COUNT(*) FROM users WHERE role = 'super_admin'")
    return "fresh" if int(n) == 0 else None
