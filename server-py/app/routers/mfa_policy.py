"""Politica de MFA (Settings → System → Security, super admin).

  GET /api/system/mfa   -> {requireAll, smtpAvailable, requiredUsers, enabledUsers}
  PUT /api/system/mfa   -> {requireAll: bool}

"Exigir MFA para um usuario especifico" e feito por usuario, em
PUT /api/users/:username {mfaRequired: bool} (e {resetMfa: true} para desligar o MFA de
quem perdeu o acesso ao e-mail). A politica vale para contas LOCAIS (senha); contas SSO
usam o MFA do proprio provedor.
"""
from fastapi import APIRouter, Body, Depends, HTTPException

from .. import mailer, mfa
from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, require_super_admin

router = APIRouter(prefix="/api/system/mfa", tags=["mfa"])


async def _state() -> dict:
    pool = get_pool()
    return {
        "requireAll": await mfa.require_all(),
        "smtpAvailable": await mailer.is_configured(),
        "requiredUsers": int(await pool.fetchval("SELECT COUNT(*) FROM users WHERE is_local = 1 AND mfa_required = 1") or 0),
        "enabledUsers": int(await pool.fetchval("SELECT COUNT(*) FROM users WHERE is_local = 1 AND mfa_enabled = 1") or 0),
    }


@router.get("")
async def get_policy(user: CurrentUser = Depends(require_super_admin)) -> dict:
    return await _state()


@router.put("")
async def put_policy(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_super_admin)) -> dict:
    value = body.get("requireAll")
    if not isinstance(value, bool):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"requireAll" must be true or false'})
    if value and not await mailer.is_configured():
        raise HTTPException(
            status_code=409,
            detail={"error": "smtp_not_configured", "message": "Configure the SMTP server (Settings → System → E-mail) before requiring MFA."},
        )
    await mfa.set_require_all(value, user["username"])
    await log_audit(user["username"], "update", "security_settings", "mfa", "MFA",
                    f"MFA required for all local users: {'on' if value else 'off'}")
    return await _state()
