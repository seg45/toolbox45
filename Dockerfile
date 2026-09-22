# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — backend image (toolbox45-backend)
#
# Pure Node/Express REST API — no static frontend files here anymore (see
# frontend/Dockerfile for the nginx image that serves those and reverse
# proxies /api/* to this container). Talks to PostgreSQL (toolbox45-db, a
# separate container — see docker-compose.yml) over the network, so there is
# no native module to compile (no better-sqlite3 anymore) and no local
# database file/volume for this image.
#
# `postgresql-client` is installed for the Backup & Restore feature (Settings
# → System → Database), which shells out to `pg_dump`/`pg_restore` — see
# server/index.js. `openssl` is installed for the SSL Certificate feature
# (Settings → System → SSL Certificate), which shells out to `openssl req`
# to generate a default self-signed certificate on first boot and whenever
# the admin deletes a custom one — see ensureTlsBootstrap()/
# generateSelfSignedCert() in server/index.js.
# ════════════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim
WORKDIR /app/server

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client openssl \
    && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/schema.sql server/db.js server/index.js server/seed.js server/auth.js ./

# Dedicated non-root user + folders for features that write to disk outside
# the app code itself: /app/backups (Backup & Restore, a named volume so
# dumps survive image rebuilds/container recreation) and /app/tls (SSL
# Certificate — a volume SHARED with toolbox45-frontend, which actually
# serves HTTPS with whatever cert/key live there; see docker-compose.yml and
# frontend/nginx.conf).
RUN useradd --system --no-create-home --shell /usr/sbin/nologin toolbox45 \
    && mkdir -p /app/backups /app/tls \
    && chown -R toolbox45:toolbox45 /app
USER toolbox45

ENV PORT=3000
ENV BACKUP_DIR=/app/backups
ENV TLS_DIR=/app/tls
# Uncomment (or set at "docker run"/compose level) if this host is not on a
# Windows domain — otherwise NTLM identification is attempted by default.
# ENV NTLM_DISABLED=1

EXPOSE 3000
VOLUME ["/app/backups", "/app/tls"]

CMD ["node", "index.js"]
