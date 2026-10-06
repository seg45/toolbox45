"""GET /api/auth-events -- eventos de acesso (ver app/auth_events.py).

Somente super_admin: o registro mostra IPs, navegadores e tentativas contra
contas, que um admin comum nao precisa ver (auditoria de seguranca, out/2026).
API keys nunca sao super_admin, entao tambem nao leem.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth_events import EVENTS, RETENTION_DAYS
from ..db import get_pool
from ..deps import CurrentUser, require_super_admin

logger = logging.getLogger("toolbox45")
router = APIRouter(tags=["auth-events"])


@router.get("/api/auth-events")
async def list_auth_events(
    limit: int = Query(200, ge=1, le=1000),
    event: Optional[str] = Query(None, max_length=40),
    username: Optional[str] = Query(None, max_length=254),
    hours: Optional[int] = Query(None, ge=1, le=RETENTION_DAYS * 24),
    user: CurrentUser = Depends(require_super_admin),
) -> list:
    if event is not None and event not in EVENTS:
        raise HTTPException(
            status_code=400,
            detail={"error": "validation_error", "message": f'Unknown event "{event[:40]}"'},
        )
    clauses, args = [], []
    if event:
        args.append(event)
        clauses.append(f"event = ${len(args)}")
    if username:
        args.append(username)
        clauses.append(f"username = ${len(args)}")
    if hours:
        args.append(hours)
        clauses.append(f"ts >= NOW() - (${len(args)}::int * INTERVAL '1 hour')")
    args.append(limit)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    try:
        rows = await get_pool().fetch(
            f"""SELECT id, ts, event, username, ip, user_agent, detail
                FROM auth_events {where}
                ORDER BY ts DESC, id DESC
                LIMIT ${len(args)}""",
            *args,
        )
    except Exception as err:  # noqa: BLE001
        logger.error("ler auth_events falhou: %s", err)
        raise HTTPException(
            status_code=500, detail={"error": "internal_error", "message": "Failed to read the access log."}
        ) from err
    return [dict(r) for r in rows]
