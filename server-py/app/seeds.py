"""Seeds de dados padrao de uma instalacao nova -- porta 1:1 das funcoes
seedDefault*() de server/db.js, na MESMA ordem em que initDb() as chama.

Regra geral: cada seed de catalogo so semeia se a PROPRIA tabela estiver
totalmente vazia (nunca sobrescreve nem "reafirma" o que o administrador ja
cadastrou, editou ou excluiu pelo Register). Excecao: a pasta "Favorites"
usa ON CONFLICT DO NOTHING e e reafirmada a cada boot.

Cada seed tem seu proprio try/except: um erro numa seed e logado e as
seguintes continuam rodando (igual ao Node). Este modulo recebe o pool por
parametro e NAO importa nada de app.db (evita import circular).
"""
import logging

from .security import hash_password

logger = logging.getLogger("toolbox45")


# NAO existe mais conta padrao (antes: admin/admin). O primeiro super_admin e
# criado pela tela de configuracao inicial (POST /api/auth/setup, ver
# app/setup.py), com o e-mail e a senha que a pessoa escolher; uma instalacao
# antiga que ainda tem admin/admin e convertida na primeira visita.
# Garante que TODO usuario ja cadastrado tenha uma pasta "Favorites". Roda
# a cada boot, para cobrir as contas criadas desde o ultimo. Um unico INSERT ... SELECT,
# idempotente (ON CONFLICT (username, name) DO NOTHING) -- nunca duplica nem
# sobrescreve uma pasta "Favorites" que o usuario ja tenha.
async def seed_default_folders(pool) -> None:
    try:
        await pool.execute(
            """INSERT INTO folders (username, name) SELECT username, 'Favorites' FROM users
       ON CONFLICT (username, name) DO NOTHING"""
        )
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao semear pasta Favorites padrão para usuários existentes: %s", err)


# Semeia o catalogo de Prompts: um prompt Check Point (Expert/Clish) + dois
# Fortinet (CLI padrao / modo config). So roda numa instalacao nova (tabela
# vazia): um DELETE intencional do usuario nao pode "voltar" a cada boot
# (exceto se ele apagar TODOS os prompts, esvaziando a tabela de novo). Keys
# fixas -- evita depender de slugifyCatalogKey (server/index.js).
async def seed_default_prompts(pool) -> None:
    DEFAULTS = [
        {"key": "expert-fw", "label": "[Expert@FW]#"},
        {"key": "clish", "label": "clish>"},
        {"key": "fgt", "label": "FGT#"},
        {"key": "fgt-config", "label": "FGT(config)#"},
    ]
    try:
        n = await pool.fetchval("SELECT COUNT(*) AS n FROM prompts")
        if int(n) > 0:
            return  # instalacao ja tem prompts (seed anterior ou cadastrados manualmente)
        for i, d in enumerate(DEFAULTS):
            await pool.execute(
                "INSERT INTO prompts (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING",
                d["key"], d["label"], i,
            )
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao semear catálogo de Prompts padrão: %s", err)


# Semeia o catalogo de Exports -- mesmo principio de seed_default_prompts (so
# roda numa instalacao nova, tabela vazia). O unico item padrao reproduz
# EXATAMENTE o comportamento fixo que existia antes da feature (redirecionamento
# "> {{logFile}}"), ver tambem o backfill de command_lines.export_template em
# run_migrations() (mesmo texto usado la).
async def seed_default_exports(pool) -> None:
    DEFAULTS = [
        {"key": "redirect-logfile", "label": "> {{logFile}}"},
    ]
    try:
        n = await pool.fetchval("SELECT COUNT(*) AS n FROM exports")
        if int(n) > 0:
            return  # instalacao ja tem exports (seed anterior ou cadastrados manualmente)
        for i, d in enumerate(DEFAULTS):
            await pool.execute(
                "INSERT INTO exports (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING",
                d["key"], d["label"], i,
            )
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao semear catalogo de Exports padrao: %s", err)


# -- Catalogos padrao de uma instalacao nova (Vendor/System/Version/
# Environment/Parameter). Mesmo principio de seed_default_prompts (so semeia
# se a PROPRIA tabela estiver totalmente vazia). Keys fixas, ja em minusculas/
# hifenizadas no mesmo estilo que slugifyCatalogKey geraria a partir do label.
async def seed_default_vendors(pool) -> None:
    DEFAULTS = [
        {"key": "check-point", "label": "Check Point"},
        {"key": "fortinet", "label": "Fortinet"},
    ]
    try:
        n = await pool.fetchval("SELECT COUNT(*) AS n FROM vendors")
        if int(n) > 0:
            return
        for i, d in enumerate(DEFAULTS):
            await pool.execute(
                "INSERT INTO vendors (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING",
                d["key"], d["label"], i,
            )
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao semear catálogo de Vendors padrão: %s", err)


# Depende de vendors ja semeado (FK obrigatoria systems.vendor) -- chamada
# DEPOIS de seed_default_vendors() em run_seeds().
async def seed_default_systems(pool) -> None:
    DEFAULTS = [
        {"key": "gaia", "vendor": "check-point", "label": "Gaia"},
        {"key": "fortios", "vendor": "fortinet", "label": "FortiOS"},
    ]
    try:
        n = await pool.fetchval("SELECT COUNT(*) AS n FROM systems")
        if int(n) > 0:
            return
        for i, d in enumerate(DEFAULTS):
            await pool.execute(
                "INSERT INTO systems (key, vendor, label, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING",
                d["key"], d["vendor"], d["label"], i,
            )
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao semear catálogo de Systems padrão: %s", err)


# Depende de systems ja semeado (FK obrigatoria versions.system/vendor).
async def seed_default_versions(pool) -> None:
    DEFAULTS = [
        {"system": "gaia", "vendor": "check-point", "key": "r81.10", "label": "R81.10"},
        {"system": "gaia", "vendor": "check-point", "key": "r81.20", "label": "R81.20"},
        {"system": "gaia", "vendor": "check-point", "key": "r82", "label": "R82"},
        {"system": "gaia", "vendor": "check-point", "key": "r82.10", "label": "R82.10"},
        {"system": "fortios", "vendor": "fortinet", "key": "7.2", "label": "7.2"},
        {"system": "fortios", "vendor": "fortinet", "key": "7.4", "label": "7.4"},
        {"system": "fortios", "vendor": "fortinet", "key": "7.6", "label": "7.6"},
        {"system": "fortios", "vendor": "fortinet", "key": "8.0", "label": "8.0"},
    ]
    try:
        n = await pool.fetchval("SELECT COUNT(*) AS n FROM versions")
        if int(n) > 0:
            return
        for i, d in enumerate(DEFAULTS):
            await pool.execute(
                "INSERT INTO versions (system, vendor, key, label, sort_order) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (system, key) DO NOTHING",
                d["system"], d["vendor"], d["key"], d["label"], i,
            )
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao semear catálogo de Versions padrão: %s", err)


# Depende de systems ja semeado (FK obrigatoria environments.system/vendor).
# Roda DEPOIS de run_migrations() (que cuida do backfill de instalacoes ja
# existentes) -- numa instalacao nova a tabela chega vazia em ambos os casos.
async def seed_default_environments(pool) -> None:
    DEFAULTS = [
        {"system": "gaia", "vendor": "check-point", "key": "firewall", "label": "Firewall"},
        {"system": "gaia", "vendor": "check-point", "key": "management", "label": "Management"},
        {"system": "gaia", "vendor": "check-point", "key": "maestro", "label": "Maestro"},
        {"system": "gaia", "vendor": "check-point", "key": "multi-domain", "label": "Multi-Domain"},
        {"system": "gaia", "vendor": "check-point", "key": "vsx", "label": "VSX"},
        {"system": "fortios", "vendor": "fortinet", "key": "fortigate", "label": "FortiGate"},
        {"system": "fortios", "vendor": "fortinet", "key": "forticlient", "label": "FortiClient"},
        {"system": "fortios", "vendor": "fortinet", "key": "fortianalyzer", "label": "FortiAnalyzer"},
        {"system": "fortios", "vendor": "fortinet", "key": "fortimanager", "label": "FortiManager"},
        {"system": "fortios", "vendor": "fortinet", "key": "fortisase", "label": "FortiSASE"},
    ]
    try:
        n = await pool.fetchval("SELECT COUNT(*) AS n FROM environments")
        if int(n) > 0:
            return
        for i, d in enumerate(DEFAULTS):
            await pool.execute(
                "INSERT INTO environments (key, system, vendor, label, sort_order) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING",
                d["key"], d["system"], d["vendor"], d["label"], i,
            )
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao semear catálogo de Environments padrão: %s", err)


# Sem dependencia de FK -- independente da ordem em relacao aos 4 acima.
async def seed_default_parameters(pool) -> None:
    DEFAULTS = [
        {"key": "src_ip", "label": "Source"},
        {"key": "dst_ip", "label": "Destination"},
        {"key": "src_port", "label": "Source Port"},
        {"key": "dst_port", "label": "Destination Port"},
        {"key": "user", "label": "User"},
        {"key": "host", "label": "Host"},
        {"key": "license", "label": "License"},
        {"key": "signature", "label": "Signature"},
    ]
    try:
        n = await pool.fetchval("SELECT COUNT(*) AS n FROM parameters")
        if int(n) > 0:
            return
        for i, d in enumerate(DEFAULTS):
            await pool.execute(
                "INSERT INTO parameters (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING",
                d["key"], d["label"], i,
            )
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao semear catálogo de Parameters padrão: %s", err)


async def run_seeds(pool) -> None:
    """Executa todas as seeds na ordem exata do initDb() do Node. Ordem
    importa: vendors -> systems (FK vendor) -> versions/environments (FK
    system) -> parameters/prompts (independentes)."""
    await seed_default_folders(pool)
    await seed_default_vendors(pool)
    await seed_default_systems(pool)
    await seed_default_versions(pool)
    await seed_default_environments(pool)
    await seed_default_parameters(pool)
    await seed_default_prompts(pool)
    await seed_default_exports(pool)
