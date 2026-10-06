#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — cria a chave que cifra o client secret do OAuth no banco.
#
# Uso (no servidor, a partir da raiz do repositório):
#   sudo bash scripts/init-secret-key.sh
#
# Gera TOOLBOX45_SECRET_KEY (64 caracteres hex) no .env (modo 600), reinicia o
# backend e confere que nenhum secret do OAuth ficou em texto puro no banco. A
# chave vive SÓ no .env do servidor — nunca no banco nem nos backups; por isso um
# dump sozinho não revela o secret. Detalhes em server-py/app/secrets_box.py.
#
# ATENÇÃO:
#   * guarde a chave no cofre de senhas: perdê-la = reconfigurar o OAuth em
#     Settings → System (o secret cifrado não é recuperável);
#   * restaurar um backup em OUTRO servidor exige levar o mesmo .env (ou a chave);
#   * se a chave já existir, o script não a troca (trocar = reconfigurar o OAuth).
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/_envfile.sh
. scripts/_envfile.sh

DC="${DC:-docker compose}"
PGU="$(env_get POSTGRES_USER)"; PGU="${PGU:-toolbox45}"
PGD="$(env_get POSTGRES_DB)"; PGD="${PGD:-toolbox45}"
say()  { printf '%s\n' "$*"; }
fail() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || fail "openssl não encontrado"
$DC ps --status running --format '{{.Name}}' 2>/dev/null | grep -qx toolbox45-backend || fail "o backend não está rodando (docker compose up -d)"

CUR="$(env_get TOOLBOX45_SECRET_KEY)"
if [ -n "$CUR" ]; then
  say "TOOLBOX45_SECRET_KEY já existe no $ENV_FILE — nada a gerar."
else
  [ -f "$ENV_FILE" ] && { BK="${ENV_FILE}.bak-$(date +%Y%m%d%H%M%S)"; cp -p "$ENV_FILE" "$BK"; chmod 600 "$BK"; say "cópia do .env: $BK"; }
  env_set TOOLBOX45_SECRET_KEY "$(openssl rand -hex 32)"
  chmod 600 "$ENV_FILE"
  say "chave gerada e gravada em $ENV_FILE (TOOLBOX45_SECRET_KEY, modo 600)."
fi

say "recriando o backend para aplicar..."
$DC up -d toolbox45-backend >/dev/null 2>&1 || fail "docker compose up -d falhou"
healthy=0
for _ in $(seq 1 45); do
  st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' toolbox45-backend 2>/dev/null || echo none)
  [ "$st" = healthy ] && { healthy=1; break; }
  sleep 2
done
[ "$healthy" = 1 ] || fail "o backend não ficou saudável em 90 s (veja: docker compose logs toolbox45-backend)"

plain=$($DC exec -T toolbox45-db psql -U "$PGU" -d "$PGD" -At -c "SELECT COUNT(*) FROM oauth_settings WHERE client_secret IS NOT NULL AND client_secret NOT LIKE 'enc:v1:%'" 2>&1 | head -1)
case "$plain" in
  0) say "OK: nenhum secret do OAuth em texto puro no banco." ;;
  ''|*[!0-9]*) fail "não consegui conferir o banco: $plain" ;;
  *) fail "ainda há $plain secret(s) em texto puro — veja: docker compose logs toolbox45-backend | grep oauth" ;;
esac
say ""
say "IMPORTANTE: guarde o valor de TOOLBOX45_SECRET_KEY (grep TOOLBOX45_SECRET_KEY $ENV_FILE) no cofre de senhas."
say "Sem ele, um backup restaurado em outro servidor não consegue ler o secret do OAuth."
