"""GET/POST/PUT/DELETE /api/commands -- porta 1:1 de server/index.js
(GET lista ~linha 1200, GET/:id ~1287, POST ~3448, PUT ~3506, DELETE ~3592).
A rota mais usada da aplicacao -- a tela principal inteira depende de GET
/api/commands.

Nota: commands.id e INTEGER (SERIAL) -- diferente do driver node-postgres
(que serializa qualquer parametro como texto e deixa o Postgres fazer o
cast), asyncpg exige que o parametro bind ja chegue como int de verdade.
Por isso os path params abaixo sao tipados `int` (FastAPI/Pydantic
convertem a string da URL) em vez de `str` cru feito no Node. Efeito
colateral aceito: um :id nao-numerico vira 400 validation_error aqui contra
um 500 internal_error no Node -- a UI real nunca chama isto com um id
nao-numerico (sempre vem de um objeto ja shapeado pela propria API).
"""
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response

from .. import commands as cmds
from ..audit import log_audit, summarize_changed_fields
from ..db import get_pool
from ..deps import CurrentUser, require_user, role_rank

router = APIRouter(prefix="/api/commands", tags=["commands"])


def _viewer_ctx(username: str, is_admin: bool, handle_map: Optional[dict]) -> dict:
    return {"username": username, "is_admin": is_admin, "handle_map": handle_map}


@router.get("")
async def list_commands(
    topic: Optional[str] = None,
    version: Optional[str] = None,
    environment: Optional[str] = None,
    vendor: Optional[str] = None,
    system: Optional[str] = None,
    sort: Optional[str] = None,
    user: CurrentUser = Depends(require_user),
):
    username = user["username"]
    is_admin = role_rank(user["role"]) >= 1

    sql = "SELECT * FROM commands WHERE 1=1"
    params: list = []

    # Privado por padrao: um usuario comum so ve comandos de referencia
    # (System/sem dono), os PROPRIOS comandos, os de quem compartilhou com
    # ele (share_commands=true) e os de quem esta no MESMO GRUPO que ele.
    # Admin ve tudo, sem excecao.
    if not is_admin:
        params.append(username)
        p = len(params)
        sql += f"""
          AND (
            commands.created_by IS NULL OR commands.created_by = 'System'
            OR commands.created_by = ${p}
            OR EXISTS (
              SELECT 1 FROM shares sh
              WHERE sh.grantor_username = commands.created_by AND sh.grantee_username = ${p} AND sh.share_commands = true
            )
            OR EXISTS (
              SELECT 1 FROM group_members gm_me
              JOIN group_members gm_owner ON gm_owner.group_id = gm_me.group_id
              WHERE gm_me.username = ${p} AND gm_owner.username = commands.created_by
            )
          )
        """

    if topic:
        params.append(topic)
        sql += f" AND EXISTS (SELECT 1 FROM command_topics ct WHERE ct.command_id = commands.id AND ct.topic = ${len(params)})"
    if vendor:
        params.append(vendor)
        sql += f"""
          AND (
            NOT EXISTS (SELECT 1 FROM command_vendors cv WHERE cv.command_id = commands.id)
            OR EXISTS (SELECT 1 FROM command_vendors cv WHERE cv.command_id = commands.id AND cv.vendor = ${len(params)})
          )
        """
    if system:
        params.append(system)
        sql += f"""
          AND (
            NOT EXISTS (SELECT 1 FROM command_systems cs WHERE cs.command_id = commands.id)
            OR EXISTS (SELECT 1 FROM command_systems cs WHERE cs.command_id = commands.id AND cs.system = ${len(params)})
          )
        """
    if version:
        params.append(version)
        sql += f"""
          AND (
            NOT EXISTS (SELECT 1 FROM command_versions cv WHERE cv.command_id = commands.id)
            OR EXISTS (SELECT 1 FROM command_versions cv WHERE cv.command_id = commands.id AND cv.version = ${len(params)})
          )
        """
    if environment:
        params.append(environment)
        sql += f"""
          AND (
            NOT EXISTS (SELECT 1 FROM command_environments ce WHERE ce.command_id = commands.id)
            OR EXISTS (SELECT 1 FROM command_environments ce WHERE ce.command_id = commands.id AND ce.environment = ${len(params)})
          )
        """

    sql += " ORDER BY created_by, sort_order, id" if sort == "creator" else " ORDER BY sort_order, id"

    pool = get_pool()
    rows = await pool.fetch(sql, *params)

    handle_map = None if is_admin else await cmds.get_handle_map()
    viewer_ctx = _viewer_ctx(username, is_admin, handle_map)
    return await cmds.shape_commands_batch([dict(r) for r in rows], username, viewer_ctx)


@router.get("/{command_id}")
async def get_command(command_id: int, user: CurrentUser = Depends(require_user)):
    row = await cmds.find_command(command_id)
    if not row:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Command '{command_id}' not found"})

    username = user["username"]
    is_admin = role_rank(user["role"]) >= 1

    # Mesma regra de visibilidade de GET /api/commands -- 404 (nao 403: nao
    # vaza a distincao) quando o comando e de outro usuario que nao
    # compartilhou/nao esta no mesmo grupo de quem pediu.
    if not is_admin and row["created_by"] and row["created_by"] != "System" and row["created_by"] != username:
        pool = get_pool()
        vis = await pool.fetchrow(
            """SELECT 1 WHERE EXISTS (
                 SELECT 1 FROM shares WHERE grantor_username = $1 AND grantee_username = $2 AND share_commands = true
               ) OR EXISTS (
                 SELECT 1 FROM group_members gm_me
                 JOIN group_members gm_owner ON gm_owner.group_id = gm_me.group_id
                 WHERE gm_me.username = $2 AND gm_owner.username = $1
               )""",
            row["created_by"], username,
        )
        if not vis:
            raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Command '{command_id}' not found"})

    handle_map = None if is_admin else await cmds.get_handle_map()
    return await cmds.shape_command(row, username, _viewer_ctx(username, is_admin, handle_map))


@router.post("", status_code=201)
async def create_command(
    request: Request,
    body: dict = Body(default_factory=dict),
    user: CurrentUser = Depends(require_user),
):
    errors = cmds.validate_body(body)
    if errors:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "; ".join(errors)})

    cols = cmds.build_command_columns(body)
    username = user["username"]

    # Todo comando criado por esta API e atribuido ao usuario atual, EXCETO
    # quando o chamador e admin e envia X-Save-As-System (import "as
    # System" -- ver js/csv-import.js): nesse caso created_by=modified_by=
    # 'System'. Ignorado silenciosamente para nao-admins (nao e erro --
    # confiar num header do cliente pra elevar privilegio sem checar role
    # no servidor seria inseguro).
    wants_system = request.headers.get("x-save-as-system") in ("1", "true")
    save_as_system = wants_system and role_rank(user["role"]) >= 1
    cols["created_by"] = "System" if save_as_system else username
    cols["modified_by"] = "System" if save_as_system else username

    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            command_id = await conn.fetchval(
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
            await cmds.insert_children(conn, command_id, body)

    await log_audit(username, "create", "command", command_id, cols["name"])
    row = await cmds.find_command(command_id)
    # created_by === username sempre aqui (comando recem-criado pelo
    # proprio usuario) -- mask_username_for_viewer nunca mascara a propria
    # criacao, entao is_admin/handle_map nao importam neste caso.
    return await cmds.shape_command(row, username, _viewer_ctx(username, False, None))


@router.put("/{command_id}")
async def update_command(
    command_id: int,
    request: Request,
    body: dict = Body(default_factory=dict),
    user: CurrentUser = Depends(require_user),
):
    found = await cmds.find_command(command_id)
    if not found:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Command '{command_id}' not found"})

    current_user = user["username"]
    # Um usuario comum pode editar o PROPRIO comando OU um comando de
    # referencia (created_by='System'). Nao pode editar o comando de OUTRO
    # usuario -- precisa duplicar (POST normal) e editar a copia. Admins
    # nao tem essa restricao.
    is_system_command = found["created_by"] == "System"
    if role_rank(user["role"]) < 1 and found["created_by"] != current_user and not is_system_command:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "forbidden",
                "message": "You can only edit your own commands (or System commands). Duplicate it to create your own editable copy.",
            },
        )

    errors = cmds.validate_body(body)
    if errors:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": "; ".join(errors)})

    cols = cmds.build_command_columns(body)
    cols["modified_by"] = current_user

    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """UPDATE commands SET
                     topic = $1, icon = $2, sort_order = $3,
                     requires_ip_port = $4,
                     placeholder_resolver = $5,
                     name = $6, name_empty = $7, "desc" = $8, desc_empty = $9,
                     details = $10,
                     modified_by = $11,
                     updated_at = NOW()
                   WHERE id = $12""",
                cols["topic"], cols["icon"], cols["sort_order"],
                cols["requires_ip_port"],
                cols["placeholder_resolver"],
                cols["name"], cols["name_empty"], cols["desc"], cols["desc_empty"],
                cols["details"],
                cols["modified_by"],
                command_id,
            )
            await conn.execute("DELETE FROM command_topics WHERE command_id = $1", command_id)
            await conn.execute("DELETE FROM command_vendors WHERE command_id = $1", command_id)
            await conn.execute("DELETE FROM command_systems WHERE command_id = $1", command_id)
            await conn.execute("DELETE FROM command_versions WHERE command_id = $1", command_id)
            await conn.execute("DELETE FROM command_environments WHERE command_id = $1", command_id)
            await conn.execute("DELETE FROM command_lines WHERE command_id = $1", command_id)
            await cmds.insert_children(conn, command_id, body)

    # Resumo de "o que foi feito" (so campos escalares -- linhas/tags/
    # vendors/etc. sao sempre apagadas e reinseridas por inteiro a cada PUT,
    # entao "mudaram" seria sempre verdadeiro e sem sinal real).
    change_details = summarize_changed_fields(
        found, cols,
        {"name": "name", "topic": "topic", "desc": "description", "details": "details", "requires_ip_port": "IP+Port pairing"},
    )
    await log_audit(current_user, "update", "command", command_id, cols["name"], change_details)
    row = await cmds.find_command(command_id)
    return await cmds.shape_command(row, current_user, _viewer_ctx(current_user, False, None))


@router.delete("/{command_id}", status_code=204)
async def delete_command(command_id: int, user: CurrentUser = Depends(require_user)):
    found = await cmds.find_command(command_id)
    if not found:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Command '{command_id}' not found"})

    current_user = user["username"]
    # Um usuario comum so exclui o PROPRIO comando. Comandos 'System' e de
    # outros usuarios exigem admin.
    if role_rank(user["role"]) < 1 and found["created_by"] != current_user:
        message = (
            "Only admins can delete System commands."
            if found["created_by"] == "System"
            else "You can only delete your own commands."
        )
        raise HTTPException(status_code=403, detail={"error": "forbidden", "message": message})

    pool = get_pool()
    # command_id em folder_commands tem FK ON DELETE CASCADE -- apagar o
    # comando ja limpa sozinho sua presenca em qualquer pasta.
    await pool.execute("DELETE FROM commands WHERE id = $1", command_id)
    await log_audit(current_user, "delete", "command", command_id, found["name"])
