#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — procura vulnerabilidades conhecidas (HIGH/CRITICAL) nas imagens.
#
# Uso (no servidor ou na máquina de build, com docker e acesso à internet):
#   bash scripts/scan-images.sh                 # as 3 imagens do compose
#   bash scripts/scan-images.sh toolbox45-backend:latest   # uma imagem específica
#
# Roda o Trivy (aquasec/trivy, versão fixada abaixo) num container descartável.
# A imagem é exportada com `docker save` para um .tar temporário e entregue ao
# Trivy somente-leitura: o container do scanner NÃO recebe o socket do Docker.
# Só mostra falhas que já têm correção publicada (--ignore-unfixed). Código de
# saída 1 se achar algo — serve para rodar antes de um deploy.
#
# O banco de vulnerabilidades do Trivy fica no volume "toolbox45-trivy-cache".
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.58.2}"
IMAGES=("$@")
[ ${#IMAGES[@]} -gt 0 ] || IMAGES=(toolbox45-backend:latest toolbox45-frontend:latest postgres:16-alpine)

command -v docker >/dev/null 2>&1 || { echo "ERRO: docker não encontrado" >&2; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

status=0
for img in "${IMAGES[@]}"; do
  echo "== $img"
  if ! docker image inspect "$img" >/dev/null 2>&1; then echo "  imagem não existe localmente (docker compose build / pull)"; status=2; continue; fi
  docker save "$img" -o "$tmp/image.tar"
  docker run --rm -v "$tmp/image.tar:/image.tar:ro" -v toolbox45-trivy-cache:/root/.cache/ \
    "$TRIVY_IMAGE" image --input /image.tar --severity HIGH,CRITICAL --ignore-unfixed \
    --exit-code 1 --no-progress --scanners vuln || { rc=$?; [ "$rc" = 1 ] && status=1 || status=$rc; }
  rm -f "$tmp/image.tar"
done
[ "$status" = 0 ] && echo "Nenhuma vulnerabilidade HIGH/CRITICAL com correção disponível."
exit "$status"
