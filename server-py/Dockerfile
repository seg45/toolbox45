# Backend Python (FastAPI) -- Fase 1 da migracao (ver plano no Project
# toolbox45). Ainda NAO referenciado em docker-compose.yml: este servico
# roda isolado, so pra validacao manual, ate a Fase 2 (frontend antigo
# apontado pra ca lado a lado com o backend Node em producao).
#
# Build a partir da RAIZ do repo (mesmo padrao do Dockerfile do backend Node
# na raiz), nao de dentro de server-py/ -- por causa do COPY server/schema.sql
# abaixo:
#   docker build -f server-py/Dockerfile -t toolbox45-backend-py:latest .
FROM python:3.12-slim

WORKDIR /app

# postgresql-client (pg_dump/pg_restore, fatia 10 -- Backup & Restore, ver
# app/backup.py) -- instalado a partir do repositorio OFICIAL do PostgreSQL
# (apt.postgresql.org), fixando a MESMA major version do servidor real
# (toolbox45-db, Postgres 16 -- ver docker-compose.yml), em vez do pacote
# generico "postgresql-client" do Debian (que na imagem base atual,
# python:3.12-slim/trixie, resolve pra v17 -- funciona contra um servidor
# v16, mas emite um aviso de "unrecognized configuration parameter
# transaction_timeout" no restore, porque o dump de um client mais novo usa
# um parametro de sessao que so existe no Postgres 17). Testado localmente
# (dump + restore reais contra um Postgres 16) com o client v16 exato: zero
# erros/avisos -- ver comentario equivalente em app/backup.py.
#
# openssl (fatia 9 -- SSL Certificate, ver app/tls.py) ja vem na imagem base
# (nao precisa de apt-get separado, confirmado na validacao da fatia 9).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gnupg curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && apt-get purge -y --auto-remove gnupg curl \
    && rm -rf /var/lib/apt/lists/*

COPY server-py/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# server/schema.sql e a mesma fonte de verdade usada pelo backend Node (ver
# app/db.py) -- copiado aqui pra dentro da imagem junto com o codigo Python.
COPY server/schema.sql ./server/schema.sql
COPY server-py/app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
