"""GET /api/catalogs + CRUD de vendors/systems/versions/environments/topics/
parameters/prompts/exports -- porta 1:1 de server/index.js (~linhas
3672-4268).

TODAS as 27 rotas de escrita (POST/PUT/DELETE das 8 entidades) exigem
require_admin -- diferente de fatias anteriores como links/shares (self-
service) e igual em espirito a groups/users (mas aqui e "admin" comum, nao
"super_admin"). A UNICA excecao e a leitura: GET /api/catalogs so exige
require_user (qualquer usuario autenticado, sessao ou API key) -- todo
usuario ve o catalogo, so quem administra o cria/edita/exclui.

Hierarquia estrita: Vendor -> System -> Version (1:N encadeado). Environment
tambem exige um System (deriva/desnormaliza o vendor dele). Topic, Parameter,
Prompt e Export sao independentes (sem FK de pai). Version<->Environment e
Environment<->Topic sao vinculos N:N a parte (version_environments,
environment_topics), com rotas PUT dedicadas de "substituir tudo"
(replace_scope_links) que, excepcionalmente, NAO gravam audit log (unicas 2
rotas de escrita do dominio inteiro sem log_audit).

So ha UMA rota de leitura pra tudo isso -- GET /api/catalogs, que devolve as
8 tabelas + as 2 tabelas de vinculo de uma vez (usado no boot do front-end e
apos qualquer mutacao). Nao existe GET individual por entidade.

Exports (templates de redirecionamento tipo "> {{logFile}}") tem exatamente
o mesmo formato de Prompts (sem color, sem guarda de uso no DELETE) -- so
muda o nome da tabela/entidade.
"""
import asyncio

from fastapi import APIRouter, Body, Depends, HTTPException

from ..audit import log_audit, summarize_changed_fields
from ..catalog import CATALOG_KEY_RE, count_usage, is_int, key_exists, replace_scope_links, slugify_catalog_key, unique_catalog_key
from ..db import get_pool
from ..deps import CurrentUser, require_admin, require_user

router = APIRouter(tags=["catalog"])


# ════════════════════════════════════════════════
# GET /api/catalogs -- leitura em lote (a UNICA rota de leitura do dominio)
# ════════════════════════════════════════════════
@router.get("/api/catalogs")
async def get_catalogs(user: CurrentUser = Depends(require_user)) -> dict:
    pool = get_pool()
    (
        vendors, systems, versions, environments, topics, parameters, prompts, exports_cat,
        version_environments, environment_topics,
    ) = await asyncio.gather(
        pool.fetch("SELECT * FROM vendors ORDER BY sort_order, key"),
        pool.fetch("SELECT * FROM systems ORDER BY sort_order, key"),
        pool.fetch("SELECT * FROM versions ORDER BY sort_order, key"),
        pool.fetch("SELECT * FROM environments ORDER BY sort_order, key"),
        pool.fetch("SELECT * FROM topics ORDER BY sort_order, key"),
        pool.fetch("SELECT * FROM parameters ORDER BY sort_order, key"),
        pool.fetch("SELECT * FROM prompts ORDER BY sort_order, key"),
        pool.fetch("SELECT * FROM exports ORDER BY sort_order, key"),
        pool.fetch("SELECT version, environment FROM version_environments"),
        pool.fetch("SELECT environment, topic FROM environment_topics"),
    )
    return {
        "vendors": [dict(r) for r in vendors],
        "systems": [dict(r) for r in systems],
        "versions": [dict(r) for r in versions],
        "environments": [dict(r) for r in environments],
        "topics": [dict(r) for r in topics],
        "parameters": [dict(r) for r in parameters],
        "prompts": [dict(r) for r in prompts],
        "exports": [dict(r) for r in exports_cat],
        "version_environments": [dict(r) for r in version_environments],
        "environment_topics": [dict(r) for r in environment_topics],
    }


# ════════════════════════════════════════════════
# VENDORS -- parent: nenhum; child: systems
# ════════════════════════════════════════════════
@router.post("/api/vendors", status_code=201)
async def create_vendor(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    label = body.get("label")
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})
    color = body.get("color") or "#8B949E"

    pool = get_pool()
    key = await unique_catalog_key(slugify_catalog_key(label), lambda k: key_exists(pool, "vendors", k))
    max_order = await pool.fetchval("SELECT COALESCE(MAX(sort_order), -1) AS m FROM vendors")
    await pool.execute(
        "INSERT INTO vendors (key, label, color, sort_order) VALUES ($1, $2, $3, $4)",
        key, label, color, max_order + 1,
    )
    row = await pool.fetchrow("SELECT * FROM vendors WHERE key = $1", key)
    await log_audit(user["username"], "create", "vendor", key, label)
    return dict(row)


@router.put("/api/vendors/{key}")
async def update_vendor(key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM vendors WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Vendor '{key}' not found"})

    label = body.get("label") if body.get("label") is not None else existing["label"]
    color = body.get("color") if body.get("color") is not None else existing["color"]
    sort_order = body.get("sort_order") if is_int(body.get("sort_order")) else existing["sort_order"]
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})

    await pool.execute("UPDATE vendors SET label = $1, color = $2, sort_order = $3 WHERE key = $4", label, color, sort_order, key)
    row = await pool.fetchrow("SELECT * FROM vendors WHERE key = $1", key)
    details = summarize_changed_fields(existing, {"label": label, "color": color, "sort_order": sort_order}, {"label": "label", "color": "color", "sort_order": "order"})
    await log_audit(user["username"], "update", "vendor", key, label, details)
    return dict(row)


@router.delete("/api/vendors/{key}", status_code=204)
async def delete_vendor(key: str, user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM vendors WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Vendor '{key}' not found"})
    count = await count_usage(pool, "command_vendors", "vendor", key)
    if count > 0:
        raise HTTPException(status_code=409, detail={"error": "in_use", "message": f"Vendor '{key}' is used by {count} command(s)", "count": count})
    await pool.execute("DELETE FROM vendors WHERE key = $1", key)  # cascata: systems -> versions/environments
    await log_audit(user["username"], "delete", "vendor", key, existing["label"])


# ════════════════════════════════════════════════
# SYSTEMS -- parent: vendors (obrigatorio); child: versions, environments
# ════════════════════════════════════════════════
@router.post("/api/systems", status_code=201)
async def create_system(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    label = body.get("label")
    vendor = body.get("vendor")
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})
    if not vendor or not isinstance(vendor, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"vendor" is required'})
    color = body.get("color") or "#8B949E"

    pool = get_pool()
    if not await key_exists(pool, "vendors", vendor):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": f"Vendor '{vendor}' not found"})
    key = await unique_catalog_key(slugify_catalog_key(label), lambda k: key_exists(pool, "systems", k))
    max_order = await pool.fetchval("SELECT COALESCE(MAX(sort_order), -1) AS m FROM systems")
    await pool.execute(
        "INSERT INTO systems (key, vendor, label, color, sort_order) VALUES ($1, $2, $3, $4, $5)",
        key, vendor, label, color, max_order + 1,
    )
    row = await pool.fetchrow("SELECT * FROM systems WHERE key = $1", key)
    await log_audit(user["username"], "create", "system", key, label)
    return dict(row)


@router.put("/api/systems/{key}")
async def update_system(key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM systems WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"System '{key}' not found"})

    label = body.get("label") if body.get("label") is not None else existing["label"]
    color = body.get("color") if body.get("color") is not None else existing["color"]
    vendor = body.get("vendor") if body.get("vendor") is not None else existing["vendor"]
    sort_order = body.get("sort_order") if is_int(body.get("sort_order")) else existing["sort_order"]
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})
    if not vendor or not isinstance(vendor, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"vendor" is required'})
    if not await key_exists(pool, "vendors", vendor):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": f"Vendor '{vendor}' not found"})

    await pool.execute("UPDATE systems SET label = $1, color = $2, vendor = $3, sort_order = $4 WHERE key = $5", label, color, vendor, sort_order, key)
    # Reatribuir o vendor do Sistema mantem versions.vendor em sincronia (desnormalizado).
    await pool.execute("UPDATE versions SET vendor = $1 WHERE system = $2", vendor, key)
    row = await pool.fetchrow("SELECT * FROM systems WHERE key = $1", key)
    details = summarize_changed_fields(existing, {"label": label, "color": color, "vendor": vendor, "sort_order": sort_order}, {"label": "label", "color": "color", "vendor": "vendor", "sort_order": "order"})
    await log_audit(user["username"], "update", "system", key, label, details)
    return dict(row)


@router.delete("/api/systems/{key}", status_code=204)
async def delete_system(key: str, user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM systems WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"System '{key}' not found"})
    count = await count_usage(pool, "command_systems", "system", key)
    if count > 0:
        raise HTTPException(status_code=409, detail={"error": "in_use", "message": f"System '{key}' is used by {count} command(s)", "count": count})
    await pool.execute("DELETE FROM systems WHERE key = $1", key)  # cascata: versions, environments
    await log_audit(user["username"], "delete", "system", key, existing["label"])


# ════════════════════════════════════════════════
# VERSIONS -- parent: systems (obrigatorio, mutavel); PK composta (system, key)
# ════════════════════════════════════════════════
@router.post("/api/versions", status_code=201)
async def create_version(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    label = body.get("label")
    system = body.get("system")
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})
    if not system or not isinstance(system, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"system" is required'})
    color = body.get("color") or "#8B949E"

    pool = get_pool()
    system_row = await pool.fetchrow("SELECT * FROM systems WHERE key = $1", system)
    if not system_row:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": f"System '{system}' not found"})

    # UNIQUE(vendor, key) -- a checagem de unicidade precisa cobrir todo o vendor.
    async def _exists(k: str) -> bool:
        return await pool.fetchval("SELECT 1 FROM versions WHERE vendor = $1 AND key = $2", system_row["vendor"], k) is not None

    key = await unique_catalog_key(slugify_catalog_key(label), _exists)
    max_order = await pool.fetchval("SELECT COALESCE(MAX(sort_order), -1) AS m FROM versions")
    await pool.execute(
        "INSERT INTO versions (system, vendor, key, label, color, sort_order) VALUES ($1, $2, $3, $4, $5, $6)",
        system, system_row["vendor"], key, label, color, max_order + 1,
    )
    row = await pool.fetchrow("SELECT * FROM versions WHERE system = $1 AND key = $2", system, key)
    await log_audit(user["username"], "create", "version", key, label, f"System: {system}")
    return dict(row)


@router.put("/api/versions/{system}/{key}")
async def update_version(system: str, key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM versions WHERE system = $1 AND key = $2", system, key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Version '{key}' not found under system '{system}'"})

    label = body.get("label") if body.get("label") is not None else existing["label"]
    color = body.get("color") if body.get("color") is not None else existing["color"]
    sort_order = body.get("sort_order") if is_int(body.get("sort_order")) else existing["sort_order"]
    new_system = body.get("system") if body.get("system") is not None else system
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})

    new_vendor = existing["vendor"]
    if new_system != system:
        system_row = await pool.fetchrow("SELECT * FROM systems WHERE key = $1", new_system)
        if not system_row:
            raise HTTPException(status_code=400, detail={"error": "validation_error", "message": f"System '{new_system}' not found"})
        new_vendor = system_row["vendor"]
        dup1 = await pool.fetchval("SELECT 1 FROM versions WHERE system = $1 AND key = $2", new_system, key)
        if dup1 is not None:
            raise HTTPException(status_code=409, detail={"error": "conflict", "message": f"Version '{key}' already exists under system '{new_system}'"})
        dup2 = await pool.fetchval("SELECT 1 FROM versions WHERE vendor = $1 AND key = $2 AND system != $3", new_vendor, key, system)
        if dup2 is not None:
            raise HTTPException(status_code=409, detail={"error": "conflict", "message": f"Version '{key}' already exists under another system of vendor '{new_vendor}'"})

    await pool.execute(
        "UPDATE versions SET label = $1, color = $2, sort_order = $3, system = $4, vendor = $5 WHERE system = $6 AND key = $7",
        label, color, sort_order, new_system, new_vendor, system, key,
    )
    row = await pool.fetchrow("SELECT * FROM versions WHERE system = $1 AND key = $2", new_system, key)
    details = summarize_changed_fields(existing, {"label": label, "color": color, "sort_order": sort_order, "system": new_system}, {"label": "label", "color": "color", "sort_order": "order", "system": "system"})
    await log_audit(user["username"], "update", "version", key, label, details)
    return dict(row)


@router.delete("/api/versions/{system}/{key}", status_code=204)
async def delete_version(system: str, key: str, user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM versions WHERE system = $1 AND key = $2", system, key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Version '{key}' not found under system '{system}'"})
    count = await count_usage(pool, "command_versions", "version", key)
    if count > 0:
        raise HTTPException(status_code=409, detail={"error": "in_use", "message": f"Version '{key}' is used by {count} command(s)", "count": count})
    await pool.execute("DELETE FROM versions WHERE system = $1 AND key = $2", system, key)
    await log_audit(user["username"], "delete", "version", key, existing["label"], f"System: {system}")


# ════════════════════════════════════════════════
# ENVIRONMENTS -- parent: systems (obrigatorio, mutavel); vinculos N:N: versions, topics
# ════════════════════════════════════════════════
@router.post("/api/environments", status_code=201)
async def create_environment(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    label = body.get("label")
    system = body.get("system")
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})
    if not system or not isinstance(system, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"system" is required'})
    color = body.get("color") or "#8B949E"

    pool = get_pool()
    system_row = await pool.fetchrow("SELECT * FROM systems WHERE key = $1", system)
    if not system_row:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": f"System '{system}' not found"})
    key = await unique_catalog_key(slugify_catalog_key(label), lambda k: key_exists(pool, "environments", k))
    max_order = await pool.fetchval("SELECT COALESCE(MAX(sort_order), -1) AS m FROM environments")
    await pool.execute(
        "INSERT INTO environments (key, system, vendor, label, color, sort_order) VALUES ($1, $2, $3, $4, $5, $6)",
        key, system, system_row["vendor"], label, color, max_order + 1,
    )
    row = await pool.fetchrow("SELECT * FROM environments WHERE key = $1", key)
    await log_audit(user["username"], "create", "environment", key, label, f"System: {system}")
    return dict(row)


@router.put("/api/environments/{key}")
async def update_environment(key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM environments WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Environment '{key}' not found"})

    label = body.get("label") if body.get("label") is not None else existing["label"]
    color = body.get("color") if body.get("color") is not None else existing["color"]
    sort_order = body.get("sort_order") if is_int(body.get("sort_order")) else existing["sort_order"]
    new_system = body.get("system") if body.get("system") is not None else existing["system"]
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})
    if not new_system or not isinstance(new_system, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"system" is required'})

    new_vendor = existing["vendor"]
    system_changed = new_system != existing["system"]
    if system_changed:
        system_row = await pool.fetchrow("SELECT * FROM systems WHERE key = $1", new_system)
        if not system_row:
            raise HTTPException(status_code=400, detail={"error": "validation_error", "message": f"System '{new_system}' not found"})
        new_vendor = system_row["vendor"]

    await pool.execute(
        "UPDATE environments SET label = $1, color = $2, sort_order = $3, system = $4, vendor = $5 WHERE key = $6",
        label, color, sort_order, new_system, new_vendor, key,
    )
    if system_changed:
        # Os vinculos Versao<->Ambiente existentes foram registrados sob o
        # Sistema ANTERIOR -- trocar o Sistema do ambiente os deixaria
        # inconsistentes. Mais seguro resetar e deixar o administrador
        # revincular pela tela de Register (mesmo comportamento do Node).
        await pool.execute("DELETE FROM version_environments WHERE environment = $1", key)
    row = await pool.fetchrow("SELECT * FROM environments WHERE key = $1", key)
    details = summarize_changed_fields(existing, {"label": label, "color": color, "sort_order": sort_order, "system": new_system}, {"label": "label", "color": "color", "sort_order": "order", "system": "system"})
    await log_audit(user["username"], "update", "environment", key, label, details)
    return dict(row)


@router.delete("/api/environments/{key}", status_code=204)
async def delete_environment(key: str, user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM environments WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Environment '{key}' not found"})
    count = await count_usage(pool, "command_environments", "environment", key)
    if count > 0:
        raise HTTPException(status_code=409, detail={"error": "in_use", "message": f"Environment '{key}' is used by {count} command(s)", "count": count})
    await pool.execute("DELETE FROM environments WHERE key = $1", key)
    await log_audit(user["username"], "delete", "environment", key, existing["label"])


# ════════════════════════════════════════════════
# Vinculos N:N: Versao <-> Ambiente / Ambiente <-> Topico -- substituicao
# completa (delete+insert), SEM audit log (mesmo comportamento do Node --
# unicas 2 rotas de escrita do dominio inteiro que nao chamam log_audit).
# ════════════════════════════════════════════════
@router.put("/api/environments/{key}/versions")
async def set_environment_versions(key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    env = await pool.fetchrow("SELECT * FROM environments WHERE key = $1", key)
    if not env:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Environment '{key}' not found"})
    requested = body.get("versions") if isinstance(body.get("versions"), list) else []
    allowed = requested
    if env["system"] and requested:
        # So faz sentido vincular Ambiente a Versoes do MESMO Sistema --
        # filtra silenciosamente qualquer versao de outro Sistema, em vez de
        # recusar a chamada inteira por isso (mesmo comportamento do Node).
        valid_rows = await pool.fetch("SELECT key FROM versions WHERE system = $1 AND key = ANY($2)", env["system"], requested)
        allowed = [r["key"] for r in valid_rows]
    await replace_scope_links(pool, "version_environments", "environment", key, "version", allowed)
    rows = await pool.fetch("SELECT version FROM version_environments WHERE environment = $1", key)
    return {"environment": key, "versions": [r["version"] for r in rows]}


@router.put("/api/topics/{key}/environments")
async def set_topic_environments(key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    if not await key_exists(pool, "topics", key):
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Topic '{key}' not found"})
    await replace_scope_links(pool, "environment_topics", "topic", key, "environment", body.get("environments"))
    rows = await pool.fetch("SELECT environment FROM environment_topics WHERE topic = $1", key)
    return {"topic": key, "environments": [r["environment"] for r in rows]}


# ════════════════════════════════════════════════
# TOPICS -- parent: nenhum; flag is_protected (topico "environment" interno)
# ════════════════════════════════════════════════
@router.post("/api/topics", status_code=201)
async def create_topic(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    label = body.get("label")
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})
    color = body.get("color") or "#8B949E"

    pool = get_pool()
    key = await unique_catalog_key(slugify_catalog_key(label), lambda k: key_exists(pool, "topics", k))
    # sort_order MAX exclui topicos protegidos (o topico interno "environment").
    max_order = await pool.fetchval("SELECT COALESCE(MAX(sort_order), -1) AS m FROM topics WHERE is_protected = 0")
    await pool.execute(
        "INSERT INTO topics (key, label, color, sort_order, is_protected) VALUES ($1, $2, $3, $4, 0)",
        key, label, color, max_order + 1,
    )
    row = await pool.fetchrow("SELECT * FROM topics WHERE key = $1", key)
    await log_audit(user["username"], "create", "topic", key, label)
    return dict(row)


@router.put("/api/topics/{key}")
async def update_topic(key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM topics WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Topic '{key}' not found"})

    label = body.get("label") if body.get("label") is not None else existing["label"]
    color = body.get("color") if body.get("color") is not None else existing["color"]
    sort_order = body.get("sort_order") if is_int(body.get("sort_order")) else existing["sort_order"]
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})

    # is_protected nunca e alteravel por esta API.
    await pool.execute("UPDATE topics SET label = $1, color = $2, sort_order = $3 WHERE key = $4", label, color, sort_order, key)
    row = await pool.fetchrow("SELECT * FROM topics WHERE key = $1", key)
    details = summarize_changed_fields(existing, {"label": label, "color": color, "sort_order": sort_order}, {"label": "label", "color": "color", "sort_order": "order"})
    await log_audit(user["username"], "update", "topic", key, label, details)
    return dict(row)


@router.delete("/api/topics/{key}", status_code=204)
async def delete_topic(key: str, user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM topics WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Topic '{key}' not found"})
    # Ordem importa: protegido primeiro, uso depois (mesma ordem do Node).
    if existing["is_protected"]:
        raise HTTPException(status_code=409, detail={"error": "protected", "message": f"Topic '{key}' is a protected system topic and cannot be deleted"})
    count = await count_usage(pool, "command_topics", "topic", key)
    if count > 0:
        raise HTTPException(status_code=409, detail={"error": "in_use", "message": f"Topic '{key}' is used by {count} command(s)", "count": count})
    await pool.execute("DELETE FROM topics WHERE key = $1", key)
    await log_audit(user["username"], "delete", "topic", key, existing["label"])


# ════════════════════════════════════════════════
# PARAMETERS -- parent: nenhum; key CLIENT-SUPPLIED (unico caso no dominio);
# 2 tipos de guarda de delete (estrutural + uso via {{token}} no texto)
# ════════════════════════════════════════════════
async def _count_parameter_template_usage(pool, key: str) -> int:
    # Conta em quantos comandos DISTINTOS o placeholder {{key}} aparece de
    # verdade (linhas normais) -- escaneado em Python (nao SQL LIKE), mesma
    # tecnica do Node (command_lines.content pode ter qualquer coisa, e o
    # volume de linhas nao justifica otimizar isso agora).
    needle = "{{" + key + "}}"
    rows = await pool.fetch("SELECT command_id, content FROM command_lines")
    used_by = {r["command_id"] for r in rows if r["content"] and needle in r["content"]}
    return len(used_by)


async def _parameter_structural_dependency_count(pool, key: str) -> int:
    # 'ip'/'port' sao lidos DIRETO (nao via {{token}}) pela logica de estado
    # vazio do card (requires_ip_port em commands) -- exclui-los quebraria
    # essa logica pra todo comando marcado com a flag, mesmo que nenhum
    # {{ip}} literal apareca no texto.
    if key in ("ip", "port"):
        return await pool.fetchval("SELECT COUNT(*) AS n FROM commands WHERE requires_ip_port = 1") or 0
    return 0


@router.post("/api/parameters", status_code=201)
async def create_parameter(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    key = body.get("key")
    label = body.get("label")
    if not key or not isinstance(key, str) or not CATALOG_KEY_RE.match(key):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"key" is required (letters, numbers, dot, underscore, hyphen only)'})
    if not label:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})

    pool = get_pool()
    if await key_exists(pool, "parameters", key):
        raise HTTPException(status_code=409, detail={"error": "conflict", "message": f"Parameter '{key}' already exists"})
    sort_order_body = body.get("sort_order")
    if is_int(sort_order_body):
        order = sort_order_body
    else:
        max_order = await pool.fetchval("SELECT COALESCE(MAX(sort_order), -1) AS m FROM parameters")
        order = max_order + 1
    await pool.execute("INSERT INTO parameters (key, label, sort_order) VALUES ($1, $2, $3)", key, label, order)
    row = await pool.fetchrow("SELECT * FROM parameters WHERE key = $1", key)
    await log_audit(user["username"], "create", "parameter", key, label)
    return dict(row)


@router.put("/api/parameters/{key}")
async def update_parameter(key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM parameters WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Parameter '{key}' not found"})

    label = body.get("label") if body.get("label") is not None else existing["label"]
    sort_order = body.get("sort_order") if is_int(body.get("sort_order")) else existing["sort_order"]
    if not label:
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})

    # `key` nunca e alteravel por esta API.
    await pool.execute("UPDATE parameters SET label = $1, sort_order = $2 WHERE key = $3", label, sort_order, key)
    row = await pool.fetchrow("SELECT * FROM parameters WHERE key = $1", key)
    details = summarize_changed_fields(existing, {"label": label, "sort_order": sort_order}, {"label": "label", "sort_order": "order"})
    await log_audit(user["username"], "update", "parameter", key, label, details)
    return dict(row)


@router.delete("/api/parameters/{key}", status_code=204)
async def delete_parameter(key: str, user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM parameters WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Parameter '{key}' not found"})
    struct_count = await _parameter_structural_dependency_count(pool, key)
    if struct_count > 0:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "structural_dependency",
                "message": f"Parameter '{key}' is read directly by {struct_count} command(s)' empty-state logic (requires_ip_port) and cannot be deleted",
                "count": struct_count,
            },
        )
    usage = await _count_parameter_template_usage(pool, key)
    if usage > 0:
        raise HTTPException(status_code=409, detail={"error": "in_use", "message": f"Parameter '{key}' is used by {usage} command(s)", "count": usage})
    await pool.execute("DELETE FROM parameters WHERE key = $1", key)
    await log_audit(user["username"], "delete", "parameter", key, existing["label"])


# ════════════════════════════════════════════════
# PROMPTS -- parent: nenhum; sem coluna color; SEM guarda de uso no delete
# (command_lines.prompt e texto solto, nunca FK -- excluir do catalogo nunca
# altera comandos ja salvos, so tira a opcao do <select> do editor)
# ════════════════════════════════════════════════
@router.post("/api/prompts", status_code=201)
async def create_prompt(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    label = body.get("label")
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})

    pool = get_pool()
    key = await unique_catalog_key(slugify_catalog_key(label), lambda k: key_exists(pool, "prompts", k))
    max_order = await pool.fetchval("SELECT COALESCE(MAX(sort_order), -1) AS m FROM prompts")
    await pool.execute("INSERT INTO prompts (key, label, sort_order) VALUES ($1, $2, $3)", key, label, max_order + 1)
    row = await pool.fetchrow("SELECT * FROM prompts WHERE key = $1", key)
    await log_audit(user["username"], "create", "prompt", key, label)
    return dict(row)


@router.put("/api/prompts/{key}")
async def update_prompt(key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM prompts WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Prompt '{key}' not found"})

    label = body.get("label") if body.get("label") is not None else existing["label"]
    sort_order = body.get("sort_order") if is_int(body.get("sort_order")) else existing["sort_order"]
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})

    # `key` nunca e alteravel por esta API (mesma regra de parameters/vendors/etc.).
    await pool.execute("UPDATE prompts SET label = $1, sort_order = $2 WHERE key = $3", label, sort_order, key)
    row = await pool.fetchrow("SELECT * FROM prompts WHERE key = $1", key)
    details = summarize_changed_fields(existing, {"label": label, "sort_order": sort_order}, {"label": "label", "sort_order": "order"})
    await log_audit(user["username"], "update", "prompt", key, label, details)
    return dict(row)


@router.delete("/api/prompts/{key}", status_code=204)
async def delete_prompt(key: str, user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM prompts WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Prompt '{key}' not found"})
    await pool.execute("DELETE FROM prompts WHERE key = $1", key)
    await log_audit(user["username"], "delete", "prompt", key, existing["label"])

# ════════════════════════════════════════════════
# EXPORTS -- templates de redirecionamento de saida (ex.: "> {{logFile}}",
# "-w {{logFile}}") oferecidos no dropdown "Export" de cada linha 'cmd' do
# editor de comandos. Mesmo formato de PROMPTS (sem color, sem guarda de uso
# no DELETE -- command_lines.export_template guarda o TEXTO do template, nao
# uma FK) -- unica diferenca e o nome da entidade/tabela.
# ════════════════════════════════════════════════
@router.post("/api/exports", status_code=201)
async def create_export(body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    label = body.get("label")
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})

    pool = get_pool()
    key = await unique_catalog_key(slugify_catalog_key(label), lambda k: key_exists(pool, "exports", k))
    max_order = await pool.fetchval("SELECT COALESCE(MAX(sort_order), -1) AS m FROM exports")
    await pool.execute("INSERT INTO exports (key, label, sort_order) VALUES ($1, $2, $3)", key, label, max_order + 1)
    row = await pool.fetchrow("SELECT * FROM exports WHERE key = $1", key)
    await log_audit(user["username"], "create", "export", key, label)
    return dict(row)


@router.put("/api/exports/{key}")
async def update_export(key: str, body: dict = Body(default_factory=dict), user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM exports WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Export '{key}' not found"})

    label = body.get("label") if body.get("label") is not None else existing["label"]
    sort_order = body.get("sort_order") if is_int(body.get("sort_order")) else existing["sort_order"]
    if not label or not isinstance(label, str):
        raise HTTPException(status_code=400, detail={"error": "validation_error", "message": '"label" is required'})

    await pool.execute("UPDATE exports SET label = $1, sort_order = $2 WHERE key = $3", label, sort_order, key)
    row = await pool.fetchrow("SELECT * FROM exports WHERE key = $1", key)
    details = summarize_changed_fields(existing, {"label": label, "sort_order": sort_order}, {"label": "label", "sort_order": "order"})
    await log_audit(user["username"], "update", "export", key, label, details)
    return dict(row)


@router.delete("/api/exports/{key}", status_code=204)
async def delete_export(key: str, user: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    existing = await pool.fetchrow("SELECT * FROM exports WHERE key = $1", key)
    if not existing:
        raise HTTPException(status_code=404, detail={"error": "not_found", "message": f"Export '{key}' not found"})
    await pool.execute("DELETE FROM exports WHERE key = $1", key)
    await log_audit(user["username"], "delete", "export", key, existing["label"])
