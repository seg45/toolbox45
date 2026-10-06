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

# IP do gateway da rede Docker (rota padrao deste container). Se as conexoes
# dos usuarios chegarem com esse IP (docker-proxy/userland-proxy reescreve a
# origem), o limite de taxa POR IP do nginx viraria global; o nginx.conf usa
# $tb_gw para nao limitar essa origem (ver bloco "Limites de taxa" la).
# /run e tmpfs (rootfs somente-leitura) -- ver docker-compose.yml.
GW=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')
mkdir -p /run/toolbox45
case "$GW" in
  *[!0-9.]*|"")   # vazio ou nao-IPv4: nenhum gateway conhecido (limite por IP normal)
    printf 'geo $tb_gw {\n  default 0;\n}\n' > /run/toolbox45/tb-gateway.conf
    ;;
  *)
    printf 'geo $tb_gw {\n  default 0;\n  %s 1;\n}\n' "$GW" > /run/toolbox45/tb-gateway.conf
    echo "toolbox45-frontend: gateway Docker $GW sem limite de taxa por IP (origem indistinguivel)"
    ;;
esac

(
  while true; do
    inotifywait -q -e modify,create,move,delete,close_write /etc/nginx/tls 2>/dev/null
    sleep 1
    nginx -s reload 2>/dev/null || true
  done
) &

exec nginx -g "daemon off;"
