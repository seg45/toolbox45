"""Migracoes idempotentes de schema/dados executadas a cada boot -- porta 1:1 de
migrateCommandsIdToSerial() e runMigrations() em server/db.js.

`CREATE TABLE IF NOT EXISTS` (schema.sql) nao altera uma tabela que ja existe
de um deploy anterior, entao colunas/constraints/tabelas adicionadas depois da
criacao inicial de uma instalacao precisam de um ALTER/DROP explicito aqui.
TUDO neste modulo e seguro rodar em todo boot, inclusive numa instalacao nova
(onde a maioria dos IF EXISTS / IF NOT EXISTS simplesmente nao faz nada).

IMPORTANTE -- fronteiras de try/except: o Node tem varios blocos try/catch
INDEPENDENTES em runMigrations(); cada um loga o proprio erro e a execucao
continua pro proximo bloco. Essas fronteiras sao preservadas exatamente aqui
(um erro num bloco nunca aborta os seguintes, mas aborta o RESTO do mesmo
bloco, igual ao Node).

Este modulo recebe o pool por parametro e NAO importa nada de app.db (evita
import circular: db.py e quem chama run_migrations()).
"""
import logging
import re

from .handles import generate_unique_handle

logger = logging.getLogger("toolbox45")


def _row_count(tag: str) -> int:
    """Extrai o rowCount da status-tag devolvida por asyncpg execute() (ex.:
    "UPDATE 3", "DELETE 0", "INSERT 0 1") -- equivalente ao `rowCount` do
    driver `pg` do Node (sempre o ULTIMO numero da tag)."""
    try:
        return int(tag.split()[-1])
    except (ValueError, IndexError):
        return 0


# Converte commands.id de TEXT (slug estavel, ex.: 'cplic-print') para
# INTEGER sequencial (SERIAL). So existe DADO A MIGRAR numa instalacao que ja
# tinha comandos cadastrados com o esquema antigo; uma instalacao nova ja
# nasce com `id SERIAL` direto do CREATE TABLE em schema.sql, entao o guard
# abaixo (consulta a information_schema) faz esta funcao nao fazer nada nesse
# caso -- so entra no corpo quando encontra o tipo antigo.
#
# 8 tabelas dependem de commands.id via FK. A troca de tipo de uma coluna
# referenciada por FK em varias tabelas nao e single-statement no Postgres --
# o caminho seguro (mesmo do Node): (1) criar coluna nova SERIAL em
# `commands`; (2) em cada dependente, criar uma coluna INTEGER nova e
# preenche-la via JOIN pelo id de texto antigo; (3) remover FK/PK antiga e a
# coluna de texto antiga de cada dependente, renomeando a nova pro lugar; (4)
# so entao trocar a PK de `commands`; (5) recriar FK/PK dos dependentes; (6)
# recriar os indices que dependiam da coluna antiga. Tudo numa unica
# transacao -- se qualquer passo falhar, o Postgres desfaz tudo e o guard
# tenta de novo no proximo boot.
async def migrate_commands_id_to_serial(pool) -> None:
    try:
        row = await pool.fetchrow(
            "SELECT data_type FROM information_schema.columns WHERE table_name = 'commands' AND column_name = 'id'"
        )
        if row is None or row["data_type"] != "text":
            return  # ja migrado, ou instalacao nova (schema.sql ja cria como integer)

        logger.info("[db] commands.id ainda é TEXT (slug) — migrando para INTEGER sequencial (isso preserva todos os comandos e vínculos já cadastrados)...")

        # Nome da tabela e controlado por nos mesmos aqui (lista fixa abaixo,
        # nunca vem de input externo), entao interpolar no SQL e seguro -- nao
        # da pra parametrizar um identificador de tabela/coluna via $1.
        DEPENDENTS = [
            "command_vendors", "command_systems", "command_versions",
            "command_environments", "command_topics", "command_lines",
            "folder_commands", "user_favorites",
        ]
        # So estas tem uma PK COMPOSTA que inclui command_id (precisa ser
        # recriada) -- command_lines tem PK propria em `id` (SERIAL), que nao
        # e tocada em nenhum passo desta migracao.
        COMPOSITE_PK_COLS = {
            "command_vendors": ["command_id", "vendor"],
            "command_systems": ["command_id", "system"],
            "command_versions": ["command_id", "version"],
            "command_environments": ["command_id", "environment"],
            "command_topics": ["command_id", "topic"],
            "folder_commands": ["folder_id", "command_id"],
            "user_favorites": ["username", "command_id"],
        }

        # Equivalente ao withTransaction() do Node: um unico client dedicado,
        # BEGIN/COMMIT/ROLLBACK (rollback automatico se qualquer passo levantar).
        async with pool.acquire() as client:
            async with client.transaction():
                # 1) Coluna sequencial nova em commands (convive com a antiga
                #    por enquanto -- so vira a PK de fato no passo 4).
                await client.execute("ALTER TABLE commands ADD COLUMN IF NOT EXISTS id_seq SERIAL")

                # 2) Cada dependente ganha uma coluna INTEGER nova, preenchida
                #    a partir do mapeamento commands.id (texto antigo) ->
                #    commands.id_seq.
                for table in DEPENDENTS:
                    await client.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS command_id_seq INTEGER")
                    await client.execute(f"UPDATE {table} t SET command_id_seq = c.id_seq FROM commands c WHERE t.command_id = c.id")

                # 3) Em cada dependente: derruba a FK antiga (nome default do
                #    Postgres: <tabela>_command_id_fkey) e, so nas tabelas com
                #    PK composta, a PK antiga tambem -- depois remove a coluna
                #    de texto e poe a nova no lugar dela.
                for table in DEPENDENTS:
                    await client.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {table}_command_id_fkey")
                    if table in COMPOSITE_PK_COLS:
                        await client.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {table}_pkey")
                    await client.execute(f"ALTER TABLE {table} DROP COLUMN command_id")
                    await client.execute(f"ALTER TABLE {table} RENAME COLUMN command_id_seq TO command_id")
                    await client.execute(f"ALTER TABLE {table} ALTER COLUMN command_id SET NOT NULL")

                # 4) So agora troca a PK de `commands` -- todas as FKs que
                #    apontavam pra ela ja foram removidas no passo 3.
                await client.execute("ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_pkey")
                await client.execute("ALTER TABLE commands DROP COLUMN id")
                await client.execute("ALTER TABLE commands RENAME COLUMN id_seq TO id")
                await client.execute("ALTER TABLE commands ADD PRIMARY KEY (id)")

                # 5) Recria PK composta (onde havia) + FK de cada dependente,
                #    agora apontando pra commands(id) ja inteiro.
                for table in DEPENDENTS:
                    await client.execute(f"ALTER TABLE {table} ADD CONSTRAINT {table}_command_id_fkey FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE CASCADE")
                    if table in COMPOSITE_PK_COLS:
                        await client.execute(f"ALTER TABLE {table} ADD PRIMARY KEY ({', '.join(COMPOSITE_PK_COLS[table])})")

                # 6) Indices que existiam sobre a coluna antiga (dropados junto
                #    com ela no passo 3/4) -- recria todos.
                await client.execute("CREATE INDEX IF NOT EXISTS idx_command_topics_topic ON command_topics(topic)")
                await client.execute("CREATE INDEX IF NOT EXISTS idx_user_favorites_command ON user_favorites(command_id)")
                await client.execute("CREATE INDEX IF NOT EXISTS idx_folder_commands_command ON folder_commands(command_id)")
                await client.execute("CREATE INDEX IF NOT EXISTS idx_command_lines_command ON command_lines(command_id)")
                await client.execute("CREATE INDEX IF NOT EXISTS idx_commands_topic ON commands(topic)")

        # Cosmetico -- fora da transacao de proposito: o nome da sequencia
        # criada pelo `SERIAL` no passo 1 fica `commands_id_seq_seq`, diferente
        # do nome de uma instalacao NOVA (`commands_id_seq`). Renomear deixa as
        # duas instalacoes identicas; uma falha aqui e so estetica e nao deve
        # desfazer a migracao de dados, que ja foi commitada acima.
        try:
            await pool.execute("ALTER SEQUENCE IF EXISTS commands_id_seq_seq RENAME TO commands_id_seq")
        except Exception:  # noqa: BLE001 -- cosmetico, ver comentario acima
            pass

        logger.info("[db] commands.id migrado para INTEGER sequencial — todos os comandos e vínculos (pastas, linhas, catálogos) foram preservados.")
    except Exception as err:  # noqa: BLE001 -- mesmo padrao amplo do try/catch em db.js
        logger.error("[db] Falha ao migrar commands.id para INTEGER sequencial — nada foi alterado (a migração roda inteira dentro de uma transação): %s", err)


# --- helpers da migracao about_purpose/about_when/about_obs -> details -------
# O texto antigo era sempre PLAIN TEXT (nunca HTML) -- por isso e escapado
# (&/</>) antes de virar HTML, e quebras de linha viram paragrafos/<br>.
_PARAGRAPH_SPLIT_RE = re.compile(r"\n{2,}")


def _escape_html(s) -> str:
    return str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _to_paragraphs(s) -> str:
    return "".join(
        "<p>" + block.replace("\n", "<br>") + "</p>"
        for block in _PARAGRAPH_SPLIT_RE.split(_escape_html(s))
    )


def _build_details_html(purpose, when, obs) -> str:
    sections = []
    if purpose and purpose.strip():
        sections.append(f"<p><strong>Purpose</strong></p>{_to_paragraphs(purpose)}")
    if when and when.strip():
        sections.append(f"<p><strong>When to use</strong></p>{_to_paragraphs(when)}")
    if obs and obs.strip():
        sections.append(f"<p><strong>Note</strong></p>{_to_paragraphs(obs)}")
    return "".join(sections)


async def run_migrations(pool) -> None:
    # Roda ANTES de qualquer outra migracao/seed -- varias delas tocam em
    # command_lines/folder_commands/etc., entao e mais simples garantir que
    # commands.id ja esta no formato final (INTEGER) antes de mexer em mais
    # nada. Ver migrate_commands_id_to_serial() acima.
    await migrate_commands_id_to_serial(pool)

    # --- Bloco 1: colunas/ajustes diversos (um unico try, como no Node) ------
    try:
        # users.auth_provider ('ntlm'|'local'|'google'). DEFAULT 'ntlm'
        # preserva as contas NTLM ja existentes; o UPDATE faz o backfill das
        # contas LOCAIS (is_local=1) que existiam antes da coluna.
        await pool.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'ntlm'")
        await pool.execute("UPDATE users SET auth_provider = 'local' WHERE is_local = 1 AND auth_provider = 'ntlm'")
        # api_keys.role (admin|user). DEFAULT 'admin' preserva o acesso total
        # das keys criadas antes deste campo existir.
        await pool.execute("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'")
        # api_keys.expires_at -- sem DEFAULT (NULL = nunca expira).
        await pool.execute("ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ")
        # folder_commands.sort_order (task #458) -- ordena os comandos DENTRO
        # de uma pasta. DEFAULT 0 sozinho deixaria todo membership ja existente
        # empatado; o UPDATE no fim deste bloco faz o backfill inicial usando a
        # MESMA ordem ja exibida antes (created_at).
        await pool.execute("ALTER TABLE folder_commands ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0")
        # folders.parent_id (subpastas) -- NULL por padrao (toda pasta ja
        # existente vira pasta de topo).
        await pool.execute("ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE")
        await pool.execute("CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)")
        # system_logo: variante do tema escuro. image_data/mime_type existentes
        # (variante clara) tambem perdem o NOT NULL, porque uma linha pode
        # existir com so a variante escura preenchida.
        await pool.execute("ALTER TABLE system_logo ADD COLUMN IF NOT EXISTS image_data_dark TEXT")
        await pool.execute("ALTER TABLE system_logo ADD COLUMN IF NOT EXISTS mime_type_dark TEXT")
        await pool.execute("ALTER TABLE system_logo ADD COLUMN IF NOT EXISTS updated_at_dark TIMESTAMPTZ")
        await pool.execute("ALTER TABLE system_logo ADD COLUMN IF NOT EXISTS updated_by_dark TEXT")
        await pool.execute("ALTER TABLE system_logo ALTER COLUMN image_data DROP NOT NULL")
        await pool.execute("ALTER TABLE system_logo ALTER COLUMN mime_type DROP NOT NULL")
        await pool.execute("ALTER TABLE system_logo ALTER COLUMN updated_at DROP NOT NULL")
        # audit_log: generalizado de "so comandos" para qualquer entidade.
        # RENAME COLUMN nao aceita IF EXISTS na coluna -- por isso o DO $$ ...
        # $$ confere via information_schema antes de renomear (seguro em todo
        # boot).
        await pool.execute("""
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'command_id')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'entity_id') THEN
          ALTER TABLE audit_log RENAME COLUMN command_id TO entity_id;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'command_name')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'entity_name') THEN
          ALTER TABLE audit_log RENAME COLUMN command_name TO entity_name;
        END IF;
      END $$;
    """)
        await pool.execute("ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'command'")
        await pool.execute("ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS details TEXT")
        # Remocao da feature Tags/badges: command_tags saiu do schema.sql; aqui
        # e so o DROP para quem ja tinha a tabela de um deploy anterior.
        await pool.execute("DROP TABLE IF EXISTS command_tags")
        # command_lines.export_template -- substitui o antigo checkbox unico
        # "Exportable" (supports_export INTEGER 0/1) por um catalogo de
        # templates (Exports). O backfill ('> {{logFile}}') e EXATAMENTE o
        # redirecionamento fixo que supports_export=1 produzia antes, e casa
        # com o item padrao semeado em seed_default_exports().
        await pool.execute("ALTER TABLE command_lines ADD COLUMN IF NOT EXISTS export_template TEXT")
        await pool.execute("""
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'command_lines' AND column_name = 'supports_export') THEN
          UPDATE command_lines SET export_template = '> {{logFile}}' WHERE supports_export = 1 AND (export_template IS NULL OR export_template = '');
          ALTER TABLE command_lines DROP COLUMN supports_export;
        END IF;
      END $$;
    """)
        # users.role: 3 niveis (user|admin|super_admin) + users.approved_at.
        # CUIDADO: run_migrations() roda em TODO boot -- por isso o backfill
        # abaixo (marcar contas pre-existentes como ja aprovadas) fica dentro
        # de um `IF NOT EXISTS (coluna)` que so e verdadeiro no boot em que a
        # coluna esta sendo criada agora. Sem essa guarda, um UPDATE
        # incondicional aprovaria automaticamente QUALQUER cadastro pendente de
        # verdade a cada restart.
        await pool.execute("""
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'approved_at') THEN
          ALTER TABLE users ADD COLUMN approved_at TIMESTAMPTZ;
          -- Toda conta que ja existia ANTES deste recurso (criada por um
          -- admin, ou auto-provisionada no 1o login Google -- os 2 unicos
          -- jeitos de uma conta existir antes de POST /api/auth/register/
          -- self-registro Google pendente passarem a existir) ja era, na
          -- pratica, uma conta aprovada -- nunca passou por um fluxo de
          -- "pendente". So roda aqui dentro, uma unica vez.
          UPDATE users SET approved_at = COALESCE(created_at, NOW());
        END IF;
      END $$;
    """)
        # A conta local 'admin' de instalacoes antigas (a conta padrao agora so
        # existe ate a configuracao inicial -- ver app/setup.py) e SEMPRE Super
        # Admin, reforcado aqui a cada boot (idempotente).
        await pool.execute("UPDATE users SET role = 'super_admin' WHERE username = 'admin' AND role != 'super_admin'")
        await pool.execute("""
      UPDATE folder_commands fc SET sort_order = ranked.rn
      FROM (
        SELECT folder_id, command_id,
               row_number() OVER (PARTITION BY folder_id ORDER BY created_at, command_id) - 1 AS rn
        FROM folder_commands
      ) ranked
      WHERE fc.folder_id = ranked.folder_id AND fc.command_id = ranked.command_id AND fc.sort_order = 0
    """)
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao rodar migrações: %s", err)

    # --- Bloco 2: users.handle + tabela `shares` ------------------------------
    # ADD COLUMN nullable de proposito: instalacoes ja existentes ganham a
    # coluna sem handle nenhum ainda; o backfill gera um handle unico para
    # cada usuario que ainda nao tem um ANTES do indice unico ser criado.
    try:
        await pool.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT")
        no_handle = await pool.fetch("SELECT username FROM users WHERE handle IS NULL")
        for r in no_handle:
            username = r["username"]
            handle = await generate_unique_handle(pool, username)
            await pool.execute("UPDATE users SET handle = $1 WHERE username = $2", handle, username)
        await pool.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle)")
        await pool.execute("""
      CREATE TABLE IF NOT EXISTS shares (
        id               SERIAL PRIMARY KEY,
        grantor_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        grantee_username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        share_folders    BOOLEAN NOT NULL DEFAULT false,
        share_commands   BOOLEAN NOT NULL DEFAULT false,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (grantor_username, grantee_username),
        CHECK (grantor_username <> grantee_username)
      )
    """)
        await pool.execute("CREATE INDEX IF NOT EXISTS idx_shares_grantee ON shares(grantee_username)")
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao migrar users.handle / criar tabela shares: %s", err)

    # --- Bloco 3: environments.system/vendor ---------------------------------
    # Nullable no ADD COLUMN de proposito (uma instalacao ja existente pode ter
    # linhas em `environments` de antes desta FK existir); o backfill tenta
    # resolver o Sistema de cada uma e so entao a coluna vira NOT NULL.
    try:
        await pool.execute("ALTER TABLE environments ADD COLUMN IF NOT EXISTS system TEXT REFERENCES systems(key) ON DELETE CASCADE")
        await pool.execute("ALTER TABLE environments ADD COLUMN IF NOT EXISTS vendor TEXT REFERENCES vendors(key) ON DELETE CASCADE")
        await pool.execute("CREATE INDEX IF NOT EXISTS idx_environments_system ON environments(system)")

        # 1) Quando o Ambiente ja tem exatamente 1 Sistema "descobrivel"
        #    atraves dos vinculos version_environments -> versions.system, usa
        #    esse.
        await pool.execute("""
      UPDATE environments e SET system = resolved.system, vendor = s.vendor
      FROM (
        SELECT ve.environment, v.system
        FROM version_environments ve
        JOIN versions v ON v.key = ve.version
        GROUP BY ve.environment, v.system
        HAVING COUNT(DISTINCT v.system) = 1
      ) resolved
      JOIN systems s ON s.key = resolved.system
      WHERE e.key = resolved.environment AND e.system IS NULL
    """)
        # Nota: a subquery acima ja garante 1 system por ambiente (HAVING COUNT
        # DISTINCT = 1) considerando TODOS os vinculos daquele ambiente -- se um
        # ambiente estiver ligado a versoes de mais de um Sistema diferente,
        # nenhuma linha e gerada para ele aqui (cai no fallback abaixo).

        # 2) Ainda sem Sistema e existe exatamente 1 Sistema cadastrado no
        #    total: assume que e esse (instalacao single-vendor/single-system).
        sys_count = await pool.fetchval("SELECT COUNT(*) AS n FROM systems")
        if int(sys_count) == 1:
            await pool.execute("""
        UPDATE environments e SET system = s.key, vendor = s.vendor
        FROM systems s
        WHERE e.system IS NULL
      """)
        elif int(sys_count) > 1:
            # 3) Mais de um Sistema cadastrado e ainda restam ambientes sem
            #    Sistema resolvido: cai no primeiro Sistema por sort_order so
            #    para nao deixar a coluna NOT NULL impossivel de aplicar -- e
            #    uma suposicao (registrada no log para o administrador revisar).
            unresolved = await pool.fetch("SELECT key FROM environments WHERE system IS NULL")
            if unresolved:
                first_sys = await pool.fetchrow("SELECT key, vendor FROM systems ORDER BY sort_order, key LIMIT 1")
                if first_sys:
                    await pool.execute("UPDATE environments SET system = $1, vendor = $2 WHERE system IS NULL", first_sys["key"], first_sys["vendor"])
                    logger.warning(
                        "[db] Ambiente(s) sem Sistema determinável de forma inequívoca (%s) foram atribuídos a '%s' como suposição — revise em Register → Environments.",
                        ", ".join(r["key"] for r in unresolved), first_sys["key"],
                    )

        # So promove a NOT NULL se toda linha ja tem um Sistema. Reaplicar SET
        # NOT NULL numa coluna que ja e NOT NULL nao da erro no Postgres, entao
        # isto e seguro rodar em todo boot.
        pending = await pool.fetchval("SELECT COUNT(*) AS n FROM environments WHERE system IS NULL")
        if int(pending) == 0:
            await pool.execute("ALTER TABLE environments ALTER COLUMN system SET NOT NULL")
            await pool.execute("ALTER TABLE environments ALTER COLUMN vendor SET NOT NULL")
        else:
            logger.warning("[db] %s ambiente(s) ainda sem Sistema após a migração automática — corrija manualmente em Register → Environments antes de contar com a obrigatoriedade desse campo.", pending)
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao migrar environments.system/vendor: %s", err)

    # --- Bloco 4: parametros fixos padrao (reinseridos a cada boot) ----------
    # Garante que os 8 parametros "fixos" da linha unica do campo de busca
    # sempre EXISTAM no catalogo. seed_default_parameters() so semeia numa
    # tabela vazia; numa instalacao parcialmente preenchida o seed nunca roda
    # de novo. ON CONFLICT (key) DO NOTHING: so cria o que estiver faltando,
    # nunca sobrescreve um parametro ja cadastrado.
    try:
        FIXED_PARAM_DEFAULTS = [
            {"key": "src_ip", "label": "Source"},
            {"key": "dst_ip", "label": "Destination"},
            {"key": "src_port", "label": "Source Port"},
            {"key": "dst_port", "label": "Destination Port"},
            {"key": "user", "label": "User"},
            {"key": "host", "label": "Host"},
            {"key": "license", "label": "License"},
            {"key": "signature", "label": "Signature"},
        ]
        max_sort = await pool.fetchval("SELECT COALESCE(MAX(sort_order), -1) AS m FROM parameters")
        next_sort = int(max_sort) + 1
        for p in FIXED_PARAM_DEFAULTS:
            tag = await pool.execute(
                "INSERT INTO parameters (key, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING",
                p["key"], p["label"], next_sort,
            )
            if _row_count(tag):
                next_sort += 1
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao garantir parâmetros fixos padrão: %s", err)

    # --- Bloco 5: favoritos legados (user_favorites) -> folders --------------
    # Migracao de dados: feature "Favorites" (tabela legada user_favorites)
    # virou "Folders" -- cada usuario que tinha favoritos ganha uma pasta
    # chamada "Favorites" com os mesmos comandos. to_regclass() confirma que a
    # tabela legada ainda existe antes de ler dela. O upsert com "DO UPDATE ...
    # RETURNING id" garante idempotencia e devolve o id mesmo se a pasta ja
    # existir (um DO NOTHING puro nao devolve linha); folder_commands tem sua
    # propria PK composta contra duplicar membership numa segunda execucao.
    try:
        legacy_check = await pool.fetchval("SELECT to_regclass('public.user_favorites') AS t")
        if legacy_check:
            users = await pool.fetch("SELECT DISTINCT username FROM user_favorites")
            for u in users:
                username = u["username"]
                folder_id = await pool.fetchval(
                    """INSERT INTO folders (username, name) VALUES ($1, 'Favorites')
           ON CONFLICT (username, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id""",
                    username,
                )
                await pool.execute(
                    """INSERT INTO folder_commands (folder_id, command_id)
           SELECT $1, command_id FROM user_favorites WHERE username = $2
           ON CONFLICT DO NOTHING""",
                    folder_id, username,
                )
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao migrar favoritos legados para folders: %s", err)

    # --- Bloco 6: linhas line_type='note' -> about_obs -----------------------
    # Migracao de dados: a categoria de texto 'note' foi removida do editor.
    # Cada linha line_type='note' de um comando vira um paragrafo anexado ao
    # about_obs JA EXISTENTE daquele comando (nunca sobrescreve). Depois, as
    # linhas 'note' sao apagadas. Idempotente: depois da 1a execucao nao sobra
    # nenhuma linha line_type='note'. Guarda: `about_obs` so existe em bancos
    # ainda nao migrados para `details` (migracao mais abaixo, que depende do
    # conteudo ja consolidado aqui).
    try:
        obs_col = await pool.fetch(
            "SELECT 1 FROM information_schema.columns WHERE table_name = 'commands' AND column_name = 'about_obs'"
        )
        if obs_col:
            moved_tag = await pool.execute("""
        UPDATE commands c SET about_obs = trim(both chr(10) from
          c.about_obs || CASE WHEN c.about_obs <> '' THEN chr(10) || chr(10) ELSE '' END || agg.combined
        )
        FROM (
          SELECT command_id, string_agg(content, chr(10) ORDER BY sort_order, id) AS combined
          FROM command_lines
          WHERE line_type = 'note' AND trim(content) <> ''
          GROUP BY command_id
        ) agg
        WHERE c.id = agg.command_id
      """)
            moved_cmd_notes = _row_count(moved_tag)
            deleted_tag = await pool.execute("DELETE FROM command_lines WHERE line_type = 'note'")
            deleted_cmd_notes = _row_count(deleted_tag)

            if deleted_cmd_notes:
                logger.info("[db] Categoria de texto 'note' migrada e removida: %s comando(s) tiveram o texto movido para o campo Note; %s linha(s) de command_lines apagadas.", moved_cmd_notes, deleted_cmd_notes)
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao migrar linhas 'note' para about_obs: %s", err)

    # --- Bloco 7: remocao de raw_template/requires_ips/command_diffs ---------
    # DROP COLUMN/TABLE IF EXISTS: seguro rodar em toda instalacao, inclusive
    # uma nova (onde essas colunas/tabelas nunca existiram).
    try:
        await pool.execute("ALTER TABLE commands DROP COLUMN IF EXISTS raw_template")
        await pool.execute("ALTER TABLE commands DROP COLUMN IF EXISTS requires_ips")
        await pool.execute("DROP TABLE IF EXISTS command_diff_lines")
        await pool.execute("DROP TABLE IF EXISTS command_diffs")
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao remover raw_template/requires_ips/command_diffs: %s", err)

    # --- Bloco 8: about_purpose/about_when/about_obs -> details --------------
    # 1) Garante a coluna nova (ADD COLUMN IF NOT EXISTS). 2) Backfill: so roda
    # se as 3 colunas ANTIGAS ainda existirem (guard via information_schema).
    # So migra comandos cujo `details` ainda esteja vazio e que tenham pelo
    # menos um dos 3 campos antigos preenchido -- nunca sobrescreve um
    # `details` ja escrito. 3) Remove as 4 colunas antigas (about_icon
    # incluido).
    try:
        old_cols = await pool.fetch(
            """SELECT column_name FROM information_schema.columns
       WHERE table_name = 'commands' AND column_name IN ('about_purpose', 'about_when', 'about_obs')"""
        )
        if len(old_cols) == 3:
            await pool.execute("ALTER TABLE commands ADD COLUMN IF NOT EXISTS details TEXT NOT NULL DEFAULT ''")
            to_migrate = await pool.fetch("""
        SELECT id, about_purpose, about_when, about_obs FROM commands
        WHERE trim(coalesce(details, '')) = ''
          AND (trim(coalesce(about_purpose, '')) <> '' OR trim(coalesce(about_when, '')) <> '' OR trim(coalesce(about_obs, '')) <> '')
      """)
            for row in to_migrate:
                await pool.execute(
                    "UPDATE commands SET details = $1 WHERE id = $2",
                    _build_details_html(row["about_purpose"], row["about_when"], row["about_obs"]), row["id"],
                )
            if to_migrate:
                logger.info("[db] Purpose/When to use/Note migrados para o novo campo Details (rich text) em %s comando(s).", len(to_migrate))
            await pool.execute("ALTER TABLE commands DROP COLUMN IF EXISTS about_purpose")
            await pool.execute("ALTER TABLE commands DROP COLUMN IF EXISTS about_when")
            await pool.execute("ALTER TABLE commands DROP COLUMN IF EXISTS about_obs")
            await pool.execute("ALTER TABLE commands DROP COLUMN IF EXISTS about_icon")
        else:
            # Instalacao nova, ou ja migrada -- so garante que `details` existe
            # (redundante numa instalacao 100% nova, mas inofensivo).
            await pool.execute("ALTER TABLE commands ADD COLUMN IF NOT EXISTS details TEXT NOT NULL DEFAULT ''")
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha ao migrar about_purpose/about_when/about_obs para details: %s", err)

    # --- Bloco 9: limpeza UNICA de 'cpa-theme' contaminado -------------------
    # Roda UMA UNICA VEZ (guardada pela linha sentinela em user_data), nunca de
    # novo em boots seguintes -- senao apagaria tambem preferencias reais que
    # usuarios venham a escolher DEPOIS da limpeza. Nao ha como distinguir com
    # certeza um 'cpa-theme' contaminado de um escolhido de proposito; a perda
    # foi aceita pelo usuario no pedido original.
    try:
        SENTINEL_USER = "__migrations__"
        SENTINEL_KEY = "cpa_theme_reset_v1"
        already_ran = await pool.fetch(
            "SELECT 1 FROM user_data WHERE username = $1 AND data_key = $2",
            SENTINEL_USER, SENTINEL_KEY,
        )
        if not already_ran:
            tag = await pool.execute("DELETE FROM user_data WHERE data_key = 'cpa-theme'")
            row_count = _row_count(tag)
            await pool.execute(
                """INSERT INTO user_data (username, data_key, value, updated_at) VALUES ($1, $2, 'done', NOW())
         ON CONFLICT (username, data_key) DO NOTHING""",
                SENTINEL_USER, SENTINEL_KEY,
            )
            logger.info("[db] Limpeza única de 'cpa-theme' contaminado: %s preferência(s) de tema removida(s) — usuários sem escolha própria voltam a acompanhar o default do admin.", row_count)
    except Exception as err:  # noqa: BLE001
        logger.error("[db] Falha na limpeza única de cpa-theme: %s", err)
