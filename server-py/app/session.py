"""Sessao (cookie tb45_session) -- porta de server/index.js. Login local,
Google e Microsoft compartilham a MESMA tabela `sessions` e o MESMO cookie;
so users.auth_provider diz qual foi (login com Google/Microsoft fica pra
fatia 3, mas a tabela/cookie ja sao os definitivos desde ja).
"""
from datetime import datetime, timedelta, timezone
from typing import Optional, TypedDict

from fastapi import Request, Response

from .db import get_pool
from .security import generate_session_token

SESSION_COOKIE_NAME = "tb45_session"
SESSION_TTL_SECONDS = 12 * 60 * 60  # 12h -- mesmo valor do Node (SESSION_TTL_MS)


class CurrentSession(TypedDict):
    username: str
    role: str
    auth_provider: str


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=SESSION_TTL_SECONDS,
        path="/",
        httponly=True,
        samesite="lax",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/", httponly=True, samesite="lax")


async def create_session(username: str) -> str:
    token = generate_session_token()
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=SESSION_TTL_SECONDS)
    pool = get_pool()
    await pool.execute(
        "INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, $3)",
        token, username, expires_at,
    )
    return token


async def delete_session(token: str) -> None:
    pool = get_pool()
    await pool.execute("DELETE FROM sessions WHERE token = $1", token)


async def get_current_session(request: Request) -> Optional[CurrentSession]:
    """Resolve a sessao a partir do cookie, sem forcar 401 -- igual ao
    middleware de sessao "silencioso" do Node, que so preenche
    req.currentUser quando existe uma sessao valida; quem decide se a rota
    EXIGE sessao e cada rota/dependencia especifica (nenhuma rota da fatia
    2 exige -- login/logout/registro/providers sao publicas no Node, ver
    REQUIRE_AUTH_PUBLIC_ROUTES em server/index.js). Sera reaproveitada pelas
    proximas fatias (ex.: GET /api/me) para um requireAuth de verdade.
    """
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    pool = get_pool()
    row = await pool.fetchrow(
        """SELECT s.username, u.role, u.disabled, u.auth_provider
           FROM sessions s JOIN users u ON u.username = s.username
           WHERE s.token = $1 AND s.expires_at > NOW()""",
        token,
    )
    if not row or row["disabled"]:
        return None
    auth_provider = row["auth_provider"] if row["auth_provider"] in ("google", "microsoft") else "local"
    return {"username": row["username"], "role": row["role"], "auth_provider": auth_provider}
