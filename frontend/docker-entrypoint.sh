#!/bin/sh
# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — frontend entrypoint (toolbox45-frontend)
#
# nginx already terminates HTTPS using /etc/nginx/tls/cert.pem + key.pem
# (see nginx.conf) mounted from the toolbox45-tls shared volume — but nginx
# only reads those files once, at startup. When an admin imports/replaces/
# deletes a certificate via Settings → System → SSL Certificate, the backend
# (server/index.js) writes the new cert.pem/key.pem to that SAME volume, but
# has no way to tell THIS container to pick them up — there's no
# /var/run/docker.sock access anywhere in this stack (removed on purpose,
# see the old "updater" service), so nginx can't be restarted from outside.
#
# The fix: watch the mounted /etc/nginx/tls directory from INSIDE this
# container with inotifywait, and run `nginx -s reload` (graceful reload —
# does not drop in-flight connections) whenever the certificate files
# change. This runs as a background loop; nginx itself still runs in the
# foreground so the container stays up as long as nginx does.
# ════════════════════════════════════════════════════════════════════════
set -e

(
  while true; do
    inotifywait -q -e modify,create,move,delete,close_write /etc/nginx/tls 2>/dev/null
    # Pequeno debounce — o import de certificado grava cert.pem e key.pem em
    # duas escritas separadas (ver server/index.js: POST /api/system/ssl-
    # certificate); sem isto, o primeiro evento poderia disparar um reload
    # entre as duas gravações, com um key.pem ainda do certificado antigo.
    sleep 1
    nginx -s reload 2>/dev/null || true
  done
) &

exec nginx -g "daemon off;"
