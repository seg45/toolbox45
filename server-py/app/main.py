"""Toolbox45 -- backend Python (FastAPI), Fase 1 da migracao (ver plano no
Project toolbox45: "Backend novo primeiro, front depois").

Nesta fatia (Fase 1, fatia 1 -- infra basica): so sobe o FastAPI, conecta no
mesmo Postgres do backend Node, aplica server/schema.sql (idempotente) e
expoe GET /api/health com o MESMO contrato do Node ({"ok": true} -- ver
server/index.js linha 63), para o frontend antigo (inalterado) poder ser
apontado pra ca na Fase 2 sem notar diferenca nesta rota. As demais ~93
rotas do server/index.js ainda nao existem aqui -- ver roadmap no plano de
migracao (Project toolbox45).
"""
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from . import db

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # GET /api/health so responde depois disto completar -- mesmo
    # comportamento do backend Node (initDb() roda antes de app.listen(),
    # ver server/index.js) -- importante porque o healthcheck do
    # docker-compose depende disso pra saber quando o servico esta pronto.
    await db.init_db()
    yield
    await db.close_db()


app = FastAPI(title="Toolbox45 API (Python)", version="0.1.0-fase1", lifespan=lifespan)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True}
