# server-py — backend Python (FastAPI)

Backend do Toolbox45 (serviço `toolbox45-backend` do `docker-compose.yml`). Substituiu o
backend Node.js/Express no corte da Fase 4 da migração para Python (backend) + React
(frontend), feita por padronização de linguagem da empresa. O histórico completo da
migração (inventário de rotas, decisões, validações por fatia) está no documento
`migracao-python-react.md` do Project **toolbox45** (claude.ai).

## O que é

- FastAPI + `asyncpg` (PostgreSQL 16). Mesmo contrato HTTP do backend antigo: mesmas rotas,
  mesmos formatos de request/response e de erro (`{"error","message"}`), mesma sessão por
  cookie, mesmo hash de senha (scrypt) e mesmas variáveis de ambiente.
- Rotas em `app/routers/*.py` (um módulo por domínio); regras compartilhadas em `app/`
  (`deps.py` — autenticação/autorização, `commands.py`, `folders.py`, `catalog.py`,
  `audit.py`, `sanitize.py`, `tls.py`, `backup.py`…). Referência da API em `docs/api.md`.
- No boot (`app/db.py`): aplica `app/schema.sql`, roda as migrações idempotentes
  (`app/migrations.py`) e semeia os padrões de primeira instalação (`app/seeds.py`:
  pasta Favorites, catálogo base — não há mais usuário padrão: o primeiro `super_admin` é criado
  pela configuração inicial, `app/setup.py`). Veja
  `docs/server-overview.md`.
- Também no boot/em segundo plano: recarrega a config de OAuth (banco > variáveis de
  ambiente), gera o certificado TLS autoassinado se não houver um (`openssl`), e roda o
  agendador de backup (`pg_dump`, cliente PostgreSQL 16 instalado na imagem).
- `GET /api/health` → `{"ok": true}`; só responde depois de tudo acima concluir.

## Variáveis de ambiente

`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` (ou `DATABASE_URL`),
`GOOGLE_*`/`MICROSOFT_*` (opcionais; a config salva na UI tem precedência),
`BACKUP_DIR` (padrão `/app/backups` na imagem) e `TLS_DIR` (padrão `/app/tls`).

## Imagem Docker

`server-py/Dockerfile` — build a partir da **raiz do repo** (não de dentro de
`server-py/`), por causa dos caminhos dos `COPY`:

```bash
docker build -f server-py/Dockerfile -t toolbox45-backend:latest .
```

O container roda como usuário não-root `toolbox45` (uid/gid **999**, o mesmo da imagem Node
antiga — mantém a posse dos volumes `toolbox45-backups` e `toolbox45-tls` já existentes). Em
produção ele sobe pelo `docker-compose.yml`; ver `docs/install-instructions.txt`.

## Testes

Precisa de um PostgreSQL acessível (usa bancos descartáveis com prefixo `p_`; o módulo é
ignorado se não houver Postgres):

```bash
cd server-py
pip install -r requirements.txt pytest
python -m pytest tests
```

A suíte (`tests/test_boot.py`) cobre o boot completo: instalação do zero, idempotência,
migrações de bancos legados e o ciclo de vida do FastAPI (configuração inicial, login, catálogo);
`tests/test_setup.py` cobre o primeiro acesso (instalação nova e migração do `admin` legado).

## Código Node antigo

Comentários do tipo "porta de `server/index.js`" referem-se ao backend Node removido no corte;
o código continua acessível pela tag `node-final` (último commit que ainda o contém):
`git show node-final:server/index.js` lê um arquivo; `git checkout node-final` restaura
a stack antiga inteira.
