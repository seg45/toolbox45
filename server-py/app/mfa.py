"""MFA por e-mail (segundo fator por codigo de 6 digitos) para contas LOCAIS.

Contas SSO (Google/Microsoft) nao passam por aqui: o MFA delas e do provedor.

Quando o login pede o codigo (ver `login_requirement`):
  * o usuario ligou (users.mfa_enabled), OU
  * um super admin EXIGIU: para a conta (users.mfa_required) ou para todos
    (security_settings 'mfa_require_all'). Quem e exigido e ainda nao ativou recebe o
    codigo no primeiro login e, ao digitar certo, o MFA fica ativo ("enrolling").
  * Sem SMTP utilizavel nao ha como mandar o codigo: o login segue sem MFA (e o evento
    `mfa_skipped` e gravado) -- e a tela de configuracao avisa o super admin. Preferimos
    isso a trancar todo mundo (inclusive o admin) para fora por causa do e-mail.

Cuidados: so o SHA-256 do codigo (com o id do desafio como sal) e do id do desafio vai
para o banco; codigo valido por 10 min, no maximo 5 tentativas por desafio, reenvio
com intervalo de 30 s e no maximo 3 vezes; comparacao em tempo constante.
"""
import hashlib
import hmac
import logging
import secrets
from typing import Optional, Tuple

from . import mailer
from .db import get_pool

logger = logging.getLogger("toolbox45")

CODE_TTL_MINUTES = 10
MAX_ATTEMPTS = 5
MAX_RESENDS = 3
RESEND_COOLDOWN_SECONDS = 30
REQUIRE_ALL_KEY = "mfa_require_all"


class MfaError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def _h(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _code_hash(challenge: str, code: str) -> str:
    return _h(f"{challenge}:{code}")


def mask_email(email: str) -> str:
    local, _, domain = (email or "").partition("@")
    if not domain:
        return "***"
    host, _, tld = domain.rpartition(".")
    return f"{local[:1]}***@{host[:1]}***.{tld}" if host else f"{local[:1]}***@***"


async def require_all() -> bool:
    v = await get_pool().fetchval("SELECT value FROM security_settings WHERE key = $1", REQUIRE_ALL_KEY)
    return v == "1"


async def set_require_all(value: bool, by: str) -> None:
    await get_pool().execute(
        """INSERT INTO security_settings (key, value, updated_at, updated_by) VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by""",
        REQUIRE_ALL_KEY, "1" if value else "0", by,
    )


async def is_required_for(row) -> bool:
    """O MFA e OBRIGATORIO para esta conta (flag individual ou politica global)?"""
    if not row["is_local"]:
        return False
    return bool(row["mfa_required"]) or await require_all()


async def login_requirement(row) -> Tuple[bool, bool]:
    """(pede_codigo, esta_ativando) para uma conta local que acabou de acertar a senha."""
    if not row["is_local"]:
        return (False, False)
    enabled = bool(row["mfa_enabled"])
    required = await is_required_for(row)
    if not (enabled or required):
        return (False, False)
    if not await mailer.is_configured():
        return (False, False)
    return (True, not enabled)


async def start_challenge(username: str, purpose: str) -> str:
    """Cria o desafio, manda o codigo por e-mail e devolve o id do desafio (segredo do
    cliente). Se o e-mail falhar, o desafio e apagado e MailError sobe."""
    cfg = await mailer.load_config()
    if not cfg:
        raise mailer.MailError("E-mail (SMTP) is not configured.")
    challenge = secrets.token_urlsafe(32)
    code = f"{secrets.randbelow(10 ** 6):06d}"
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM mfa_challenges WHERE (username = $1 AND purpose = $2) OR expires_at < NOW()", username, purpose)
            await conn.execute(
                "INSERT INTO mfa_challenges (challenge_hash, username, purpose, code_hash, expires_at) "
                "VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))",
                _h(challenge), username, purpose, _code_hash(challenge, code), CODE_TTL_MINUTES,
            )
    try:
        await _send_code(username, code, cfg)
    except mailer.MailError:
        await pool.execute("DELETE FROM mfa_challenges WHERE challenge_hash = $1", _h(challenge))
        raise
    return challenge


async def _send_code(username: str, code: str, cfg: dict) -> None:
    text = (
        f"Your Toolbox45 verification code is: {code}\n\n"
        f"It is valid for {CODE_TTL_MINUTES} minutes. If you did not try to sign in, change your password.\n"
    )
    html = (
        f"<p>Your Toolbox45 verification code is:</p><p style=\"font-size:24px;letter-spacing:4px\"><b>{code}</b></p>"
        f"<p><small>It is valid for {CODE_TTL_MINUTES} minutes. If you did not try to sign in, change your password.</small></p>"
    )
    await mailer.send_mail(username, f"Toolbox45 verification code: {code}", text, html, cfg=cfg)


async def resend(challenge: str, purpose: str) -> str:
    """Novo codigo no MESMO desafio (limite de reenvios e de intervalo). Devolve o usuario."""
    pool = get_pool()
    cfg = await mailer.load_config()
    if not cfg:
        raise MfaError("smtp_not_configured", "E-mail (SMTP) is not configured.", 503)
    code = f"{secrets.randbelow(10 ** 6):06d}"
    row = await pool.fetchrow(
        """UPDATE mfa_challenges SET code_hash = $3, resends = resends + 1, sent_at = NOW()
           WHERE challenge_hash = $1 AND purpose = $2 AND expires_at > NOW() AND resends < $4
             AND sent_at < NOW() - make_interval(secs => $5) RETURNING username""",
        _h(challenge), purpose, _code_hash(challenge, code), MAX_RESENDS, float(RESEND_COOLDOWN_SECONDS),
    )
    if not row:
        exists = await pool.fetchrow(
            "SELECT resends, sent_at FROM mfa_challenges WHERE challenge_hash = $1 AND purpose = $2 AND expires_at > NOW()",
            _h(challenge), purpose)
        if not exists:
            raise MfaError("invalid_challenge", "This verification expired. Sign in again.", 400)
        if exists["resends"] >= MAX_RESENDS:
            raise MfaError("too_many_resends", "Too many codes requested. Sign in again.", 429)
        raise MfaError("resend_too_soon", f"Wait {RESEND_COOLDOWN_SECONDS} seconds before asking for another code.", 429)
    try:
        await _send_code(row["username"], code, cfg)
    except mailer.MailError as err:
        raise MfaError("smtp_error", str(err), 502)
    return row["username"]


async def check(challenge: str, code: str, purpose: str) -> str:
    """Confere o codigo. Devolve o usuario e consome o desafio; senao MfaError.
    Cada chamada gasta 1 das 5 tentativas do desafio."""
    pool = get_pool()
    invalid = MfaError("invalid_code", "That code is not correct.", 400)
    expired = MfaError("invalid_challenge", "This verification expired. Sign in again.", 400)
    if not isinstance(challenge, str) or not (20 <= len(challenge) <= 128):
        raise expired
    clean = (code or "").strip().replace(" ", "")
    row = await pool.fetchrow(
        """UPDATE mfa_challenges SET attempts = attempts + 1
           WHERE challenge_hash = $1 AND purpose = $2 AND expires_at > NOW() AND attempts < $3
           RETURNING username, code_hash, attempts""",
        _h(challenge), purpose, MAX_ATTEMPTS,
    )
    if not row:
        await pool.execute("DELETE FROM mfa_challenges WHERE challenge_hash = $1 AND attempts >= $2", _h(challenge), MAX_ATTEMPTS)
        raise expired
    ok = bool(clean.isdigit() and len(clean) == 6 and hmac.compare_digest(row["code_hash"], _code_hash(challenge, clean)))
    if not ok:
        if row["attempts"] >= MAX_ATTEMPTS:
            await pool.execute("DELETE FROM mfa_challenges WHERE challenge_hash = $1", _h(challenge))
            raise MfaError("invalid_challenge", "Too many wrong codes. Sign in again.", 400)
        raise invalid
    # uso unico: so quem apagar a linha "ganha"
    gone = await pool.fetchval("DELETE FROM mfa_challenges WHERE challenge_hash = $1 RETURNING 1", _h(challenge))
    if not gone:
        raise expired
    return row["username"]


async def clear_user(username: str) -> None:
    await get_pool().execute("DELETE FROM mfa_challenges WHERE username = $1", username)
