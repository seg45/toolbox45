"""Toolbox45 -- backend Python (FastAPI), Fase 1 da migracao (ver plano no
Project toolbox45: "Backend novo primeiro, front depois").

Fatia 1 (infra basica): sobe o FastAPI, conecta no mesmo Postgres do
backend Node, aplica server/schema.sql (idempotente) e expoe GET
/api/health com o MESMO contrato do Node ({"ok": true} -- ver
server/index.js linha 63).

Fatia 2 (auth local): POST /api/auth/login, POST /api/auth/logout, POST
/api/auth/register, GET /api/auth/providers (ver app/routers/auth.py) --
compatibilidade de hash de senha (scrypt) com os usuarios locais ja
cadastrados validada nesta maquina (ver app/security.py) antes de subir.

As demais ~89 rotas do server/index.js ainda nao existem aqui -- ver
roadmap no plano de migracao (Project toolbox45).
"""
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import db
from .routers import auth as auth_router

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


app = FastAPI(title="Toolbox45 API (Python)", version="0.1.0-fase2", lifespan=lifespan)


# ════════════════════════════════════════════════
# Contrato de erro -- TODA rota de negocio do backend Node responde erro
# como {"error": "<codigo>", "message": "<texto>"} direto no corpo (ver
# server/index.js, ex.: res.status(400).json({error:'validation_error',...})).
# O default do FastAPI para HTTPException e diferente: envelopa em
# {"detail": ...}. Os dois handlers abaixo achatam isso de volta pro
# formato do Node -- infraestrutura pra TODAS as rotas, atuais e futuras:
# toda rota nova deve levantar HTTPException(status_code=..., detail={
# "error": "...", "message": "..."}) pra manter o contrato 1:1.
# ════════════════════════════════════════════════
@app.exception_handler(HTTPException)
async def flat_http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict):
        return JSONResponse(status_code=exc.status_code, content=exc.detail, headers=exc.headers)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": "error", "message": str(exc.detail)},
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    # Rede de seguranca: as rotas de auth ja validam campos manualmente (ver
    # app/routers/auth.py) pra cair nos codigos exatos do Node, mas se
    # algum corpo malformado escapar disso (ex.: JSON invalido), ainda
    # assim volta no formato {error, message} em vez do formato padrao
    # (lista de erros) do FastAPI.
    return JSONResponse(status_code=400, content={"error": "validation_error", "message": str(exc)})


app.include_router(auth_router.router)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True}
