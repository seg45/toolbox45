"""Pool de conexoes PostgreSQL (asyncpg) + aplicacao de server/schema.sql no
boot -- mesmo comportamento do initDb() em server/db.js: schema.sql e
idempotente (CREATE TABLE IF NOT EXISTS), entao reexecuta-lo a cada start e
seguro.

Este backend roda contra o MESMO banco que o backend Node (ver
docker-compose.yml: PGHOST=toolbox45-db) durante a Fase 1/2 da migracao --
por isso, propositalmente, esta funcao NAO replica as funcoes de seed
(seedDefaultAdmin, seedDefaultVendors, etc.) nem as migracoes legadas de
dados (migrateCommandsIdToSerial) de server/db.js: numa instalacao ja em
producao elas ja rodaram pelo backend Node. Portar esse seeding so vira
necessario na Fase 4 (corte), quando este backend passa a ser responsavel
por uma instalacao nova do zero -- fica registrado aqui como pendencia
conhecida, nao esquecimento.
"""
import asyncio
import logging
from pathlib import Path
from typing import Optional

import asyncpg

from .config import settings

logger = logging.getLogger("toolbox45")

# server-py/app/db.py -> server-py/app -> server-py -> raiz do repo -> server/schema.sql
# (mesmo arquivo-fonte que o backend Node usa -- uma unica fonte de verdade
# para o schema enquanto os dois backends coexistirem)
SCHEMA_PATH = Path(__file__).resolve().parent.parent.parent / "server" / "schema.sql"

_pool: Optional[asyncpg.Pool] = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Pool do banco ainda nao foi inicializado (init_db() nao rodou)")
    return _pool


async def init_db(retries: int = 30, delay_seconds: float = 2.0) -> None:
    """Conecta ao Postgres e aplica schema.sql, tentando de novo por ate
    `retries` vezes -- mesmo racional do initDb() em server/db.js: no
    docker-compose, toolbox45-db pode ainda estar inicializando quando este
    backend sobe, mesmo com depends_on + healthcheck (e rede real)."""
    global _pool
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")

    last_error: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            _pool = await asyncpg.create_pool(dsn=settings.dsn(), min_size=1, max_size=10)
            async with _pool.acquire() as conn:
                # Sem parametros bind -> asyncpg usa o protocolo simples do
                # Postgres, que aceita multiplos statements separados por
                # ";" numa unica string (mesmo comportamento do pool.query()
                # do driver `pg` usado pelo backend Node em db.js).
                await conn.execute(schema_sql)
            logger.info("[db] Conectado ao PostgreSQL e schema aplicado.")
            return
        except Exception as err:  # noqa: BLE001 -- mesmo padrao amplo do try/catch em db.js
            last_error = err
            if _pool is not None:
                await _pool.close()
                _pool = None
            if attempt == retries:
                raise
            logger.warning(
                "[db] Falha ao conectar/aplicar schema (tentativa %s/%s): %s -- tentando de novo em %ss...",
                attempt, retries, err, delay_seconds,
            )
            await asyncio.sleep(delay_seconds)

    if last_error:  # inalcancavel (o raise acima ja sai do loop), so por clareza
        raise last_error


async def close_db() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
