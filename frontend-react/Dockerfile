# ════════════════════════════════════════════════════════════════════════
# Toolbox45 — imagem do frontend (React/Vite + nginx), servico
# toolbox45-frontend no docker-compose.yml.
#
# Multi-stage: `npm run build` (Vite) num estagio node, e o nginx serve o
# resultado (frontend-react/nginx.conf: proxy /api/ para o backend Python,
# HTTPS com hot-reload de TLS via inotify — docker-entrypoint.sh).
#
# Build context é a raiz do repo, por causa dos caminhos frontend-react/...:
#   docker build -f frontend-react/Dockerfile -t toolbox45-frontend:latest .
# ════════════════════════════════════════════════════════════════════════
FROM node:20-bookworm-slim AS build
WORKDIR /app
# Limita o heap do Node no build (tsc + vite): sem teto, o V8 deixa o heap
# crescer ate faltar RAM no host de ~1 GiB (docker01) e o kernel mata
# processos por OOM. O build precisa de bem menos que isso (testado: passa
# com 256 MB); 384 MB deixa folga.
ENV NODE_OPTIONS=--max-old-space-size=384
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
# Garante leitura pelo usuario do nginx (workers nao rodam como root) mesmo se
# o checkout/contexto de build trouxer arquivos com modo restrito (ex.: 0700
# em public/img) — senao /img/* responde 403.
RUN chmod -R a+rX /usr/share/nginx/html

EXPOSE 80 443
ENTRYPOINT ["/docker-entrypoint-tls.sh"]
