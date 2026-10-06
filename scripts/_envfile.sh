# Funcoes para ler/gravar o arquivo .env (ao lado do docker-compose.yml).
# Usado por rotate-db-password.sh e init-secret-key.sh (`source`, nao executar).
ENV_FILE="${ENV_FILE:-.env}"

# env_get CHAVE -> valor (sem aspas) ou vazio
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  local line
  line=$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -1) || true
  [ -n "$line" ] || return 0
  line=${line#*=}
  line=${line%\"}; line=${line#\"}; line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

# env_set CHAVE VALOR -> troca a linha existente ou acrescenta; mantem permissoes (600 se novo)
env_set() {
  local key="$1" val="$2" tmp
  if [ ! -f "$ENV_FILE" ]; then ( umask 077; : > "$ENV_FILE" ); fi
  tmp=$(mktemp "${ENV_FILE}.XXXXXX"); chmod 600 "$tmp"
  if grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
    K="$key" V="$val" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]}
      $0 ~ "^[[:space:]]*" k "=" { if (!done) { print k "=" v; done=1 } ; next } { print }' "$ENV_FILE" > "$tmp"
  else
    { cat "$ENV_FILE"; [ -z "$(tail -c1 "$ENV_FILE")" ] || echo; printf '%s=%s\n' "$key" "$val"; } > "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
