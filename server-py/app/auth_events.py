"""Registro de eventos de acesso (login, falha, bloqueio, setup, senha, OAuth).

Auditoria de seguranca (out/2026): o `audit_log` cobre alteracoes de dados
(comandos, usuarios...) e guarda 30 dias; nao dizia quem tentou entrar, de onde,
nem quando uma conta foi bloqueada. Esta tabela (`auth_events`) responde isso, com
retencao propria de 180 dias, e so o super admin consulta (GET /api/auth-events).

Eventos gravados (coluna `event`):
  login_success | login_failed | login_blocked | setup_completed | register |
  password_changed | password_change_failed | password_change_blocked |
  password_reset_by_admin | oauth_login | oauth_pending | oauth_failed

Cuidados:
  * NUNCA grava senha, hash, token ou cookie -- so quem (usuario), de onde (IP),
    com qual navegador (user-agent cortado) e um motivo curto.
  * O "usuario" de um login que falhou e texto digitado por qualquer um: so e
    gravado se parecer um e-mail (gente digita a senha no campo de usuario); senao
    fica "(formato invalido)". Tamanho e caracteres de controle sao tratados.
  * Uma falha ao gravar NUNCA derruba a rota (mesmo padrao do audit_log).
  * Contra enchente (alguem martelando o login): `login_blocked` repetido para o
    mesmo (IP, usuario) grava no maximo 1 linha por minuto, e a limpeza apaga
    o que passou de 180 dias e, se passar de MAX_ROWS, as linhas mais antigas.
"""
import logging
import re
import time
from typing import Dict, Optional, Tuple

from .db import get_pool
from .login_guard import client_ip

logger = logging.getLogger("toolbox45")

RETENTION_DAYS = 180
MAX_ROWS = 200_000
_PURGE_EVERY_SECONDS = 600
_BLOCKED_DEDUPE_SECONDS = 60

EVENTS = (
    "login_success", "login_failed", "login_blocked", "setup_completed", "register",
    "password_changed", "password_change_failed", "password_change_blocked",
    "password_reset_by_admin", "oauth_login", "oauth_pending", "oauth_failed",
)

_EMAIL_LIKE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_last_purge = float("-inf")
_blocked_seen: Dict[Tuple[str, str], float] = {}


def safe_username(value: Optional[str], *, require_email: bool = False) -> Optional[str]:
    """Limpa um nome de usuario vindo da rede antes de gravar."""
    if not value:
        return None
    v = _CONTROL.sub("", str(value)).strip()[:254]
    if not v:
        return None
    if require_email and not _EMAIL_LIKE.match(v):
        return "(formato invalido)"
    return v


def _clean(value: Optional[str], limit: int) -> Optional[str]:
    if not value:
        return None
    v = _CONTROL.sub(" ", str(value)).strip()[:limit]
    return v or None


async def log_auth_event(
    event: str,
    *,
    request=None,
    username: Optional[str] = None,
    detail: Optional[str] = None,
    ip: Optional[str] = None,
    require_email: bool = False,
) -> None:
    """Grava um evento. `request` fornece IP e user-agent (opcional)."""
    try:
        if event == "login_blocked":
            key = ((ip or (client_ip(request) if request is not None else "?")), (username or "").lower())
            now = time.monotonic()
            if now - _blocked_seen.get(key, -1e9) < _BLOCKED_DEDUPE_SECONDS:
                return
            if len(_blocked_seen) > 5000:
                _blocked_seen.clear()
            _blocked_seen[key] = now
        if ip is None and request is not None:
            ip = client_ip(request)
        ua = request.headers.get("user-agent") if request is not None else None
        pool = get_pool()
        await pool.execute(
            "INSERT INTO auth_events (event, username, ip, user_agent, detail) VALUES ($1,$2,$3,$4,$5)",
            event,
            safe_username(username, require_email=require_email),
            _clean(ip, 64),
            _clean(ua, 200),
            _clean(detail, 300),
        )
        await _maybe_purge(pool)
    except Exception as err:  # noqa: BLE001
        logger.error("log_auth_event failed: %s", err)


async def _maybe_purge(pool) -> None:
    global _last_purge
    now = time.monotonic()
    if now - _last_purge < _PURGE_EVERY_SECONDS:
        return
    _last_purge = now
    await purge(pool)


async def purge(pool) -> None:
    """Apaga o que passou da retencao e, se ainda passar de MAX_ROWS, as mais antigas."""
    await pool.execute(f"DELETE FROM auth_events WHERE ts < NOW() - INTERVAL '{RETENTION_DAYS} days'")
    total = await pool.fetchval("SELECT COUNT(*) FROM auth_events")
    if total and int(total) > MAX_ROWS:
        await pool.execute(
            "DELETE FROM auth_events WHERE id IN (SELECT id FROM auth_events ORDER BY id LIMIT $1)",
            int(total) - MAX_ROWS,
        )
