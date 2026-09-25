"""PUT/DELETE/POST /api/notes/:id* -- porta 1:1 de server/index.js
(~linhas 2636-2760). Criacao de nota (POST /api/folders/:id/notes) fica em
app/routers/folders.py -- essas quatro aqui operam num ID de nota ja
existente.
"""
import asyncio

from fastapi import APIRouter, Body, Depends, HTTPException

from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, require_user
from ..folders import get_root_ancestor_id, parse_required_int
from ..sanitize import sanitize_note_html

router = APIRouter(prefix="/api/notes", tags=["notes"])


@router.put("/{note_id}")
async def update_note(note_id: int, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    username = user["username"]
    title = str(body.get("title") or "").strip()
    description = sanitize_note_html(body.get("description") or "")
    pool = get_pool()
    row = await pool.fetchrow(
        """UPDATE notes SET title = $1, description = $2, updated_at = NOW()
           WHERE id = $3 AND username = $4
           RETURNING id, folder_id, title, description, sort_order, created_at, updated_at""",
        title, description, note_id, username,
    )
    if not row:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Note '{note_id}' not found"})
    await log_audit(username, "update", "note", row["id"], title or "(untitled)")
    return dict(row)


@router.put("/{note_id}/move")
async def move_note(note_id: int, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    username = user["username"]
    new_folder_id = parse_required_int(body.get("folder_id"))
    if new_folder_id is None:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"folder_id" must be an integer'})

    pool = get_pool()
    note = await pool.fetchrow("SELECT id, folder_id, username FROM notes WHERE id = $1", note_id)
    if not note or note["username"] != username:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Note '{note_id}' not found"})
    new_folder = await pool.fetchrow("SELECT id, username FROM folders WHERE id = $1", new_folder_id)
    if not new_folder or new_folder["username"] != username:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{new_folder_id}' not found"})

    old_root, new_root = await asyncio.gather(
        get_root_ancestor_id(note["folder_id"]),
        get_root_ancestor_id(new_folder_id),
    )
    if old_root != new_root:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": "Cannot move a note outside of its top-level parent folder"},
        )

    max_row = await pool.fetchrow(
        """SELECT COALESCE(MAX(sort_order), -1) AS m FROM (
             SELECT sort_order FROM folder_commands WHERE folder_id = $1
             UNION ALL
             SELECT sort_order FROM notes WHERE folder_id = $1
             UNION ALL
             SELECT sort_order FROM folders WHERE parent_id = $1
           ) combined""",
        new_folder_id,
    )
    row = await pool.fetchrow(
        """UPDATE notes SET folder_id = $1, sort_order = $2, updated_at = NOW()
           WHERE id = $3 AND username = $4
           RETURNING id, folder_id, title, description, sort_order, created_at, updated_at""",
        new_folder_id, max_row["m"] + 1, note_id, username,
    )
    await log_audit(username, "update", "note", row["id"], row["title"] or "(untitled)", f"Moved into folder #{new_folder_id}")
    return dict(row)


@router.delete("/{note_id}", status_code=204)
async def delete_note(note_id: int, user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    before = await pool.fetchrow("SELECT title FROM notes WHERE id = $1 AND username = $2", note_id, username)
    result = await pool.execute("DELETE FROM notes WHERE id = $1 AND username = $2", note_id, username)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Note '{note_id}' not found"})
    await log_audit(username, "delete", "note", note_id, (before["title"] if before else None) or "(untitled)")


@router.post("/{note_id}/clone", status_code=201)
async def clone_note(note_id: int, user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    src = await pool.fetchrow("SELECT folder_id, title, description FROM notes WHERE id = $1 AND username = $2", note_id, username)
    if not src:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Note '{note_id}' not found"})
    folder_id = src["folder_id"]
    title = src["title"]
    description = src["description"]
    row = await pool.fetchrow(
        """INSERT INTO notes (folder_id, username, title, description, sort_order)
           VALUES ($1, $2, $3, $4, (
             SELECT COALESCE(GREATEST(
               (SELECT MAX(sort_order) FROM folder_commands WHERE folder_id = $1),
               (SELECT MAX(sort_order) FROM notes WHERE folder_id = $1)
             ), -1) + 1
           ))
           RETURNING id, folder_id, title, description, sort_order, created_at, updated_at""",
        folder_id, username, f"{title} (copy)", description,
    )
    await log_audit(username, "create", "note", row["id"], row["title"] or "(untitled)", f'Cloned from note "{title or "(untitled)"}"')
    return dict(row)
