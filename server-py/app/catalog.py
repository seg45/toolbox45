"""Helpers compartilhados pelo catalogo administrativo (vendors, systems,
versions, environments, topics, parameters, prompts) -- porta 1:1 de
server/index.js (~linhas 2677-2751): geracao de key por slug com dedup
automatico (-2, -3, ...), checagem de existencia/uso e substituicao
(delete+insert) de vinculos N:N (version_environments, environment_topics).
"""
import re
from typing import Any, Awaitable, Callable, Optional, Sequence

CATALOG_KEY_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")


def slugify_catalog_key(label: Any) -> str:
    s = str(label if label is not None else "").strip().lower()
    s = re.sub(r"[^a-z0-9._-]+", "-", s)
    s = re.sub(r"^[-._]+|[-._]+$", "", s)
    s = re.sub(r"-{2,}", "-", s)
    if not s:
        s = "item"
    return s[:40]


async def unique_catalog_key(base: str, exists_fn: Callable[[str], Awaitable[bool]]) -> str:
    candidate = base
    n = 2
    while await exists_fn(candidate):
        suffix = f"-{n}"
        candidate = base[: max(1, 40 - len(suffix))] + suffix
        n += 1
    return candidate


async def key_exists(pool, table: str, key: str) -> bool:
    # `table` vem sempre de um literal fixo no proprio codigo (nunca de
    # entrada do usuario) -- seguro interpolar direto na string SQL.
    row = await pool.fetchval(f"SELECT 1 FROM {table} WHERE key = $1", key)
    return row is not None


async def count_usage(pool, table: str, column: str, key: str) -> int:
    row = await pool.fetchval(f"SELECT COUNT(*) AS n FROM {table} WHERE {column} = $1", key)
    return int(row)


async def replace_scope_links(
    pool, join_table: str, child_col: str, child_key: str, parent_col: str, parent_keys: Optional[Sequence[str]]
) -> None:
    await pool.execute(f"DELETE FROM {join_table} WHERE {child_col} = $1", child_key)
    for pk in (parent_keys if isinstance(parent_keys, list) else []):
        await pool.execute(
            f"INSERT INTO {join_table} ({child_col}, {parent_col}) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            child_key, pk,
        )


def is_int(value: Any) -> bool:
    # Number.isInteger(x) do JS -- exclui bool (subclasse de int em Python:
    # isinstance(True, int) e True).
    return isinstance(value, int) and not isinstance(value, bool)
