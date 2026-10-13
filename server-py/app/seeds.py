"""Seeds de uma instalacao nova.

Uma instalacao NOVA nasce VAZIA: nenhum catalogo (vendors, systems, versions,
environments, parameters, prompts, exports), nenhum comando, nenhum usuario. Tudo
e cadastrado depois pelo administrador (Settings -> Register / Database) ou
importado. As antigas seeds de catalogo (Check Point/Fortinet, versoes,
ambientes, parametros, prompts, exports) foram removidas.

Unica excecao estrutural: a pasta "Favorites" de cada usuario (ver
seed_default_folders), que o app trata como pasta fixa de cada conta -- nao e um
dado de exemplo, e criada vazia.

Este modulo recebe o pool por parametro e NAO importa nada de app.db (evita
import circular).
"""
import logging

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


async def run_seeds(pool) -> None:
    """Unica seed: a pasta "Favorites" de cada usuario ja existente (sem
    usuarios, nao cria nada)."""
    await seed_default_folders(pool)
