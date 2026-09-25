"""Leitura/escrita de comandos -- porta 1:1 de shapeCommand()/
shapeCommandsBatch()/maskUsernameForViewer()/getHandleMap()/
validateBody()/buildCommandColumns()/insertChildren() em server/index.js
(linhas ~995-1150 e ~3345-3420). De longe a rota mais usada da aplicacao --
a tela principal inteira depende de GET /api/commands.
"""
import asyncio
from typing import Any, Optional

import asyncpg

from .db import get_pool
from .sanitize import sanitize_note_html

REQUIRED_TEXT_FIELDS = ["name", "desc"]
NULLABLE_TEXT_FIELDS = ["name_empty", "desc_empty"]


def resolve_topics(body: dict) -> list:
    topics = body.get("topics")
    if isinstance(topics, list) and topics:
        return topics
    topic = body.get("topic")
    if isinstance(topic, str) and topic:
        return [topic]
    return []


def _is_non_empty_array(val: Any) -> bool:
    return isinstance(val, list) and len(val) > 0


def validate_body(body: Any) -> list:
    if not isinstance(body, dict):
        return ["Request body must be a JSON object"]
    errors = []
    vendors = body.get("vendors")
    if not _is_non_empty_array(vendors):
        errors.append('"vendors" is required (exactly one vendor)')
    elif len(vendors) > 1:
        errors.append('"vendors" must contain exactly one vendor (a command belongs to a single vendor)')
    if not _is_non_empty_array(body.get("systems")):
        errors.append('"systems" is required (at least one system)')
    if not _is_non_empty_array(body.get("versions")):
        errors.append('"versions" is required (at least one version)')
    if not _is_non_empty_array(body.get("environments")):
        errors.append('"environments" is required (at least one environment)')
    if not resolve_topics(body):
        errors.append('"topics" is required (at least one topic)')
    name = body.get("name")
    if not name or not isinstance(name, str):
        errors.append('"name" is required')
    return errors


def build_command_columns(body: dict) -> dict:
    topics = resolve_topics(body)
    lines = body.get("lines") if isinstance(body.get("lines"), list) else []
    has_empty_lines = any(
        isinstance(l, dict) and l.get("variant") == "empty" and str(l.get("content") or "").strip()
        for l in lines
    )
    sort_order = body.get("sort_order")
    cols: dict = {
        "topic": topics[0],
        "icon": body.get("icon") or "📄",
        "sort_order": sort_order if isinstance(sort_order, int) and not isinstance(sort_order, bool) else 0,
        "requires_ip_port": 1 if (body.get("requires_ip_port") and has_empty_lines) else 0,
        "placeholder_resolver": body.get("placeholder_resolver") or None,
        # `details` -- conteudo rico (HTML) do editor de Details,
        # sanitizado igual a descricao de uma Note (mesma funcao/allow-list
        # -- ver app/sanitize.py), nunca confiado cru so porque veio
        # autenticado.
        "details": sanitize_note_html(body.get("details") or ""),
    }
    for f in REQUIRED_TEXT_FIELDS:
        v = body.get(f)
        cols[f] = v if v is not None else ""
    for f in NULLABLE_TEXT_FIELDS:
        v = body.get(f)
        cols[f] = v if v is not None else None
    return cols


async def insert_children(conn: asyncpg.Connection, command_id: int, body: dict) -> None:
    for tp in resolve_topics(body):
        await conn.execute("INSERT INTO command_topics (command_id, topic) VALUES ($1, $2)", command_id, tp)
    for v in (body.get("vendors") or []):
        await conn.execute("INSERT INTO command_vendors (command_id, vendor) VALUES ($1, $2)", command_id, v)
    for s in (body.get("systems") or []):
        await conn.execute("INSERT INTO command_systems (command_id, system) VALUES ($1, $2)", command_id, s)
    for v in (body.get("versions") or []):
        await conn.execute("INSERT INTO command_versions (command_id, version) VALUES ($1, $2)", command_id, v)
    for e in (body.get("environments") or []):
        await conn.execute("INSERT INTO command_environments (command_id, environment) VALUES ($1, $2)", command_id, e)

    lines = body.get("lines") or []
    for i, line in enumerate(lines):
        line_sort_order = line.get("sort_order")
        line_type = line.get("line_type") or "cmd"
        await conn.execute(
            """INSERT INTO command_lines
                 (command_id, variant, sort_order, line_type, prompt, content, export_template, image_data)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
            command_id,
            line.get("variant") or "default",
            line_sort_order if isinstance(line_sort_order, int) and not isinstance(line_sort_order, bool) else i,
            line_type,
            line.get("prompt") or None,
            line.get("content") or "",
            line.get("export_template") or None,
            (line.get("image_data") or None) if line_type == "image" else None,
        )


async def find_command(command_id: Any) -> Optional[dict]:
    pool = get_pool()
    row = await pool.fetchrow("SELECT * FROM commands WHERE id = $1", command_id)
    return dict(row) if row else None


async def get_handle_map() -> dict:
    pool = get_pool()
    rows = await pool.fetch("SELECT username, handle FROM users")
    return {r["username"]: r["handle"] for r in rows}


def mask_username_for_viewer(raw_username: Optional[str], viewer_ctx: Optional[dict]) -> Optional[str]:
    if not raw_username or raw_username == "System":
        return raw_username
    if not viewer_ctx or viewer_ctx.get("is_admin") or raw_username == viewer_ctx.get("username"):
        return raw_username
    handle_map = viewer_ctx.get("handle_map") or {}
    return handle_map.get(raw_username) or raw_username


def _shape_line(l: dict) -> dict:
    return {
        "line_type": l["line_type"],
        "prompt": l["prompt"],
        "content": l["content"],
        "export_template": l["export_template"] or None,
        "image_data": l["image_data"] or None,
    }


def _shape_row(
    row: dict,
    vendors: list,
    systems: list,
    versions: list,
    environments: list,
    topics: list,
    folder_ids: list,
    lines_rows: list,
    viewer_ctx: Optional[dict],
) -> dict:
    lines = {
        "default": [_shape_line(l) for l in lines_rows if l["variant"] == "default"],
        "empty": [_shape_line(l) for l in lines_rows if l["variant"] == "empty"],
    }
    return {
        "id": row["id"],
        "topic": row["topic"],
        "topics": topics if topics else [row["topic"]],
        "folder_ids": folder_ids,
        "icon": row["icon"],
        "sort_order": row["sort_order"],
        "requires_ip_port": bool(row["requires_ip_port"]),
        "placeholder_resolver": row["placeholder_resolver"],
        "name": row["name"],
        "name_empty": row["name_empty"],
        "desc": row["desc"],
        "desc_empty": row["desc_empty"],
        "details": row["details"],
        "vendors": vendors,
        "systems": systems,
        "versions": versions,
        "environments": environments,
        "lines": lines,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "created_by": mask_username_for_viewer(row["created_by"], viewer_ctx) or None,
        "modified_by": mask_username_for_viewer(row["modified_by"] or row["created_by"], viewer_ctx) or None,
        "is_system": row["created_by"] == "System",
    }


async def shape_command(row: dict, username: Optional[str], viewer_ctx: Optional[dict]) -> dict:
    pool = get_pool()
    command_id = row["id"]

    async def folder_rows_coro():
        if not username:
            return []
        return await pool.fetch(
            """SELECT fc.folder_id FROM folder_commands fc
               JOIN folders f ON f.id = fc.folder_id
               WHERE fc.command_id = $1 AND f.username = $2
               ORDER BY fc.folder_id""",
            command_id, username,
        )

    vendors_rows, systems_rows, versions_rows, env_rows, topics_rows, folder_rows, lines_rows = await asyncio.gather(
        pool.fetch("SELECT vendor FROM command_vendors WHERE command_id = $1 ORDER BY vendor", command_id),
        pool.fetch("SELECT system FROM command_systems WHERE command_id = $1 ORDER BY system", command_id),
        pool.fetch("SELECT version FROM command_versions WHERE command_id = $1 ORDER BY version", command_id),
        pool.fetch("SELECT environment FROM command_environments WHERE command_id = $1 ORDER BY environment", command_id),
        pool.fetch("SELECT topic FROM command_topics WHERE command_id = $1 ORDER BY topic", command_id),
        folder_rows_coro(),
        pool.fetch(
            "SELECT variant, sort_order, line_type, prompt, content, export_template, image_data "
            "FROM command_lines WHERE command_id = $1 ORDER BY variant, sort_order, id",
            command_id,
        ),
    )

    return _shape_row(
        row,
        [r["vendor"] for r in vendors_rows],
        [r["system"] for r in systems_rows],
        [r["version"] for r in versions_rows],
        [r["environment"] for r in env_rows],
        [r["topic"] for r in topics_rows],
        [r["folder_id"] for r in folder_rows],
        lines_rows,
        viewer_ctx,
    )


def _group_rows_by(rows: list, key_field: str) -> dict:
    grouped: dict = {}
    for r in rows:
        grouped.setdefault(r[key_field], []).append(r)
    return grouped


async def shape_commands_batch(rows: list, username: Optional[str], viewer_ctx: Optional[dict]) -> list:
    """Versao em lote de shape_command() -- usada so por GET /api/commands
    (a listagem completa). shape_command() faz varias queries por comando
    (otimo pra 1, pessimo pra N: ~8N round-trips ao Postgres). Aqui cada
    tabela relacionada e buscada UMA vez pra TODOS os comandos de uma vez
    (WHERE command_id = ANY($1)) e distribuida em memoria -- mesmo formato
    de saida de shape_command(), O(1) queries por tabela em vez de O(N).
    """
    if not rows:
        return []
    pool = get_pool()
    ids = [r["id"] for r in rows]

    async def folder_rows_coro():
        if not username:
            return []
        return await pool.fetch(
            """SELECT fc.command_id, fc.folder_id FROM folder_commands fc
               JOIN folders f ON f.id = fc.folder_id
               WHERE fc.command_id = ANY($1) AND f.username = $2
               ORDER BY fc.command_id, fc.folder_id""",
            ids, username,
        )

    vendors_rows, systems_rows, versions_rows, env_rows, topics_rows, folder_rows, lines_rows = await asyncio.gather(
        pool.fetch("SELECT command_id, vendor FROM command_vendors WHERE command_id = ANY($1) ORDER BY command_id, vendor", ids),
        pool.fetch("SELECT command_id, system FROM command_systems WHERE command_id = ANY($1) ORDER BY command_id, system", ids),
        pool.fetch("SELECT command_id, version FROM command_versions WHERE command_id = ANY($1) ORDER BY command_id, version", ids),
        pool.fetch("SELECT command_id, environment FROM command_environments WHERE command_id = ANY($1) ORDER BY command_id, environment", ids),
        pool.fetch("SELECT command_id, topic FROM command_topics WHERE command_id = ANY($1) ORDER BY command_id, topic", ids),
        folder_rows_coro(),
        pool.fetch(
            "SELECT command_id, variant, sort_order, line_type, prompt, content, export_template, image_data "
            "FROM command_lines WHERE command_id = ANY($1) ORDER BY command_id, variant, sort_order, id",
            ids,
        ),
    )

    vendors_by = _group_rows_by(vendors_rows, "command_id")
    systems_by = _group_rows_by(systems_rows, "command_id")
    versions_by = _group_rows_by(versions_rows, "command_id")
    env_by = _group_rows_by(env_rows, "command_id")
    topics_by = _group_rows_by(topics_rows, "command_id")
    folder_by = _group_rows_by(folder_rows, "command_id")
    lines_by = _group_rows_by(lines_rows, "command_id")

    result = []
    for row in rows:
        cid = row["id"]
        result.append(
            _shape_row(
                row,
                [r["vendor"] for r in vendors_by.get(cid, [])],
                [r["system"] for r in systems_by.get(cid, [])],
                [r["version"] for r in versions_by.get(cid, [])],
                [r["environment"] for r in env_by.get(cid, [])],
                [r["topic"] for r in topics_by.get(cid, [])],
                [r["folder_id"] for r in folder_by.get(cid, [])],
                lines_by.get(cid, []),
                viewer_ctx,
            )
        )
    return result
