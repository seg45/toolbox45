"""GET/POST/PUT/DELETE /api/groups* -- porta 1:1 de server/index.js
(~linhas 1531-1636). Grupos sao simetricos e tudo-ou-nada (sem toggles
separados de folders/commands como em shares -- ver app/routers/shares.py),
membership N:N via group_members (chave composta group_id+username). TODAS
as 6 rotas exigem super_admin (diferente de links/shares, que sao
self-service para qualquer usuario logado).
"""
from fastapi import APIRouter, Body, Depends, HTTPException

from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, require_super_admin

router = APIRouter(prefix="/api/groups", tags=["groups"])


@router.get("")
async def list_groups(user: CurrentUser = Depends(require_super_admin)):
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT g.id, g.name, g.created_at, g.created_by,
                  COALESCE(array_agg(gm.username ORDER BY gm.username) FILTER (WHERE gm.username IS NOT NULL), '{}') AS members
           FROM groups g
           LEFT JOIN group_members gm ON gm.group_id = g.id
           GROUP BY g.id
           ORDER BY g.name"""
    )
    return [dict(r) for r in rows]


@router.post("", status_code=201)
async def create_group(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_super_admin)):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"name" is required'})
    pool = get_pool()
    existing = await pool.fetchrow("SELECT id FROM groups WHERE name = $1", name)
    if existing:
        raise HTTPException(status_code=409, detail={"error": "conflict", "message": f'A group named "{name}" already exists'})
    username = user["username"]
    row = await pool.fetchrow(
        "INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id, name, created_at, created_by",
        name, username,
    )
    await log_audit(username, "create", "group", str(row["id"]), name)
    result = dict(row)
    result["members"] = []
    return result


@router.put("/{group_id}")
async def rename_group(group_id: int, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_super_admin)):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"name" is required'})
    pool = get_pool()
    found = await pool.fetchrow("SELECT id, name FROM groups WHERE id = $1", group_id)
    if not found:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Group '{group_id}' not found"})
    dup = await pool.fetchrow("SELECT id FROM groups WHERE name = $1 AND id <> $2", name, group_id)
    if dup:
        raise HTTPException(status_code=409, detail={"error": "conflict", "message": f'A group named "{name}" already exists'})
    await pool.execute("UPDATE groups SET name = $1 WHERE id = $2", name, group_id)
    username = user["username"]
    if found["name"] != name:
        await log_audit(username, "update", "group", str(group_id), name, f'Renamed from "{found["name"]}"')
    return {"id": group_id, "name": name}


@router.delete("/{group_id}", status_code=204)
async def delete_group(group_id: int, user: CurrentUser = Depends(require_super_admin)):
    pool = get_pool()
    found = await pool.fetchrow("SELECT id, name FROM groups WHERE id = $1", group_id)
    if not found:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Group '{group_id}' not found"})
    await pool.execute("DELETE FROM groups WHERE id = $1", group_id)  # cascata em group_members
    await log_audit(user["username"], "delete", "group", str(group_id), found["name"])


@router.post("/{group_id}/members", status_code=201)
async def add_group_member(group_id: int, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_super_admin)):
    member_username = str(body.get("username") or "").strip()
    if not member_username:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"username" is required'})
    pool = get_pool()
    found = await pool.fetchrow("SELECT id, name FROM groups WHERE id = $1", group_id)
    if not found:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Group '{group_id}' not found"})
    user_row = await pool.fetchrow("SELECT username FROM users WHERE username = $1", member_username)
    if not user_row:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"User '{member_username}' not found"})
    await pool.execute(
        "INSERT INTO group_members (group_id, username) VALUES ($1, $2) ON CONFLICT (group_id, username) DO NOTHING",
        group_id, member_username,
    )
    await log_audit(user["username"], "update", "group", str(group_id), found["name"], f"Added member: {member_username}")
    members = await pool.fetch("SELECT username FROM group_members WHERE group_id = $1 ORDER BY username", group_id)
    return {"members": [m["username"] for m in members]}


@router.delete("/{group_id}/members/{target_username}", status_code=204)
async def remove_group_member(group_id: int, target_username: str, user: CurrentUser = Depends(require_super_admin)):
    pool = get_pool()
    found = await pool.fetchrow("SELECT id, name FROM groups WHERE id = $1", group_id)
    if not found:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Group '{group_id}' not found"})
    await pool.execute("DELETE FROM group_members WHERE group_id = $1 AND username = $2", group_id, target_username)
    await log_audit(user["username"], "update", "group", str(group_id), found["name"], f"Removed member: {target_username}")
