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

from .. import oauth
from ..db import get_pool
from ..handles import generate_unique_handle
from ..security import hash_password, verify_password
from ..session import (
    SESSION_COOKIE_NAME,
    clear_session_cookie,
    create_session,
    delete_session,
    set_session_cookie,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Mesma regex de server/index.js (EMAIL_RE) -- validacao simples de formato,
# nao de existencia real do dominio/caixa postal.
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


# Campos Optional (nao obrigatorios pro pydantic) DE PROPOSITO: um corpo sem
# "username"/"password" precisa continuar chegando na funcao da rota pra
# cair no MESMO 400 {"error":"validation_error",...} que o Node devolve
# (`const { username, password } = req.body || {}`), em vez do 422 padrao
# do FastAPI que a validacao automatica geraria se o campo fosse obrigatorio.
class LoginRequest(BaseModel):
    username: Optional[str] = None
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


@router.post("/login")
async def login(payload: LoginRequest, response: Response) -> dict:
    username = (payload.username or "").strip()
    password = payload.password or ""
    if not username or not password:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": '"username" and "password" are required'},
        )

    pool = get_pool()
    user = await pool.fetchrow(
        "SELECT * FROM users WHERE username = $1 AND is_local = 1", username
    )
    if not user or user["disabled"] or not verify_password(password, user["password_hash"]):
        raise HTTPException(
            status_code=401,
            detail={"error": "invalid_credentials", "message": "Invalid username or password"},
        )

    token = await create_session(user["username"])
    set_session_cookie(response, token)
    return {"username": user["username"], "role": user["role"]}


@router.post("/logout")
async def logout(request: Request, response: Response) -> Response:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token:
        await delete_session(token)
    clear_session_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest) -> dict:
    email = (payload.email or "").strip()
    if not email or not EMAIL_RE.match(email):
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": "A valid e-mail address is required"},
        )
    password = payload.password or ""
    if len(password) < 4:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": '"password" must be at least 4 characters'},
        )

    normalized_email = email.lower()
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
        handle = await generate_unique_handle(conn, normalized_email)
        await conn.execute(
            """INSERT INTO users (username, password_hash, role, is_local, disabled, created_by, auth_provider, handle)
               VALUES ($1, $2, 'user', 1, 1, 'self-registration', 'local', $3)""",
            normalized_email, hash_password(password), handle,
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

    return {
        "status": "pending_approval",
        "message": "Your account was created and is pending administrator approval.",
    }
