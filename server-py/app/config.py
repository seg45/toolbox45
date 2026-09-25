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

    def dsn(self) -> str:
        if self.database_url:
            return self.database_url
        return (
            f"postgresql://{self.pguser}:{self.pgpassword}"
            f"@{self.pghost}:{self.pgport}/{self.pgdatabase}"
        )


settings = Settings()
