#!/bin/sh
# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — entrypoint do frontend (toolbox45-frontend)
#
# Hot-reload de TLS: o nginx só lê /etc/nginx/tls/cert.pem+key.pem uma vez,
# no boot, então este script observa esse diretório (volume toolbox45-tls,
# somente-leitura) com inotifywait e roda `nginx -s reload` (graceful, não
# derruba conexão em andamento) sempre que os arquivos mudam — importar ou
# remover um certificado em Settings → System → SSL Certificate vale sem
# reiniciar o container, e sem acesso a /var/run/docker.sock.
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
