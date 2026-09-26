"""GET/POST/DELETE /api/shares -- porta 1:1 de server/index.js (~linhas
1441-1512). Compartilhamento direcional (grantor -> grantee) identificado
por *handle* (nao username), com dois toggles independentes
(share_folders/share_commands) e UPSERT via ON CONFLICT -- sem fluxo de
aceite (o grantee nunca precisa confirmar).
"""
import asyncio

from fastapi import APIRouter, Body, Depends, HTTPException

from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, require_user
from ..handles import normalize_handle

router = APIRouter(prefix="/api/shares", tags=["shares"])


@router.get("")
async def list_shares(user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    given, received = await asyncio.gather(
        pool.fetch(
            """SELECT s.id, s.share_folders, s.share_commands, s.created_at, s.updated_at, u.handle AS grantee_handle
               FROM shares s JOIN users u ON u.username = s.grantee_username
               WHERE s.grantor_username = $1 ORDER BY u.handle""",
            username,
        ),
        pool.fetch(
            """SELECT s.id, s.share_folders, s.share_commands, s.created_at, s.updated_at, u.handle AS grantor_handle
               FROM shares s JOIN users u ON u.username = s.grantor_username
               WHERE s.grantee_username = $1 ORDER BY u.handle""",
            username,
        ),
    )
    return {"given": [dict(r) for r in given], "received": [dict(r) for r in received]}


@router.post("", status_code=201)
async def create_share(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    username = user["username"]
    handle = normalize_handle(body.get("handle"))
    share_folders = bool(body.get("share_folders"))
    share_commands = bool(body.get("share_commands"))
    if not handle:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"handle" is required'})
    if not share_folders and not share_commands:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": "Enable at least one of folders/commands to share"},
        )

    pool = get_pool()
    target = await pool.fetchrow("SELECT username, handle FROM users WHERE handle = $1", handle)
    if not target:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f'No user found with handle "{handle}"'})
    if target["username"] == username:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "You cannot share with yourself"})

    row = await pool.fetchrow(
        """INSERT INTO shares (grantor_username, grantee_username, share_folders, share_commands)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (grantor_username, grantee_username)
           DO UPDATE SET share_folders = $3, share_commands = $4, updated_at = NOW()
           RETURNING id, share_folders, share_commands, created_at, updated_at""",
        username, target["username"], share_folders, share_commands,
    )
    await log_audit(
        username, "update", "share", str(row["id"]), target["handle"],
        f"Folders: {'on' if share_folders else 'off'}, Commands: {'on' if share_commands else 'off'}",
    )
    result = dict(row)
    result["grantee_handle"] = target["handle"]
    return result


@router.delete("/{share_id}", status_code=204)
async def delete_share(share_id: int, user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    before = await pool.fetchrow(
        """SELECT s.id, u.handle FROM shares s JOIN users u ON u.username = s.grantee_username
           WHERE s.id = $1 AND s.grantor_username = $2""",
        share_id, username,
    )
    if not before:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Share '{share_id}' not found"})
    await pool.execute("DELETE FROM shares WHERE id = $1 AND grantor_username = $2", share_id, username)
    await log_audit(username, "delete", "share", str(share_id), before["handle"])
