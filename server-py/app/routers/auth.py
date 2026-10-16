"""Rotas de autenticacao local (login/logout/registro) + GET
/api/auth/providers -- porta 1:1 de POST /api/auth/login, POST
/api/auth/logout, POST /api/auth/register e GET /api/auth/providers em
server/index.js.

OAuth (Google/Microsoft) fica pra fatia 3 do roadmap -- GET
/api/auth/providers ja reflete corretamente se estao configurados via
variavel de ambiente (ver app/config.py), mas os endpoints
/api/auth/google*/microsoft* em si ainda nao existem neste backend.
"""
import asyncio
import hashlib
import logging
import re
import secrets
from html import escape
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel

from .. import mailer, mfa, oauth, setup
from ..auth_events import log_auth_event
from ..db import get_pool
from ..login_guard import client_ip, forgot_limiter, login_limiter, mfa_limiter, reset_limiter
from ..security import burn_verify, hash_password_async, verify_password_async
from ..password_policy import password_problem
from ..session import (
    SESSION_COOKIE_NAME,
    clear_session_cookie,
    create_session,
    delete_session,
    delete_user_sessions,
    request_is_https,
    set_session_cookie,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger("toolbox45")

# Mesma regex de server/index.js (EMAIL_RE) -- validacao simples de formato,
# nao de existencia real do dominio/caixa postal.
# `\x00` fora: o Postgres recusa o byte NUL em TEXT (daria 500 em vez de 400).
EMAIL_RE = re.compile(r"^[^\s@\x00]+@[^\s@\x00]+\.[^\s@\x00]+$")


# Campos Optional (nao obrigatorios pro pydantic) DE PROPOSITO: um corpo sem
# "username"/"password" precisa continuar chegando na funcao da rota pra
# cair no MESMO 400 {"error":"validation_error",...} que o Node devolve
# (`const { username, password } = req.body || {}`), em vez do 422 padrao
# do FastAPI que a validacao automatica geraria se o campo fosse obrigatorio.
class LoginRequest(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None


class SetupRequest(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None


class RegisterRequest(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None


@router.get("/providers")
async def get_providers() -> dict:
    # Le a config JA com a prioridade banco > ambiente (ver app/oauth.py) --
    # mesmo GOOGLE_ENABLED/MICROSOFT_ENABLED que o Node calcula depois de
    # reloadOAuthConfig().
    return {
        "google": oauth.google_config.enabled,
        "microsoft": oauth.microsoft_config.enabled,
        # "Esqueci a senha" so aparece se ha SMTP configurado (Settings -> System).
        "passwordReset": await mailer.is_configured(),
    }


@router.get("/setup-status")
async def setup_status() -> dict:
    """Publica: o login usa isto para decidir se mostra a tela de primeiro
    acesso (ver app/setup.py)."""
    mode = await setup.get_mode()
    return {"required": mode is not None, "mode": mode}


@router.post("/setup")
async def initial_setup(payload: SetupRequest, request: Request, response: Response) -> dict:
    """Primeiro acesso: cria o super_admin com o e-mail/senha informados (ou
    converte o `admin` padrao de uma instalacao antiga) e ja abre a sessao dele.
    So funciona enquanto a configuracao inicial esta pendente (senao 409)."""
    email = (payload.email or "").strip().lower()
    if not email or not EMAIL_RE.match(email):
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": "A valid e-mail address is required"},
        )
    problem = password_problem(payload.password, email)
    if problem:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": problem})
    if await setup.get_mode() is None:
        raise HTTPException(
            status_code=409,
            detail={"error": "setup_not_required", "message": "The initial setup has already been completed."},
        )

    password_hash = await hash_password_async(payload.password)
    try:
        mode = await setup.complete_setup(email, password_hash)
    except ValueError:
        raise HTTPException(
            status_code=409,
            detail={"error": "conflict", "message": "An account with this e-mail already exists."},
        )
    if mode is None:  # outra requisicao concluiu a configuracao antes desta
        raise HTTPException(
            status_code=409,
            detail={"error": "setup_not_required", "message": "The initial setup has already been completed."},
        )
    token = await create_session(email)
    set_session_cookie(response, token, secure=request_is_https(request))
    await log_auth_event("setup_completed", request=request, username=email, detail=f"mode={mode}")
    return {"username": email, "role": "super_admin", "mode": mode}


@router.post("/login")
async def login(payload: LoginRequest, request: Request, response: Response) -> dict:
    username = (payload.username or "").strip()
    password = payload.password or ""
    if not username or not password:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": '"username" and "password" are required'},
        )

    ip = client_ip(request)
    wait = login_limiter.retry_after(ip, username)
    if wait:
        # Bloqueado: responde sem calcular scrypt (rejeicao barata).
        await log_auth_event(
            "login_blocked", request=request, ip=ip, username=username, require_email=True,
            detail=f"retry_after={wait}s",
        )
        raise HTTPException(
            status_code=429,
            detail={
                "error": "too_many_attempts",
                "message": f"Too many failed login attempts. Try again in {max(1, -(-wait // 60))} minute(s).",
            },
            headers={"Retry-After": str(wait)},
        )

    if username == setup.DEFAULT_ADMIN_USERNAME and setup.default_admin_pending():
        # A conta padrao (admin/admin) so existe ate a configuracao inicial: o
        # login com ela e recusado e a tela de login mostra o formulario de setup.
        raise HTTPException(
            status_code=403,
            detail={
                "error": "setup_required",
                "message": "The default admin account is disabled. Open the login page to finish the initial setup.",
            },
        )

    pool = get_pool()
    # Byte NUL no usuario: o Postgres recusaria a consulta (500); trata como conta inexistente.
    user = None if "\x00" in username else await pool.fetchrow(
        "SELECT * FROM users WHERE username = $1 AND is_local = 1", username
    )
    if user and not user["disabled"]:
        ok = await verify_password_async(password, user["password_hash"])
        why = "bad_password"
    else:
        # Usuario inexistente/desativado: gasta o mesmo scrypt, para o tempo
        # de resposta nao revelar quais contas existem.
        await burn_verify(password)
        ok = False
        why = "account_disabled" if user else "unknown_user"
    if not ok:
        login_limiter.record_failure(ip, username)
        await log_auth_event("login_failed", request=request, ip=ip, username=username, require_email=True, detail=why)
        raise HTTPException(
            status_code=401,
            detail={"error": "invalid_credentials", "message": "Invalid username or password"},
        )
    login_limiter.record_success(ip, username)

    # MFA por e-mail (ver app/mfa.py): senha certa, mas ainda falta o codigo.
    needs_code, enrolling = await mfa.login_requirement(user)
    if needs_code:
        try:
            challenge = await mfa.start_challenge(user["username"], "login")
        except mailer.MailError as err:
            logger.error("MFA code e-mail failed for %s: %s", user["username"], err)
            raise HTTPException(
                status_code=502,
                detail={"error": "mfa_send_failed", "message": "Could not send the verification code by e-mail. Try again or contact an administrator."},
            )
        await log_auth_event("mfa_code_sent", request=request, ip=ip, username=user["username"], require_email=True,
                             detail="enrolling" if enrolling else "login")
        return {"mfaRequired": True, "challenge": challenge, "maskedEmail": mfa.mask_email(user["username"]), "enrolling": enrolling}
    if (user["mfa_enabled"] or await mfa.is_required_for(user)):
        await log_auth_event("mfa_skipped", request=request, ip=ip, username=user["username"], require_email=True,
                             detail="smtp_not_configured")

    token = await create_session(user["username"])
    set_session_cookie(response, token, secure=request_is_https(request))
    await log_auth_event("login_success", request=request, ip=ip, username=user["username"])
    return {"username": user["username"], "role": user["role"]}


class MfaVerifyRequest(BaseModel):
    challenge: Optional[str] = None
    code: Optional[str] = None


@router.post("/mfa/verify")
async def mfa_verify(payload: MfaVerifyRequest, request: Request, response: Response) -> dict:
    challenge = payload.challenge or ""
    key = mfa._h(challenge)[:24]
    ip = client_ip(request)
    wait = mfa_limiter.retry_after(ip, key)
    if wait:
        raise HTTPException(
            status_code=429,
            detail={"error": "too_many_attempts", "message": f"Too many attempts. Try again in {max(1, -(-wait // 60))} minute(s)."},
            headers={"Retry-After": str(wait)},
        )
    try:
        username = await mfa.check(challenge, payload.code or "", "login")
    except mfa.MfaError as err:
        mfa_limiter.record_failure(ip, key)
        await log_auth_event("mfa_failed", request=request, ip=ip, detail=err.code)
        raise HTTPException(status_code=err.status, detail={"error": err.code, "message": err.message})
    pool = get_pool()
    user = await pool.fetchrow("SELECT * FROM users WHERE username = $1 AND is_local = 1", username)
    if not user or user["disabled"]:
        raise HTTPException(status_code=400, detail={"error": "invalid_challenge", "message": "This verification expired. Sign in again."})
    if not user["mfa_enabled"]:
        # ativacao: quem foi EXIGIDO e acertou o codigo prova que o e-mail recebe -> MFA ligado
        await pool.execute("UPDATE users SET mfa_enabled = 1 WHERE username = $1", username)
        await log_auth_event("mfa_enabled", request=request, ip=ip, username=username, require_email=True, detail="on_login")
    token = await create_session(username)
    set_session_cookie(response, token, secure=request_is_https(request))
    await log_auth_event("login_success", request=request, ip=ip, username=username, require_email=True, detail="mfa")
    return {"username": username, "role": user["role"]}


class MfaResendRequest(BaseModel):
    challenge: Optional[str] = None


@router.post("/mfa/resend")
async def mfa_resend(payload: MfaResendRequest, request: Request) -> dict:
    ip = client_ip(request)
    wait = mfa_limiter.retry_after(ip, "resend")
    if wait:
        raise HTTPException(status_code=429, detail={"error": "too_many_attempts", "message": "Too many requests. Try again later."},
                            headers={"Retry-After": str(wait)})
    mfa_limiter.record_failure(ip, "resend")
    try:
        username = await mfa.resend(payload.challenge or "", "login")
    except mfa.MfaError as err:
        raise HTTPException(status_code=err.status, detail={"error": err.code, "message": err.message})
    return {"ok": True, "maskedEmail": mfa.mask_email(username)}


@router.post("/logout")
async def logout(request: Request, response: Response) -> Response:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token:
        await delete_session(token)
    clear_session_cookie(response, secure=request_is_https(request))
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, request: Request) -> dict:
    email = (payload.email or "").strip()
    if not email or not EMAIL_RE.match(email):
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": "A valid e-mail address is required"},
        )
    password = payload.password or ""
    normalized_email = email.lower()
    problem = password_problem(password, normalized_email)
    if problem:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": problem})

    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM users WHERE username = $1", normalized_email)
    if existing:
        # Ja cadastrado e ainda nao aprovado: mesma mensagem, nao importa se
        # ja existia antes ou se foi criado agora -- mesmo comportamento do
        # Node.
        if existing["disabled"] and not existing["approved_at"]:
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "pending_approval",
                    "message": "This e-mail is already registered and is pending administrator approval.",
                },
            )
        raise HTTPException(
            status_code=409,
            detail={
                "error": "account_exists",
                "message": "An account with this e-mail already exists. Please log in instead.",
            },
        )

    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO users (username, password_hash, role, is_local, disabled, created_by, auth_provider)
               VALUES ($1, $2, 'user', 1, 1, 'self-registration', 'local')""",
            normalized_email, await hash_password_async(password),
        )
        # ensureDefaultFolder(): toda conta nova ja nasce com a pasta
        # "Favorites" -- ON CONFLICT DO NOTHING pelo mesmo motivo do Node
        # (seguro sob corrida, nunca duplica).
        await conn.execute(
            "INSERT INTO folders (username, name) VALUES ($1, 'Favorites') ON CONFLICT (username, name) DO NOTHING",
            normalized_email,
        )
        # logAudit() simplificado: so o INSERT -- o DELETE de retencao (30
        # dias) do Node roda a cada logAudit() individual; replicado aqui
        # tambem pra nao deixar o audit_log crescer sem limite so porque
        # as chamadas vieram do backend Python.
        await conn.execute(
            "INSERT INTO audit_log (username, action, entity_type, entity_id, entity_name, details) VALUES ($1,$2,$3,$4,$5,$6)",
            normalized_email, "create", "user", normalized_email, normalized_email,
            "Self-registered, pending approval",
        )
        await conn.execute(
            "DELETE FROM audit_log WHERE ts < NOW() - INTERVAL '30 days'"
        )

    await log_auth_event("register", request=request, username=normalized_email, detail="pending_approval")
    return {
        "status": "pending_approval",
        "message": "Your account was created and is pending administrator approval.",
    }


# ════════════════════════════════════════════════
# "Esqueci a senha" (contas locais) -- precisa do SMTP configurado.
#
#   POST /api/auth/forgot-password {email}  -> SEMPRE 200 com a mesma mensagem (nao
#        revela se a conta existe); manda um e-mail com um link de uso unico.
#   POST /api/auth/reset-password {token, password} -> troca a senha, encerra as
#        sessoes da conta e invalida os outros links pendentes.
#
# Seguranca: token aleatorio de 256 bits, so o SHA-256 vai para o banco, validade de
# 30 min, uso unico, limite de pedidos por IP/e-mail, link montado com a "Public URL"
# do SMTP (nunca com o cabecalho Host), token no fragmento (#) do link para nao ir a
# logs/Referer, e e-mail so para conta local ativa cujo usuario e um e-mail.
# ════════════════════════════════════════════════
RESET_TOKEN_TTL_MINUTES = 30
FORGOT_GENERIC_MESSAGE = (
    "If an account with that e-mail exists and can be reset, we sent a message with a link to choose a new password."
)
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-]{20,128}$")


class ForgotRequest(BaseModel):
    email: Optional[str] = None


class ResetRequest(BaseModel):
    token: Optional[str] = None
    password: Optional[str] = None


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _reset_email(link: str, minutes: int) -> tuple:
    text = (
        "Someone asked to reset the password of your Toolbox45 account.\n\n"
        f"To choose a new password, open this link (valid for {minutes} minutes, one use only):\n{link}\n\n"
        "If you did not ask for this, ignore this message -- your password stays the same."
    )
    safe = escape(link, quote=True)
    html = (
        "<p>Someone asked to reset the password of your Toolbox45 account.</p>"
        f'<p><a href="{safe}">Choose a new password</a><br>'
        f"<small>The link is valid for {minutes} minutes and works only once.</small></p>"
        "<p><small>If you did not ask for this, ignore this message &mdash; your password stays the same.</small></p>"
    )
    return text, html


async def _send_reset_email(email: str, link: str, cfg: dict) -> None:
    try:
        text, html = _reset_email(link, RESET_TOKEN_TTL_MINUTES)
        await mailer.send_mail(email, "Toolbox45 — reset your password", text, html, cfg=cfg)
    except Exception as err:  # noqa: BLE001  (segundo plano: so registra, sem expor ao cliente)
        logger.error("password reset e-mail failed: %s", err)


_background: set = set()


@router.post("/forgot-password")
async def forgot_password(payload: ForgotRequest, request: Request) -> dict:
    email = (payload.email or "").strip()
    if not email or len(email) > 254 or not EMAIL_RE.match(email):
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": "A valid e-mail address is required"},
        )
    username = email.lower()
    ip = client_ip(request)
    wait = forgot_limiter.retry_after(ip, username)
    if wait:
        raise HTTPException(
            status_code=429,
            detail={
                "error": "too_many_attempts",
                "message": f"Too many requests. Try again in {max(1, -(-wait // 60))} minute(s).",
            },
            headers={"Retry-After": str(wait)},
        )
    forgot_limiter.record_failure(ip, username)   # conta o pedido (tenha a conta existido ou nao)

    cfg = await mailer.load_config()
    if not cfg:
        raise HTTPException(
            status_code=503,
            detail={"error": "smtp_not_configured", "message": "Password reset by e-mail is not available. Ask an administrator."},
        )

    pool = get_pool()
    user = await pool.fetchrow(
        "SELECT username, disabled FROM users WHERE username = $1 AND is_local = 1 AND password_hash IS NOT NULL", username
    )
    skip = (
        not user
        or user["disabled"]
        or (username == setup.DEFAULT_ADMIN_USERNAME and setup.default_admin_pending())
    )
    await log_auth_event(
        "password_reset_requested", request=request, ip=ip, username=username, require_email=True,
        detail="sent" if not skip else "ignored",
    )
    if not skip:
        token = secrets.token_urlsafe(32)
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM password_reset_tokens WHERE username = $1 OR expires_at < NOW()", username)
                await conn.execute(
                    "INSERT INTO password_reset_tokens (token_hash, username, expires_at) "
                    "VALUES ($1, $2, NOW() + make_interval(mins => $3))",
                    _token_hash(token), username, RESET_TOKEN_TTL_MINUTES,
                )
        link = f"{cfg['app_url']}/login.html#reset={token}"
        # Em segundo plano: o tempo de resposta nao revela se a conta existe.
        task = asyncio.create_task(_send_reset_email(username, link, cfg))
        _background.add(task)
        task.add_done_callback(_background.discard)
    return {"ok": True, "message": FORGOT_GENERIC_MESSAGE}


@router.post("/reset-password")
async def reset_password(payload: ResetRequest, request: Request) -> dict:
    token = (payload.token or "").strip()
    ip = client_ip(request)
    wait = reset_limiter.retry_after(ip, "")
    if wait:
        raise HTTPException(
            status_code=429,
            detail={"error": "too_many_attempts", "message": f"Too many attempts. Try again in {max(1, -(-wait // 60))} minute(s)."},
            headers={"Retry-After": str(wait)},
        )
    invalid = HTTPException(
        status_code=400,
        detail={"error": "invalid_token", "message": "This reset link is invalid or has expired. Ask for a new one."},
    )
    if not _TOKEN_RE.match(token):
        reset_limiter.record_failure(ip, "")
        raise invalid

    pool = get_pool()
    row = await pool.fetchrow(
        """SELECT t.username, u.disabled FROM password_reset_tokens t JOIN users u ON u.username = t.username
           WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW() AND u.is_local = 1""",
        _token_hash(token),
    )
    if not row or row["disabled"]:
        reset_limiter.record_failure(ip, "")
        await log_auth_event("password_reset_failed", request=request, ip=ip, detail="invalid_or_expired_token")
        raise invalid

    username = row["username"]
    problem = password_problem(payload.password, username)
    if problem:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": problem})

    new_hash = await hash_password_async(payload.password)
    async with pool.acquire() as conn:
        async with conn.transaction():
            # uso unico: so uma requisicao "consome" o token (corrida entre duas abas)
            consumed = await conn.fetchval(
                "UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL RETURNING 1",
                _token_hash(token),
            )
            if not consumed:
                raise invalid
            await conn.execute("UPDATE users SET password_hash = $1 WHERE username = $2", new_hash, username)
            await conn.execute("DELETE FROM password_reset_tokens WHERE username = $1", username)
    revoked = await delete_user_sessions(username)
    await log_auth_event(
        "password_reset_done", request=request, ip=ip, username=username, require_email=True,
        detail=f"{revoked} session(s) revoked",
    )
    return {"ok": True, "message": "Your password was changed. You can log in now."}
