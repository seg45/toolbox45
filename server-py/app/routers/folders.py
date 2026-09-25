"""GET/POST/PUT/DELETE /api/folders* -- porta 1:1 de server/index.js
(~linhas 1794-2620). Arvore de pastas do usuario (com subpastas,
drag-and-drop, copiar/exportar/importar) + POST /api/folders/:id/notes
(criacao de nota, as demais rotas de nota ficam em app/routers/notes.py).
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Body, HTTPException, Depends

from .. import commands as cmds
from ..audit import log_audit
from ..db import get_pool
from ..deps import CurrentUser, require_user, role_rank
from ..folders import (
    FAVORITES_FOLDER_NAME,
    build_folder_export_node,
    find_available_folder_name,
    folder_shares_allow,
    get_root_ancestor_id,
    import_folder_tree_node,
    load_folder_order_and_notes,
    parse_optional_parent_id,
    parse_required_int,
)
from ..sanitize import sanitize_note_html

router = APIRouter(prefix="/api/folders", tags=["folders"])


def _iso_now() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


@router.get("")
async def list_folders(user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT f.id, f.name, f.sort_order, f.parent_id,
                  COALESCE(array_agg(fc.command_id ORDER BY fc.sort_order, fc.created_at) FILTER (WHERE fc.command_id IS NOT NULL), '{}') AS command_ids
           FROM folders f
           LEFT JOIN folder_commands fc ON fc.folder_id = f.id
           WHERE f.username = $1
           GROUP BY f.id
           ORDER BY f.sort_order, f.name""",
        username,
    )
    order_by_folder, notes_by_folder = await load_folder_order_and_notes([r["id"] for r in rows])
    return [
        {
            "id": r["id"], "name": r["name"], "sort_order": r["sort_order"], "parent_id": r["parent_id"],
            "command_ids": r["command_ids"],
            "notes": notes_by_folder.get(r["id"], []),
            "order": order_by_folder.get(r["id"], []),
        }
        for r in rows
    ]


@router.get("/all")
async def list_all_folders(user: CurrentUser = Depends(require_user)):
    username = user["username"]
    is_admin = role_rank(user["role"]) >= 1
    pool = get_pool()

    if is_admin:
        rows = await pool.fetch(
            """SELECT f.id, f.username, f.name, f.sort_order, f.parent_id,
                      COALESCE(array_agg(fc.command_id ORDER BY fc.sort_order, fc.created_at) FILTER (WHERE fc.command_id IS NOT NULL), '{}') AS command_ids
               FROM folders f
               LEFT JOIN folder_commands fc ON fc.folder_id = f.id
               GROUP BY f.id
               ORDER BY f.username, f.sort_order, f.name"""
        )
    else:
        rows = await pool.fetch(
            """SELECT f.id, f.username, f.name, f.sort_order, f.parent_id,
                      COALESCE(array_agg(fc.command_id ORDER BY fc.sort_order, fc.created_at) FILTER (WHERE fc.command_id IS NOT NULL), '{}') AS command_ids
               FROM folders f
               LEFT JOIN folder_commands fc ON fc.folder_id = f.id
               WHERE f.username = $1 OR EXISTS (
                 SELECT 1 FROM shares sh WHERE sh.grantor_username = f.username AND sh.grantee_username = $1 AND sh.share_folders = true
               ) OR EXISTS (
                 SELECT 1 FROM group_members gm_me
                 JOIN group_members gm_owner ON gm_owner.group_id = gm_me.group_id
                 WHERE gm_me.username = $1 AND gm_owner.username = f.username
               )
               GROUP BY f.id
               ORDER BY f.username, f.sort_order, f.name""",
            username,
        )

    folder_ids = [r["id"] for r in rows]
    order_by_folder, notes_by_folder = await load_folder_order_and_notes(folder_ids)
    handle_map = None if is_admin else await cmds.get_handle_map()
    viewer_ctx = {"username": username, "is_admin": is_admin, "handle_map": handle_map}
    return [
        {
            "id": r["id"], "username": cmds.mask_username_for_viewer(r["username"], viewer_ctx),
            "name": r["name"], "sort_order": r["sort_order"], "parent_id": r["parent_id"],
            "command_ids": r["command_ids"],
            "notes": notes_by_folder.get(r["id"], []),
            "order": order_by_folder.get(r["id"], []),
        }
        for r in rows
    ]


@router.post("", status_code=201)
async def create_folder(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"name" is required'})

    parent_id, parent_ok = parse_optional_parent_id(body.get("parent_id"))
    if not parent_ok:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"parent_id" must be an integer'})

    username = user["username"]
    pool = get_pool()
    sort_order = 0
    if parent_id is not None:
        parent = await pool.fetchrow("SELECT id FROM folders WHERE id = $1 AND username = $2", parent_id, username)
        if not parent:
            raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Parent folder '{parent_id}' not found"})
        # Nova subpasta entra no TOPO da lista combinada de itens da
        # pasta-mae (comandos + notas + subpastas, MESMA escala de
        # sort_order) -- sort_order menor que o menor ja existente entre
        # qualquer um dos tres tipos.
        min_row = await pool.fetchrow(
            """SELECT COALESCE(MIN(sort_order), 0) AS m FROM (
                 SELECT sort_order FROM folder_commands WHERE folder_id = $1
                 UNION ALL
                 SELECT sort_order FROM notes WHERE folder_id = $1
                 UNION ALL
                 SELECT sort_order FROM folders WHERE parent_id = $1
               ) combined""",
            parent_id,
        )
        sort_order = min_row["m"] - 1

    try:
        row = await pool.fetchrow(
            "INSERT INTO folders (username, name, parent_id, sort_order) VALUES ($1, $2, $3, $4) RETURNING id, name, sort_order, parent_id",
            username, name, parent_id, sort_order,
        )
    except Exception as err:  # noqa: BLE001
        if getattr(err, "sqlstate", None) == "23505":
            raise HTTPException(status_code=409, detail={"error": "conflict", "message": f'You already have a folder named "{name}"'})
        raise

    await log_audit(username, "create", "folder", row["id"], name)
    return {"id": row["id"], "name": row["name"], "sort_order": row["sort_order"], "parent_id": row["parent_id"], "command_ids": []}


@router.put("/{folder_id}")
async def rename_folder(folder_id: int, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"name" is required'})

    username = user["username"]
    pool = get_pool()
    before = await pool.fetchrow("SELECT name, username FROM folders WHERE id = $1", folder_id)
    if not before or before["username"] != username:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})
    if before["name"] == FAVORITES_FOLDER_NAME:
        raise HTTPException(status_code=403, detail={"error": "forbidden", "message": f'The "{FAVORITES_FOLDER_NAME}" folder cannot be renamed.'})

    try:
        row = await pool.fetchrow(
            "UPDATE folders SET name = $1 WHERE id = $2 AND username = $3 RETURNING id, name, sort_order",
            name, folder_id, username,
        )
    except Exception as err:  # noqa: BLE001
        if getattr(err, "sqlstate", None) == "23505":
            raise HTTPException(
                status_code=409,
                detail={"error": "conflict", "message": f'A folder named "{name}" already exists for that folder\'s owner'},
            )
        raise
    if not row:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})

    old_name = before["name"]
    details = f'Renamed from "{old_name}" to "{name}"' if old_name != name else None
    await log_audit(username, "update", "folder", row["id"], row["name"], details)
    return dict(row)


@router.put("/{folder_id}/move")
async def move_folder(folder_id: int, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    username = user["username"]
    new_parent_id = parse_required_int(body.get("parent_id"))
    if new_parent_id is None:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"parent_id" must be an integer'})

    pool = get_pool()
    folder = await pool.fetchrow("SELECT id, parent_id, username FROM folders WHERE id = $1", folder_id)
    if not folder or folder["username"] != username:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})
    if folder["parent_id"] is None:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": "Only subfolders (folders with a parent) can be moved this way"},
        )

    new_parent = await pool.fetchrow("SELECT id, username FROM folders WHERE id = $1", new_parent_id)
    if not new_parent or new_parent["username"] != username:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Parent folder '{new_parent_id}' not found"})
    if new_parent_id == folder_id:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "A folder cannot be its own parent"})

    # Ciclo: o novo pai nao pode ser um DESCENDENTE de :id.
    cursor = new_parent_id
    for _ in range(100):
        if cursor == folder_id:
            raise HTTPException(
                status_code=400,
                detail={"error": "validation_error", "message": "Cannot move a folder into one of its own subfolders"},
            )
        r = await pool.fetchrow("SELECT parent_id FROM folders WHERE id = $1", cursor)
        if not r or r["parent_id"] is None:
            break
        cursor = r["parent_id"]

    old_root = await get_root_ancestor_id(folder["parent_id"])
    new_root = await get_root_ancestor_id(new_parent_id)
    if old_root != new_root:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": "Cannot move a subfolder outside of its top-level parent folder"},
        )

    max_row = await pool.fetchrow("SELECT COALESCE(MAX(sort_order), -1) AS m FROM folders WHERE parent_id = $1", new_parent_id)
    row = await pool.fetchrow(
        "UPDATE folders SET parent_id = $1, sort_order = $2 WHERE id = $3 AND username = $4 RETURNING id, name, sort_order, parent_id",
        new_parent_id, max_row["m"] + 1, folder_id, username,
    )
    await log_audit(username, "update", "folder", row["id"], row["name"], f"Moved into folder #{new_parent_id}")
    return dict(row)


@router.delete("/{folder_id}", status_code=204)
async def delete_folder(folder_id: int, user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    before = await pool.fetchrow("SELECT name, username FROM folders WHERE id = $1", folder_id)
    if not before or before["username"] != username:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})
    if before["name"] == FAVORITES_FOLDER_NAME:
        raise HTTPException(status_code=403, detail={"error": "forbidden", "message": f'The "{FAVORITES_FOLDER_NAME}" folder cannot be deleted.'})
    result = await pool.execute("DELETE FROM folders WHERE id = $1 AND username = $2", folder_id, username)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})
    await log_audit(username, "delete", "folder", folder_id, before["name"], None)


@router.post("/{folder_id}/commands/{command_id}", status_code=204)
async def add_command_to_folder(folder_id: int, command_id: int, user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    folder = await pool.fetchrow("SELECT id, name FROM folders WHERE id = $1 AND username = $2", folder_id, username)
    if not folder:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})
    cmd_row = await cmds.find_command(command_id)
    if not cmd_row:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Command '{command_id}' not found"})
    await pool.execute(
        """INSERT INTO folder_commands (folder_id, command_id, sort_order)
           VALUES ($1, $2, (
             SELECT COALESCE(GREATEST(
               (SELECT MAX(sort_order) FROM folder_commands WHERE folder_id = $1),
               (SELECT MAX(sort_order) FROM notes WHERE folder_id = $1)
             ), -1) + 1
           ))
           ON CONFLICT DO NOTHING""",
        folder_id, command_id,
    )
    await log_audit(username, "update", "folder", folder_id, folder["name"], f'Added command "{cmd_row["name"]}"')


@router.delete("/{folder_id}/commands/{command_id}", status_code=204)
async def remove_command_from_folder(folder_id: int, command_id: int, user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    folder = await pool.fetchrow("SELECT id, name FROM folders WHERE id = $1 AND username = $2", folder_id, username)
    if not folder:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})
    cmd_row = await cmds.find_command(command_id)
    await pool.execute("DELETE FROM folder_commands WHERE folder_id = $1 AND command_id = $2", folder_id, command_id)
    cmd_name = cmd_row["name"] if cmd_row else str(command_id)
    await log_audit(username, "update", "folder", folder_id, folder["name"], f'Removed command "{cmd_name}"')


@router.put("/{folder_id}/reorder", status_code=204)
async def reorder_folder(folder_id: int, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    username = user["username"]
    order = body.get("order") if isinstance(body.get("order"), list) else None
    if not order and isinstance(body.get("command_ids"), list):
        order = [{"type": "command", "id": cid} for cid in body["command_ids"]]
    if not order:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": '"order" must be a non-empty array of {type, id}'},
        )

    pool = get_pool()
    folder = await pool.fetchrow("SELECT id FROM folders WHERE id = $1 AND username = $2", folder_id, username)
    if not folder:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})

    async with pool.acquire() as conn:
        async with conn.transaction():
            for i, item in enumerate(order):
                if not isinstance(item, dict):
                    continue
                try:
                    item_id = int(item.get("id"))
                except (TypeError, ValueError):
                    continue
                item_type = item.get("type")
                if item_type == "note":
                    await conn.execute(
                        "UPDATE notes SET sort_order = $1 WHERE folder_id = $2 AND id = $3 AND username = $4",
                        i, folder_id, item_id, username,
                    )
                elif item_type == "folder":
                    await conn.execute(
                        "UPDATE folders SET sort_order = $1 WHERE id = $2 AND parent_id = $3 AND username = $4",
                        i, item_id, folder_id, username,
                    )
                else:
                    await conn.execute(
                        "UPDATE folder_commands SET sort_order = $1 WHERE folder_id = $2 AND command_id = $3",
                        i, folder_id, item_id,
                    )


@router.post("/{folder_id}/copy", status_code=201)
async def copy_folder(folder_id: int, user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    src = await pool.fetchrow("SELECT id, name, username FROM folders WHERE id = $1", folder_id)
    if not src:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})

    if src["username"] != username:
        is_admin = role_rank(user["role"]) >= 1
        if not is_admin and not await folder_shares_allow(src["username"], username):
            raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})

    base_name = src["name"]
    name = base_name
    suffix = 1
    while True:
        exists = await pool.fetchval("SELECT 1 FROM folders WHERE username = $1 AND name = $2", username, name)
        if not exists:
            break
        suffix += 1
        name = f"{base_name} (copy)" if suffix == 2 else f"{base_name} (copy {suffix - 1})"

    async with pool.acquire() as conn:
        async with conn.transaction():
            new_folder = await conn.fetchrow(
                "INSERT INTO folders (username, name) VALUES ($1, $2) RETURNING id, name, sort_order",
                username, name,
            )
            await conn.execute(
                """INSERT INTO folder_commands (folder_id, command_id, sort_order)
                   SELECT $1, fc.command_id, fc.sort_order FROM folder_commands fc WHERE fc.folder_id = $2""",
                new_folder["id"], folder_id,
            )
            await conn.execute(
                """INSERT INTO notes (folder_id, username, title, description, sort_order)
                   SELECT $1, $2, n.title, n.description, n.sort_order FROM notes n WHERE n.folder_id = $3""",
                new_folder["id"], username, folder_id,
            )

    await log_audit(username, "create", "folder", new_folder["id"], new_folder["name"], f'Copied from folder "{base_name}"')
    cmd_rows = await pool.fetch(
        "SELECT command_id FROM folder_commands WHERE folder_id = $1 ORDER BY sort_order, created_at", new_folder["id"]
    )
    order_by_folder, notes_by_folder = await load_folder_order_and_notes([new_folder["id"]])
    return {
        "id": new_folder["id"], "name": new_folder["name"], "sort_order": new_folder["sort_order"],
        "command_ids": [r["command_id"] for r in cmd_rows],
        "notes": notes_by_folder.get(new_folder["id"], []),
        "order": order_by_folder.get(new_folder["id"], []),
    }


@router.get("/{folder_id}/export")
async def export_folder(folder_id: int, user: CurrentUser = Depends(require_user)):
    username = user["username"]
    pool = get_pool()
    owned = await pool.fetchrow("SELECT id FROM folders WHERE id = $1 AND username = $2", folder_id, username)
    if not owned:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})
    is_admin = role_rank(user["role"]) >= 1
    handle_map = None if is_admin else await cmds.get_handle_map()
    viewer_ctx = {"username": username, "is_admin": is_admin, "handle_map": handle_map}
    root = await build_folder_export_node(folder_id, username, viewer_ctx)
    return {"type": "toolbox45-folder-export", "version": 1, "exported_at": _iso_now(), "root": root}


@router.post("/import", status_code=201)
async def import_folder(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    tree = body.get("tree")
    if not isinstance(tree, dict) or not isinstance(tree.get("name"), str):
        raise HTTPException(
            status_code=400,
            detail={
                "error": "validation_error",
                "message": 'Invalid or missing "tree" (expected the "root" object from a folder export file)',
            },
        )
    parent_id, parent_ok = parse_optional_parent_id(body.get("parent_id"))
    if not parent_ok:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"parent_id" must be an integer'})

    username = user["username"]
    pool = get_pool()
    if parent_id is not None:
        parent = await pool.fetchrow("SELECT id FROM folders WHERE id = $1 AND username = $2", parent_id, username)
        if not parent:
            raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Parent folder '{parent_id}' not found"})

    stats = {"folders": 0, "notes": 0, "commands": 0, "commandsFailed": 0, "errors": []}
    async with pool.acquire() as conn:
        async with conn.transaction():
            root_folder_id = await import_folder_tree_node(conn, tree, username, parent_id, stats)

    extra = f", {stats['commandsFailed']} command(s) failed" if stats["commandsFailed"] else ""
    await log_audit(
        username, "create", "folder", root_folder_id, tree["name"],
        f"Imported folder tree: {stats['folders']} folder(s), {stats['commands']} command(s), {stats['notes']} note(s){extra}",
    )
    return stats


@router.post("/{folder_id}/notes", status_code=201)
async def create_note(folder_id: int, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_user)):
    username = user["username"]
    title = str(body.get("title") or "").strip()
    description = sanitize_note_html(body.get("description") or "")
    pool = get_pool()
    folder = await pool.fetchrow("SELECT id FROM folders WHERE id = $1 AND username = $2", folder_id, username)
    if not folder:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Folder '{folder_id}' not found"})
    row = await pool.fetchrow(
        """INSERT INTO notes (folder_id, username, title, description, sort_order)
           VALUES ($1, $2, $3, $4, (
             SELECT COALESCE(GREATEST(
               (SELECT MAX(sort_order) FROM folder_commands WHERE folder_id = $1),
               (SELECT MAX(sort_order) FROM notes WHERE folder_id = $1)
             ), -1) + 1
           ))
           RETURNING id, folder_id, title, description, sort_order, created_at, updated_at""",
        folder_id, username, title, description,
    )
    await log_audit(username, "create", "note", row["id"], title or "(untitled)")
    return dict(row)
