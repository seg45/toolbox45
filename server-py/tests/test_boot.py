"""Testes do boot do backend Python (migracoes + seeds, portados de
server/db.js): init_db() em bancos NOVOS, em bancos "legados" (DDL minimo
embutido aqui, so o necessario a cada cenario) e ponta a ponta via FastAPI.

Python-only: nao depende de Node nem de nada fora do repositorio. Precisa de
um PostgreSQL alcancavel pelas variaveis PGHOST/PGPORT/PGUSER/PGPASSWORD (o
modulo inteiro e pulado se nao houver); cada teste cria o PROPRIO banco
(prefixo `p_`, nome unico) e o remove no final (DROP DATABASE ... FORCE).

Rodar a partir de server-py/:  python -m pytest tests/test_boot.py -v
"""
import asyncio
import logging
import os
import shutil
import sys
import uuid
from pathlib import Path
from urllib.parse import quote

import asyncpg
import pytest

# server-py/ no sys.path (ha `app/` la dentro) mesmo sem `python -m pytest`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db  # noqa: E402
from app.config import settings  # noqa: E402
from app.migrations import run_migrations  # noqa: E402
from app.security import hash_password, verify_password  # noqa: E402

# ════════════════════════════════════════════════
# Conexao com o Postgres (variaveis PG*) -- pula o modulo se inalcancavel
# ════════════════════════════════════════════════
_PG = {
    "host": os.environ.get("PGHOST", "localhost"),
    "port": int(os.environ.get("PGPORT", "5432")),
    "user": os.environ.get("PGUSER", "toolbox45"),
    "password": os.environ.get("PGPASSWORD", "toolbox45"),
}


def _kw(database):
    return {**_PG, "database": database}


async def _admin_connect():
    ultimo = None
    for nome in ("postgres", "template1"):
        try:
            return await asyncpg.connect(**_kw(nome), timeout=5)
        except Exception as err:  # noqa: BLE001
            ultimo = err
    raise ultimo


def _pg_alcancavel() -> bool:
    async def _t():
        conn = await _admin_connect()
        await conn.close()
    try:
        asyncio.run(_t())
        return True
    except Exception:  # noqa: BLE001
        return False


if not _pg_alcancavel():
    pytest.skip("PostgreSQL inalcancavel (PGHOST/PGPORT/PGUSER/PGPASSWORD)", allow_module_level=True)


def _dsn(database) -> str:
    return (f"postgresql://{quote(_PG['user'], safe='')}:{quote(_PG['password'], safe='')}"
            f"@{_PG['host']}:{_PG['port']}/{database}")


# ════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════
def sql(database, query, *args, fetch="all"):
    """Executa uma query num banco de teste (conexao propria, fechada ao
    final). fetch: 'all' (lista de Record), 'val', 'row' ou 'exec' (DDL/DML)."""
    async def _run():
        conn = await asyncpg.connect(**_kw(database))
        try:
            if fetch == "val":
                return await conn.fetchval(query, *args)
            if fetch == "row":
                return await conn.fetchrow(query, *args)
            if fetch == "exec":
                return await conn.execute(query, *args)
            return await conn.fetch(query, *args)
        finally:
            await conn.close()
    return asyncio.run(_run())


async def _boot():
    await db.init_db(retries=1)
    await db.close_db()


def boot():
    """Um boot completo (schema + migracoes + seeds) e fechamento do pool."""
    asyncio.run(_boot())


@pytest.fixture
def banco(monkeypatch):
    """Banco novo e vazio (so o database, sem tabelas), apontado em
    settings.database_url; removido no final do teste."""
    nome = f"p_t45_{uuid.uuid4().hex[:10]}"

    async def _criar():
        conn = await _admin_connect()
        try:
            await conn.execute(f'CREATE DATABASE "{nome}"')
        finally:
            await conn.close()

    async def _remover():
        conn = await _admin_connect()
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{nome}" WITH (FORCE)')
        finally:
            await conn.close()

    asyncio.run(_criar())
    monkeypatch.setattr(settings, "database_url", _dsn(nome))
    try:
        yield nome
    finally:
        asyncio.run(_remover())


def contagens(nome, *tabelas):
    return {t: sql(nome, f"SELECT COUNT(*) FROM {t}", fetch="val") for t in tabelas}


CATALOGOS = ("vendors", "systems", "versions", "environments", "parameters", "prompts", "exports")


def indices(nome):
    return {r["indexname"] for r in sql(nome, "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")}


def todas_contagens(nome):
    tabelas = [r["tablename"] for r in sql(nome, "SELECT tablename FROM pg_tables WHERE schemaname = 'public'")]
    return {t: sql(nome, f'SELECT COUNT(*) FROM "{t}"', fetch="val") for t in sorted(tabelas)}


# ── DDL legado minimo embutido (so o que cada cenario precisa) ──────────────
def ddl_legado_users() -> str:
    """users de uma era ANTIGA: sem auth_provider, handle e approved_at."""
    return """
    CREATE TABLE users (
      username      TEXT PRIMARY KEY,
      password_hash TEXT,
      role          TEXT NOT NULL DEFAULT 'user',
      is_local      INTEGER NOT NULL DEFAULT 0,
      disabled      INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by    TEXT
    );
    """


def ddl_legado_comandos(tipo_id: str, com_details: bool = False) -> str:
    """commands + dependentes de uma era antiga (about_* / raw_template /
    requires_ips / supports_export). tipo_id: 'TEXT' (slug) ou 'INTEGER'."""
    pk = "id TEXT PRIMARY KEY" if tipo_id == "TEXT" else "id SERIAL PRIMARY KEY"
    ref = f"command_id {tipo_id} NOT NULL REFERENCES commands(id) ON DELETE CASCADE"
    return f"""
    {ddl_legado_users()}
    CREATE TABLE commands (
      {pk},
      topic TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'x',
      sort_order INTEGER NOT NULL DEFAULT 0,
      requires_ips INTEGER NOT NULL DEFAULT 0,
      requires_ip_port INTEGER NOT NULL DEFAULT 0,
      placeholder_resolver TEXT,
      raw_template TEXT,
      name TEXT NOT NULL,
      name_empty TEXT,
      "desc" TEXT NOT NULL DEFAULT '',
      desc_empty TEXT,
      about_icon TEXT,
      about_purpose TEXT NOT NULL DEFAULT '',
      about_when TEXT NOT NULL DEFAULT '',
      about_obs TEXT NOT NULL DEFAULT '',
      {"details TEXT NOT NULL DEFAULT ''," if com_details else ""}
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by TEXT,
      modified_by TEXT
    );
    CREATE TABLE command_vendors (    {ref}, vendor TEXT NOT NULL,      PRIMARY KEY (command_id, vendor));
    CREATE TABLE command_systems (    {ref}, system TEXT NOT NULL,      PRIMARY KEY (command_id, system));
    CREATE TABLE command_versions (   {ref}, version TEXT NOT NULL,     PRIMARY KEY (command_id, version));
    CREATE TABLE command_environments ({ref}, environment TEXT NOT NULL, PRIMARY KEY (command_id, environment));
    CREATE TABLE command_topics (     {ref}, topic TEXT NOT NULL,       PRIMARY KEY (command_id, topic));
    CREATE TABLE command_lines (
      id SERIAL PRIMARY KEY,
      {ref},
      variant TEXT NOT NULL DEFAULT 'default',
      sort_order INTEGER NOT NULL DEFAULT 0,
      line_type TEXT NOT NULL DEFAULT 'cmd',
      prompt TEXT,
      content TEXT NOT NULL DEFAULT '',
      supports_export INTEGER NOT NULL DEFAULT 0,
      image_data TEXT
    );
    CREATE TABLE user_favorites (
      username TEXT NOT NULL,
      {ref},
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (username, command_id)
    );
    CREATE TABLE folders (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (username, name)
    );
    CREATE TABLE folder_commands (
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      {ref},
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (folder_id, command_id)
    );
    """


# ════════════════════════════════════════════════
# 1) Banco novo
# ════════════════════════════════════════════════
def test_banco_novo_semeia_catalogos_e_nao_cria_nenhum_usuario(banco):
    boot()

    # Nao existe mais conta padrao (admin/admin): o primeiro super_admin nasce na
    # configuracao inicial (POST /api/auth/setup), nunca no boot.
    assert sql(banco, "SELECT COUNT(*) FROM users", fetch="val") == 0
    assert sql(banco, "SELECT COUNT(*) FROM folders", fetch="val") == 0

    # Contagens do catalogo padrao
    assert contagens(banco, "vendors", "systems", "versions", "environments", "parameters", "prompts", "exports") == {
        "vendors": 2, "systems": 2, "versions": 8, "environments": 10, "parameters": 8, "prompts": 4, "exports": 1,
    }
    assert [r["key"] for r in sql(banco, "SELECT key FROM vendors ORDER BY sort_order")] == ["check-point", "fortinet"]
    assert [r["key"] for r in sql(banco, "SELECT key FROM prompts ORDER BY sort_order")] == [
        "expert-fw", "clish", "fgt", "fgt-config"]
    assert sql(banco, "SELECT key FROM exports", fetch="val") == "redirect-logfile"

    # Indices criados em run_migrations()
    idx = {r["indexname"]: r["indexdef"] for r in sql(
        banco, "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'")}
    for nome in ("idx_users_handle", "idx_environments_system", "idx_folders_parent", "idx_shares_grantee"):
        assert nome in idx, f"indice {nome} nao foi criado"
    assert idx["idx_users_handle"].startswith("CREATE UNIQUE INDEX")

    # Banco novo ja nasce com commands.id inteiro (sequencia padrao do SERIAL)
    assert sql(banco, "SELECT pg_get_serial_sequence('commands', 'id')", fetch="val") == "public.commands_id_seq"
    # e sem as colunas/tabelas legadas
    cols = {r["column_name"] for r in sql(banco, "SELECT column_name FROM information_schema.columns WHERE table_name = 'commands'")}
    assert "details" in cols
    assert not cols & {"about_purpose", "about_when", "about_obs", "about_icon", "raw_template", "requires_ips"}
    # migracao cpa-theme deixa a linha sentinela (uma vez)
    assert sql(banco, "SELECT COUNT(*) FROM user_data WHERE username = '__migrations__' AND data_key = 'cpa_theme_reset_v1'",
               fetch="val") == 1


# ════════════════════════════════════════════════
# 2) Idempotencia
# ════════════════════════════════════════════════
def test_init_db_duas_vezes_e_idempotente(banco):
    boot()
    cont1, idx1 = todas_contagens(banco), indices(banco)
    cat1 = {t: [tuple(r) for r in sql(banco, f"SELECT * FROM {t} ORDER BY 1, 2")] for t in ("parameters", "vendors", "prompts")}

    boot()
    assert todas_contagens(banco) == cont1
    assert indices(banco) == idx1
    assert sql(banco, "SELECT COUNT(*) FROM users", fetch="val") == 0  # boot nunca cria usuario
    assert {t: [tuple(r) for r in sql(banco, f"SELECT * FROM {t} ORDER BY 1, 2")] for t in ("parameters", "vendors", "prompts")} == cat1
    assert contagens(banco, *CATALOGOS)["versions"] == 8


def test_boot_nao_recria_nem_altera_usuarios_existentes(banco):
    boot()
    novo = hash_password("nova-senha-forte")
    sql(banco, """INSERT INTO users (username, password_hash, role, is_local, created_by, auth_provider, handle, approved_at)
                  VALUES ('dono@x.com', $1, 'super_admin', 1, 'setup', 'local', 'dono', NOW())""", novo, fetch="exec")
    boot()
    assert sql(banco, "SELECT password_hash FROM users WHERE username = 'dono@x.com'", fetch="val") == novo
    assert sql(banco, "SELECT COUNT(*) FROM users WHERE username = 'admin'", fetch="val") == 0  # 'admin' nunca volta


# ════════════════════════════════════════════════
# 3) Seeds so se a tabela estiver vazia (parametros fixos: excecao)
# ════════════════════════════════════════════════
def test_seeds_so_se_vazio_mas_parametros_fixos_sao_garantidos(banco):
    boot()

    # Vendors: apagar 1 NAO o reinsere (a tabela nao esta vazia).
    sql(banco, "DELETE FROM vendors WHERE key = 'fortinet'", fetch="exec")
    # Prompts: apagar 1 tambem nao volta.
    sql(banco, "DELETE FROM prompts WHERE key = 'fgt'", fetch="exec")
    # Parametros fixos: apagar 1 DOS 8 e reinserido (Bloco 4 de run_migrations,
    # fora do "so se vazio"), no FIM da ordenacao (max(sort_order) + 1).
    sql(banco, "DELETE FROM parameters WHERE key = 'host'", fetch="exec")
    assert contagens(banco, "vendors", "prompts", "parameters") == {"vendors": 1, "prompts": 3, "parameters": 7}
    sistemas_antes = contagens(banco, "systems", "versions", "environments")

    boot()

    assert [r["key"] for r in sql(banco, "SELECT key FROM vendors")] == ["check-point"]  # fortinet continua apagado
    assert "fgt" not in {r["key"] for r in sql(banco, "SELECT key FROM prompts")}
    assert contagens(banco, "prompts")["prompts"] == 3
    assert contagens(banco, "parameters")["parameters"] == 8  # 'host' voltou
    host = sql(banco, "SELECT label, sort_order FROM parameters WHERE key = 'host'", fetch="row")
    assert host["label"] == "Host"
    assert host["sort_order"] == 8  # appendado depois do maior sort_order (7)
    # systems/versions/environments restantes (os do check-point) nao foram tocados
    assert contagens(banco, "systems", "versions", "environments") == sistemas_antes


def test_esvaziar_tabela_inteira_reativa_o_seed(banco):
    """A regra e 'tabela totalmente vazia': apagar TODOS os prompts faz o seed
    voltar no proximo boot (comportamento herdado do Node)."""
    boot()
    sql(banco, "DELETE FROM prompts", fetch="exec")
    boot()
    assert contagens(banco, "prompts")["prompts"] == 4


# ════════════════════════════════════════════════
# 4) Guarda de approved_at
# ════════════════════════════════════════════════
def test_usuario_pendente_continua_pendente_apos_dois_boots(banco):
    boot()
    sql(banco, """INSERT INTO users (username, password_hash, role, is_local, disabled, created_by, auth_provider, handle)
                  VALUES ('pend@x.com', $1, 'user', 1, 1, 'self-registration', 'local', 'pend')""",
        hash_password("senha123"), fetch="exec")
    assert sql(banco, "SELECT approved_at FROM users WHERE username = 'pend@x.com'", fetch="val") is None

    boot()
    boot()
    u = sql(banco, "SELECT disabled, approved_at FROM users WHERE username = 'pend@x.com'", fetch="row")
    assert u["disabled"] == 1
    assert u["approved_at"] is None


def test_banco_legado_sem_approved_at_aprova_existentes_uma_vez(banco):
    # users legado: sem approved_at (nem handle/auth_provider)
    sql(banco, ddl_legado_users(), fetch="exec")
    sql(banco, """INSERT INTO users (username, password_hash, role, is_local, disabled, created_by)
                  VALUES ('antigo1@x.com', NULL, 'user', 1, 0, 'admin'),
                         ('antigo2@x.com', NULL, 'user', 1, 1, 'admin')""", fetch="exec")  # inclusive um desabilitado

    boot()
    for u in ("antigo1@x.com", "antigo2@x.com"):
        assert sql(banco, "SELECT approved_at FROM users WHERE username = $1", u, fetch="val") is not None, u
    # o backfill de approved_at usa created_at da conta (COALESCE(created_at, NOW()))
    assert sql(banco, "SELECT approved_at = created_at FROM users WHERE username = 'antigo1@x.com'", fetch="val") is True

    # Um usuario pendente criado DEPOIS (a coluna ja existe) nao e aprovado no boot seguinte
    sql(banco, """INSERT INTO users (username, role, is_local, disabled, created_by, auth_provider, handle)
                  VALUES ('novo@x.com', 'user', 1, 1, 'self-registration', 'local', 'novo')""", fetch="exec")
    boot()
    assert sql(banco, "SELECT approved_at FROM users WHERE username = 'novo@x.com'", fetch="val") is None
    assert sql(banco, "SELECT disabled FROM users WHERE username = 'novo@x.com'", fetch="val") == 1


def test_auth_provider_backfill_em_banco_legado(banco):
    sql(banco, ddl_legado_users(), fetch="exec")
    sql(banco, """INSERT INTO users (username, role, is_local, created_by) VALUES
                  ('local@x.com', 'user', 1, 'admin'), ('CORP\\bob', 'user', 0, NULL)""", fetch="exec")
    boot()
    got = {r["username"]: r["auth_provider"] for r in sql(banco, "SELECT username, auth_provider FROM users")}
    assert got["local@x.com"] == "local"   # is_local=1 -> 'local'
    assert got["CORP\\bob"] == "ntlm"      # DEFAULT preserva contas NTLM


# ════════════════════════════════════════════════
# 5) Backfill de handle
# ════════════════════════════════════════════════
def test_backfill_de_handle_com_colisao_e_indice_unico(banco):
    sql(banco, ddl_legado_users(), fetch="exec")
    # ordem de insercao = ordem fisica = ordem do SELECT sem ORDER BY do backfill
    sql(banco, """INSERT INTO users (username, role, is_local, created_by) VALUES
                  ('ana@a.com', 'user', 1, 'admin'),
                  ('ana@b.com', 'user', 1, 'admin'),
                  ('Joao.Silva+tag@x.com', 'user', 1, 'admin'),
                  ('a@x.com', 'user', 1, 'admin')""", fetch="exec")
    assert "handle" not in {r["column_name"] for r in sql(banco, "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")}

    boot()
    handles = {r["username"]: r["handle"] for r in sql(banco, "SELECT username, handle FROM users")}
    assert handles["ana@a.com"] == "ana"
    assert handles["ana@b.com"] == "ana-2"           # colisao -> sufixo -2
    assert handles["Joao.Silva+tag@x.com"] == "joao.silva-tag"  # slugify: caracteres invalidos viram '-'
    assert handles["a@x.com"] == "user-a"            # menos de 2 caracteres -> prefixo user-
    assert len(set(handles.values())) == len(handles)  # todos distintos

    # indice UNICO existe de verdade (duplicar handle e rejeitado)
    indexdef = sql(banco, "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_users_handle'", fetch="val")
    assert indexdef.startswith("CREATE UNIQUE INDEX")
    with pytest.raises(asyncpg.UniqueViolationError):
        sql(banco, "UPDATE users SET handle = 'ana' WHERE username = 'ana@b.com'", fetch="exec")


def test_backfill_de_handle_so_toca_quem_nao_tem(banco):
    boot()
    sql(banco, """INSERT INTO users (username, role, is_local, created_by, auth_provider, handle, approved_at)
                  VALUES ('ana@a.com', 'user', 1, 'admin', 'local', 'apelido-escolhido', NOW()),
                         ('ana@b.com', 'user', 1, 'admin', 'local', NULL, NOW())""", fetch="exec")
    boot()
    handles = {r["username"]: r["handle"] for r in sql(banco, "SELECT username, handle FROM users")}
    assert handles["ana@a.com"] == "apelido-escolhido"  # nunca sobrescreve um handle existente
    assert handles["ana@b.com"] == "ana"                # o slug livre


# ════════════════════════════════════════════════
# 6) commands.id TEXT -> INTEGER preservando vinculos
# ════════════════════════════════════════════════
def test_migracao_commands_id_text_para_integer(banco):
    sql(banco, ddl_legado_comandos("TEXT"), fetch="exec")
    sql(banco, """
        INSERT INTO commands (id, topic, name) VALUES ('cplic-print', 'licensing', 'cplic print'),
                                                      ('fwmonitor', 'monitoring', 'fw monitor');
        INSERT INTO command_vendors VALUES ('cplic-print', 'check-point');
        INSERT INTO command_systems VALUES ('cplic-print', 'gaia');
        INSERT INTO command_versions VALUES ('cplic-print', 'r82'), ('fwmonitor', 'r81.10');
        INSERT INTO command_environments VALUES ('fwmonitor', 'firewall');
        INSERT INTO command_topics VALUES ('cplic-print', 'licensing'), ('fwmonitor', 'monitoring');
        INSERT INTO command_lines (command_id, line_type, content) VALUES ('cplic-print', 'cmd', 'cplic print -A'),
                                                                          ('fwmonitor', 'cmd', 'fw monitor -e');
        INSERT INTO folders (username, name) VALUES ('ana@a.com', 'Pasta');
        INSERT INTO folder_commands (folder_id, command_id) VALUES (1, 'fwmonitor'), (1, 'cplic-print');
        INSERT INTO user_favorites (username, command_id) VALUES ('ana@a.com', 'fwmonitor');
    """, fetch="exec")

    boot()

    assert sql(banco, "SELECT data_type FROM information_schema.columns WHERE table_name = 'commands' AND column_name = 'id'",
               fetch="val") == "integer"
    assert {r["column_name"] for r in sql(banco, "SELECT column_name FROM information_schema.columns WHERE table_name = 'commands'")} \
        .isdisjoint({"id_seq", "about_purpose"})
    ids = {r["name"]: r["id"] for r in sql(banco, "SELECT id, name FROM commands")}
    assert sorted(ids.values()) == [1, 2]
    assert ids["cplic print"] != ids["fw monitor"]

    # vinculos preservados, agora por id inteiro
    def por_nome(q):
        return sorted(tuple(r) for r in sql(banco, q))
    assert por_nome("SELECT c.name, l.content FROM command_lines l JOIN commands c ON c.id = l.command_id") == [
        ("cplic print", "cplic print -A"), ("fw monitor", "fw monitor -e")]
    assert por_nome("SELECT c.name, x.vendor FROM command_vendors x JOIN commands c ON c.id = x.command_id") == [("cplic print", "check-point")]
    assert por_nome("SELECT c.name, x.system FROM command_systems x JOIN commands c ON c.id = x.command_id") == [("cplic print", "gaia")]
    assert por_nome("SELECT c.name, x.version FROM command_versions x JOIN commands c ON c.id = x.command_id") == [
        ("cplic print", "r82"), ("fw monitor", "r81.10")]
    assert por_nome("SELECT c.name, x.environment FROM command_environments x JOIN commands c ON c.id = x.command_id") == [("fw monitor", "firewall")]
    assert por_nome("SELECT c.name, x.topic FROM command_topics x JOIN commands c ON c.id = x.command_id") == [
        ("cplic print", "licensing"), ("fw monitor", "monitoring")]
    assert por_nome("SELECT f.name, c.name FROM folder_commands fc JOIN folders f ON f.id = fc.folder_id "
                    "JOIN commands c ON c.id = fc.command_id WHERE f.name = 'Pasta'") == [
        ("Pasta", "cplic print"), ("Pasta", "fw monitor")]
    assert por_nome("SELECT c.name FROM user_favorites u JOIN commands c ON c.id = u.command_id") == [("fw monitor",)]
    # favoritos legados viraram a pasta "Favorites" do usuario (Bloco 5), com o comando certo
    assert por_nome("SELECT c.name FROM folders f JOIN folder_commands fc ON fc.folder_id = f.id "
                    "JOIN commands c ON c.id = fc.command_id WHERE f.username = 'ana@a.com' AND f.name = 'Favorites'") == [("fw monitor",)]

    # FKs recriadas com ON DELETE CASCADE nas 8 dependentes + PK composta
    for tabela in ("command_vendors", "command_systems", "command_versions", "command_environments",
                   "command_topics", "command_lines", "folder_commands", "user_favorites"):
        fk = sql(banco, """SELECT confdeltype::text FROM pg_constraint
                           WHERE conname = $1 AND conrelid = $2::regclass AND confrelid = 'commands'::regclass""",
                 f"{tabela}_command_id_fkey", tabela, fetch="val")
        assert fk == "c", f"FK de {tabela} ausente ou sem CASCADE"
    pk = sql(banco, """SELECT pg_get_constraintdef(oid) FROM pg_constraint
                       WHERE conrelid = 'folder_commands'::regclass AND contype = 'p'""", fetch="val")
    assert pk == "PRIMARY KEY (folder_id, command_id)"

    # Sequencia final com o nome de uma instalacao nova, e continua de max(id)
    assert sql(banco, "SELECT pg_get_serial_sequence('commands', 'id')", fetch="val") == "public.commands_id_seq"
    assert sql(banco, "SELECT to_regclass('public.commands_id_seq_seq')", fetch="val") is None
    novo = sql(banco, "INSERT INTO commands (topic, name) VALUES ('x', 'novo') RETURNING id", fetch="val")
    assert novo == 3

    # ON DELETE CASCADE funciona de fato apos a recriacao
    sql(banco, "DELETE FROM commands WHERE id = $1", ids["fw monitor"], fetch="exec")
    assert contagens(banco, "command_lines")["command_lines"] == 1

    # segundo boot: nada muda
    antes = todas_contagens(banco)
    boot()
    assert todas_contagens(banco) == antes


def test_migracao_commands_id_e_atomica_quando_falha(banco):
    """Se algum passo da migracao falhar, a transacao desfaz TUDO (id continua
    TEXT) e o boot segue (erro logado, nao propagado)."""
    sql(banco, ddl_legado_comandos("TEXT"), fetch="exec")
    sql(banco, "INSERT INTO commands (id, topic, name) VALUES ('a', 't', 'a')", fetch="exec")
    # tabela extra com FK para commands(id) que a migracao NAO conhece: DROP CONSTRAINT commands_pkey falha
    sql(banco, "CREATE TABLE command_tags (id SERIAL PRIMARY KEY, command_id TEXT NOT NULL REFERENCES commands(id))", fetch="exec")
    boot()  # nao levanta
    assert sql(banco, "SELECT data_type FROM information_schema.columns WHERE table_name = 'commands' AND column_name = 'id'",
               fetch="val") == "text"
    assert sql(banco, "SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'commands' AND column_name = 'id_seq'",
               fetch="val") == 0  # rollback: a coluna auxiliar nao ficou pendurada
    # o resto dos blocos rodou: command_tags (legada) foi removida pelo Bloco 1 -> o 2o boot converge
    assert sql(banco, "SELECT to_regclass('public.command_tags')", fetch="val") is None
    boot()
    assert sql(banco, "SELECT data_type FROM information_schema.columns WHERE table_name = 'commands' AND column_name = 'id'",
               fetch="val") == "integer"


# ════════════════════════════════════════════════
# 7) about_* -> details, linhas 'note', supports_export
# ════════════════════════════════════════════════
def test_migracao_about_para_details_e_notas(banco):
    sql(banco, ddl_legado_comandos("INTEGER", com_details=True), fetch="exec")
    sql(banco, """
        INSERT INTO commands (id, topic, name, about_purpose, about_when, about_obs) VALUES
          (1, 't', 'A', E'Mostra licencas & <contratos>\\n\\nSegundo paragrafo\\nlinha 2', 'Quando validar', ''),
          (2, 't', 'B', '', '', ''),
          (3, 't', 'C', '', '', ''),
          (4, 't', 'D', '', '', 'obs existente'),
          (5, 't', 'E', '', '   ', ''),
          (6, 't', 'F', 'texto antigo', '', '');
        UPDATE commands SET details = '<p>meu details</p>' WHERE id = 6;
        INSERT INTO command_lines (command_id, sort_order, line_type, content) VALUES
          (3, 0, 'note', 'nota um'),
          (3, 1, 'note', 'nota dois & <fim>'),
          (3, 2, 'cmd',  'show version'),
          (4, 0, 'note', 'extra'),
          (1, 0, 'cmd',  'cplic print');
    """, fetch="exec")
    sql(banco, "SELECT setval(pg_get_serial_sequence('commands', 'id'), 6)", fetch="val")

    boot()

    details = {r["name"]: r["details"] for r in sql(banco, "SELECT name, details FROM commands")}
    assert details["A"] == (
        "<p><strong>Purpose</strong></p><p>Mostra licencas &amp; &lt;contratos&gt;</p>"
        "<p>Segundo paragrafo<br>linha 2</p>"
        "<p><strong>When to use</strong></p><p>Quando validar</p>")
    assert details["B"] == ""
    # linhas 'note' foram movidas para o about_obs ANTES da conversao para details
    assert details["C"] == "<p><strong>Note</strong></p><p>nota um<br>nota dois &amp; &lt;fim&gt;</p>"
    assert details["D"] == "<p><strong>Note</strong></p><p>obs existente</p><p>extra</p>"
    assert details["E"] == ""                      # so espacos: nao migra
    assert details["F"] == "<p>meu details</p>"    # nunca sobrescreve um details ja escrito

    cols = {r["column_name"] for r in sql(banco, "SELECT column_name FROM information_schema.columns WHERE table_name = 'commands'")}
    assert not cols & {"about_purpose", "about_when", "about_obs", "about_icon", "raw_template", "requires_ips"}
    assert "details" in cols

    # linhas 'note' removidas; as demais ficam
    tipos = sorted(r["line_type"] for r in sql(banco, "SELECT line_type FROM command_lines"))
    assert tipos == ["cmd", "cmd"]

    # segundo boot nao altera nada
    boot()
    assert {r["name"]: r["details"] for r in sql(banco, "SELECT name, details FROM commands")} == details


def test_migracao_supports_export_para_export_template(banco):
    sql(banco, ddl_legado_comandos("INTEGER"), fetch="exec")
    sql(banco, """
        INSERT INTO commands (id, topic, name) VALUES (1, 't', 'A');
        INSERT INTO command_lines (command_id, sort_order, line_type, content, supports_export) VALUES
          (1, 0, 'cmd', 'exportavel', 1), (1, 1, 'cmd', 'comum', 0);
    """, fetch="exec")
    boot()
    cols = {r["column_name"] for r in sql(banco, "SELECT column_name FROM information_schema.columns WHERE table_name = 'command_lines'")}
    assert "supports_export" not in cols and "export_template" in cols
    got = {r["content"]: r["export_template"] for r in sql(banco, "SELECT content, export_template FROM command_lines")}
    assert got == {"exportavel": "> {{logFile}}", "comum": None}


def test_migracao_audit_log_renomeia_colunas(banco):
    sql(banco, """CREATE TABLE audit_log (
        id SERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), username TEXT,
        action TEXT NOT NULL, command_id TEXT, command_name TEXT);
        INSERT INTO audit_log (username, action, command_id, command_name) VALUES ('admin', 'create', 'x1', 'cmd x');""",
        fetch="exec")
    boot()
    r = sql(banco, "SELECT entity_type, entity_id, entity_name, details FROM audit_log", fetch="row")
    assert (r["entity_type"], r["entity_id"], r["entity_name"], r["details"]) == ("command", "x1", "cmd x", None)
    cols = {c["column_name"] for c in sql(banco, "SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log'")}
    assert not cols & {"command_id", "command_name"}


def test_role_admin_legado_vira_super_admin(banco):
    sql(banco, ddl_legado_users(), fetch="exec")
    sql(banco, """INSERT INTO users (username, password_hash, role, is_local, created_by) VALUES
                  ('admin', 'aa:bb', 'admin', 1, 'system'),
                  ('bob@x.com', NULL, 'admin', 1, 'admin'),
                  ('carol@x.com', NULL, 'user', 1, 'admin')""", fetch="exec")
    boot()
    roles = {r["username"]: r["role"] for r in sql(banco, "SELECT username, role FROM users")}
    assert roles == {"admin": "super_admin", "bob@x.com": "admin", "carol@x.com": "user"}
    # a senha preexistente do admin legado nao e regravada
    assert sql(banco, "SELECT password_hash FROM users WHERE username = 'admin'", fetch="val") == "aa:bb"


def test_limpeza_cpa_theme_roda_uma_unica_vez(banco):
    boot()
    sql(banco, "INSERT INTO user_data (username, data_key, value) VALUES ('admin', 'cpa-theme', 'dark')", fetch="exec")
    boot()  # sentinela ja existe -> nao apaga a preferencia escolhida depois da limpeza
    assert sql(banco, "SELECT value FROM user_data WHERE username = 'admin' AND data_key = 'cpa-theme'", fetch="val") == "dark"


def test_limpeza_cpa_theme_em_banco_legado_apaga_uma_vez(banco):
    sql(banco, """CREATE TABLE user_data (username TEXT NOT NULL, data_key TEXT NOT NULL, value TEXT NOT NULL,
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (username, data_key));
                  INSERT INTO user_data (username, data_key, value) VALUES ('ana', 'cpa-theme', 'dark'), ('ana', 'lang', 'pt');""",
        fetch="exec")
    boot()
    assert [r["data_key"] for r in sql(banco, "SELECT data_key FROM user_data WHERE username = 'ana'")] == ["lang"]


# ════════════════════════════════════════════════
# 8) Isolamento de erro entre blocos
# ════════════════════════════════════════════════
class _PoolComFalha:
    """Proxy do pool que levanta uma excecao quando execute() recebe uma
    instrucao contendo `trecho` (comparado com espacos normalizados); tudo
    mais delega ao pool real."""

    def __init__(self, pool, trecho):
        self._pool = pool
        self._trecho = " ".join(trecho.split())

    async def execute(self, query, *args, **kw):
        if self._trecho in " ".join(query.split()):
            raise RuntimeError(f"falha injetada em: {self._trecho}")
        return await self._pool.execute(query, *args, **kw)

    def __getattr__(self, nome):
        return getattr(self._pool, nome)


def _injetar_falha(monkeypatch, trecho):
    async def _run(pool):
        await run_migrations(_PoolComFalha(pool, trecho))
    monkeypatch.setattr(db, "run_migrations", _run)


def test_erro_num_bloco_e_logado_e_blocos_seguintes_rodam(banco, monkeypatch, caplog):
    boot()
    sql(banco, "DELETE FROM parameters WHERE key = 'host'", fetch="exec")  # sera reinserido pelo Bloco 4 (posterior)
    sql(banco, "DELETE FROM shares", fetch="exec")

    _injetar_falha(monkeypatch, "ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT")
    with caplog.at_level(logging.INFO, logger="toolbox45"):
        boot()  # nao propaga a excecao

    erros = [r for r in caplog.records if r.name == "toolbox45" and r.levelno == logging.ERROR]
    msgs = [r.getMessage() for r in erros]
    assert any("Falha ao migrar users.handle / criar tabela shares" in m and "falha injetada" in m for m in msgs), msgs
    # so o bloco 2 falhou: nenhum outro erro de bloco foi logado
    assert len(erros) == 1, msgs
    # blocos POSTERIORES ainda rodaram: parametro fixo garantido (Bloco 4) e seeds
    assert sql(banco, "SELECT COUNT(*) FROM parameters WHERE key = 'host'", fetch="val") == 1


def test_erro_aborta_so_o_resto_do_mesmo_bloco(banco, monkeypatch, caplog):
    boot()
    # conta 'admin' LEGADA (instalacao antiga) rebaixada: o boot normal a reforca como super_admin
    sql(banco, """INSERT INTO users (username, password_hash, role, is_local, created_by, auth_provider, handle, approved_at)
                  VALUES ('admin', $1, 'admin', 1, 'system', 'local', 'admin', NOW())""", hash_password("admin"), fetch="exec")
    sql(banco, "DELETE FROM parameters WHERE key = 'host'", fetch="exec")

    # 1a instrucao do Bloco 1: o RESTO do bloco (incluindo o reforco de super_admin) nao roda...
    _injetar_falha(monkeypatch, "ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider")
    with caplog.at_level(logging.INFO, logger="toolbox45"):
        boot()
    msgs = [r.getMessage() for r in caplog.records if r.name == "toolbox45" and r.levelno == logging.ERROR]
    assert any("Falha ao rodar migrações" in m and "falha injetada" in m for m in msgs), msgs
    assert sql(banco, "SELECT role FROM users WHERE username = 'admin'", fetch="val") == "admin"
    # ...mas os blocos seguintes rodaram normalmente
    assert sql(banco, "SELECT COUNT(*) FROM parameters WHERE key = 'host'", fetch="val") == 1

    # sem a falha injetada, o proximo boot reforca o role
    monkeypatch.setattr(db, "run_migrations", run_migrations)
    boot()
    assert sql(banco, "SELECT role FROM users WHERE username = 'admin'", fetch="val") == "super_admin"


def test_erro_numa_seed_nao_impede_as_seguintes(banco, caplog):
    """Cada seed tem o proprio try/except: uma que falha (aqui, `systems`
    renomeada -> relacao inexistente) loga o erro e as seguintes rodam."""
    boot()
    sql(banco, "DELETE FROM parameters", fetch="exec")
    sql(banco, "DELETE FROM prompts", fetch="exec")
    sql(banco, "ALTER TABLE systems RENAME TO systems_x", fetch="exec")
    with caplog.at_level(logging.INFO, logger="toolbox45"):
        asyncio.run(_run_seeds_only())
    msgs = [r.getMessage() for r in caplog.records if r.name == "toolbox45" and r.levelno == logging.ERROR]
    assert len(msgs) == 1 and "Systems" in msgs[0], msgs
    # seeds POSTERIORES a de systems (parameters, prompts) ainda rodaram
    assert contagens(banco, "parameters", "prompts") == {"parameters": 8, "prompts": 4}


async def _run_seeds_only():
    from app.seeds import run_seeds
    pool = await asyncpg.create_pool(dsn=settings.dsn(), min_size=1, max_size=2)
    try:
        await run_seeds(pool)
    finally:
        await pool.close()


# ════════════════════════════════════════════════
# 9) Ponta a ponta: lifespan do FastAPI contra banco novo
# ════════════════════════════════════════════════
def test_ponta_a_ponta_lifespan_login_e_catalogos(banco, monkeypatch, tmp_path):
    if shutil.which("openssl") is None:
        pytest.skip("openssl nao encontrado (necessario ao bootstrap TLS do lifespan)")
    from fastapi.testclient import TestClient

    tls_dir, backup_dir = tmp_path / "tls", tmp_path / "backups"
    monkeypatch.setenv("TLS_DIR", str(tls_dir))
    monkeypatch.setenv("BACKUP_DIR", str(backup_dir))

    from app import backup, tls
    from app.main import app

    # TLS_DIR/BACKUP_DIR sao lidos no IMPORT dos modulos; se app.* ja foi
    # importado antes (outro teste/arquivo), as constantes precisam ser
    # redirecionadas explicitamente.
    monkeypatch.setattr(tls, "TLS_DIR", tls_dir)
    monkeypatch.setattr(tls, "TLS_CERT_PATH", tls_dir / "cert.pem")
    monkeypatch.setattr(tls, "TLS_KEY_PATH", tls_dir / "key.pem")
    monkeypatch.setattr(tls, "TLS_BACKUP_DIR", tls_dir / "backup")
    monkeypatch.setattr(backup, "BACKUP_DIR", backup_dir)

    with TestClient(app) as client:  # aciona o lifespan (init_db + oauth + TLS + job de backup)
        r = client.get("/api/health")
        assert r.status_code == 200
        assert r.json() == {"ok": True}

        # sem sessao: catalogo exige login
        assert client.get("/api/catalogs").status_code == 401
        # credencial errada
        assert client.post("/api/auth/login", json={"username": "admin", "password": "errada"}).status_code == 401
        # corpo sem campos -> 400 validation_error (contrato do Node)
        r = client.post("/api/auth/login", json={})
        assert r.status_code == 400 and r.json()["error"] == "validation_error"

        # instalacao nova: a conta admin/admin NAO existe (login recusado) e a
        # tela de primeiro acesso esta pendente
        assert client.post("/api/auth/login", json={"username": "admin", "password": "admin"}).status_code == 401
        assert client.get("/api/auth/setup-status").json() == {"required": True, "mode": "fresh"}
        r = client.post("/api/auth/setup", json={"email": "dono@empresa.com", "password": "senha-do-dono-1"})
        assert r.status_code == 200, r.text
        assert r.json() == {"username": "dono@empresa.com", "role": "super_admin", "mode": "fresh"}
        assert client.get("/api/auth/setup-status").json() == {"required": False, "mode": None}
        client.cookies.clear()
        r = client.post("/api/auth/login", json={"username": "dono@empresa.com", "password": "senha-do-dono-1"})
        assert r.status_code == 200
        assert r.json() == {"username": "dono@empresa.com", "role": "super_admin"}
        assert "tb45_session" in client.cookies
        assert len(client.cookies.get("tb45_session")) == 64  # token_hex(32)

        r = client.get("/api/catalogs")  # com o cookie da sessao
        assert r.status_code == 200
        cat = r.json()
        assert [v["key"] for v in cat["vendors"]] == ["check-point", "fortinet"]
        assert [s["key"] for s in cat["systems"]] == ["gaia", "fortios"]
        assert len(cat["versions"]) == 8 and len(cat["environments"]) == 10
        assert len(cat["parameters"]) == 8 and len(cat["prompts"]) == 4 and len(cat["exports"]) == 1

    # bootstrap TLS gerou cert/key nos diretorios temporarios (openssl real)
    assert (tls_dir / "cert.pem").exists() and (tls_dir / "key.pem").exists()
    # a sessao ficou registrada no banco do teste
    assert sql(banco, "SELECT COUNT(*) FROM sessions WHERE username = 'dono@empresa.com'", fetch="val") >= 1
