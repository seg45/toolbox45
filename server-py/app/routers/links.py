"""GET/POST/PUT/DELETE /api/links -- porta 1:1 de server/index.js (~linhas
1638-1732). Links pessoais (favoritos de URL), escopo estritamente privado
por username (sem admin bypass, ao contrario de comandos/pastas).
"""
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Body, Depends, HTTPException

from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, require_user

router = APIRouter(prefix="/api/links", tags=["links"])


def _normalize_link_url(raw: Any) -> Optional[str]:
    """Porta aproximada de normalizeLinkUrl() do Node: prefixa "https://" se
    faltar esquema, valida com um parser de URL. Divergencia deliberada: o
    `new URL()` do JS faz uma validacao RFC mais estrita que o
    `urlsplit()` do Python (que e bem permissivo); aqui reforcamos so a
    checagem que mais importa na pratica -- exigir um host presente e
    rejeitar espacos em branco (que o `new URL()` tambem rejeita). Casos de
    borda bizarros podem divergir, mas a UI real sempre manda uma URL
    razoavel nesse campo.
    """
    url = str(raw or "").strip()
    if not url:
        return None
    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    if any(ch.isspace() for ch in url):
        return None
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    if not parsed.scheme or not parsed.netloc:
        return None
    return url


@router.get("")
async def list_links(user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    rows = await pool.fetch(
        "SELECT id, name, url, created_at FROM links WHERE username = $1 ORDER BY created_at ASC, id ASC", username
    )
    return [dict(r) for r in rows]


@router.post("", status_code=201)
async def create_link(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    username = user["username"]
    name = str(body.get("name") or "").strip()
    url = _normalize_link_url(body.get("url"))
    if not name:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"name" is required'})
    if not url:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "A valid URL is required"})
    pool = get_pool()
    row = await pool.fetchrow(
        "INSERT INTO links (username, name, url) VALUES ($1, $2, $3) RETURNING id, name, url, created_at",
        username, name, url,
    )
    await log_audit(username, "create", "link", str(row["id"]), name)
    return dict(row)


@router.put("/{link_id}")
async def update_link(link_id: int, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    found = await pool.fetchrow("SELECT id FROM links WHERE id = $1 AND username = $2", link_id, username)
    if not found:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Link '{link_id}' not found"})
    name = str(body.get("name") or "").strip()
    url = _normalize_link_url(body.get("url"))
    if not name:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"name" is required'})
    if not url:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "A valid URL is required"})
    row = await pool.fetchrow(
        "UPDATE links SET name = $1, url = $2 WHERE id = $3 RETURNING id, name, url, created_at",
        name, url, link_id,
    )
    await log_audit(username, "update", "link", str(link_id), name)
    return dict(row)


@router.delete("/{link_id}", status_code=204)
async def delete_link(link_id: int, user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    found = await pool.fetchrow("SELECT id, name FROM links WHERE id = $1 AND username = $2", link_id, username)
    if not found:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Link '{link_id}' not found"})
    await pool.execute("DELETE FROM links WHERE id = $1", link_id)
    await log_audit(username, "delete", "link", str(link_id), found["name"])
