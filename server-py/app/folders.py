"""Pastas + notas -- porta 1:1 de server/index.js (~linhas 220-243 e
1740-2760). Arvore de subpastas (self-referencing `parent_id`), notas
dentro de pasta, copiar/exportar/importar pasta (recursivo) e
get_root_ancestor_id() (usado pelas checagens de "nao pode mover pra fora
da pasta-mae" em PUT /api/folders/:id/move e PUT /api/notes/:id/move).
"""
import asyncio
from typing import Any, Optional

import asyncpg

from .commands import build_command_columns, find_command, insert_children, shape_command, validate_body
from .db import get_pool
from .sanitize import sanitize_note_html

FAVORITES_FOLDER_NAME = "Favorites"


def _js_to_number(raw: Any) -> Optional[float]:
    """Porta aproximada de `Number(x)` do JS -- None representa "invalido"
    (NaN). Diferenca deliberada: o Node trata `Number(null)`/`Number('')`
    como 0 (um inteiro "valido", que so falha depois ao nao achar a
    pasta/nota id 0); aqui os dois casos já caem em invalido/400 direto --
    simplifica a checagem sem mudar nada que a UI real aciona (ela sempre
    manda um id de verdade nesses campos).
    """
    if raw is None or raw == "" or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        try:
            return float(raw)
        except ValueError:
            return None
    return None


def _js_is_integer(n: Optional[float]) -> bool:
    return n is not None and n == int(n)


def parse_required_int(raw: Any) -> Optional[int]:
    """None se `raw` nao for um inteiro valido -- porta de `Number(x)` +
    `Number.isInteger()` para um campo OBRIGATORIO (parent_id de PUT
    /api/folders/:id/move, folder_id de PUT /api/notes/:id/move)."""
    n = _js_to_number(raw)
    return int(n) if _js_is_integer(n) else None


def parse_optional_parent_id(raw: Any) -> tuple:
    """Retorna (parent_id, valido). (None, True) significa "sem pasta-mae"
    (pasta de topo) -- porta de `parentIdRaw === undefined || null || ''`
    em POST /api/folders e POST /api/folders/import."""
    if raw is None or raw == "":
        return None, True
    n = _js_to_number(raw)
    if not _js_is_integer(n):
        return None, False
    return int(n), True


async def get_root_ancestor_id(folder_id: int) -> int:
    pool = get_pool()
    current = folder_id
    for _ in range(100):
        row = await pool.fetchrow("SELECT parent_id FROM folders WHERE id = $1", current)
        if not row or row["parent_id"] is None:
            return current
        current = row["parent_id"]
    return current


async def load_folder_order_and_notes(folder_ids: list) -> tuple:
    """Junta folder_commands + notes + SUBPASTAS DIRETAS de um conjunto de
    pastas num unico array `order` por pasta -- {type, id} na sequencia de
    sort_order (MESMA escala numerica pras tres fontes dentro de uma
    pasta). `notes_by_folder` sai pronto pra virar o campo `notes` de cada
    pasta na resposta.
    """
    if not folder_ids:
        return {}, {}
    pool = get_pool()
    items_rows, notes_rows = await asyncio.gather(
        pool.fetch(
            """SELECT folder_id, command_id AS item_id, sort_order, 'command' AS item_type FROM folder_commands WHERE folder_id = ANY($1)
               UNION ALL
               SELECT folder_id, id AS item_id, sort_order, 'note' AS item_type FROM notes WHERE folder_id = ANY($1)
               UNION ALL
               SELECT parent_id AS folder_id, id AS item_id, sort_order, 'folder' AS item_type FROM folders WHERE parent_id = ANY($1)
               ORDER BY folder_id, sort_order, item_type""",
            folder_ids,
        ),
        pool.fetch(
            """SELECT id, folder_id, username, title, description, sort_order, created_at, updated_at
               FROM notes WHERE folder_id = ANY($1) ORDER BY folder_id, sort_order, id""",
            folder_ids,
        ),
    )
    order_by_folder: dict = {}
    for r in items_rows:
        order_by_folder.setdefault(r["folder_id"], []).append({"type": r["item_type"], "id": r["item_id"]})
    notes_by_folder: dict = {}
    for r in notes_rows:
        notes_by_folder.setdefault(r["folder_id"], []).append({
            "id": r["id"], "folder_id": r["folder_id"], "title": r["title"], "description": r["description"],
            "sort_order": r["sort_order"], "created_at": r["created_at"], "updated_at": r["updated_at"],
        })
    return order_by_folder, notes_by_folder


async def folder_shares_allow(owner: str, viewer: str) -> bool:
    """share_folders (nao share_commands) -- usado por POST
    /api/folders/:id/copy pra decidir se um nao-dono/nao-admin pode copiar
    uma pasta de outro usuario."""
    pool = get_pool()
    row = await pool.fetchrow(
        """SELECT 1 WHERE EXISTS (
             SELECT 1 FROM shares WHERE grantor_username = $1 AND grantee_username = $2 AND share_folders = true
           ) OR EXISTS (
             SELECT 1 FROM group_members gm_me
             JOIN group_members gm_owner ON gm_owner.group_id = gm_me.group_id
             WHERE gm_me.username = $2 AND gm_owner.username = $1
           )""",
        owner, viewer,
    )
    return row is not None


def flatten_command_lines_for_import(lines: Optional[dict]) -> list:
    out = []
    for l in (lines or {}).get("default") or []:
        out.append({**l, "variant": "default"})
    for l in (lines or {}).get("empty") or []:
        out.append({**l, "variant": "empty"})
    return out


async def build_folder_export_node(folder_id: int, username: str, viewer_ctx: dict) -> Optional[dict]:
    pool = get_pool()
    folder_row = await pool.fetchrow("SELECT id, name FROM folders WHERE id = $1", folder_id)
    if not folder_row:
        return None
    name = folder_row["name"]

    note_rows = await pool.fetch(
        "SELECT title, description, sort_order FROM notes WHERE folder_id = $1 ORDER BY sort_order, id", folder_id
    )
    fc_rows = await pool.fetch(
        "SELECT command_id, sort_order FROM folder_commands WHERE folder_id = $1 ORDER BY sort_order, created_at",
        folder_id,
    )
    commands = []
    for fc in fc_rows:
        cmd_row = await find_command(fc["command_id"])
        if not cmd_row:
            continue
        commands.append({"sort_order": fc["sort_order"], "command": await shape_command(cmd_row, username, viewer_ctx)})

    child_rows = await pool.fetch(
        "SELECT id, sort_order FROM folders WHERE parent_id = $1 ORDER BY sort_order, name", folder_id
    )
    children = []
    for cf in child_rows:
        child_node = await build_folder_export_node(cf["id"], username, viewer_ctx)
        if child_node:
            children.append({"sort_order": cf["sort_order"], "folder": child_node})

    return {
        "name": name,
        "notes": [dict(r) for r in note_rows],
        "commands": commands,
        "children": children,
    }


async def find_available_folder_name(conn: asyncpg.Connection, username: str, base_name: str) -> str:
    name = base_name
    suffix = 1
    while True:
        exists = await conn.fetchval("SELECT 1 FROM folders WHERE username = $1 AND name = $2", username, name)
        if not exists:
            return name
        suffix += 1
        name = f"{base_name} (copy)" if suffix == 2 else f"{base_name} (copy {suffix - 1})"


async def import_folder_tree_node(
    conn: asyncpg.Connection, node: dict, username: str, parent_id: Optional[int], stats: dict
) -> int:
    base_name = str((node or {}).get("name") or "Imported folder").strip() or "Imported folder"
    name = await find_available_folder_name(conn, username, base_name)
    folder_id = await conn.fetchval(
        "INSERT INTO folders (username, name, parent_id) VALUES ($1, $2, $3) RETURNING id",
        username, name, parent_id,
    )
    stats["folders"] += 1

    for n in (node.get("notes") or []):
        n = n if isinstance(n, dict) else {}
        sort_order = n.get("sort_order")
        await conn.execute(
            "INSERT INTO notes (folder_id, username, title, description, sort_order) VALUES ($1, $2, $3, $4, $5)",
            folder_id, username, str(n.get("title") or ""),
            sanitize_note_html(n.get("description") or ""),
            sort_order if isinstance(sort_order, int) and not isinstance(sort_order, bool) else 0,
        )
        stats["notes"] += 1

    for c in (node.get("commands") or []):
        c = c if isinstance(c, dict) else {}
        cmd = c.get("command")
        if not cmd:
            continue
        body = {**cmd, "lines": flatten_command_lines_for_import(cmd.get("lines"))}
        errors = validate_body(body)
        if errors:
            stats["commandsFailed"] += 1
            stats["errors"].append(f"\"{cmd.get('name') or '?'}\": {'; '.join(errors)}")
            continue
        cols = build_command_columns(body)
        cols["created_by"] = username
        cols["modified_by"] = username
        new_cmd_id = await conn.fetchval(
            """INSERT INTO commands (
                 topic, icon, sort_order, requires_ip_port, placeholder_resolver,
                 name, name_empty, "desc", desc_empty,
                 details,
                 created_by, modified_by
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
               RETURNING id""",
            cols["topic"], cols["icon"], cols["sort_order"], cols["requires_ip_port"],
            cols["placeholder_resolver"],
            cols["name"], cols["name_empty"], cols["desc"], cols["desc_empty"],
            cols["details"],
            cols["created_by"], cols["modified_by"],
        )
        await insert_children(conn, new_cmd_id, body)
        c_sort_order = c.get("sort_order")
        await conn.execute(
            "INSERT INTO folder_commands (folder_id, command_id, sort_order) VALUES ($1, $2, $3)",
            folder_id, new_cmd_id,
            c_sort_order if isinstance(c_sort_order, int) and not isinstance(c_sort_order, bool) else 0,
        )
        stats["commands"] += 1

    for child in (node.get("children") or []):
        if isinstance(child, dict) and child.get("folder"):
            await import_folder_tree_node(conn, child["folder"], username, folder_id, stats)

    return folder_id
