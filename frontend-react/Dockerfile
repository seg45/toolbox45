# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — frontend React (Fase 3) image (toolbox45-frontend-react)
#
# Build de produção (Vite, npm run build) + nginx — MESMO padrão do
# frontend/Dockerfile atual (JS puro): reaproveita o mesmo nginx.conf
# (proxy /api/, TLS hot-reload via inotify) e o mesmo docker-entrypoint.sh
# (cópia 1:1, ver comentário lá), trocando só a origem dos arquivos
# estáticos — agora vem de `npm run build` (Vite), não mais copiado direto
# do repo.
#
# Build context é a raiz do repo (igual a frontend/Dockerfile e
# server-py/Dockerfile) — necessário pra referenciar frontend-react/ com
# caminho relativo à raiz:
#   cd /opt/toolbox45 && docker build -f frontend-react/Dockerfile -t toolbox45-frontend-react .
#
# Nesta fatia (Fase 3, fatia 1 — setup + login) esta imagem só é usada num
# container de teste ISOLADO, porta nova, apontando pro backend Python —
# não faz parte do docker-compose.yml ainda (mesmo critério da Fase 2 pro
# frontend JS atual). A entrada em produção de verdade só acontece na
# Fase 4 (corte).
# ════════════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY frontend-react/package.json frontend-react/package-lock.json* ./
RUN npm install
COPY frontend-react/ .
RUN npm run build

FROM nginx:1.27-alpine

RUN apk add --no-cache inotify-tools

COPY frontend-react/nginx.conf /etc/nginx/nginx.conf
COPY frontend-react/docker-entrypoint.sh /docker-entrypoint-tls.sh
RUN chmod +x /docker-entrypoint-tls.sh
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80 443
ENTRYPOINT ["/docker-entrypoint-tls.sh"]
