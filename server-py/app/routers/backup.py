"""Fatia 10 (Backup/restore + audit log): as 7 rotas de
Configuracoes -> "Backup & Restore" (ver js/backup.js) + GET
/api/audit-log -- porta 1:1 de server/index.js.

Modelo de autorizacao (CONFERIDO DIRETO no server/index.js real do
Rodrigo -- ver server/index.js linhas ~4283-4470 para backup/restore e
~2765 para audit-log): TODAS as 8 rotas desta fatia exigem require_admin
(nenhuma e require_super_admin nem publica) -- padrao uniforme, ao
contrario da fatia 9 (Sistema).

/api/backups/:filename/download e /api/backups/:filename/restore usam o
filename vindo da URL, protegido por resolve_backup_path() (ver
app/backup.py) contra path traversal -- 404 (nao 400) quando o nome nao
"bate" ou o arquivo nao existe, mesmo comportamento do Node.
"""
import re
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse

from .. import backup
from ..audit import AUDIT_LOG_RETENTION_DAYS
from ..config import settings
from ..db import get_pool
from ..deps import CurrentUser, require_admin
from .system import _read_global_setting, _write_global_setting

router = APIRouter(tags=["backup"])


# ════════════════════════════════════════════════
# Backup e restauracao (ver app/backup.py pros helpers compartilhados).
# ════════════════════════════════════════════════
@router.get("/api/backups")
async def list_backups(user: CurrentUser = Depends(require_admin)) -> list:
    try:
        return backup.list_backup_files()
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"error": "internal_error", "message": str(err)}) from err


@router.post("/api/backups", status_code=201)
async def create_backup(user: CurrentUser = Depends(require_admin)) -> dict:
    try:
        filename = await backup.perform_backup("backup")
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"error": "internal_error", "message": str(err)}) from err
    return {"filename": filename}


@router.get("/api/backups/{filename}/download")
async def download_backup(filename: str, user: CurrentUser = Depends(require_admin)) -> FileResponse:
    full = backup.resolve_backup_path(filename)
    if not full:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    # media_type explicito: a extensao .dump nao e reconhecida por
    # mimetypes.guess_type() (o FileResponse cairia em "text/plain" por
    # default do Starlette) -- o Node/Express (res.download -> modulo
    # `send`) cai em "application/octet-stream" pra extensao desconhecida,
    # entao fixamos isso aqui pra bater com o Content-Type real do Node.
    return FileResponse(str(full), filename=filename, media_type="application/octet-stream")


@router.delete("/api/backups/{filename}", status_code=204)
async def delete_backup(filename: str, user: CurrentUser = Depends(require_admin)) -> None:
    full = backup.resolve_backup_path(filename)
    if not full:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    try:
        full.unlink()
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"error": "internal_error", "message": str(err)}) from err


@router.post("/api/backups/{filename}/restore")
async def restore_backup(filename: str, user: CurrentUser = Depends(require_admin)) -> dict:
    # Por seguranca, tira uma foto do banco ATUAL antes de sobrescrever
    # (prefixo "pre-restore-"), para permitir desfazer.
    full = backup.resolve_backup_path(filename)
    if not full:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    try:
        await backup.perform_backup("pre-restore")
        await backup._run_cli("pg_restore", ["--clean", "--if-exists", "--no-owner", "-d", settings.dsn(), str(full)])
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"error": "internal_error", "message": str(err)}) from err
    return {"ok": True, "message": "Restore complete. Reload the page to see the restored data."}


# ════════════════════════════════════════════════
# Agendamento de backup -- guardado nas MESMAS chaves de /api/global-settings
# (tabela user_data, username sentinela GLOBAL_SETTINGS_USER, ver
# app/routers/system.py) -- checado a cada minuto por
# backup.scheduled_backup_loop() (ver app/main.py, lifespan).
# ════════════════════════════════════════════════
@router.get("/api/backup-schedule")
async def get_backup_schedule(user: CurrentUser = Depends(require_admin)) -> dict:
    pool = get_pool()
    weekly_raw = await _read_global_setting(pool, "backupScheduleWeeklyDays", "")
    weekly_days = [int(s.strip()) for s in weekly_raw.split(",") if s.strip()]
    try:
        monthly_day = int(await _read_global_setting(pool, "backupScheduleMonthlyDay", "1")) or 1
    except (TypeError, ValueError):
        monthly_day = 1
    return {
        "enabled": (await _read_global_setting(pool, "backupScheduleEnabled", "0")) == "1",
        "frequency": await _read_global_setting(pool, "backupScheduleFrequency", "daily"),
        "weeklyDays": weekly_days,
        "monthlyDay": monthly_day,
        "time": await _read_global_setting(pool, "backupScheduleTime", "02:00"),
    }


@router.put("/api/backup-schedule", status_code=204)
async def update_backup_schedule(body: Any = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)) -> None:
    if not isinstance(body, dict):
        body = {}
    frequency = body.get("frequency") if body.get("frequency") in ("daily", "weekly", "monthly") else "daily"
    raw_weekly = body.get("weeklyDays")
    weekly_days = []
    if isinstance(raw_weekly, list):
        for item in raw_weekly:
            try:
                n = int(item)
            except (TypeError, ValueError):
                continue
            if 0 <= n <= 6:
                weekly_days.append(n)
    monthly_day = min(31, max(1, backup.js_parse_int_or(body.get("monthlyDay"), 1)))
    time_value = body.get("time")
    time_ok = isinstance(time_value, str) and re.match(r"^\d{2}:\d{2}$", time_value)
    time_str = time_value if time_ok else "02:00"

    pool = get_pool()
    await _write_global_setting(pool, "backupScheduleEnabled", "1" if body.get("enabled") else "0")
    await _write_global_setting(pool, "backupScheduleFrequency", frequency)
    await _write_global_setting(pool, "backupScheduleWeeklyDays", ",".join(str(n) for n in weekly_days))
    await _write_global_setting(pool, "backupScheduleMonthlyDay", str(monthly_day))
    await _write_global_setting(pool, "backupScheduleTime", time_str)


# ════════════════════════════════════════════════
# GET /api/audit-log -- lista as alteracoes (criar/editar/excluir, em
# qualquer entidade -- ver app/audit.py) dos ultimos 30 dias, mais recente
# primeiro. Teto de 1000 linhas. command_id/command_name continuam no JSON
# de resposta (apontando para os mesmos valores de entity_id/entity_name)
# so para nao quebrar nenhum consumidor externo (API key) que ja lia esses
# nomes de campo antes desta mudanca.
# ════════════════════════════════════════════════
@router.get("/api/audit-log")
async def get_audit_log(user: CurrentUser = Depends(require_admin)) -> list:
    try:
        pool = get_pool()
        rows = await pool.fetch(
            f"""SELECT id, ts, username, action, entity_type, entity_id, entity_name, details
                FROM audit_log
                WHERE ts >= NOW() - INTERVAL '{AUDIT_LOG_RETENTION_DAYS} days'
                ORDER BY ts DESC, id DESC
                LIMIT 1000"""
        )
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"error": "internal_error", "message": str(err)}) from err
    return [
        {**dict(r), "command_id": r["entity_id"], "command_name": r["entity_name"]}
        for r in rows
    ]
