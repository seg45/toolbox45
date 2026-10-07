"""GET/PUT /api/me -- porta 1:1 de server/index.js linhas 1332-1414. Perfil
do usuario autenticado (sessao local/Google/Microsoft, ou API key): dados
basicos e troca de senha (self-service).
"""
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel

from ..db import get_pool
from ..deps import CurrentUser, require_user, role_rank
from ..audit import log_audit
from ..auth_events import log_auth_event
from ..login_guard import client_ip, password_change_limiter
from ..password_policy import password_problem
from ..security import hash_password_async, verify_password_async
from ..session import SESSION_COOKIE_NAME, delete_user_sessions
from .. import setup as setup_mod

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("")
async def get_me(user: CurrentUser = Depends(require_user)):
    username = user["username"]
    role = user["role"]
    return {
        "username": username,
        "upn": username,  # mantido por compatibilidade com js/user-sync.js
        "role": role,
        "isAdmin": role_rank(role) >= 1,
        "isSuperAdmin": role_rank(role) >= 2,
        "authMethod": user["auth_method"],
    }


@router.put("/password", status_code=204)
async def update_password(request: Request, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    if user["api_key"]:
        raise HTTPException(
            status_code=400, detail={"error": "validation_error", "message": "Not applicable to API key requests"}
        )
    username = user["username"]
    current_password = body.get("current_password")
    new_password = body.get("new_password")

    pool = get_pool()
    row = await pool.fetchrow("SELECT * FROM users WHERE username = $1", username)
    if not row:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"User '{username}' not found"})
    if not row["is_local"]:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "validation_error",
                "message": "This account signs in with Google — there is no local password to change.",
            },
        )
    ip = client_ip(request)
    wait = password_change_limiter.retry_after(ip, username)
    if wait:
        await log_auth_event("password_change_blocked", request=request, ip=ip, username=username, detail=f"retry_after={wait}s")
        raise HTTPException(
            status_code=429,
            detail={
                "error": "too_many_attempts",
                "message": f"Too many failed attempts. Try again in {max(1, -(-wait // 60))} minute(s).",
            },
            headers={"Retry-After": str(wait)},
        )
    if not current_password or not await verify_password_async(current_password, row["password_hash"]):
        password_change_limiter.record_failure(ip, username)
        await log_auth_event("password_change_failed", request=request, ip=ip, username=username, detail="wrong_current_password")
        raise HTTPException(status_code=401, detail={"error": "unauthorized", "message": "Current password is incorrect"})
    password_change_limiter.record_success(ip, username)
    problem = password_problem(new_password, username)
    if problem:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": problem.replace('"password"', '"new_password"')},
        )

    await pool.execute(
        "UPDATE users SET password_hash = $1 WHERE username = $2", await hash_password_async(new_password), username
    )
    # Trocou a senha: todas as OUTRAS sessoes dessa conta caem (um cookie roubado
    # ou esquecido em outro aparelho deixa de valer); a atual continua.
    revoked = await delete_user_sessions(username, except_token=request.cookies.get(SESSION_COOKIE_NAME))
    await log_auth_event("password_changed", request=request, ip=ip, username=username, detail=f"other_sessions_revoked={revoked}")
    if username == setup_mod.DEFAULT_ADMIN_USERNAME:
        await setup_mod.refresh_default_admin_state()

    # Nunca grava a senha (nem o hash) no audit_log.
    await log_audit(username, "update", "user", username, username, "Changed: password (self-service)")
