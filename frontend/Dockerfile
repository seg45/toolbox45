# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — frontend image (toolbox45-frontend)
#
# Static files (index.html, css/, js/, img/) served by nginx, with a reverse
# proxy for /api/* to the backend container (toolbox45-backend) — see
# nginx.conf. This is the ONLY container exposed to the browser/host network
# (see docker-compose.yml: toolbox45-db and toolbox45-backend have no
# published ports).
#
# Build context is the repo root (same as the backend Dockerfile) — see
# docker-compose.yml: "dockerfile: frontend/Dockerfile".
#
# `inotify-tools` + docker-entrypoint.sh: watches the toolbox45-tls shared
# volume (mounted read-only at /etc/nginx/tls — see docker-compose.yml) and
# runs `nginx -s reload` whenever cert.pem/key.pem change, so importing or
# deleting a certificate via Settings → System → SSL Certificate takes effect
# without restarting this container. No /var/run/docker.sock access needed —
# deliberately avoided (see server/index.js comment on the old "updater"
# service removed in an earlier commit).
# ════════════════════════════════════════════════════════════════════════
FROM nginx:1.27-alpine

RUN apk add --no-cache inotify-tools

COPY frontend/nginx.conf /etc/nginx/nginx.conf
COPY frontend/docker-entrypoint.sh /docker-entrypoint-tls.sh
RUN chmod +x /docker-entrypoint-tls.sh
COPY index.html /usr/share/nginx/html/index.html
# login.html — nova página inicial de login (usuário/senha ou Windows
# authentication), ver js/login.js e css/login.css (já cobertos pelos COPY
# de diretório abaixo, só o .html avulso precisa de linha própria).
COPY login.html /usr/share/nginx/html/login.html
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY img /usr/share/nginx/html/img

EXPOSE 80 443
ENTRYPOINT ["/docker-entrypoint-tls.sh"]
