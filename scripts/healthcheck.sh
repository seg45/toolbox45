#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — health check da aplicação (SOMENTE LEITURA).
#
# Uso (no servidor, na raiz do repositório ou em qualquer lugar):
#   sudo bash scripts/healthcheck.sh
#   sudo bash scripts/healthcheck.sh --check-default-admin   # opcional, ver abaixo
#
# Verifica: versão/deploy, containers, endpoints HTTP/HTTPS, certificado TLS,
# integridade do banco (constraints, sequências, referências órfãs, dados),
# backups, logs, recursos do host e higiene básica de segurança. Nada é
# alterado. Cada linha sai como [ OK ], [AVISO] ou [FALHA]; o código de saída
# é 1 se houver alguma FALHA (0 caso contrário), então serve também em cron.
#
# --check-default-admin: tenta UM login com admin/admin (a credencial padrão
# da primeira instalação) em /api/auth/login e avisa se funcionar. Fica
# desligado por padrão porque é uma tentativa de login de verdade (aparece no
# log de acesso); rode só no seu próprio servidor.
#
# Variáveis opcionais: DC="docker compose", BASE_URL=http://localhost,
# PSQL="psql ... -At" (substitui o acesso ao banco via container; usado nos
# testes).
# ════════════════════════════════════════════════════════════════════════
set -u
cd "$(dirname "$0")/.." || exit 2

DC="${DC:-docker compose}"
BASE_URL="${BASE_URL:-http://localhost}"
CHECK_DEFAULT_ADMIN=0
[ "${1:-}" = "--check-default-admin" ] && CHECK_DEFAULT_ADMIN=1

PASS=0; WARN=0; FAIL=0
ok()   { printf '  [ OK  ] %s\n' "$*"; PASS=$((PASS+1)); }
warn() { printf '  [AVISO] %s\n' "$*"; WARN=$((WARN+1)); }
bad()  { printf '  [FALHA] %s\n' "$*"; FAIL=$((FAIL+1)); }
info() { printf '          %s\n' "$*"; }
sec()  { printf '\n== %s\n' "$*"; }

HAVE_DOCKER=1
command -v docker >/dev/null 2>&1 || HAVE_DOCKER=0

# Consulta ao banco: um valor por linha / colunas separadas por "|".
q() {
  if [ -n "${PSQL:-}" ]; then
    # shellcheck disable=SC2086
    $PSQL -c "$1" 2>&1
  else
    $DC exec -T toolbox45-db psql -U "${POSTGRES_USER:-toolbox45}" -d "${POSTGRES_DB:-toolbox45}" -At -c "$1" 2>&1
  fi
}
# Compara um contador esperado = 0.
expect_zero() { # descricao, query que devolve um inteiro
  local n; n=$(q "$2" | head -1)
  case "$n" in
    ''|*[!0-9]*) bad "$1 — consulta falhou: ${n:-sem resposta}" ;;
    0) ok "$1" ;;
    *) bad "$1: $n registro(s)" ;;
  esac
}
http_code() { local c; c=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" 2>/dev/null); echo "${c:-000}"; }

printf 'Toolbox45 — health check em %s (%s)\n' "$(hostname)" "$(date '+%F %T %Z')"

# ──────────────────────────────────────────────────────────────────────
sec "1. Versão e deploy"
if git rev-parse --git-dir >/dev/null 2>&1; then
  info "commit atual: $(git log -1 --format='%h %s' | cut -c1-90)"
  if [ -z "$(git status --porcelain 2>/dev/null)" ]; then ok "árvore do git limpa (sem alterações locais)"; else warn "há alterações locais não commitadas: $(git status --porcelain | head -3 | tr '\n' ';')"; fi
  git fetch -q origin 2>/dev/null
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
  case "$behind" in 0) ok "servidor está em dia com origin/main" ;; '?') warn "não consegui consultar origin/main" ;; *) warn "origin/main tem $behind commit(s) a mais (falta git pull)" ;; esac
  # Imagem mais antiga que o último commit que mexeu no código dela?
  if [ "$HAVE_DOCKER" = 1 ]; then
    for pair in "toolbox45-backend:latest|server-py" "toolbox45-frontend:latest|frontend-react"; do
      img=${pair%%|*}; dir=${pair##*|}
      created=$(docker image inspect -f '{{.Created}}' "$img" 2>/dev/null)
      if [ -z "$created" ]; then warn "imagem $img não encontrada"; continue; fi
      img_ts=$(date -d "$created" +%s 2>/dev/null || echo 0)
      code_ts=$(git log -1 --format=%ct -- "$dir" docker-compose.yml 2>/dev/null || echo 0)
      if [ "$img_ts" -ge "$code_ts" ]; then ok "imagem $img é mais nova que o último commit de $dir"; else warn "imagem $img (de $(date -d "@$img_ts" '+%F %R')) é mais antiga que o último commit em $dir (de $(date -d "@$code_ts" '+%F %R')) — falta rebuild"; fi
    done
  fi
else
  warn "não é um repositório git (pulei as checagens de versão)"
fi
[ -e cookies.txt ] && warn "cookies.txt existe na raiz do repositório (pode conter sessão válida) — remova" || ok "sem cookies.txt solto na raiz do repositório"

# ──────────────────────────────────────────────────────────────────────
sec "2. Containers"
if [ "$HAVE_DOCKER" = 1 ]; then
  for c in toolbox45-db toolbox45-backend toolbox45-frontend; do
    st=$(docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{.HostConfig.OomScoreAdj}}|{{.State.StartedAt}}' "$c" 2>/dev/null)
    if [ -z "$st" ]; then bad "$c: container não existe"; continue; fi
    IFS='|' read -r status health restarts oomk oomadj started <<<"$st"
    if [ "$status" = "running" ]; then ok "$c: running (desde ${started%%.*})"; else bad "$c: estado=$status"; fi
    case "$health" in healthy|-) ;; *) bad "$c: healthcheck=$health" ;; esac
    [ "$oomk" = "true" ] && bad "$c: foi morto por OOM" || true
    [ "$restarts" != "0" ] && warn "$c: reiniciou $restarts vez(es) desde a criação"
    case "$c" in toolbox45-db|toolbox45-backend) [ "$oomadj" = "-500" ] && ok "$c: oom_score_adj=-500 (protegido)" || warn "$c: oom_score_adj=$oomadj (esperado -500, ver docker-compose.yml)" ;; esac
  done
  nconf=$($DC exec -T toolbox45-frontend nginx -t 2>&1)
  echo "$nconf" | grep -q "test is successful" && ok "nginx: configuração válida" || bad "nginx -t falhou: $(echo "$nconf" | tail -1)"
  pw=$(docker exec toolbox45-backend printenv PGPASSWORD 2>/dev/null)
  if [ -z "$pw" ]; then warn "não consegui ler PGPASSWORD do backend (pulei a checagem de senha padrão)"; elif [ "$pw" = "toolbox45" ]; then warn "banco usa a senha padrão (toolbox45); baixo risco porque a porta não é exposta, mas troque em produção (POSTGRES_PASSWORD no .env)"; else ok "senha do banco não é a padrão"; fi
else
  warn "docker não disponível neste ambiente (pulei containers)"
fi

# ──────────────────────────────────────────────────────────────────────
sec "3. Endpoints HTTP/HTTPS"
body=$(curl -s -m 10 "$BASE_URL/api/health" 2>/dev/null)
echo "$body" | grep -q '"ok":[ ]*true' && ok "GET /api/health → $body" || bad "GET /api/health inesperado: $(printf '%s' "${body:-sem resposta}" | head -c 100)"
code=$(http_code -k "https://localhost/api/health"); [ "$code" = 200 ] && ok "HTTPS 443 /api/health → 200" || bad "HTTPS 443 /api/health → $code"
for path in / /login.html /api/auth/providers /api/system/appearance /api/system/logo /img/logo-toolbox45.png; do
  code=$(http_code "$BASE_URL$path"); [ "$code" = 200 ] && ok "GET $path → 200" || bad "GET $path → $code"
done
for path in /api/commands /api/me /api/users /api/api-keys /api/backups /api/audit-log; do
  code=$(http_code "$BASE_URL$path")
  case "$code" in 401|403) ok "GET $path sem sessão → $code (protegido)" ;; *) bad "GET $path sem sessão → $code (deveria exigir login: 401/403)" ;; esac
done
# Assets estáticos referenciados pelo index.html (pega o bug de permissão 403 do nginx).
assets=$(curl -s -m 10 "$BASE_URL/" 2>/dev/null | grep -o '/assets/[^"]*\.\(js\|css\)' | sort -u)
if [ -z "$assets" ]; then bad "index.html não referencia nenhum /assets/*.js|css"; else
  na=0; nb=0
  for a in $assets; do
    code=$(http_code "$BASE_URL$a"); if [ "$code" = 200 ]; then na=$((na+1)); else nb=$((nb+1)); bad "asset $a → $code"; fi
  done
  [ "$nb" = 0 ] && ok "$na asset(s) do index.html respondem 200"
fi
t=$(curl -s -o /dev/null -m 10 -w '%{time_total}' "$BASE_URL/api/health" 2>/dev/null || echo 99)
awk -v t="$t" 'BEGIN{exit !(t<1.0)}' && ok "latência de /api/health: ${t}s" || warn "latência de /api/health alta: ${t}s"
if command -v ss >/dev/null 2>&1; then
  exposed=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E '(^|:)(5432|8000)$' | grep -v -E '^(127\.0\.0\.1|\[::1\]):' | head -2)
  [ -z "$exposed" ] && ok "banco (5432) e backend (8000) não estão expostos no host" || bad "porta interna exposta no host: $exposed"
fi
if [ "$CHECK_DEFAULT_ADMIN" = 1 ]; then
  code=$(http_code -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}' "$BASE_URL/api/auth/login")
  case "$code" in 401|403|400|422) ok "login admin/admin (padrão) rejeitado ($code)" ;; 200) bad "login admin/admin FUNCIONA — troque a senha do admin agora (Settings → Users)" ;; *) warn "teste de login padrão inconclusivo (HTTP $code)" ;; esac
fi

# ──────────────────────────────────────────────────────────────────────
sec "4. Certificado TLS"
if command -v openssl >/dev/null 2>&1; then
  cert=$(echo | openssl s_client -connect localhost:443 -servername "${TLS_HOST:-toolbox.seg45.com.br}" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null)
  if [ -z "$cert" ]; then bad "não consegui ler o certificado servido em :443"; else
    info "$(echo "$cert" | grep subject | cut -c1-100)"
    info "$(echo "$cert" | grep issuer | cut -c1-100)"
    end=$(echo "$cert" | sed -n 's/^notAfter=//p'); end_ts=$(date -d "$end" +%s 2>/dev/null || echo 0); left=$(( (end_ts - $(date +%s)) / 86400 ))
    if [ "$left" -lt 0 ]; then bad "certificado EXPIRADO há $((-left)) dia(s)"; elif [ "$left" -lt 30 ]; then warn "certificado expira em $left dia(s) ($end)"; else ok "certificado válido por mais $left dia(s) ($end)"; fi
    s=$(echo "$cert" | sed -n 's/^subject=//p'); i=$(echo "$cert" | sed -n 's/^issuer=//p'); [ "$s" = "$i" ] && info "(autoassinado — normal se ninguém importou um certificado próprio)"
  fi
else warn "openssl não disponível (pulei o certificado)"; fi

# ──────────────────────────────────────────────────────────────────────
sec "5. Banco de dados — estado"
ver=$(q "SELECT split_part(version(),' ',2);" | head -1); case "$ver" in [0-9]*) ok "PostgreSQL $ver respondendo" ;; *) bad "banco não respondeu: ${ver:-sem resposta}" ;; esac
info "tamanho: $(q "SELECT pg_size_pretty(pg_database_size(current_database()));" | head -1)"
conn=$(q "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database();" | head -1); maxc=$(q "SHOW max_connections;" | head -1)
case "$conn$maxc" in *[!0-9]*|'') warn "não consegui ler as conexões" ;; *) [ "$conn" -lt $((maxc*8/10)) ] && ok "conexões: $conn de $maxc" || warn "conexões altas: $conn de $maxc" ;; esac
expect_zero "sem constraints inválidas" "SELECT count(*) FROM pg_constraint WHERE NOT convalidated;"
expect_zero "sem índices inválidos" "SELECT count(*) FROM pg_index WHERE NOT indisvalid;"
expect_zero "sem transações presas há mais de 10 min" "SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND now()-state_change > interval '10 minutes';"
# Sequências: se last_value < max(id), o próximo INSERT colide (acontece depois de restore/import).
seqbad=0
for t in commands command_lines folders notes audit_log shares groups links api_keys; do
  seq=$(q "SELECT pg_get_serial_sequence('$t','id');" | head -1)
  [ -z "$seq" ] && continue
  mx=$(q "SELECT coalesce(max(id),0) FROM $t;" | head -1); lv=$(q "SELECT last_value FROM $seq;" | head -1)
  case "$mx$lv" in *[!0-9]*|'') warn "sequência de $t ilegível"; continue ;; esac
  [ "$lv" -lt "$mx" ] && { bad "sequência de $t atrasada (last_value=$lv < max(id)=$mx) — próximo INSERT vai falhar"; seqbad=1; }
done
[ "$seqbad" = 0 ] && ok "sequências (ids) consistentes com os dados"

# ──────────────────────────────────────────────────────────────────────
sec "6. Banco de dados — integridade lógica"
expect_zero "comandos sem nenhuma linha de conteúdo" "SELECT count(*) FROM commands c WHERE NOT EXISTS (SELECT 1 FROM command_lines l WHERE l.command_id=c.id);"
expect_zero "linhas com line_type inválido" "SELECT count(*) FROM command_lines WHERE line_type NOT IN ('cmd','note','warn','info','ok','image');"
expect_zero "linhas com variant inválida" "SELECT count(*) FROM command_lines WHERE variant NOT IN ('default','empty');"
expect_zero "comandos cujo tópico primário não está em command_topics" "SELECT count(*) FROM commands c WHERE NOT EXISTS (SELECT 1 FROM command_topics t WHERE t.command_id=c.id AND t.topic=c.topic);"
expect_zero "tópicos de comandos que não existem no catálogo" "SELECT count(*) FROM command_topics ct WHERE NOT EXISTS (SELECT 1 FROM topics t WHERE t.key=ct.topic);"
expect_zero "vendors de comandos fora do catálogo" "SELECT count(*) FROM command_vendors x WHERE NOT EXISTS (SELECT 1 FROM vendors v WHERE v.key=x.vendor);"
expect_zero "systems de comandos fora do catálogo" "SELECT count(*) FROM command_systems x WHERE NOT EXISTS (SELECT 1 FROM systems s WHERE s.key=x.system);"
expect_zero "versões de comandos fora do catálogo" "SELECT count(*) FROM command_versions x WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE v.key=x.version);"
expect_zero "ambientes de comandos fora do catálogo" "SELECT count(*) FROM command_environments x WHERE NOT EXISTS (SELECT 1 FROM environments e WHERE e.key=x.environment);"
expect_zero "pastas de usuários que não existem" "SELECT count(*) FROM folders f WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.username=f.username);"
expect_zero "notas de usuários que não existem" "SELECT count(*) FROM notes n WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.username=n.username);"
expect_zero "favoritos de usuários que não existem" "SELECT count(*) FROM user_favorites f WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.username=f.username);"
expect_zero "subpastas de dono diferente do da pasta-pai" "SELECT count(*) FROM folders c JOIN folders p ON p.id=c.parent_id WHERE c.username<>p.username;"
expect_zero "pastas que são pai de si mesmas" "SELECT count(*) FROM folders WHERE parent_id=id;"
expect_zero "roles de usuário inválidos" "SELECT count(*) FROM users WHERE role NOT IN ('user','admin','super_admin');"
expect_zero "contas locais sem hash de senha" "SELECT count(*) FROM users WHERE is_local=1 AND password_hash IS NULL;"
expect_zero "handles duplicados" "SELECT count(*) FROM (SELECT handle FROM users WHERE handle IS NOT NULL GROUP BY handle HAVING count(*)>1) d;"
expect_zero "usuários sem handle" "SELECT count(*) FROM users WHERE handle IS NULL OR handle='';"
n=$(q "SELECT count(*) FROM users WHERE role='super_admin' AND disabled=0;" | head -1)
[ "${n:-0}" -ge 1 ] 2>/dev/null && ok "há $n super_admin ativo(s)" || bad "nenhum super_admin ativo — ninguém consegue administrar"
pend=$(q "SELECT count(*) FROM users WHERE disabled=1;" | head -1); [ "${pend:-0}" = 0 ] && ok "nenhuma conta desabilitada/pendente" || warn "$pend conta(s) desabilitada(s)/pendente(s) de aprovação: $(q "SELECT string_agg(username||'('||auth_provider||')', ', ') FROM users WHERE disabled=1;" | head -1)"
exp=$(q "SELECT count(*) FROM sessions WHERE expires_at < now();" | head -1); act=$(q "SELECT count(*) FROM sessions WHERE expires_at >= now();" | head -1)
info "sessões ativas: ${act:-?}; expiradas aguardando limpeza: ${exp:-?}"
[ "${exp:-0}" -gt 1000 ] 2>/dev/null && warn "muitas sessões expiradas acumuladas ($exp)"
info "contagens: $(q "SELECT (SELECT count(*) FROM commands)||' comandos, '||(SELECT count(*) FROM command_lines)||' linhas, '||(SELECT count(*) FROM users)||' usuários, '||(SELECT count(*) FROM folders)||' pastas, '||(SELECT count(*) FROM notes)||' notas, '||(SELECT count(*) FROM audit_log)||' eventos de auditoria';" | head -1)"
info "última escrita no audit log: $(q "SELECT coalesce(to_char(max(ts),'YYYY-MM-DD HH24:MI')||' por '||(SELECT username FROM audit_log ORDER BY ts DESC LIMIT 1),'(vazio)') FROM audit_log;" | head -1)"

# ──────────────────────────────────────────────────────────────────────
sec "7. Backups"
if [ "$HAVE_DOCKER" = 1 ]; then
  sched=$(q "SELECT string_agg(data_key||'='||value, ' ' ORDER BY data_key) FROM user_data WHERE username='__global_defaults__' AND data_key LIKE 'backupSchedule%';" | head -1)
  info "agendamento: ${sched:-(não configurado)}"
  newest=$(docker exec toolbox45-backend sh -c 'ls -t /app/backups 2>/dev/null | head -1')
  if [ -z "$newest" ]; then warn "nenhum arquivo em /app/backups"; else
    mt=$(docker exec toolbox45-backend stat -c %Y "/app/backups/$newest" 2>/dev/null || echo 0); age=$(( ($(date +%s) - mt) / 3600 )); sz=$(docker exec toolbox45-backend stat -c %s "/app/backups/$newest" 2>/dev/null || echo 0)
    info "mais recente: $newest ($((sz/1024)) KiB, há ${age}h)"
    [ "$sz" -gt 1024 ] 2>/dev/null || bad "o backup mais recente está vazio ou minúsculo"
    echo "$sched" | grep -q 'backupScheduleEnabled=1' && { [ "$age" -le 36 ] && ok "backup recente (agendamento diário ativo)" || warn "agendamento ativo, mas o último backup tem ${age}h"; } || { [ "$age" -le 192 ] && ok "último backup tem ${age}h" || warn "último backup tem ${age}h e o agendamento não está ativo"; }
  fi
fi

# ──────────────────────────────────────────────────────────────────────
sec "8. Logs das últimas 24 h"
if [ "$HAVE_DOCKER" = 1 ]; then
  be=$($DC logs --since 24h toolbox45-backend 2>&1 | grep -i -E "traceback|exception|critical| error " | grep -v -i "HTTP/1.1\" [24]0" )
  nbe=$(printf '%s' "$be" | grep -c . || true)
  if [ "${nbe:-0}" = 0 ]; then ok "backend: sem erros/exceções"; else warn "backend: $nbe linha(s) de erro/exceção (últimas abaixo)"; printf '%s\n' "$be" | tail -4 | cut -c1-160 | sed 's/^/          /'; fi
  ng=$($DC logs --since 24h toolbox45-frontend 2>&1 | grep -c "\[error\]" || true)
  [ "${ng:-0}" = 0 ] && ok "nginx: sem [error]" || warn "nginx: $ng linha(s) [error]"
  db=$($DC logs --since 24h toolbox45-db 2>&1 | grep -c -E "FATAL|PANIC|ERROR" || true)
  [ "${db:-0}" = 0 ] && ok "postgres: sem FATAL/ERROR" || warn "postgres: $db linha(s) FATAL/ERROR"
fi
oomk=$(journalctl -k --since "24 hours ago" 2>/dev/null | grep -c -i -E "out of memory|oom-kill" || true)
[ "${oomk:-0}" = 0 ] && ok "kernel: sem OOM nas últimas 24 h" || bad "kernel: $oomk evento(s) de OOM nas últimas 24 h"

# ──────────────────────────────────────────────────────────────────────
sec "9. Host (recursos e sistema)"
avail=$(free -m | awk '/^Mem:/{print $7}'); total=$(free -m | awk '/^Mem:/{print $2}')
[ "$avail" -ge 150 ] && ok "memória disponível: ${avail} MiB de ${total}" || warn "memória disponível baixa: ${avail} MiB de ${total}"
swt=$(free -m | awk '/^Swap:/{print $2}'); swu=$(free -m | awk '/^Swap:/{print $3}')
[ "${swt:-0}" -ge 1500 ] && ok "swap: ${swu} de ${swt} MiB em uso" || warn "swap pequeno (${swt} MiB); recomendado 2 GiB neste servidor"
[ "${swt:-0}" -gt 0 ] && [ "$swu" -gt $((swt*7/10)) ] && warn "swap em mais de 70% de uso"
du=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}'); [ "$du" -lt 80 ] && ok "disco /: ${du}% usado" || { [ "$du" -lt 90 ] && warn "disco /: ${du}% usado" || bad "disco /: ${du}% usado"; }
cores=$(nproc); load=$(awk '{print $2}' /proc/loadavg); awk -v l="$load" -v c="$cores" 'BEGIN{exit !(l<c)}' && ok "load (5 min) $load com $cores vCPU" || warn "load (5 min) $load ≥ $cores vCPU"
ntp=$(timedatectl show -p NTPSynchronized --value 2>/dev/null); [ "$ntp" = yes ] && ok "relógio sincronizado (NTP)" || warn "relógio não sincronizado (NTP=$ntp) — afeta expiração de sessão e certificado"
[ -e /var/run/reboot-required ] && warn "o sistema pede reinício (/var/run/reboot-required)" || ok "sem reinício pendente"
fu=$(systemctl --failed --no-legend 2>/dev/null | wc -l); [ "$fu" = 0 ] && ok "nenhuma unidade systemd com falha" || warn "$fu unidade(s) systemd com falha: $(systemctl --failed --no-legend | awk '{print $2}' | head -3 | tr '\n' ' ')"
[ "$(systemctl is-active docker 2>/dev/null)" = active ] && ok "serviço docker ativo" || warn "serviço docker não está 'active'"
info "uptime: $(uptime -p 2>/dev/null)"

# ──────────────────────────────────────────────────────────────────────
printf '\n══════════════════════════════════════\n'
printf ' RESULTADO: %s OK, %s aviso(s), %s falha(s)\n' "$PASS" "$WARN" "$FAIL"
printf '══════════════════════════════════════\n'
[ "$FAIL" -gt 0 ] && exit 1
exit 0
