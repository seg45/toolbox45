#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — troca a senha do banco (padrão "toolbox45") por uma aleatória.
#
# Uso (no servidor, a partir da raiz do repositório):
#   sudo bash scripts/rotate-db-password.sh        # pede confirmação
#   sudo bash scripts/rotate-db-password.sh -y     # sem perguntar
#   sudo bash scripts/rotate-db-password.sh --force  # troca mesmo que já não seja a padrão
#
# O que faz, nesta ordem:
#   1. gera uma senha nova (48 caracteres hex);
#   2. guarda uma cópia do .env (.env.bak-AAAAMMDDhhmmss, modo 600);
#   3. ALTER USER no Postgres (container toolbox45-db);
#   4. grava POSTGRES_PASSWORD no .env (modo 600; o .gitignore já exclui .env);
#   5. recria db e backend (`docker compose up -d`; ~15 s de indisponibilidade da API);
#   6. confere: backend saudável, senha nova aceita e senha antiga recusada.
# Qualquer falha desfaz tudo (senha antiga volta no banco e no .env) e sai com 1.
#
# A senha NÃO é impressa. Para vê-la: grep POSTGRES_PASSWORD .env (guarde no
# cofre de senhas). Os dados do banco não são tocados.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/_envfile.sh
. scripts/_envfile.sh

DC="${DC:-docker compose}"
ASSUME_YES=0; FORCE=0
for a in "$@"; do case "$a" in -y|--yes) ASSUME_YES=1 ;; --force) FORCE=1 ;; *) echo "opção desconhecida: $a" >&2; exit 2 ;; esac; done

PGU="$(env_get POSTGRES_USER)"; PGU="${PGU:-toolbox45}"
OLD="$(env_get POSTGRES_PASSWORD)"; OLD="${OLD:-toolbox45}"

say()  { printf '%s\n' "$*"; }
fail() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || fail "openssl não encontrado"
$DC ps --status running --format '{{.Name}}' 2>/dev/null | grep -qx toolbox45-db || fail "o container toolbox45-db não está rodando (docker compose up -d)"

if [ "$OLD" != "toolbox45" ] && [ "$FORCE" = 0 ]; then
  say "O banco já usa uma senha própria (não é a padrão). Nada a fazer."
  say "Use --force se quiser trocá-la por uma nova mesmo assim."
  exit 0
fi

if [ "$ASSUME_YES" = 0 ]; then
  say "Vai trocar a senha do usuário '$PGU' do Postgres e recriar os containers db e backend."
  say "A API fica indisponível por cerca de 15 segundos. Os dados não são alterados."
  read -r -p "Continuar? [s/N] " ans
  case "$ans" in s|S|y|Y|sim|SIM) ;; *) say "Cancelado."; exit 1 ;; esac
fi

NEW="$(openssl rand -hex 24)"
BACKUP=""
if [ -f "$ENV_FILE" ]; then
  BACKUP="${ENV_FILE}.bak-$(date +%Y%m%d%H%M%S)"
  cp -p "$ENV_FILE" "$BACKUP"; chmod 600 "$BACKUP"
fi

psql_sock() { $DC exec -T toolbox45-db psql -U "$PGU" -d postgres -v ON_ERROR_STOP=1 -q; }
# senha, comando -> conecta pelo endereço de REDE do container (toolbox45-db), que exige
# senha. Não usar 127.0.0.1: o pg_hba.conf da imagem oficial confia nele (trust).
psql_tcp()  {
  $DC exec -T -e PGPASSWORD="$1" toolbox45-db psql -h toolbox45-db -U "$PGU" -d postgres -At -c "$2" 2>&1
}

rollback() {
  printf '\nFALHOU — desfazendo...\n' >&2
  printf 'ALTER USER "%s" PASSWORD '"'"'%s'"'"';\n' "$PGU" "$OLD" | $DC exec -T toolbox45-db psql -U "$PGU" -d postgres -q >/dev/null 2>&1 || true
  if [ -n "$BACKUP" ]; then cat "$BACKUP" > "$ENV_FILE"; else rm -f "$ENV_FILE"; fi
  $DC up -d >/dev/null 2>&1 || true
  printf 'Senha antiga restaurada. Cópia do .env: %s\n' "${BACKUP:-(não havia .env)}" >&2
  exit 1
}

say "1/5 alterando a senha no Postgres..."
printf 'ALTER USER "%s" PASSWORD '"'"'%s'"'"';\n' "$PGU" "$NEW" | psql_sock || rollback
say "2/5 gravando POSTGRES_PASSWORD no $ENV_FILE (modo 600)..."
env_set POSTGRES_PASSWORD "$NEW"
chmod 600 "$ENV_FILE"
say "3/5 recriando db e backend..."
$DC up -d >/dev/null 2>&1 || rollback

say "4/5 aguardando o backend ficar saudável..."
healthy=0
for _ in $(seq 1 45); do
  st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' toolbox45-backend 2>/dev/null || echo none)
  [ "$st" = healthy ] && { healthy=1; break; }
  sleep 2
done
[ "$healthy" = 1 ] || { say "o backend não ficou saudável em 90 s."; rollback; }

say "5/5 conferindo..."
[ "$(psql_tcp "$NEW" 'select 1' | tail -1)" = 1 ] || { say "a senha nova não foi aceita."; rollback; }
if psql_tcp "$OLD" 'select 1' | grep -q '^1$'; then say "a senha antiga ainda é aceita."; rollback; fi

say ""
say "Pronto: a senha do banco foi trocada. A nova está em $ENV_FILE (POSTGRES_PASSWORD) — guarde no cofre de senhas."
[ -n "$BACKUP" ] && say "Cópia do .env anterior: $BACKUP (apague depois de guardar a senha nova; ela contém a senha antiga)."
say "Confirme com: sudo bash scripts/healthcheck.sh"
