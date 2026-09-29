#!/bin/sh
# Builda o app, sobe um `vite preview` local, roda a suíte de validação
# (Playwright, com /api/* mockado — ver login.spec.mjs) e derruba o
# preview no final. Não precisa de backend nenhum rodando — é a validação
# ISOLADA do frontend, equivalente ao fake_db usado nos testes do backend
# Python (Fase 1).
#
# Roda TODOS os arquivos test/*.spec.mjs (glob — cada fatia nova só precisa
# adicionar seu próprio arquivo aqui, sem editar este script), não só
# login.spec.mjs (fatia 4: o script rodava só login.spec.mjs até aqui,
# apesar do comentário acima já dizer "test/*.spec.mjs" — appshell/commands/
# querybar/resolvers.spec.mjs nunca tinham sido conectados a `npm test`;
# corrigido nesta fatia). Cada arquivo roda com seu próprio browser
# (chromium.launch() interno) — uma falha num arquivo não interrompe os
# demais; o código de saída final reflete se ALGUM arquivo falhou.
set -e
cd "$(dirname "$0")/.."
npm run build
npx vite preview --port 4173 --strictPort &
PREVIEW_PID=$!
trap 'kill $PREVIEW_PID 2>/dev/null || true' EXIT
sleep 1
status=0
for f in test/*.spec.mjs; do
  echo "── $f ──"
  node "$f" || status=1
done
exit $status
