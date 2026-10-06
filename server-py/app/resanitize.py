"""Re-sanitiza o HTML rico que JA esta no banco (details dos comandos e notas
de pasta) com o sanitizador atual (app/sanitize.py).

Por que existe: ate a correcao de seguranca de out/2026, o sanitizador era
baseado em regex e deixava passar certas tags malformadas. Conteudo gravado
antes disso pode, em tese, conter HTML perigoso. O frontend ja neutraliza tudo
na hora de exibir (DOMPurify, src/lib/safeHtml.ts), mas este utilitario limpa
tambem o dado em repouso.

Uso (dentro do container do backend, na pasta /app):

    python -m app.resanitize            # SO LISTA o que mudaria (nao altera nada)
    python -m app.resanitize --apply    # aplica (faca um backup antes!)

Conteudo legitimo normalmente NAO muda (o sanitizador novo e idempotente e
preserva o formato). O modo padrao mostra quantas linhas mudariam e um trecho
de cada uma, para voce conferir antes de aplicar.
"""
import argparse
import asyncio
import sys

import asyncpg

from .config import settings
from .sanitize import sanitize_note_html

TARGETS = (("commands", "id", "details"), ("notes", "id", "description"))


def _snippet(text: str, width: int = 90) -> str:
    one = " ".join(str(text).split())
    return one if len(one) <= width else one[: width - 1] + "…"


async def run(apply: bool) -> int:
    conn = await asyncpg.connect(dsn=settings.dsn())
    changed_total = 0
    try:
        for table, id_col, col in TARGETS:
            rows = await conn.fetch(f"SELECT {id_col} AS id, {col} AS html FROM {table} WHERE {col} <> ''")
            changes = []
            for r in rows:
                clean = sanitize_note_html(r["html"])
                if clean != r["html"]:
                    changes.append((r["id"], r["html"], clean))
            print(f"{table}.{col}: {len(rows)} linha(s) com conteúdo, {len(changes)} mudariam")
            for rid, old, new in changes[:20]:
                print(f"  id={rid}\n    antes : {_snippet(old)}\n    depois: {_snippet(new)}")
            if len(changes) > 20:
                print(f"  ... e mais {len(changes) - 20}")
            if apply and changes:
                async with conn.transaction():
                    for rid, _old, new in changes:
                        await conn.execute(f"UPDATE {table} SET {col} = $1 WHERE {id_col} = $2", new, rid)
                print(f"  → {len(changes)} linha(s) atualizada(s)")
            changed_total += len(changes)
    finally:
        await conn.close()
    if not apply and changed_total:
        print("\nNada foi alterado (modo de simulação). Rode com --apply para gravar.")
    return changed_total


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="grava as mudanças (padrão: só lista)")
    args = ap.parse_args()
    asyncio.run(run(args.apply))
    sys.exit(0)


if __name__ == "__main__":
    main()
