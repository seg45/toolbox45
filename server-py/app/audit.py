"""Log de auditoria -- porta 1:1 de logAudit()/summarizeChangedFields() em
server/index.js (linhas 223-275). Compartilhado por toda rota de
criacao/edicao/exclusao relevante -- vive num modulo a parte desde a fatia
4 porque as proximas fatias (pastas, usuarios, catalogos) tambem vao
precisar dele, nao so /api/commands.
"""
import logging
from typing import Any, Optional

from .db import get_pool

logger = logging.getLogger("toolbox45")

AUDIT_LOG_RETENTION_DAYS = 30


async def log_audit(
    username: Optional[str],
    action: str,
    entity_type: Optional[str] = "command",
    entity_id: Any = None,
    entity_name: Optional[str] = None,
    details: Optional[str] = None,
) -> None:
    # Mesmo try/catch amplo do Node -- uma falha ao gravar o audit log nunca
    # pode derrubar a rota que chamou (a acao em si -- criar/editar/excluir
    # -- ja foi commitada antes desta chamada).
    try:
        pool = get_pool()
        await pool.execute(
            "INSERT INTO audit_log (username, action, entity_type, entity_id, entity_name, details) VALUES ($1,$2,$3,$4,$5,$6)",
            username or None,
            action,
            entity_type or "command",
            str(entity_id) if entity_id else None,
            entity_name or None,
            details or None,
        )
        await pool.execute(
            f"DELETE FROM audit_log WHERE ts < NOW() - INTERVAL '{AUDIT_LOG_RETENTION_DAYS} days'"
        )
    except Exception as err:  # noqa: BLE001
        logger.error("logAudit failed: %s", err)


def summarize_changed_fields(before: Optional[dict], after: Optional[dict], field_labels: dict) -> Optional[str]:
    changed = []
    for key, label in field_labels.items():
        a = before.get(key) if before else None
        b = after.get(key) if after else None
        na = "" if a is None else str(a)
        nb = "" if b is None else str(b)
        if na != nb:
            changed.append(label)
    return f"Changed: {', '.join(changed)}" if changed else None
