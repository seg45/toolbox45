# Backend Python (FastAPI) -- Fase 1 da migracao (ver plano no Project
# toolbox45). Ainda NAO referenciado em docker-compose.yml: este servico
# roda isolado, so pra validacao manual, ate a Fase 2 (frontend antigo
# apontado pra ca lado a lado com o backend Node em producao).
#
# Build a partir da RAIZ do repo (mesmo padrao do Dockerfile do backend Node
# na raiz), nao de dentro de server-py/ -- por causa do COPY server/schema.sql
# abaixo:
#   docker build -f server-py/Dockerfile -t toolbox45-backend-py:latest .
FROM python:3.12-slim

WORKDIR /app

COPY server-py/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# server/schema.sql e a mesma fonte de verdade usada pelo backend Node (ver
# app/db.py) -- copiado aqui pra dentro da imagem junto com o codigo Python.
COPY server/schema.sql ./server/schema.sql
COPY server-py/app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
