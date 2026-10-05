"""Configuracao via variaveis de ambiente: PGHOST/PGPORT/PGDATABASE/PGUSER/
PGPASSWORD, com DATABASE_URL como alternativa (mesmas variaveis do backend
Node que este backend substituiu no corte da Fase 4, entao o .env e o
docker-compose.yml existentes continuam valendo).
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

    # Porta HTTP deste backend (a imagem Docker sobe o uvicorn na 8000).
    port: int = 8000

    # OAuth (Google/Microsoft) -- variaveis de ambiente (ver docker-compose.yml).
    # Este e so o valor de ambiente: a config EFETIVA (banco `oauth_settings`,
    # ajustavel em Settings -> System -> OAuth, tem precedencia sobre estas
    # variaveis) e resolvida em app/oauth.py.
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
