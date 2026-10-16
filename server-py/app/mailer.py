"""Envio de e-mail (SMTP) -- usado pelo "Esqueci a senha".

A configuracao mora na tabela `smtp_settings` (uma linha), editada por um super
admin em Settings → System → E-mail (SMTP). A senha do SMTP e cifrada em repouso
(app/secrets_box.py, contexto "smtp:password") e nunca volta pela API.

`send_mail` roda o smtplib (bloqueante) numa thread, com timeout, para nao travar
o event loop. Os erros viram `MailError` com mensagem curta e SEM segredos.
"""
import asyncio
import logging
import re
import smtplib
import socket
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from typing import Optional

from . import secrets_box
from .db import get_pool

logger = logging.getLogger("toolbox45")

SECURITY_MODES = ("starttls", "ssl", "none")
SMTP_TIMEOUT_SECONDS = 15
_CONTEXT = "smtp:password"
_HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class MailError(Exception):
    """Falha ao enviar/conectar. A mensagem e segura para mostrar ao admin."""


def password_context() -> str:
    return _CONTEXT


def valid_host(host: str) -> bool:
    return bool(_HOST_RE.match(host or ""))


def clean_header(value: str, limit: int = 200) -> str:
    """Remove quebras de linha/controle (injecao de cabecalho) e corta o tamanho."""
    return _CONTROL.sub(" ", value or "").strip()[:limit]


async def load_config() -> Optional[dict]:
    """Configuracao efetiva (senha ja decifrada) ou None se nao configurado /
    se a senha cifrada nao pode ser lida (chave ausente/errada)."""
    row = await get_pool().fetchrow("SELECT * FROM smtp_settings WHERE id = 1")
    if not row:
        return None
    try:
        password = secrets_box.decrypt(row["password"], _CONTEXT)
    except secrets_box.SecretUnavailable:
        logger.warning("SMTP: senha cifrada ilegivel (TOOLBOX45_SECRET_KEY ausente/diferente) -- e-mail desativado")
        return None
    return {
        "host": row["host"], "port": row["port"], "security": row["security"],
        "username": row["auth_user"], "password": password,
        "from_address": row["from_address"], "from_name": row["from_name"], "app_url": row["app_url"],
    }


async def is_configured() -> bool:
    return (await load_config()) is not None


def _send_sync(cfg: dict, to: str, subject: str, text: str, html: Optional[str]) -> None:
    msg = EmailMessage()
    msg["Subject"] = clean_header(subject, 200)
    msg["From"] = formataddr((clean_header(cfg.get("from_name") or "", 100), clean_header(cfg["from_address"], 254)))
    msg["To"] = clean_header(to, 254)
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")

    host, port, mode = cfg["host"], int(cfg["port"]), cfg["security"]
    ctx = ssl.create_default_context()
    try:
        if mode == "ssl":
            client = smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT_SECONDS, context=ctx)
        else:
            client = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT_SECONDS)
        with client:
            client.ehlo()
            if mode == "starttls":
                client.starttls(context=ctx)
                client.ehlo()
            if cfg.get("username"):
                client.login(cfg["username"], cfg.get("password") or "")
            client.send_message(msg)
    except smtplib.SMTPAuthenticationError as err:
        raise MailError("The SMTP server rejected the username/password.") from err
    except smtplib.SMTPRecipientsRefused as err:
        raise MailError("The SMTP server refused the recipient address.") from err
    except smtplib.SMTPSenderRefused as err:
        raise MailError("The SMTP server refused the sender (From) address.") from err
    except smtplib.SMTPNotSupportedError as err:
        raise MailError("The SMTP server does not support this security mode / authentication.") from err
    except ssl.SSLError as err:
        raise MailError("TLS/SSL error talking to the SMTP server (check the port and the security mode).") from err
    except (socket.gaierror, socket.timeout, TimeoutError, ConnectionError, OSError) as err:
        raise MailError(f"Could not reach {host}:{port} (check host, port and firewall).") from err
    except smtplib.SMTPException as err:
        raise MailError("The SMTP server returned an error.") from err


async def send_mail(to: str, subject: str, text: str, html: Optional[str] = None, cfg: Optional[dict] = None) -> None:
    cfg = cfg or await load_config()
    if not cfg:
        raise MailError("SMTP is not configured.")
    await asyncio.to_thread(_send_sync, cfg, to, subject, text, html)
