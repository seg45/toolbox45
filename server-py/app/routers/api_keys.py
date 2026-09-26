"""API keys -- acesso programatico externo (Settings -> System -> API
access) -- porta 1:1 de server/index.js (GET/POST /api/api-keys, DELETE
/api/api-keys/:id), todas atras de require_admin (CONFERIDO diretamente no
server/index.js real). Reaproveita hash_api_key()/generate_api_key() de
app/deps.py (ja usados desde a fatia 4 pra autenticacao via X-API-Key) --
SHA-256 hex sem salt, confirmado byte-a-byte identico ao Node nesta fatia.

A key em texto puro (`key`) so aparece na resposta do POST -- GET nunca
inclui `key_hash` nem a key crua (projecao de colunas explicita, mesmo
principio de USERS_PUBLIC_COLUMNS na fatia 7). DELETE e exclusao FISICA
permanente (`revoked_at` e legado, mantido so pra nao quebrar linhas
antigas -- nenhum codigo atual grava nele numa exclusao nova).
"""
import calendar
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, generate_api_key, hash_api_key, require_admin

router = APIRouter(tags=["api-keys"])

# Mesmo modelo de permissoes (admin|user) dos usuarios locais/Google.
# Padrao 'user' (menor privilegio) quando o campo nao e enviado.
API_KEY_ROLES = ("admin", "user")

# Validade escolhida na criacao, convertida pra uma data absoluta em
# expires_at. 'never' => None (nunca expira).
API_KEY_VALIDITIES = ("1d", "1w", "1m", "1y", "never")


def _add_months(dt: datetime, months: int) -> datetime:
    # Aritmetica de calendario (mesmo espirito do setMonth/setFullYear do
    # Node) -- "1 month"/"1 year" caem no mesmo dia do mes/ano seguinte
    # mesmo atravessando meses de tamanho diferente ou anos bissextos.
    total = dt.month - 1 + months
    year = dt.year + total // 12
    month = total % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _compute_expires_at(validity: str) -> Optional[datetime]:
    if validity == "never":
        return None
    now = datetime.now(timezone.utc)
    if validity == "1d":
        return now + timedelta(days=1)
    if validity == "1w":
        return now + timedelta(days=7)
    if validity == "1m":
        return _add_months(now, 1)
    if validity == "1y":
        return _add_months(now, 12)
    return None  # inalcancavel -- validity ja validado em create_api_key


@router.get("/api/api-keys")
async def list_api_keys(user: CurrentUser = Depends(require_admin)) -> list:
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT id, name, key_prefix, role, created_by, created_at, expires_at, last_used_at, revoked_at
           FROM api_keys ORDER BY (revoked_at IS NULL) DESC, created_at DESC"""
    )
    return [dict(r) for r in rows]


@router.post("/api/api-keys", status_code=201)
async def create_api_key(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)) -> dict:
    name = body.get("name")
    if not name or not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"name" is required'})

    final_role = body.get("role") or "user"
    if final_role not in API_KEY_ROLES:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": f'"role" must be one of: {", ".join(API_KEY_ROLES)}'})

    final_validity = body.get("validity") or "never"
    if final_validity not in API_KEY_VALIDITIES:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": f'"validity" must be one of: {", ".join(API_KEY_VALIDITIES)}'})

    expires_at = _compute_expires_at(final_validity)
    pool = get_pool()
    raw_key = generate_api_key()
    key_hash = hash_api_key(raw_key)
    key_prefix = raw_key[:12]
    created_by = user["username"]
    row = await pool.fetchrow(
        """INSERT INTO api_keys (name, key_prefix, key_hash, role, created_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, name, key_prefix, role, created_by, created_at, expires_at, last_used_at, revoked_at""",
        name.strip(), key_prefix, key_hash, final_role, created_by, expires_at,
    )
    # Nunca grava a key em si (raw_key) no audit_log -- so nome/role/validade.
    await log_audit(created_by, "create", "api_key", str(row["id"]), name.strip(), f"Role: {final_role}, validity: {final_validity}")
    return {**dict(row), "key": raw_key}


@router.delete("/api/api-keys/{id}", status_code=204)
async def delete_api_key(id: str, user: CurrentUser = Depends(require_admin)) -> None:
    try:
        key_id = int(id)
    except ValueError:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "Invalid id"})

    pool = get_pool()
    before = await pool.fetchrow("SELECT name FROM api_keys WHERE id = $1", key_id)
    deleted = await pool.fetchrow("DELETE FROM api_keys WHERE id = $1 RETURNING id", key_id)
    if not deleted:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"API key '{key_id}' not found"})
    await log_audit(user["username"], "delete", "api_key", str(key_id), before["name"] if before else None)
