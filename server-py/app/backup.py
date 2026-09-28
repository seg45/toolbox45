"""Backup e restauracao do banco de dados (Configuracoes -> "Backup &
Restore", ver js/backup.js) -- porta 1:1 de server/index.js (BACKUP_DIR,
runCli/pad2/backupTimestamp/performBackup/listBackupFiles/
resolveBackupPath/readGlobalSetting/writeGlobalSetting, as 7 rotas em
app/routers/backup.py e checkScheduledBackup(), linhas ~4283-4470).

Usa `pg_dump`/`pg_restore` (CLI do PostgreSQL -- precisa estar instalada
na imagem, ver server-py/Dockerfile) em vez de qualquer driver Python,
exatamente como o Node usa execFile em vez de um client nativo -- MESMOS
argumentos (-F c na criacao, --clean --if-exists --no-owner na
restauracao), so trocando execFile por asyncio.create_subprocess_exec (ver
_run_cli abaixo, mesmo padrao ja usado pro `openssl` na fatia 9, ver
app/tls.py).

O agendamento (diario/semanal/mensal + horario) fica guardado nas MESMAS
chaves de /api/global-settings (tabela user_data, username sentinela
GLOBAL_SETTINGS_USER) -- reaproveita _read_global_setting/
_write_global_setting de app/routers/system.py (fatia 9) em vez de
duplicar os helpers (import direto do "privado" com underscore -- mesma
convencao ja usada entre modulos deste backend, o underscore e so
sinalizacao de "uso interno do dominio Sistema", nao um limite de import
real em Python).
"""
import asyncio
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from .config import settings
from .db import get_pool
from .routers.system import _read_global_setting, _write_global_setting

logger = logging.getLogger("toolbox45")

# Mesmo default relativo do Node (path.join(__dirname, 'backup'), singular
# -- reparar que o volume em producao (docker-compose.yml) chama-se
# toolbox45-backups (plural) mas e MONTADO em /app/backups (plural) via
# BACKUP_DIR=/app/backups no Dockerfile do Node -- o default aqui so
# importa quando BACKUP_DIR nao esta setada, mesma logica do TLS_DIR na
# fatia 9). Este backend ainda nao esta wireado no docker-compose (Fase
# 4), entao por enquanto nao compartilha o MESMO volume/arquivos que o
# backend Node grava -- mesma situacao ja documentada pro TLS_DIR.
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR") or (Path(__file__).resolve().parent.parent / "backup"))


async def _run_cli(cmd: str, args: list) -> None:
    proc = await asyncio.create_subprocess_exec(
        cmd, *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(stderr.decode("utf-8", errors="replace") or f"{cmd} exited with code {proc.returncode}")


def _pad2(n: int) -> str:
    return str(n).zfill(2)


def js_parse_int_or(value, fallback: int) -> int:
    """Equivalente a `parseInt(value, 10) || fallback` do JS: le so o
    prefixo numerico inteiro da string (ignorando lixo depois, ex.: "15.5"
    -> 15) e cai no fallback se nao houver prefixo numerico OU se o
    resultado for 0 (0 e falsy em JS, igual a NaN pro operador ||)."""
    m = re.match(r"^\s*[+-]?\d+", str(value))
    if not m:
        return fallback
    n = int(m.group(0))
    return n if n else fallback


def backup_timestamp(d: Optional[datetime] = None) -> str:
    d = d or datetime.now()
    return f"{d.year}{_pad2(d.month)}{_pad2(d.day)}-{_pad2(d.hour)}{_pad2(d.minute)}{_pad2(d.second)}"


async def perform_backup(prefix: str = "backup") -> str:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{prefix}-{backup_timestamp()}.dump"
    full = BACKUP_DIR / filename
    # Formato "custom" (-F c): comprimido e restauravel com pg_restore
    # (permite --clean/--if-exists na restauracao, ao contrario do -F p).
    await _run_cli("pg_dump", ["-d", settings.dsn(), "-F", "c", "-f", str(full)])
    return filename


def _iso_utc(epoch_seconds: float) -> str:
    # Equivalente a st.mtime.toISOString() do Node (sempre UTC, milissegundos,
    # sufixo "Z") -- usado no campo createdAt da listagem.
    return (
        datetime.fromtimestamp(epoch_seconds, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def list_backup_files() -> list:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for entry in BACKUP_DIR.iterdir():
        if entry.is_file() and entry.name.endswith(".dump"):
            st = entry.stat()
            out.append({
                "filename": entry.name,
                "sizeBytes": st.st_size,
                "createdAt": _iso_utc(st.st_mtime),
            })
    # Mesmo criterio do Node (comparacao de string, nao de data parseada) --
    # funciona porque createdAt e sempre ISO 8601, que ordena lexicograficamente
    # igual a ordem cronologica.
    out.sort(key=lambda r: r["createdAt"], reverse=True)
    return out


def resolve_backup_path(filename: Optional[str]) -> Optional[Path]:
    # So aceita um nome de arquivo puro (sem separadores/"..") que ja exista
    # dentro de BACKUP_DIR -- impede path traversal via parametro de rota.
    # Porta fiel do path.basename() do Node, incluindo o mesmo caso de
    # borda: filename=".." tambem passa nesta 1a checagem aqui (Path("..").name
    # == "..", igual ao path.basename("..") do Node) -- mas cai depois no
    # download/delete tentando agir sobre um DIRETORIO (o pai de BACKUP_DIR),
    # que falha com erro (nunca serve/apaga arquivo nenhum). Mesmo
    # comportamento do Node, nao uma falha de seguranca nova introduzida aqui.
    base = Path(str(filename or "")).name
    if not base or base != filename:
        return None
    full = BACKUP_DIR / base
    if not full.exists():
        return None
    return full


async def check_scheduled_backup() -> None:
    """Roda a cada minuto (ver scheduled_backup_loop) -- dispara o backup
    automatico quando o horario configurado bate com o horario atual,
    respeitando a frequencia. backupScheduleLastRunDate evita rodar mais de
    uma vez no mesmo dia. Porta 1:1 de checkScheduledBackup() (Node)."""
    try:
        pool = get_pool()
        if await _read_global_setting(pool, "backupScheduleEnabled", "0") != "1":
            return
        time_setting = await _read_global_setting(pool, "backupScheduleTime", "02:00")
        now = datetime.now()
        if f"{_pad2(now.hour)}:{_pad2(now.minute)}" != time_setting:
            return

        today_key = f"{now.year}-{_pad2(now.month)}-{_pad2(now.day)}"
        if await _read_global_setting(pool, "backupScheduleLastRunDate", "") == today_key:
            return

        frequency = await _read_global_setting(pool, "backupScheduleFrequency", "daily")
        if frequency == "weekly":
            raw = await _read_global_setting(pool, "backupScheduleWeeklyDays", "")
            days = [int(s.strip()) for s in raw.split(",") if s.strip()]
            # now.getDay() do JS: domingo=0 .. sabado=6. datetime.weekday()
            # do Python: segunda=0 .. domingo=6 -- conversao explicita abaixo.
            js_day = (now.weekday() + 1) % 7
            if js_day not in days:
                return
        elif frequency == "monthly":
            raw_day = await _read_global_setting(pool, "backupScheduleMonthlyDay", "1")
            configured_day = js_parse_int_or(raw_day, 1)
            # Ultimo dia do mes atual (equivalente a new Date(y, m+1, 0).getDate()).
            if now.month == 12:
                next_month_first = now.replace(year=now.year + 1, month=1, day=1)
            else:
                next_month_first = now.replace(month=now.month + 1, day=1)
            last_day_of_month = (next_month_first - timedelta(days=1)).day
            if now.day != min(configured_day, last_day_of_month):
                return

        filename = await perform_backup("scheduled")
        await _write_global_setting(pool, "backupScheduleLastRunDate", today_key)
        logger.info("[backup] Backup agendado criado: %s", filename)
    except Exception:  # noqa: BLE001
        logger.exception("[backup] Erro ao checar agendamento de backup")


async def scheduled_backup_loop() -> None:
    """Equivalente ao par setInterval(checkScheduledBackup, 60_000) +
    checkScheduledBackup() imediato do Node (ver server/index.js, fim da
    secao de backup) -- iniciado em app/main.py (lifespan) como uma
    asyncio.Task, cancelada no shutdown."""
    while True:
        await check_scheduled_backup()
        await asyncio.sleep(60)
