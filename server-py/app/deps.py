"""Autenticacao/autorizacao compartilhada por toda rota protegida -- porta
de getCurrentRole()/roleRank()/requireAdmin()/requireSuperAdmin() e do
middleware de API key em server/index.js (linhas 66-108, 317-367).

Prioridade de identificacao (igual ao Node): 1) header X-API-Key; 2) sessao
via cookie tb45_session (ver app/session.py). Sem nenhuma das duas, 401 --
nao ha "usuario convidado" implicito.

Diferenca deliberada em relacao ao Node: la, o middleware de API key roda
em TODA requisicao, inclusive nas rotas publicas (health, login, providers,
oauth) -- um X-API-Key invalido enviado por engano a uma dessas rotas
tambem levaria a um 401 no Node. Aqui a checagem de API key so roda nas
rotas que dependem de require_user/require_admin/require_super_admin (as
novas desta fatia 4 em diante); as rotas publicas ja existentes (fatias 2 e
3) nunca leem X-API-Key. Na pratica isso so muda o comportamento de um
cliente que manda um X-API-Key invalido pra uma rota publica por engano --
considerado um gap aceitavel, registrado aqui em vez de re-tocar rotas ja
validadas em producao so por isso.
"""
import hashlib
import secrets
from typing import Any, Optional, TypedDict

from fastapi import Depends, HTTPException, Request

from .db import get_pool
from .session import get_current_session

ROLE_RANK = {"user": 0, "admin": 1, "super_admin": 2}


def role_rank(role: Optional[str]) -> int:
    return ROLE_RANK.get(role, 0)


class CurrentUser(TypedDict):
    username: str
    role: str
    auth_method: str  # 'local' | 'google' | 'microsoft' | 'api_key'
    api_key: Optional[dict]


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def generate_api_key() -> str:
    # Prefixo "tb45_" so facilita reconhecer o tipo de segredo em logs/
    # scanners -- o que importa e o restante, aleatorio (32 bytes).
    return "tb45_" + secrets.token_hex(32)


async def authenticate_api_key(raw_key: str) -> Optional[dict]:
    pool = get_pool()
    row = await pool.fetchrow(
        """SELECT * FROM api_keys
           WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())""",
        hash_api_key(raw_key),
    )
    if not row:
        return None
    # Best-effort, igual ao Node -- nunca bloqueia a resposta por causa disso.
    try:
        await pool.execute("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", row["id"])
    except Exception:  # noqa: BLE001
        pass
    return dict(row)


async def get_optional_user(request: Request) -> Optional[CurrentUser]:
    provided = request.headers.get("x-api-key")
    if provided:
        key_row = await authenticate_api_key(provided)
        if not key_row:
            raise HTTPException(
                status_code=401,
                detail={"error": "invalid_api_key", "message": "Invalid, revoked, or expired API key"},
            )
        # API keys nunca sao 'super_admin' (nao existe essa opcao na
        # criacao) -- so 'admin' (default, inclusive pra keys antigas de
        # antes deste campo existir) ou 'user'.
        return {
            "username": f"api:{key_row['name']}",
            "role": key_row.get("role") or "admin",
            "auth_method": "api_key",
            "api_key": key_row,
        }

    session = await get_current_session(request)
    if session:
        return {
            "username": session["username"],
            "role": session["role"],
            "auth_method": session["auth_provider"],
            "api_key": None,
        }
    return None


async def require_user(request: Request) -> CurrentUser:
    user = await get_optional_user(request)
    if not user:
        raise HTTPException(status_code=401, detail={"error": "unauthorized", "message": "Login required"})
    return user


async def require_admin(user: CurrentUser = Depends(require_user)) -> CurrentUser:
    if role_rank(user["role"]) < 1:
        raise HTTPException(
            status_code=403,
            detail={"error": "forbidden", "message": "Admin role required for this action"},
        )
    return user


async def require_super_admin(user: CurrentUser = Depends(require_user)) -> CurrentUser:
    if role_rank(user["role"]) < 2:
        raise HTTPException(
            status_code=403,
            detail={"error": "forbidden", "message": "Super Admin role required for this action"},
        )
    return user
