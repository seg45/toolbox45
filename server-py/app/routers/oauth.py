"""Login com Google e Microsoft (OAuth 2.0 Authorization Code) -- porta 1:1
de GET /api/auth/google[/callback] e GET /api/auth/microsoft[/callback] em
server/index.js. Mesma sessao/cookie (tb45_session, tabela `sessions`) da
fatia 2 -- so troca COMO a conta e confirmada antes de criar a sessao.

Nao inclui GET/PUT/DELETE /api/system/oauth/:provider (tela de config
admin-only) -- isso fica pra fatia 9 "Sistema". A leitura da config (com
prioridade do banco sobre o ambiente) ja existe desde ja em app/oauth.py.
"""
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, RedirectResponse

from .. import oauth
from ..db import get_pool
from ..handles import generate_unique_handle
from ..session import create_session, set_session_cookie

router = APIRouter(prefix="/api/auth", tags=["oauth"])

OAUTH_STATE_COOKIE = "tb45_oauth_state"        # Google
OAUTH_STATE_COOKIE_MS = "tb45_oauth_state_ms"  # Microsoft -- cookie proprio,
# nao reaproveita o do Google, pra nao colidir se o usuario tiver os dois
# fluxos abertos em abas diferentes ao mesmo tempo (mesmo comentario do Node).
_STATE_COOKIE_MAX_AGE = 300  # 5 min -- so durante a ida-e-volta do consentimento
_HTTP_TIMEOUT = 15.0


def _set_state_cookie(response: RedirectResponse, name: str, value: str) -> None:
    response.set_cookie(key=name, value=value, max_age=_STATE_COOKIE_MAX_AGE, path="/", httponly=True, samesite="lax")


def _clear_state_cookie(response: RedirectResponse, name: str) -> None:
    response.delete_cookie(key=name, path="/", httponly=True, samesite="lax")


async def _provision_or_login(email: str, provider: str, created_by: str):
    """Replica os 3 ramos de server/index.js (conta existente de outro
    provedor -> failure; existente e desabilitada -> pending/failure;
    existente e habilitada -> login; nao existe -> cria pendente).
    Retorna ("login", user_row) | ("pending", None) | ("failure", motivo).
    """
    pool = get_pool()
    user = await pool.fetchrow("SELECT * FROM users WHERE username = $1", email)
    if user:
        if user["auth_provider"] != provider:
            # Este e-mail ja pertence a uma conta local/outro provedor --
            # recusa entrar "como" ela (evita account takeover).
            return ("failure", "account_exists_other_method")
        if user["disabled"]:
            if not user["approved_at"]:
                return ("pending", None)
            return ("failure", "account_disabled")
        return ("login", user)

    async with pool.acquire() as conn:
        handle = await generate_unique_handle(conn, email)
        await conn.execute(
            """INSERT INTO users (username, role, is_local, disabled, created_by, auth_provider, handle)
               VALUES ($1, 'user', 0, 1, $2, $3, $4)
               ON CONFLICT (username) DO NOTHING""",
            email, created_by, provider, handle,
        )
        new_user = await conn.fetchrow("SELECT * FROM users WHERE username = $1", email)
        if not new_user:
            return ("failure", "provisioning_failed")
        await conn.execute(
            "INSERT INTO folders (username, name) VALUES ($1, 'Favorites') ON CONFLICT (username, name) DO NOTHING",
            email,
        )
    return ("pending", None)


# ──────────────────────────── Google ────────────────────────────

@router.get("/google")
async def google_login():
    cfg = oauth.google_config
    if not cfg.enabled:
        return PlainTextResponse("Google login is not configured on this server.", status_code=503)
    state = secrets.token_hex(24)
    query = urlencode({
        "client_id": cfg.client_id,
        "redirect_uri": cfg.redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    })
    response = RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{query}", status_code=302)
    _set_state_cookie(response, OAUTH_STATE_COOKIE, state)
    return response


@router.get("/google/callback")
async def google_callback(request: Request):
    def failure(reason: str) -> RedirectResponse:
        r = RedirectResponse(f"/login.html?google=error&reason={reason}", status_code=302)
        _clear_state_cookie(r, OAUTH_STATE_COOKIE)
        return r

    cfg = oauth.google_config
    if not cfg.enabled:
        return failure("not_configured")

    qp = request.query_params
    if qp.get("error"):
        return failure("access_denied")
    state = qp.get("state")
    cookie_state = request.cookies.get(OAUTH_STATE_COOKIE)
    if not state or not cookie_state or state != cookie_state:
        return failure("invalid_state")
    code = qp.get("code")
    if not code:
        return failure("missing_code")

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            token_res = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": code,
                    "client_id": cfg.client_id,
                    "client_secret": cfg.client_secret,
                    "redirect_uri": cfg.redirect_uri,
                    "grant_type": "authorization_code",
                },
            )
            if token_res.status_code >= 400:
                return failure("token_exchange_failed")
            tokens = token_res.json()

            profile_res = await client.get(
                "https://openidconnect.googleapis.com/v1/userinfo",
                headers={"Authorization": f"Bearer {tokens.get('access_token')}"},
            )
            if profile_res.status_code >= 400:
                return failure("profile_fetch_failed")
            profile = profile_res.json()
    except httpx.HTTPError:
        return failure("internal_error")

    email_verified = profile.get("email_verified")
    if not profile.get("email") or email_verified not in (True, "true"):
        return failure("email_not_verified")
    email = str(profile["email"]).lower()

    outcome, payload = await _provision_or_login(email, "google", "google-oauth")
    if outcome == "failure":
        return failure(payload)
    if outcome == "pending":
        r = RedirectResponse("/login.html?google=pending", status_code=302)
        _clear_state_cookie(r, OAUTH_STATE_COOKIE)
        return r

    token = await create_session(payload["username"])
    r = RedirectResponse("/login.html?google=success", status_code=302)
    _clear_state_cookie(r, OAUTH_STATE_COOKIE)
    set_session_cookie(r, token)
    return r


# ──────────────────────────── Microsoft ────────────────────────────

@router.get("/microsoft")
async def microsoft_login():
    cfg = oauth.microsoft_config
    if not cfg.enabled:
        return PlainTextResponse("Microsoft login is not configured on this server.", status_code=503)
    state = secrets.token_hex(24)
    query = urlencode({
        "client_id": cfg.client_id,
        "redirect_uri": cfg.redirect_uri,
        "response_type": "code",
        "response_mode": "query",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    })
    tenant = cfg.tenant_id or "common"
    response = RedirectResponse(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?{query}", status_code=302
    )
    _set_state_cookie(response, OAUTH_STATE_COOKIE_MS, state)
    return response


@router.get("/microsoft/callback")
async def microsoft_callback(request: Request):
    def failure(reason: str) -> RedirectResponse:
        r = RedirectResponse(f"/login.html?microsoft=error&reason={reason}", status_code=302)
        _clear_state_cookie(r, OAUTH_STATE_COOKIE_MS)
        return r

    cfg = oauth.microsoft_config
    if not cfg.enabled:
        return failure("not_configured")

    qp = request.query_params
    if qp.get("error"):
        return failure("access_denied")
    state = qp.get("state")
    cookie_state = request.cookies.get(OAUTH_STATE_COOKIE_MS)
    if not state or not cookie_state or state != cookie_state:
        return failure("invalid_state")
    code = qp.get("code")
    if not code:
        return failure("missing_code")

    tenant = cfg.tenant_id or "common"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            token_res = await client.post(
                f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
                data={
                    "code": code,
                    "client_id": cfg.client_id,
                    "client_secret": cfg.client_secret,
                    "redirect_uri": cfg.redirect_uri,
                    "grant_type": "authorization_code",
                    "scope": "openid email profile",
                },
            )
            if token_res.status_code >= 400:
                return failure("token_exchange_failed")
            tokens = token_res.json()

            profile_res = await client.get(
                "https://graph.microsoft.com/oidc/userinfo",
                headers={"Authorization": f"Bearer {tokens.get('access_token')}"},
            )
            if profile_res.status_code >= 400:
                return failure("profile_fetch_failed")
            profile = profile_res.json()
    except httpx.HTTPError:
        return failure("internal_error")

    # Diferente do Google, o userinfo do Microsoft nao devolve
    # "email_verified" -- so exige que o e-mail tenha vindo preenchido
    # (mesmo comportamento do Node).
    if not profile.get("email"):
        return failure("email_not_verified")
    email = str(profile["email"]).lower()

    outcome, payload = await _provision_or_login(email, "microsoft", "microsoft-oauth")
    if outcome == "failure":
        return failure(payload)
    if outcome == "pending":
        r = RedirectResponse("/login.html?microsoft=pending", status_code=302)
        _clear_state_cookie(r, OAUTH_STATE_COOKIE_MS)
        return r

    token = await create_session(payload["username"])
    r = RedirectResponse("/login.html?microsoft=success", status_code=302)
    _clear_state_cookie(r, OAUTH_STATE_COOKIE_MS)
    set_session_cookie(r, token)
    return r
