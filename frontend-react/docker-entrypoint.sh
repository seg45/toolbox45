#!/bin/sh
# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — frontend React entrypoint (toolbox45-frontend-react)
#
# Cópia 1:1 de frontend/docker-entrypoint.sh (frontend JS atual) — mesma
# lógica de hot-reload de TLS, sem nenhuma mudança: nginx só lê
# /etc/nginx/tls/cert.pem+key.pem uma vez, no boot, então este script
# observa esse diretório com inotifywait e roda `nginx -s reload`
# (graceful, não derruba conexão em andamento) sempre que os arquivos
# mudam — sem precisar de acesso a /var/run/docker.sock. Ver comentário
# completo no arquivo original.
# ════════════════════════════════════════════════════════════════════════
set -e

(
  while true; do
    inotifywait -q -e modify,create,move,delete,close_write /etc/nginx/tls 2>/dev/null
    sleep 1
    nginx -s reload 2>/dev/null || true
  done
) &

exec nginx -g "daemon off;"
