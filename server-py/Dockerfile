# Toolbox45 -- backend Python (FastAPI), imagem do servico toolbox45-backend.
#
# Substitui o backend Node no corte da Fase 4 (ver docker-compose.yml).
# Build a partir da RAIZ do repo (nao de dentro de server-py/), porque o
# contexto precisa enxergar server-py/ com caminhos relativos a raiz:
#   docker build -f server-py/Dockerfile -t toolbox45-backend:latest .
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

# schema.sql vive em server-py/app/schema.sql (ver app/db.py) -- ja vem junto
# com o COPY do pacote Python abaixo.
COPY server-py/app ./app

# Usuario dedicado, nao-root, com uid/gid FIXOS em 999 -- o mesmo que a imagem
# do backend Node (`useradd --system`, node:20-bookworm-slim) atribuia ao
# usuario "toolbox45". Os volumes nomeados toolbox45-backups e toolbox45-tls
# ja existentes em producao pertencem a esse uid; manter o mesmo evita
# "Permission denied" no Backup & Restore e no SSL Certificate depois do
# corte, e tambem permite voltar ao Node (rollback) sem arquivos root-owned
# que o Node nao conseguiria sobrescrever.
#   /app/backups -- dumps do Backup & Restore (BACKUP_DIR, volume nomeado)
#   /app/tls     -- cert.pem/key.pem (TLS_DIR, volume COMPARTILHADO com o
#                   nginx do frontend, que e quem de fato termina o HTTPS)
RUN groupadd --system --gid 999 toolbox45 \
    && useradd --system --uid 999 --gid 999 --no-create-home --shell /usr/sbin/nologin toolbox45 \
    && mkdir -p /app/backups /app/tls \
    && chown -R toolbox45:toolbox45 /app
USER toolbox45

ENV BACKUP_DIR=/app/backups
ENV TLS_DIR=/app/tls

EXPOSE 8000
VOLUME ["/app/backups", "/app/tls"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
