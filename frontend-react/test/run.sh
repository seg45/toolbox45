#!/bin/sh
# Builda o app, sobe um `vite preview` local, roda a suíte de validação
# (Playwright, com /api/* mockado — ver login.spec.mjs) e derruba o
# preview no final. Não precisa de backend nenhum rodando — é a validação
# ISOLADA do frontend, equivalente ao fake_db usado nos testes do backend
# Python (Fase 1).
set -e
cd "$(dirname "$0")/.."
npm run build
npx vite preview --port 4173 --strictPort &
PREVIEW_PID=$!
trap 'kill $PREVIEW_PID 2>/dev/null || true' EXIT
sleep 1
node test/login.spec.mjs
