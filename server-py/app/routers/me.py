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
from .. import mailer, mfa, setup as setup_mod
from ..login_guard import mfa_limiter

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("")
async def get_me(user: CurrentUser = Depends(require_user)):
    username = user["username"]
    role = user["role"]
    out = {
        "username": username,
        "upn": username,  # mantido por compatibilidade com js/user-sync.js
        "role": role,
        "isAdmin": role_rank(role) >= 1,
        "isSuperAdmin": role_rank(role) >= 2,
        "authMethod": user["auth_method"],
    }
    if not user["api_key"]:
        row = await get_pool().fetchrow("SELECT is_local, auth_provider, mfa_enabled, mfa_required FROM users WHERE username = $1", username)
        if row:
            smtp_ok = await mailer.is_configured()
            out["isLocal"] = bool(row["is_local"])
            out["authProvider"] = row["auth_provider"]
            out["mfa"] = {
                "enabled": bool(row["mfa_enabled"]),
                "required": await mfa.is_required_for(row),   # exigido por um super admin (conta ou todos)
                "available": smtp_ok,                          # sem SMTP nao ha como mandar o codigo
            }
    return out


def _bad(message: str, status: int = 400, code: str = "validation_error") -> HTTPException:
    return HTTPException(status_code=status, detail={"error": code, "message": message})


async def _local_row(user: CurrentUser):
    if user["api_key"]:
        raise _bad("Not applicable to API key requests")
    row = await get_pool().fetchrow("SELECT * FROM users WHERE username = $1", user["username"])
    if not row:
        raise _bad("User not found", 404, "not_found")
    return row


# ── MFA por e-mail (conta local) ──────────────────────────────────────────
@router.post("/mfa/start")
async def mfa_start(request: Request, user: CurrentUser = Depends(require_user)) -> dict:
    """Passo 1 de ligar o MFA: manda um codigo para o e-mail da conta (prova que ele recebe)."""
    row = await _local_row(user)
    if not row["is_local"]:
        raise _bad("MFA by e-mail is only for accounts that sign in with a password. SSO accounts use the provider's MFA.")
    if row["mfa_enabled"]:
        raise _bad("MFA is already enabled.", 409, "conflict")
    if not await mailer.is_configured():
        raise _bad("E-mail (SMTP) is not configured. Ask an administrator.", 409, "smtp_not_configured")
    ip = client_ip(request)
    wait = mfa_limiter.retry_after(ip, "start:" + row["username"])
    if wait:
        raise _bad("Too many requests. Try again later.", 429, "too_many_attempts")
    mfa_limiter.record_failure(ip, "start:" + row["username"])
    try:
        challenge = await mfa.start_challenge(row["username"], "enable")
    except mailer.MailError:
        raise _bad("Could not send the verification code by e-mail.", 502, "mfa_send_failed")
    return {"ok": True, "challenge": challenge, "maskedEmail": mfa.mask_email(row["username"])}


@router.post("/mfa/confirm")
async def mfa_confirm(request: Request, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)) -> dict:
    row = await _local_row(user)
    if not row["is_local"]:
        raise _bad("MFA by e-mail is only for accounts that sign in with a password.")
    challenge = body.get("challenge") if isinstance(body.get("challenge"), str) else ""
    key = mfa._h(challenge)[:24]
    ip = client_ip(request)
    if mfa_limiter.retry_after(ip, key):
        raise _bad("Too many attempts. Try again later.", 429, "too_many_attempts")
    try:
        who = await mfa.check(challenge, str(body.get("code") or ""), "enable")
    except mfa.MfaError as err:
        mfa_limiter.record_failure(ip, key)
        raise _bad(err.message, err.status, err.code)
    if who != row["username"]:
        raise _bad("This verification expired. Start again.", 400, "invalid_challenge")
    await get_pool().execute("UPDATE users SET mfa_enabled = 1 WHERE username = $1", who)
    await log_auth_event("mfa_enabled", request=request, ip=ip, username=who, require_email=True, detail="self_service")
    await log_audit(who, "update", "user", who, who, "Changed: MFA enabled (self-service)")
    return {"ok": True}


@router.post("/mfa/disable")
async def mfa_disable(request: Request, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)) -> dict:
    row = await _local_row(user)
    if not row["is_local"]:
        raise _bad("MFA by e-mail is only for accounts that sign in with a password.")
    if not row["mfa_enabled"]:
        return {"ok": True}
    if await mfa.is_required_for(row):
        raise _bad("MFA is required for this account by an administrator and can't be turned off.", 409, "mfa_required")
    ip = client_ip(request)
    wait = password_change_limiter.retry_after(ip, row["username"])
    if wait:
        raise _bad("Too many failed attempts. Try again later.", 429, "too_many_attempts")
    password = body.get("password")
    if not password or not await verify_password_async(password, row["password_hash"]):
        password_change_limiter.record_failure(ip, row["username"])
        raise _bad("Password is incorrect", 401, "unauthorized")
    password_change_limiter.record_success(ip, row["username"])
    await get_pool().execute("UPDATE users SET mfa_enabled = 0 WHERE username = $1", row["username"])
    await mfa.clear_user(row["username"])
    await log_auth_event("mfa_disabled", request=request, ip=ip, username=row["username"], require_email=True, detail="self_service")
    await log_audit(row["username"], "update", "user", row["username"], row["username"], "Changed: MFA disabled (self-service)")
    return {"ok": True}


# ── SSO -> login local ────────────────────────────────────────────────────
@router.post("/convert-to-local")
async def convert_to_local(request: Request, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)) -> dict:
    """Quem entra por Google/Microsoft passa a entrar com e-mail + senha. A conta, os
    dados e o papel continuam os mesmos; o login SSO deixa de valer (so volta se
    converter de novo)."""
    row = await _local_row(user)
    if row["is_local"]:
        raise _bad("This account already signs in with a password.", 409, "conflict")
    if row["auth_provider"] not in ("google", "microsoft"):
        raise _bad("Only Google/Microsoft (SSO) accounts can be converted.", 400)
    username = row["username"]
    password = body.get("password")
    problem = password_problem(password, username)
    if problem:
        raise _bad(problem.replace('"password"', '"password"'))
    new_hash = await hash_password_async(password)
    previous = row["auth_provider"]
    await get_pool().execute(
        "UPDATE users SET password_hash = $1, is_local = 1, auth_provider = 'local' WHERE username = $2", new_hash, username
    )
    revoked = await delete_user_sessions(username, except_token=request.cookies.get(SESSION_COOKIE_NAME))
    await log_auth_event("converted_to_local", request=request, username=username, require_email=True, detail=f"from={previous}; other_sessions_revoked={revoked}")
    await log_audit(username, "update", "user", username, username, f"Changed: sign-in method {previous} → local (self-service)")
    return {"ok": True}


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
