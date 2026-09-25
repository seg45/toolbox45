# server-py — backend Python (FastAPI)

Backend novo, em construção, parte da migração para Python (backend) +
React (frontend) por padronização de linguagem da empresa. Plano completo,
inventário de rotas e roadmap por fases: documento `migracao-python-react.md`
no Project **toolbox45** (claude.ai).

## Status atual: Fase 1, fatia 1 (infra básica)

O que já existe:

- Sobe um FastAPI, conecta no PostgreSQL usando as MESMAS variáveis de
  ambiente do backend Node atual (`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/
  `PGPASSWORD`, ou `DATABASE_URL`).
- Aplica `server/schema.sql` no boot (idempotente — igual ao `initDb()` do
  Node em `server/db.js`).
- `GET /api/health` → `{"ok": true}`, mesmo contrato do backend Node
  (`server/index.js` linha 63).

O que ainda NÃO existe (propositalmente, fora do escopo desta fatia):

- Nenhuma das outras ~93 rotas da API (auth, comandos, pastas, etc.).
- Seed de dados padrão (usuário admin, vendors/systems/topics default) —
  desnecessário aqui porque este serviço, por enquanto, sempre aponta pro
  MESMO banco que o backend Node já inicializou e semeou.
- Qualquer wiring no `docker-compose.yml` — este serviço roda isolado,
  buildado e testado manualmente, até a Fase 2 do plano (frontend antigo
  apontado pra cá lado a lado com o backend Node em produção).

## Como testar isoladamente

Build (a partir da raiz do repo, não de dentro de `server-py/`):

```bash
docker build -f server-py/Dockerfile -t toolbox45-backend-py:latest .
```

Descobrir o nome da rede que o `docker compose` já criou pro projeto (pra
este container conseguir enxergar o `toolbox45-db` existente):

```bash
docker network ls | grep toolbox45
```

Rodar contra o banco já em produção (rede interna do compose, sem publicar
porta do Postgres — só a porta HTTP deste serviço novo, numa porta
diferente da 80/443 já usadas pelo `toolbox45-frontend`):

```bash
docker run --rm -it \
  --network <nome-da-rede-encontrada-acima> \
  -e PGHOST=toolbox45-db \
  -e PGPORT=5432 \
  -e PGDATABASE=toolbox45 \
  -e PGUSER=toolbox45 \
  -e PGPASSWORD=toolbox45 \
  -p 8001:8000 \
  toolbox45-backend-py:latest
```

Validar:

```bash
curl http://localhost:8001/api/health
# esperado: {"ok":true}
```

`Ctrl+C` para parar — não afeta o backend Node nem o frontend, que
continuam servindo normalmente na 80/443 o tempo todo.
