"""Rotas de autenticacao local (login/logout/registro) + GET
/api/auth/providers -- porta 1:1 de POST /api/auth/login, POST
/api/auth/logout, POST /api/auth/register e GET /api/auth/providers em
server/index.js.

OAuth (Google/Microsoft) fica pra fatia 3 do roadmap -- GET
/api/auth/providers ja reflete corretamente se estao configurados via
variavel de ambiente (ver app/config.py), mas os endpoints
/api/auth/google*/microsoft* em si ainda nao existem neste backend.
"""
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel

from .. import oauth, setup
from ..auth_events import log_auth_event
from ..db import get_pool
from ..login_guard import client_ip, login_limiter
from ..security import burn_verify, hash_password_async, verify_password_async
from ..password_policy import password_problem
from ..session import (
    SESSION_COOKIE_NAME,
    clear_session_cookie,
    create_session,
    delete_session,
    request_is_https,
    set_session_cookie,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

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
    return {"google": oauth.google_config.enabled, "microsoft": oauth.microsoft_config.enabled}


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

    token = await create_session(user["username"])
    set_session_cookie(response, token, secure=request_is_https(request))
    await log_auth_event("login_success", request=request, ip=ip, username=user["username"])
    return {"username": user["username"], "role": user["role"]}


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
