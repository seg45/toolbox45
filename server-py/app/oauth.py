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

from .config import settings
from .db import get_pool


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


async def reload_oauth_config() -> None:
    global google_config, microsoft_config
    pool = get_pool()
    rows = await pool.fetch("SELECT * FROM oauth_settings")
    by_provider = {row["provider"]: row for row in rows}

    g = by_provider.get("google")
    google_config = ProviderConfig(
        client_id=(g and g["client_id"]) or settings.google_client_id or None,
        client_secret=(g and g["client_secret"]) or settings.google_client_secret or None,
        redirect_uri=(g and g["redirect_uri"]) or settings.google_redirect_uri or None,
    )

    m = by_provider.get("microsoft")
    microsoft_config = ProviderConfig(
        client_id=(m and m["client_id"]) or settings.microsoft_client_id or None,
        client_secret=(m and m["client_secret"]) or settings.microsoft_client_secret or None,
        redirect_uri=(m and m["redirect_uri"]) or settings.microsoft_redirect_uri or None,
        tenant_id=(m and m["tenant_id"]) or settings.microsoft_tenant_id or "common",
    )
