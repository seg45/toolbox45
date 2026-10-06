"""Config efetiva de OAuth (Google/Microsoft) -- porta de
reloadOAuthConfig() em server/index.js. Uma linha em `oauth_settings`
(configurada pela UI, Settings -> System -> OAuth Integrations -- rotas
GET/PUT/DELETE /api/system/oauth/:provider, ainda NAO portadas, ficam pra
fatia 9 "Sistema") tem prioridade sobre a variavel de ambiente
correspondente; sem linha, cai pro valor de ambiente.

Assim como no Node, isto e recarregado uma vez no boot (ver app/main.py,
lifespan) -- NAO fica observando a tabela em tempo real. Ate a fatia 9
portar as rotas de escrita de /api/system/oauth, uma configuracao mudada
pela UI (que ainda so existe no backend Node) so e enxergada por este
backend no proximo restart do container -- mesma janela de staleness que
ja existia no proprio Node entre um PUT e o proximo boot de UM SO
processo, só que aqui (sem as rotas de escrita ainda) so fecha reiniciando
o container.
"""
from dataclasses import dataclass
from typing import Optional

import logging

from . import secrets_box
from .config import settings
from .db import get_pool

logger = logging.getLogger("toolbox45")


@dataclass
class ProviderConfig:
    client_id: Optional[str]
    client_secret: Optional[str]
    redirect_uri: Optional[str]
    tenant_id: Optional[str] = None

    @property
    def enabled(self) -> bool:
        return bool(self.client_id and self.client_secret and self.redirect_uri)


def _env_only() -> "tuple[ProviderConfig, ProviderConfig]":
    google = ProviderConfig(
        client_id=settings.google_client_id or None,
        client_secret=settings.google_client_secret or None,
        redirect_uri=settings.google_redirect_uri or None,
    )
    microsoft = ProviderConfig(
        client_id=settings.microsoft_client_id or None,
        client_secret=settings.microsoft_client_secret or None,
        redirect_uri=settings.microsoft_redirect_uri or None,
        tenant_id=settings.microsoft_tenant_id or "common",
    )
    return google, microsoft


# Valor inicial (só variáveis de ambiente) até reload_oauth_config() rodar
# no boot (ver lifespan em app/main.py) -- mesma sequência do Node (as
# variáveis let GOOGLE_CLIENT_ID etc. também nascem só do ambiente, e só
# viram a versão "com banco" depois do reloadOAuthConfig() no startup IIFE).
google_config, microsoft_config = _env_only()


def secret_context(provider: str) -> str:
    """Dado autenticado (AAD) da cifra: amarra o ciphertext a linha do provedor."""
    return f"oauth:{provider}"


def _db_row_usable(row, provider: str):
    """(linha, secret em texto puro). Se o secret gravado esta cifrado e nao da para
    ler (chave ausente/errada), a linha INTEIRA e ignorada -- misturar o client_id
    do banco com o secret da variavel de ambiente seria uma credencial invalida."""
    if not row:
        return None, None
    try:
        return row, secrets_box.decrypt(row["client_secret"], secret_context(provider))
    except secrets_box.SecretUnavailable as err:
        logger.error(
            "[oauth] o secret de %s no banco nao pode ser lido (%s): o login %s fica indisponivel "
            "ate a chave certa ser configurada ou o secret ser salvo de novo em Settings -> System -> OAuth.",
            provider, err, provider,
        )
        return None, None


async def reload_oauth_config() -> None:
    global google_config, microsoft_config
    pool = get_pool()
    rows = await pool.fetch("SELECT * FROM oauth_settings")
    by_provider = {row["provider"]: row for row in rows}

    g, g_secret = _db_row_usable(by_provider.get("google"), "google")
    google_config = ProviderConfig(
        client_id=(g and g["client_id"]) or settings.google_client_id or None,
        client_secret=g_secret or settings.google_client_secret or None,
        redirect_uri=(g and g["redirect_uri"]) or settings.google_redirect_uri or None,
    )

    m, m_secret = _db_row_usable(by_provider.get("microsoft"), "microsoft")
    microsoft_config = ProviderConfig(
        client_id=(m and m["client_id"]) or settings.microsoft_client_id or None,
        client_secret=m_secret or settings.microsoft_client_secret or None,
        redirect_uri=(m and m["redirect_uri"]) or settings.microsoft_redirect_uri or None,
        tenant_id=(m and m["tenant_id"]) or settings.microsoft_tenant_id or "common",
    )


async def encrypt_legacy_secrets() -> int:
    """Cifra, uma unica vez, os secrets que ainda estao em texto puro (instalacao
    anterior a esta auditoria). So age com TOOLBOX45_SECRET_KEY configurada; sem ela
    apenas avisa. Devolve quantas linhas converteu."""
    problem = secrets_box.key_problem()
    if problem:
        logger.warning("[oauth] %s", problem)
    pool = get_pool()
    rows = await pool.fetch(
        "SELECT provider, client_secret FROM oauth_settings WHERE client_secret IS NOT NULL AND client_secret NOT LIKE $1",
        secrets_box.PREFIX + "%",
    )
    if not rows:
        return 0
    if not secrets_box.key_configured():
        logger.warning(
            "[oauth] %d secret(s) OAuth em TEXTO PURO no banco (e nos backups): defina %s no .env "
            "(scripts/init-secret-key.sh) e reinicie o backend para cifrar.", len(rows), secrets_box.KEY_ENV,
        )
        return 0
    n = 0
    for row in rows:
        enc = secrets_box.encrypt(row["client_secret"], secret_context(row["provider"]))
        await pool.execute(
            "UPDATE oauth_settings SET client_secret = $1 WHERE provider = $2 AND client_secret = $3",
            enc, row["provider"], row["client_secret"],
        )
        n += 1
    logger.info("[oauth] %d secret(s) OAuth cifrado(s) em repouso (AES-256-GCM)", n)
    return n
