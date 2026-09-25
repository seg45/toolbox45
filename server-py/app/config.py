"""Configuracao via variaveis de ambiente -- mesma convencao do backend Node
atual (server/db.js): PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD, com
DATABASE_URL como alternativa. Isso permite apontar este backend Python para
o MESMO banco Postgres que o backend Node ja usa (ver plano de migracao no
Project toolbox45: Fase 1 valida o Python contra o banco de producao antes
de qualquer corte).
"""
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    pghost: str = "toolbox45-db"
    pgport: int = 5432
    pgdatabase: str = "toolbox45"
    pguser: str = "toolbox45"
    pgpassword: str = "toolbox45"
    database_url: Optional[str] = None

    # Porta HTTP deste backend Python. Propositalmente DIFERENTE da porta do
    # backend Node (3000) e ainda nao referenciada em docker-compose.yml --
    # este servico roda isolado ate a Fase 2 (validacao lado a lado).
    port: int = 8000

    # OAuth (Google/Microsoft) -- mesmas variaveis de ambiente do Node (ver
    # docker-compose.yml). Usadas por enquanto so por GET /api/auth/providers
    # (fatia 2), pra refletir corretamente se estao configuradas -- os
    # endpoints /api/auth/google*/microsoft* em si ainda nao existem neste
    # backend (fatia 3 do roadmap). NAO reflete a config vinda do banco
    # (system_settings, ajustavel pela UI em Settings -> System -> OAuth
    # Integrations) -- isso fica pra quando a fatia 9 (Sistema) portar essa
    # rota; enquanto isso, só a variavel de ambiente decide aqui, igual ao
    # comportamento do Node antes de aplicar o override do banco.
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = ""
    microsoft_client_id: str = ""
    microsoft_client_secret: str = ""
    microsoft_redirect_uri: str = ""
    microsoft_tenant_id: str = "common"

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret and self.google_redirect_uri)

    @property
    def microsoft_enabled(self) -> bool:
        return bool(self.microsoft_client_id and self.microsoft_client_secret and self.microsoft_redirect_uri)

    def dsn(self) -> str:
        if self.database_url:
            return self.database_url
        return (
            f"postgresql://{self.pguser}:{self.pgpassword}"
            f"@{self.pghost}:{self.pgport}/{self.pgdatabase}"
        )


settings = Settings()
