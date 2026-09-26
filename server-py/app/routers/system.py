"""Fatia 9 (Sistema): logo customizavel, tema/cor padrao (appearance), CRUD
de configuracao OAuth (Google/Microsoft), certificado SSL/TLS customizavel,
e os dois "baldes" key/value genericos (user-data por usuario,
global-settings do admin) -- porta 1:1 de server/index.js.

Modelo de autorizacao (CONFERIDO DIRETO no server/index.js real do
Rodrigo, nao presumido -- ver lembrete sobre relatorio de subagent na fatia
8): NENHUM padrao unico se aplica a esta fatia inteira, ao contrario das
fatias anteriores (catalogo=so require_admin, users/groups=so
require_super_admin). Aqui cada rota tem seu proprio nivel:
  - GET /api/system/logo e GET /api/system/appearance: PUBLICAS (sem
    Depends nenhum) -- login.html precisa delas ANTES de qualquer sessao
    existir (mesmo motivo de GET /api/auth/providers, fatia 2).
  - PUT/DELETE /api/system/logo, GET/PUT/DELETE /api/system/oauth[/:provider],
    GET/POST/DELETE /api/system/ssl-certificate: require_admin (rank>=1).
  - PUT /api/system/appearance: require_super_admin (rank>=2) -- MAIS
    restrito que os outros cadastros de Sistema, porque afeta a aparencia
    vista por TODO MUNDO, inclusive antes do login.
  - GET/PUT /api/global-settings e GET/PUT /api/user-data: require_user
    (qualquer usuario autenticado, nao precisa ser admin).

GET /api/system/oauth reaproveita app/oauth.py (google_config/
microsoft_config, ja recarregados com prioridade banco>ambiente desde a
fatia 3) para os campos clientId/redirectUri/clientSecretSet/configured --
so 'source'/'updatedAt'/'updatedBy' exigem uma consulta direta a
oauth_settings aqui, e reload_oauth_config() e chamado depois de todo
PUT/DELETE pra manter esse estado em sincronia (mesma ordem do Node).
client_secret NUNCA e devolvido em texto puro -- so um booleano
'clientSecretSet' (mesmo principio de "nao reexibir segredo" das API keys).
"""
import base64
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from .. import oauth, tls
from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, require_admin, require_super_admin, require_user
from ..image_dimensions import get_image_dimensions

router = APIRouter(tags=["system"])

GLOBAL_SETTINGS_USER = "__global_defaults__"


async def _read_user_data(pool, username: str) -> dict:
    rows = await pool.fetch("SELECT data_key, value FROM user_data WHERE username = $1", username)
    return {r["data_key"]: r["value"] for r in rows}


async def _write_user_data(pool, username: str, body: dict) -> None:
    for key, val in body.items():
        if val is None:
            continue
        await pool.execute(
            """INSERT INTO user_data (username, data_key, value, updated_at) VALUES ($1, $2, $3, NOW())
               ON CONFLICT (username, data_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at""",
            username, key, str(val),
        )


async def _read_global_setting(pool, key: str, fallback: str) -> str:
    val = await pool.fetchval("SELECT value FROM user_data WHERE username = $1 AND data_key = $2", GLOBAL_SETTINGS_USER, key)
    return val if val is not None else fallback


async def _write_global_setting(pool, key: str, value: str) -> None:
    await pool.execute(
        """INSERT INTO user_data (username, data_key, value, updated_at) VALUES ($1, $2, $3, NOW())
           ON CONFLICT (username, data_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at""",
        GLOBAL_SETTINGS_USER, key, str(value),
    )


# ════════════════════════════════════════════════
# user-data (require_user) / global-settings (require_user) -- key/value
# generico, upsert PARCIAL (chaves com valor null/undefined sao ignoradas,
# nao apagam a chave existente). Body precisa ser um objeto JSON simples
# (nao array) -- checagem manual porque o contrato de erro do Node
# ("Request body must be a JSON object of {key: value}") nao bate com o
# 422 padrao do FastAPI pra um tipo errado.
# ════════════════════════════════════════════════
@router.get("/api/user-data")
async def get_user_data(user: CurrentUser = Depends(require_user)) -> dict:
    pool = get_pool()
    return await _read_user_data(pool, user["username"])


@router.put("/api/user-data", status_code=204)
async def update_user_data(body: Any = Body(default_factory=dict), user: CurrentUser = Depends(require_user)) -> None:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "Request body must be a JSON object of {key: value}"})
    pool = get_pool()
    await _write_user_data(pool, user["username"], body)


@router.get("/api/global-settings")
async def get_global_settings(user: CurrentUser = Depends(require_user)) -> dict:
    pool = get_pool()
    return await _read_user_data(pool, GLOBAL_SETTINGS_USER)


@router.put("/api/global-settings", status_code=204)
async def update_global_settings(body: Any = Body(default_factory=dict), user: CurrentUser = Depends(require_user)) -> None:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "Request body must be a JSON object of {key: value}"})
    pool = get_pool()
    await _write_user_data(pool, GLOBAL_SETTINGS_USER, body)


# ════════════════════════════════════════════════
# Logo customizavel -- GET publico (login.html precisa dele sem sessao),
# PUT/DELETE require_admin. Duas variantes independentes (light/dark, ver
# schema.sql system_logo) -- cada uma com seu proprio Save/Reset.
# ════════════════════════════════════════════════
LOGO_ALLOWED_MIME = {"image/png", "image/jpeg", "image/webp"}
LOGO_MAX_BYTES = 2 * 1024 * 1024
LOGO_MAX_DIMENSION = 4096
LOGO_THEMES = {"light", "dark"}


@router.get("/api/system/logo")
async def get_logo() -> dict:
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT image_data, mime_type, updated_at, updated_by, image_data_dark, mime_type_dark, updated_at_dark, updated_by_dark FROM system_logo WHERE id = 1"
    )
    if not row:
        return {
            "imageData": None, "mimeType": None, "updatedAt": None, "updatedBy": None,
            "imageDataDark": None, "mimeTypeDark": None, "updatedAtDark": None, "updatedByDark": None,
        }
    return {
        "imageData": row["image_data"], "mimeType": row["mime_type"], "updatedAt": row["updated_at"], "updatedBy": row["updated_by"],
        "imageDataDark": row["image_data_dark"], "mimeTypeDark": row["mime_type_dark"], "updatedAtDark": row["updated_at_dark"], "updatedByDark": row["updated_by_dark"],
    }


@router.put("/api/system/logo")
async def update_logo(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)) -> dict:
    image_data = body.get("imageData")
    theme = body.get("theme")
    resolved_theme = theme if theme in LOGO_THEMES else "light"
    if not isinstance(image_data, str) or not image_data.startswith("data:image/"):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "An image file is required."})
    match = re.match(r"^data:([^;]+);base64,(.+)$", image_data, re.DOTALL)
    if not match or match.group(1) not in LOGO_ALLOWED_MIME:
        raise HTTPException(status_code=400, detail={"error": "invalid_format", "message": "Unsupported image format — use PNG, JPEG or WEBP."})
    mime_type = match.group(1)
    try:
        decoded_buf = base64.b64decode(match.group(2))
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail={"error": "invalid_format", "message": "Could not decode the uploaded image."})
    decoded_size = len(decoded_buf)
    if decoded_size > LOGO_MAX_BYTES:
        raise HTTPException(status_code=400, detail={"error": "too_large", "message": f"Image is too large (max {LOGO_MAX_BYTES // (1024 * 1024)}MB)."})
    dims = get_image_dimensions(decoded_buf, mime_type)
    if dims and (dims["width"] > LOGO_MAX_DIMENSION or dims["height"] > LOGO_MAX_DIMENSION):
        raise HTTPException(status_code=400, detail={
            "error": "too_large",
            "message": f"Image dimensions are too large ({dims['width']}×{dims['height']}px, max {LOGO_MAX_DIMENSION}×{LOGO_MAX_DIMENSION}px).",
        })
    pool = get_pool()
    if resolved_theme == "dark":
        cols = ("image_data_dark", "mime_type_dark", "updated_at_dark", "updated_by_dark")
    else:
        cols = ("image_data", "mime_type", "updated_at", "updated_by")
    await pool.execute(
        f"""INSERT INTO system_logo (id, {cols[0]}, {cols[1]}, {cols[2]}, {cols[3]})
            VALUES (1, $1, $2, NOW(), $3)
            ON CONFLICT (id) DO UPDATE SET {cols[0]} = $1, {cols[1]} = $2, {cols[2]} = NOW(), {cols[3]} = $3""",
        image_data, mime_type, user["username"],
    )
    await log_audit(
        user["username"], "update", "system_logo", None, "Logo",
        f"{'Dark' if resolved_theme == 'dark' else 'Light'} theme logo updated ({mime_type}, {round(decoded_size / 1024)}KB)",
    )
    return {"imageData": image_data, "mimeType": mime_type, "theme": resolved_theme}


@router.delete("/api/system/logo")
async def delete_logo(theme: Optional[str] = Query(default=None), user: CurrentUser = Depends(require_admin)) -> dict:
    resolved_theme = theme if theme in LOGO_THEMES else None
    pool = get_pool()
    if resolved_theme == "dark":
        await pool.execute("UPDATE system_logo SET image_data_dark = NULL, mime_type_dark = NULL, updated_at_dark = NULL, updated_by_dark = NULL WHERE id = 1")
    elif resolved_theme == "light":
        await pool.execute("UPDATE system_logo SET image_data = NULL, mime_type = NULL, updated_at = NULL, updated_by = NULL WHERE id = 1")
    else:
        await pool.execute("DELETE FROM system_logo WHERE id = 1")
    # Linha vazia dos dois lados nao serve mais pra nada -- so limpeza, GET
    # ja trata "sem linha" e "linha com tudo NULL" da mesma forma.
    await pool.execute("DELETE FROM system_logo WHERE id = 1 AND image_data IS NULL AND image_data_dark IS NULL")
    note = (
        f"Removed the {resolved_theme} theme logo — reverted to the default Toolbox45 logo"
        if resolved_theme else
        "Removed custom logo — reverted to the default Toolbox45 logo (both themes)"
    )
    await log_audit(user["username"], "delete", "system_logo", None, "Logo", note)
    return {"imageData": None, "theme": resolved_theme}


# ════════════════════════════════════════════════
# Tema/cor de destaque PADRAO -- GET publico (mesmo motivo do logo), PUT
# require_super_admin (rank>=2, mais restrito que o resto de Sistema
# porque afeta a aparencia vista por TODO MUNDO, inclusive antes do login).
# ════════════════════════════════════════════════
APPEARANCE_THEME_KEY = "appearanceTheme"
APPEARANCE_ACCENT_KEY = "appearanceAccent"
APPEARANCE_THEMES = {"light", "dark"}
# Lista (nao set) porque a ORDEM entra na mensagem de erro 400 -- precisa
# bater com [...APPEARANCE_ACCENTS] do Node (ordem de insercao).
APPEARANCE_ACCENTS_ORDER = ["teal", "pink", "blue", "green", "purple", "orange", "red", "white"]
APPEARANCE_ACCENTS = set(APPEARANCE_ACCENTS_ORDER)


@router.get("/api/system/appearance")
async def get_appearance() -> dict:
    pool = get_pool()
    theme = await _read_global_setting(pool, APPEARANCE_THEME_KEY, "light")
    accent_color = await _read_global_setting(pool, APPEARANCE_ACCENT_KEY, "teal")
    return {"theme": theme, "accentColor": accent_color}


@router.put("/api/system/appearance")
async def update_appearance(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_super_admin)) -> dict:
    theme = body.get("theme")
    accent_color = body.get("accentColor")
    if theme not in APPEARANCE_THEMES:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"theme" must be "light" or "dark".'})
    if accent_color not in APPEARANCE_ACCENTS:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": f'"accentColor" must be one of: {", ".join(APPEARANCE_ACCENTS_ORDER)}.'})
    if theme == "light" and accent_color == "white":
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": 'The "white" accent only has contrast on the dark theme — pick another color for the light theme default.'})
    pool = get_pool()
    await _write_global_setting(pool, APPEARANCE_THEME_KEY, theme)
    await _write_global_setting(pool, APPEARANCE_ACCENT_KEY, accent_color)
    await log_audit(user["username"], "update", "appearance", None, "Default theme & colors", f'Default theme set to "{theme}", default accent color set to "{accent_color}"')
    return {"theme": theme, "accentColor": accent_color}


# ════════════════════════════════════════════════
# CRUD de configuracao OAuth (Google/Microsoft) -- require_admin nas 3
# rotas. GET reaproveita app/oauth.py (ja recarregado com prioridade
# banco>ambiente); PUT/DELETE gravam oauth_settings e chamam
# reload_oauth_config() antes de responder, pra tudo ficar em sincronia
# (mesma ordem do Node).
# ════════════════════════════════════════════════
OAUTH_PROVIDERS = {"google", "microsoft"}


@router.get("/api/system/oauth")
async def get_oauth_settings(user: CurrentUser = Depends(require_admin)) -> dict:
    pool = get_pool()
    rows = await pool.fetch("SELECT * FROM oauth_settings")
    by_provider = {r["provider"]: r for r in rows}

    def build(provider: str, cfg) -> dict:
        db_row = by_provider.get(provider)
        source = "db" if db_row else ("env" if cfg.enabled else "none")
        extra = {"tenantId": cfg.tenant_id} if provider == "microsoft" else {}
        return {
            "configured": cfg.enabled,
            "source": source,
            "clientId": cfg.client_id,
            "clientSecretSet": bool(cfg.client_secret),
            "redirectUri": cfg.redirect_uri,
            "updatedAt": db_row["updated_at"] if db_row else None,
            "updatedBy": db_row["updated_by"] if db_row else None,
            **extra,
        }

    return {"google": build("google", oauth.google_config), "microsoft": build("microsoft", oauth.microsoft_config)}


@router.put("/api/system/oauth/{provider}")
async def update_oauth_settings(provider: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)) -> dict:
    if provider not in OAUTH_PROVIDERS:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": "Unknown provider."})

    client_id = body.get("clientId")
    client_secret = body.get("clientSecret")
    redirect_uri = body.get("redirectUri")
    tenant_id = body.get("tenantId")
    trimmed_client_id = client_id.strip() if isinstance(client_id, str) else ""
    trimmed_redirect_uri = redirect_uri.strip() if isinstance(redirect_uri, str) else ""
    trimmed_client_secret = client_secret.strip() if isinstance(client_secret, str) else ""
    trimmed_tenant_id = tenant_id.strip() if isinstance(tenant_id, str) else ""

    if not trimmed_client_id or not trimmed_redirect_uri:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "Client ID and Redirect URI are required."})
    if not re.match(r"^https://", trimmed_redirect_uri, re.IGNORECASE):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "Redirect URI must start with https://."})

    pool = get_pool()
    existing_secret = await pool.fetchval("SELECT client_secret FROM oauth_settings WHERE provider = $1", provider)
    # Client secret so e obrigatorio na PRIMEIRA vez que este provedor e
    # salvo -- deixar o campo em branco numa edicao posterior mantem o
    # secret ja salvo (mesmo principio de "nao reexibir segredo depois de
    # salvo" das API keys).
    final_secret = trimmed_client_secret or existing_secret
    if not final_secret:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "Client Secret is required."})

    await pool.execute(
        """INSERT INTO oauth_settings (provider, client_id, client_secret, redirect_uri, tenant_id, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, NOW(), $6)
           ON CONFLICT (provider) DO UPDATE SET
             client_id = EXCLUDED.client_id,
             client_secret = EXCLUDED.client_secret,
             redirect_uri = EXCLUDED.redirect_uri,
             tenant_id = EXCLUDED.tenant_id,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by""",
        provider, trimmed_client_id, final_secret, trimmed_redirect_uri,
        (trimmed_tenant_id or "common") if provider == "microsoft" else None,
        user["username"],
    )
    await oauth.reload_oauth_config()
    provider_label = "Google" if provider == "google" else "Microsoft"
    await log_audit(user["username"], "update", "oauth_settings", provider, provider_label, f"{provider_label} sign-in configured via Settings → System → OAuth Integrations")
    return {"ok": True}


@router.delete("/api/system/oauth/{provider}")
async def delete_oauth_settings(provider: str, user: CurrentUser = Depends(require_admin)) -> dict:
    if provider not in OAUTH_PROVIDERS:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": "Unknown provider."})
    pool = get_pool()
    await pool.execute("DELETE FROM oauth_settings WHERE provider = $1", provider)
    await oauth.reload_oauth_config()
    provider_label = "Google" if provider == "google" else "Microsoft"
    cfg = oauth.google_config if provider == "google" else oauth.microsoft_config
    new_source = "env" if cfg.enabled else "none"
    revert_note = (
        " (reverted to server environment variables)" if new_source == "env"
        else " (sign-in now disabled — no environment variables configured either)"
    )
    await log_audit(user["username"], "delete", "oauth_settings", provider, provider_label, f"{provider_label} sign-in configuration removed via Settings → System → OAuth Integrations{revert_note}")
    return {"ok": True}


# ════════════════════════════════════════════════
# Certificado SSL/TLS customizavel -- require_admin nas 3 rotas. Geracao do
# autoassinado default (ensure_tls_bootstrap) roda no BOOT do processo, ver
# app/main.py (lifespan) e app/tls.py.
# ════════════════════════════════════════════════
@router.get("/api/system/ssl-certificate")
async def get_ssl_certificate(user: CurrentUser = Depends(require_admin)) -> dict:
    return tls.read_cert_info()


@router.post("/api/system/ssl-certificate", status_code=200)
async def import_ssl_certificate(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)) -> dict:
    cert = body.get("cert")
    key = body.get("key")
    chain = body.get("chain")
    if not cert or not key or not isinstance(cert, str) or not isinstance(key, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"cert" and "key" (PEM text) are required'})

    try:
        x509_cert = tls.parse_cert(cert)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail={"error": "invalid_cert", "message": "Could not parse the certificate — make sure it is a valid PEM-encoded X.509 certificate."})
    try:
        tls.parse_private_key(key)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail={"error": "invalid_key", "message": "Could not parse the private key — make sure it is a valid, UNENCRYPTED PEM-encoded private key (no passphrase)."})

    try:
        matches = tls.cert_key_match(cert, key)
    except Exception:  # noqa: BLE001
        matches = False
    if not matches:
        raise HTTPException(status_code=400, detail={"error": "mismatch", "message": "This certificate and private key do not match each other."})

    not_after = x509_cert.not_valid_after_utc
    if not_after < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail={"error": "expired", "message": f"This certificate already expired on {tls.format_validity_date(not_after)}."})

    tls.backup_current_tls_files()
    tls.TLS_DIR.mkdir(parents=True, exist_ok=True)
    full_chain = f"{cert.strip()}\n{chain.strip()}\n" if isinstance(chain, str) and chain.strip() else f"{cert.strip()}\n"
    tls.TLS_CERT_PATH.write_text(full_chain)
    tls.TLS_CERT_PATH.chmod(0o644)
    tls.TLS_KEY_PATH.write_text(key.strip() + "\n")
    tls.TLS_KEY_PATH.chmod(0o600)
    await log_audit(user["username"], "import", "ssl_certificate", None, tls.format_name(x509_cert.subject), f"Imported SSL certificate, valid until {tls.format_validity_date(not_after)}")
    return tls.read_cert_info()


@router.delete("/api/system/ssl-certificate", status_code=200)
async def reset_ssl_certificate(user: CurrentUser = Depends(require_admin)) -> dict:
    tls.backup_current_tls_files()
    await tls.generate_self_signed_cert()
    await log_audit(user["username"], "delete", "ssl_certificate", None, None, "Removed custom SSL certificate — reverted to a self-signed default")
    return tls.read_cert_info()
