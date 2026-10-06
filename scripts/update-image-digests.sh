#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — confere/atualiza os digests das imagens base fixadas.
#
# As imagens base ficam fixadas por digest (FROM python:3.12-slim@sha256:...) em
# server-py/Dockerfile, frontend-react/Dockerfile e docker-compose.yml: um rebuild
# nunca puxa, sem aviso, uma imagem diferente da testada. O custo é que correções
# de segurança da imagem base só entram quando o digest é atualizado — este script
# mostra se há algo novo e, com --apply, grava os digests novos.
#
# Uso (precisa de docker e de rede para o registry):
#   bash scripts/update-image-digests.sh           # só confere (exit 1 se houver digest novo)
#   bash scripts/update-image-digests.sh --apply   # reescreve os arquivos
#
# Depois de --apply: revise o `git diff`, rode `bash scripts/scan-images.sh` e os
# testes, FAÇA BACKUP do banco se a imagem do Postgres mudou, faça o commit e o
# deploy (`docker compose build && docker compose up -d`). Para o Postgres só
# sobem aqui as atualizações da mesma versão major (a tag 16-alpine).
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
FILES="server-py/Dockerfile frontend-react/Dockerfile docker-compose.yml"
TAGS="python:3.12-slim node:20-bookworm-slim nginx:1.27-alpine postgres:16-alpine"

command -v docker >/dev/null 2>&1 || { echo "ERRO: docker não encontrado" >&2; exit 2; }

outdated=0
for tag in $TAGS; do
  out=$(docker buildx imagetools inspect "$tag" 2>&1) || { echo "ERRO: não consegui consultar $tag no registry: $(printf '%s' "$out" | tail -1 | cut -c1-160)" >&2; exit 2; }
  new=$(printf '%s\n' "$out" | awk '/^Digest:/ && !d {print $2; d=1}')
  case "$new" in sha256:????????????????????????????????????????????????????????????????) ;; *) echo "ERRO: resposta sem digest para $tag" >&2; exit 2 ;; esac
  cur=$(grep -rhoE "${tag//./\\.}@sha256:[0-9a-f]{64}" $FILES 2>/dev/null | head -1 | sed 's/.*@//')
  if [ "$cur" = "$new" ]; then
    printf '  [ OK  ] %-24s %s\n' "$tag" "${new:0:19}…"
  else
    outdated=1
    printf '  [NOVO ] %-24s %s → %s\n' "$tag" "${cur:0:19}…" "${new:0:19}…"
    if [ "$APPLY" = 1 ]; then
      # shellcheck disable=SC2086
      sed -i -E "s#${tag//./\\.}(@sha256:[0-9a-f]{64})?#${tag}@${new}#g" $FILES
    fi
  fi
done

if [ "$outdated" = 0 ]; then echo "Tudo em dia."; exit 0; fi
if [ "$APPLY" = 1 ]; then echo "Digests atualizados. Revise com 'git diff' antes de commitar."; exit 0; fi
echo "Há digests novos. Rode com --apply para gravar."; exit 1
