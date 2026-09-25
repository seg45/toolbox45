"""Toolbox45 -- backend Python (FastAPI), Fase 1 da migracao (ver plano no
Project toolbox45: "Backend novo primeiro, front depois").

Fatia 1 (infra basica): sobe o FastAPI, conecta no mesmo Postgres do
backend Node, aplica server/schema.sql (idempotente) e expoe GET
/api/health com o MESMO contrato do Node ({"ok": true} -- ver
server/index.js linha 63).

Fatia 2 (auth local): POST /api/auth/login, POST /api/auth/logout, POST
/api/auth/register, GET /api/auth/providers (ver app/routers/auth.py) --
compatibilidade de hash de senha (scrypt) com os usuarios locais ja
cadastrados validada em producao (ver app/security.py).

Fatia 3 (OAuth Google/Microsoft): GET /api/auth/google[/callback], GET
/api/auth/microsoft[/callback] (ver app/routers/oauth.py) -- reaproveita a
MESMA tabela sessions/cookie tb45_session da fatia 2. Config efetiva
(banco > variavel de ambiente, ver app/oauth.py) recarregada uma vez no
boot, logo depois de init_db().

Fatia 4 (/api/me + /api/commands): GET/PUT /api/me* (ver
app/routers/me.py) e GET/POST/PUT/DELETE /api/commands* (ver
app/routers/commands.py) -- o nucleo funcional do app (a tela principal
inteira depende de GET /api/commands). Introduz a infraestrutura de
autenticacao/autorizacao compartilhada por TODA rota protegida daqui em
diante (app/deps.py: API key > sessao, require_user/require_admin/
require_super_admin) e o log de auditoria compartilhado (app/audit.py).

Fatia 5 (pastas + notas): GET/POST/PUT/DELETE /api/folders* (17 rotas, ver
app/routers/folders.py e app/routers/notes.py) -- arvore de subpastas
(self-referencing parent_id), drag-and-drop (mover pasta/comando/nota sem
sair da pasta-mae, ver get_root_ancestor_id() em app/folders.py),
copiar/exportar/importar pasta inteira (recursivo) e as notas dentro de
pasta (reaproveita sanitize_note_html(), ja portado na fatia 4).

As demais ~63 rotas do server/index.js ainda nao existem aqui -- ver
roadmap no plano de migracao (Project toolbox45).
"""
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import db, oauth
from .routers import auth as auth_router
from .routers import commands as commands_router
from .routers import folders as folders_router
from .routers import me as me_router
from .routers import notes as notes_router
from .routers import oauth as oauth_router

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # GET /api/health so responde depois disto completar -- mesmo
    # comportamento do backend Node (initDb() roda antes de app.listen(),
    # ver server/index.js) -- importante porque o healthcheck do
    # docker-compose depende disso pra saber quando o servico esta pronto.
    await db.init_db()
    # Carrega a config efetiva de OAuth (banco > ambiente -- ver
    # app/oauth.py) DEPOIS do pool existir, mesma ordem do
    # reloadOAuthConfig() no startup IIFE do Node.
    await oauth.reload_oauth_config()
    yield
    await db.close_db()


app = FastAPI(title="Toolbox45 API (Python)", version="0.1.0-fase5", lifespan=lifespan)


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
app.include_router(oauth_router.router)
app.include_router(me_router.router)
app.include_router(commands_router.router)
app.include_router(folders_router.router)
app.include_router(notes_router.router)


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True}
