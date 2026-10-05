# Toolbox45 — Fase 4D: runbook do corte (Node/JS → Python/React)

Estado de partida: `main` = `b4a44f3` (4A + 4B + 4C já no `origin`). Produção no docker01 ainda roda o stack antigo (Node + frontend JS). Nada neste runbook foi executado em produção.

Convenções: todo comando abaixo é literal, pronto para colar, no servidor docker01 (`/opt/toolbox45`), com `sudo` onde precisa. Comandos de leitura não alteram nada. Cada fase só começa com o seu "sim".

## O que foi pesquisado (resumo)

- Nada em `frontend-react/` ou `server-py/` depende do código antigo (só comentários citam `server/index.js` etc.). `img/` da raiz só era usado pelo frontend antigo (o React tem `frontend-react/public/img`). `import-templates/` não é referenciado por código, só pelas docs → **fica**.
- A apagar no commit do corte: `server/`, `Dockerfile` (raiz, Node), `js/`, `css/`, `img/`, `index.html`, `login.html`, `frontend/` (inclui `nginx.fase2-teste.conf`), `frontend-react/nginx.fase3-teste.conf`. Ajustes: `.gitignore` e `.dockerignore` (tirar entradas de `server/`).
- Já provado no sandbox com Docker e as imagens reais: stack novo sobe do zero; troca Node → Python sobre o mesmo banco e volumes mantém sessão, dados e certificado; rollback Python → Node funciona (inclusive o Node escrevendo sobre arquivos criados pelo Python). Uid do usuário `toolbox45` na imagem Node = 999 (conferir no docker01, P0).
- Armadilhas tratadas: Node e Python usam o mesmo uid nos volumes; `BACKUP_DIR` corrigido para `/app/backups`; o tag `toolbox45-backend:latest` é movido pelo build, então as imagens antigas são re-etiquetadas ANTES de buildar.

## P0 — Pré-voo (somente leitura, pode rodar agora)

```
cd /opt/toolbox45 && git status --short | head -5; git log -1 --oneline; free -m; swapon --show; df -h /var/lib/docker /opt
sudo docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
sudo docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}' | grep toolbox45
sudo docker exec toolbox45-backend id toolbox45
sudo docker exec toolbox45-backend ls -ln /app/tls /app/backups
sudo docker inspect toolbox45-backend --format '{{json .Mounts}}'
sudo docker exec toolbox45-backend pg_dump --version
sed 's/=.*/=<oculto>/' /opt/toolbox45/.env
sudo docker exec toolbox45-db psql -U toolbox45 -d toolbox45 -Atc "select count(*) from users" -c "select count(*) from commands" -c "select count(*) from sessions"
```

Critério para seguir: `id toolbox45` mostra `uid=999 gid=999` (se for outro número, eu ajusto o `server-py/Dockerfile` antes de qualquer coisa); `git status` limpo; memória + swap como antes; espaço em disco com folga para duas imagens (≥ 2 GB livres).

## P1 — Ensaio com cópia do banco (não toca a produção)

Roda o backend Python novo contra uma CÓPIA do banco real e deixa você validar a UI de teste (porta 8082) com dados reais. Roda a partir do `main` atual.

```
cd /opt/toolbox45 && git pull origin main && git log -1 --oneline
sudo docker build --network host -f server-py/Dockerfile -t toolbox45-backend-py:fase4-ensaio .
sudo docker exec toolbox45-db createdb -U toolbox45 toolbox45_ensaio
sudo docker exec toolbox45-db sh -c 'pg_dump -U toolbox45 -Fc toolbox45 | pg_restore -U toolbox45 -d toolbox45_ensaio --no-owner'
```

Fotografia ANTES (schema e contagens por tabela):

```
sudo docker exec toolbox45-db pg_dump -U toolbox45 -s toolbox45_ensaio | grep -v '^\\' > /tmp/schema_antes.sql
for t in $(sudo docker exec toolbox45-db psql -U toolbox45 -d toolbox45_ensaio -At -c "select tablename from pg_tables where schemaname='public' order by 1"); do echo "$t $(sudo docker exec toolbox45-db psql -U toolbox45 -d toolbox45_ensaio -At -c "select count(*) from \"$t\"")"; done > /tmp/contagens_antes.txt
cat /tmp/contagens_antes.txt
```

Subir o Python novo sobre a cópia (substitui o container de teste `toolbox45-backend-py`, que a UI da 8082 já usa):

```
umask 077; sudo docker inspect toolbox45-backend --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(PG|GOOGLE_|MICROSOFT_)' > /tmp/pg.env
sudo docker rm -f toolbox45-backend-py
sudo docker run -d --name toolbox45-backend-py --network toolbox45_default --env-file /tmp/pg.env -e PGDATABASE=toolbox45_ensaio toolbox45-backend-py:fase4-ensaio
rm -f /tmp/pg.env
sleep 8; sudo docker logs toolbox45-backend-py 2>&1 | tail -8
```

Você valida em `http://toolbox.seg45.com.br:8082` com o seu login real: comandos (quantidade e alguns cards), pastas, catálogos, Users, audit log. Não clique em Restore. (É uma cópia: pode mexer à vontade.)

Fotografia DEPOIS e comparação (me cole a saída):

```
sudo docker exec toolbox45-db pg_dump -U toolbox45 -s toolbox45_ensaio | grep -v '^\\' > /tmp/schema_depois.sql
for t in $(sudo docker exec toolbox45-db psql -U toolbox45 -d toolbox45_ensaio -At -c "select tablename from pg_tables where schemaname='public' order by 1"); do echo "$t $(sudo docker exec toolbox45-db psql -U toolbox45 -d toolbox45_ensaio -At -c "select count(*) from \"$t\"")"; done > /tmp/contagens_depois.txt
diff /tmp/schema_antes.sql /tmp/schema_depois.sql && echo "SCHEMA IGUAL"
diff /tmp/contagens_antes.txt /tmp/contagens_depois.txt && echo "CONTAGENS IGUAIS"
```

(Se você só olhou, sem criar nada, qualquer diferença nas contagens vem do boot do Python — eu analiso. O esperado é nenhuma ou só `audit_log`/`sessions`.)

Limpeza do ensaio:

```
sudo docker rm -f toolbox45-backend-py
sudo docker exec toolbox45-db dropdb -U toolbox45 toolbox45_ensaio
sudo docker rmi toolbox45-backend-py:fase4-ensaio
rm -f /tmp/schema_antes.sql /tmp/schema_depois.sql /tmp/contagens_antes.txt /tmp/contagens_depois.txt
```

Critério para seguir: UI da 8082 funcional com dados reais; schema igual (ou diferença explicada por mim); contagens iguais (ou explicadas).

## P2 — Commit do corte (eu preparo, no meu ambiente + seu repo; sem produção)

1. Tag `node-final` em `b4a44f3` (último commit com o código Node/JS) — você faz `git push origin node-final`. Mantém resolvíveis os comentários "porta de server/index.js" (`git show node-final:server/index.js`).
2. Commit único: `git rm -r server js css img frontend Dockerfile index.html login.html frontend-react/nginx.fase3-teste.conf`; ajustes de `.gitignore`/`.dockerignore`; docs que citam o histórico passam a citar a tag.
3. Verificação independente: clone limpo do commit, `docker compose build` (prova que nada depende do código apagado), stack completo, Playwright e pytest de novo.
4. Você dá `git push`; eu confiro por hash antes da P3.

## P3 — Janela do corte (docker01)

Aviso aos usuários: indisponibilidade esperada de ~1–2 minutos; sessões continuam válidas (mesma tabela/cookie — provado no sandbox).

3.1 Backup de segurança e imagens antigas (ANTES de buildar):

```
cd /opt/toolbox45
sudo docker tag toolbox45-backend:latest toolbox45-backend:node-pre-fase4
sudo docker tag toolbox45-frontend:latest toolbox45-frontend:js-pre-fase4
sudo sh -c 'docker exec toolbox45-db pg_dump -U toolbox45 -Fc toolbox45 > /root/toolbox45-pre-fase4.dump'
sudo sh -c 'ls -l /root/toolbox45-pre-fase4.dump && docker exec -i toolbox45-db pg_restore -l < /root/toolbox45-pre-fase4.dump | head -5'
```

3.2 Trazer o código e pré-buildar (produção segue no ar; um build por vez por causa da RAM):

```
cd /opt/toolbox45 && git pull origin main && git log -1 --oneline
sudo docker compose build toolbox45-backend
sudo docker compose build toolbox45-frontend
```

3.3 Trocar (início da indisponibilidade):

```
cd /opt/toolbox45 && sudo docker compose up -d --no-build
sleep 30
sudo docker compose ps
sudo docker logs toolbox45-backend 2>&1 | tail -12
curl -s http://localhost/api/health
```

Esperado: `toolbox45-db` Running/Healthy (não recriado), backend e frontend recriados, backend `healthy`, health `{"ok":true}`, log com "schema aplicado".

3.4 Validação (você, no navegador, `https://toolbox.seg45.com.br`):
- sem pedir login de novo, se já estava logado (sessão preservada) — ou login normal;
- lista de comandos carrega (mesma quantidade de antes), pastas, filtros;
- logo e favicon aparecem (sem 403 em `/img/*`);
- Configurações → Database → Backup now (cria o `.dump` no volume); Download funciona; NÃO clicar em Restore;
- Configurações → System → SSL Certificate: mostra o certificado atual (somente leitura); o HTTPS na 443 continua com o mesmo certificado;
- Configurações → Users e Groups (como super_admin);
- se Google/Microsoft estiverem configurados: um login real pelo provedor;
- `sudo docker exec toolbox45-backend ls -ln /app/backups /app/tls` com dono `999`.

3.5 Depois de validar (não antes): aposentar os containers de teste e imagens de ensaio:

```
sudo docker rm -f toolbox45-frontend-react-fase3 toolbox45-backend-py toolbox45-frontend-fase2
sudo docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

(`docker rm -f` de nome inexistente só dá erro inofensivo.) As imagens `*-pre-fase4` e o dump `/root/toolbox45-pre-fase4.dump` ficam guardados por pelo menos uma semana.

## Rollback (decisão sua, a qualquer momento da P3.4 em diante)

Volta ao Node/JS em ~1 minuto, sem mexer nos dados (os dois backends leem o mesmo banco; provado no sandbox, nos dois sentidos):

```
cd /opt/toolbox45 && git fetch --tags origin && git checkout -q node-final
sudo docker tag toolbox45-backend:node-pre-fase4 toolbox45-backend:latest
sudo docker tag toolbox45-frontend:js-pre-fase4 toolbox45-frontend:latest
sudo docker compose up -d --no-build
sleep 30; sudo docker compose ps; curl -s http://localhost/api/health
```

Para voltar a seguir com o novo depois: `git checkout -q main` e repetir a P3.2–3.3. O dump `/root/toolbox45-pre-fase4.dump` só entra em jogo se os DADOS forem danificados (não é esperado: as migrações do Python são aditivas e idempotentes) — e restaurá-lo é decisão explícita sua, nunca pelo botão Restore da UI.

## Pontos de atenção

- RAM do docker01 (951 MiB + 1 GiB de swap): builds em sequência, nunca em paralelo; conferir `free -m` antes.
- Backup agendado: depois do corte só o Python agenda (lê as mesmas chaves). Conferir em Configurações → Database se o agendamento continua como estava.
- O bug do `pg_dump` v15 do Node deixa de existir com o corte (cliente 16 na imagem Python).
- Itens independentes ainda em aberto: testar `/restore` em produção (decisão sua; padrão: não), upload de logo/import de certificado em produção, dimensionamento de RAM.
