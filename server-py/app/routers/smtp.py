"""Configuracao do servidor SMTP (Settings → System → E-mail (SMTP)).

Somente super_admin (mesmo nivel do OAuth: guarda uma credencial). A senha e
cifrada em repouso e NUNCA e devolvida -- o GET so diz se existe (`hasPassword`);
deixar o campo em branco num PUT mantem a senha ja salva.

  GET    /api/system/smtp        -> configuracao atual (sem a senha)
  PUT    /api/system/smtp        -> grava
  DELETE /api/system/smtp        -> remove (desliga o "Esqueci a senha")
  POST   /api/system/smtp/test   -> manda um e-mail de teste com a config salva
"""
import re
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from .. import mailer, secrets_box
from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, require_super_admin
from .auth import EMAIL_RE

router = APIRouter(prefix="/api/system/smtp", tags=["smtp"])

_APP_URL_RE = re.compile(r"^https?://[A-Za-z0-9]([A-Za-z0-9.\-]*[A-Za-z0-9])?(:\d{1,5})?(/[A-Za-z0-9._~\-/]*)?$")


def _bad(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail={"error": "validation_error", "message": message})


def _public(row) -> dict:
    if not row:
        return {"configured": False, "host": "", "port": 587, "security": "starttls", "username": "",
                "hasPassword": False, "fromAddress": "", "fromName": "", "appUrl": "",
                "updatedAt": None, "updatedBy": None, "secretKeyConfigured": secrets_box.key_configured()}
    return {
        "configured": True,
        "host": row["host"], "port": row["port"], "security": row["security"],
        "username": row["auth_user"] or "", "hasPassword": bool(row["password"]),
        "fromAddress": row["from_address"], "fromName": row["from_name"] or "", "appUrl": row["app_url"],
        "updatedAt": row["updated_at"].isoformat() if row["updated_at"] else None,
        "updatedBy": row["updated_by"],
        "secretKeyConfigured": secrets_box.key_configured(),
    }


@router.get("")
async def get_smtp(user: CurrentUser = Depends(require_super_admin)) -> dict:
    return _public(await get_pool().fetchrow("SELECT * FROM smtp_settings WHERE id = 1"))


@router.put("")
async def put_smtp(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_super_admin)) -> dict:
    def text(key: str, limit: int) -> str:
        v = body.get(key)
        return v.strip()[:limit + 1] if isinstance(v, str) else ""

    host = text("host", 253)
    if not host or not mailer.valid_host(host):
        raise _bad("A valid SMTP host name is required (e.g. smtp.example.com).")
    port_raw = body.get("port")
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        raise _bad("Port must be a number between 1 and 65535.")
    if isinstance(port_raw, bool) or not 1 <= port <= 65535:
        raise _bad("Port must be a number between 1 and 65535.")
    security = text("security", 10) or "starttls"
    if security not in mailer.SECURITY_MODES:
        raise _bad("Security must be one of: starttls, ssl, none.")
    username = text("username", 254)
    if len(username) > 254 or any(ord(c) < 32 for c in username):
        raise _bad("Username is invalid.")
    password = body.get("password")
    password = password if isinstance(password, str) else ""
    if len(password) > 512 or "\x00" in password:
        raise _bad("Password is invalid.")
    from_address = text("fromAddress", 254)
    if not from_address or len(from_address) > 254 or not EMAIL_RE.match(from_address):
        raise _bad("A valid From address is required.")
    from_name = text("fromName", 100)
    if len(from_name) > 100 or any(ord(c) < 32 for c in from_name):
        raise _bad("From name is invalid.")
    app_url = text("appUrl", 300).rstrip("/")
    if not app_url or len(app_url) > 300 or not _APP_URL_RE.match(app_url):
        raise _bad("Public URL must look like https://toolbox.example.com (used in the link inside the e-mail).")

    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM smtp_settings WHERE id = 1")
    stored_password: Optional[str] = None
    if username:
        if password:
            stored_password = secrets_box.encrypt(password, mailer.password_context())
        elif existing and existing["password"] and existing["auth_user"] == username:
            stored_password = existing["password"]       # em branco = mantem
        elif existing and existing["password"]:
            # mudou o usuario sem informar a senha: nao reaproveita a senha de outro login
            raise _bad("Enter the password for the new username.")
        else:
            raise _bad("Password is required when a username is set.")

    await pool.execute(
        """INSERT INTO smtp_settings (id, host, port, security, auth_user, password, from_address, from_name, app_url, updated_at, updated_by)
           VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
           ON CONFLICT (id) DO UPDATE SET
             host = EXCLUDED.host, port = EXCLUDED.port, security = EXCLUDED.security,
             auth_user = EXCLUDED.auth_user, password = EXCLUDED.password,
             from_address = EXCLUDED.from_address, from_name = EXCLUDED.from_name,
             app_url = EXCLUDED.app_url, updated_at = NOW(), updated_by = EXCLUDED.updated_by""",
        host, port, security, username or None, stored_password, from_address, from_name or None, app_url, user["username"],
    )
    await log_audit(user["username"], "update", "smtp_settings", "smtp", "SMTP",
                    f"SMTP server configured ({host}:{port}, {security}) via Settings → System → E-mail (SMTP)")
    return _public(await pool.fetchrow("SELECT * FROM smtp_settings WHERE id = 1"))


@router.delete("")
async def delete_smtp(user: CurrentUser = Depends(require_super_admin)) -> dict:
    await get_pool().execute("DELETE FROM smtp_settings WHERE id = 1")
    await log_audit(user["username"], "delete", "smtp_settings", "smtp", "SMTP",
                    "SMTP configuration removed via Settings → System → E-mail (SMTP)")
    return {"ok": True}


@router.post("/test")
async def test_smtp(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_super_admin)) -> dict:
    to = body.get("to")
    to = to.strip() if isinstance(to, str) else ""
    if not to or len(to) > 254 or not EMAIL_RE.match(to):
        raise _bad("A valid recipient e-mail is required.")
    cfg = await mailer.load_config()
    if not cfg:
        raise HTTPException(status_code=409, detail={"error": "smtp_not_configured", "message": "Save the SMTP settings first."})
    try:
        await mailer.send_mail(
            to, "Toolbox45 — SMTP test",
            "This is a test message from Toolbox45.\n\nIf you can read this, the SMTP server is configured correctly "
            "and the \"Forgot password\" e-mails will be delivered.\n",
            cfg=cfg,
        )
    except mailer.MailError as err:
        raise HTTPException(status_code=502, detail={"error": "smtp_error", "message": str(err)})
    await log_audit(user["username"], "update", "smtp_settings", "smtp", "SMTP", f"SMTP test message sent to {to}")
    return {"ok": True}
