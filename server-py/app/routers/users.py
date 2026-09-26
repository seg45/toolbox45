"""GET/POST/PUT/DELETE /api/users* -- porta 1:1 de server/index.js (~linhas
3190-3341). Administracao de usuarios (Settings -> Users) -- TODAS as 4
rotas exigem super_admin (nem um 'admin' comum alcanca: "o perfil de Admin
so nao pode gerenciar usuarios", comentario original do Node). A conta
local 'admin' e a conta raiz do sistema e e protegida a parte: role/disabled
dela nunca mudam (nem por outro super_admin) e ela nunca pode ser excluida
-- garante que a instalacao nunca fica sem ninguem habilitado que acesse
Users. Nunca devolve password_hash.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, require_super_admin, role_rank
from ..handles import generate_unique_handle
from ..security import hash_password
from .auth import EMAIL_RE

logger = logging.getLogger("toolbox45")

router = APIRouter(prefix="/api/users", tags=["users"])

USERS_PUBLIC_COLUMNS = "username, role, is_local, disabled, created_at, created_by, auth_provider, handle, approved_at"
PROTECTED_ADMIN_USERNAME = "admin"
USER_ROLES = ["user", "admin", "super_admin"]


async def _count_enabled_admins(exclude_username: Optional[str] = None) -> int:
    pool = get_pool()
    if exclude_username:
        row = await pool.fetchrow(
            "SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','super_admin') AND disabled = 0 AND username != $1",
            exclude_username,
        )
    else:
        row = await pool.fetchrow("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','super_admin') AND disabled = 0")
    return row["n"]


async def _ensure_default_folder(username: str) -> None:
    # Best-effort, igual ao Node -- nunca bloqueia a criacao do usuario por causa disso.
    pool = get_pool()
    try:
        await pool.execute(
            "INSERT INTO folders (username, name) VALUES ($1, 'Favorites') ON CONFLICT (username, name) DO NOTHING",
            username,
        )
    except Exception as err:  # noqa: BLE001
        logger.error("[folders] Falha ao garantir pasta Favorites padrao para %s: %s", username, err)


@router.get("")
async def list_users(user: CurrentUser = Depends(require_super_admin)):
    pool = get_pool()
    rows = await pool.fetch(f"SELECT {USERS_PUBLIC_COLUMNS} FROM users ORDER BY is_local DESC, username")
    return [dict(r) for r in rows]


@router.post("", status_code=201)
async def create_user(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_super_admin)):
    username_raw = body.get("username")
    password = body.get("password")
    role = body.get("role")
    if not username_raw or not isinstance(username_raw, str) or not EMAIL_RE.match(username_raw.strip()):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "A valid e-mail address is required"})
    if not password or not isinstance(password, str) or len(password) < 4:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"password" must be at least 4 characters'})
    role_val = role if role in USER_ROLES else "user"

    pool = get_pool()
    trimmed = username_raw.strip().lower()
    existing = await pool.fetchrow("SELECT username FROM users WHERE username = $1", trimmed)
    if existing:
        raise HTTPException(status_code=409, detail={"error": "conflict", "message": f"User '{trimmed}' already exists"})

    async with pool.acquire() as conn:
        handle = await generate_unique_handle(conn, trimmed)
    await pool.execute(
        """INSERT INTO users (username, password_hash, role, is_local, created_by, auth_provider, handle, approved_at)
           VALUES ($1, $2, $3, 1, $4, 'local', $5, NOW())""",
        trimmed, hash_password(password), role_val, user["username"], handle,
    )
    await _ensure_default_folder(trimmed)
    row = await pool.fetchrow(f"SELECT {USERS_PUBLIC_COLUMNS} FROM users WHERE username = $1", trimmed)
    # Nunca grava a senha (nem o hash) no audit_log -- so o role atribuido.
    await log_audit(user["username"], "create", "user", trimmed, trimmed, f"Role: {role_val}")
    return dict(row)


@router.put("/{username}")
async def update_user(username: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_super_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM users WHERE username = $1", username)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"User '{username}' not found"})

    is_protected_admin = username == PROTECTED_ADMIN_USERNAME
    if is_protected_admin and (body.get("role") is not None or body.get("disabled") is not None):
        raise HTTPException(
            status_code=409,
            detail={"error": "conflict", "message": f"The '{PROTECTED_ADMIN_USERNAME}' account's role and status are fixed and can't be changed."},
        )

    body_role = body.get("role")
    new_role = body_role if (body_role is not None and body_role in USER_ROLES) else existing["role"]
    body_disabled = body.get("disabled")
    new_disabled = bool(body_disabled) if body_disabled is not None else bool(existing["disabled"])

    # Guarda contra lockout total: se esta mudanca tiraria o role admin/
    # super_admin ou desabilitaria a ultima conta admin-rank habilitada, recusa.
    was_enabled_admin = role_rank(existing["role"]) >= 1 and not existing["disabled"]
    will_still_be_enabled_admin = role_rank(new_role) >= 1 and not new_disabled
    if was_enabled_admin and not will_still_be_enabled_admin:
        remaining = await _count_enabled_admins(username)
        if remaining < 1:
            raise HTTPException(status_code=409, detail={"error": "conflict", "message": "At least one enabled admin must remain"})

    password_hash = existing["password_hash"]
    password = body.get("password")
    if password:
        if not existing["is_local"]:
            raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "Only local users have a password"})
        if not isinstance(password, str) or len(password) < 4:
            raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"password" must be at least 4 characters'})
        password_hash = hash_password(password)

    # Aprovando uma conta pendente (disabled: true -> false, primeira vez --
    # ver CREATE TABLE users em schema.sql): grava approved_at agora. Nao mexe
    # se ja estava aprovada (reabilitar depois de um disable normal nao e uma
    # "nova aprovacao").
    was_disabled = bool(existing["disabled"])
    approving_now = was_disabled and not new_disabled and not existing["approved_at"]
    new_approved_at = datetime.now(timezone.utc) if approving_now else existing["approved_at"]

    await pool.execute(
        "UPDATE users SET role = $1, disabled = $2, password_hash = $3, approved_at = $4 WHERE username = $5",
        new_role, 1 if new_disabled else 0, password_hash, new_approved_at, username,
    )
    row = await pool.fetchrow(f"SELECT {USERS_PUBLIC_COLUMNS} FROM users WHERE username = $1", username)

    # Nunca grava senha/hash no audit_log -- so sinaliza QUE ela mudou (sem o
    # valor), junto de role/disabled reais.
    changed = []
    if existing["role"] != new_role:
        changed.append("role")
    if bool(existing["disabled"]) != bool(new_disabled):
        changed.append("disabled")
    if password:
        changed.append("password")
    await log_audit(user["username"], "update", "user", username, username, f"Changed: {', '.join(changed)}" if changed else None)
    return dict(row)


@router.delete("/{username}", status_code=204)
async def delete_user(username: str, user: CurrentUser = Depends(require_super_admin)):
    if username == PROTECTED_ADMIN_USERNAME:
        raise HTTPException(status_code=409, detail={"error": "conflict", "message": f"The '{PROTECTED_ADMIN_USERNAME}' account can't be deleted."})
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM users WHERE username = $1", username)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"User '{username}' not found"})
    if role_rank(existing["role"]) >= 1 and not existing["disabled"]:
        remaining = await _count_enabled_admins(username)
        if remaining < 1:
            raise HTTPException(status_code=409, detail={"error": "conflict", "message": "At least one enabled admin must remain"})
    await pool.execute("DELETE FROM users WHERE username = $1", username)  # cascata via ON DELETE CASCADE (sessions, shares, group_members, links, ...)
    await log_audit(user["username"], "delete", "user", username, username)
