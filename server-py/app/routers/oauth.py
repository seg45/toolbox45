"""Login com Google e Microsoft (OAuth 2.0 Authorization Code) -- porta 1:1
de GET /api/auth/google[/callback] e GET /api/auth/microsoft[/callback] em
server/index.js. Mesma sessao/cookie (tb45_session, tabela `sessions`) da
fatia 2 -- so troca COMO a conta e confirmada antes de criar a sessao.

Nao inclui GET/PUT/DELETE /api/system/oauth/:provider (tela de config
admin-only) -- isso fica pra fatia 9 "Sistema". A leitura da config (com
prioridade do banco sobre o ambiente) ja existe desde ja em app/oauth.py.
"""
import base64
import json
import re
import secrets
from typing import Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, RedirectResponse

from .. import oauth
from ..db import get_pool
from ..handles import generate_unique_handle
from ..auth_events import log_auth_event
from ..session import create_session, request_is_https, set_session_cookie

router = APIRouter(prefix="/api/auth", tags=["oauth"])

OAUTH_STATE_COOKIE = "tb45_oauth_state"        # Google
OAUTH_STATE_COOKIE_MS = "tb45_oauth_state_ms"  # Microsoft -- cookie proprio,
# nao reaproveita o do Google, pra nao colidir se o usuario tiver os dois
# fluxos abertos em abas diferentes ao mesmo tempo (mesmo comentario do Node).
_STATE_COOKIE_MAX_AGE = 300  # 5 min -- so durante a ida-e-volta do consentimento
_HTTP_TIMEOUT = 15.0


_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# Endpoints "multi-tenant" da Microsoft: aceitam contas de QUALQUER organizacao
# (e contas pessoais) -- o `email` que vem delas NAO e verificado.
_MS_MULTI_TENANT = {"common", "organizations", "consumers"}


def decode_jwt_claims(token) -> Optional[dict]:
    """Le as claims de um JWT SEM verificar a assinatura. E aceitavel aqui
    porque o id_token chega direto do endpoint de token da Microsoft, numa
    chamada HTTPS que NOS fizemos com o client_secret (OIDC Core 3.1.3.7: a
    validacao do TLS/servidor substitui a assinatura nesse fluxo) -- ele nunca
    vem do navegador do usuario."""
    try:
        parts = str(token).split(".")
        if len(parts) != 3:
            return None
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
        return claims if isinstance(claims, dict) else None
    except Exception:  # noqa: BLE001
        return None


def microsoft_identity_problem(tenant_id: Optional[str], client_id: Optional[str], claims: Optional[dict], email: str) -> Optional[str]:
    """Defesa contra o "nOAuth": o `email` do userinfo da Microsoft e um atributo
    EDITAVEL e nao verificado -- quem cria o proprio tenant no Azure AD consegue
    por la o e-mail de qualquer pessoa. Como o login casa a conta pelo e-mail,
    isso permitiria entrar como outro usuario (ou pedir aprovacao se passando
    por ele). Por isso o e-mail so e aceito quando a identidade bate com algo
    que o provedor garante:
      * tenant fixo (GUID): o id_token tem que ser DAQUELE tenant (tid) -- so
        usuarios da organizacao entram, e ela e dona dos e-mails;
      * tenant por dominio (ex.: contoso.onmicrosoft.com): o endpoint de
        autorizacao ja e especifico do tenant;
      * common/organizations/consumers: o `preferred_username` (UPN, cujo
        dominio precisa ser verificado no tenant de origem) tem que ser igual ao
        e-mail -- um tenant do atacante nao consegue ter um UPN @empresa.com.
        Se o UPN da sua organizacao difere do e-mail, configure o ID do tenant
        em Settings -> System -> OAuth.
    Devolve o codigo de motivo (vai para /login.html?microsoft=error&reason=...)
    ou None se esta tudo certo."""
    if not claims:
        return "invalid_token"
    if not client_id or claims.get("aud") != client_id:
        return "invalid_token"
    tid = str(claims.get("tid") or "").lower()
    if not tid:
        return "invalid_token"
    tenant = (tenant_id or "common").strip().lower()
    if _GUID_RE.match(tenant):
        return None if tid == tenant else "tenant_mismatch"
    if tenant in _MS_MULTI_TENANT:
        upn = str(claims.get("preferred_username") or "").strip().lower()
        return None if upn and upn == email else "email_not_verified"
    return None


def _set_state_cookie(response: RedirectResponse, name: str, value: str, secure: bool = False) -> None:
    response.set_cookie(key=name, value=value, max_age=_STATE_COOKIE_MAX_AGE, path="/", httponly=True, samesite="lax", secure=secure)


def _clear_state_cookie(response: RedirectResponse, name: str, secure: bool = False) -> None:
    response.delete_cookie(key=name, path="/", httponly=True, samesite="lax", secure=secure)


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
async def google_login(request: Request):
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
    _set_state_cookie(response, OAUTH_STATE_COOKIE, state, secure=request_is_https(request))
    return response


@router.get("/google/callback")
async def google_callback(request: Request):
    _sec = request_is_https(request)

    def failure(reason: str) -> RedirectResponse:
        r = RedirectResponse(f"/login.html?google=error&reason={reason}", status_code=302)
        _clear_state_cookie(r, OAUTH_STATE_COOKIE, secure=_sec)
        return r

    ctx = {"email": None}

    async def fail(reason: str) -> RedirectResponse:
        await log_auth_event("oauth_failed", request=request, username=ctx["email"], detail=f"google:{reason}")
        return failure(reason)

    cfg = oauth.google_config
    if not cfg.enabled:
        return await fail("not_configured")

    qp = request.query_params
    if qp.get("error"):
        return await fail("access_denied")
    state = qp.get("state")
    cookie_state = request.cookies.get(OAUTH_STATE_COOKIE)
    if not state or not cookie_state or state != cookie_state:
        return await fail("invalid_state")
    code = qp.get("code")
    if not code:
        return await fail("missing_code")

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
                return await fail("token_exchange_failed")
            tokens = token_res.json()

            profile_res = await client.get(
                "https://openidconnect.googleapis.com/v1/userinfo",
                headers={"Authorization": f"Bearer {tokens.get('access_token')}"},
            )
            if profile_res.status_code >= 400:
                return await fail("profile_fetch_failed")
            profile = profile_res.json()
    except httpx.HTTPError:
        return await fail("internal_error")

    email_verified = profile.get("email_verified")
    if not profile.get("email") or email_verified not in (True, "true"):
        return await fail("email_not_verified")
    email = str(profile["email"]).lower()
    ctx["email"] = email

    outcome, payload = await _provision_or_login(email, "google", "google-oauth")
    if outcome == "failure":
        return await fail(payload)
    if outcome == "pending":
        await log_auth_event("oauth_pending", request=request, username=email, detail="google")
        r = RedirectResponse("/login.html?google=pending", status_code=302)
        _clear_state_cookie(r, OAUTH_STATE_COOKIE, secure=_sec)
        return r

    token = await create_session(payload["username"])
    await log_auth_event("oauth_login", request=request, username=payload["username"], detail="google")
    r = RedirectResponse("/login.html?google=success", status_code=302)
    _clear_state_cookie(r, OAUTH_STATE_COOKIE, secure=_sec)
    set_session_cookie(r, token, secure=_sec)
    return r


# ──────────────────────────── Microsoft ────────────────────────────

@router.get("/microsoft")
async def microsoft_login(request: Request):
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
    _set_state_cookie(response, OAUTH_STATE_COOKIE_MS, state, secure=request_is_https(request))
    return response


@router.get("/microsoft/callback")
async def microsoft_callback(request: Request):
    _sec = request_is_https(request)

    def failure(reason: str) -> RedirectResponse:
        r = RedirectResponse(f"/login.html?microsoft=error&reason={reason}", status_code=302)
        _clear_state_cookie(r, OAUTH_STATE_COOKIE_MS, secure=_sec)
        return r

    ctx = {"email": None}

    async def fail(reason: str) -> RedirectResponse:
        await log_auth_event("oauth_failed", request=request, username=ctx["email"], detail=f"microsoft:{reason}")
        return failure(reason)

    cfg = oauth.microsoft_config
    if not cfg.enabled:
        return await fail("not_configured")

    qp = request.query_params
    if qp.get("error"):
        return await fail("access_denied")
    state = qp.get("state")
    cookie_state = request.cookies.get(OAUTH_STATE_COOKIE_MS)
    if not state or not cookie_state or state != cookie_state:
        return await fail("invalid_state")
    code = qp.get("code")
    if not code:
        return await fail("missing_code")

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
                return await fail("token_exchange_failed")
            tokens = token_res.json()

            profile_res = await client.get(
                "https://graph.microsoft.com/oidc/userinfo",
                headers={"Authorization": f"Bearer {tokens.get('access_token')}"},
            )
            if profile_res.status_code >= 400:
                return await fail("profile_fetch_failed")
            profile = profile_res.json()
    except httpx.HTTPError:
        return await fail("internal_error")

    # Diferente do Google, o userinfo do Microsoft nao devolve
    # "email_verified" -- so exige que o e-mail tenha vindo preenchido
    # (mesmo comportamento do Node).
    if not profile.get("email"):
        return await fail("email_not_verified")
    email = str(profile["email"]).lower()
    ctx["email"] = email

    problem = microsoft_identity_problem(
        cfg.tenant_id, cfg.client_id, decode_jwt_claims(tokens.get("id_token")), email
    )
    if problem:
        return await fail(problem)

    outcome, payload = await _provision_or_login(email, "microsoft", "microsoft-oauth")
    if outcome == "failure":
        return await fail(payload)
    if outcome == "pending":
        await log_auth_event("oauth_pending", request=request, username=email, detail="microsoft")
        r = RedirectResponse("/login.html?microsoft=pending", status_code=302)
        _clear_state_cookie(r, OAUTH_STATE_COOKIE_MS, secure=_sec)
        return r

    token = await create_session(payload["username"])
    await log_auth_event("oauth_login", request=request, username=payload["username"], detail="microsoft")
    r = RedirectResponse("/login.html?microsoft=success", status_code=302)
    _clear_state_cookie(r, OAUTH_STATE_COOKIE_MS, secure=_sec)
    set_session_cookie(r, token, secure=_sec)
    return r
