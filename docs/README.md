# Documentação — Toolbox45

- [`api.md`](api.md) — referência da API REST (endpoints, autenticação local/Google/API key, formatos de erro).
- [`install-instructions.txt`](install-instructions.txt) — instalação/deploy (Docker Compose, 3 containers), variáveis de ambiente, backup/restore, atualização, troubleshooting.
- [`server-overview.md`](server-overview.md) — visão geral do backend (Python/FastAPI): como roda, o que é semeado no primeiro boot, login com Google/Microsoft, compartilhamento e catálogos.
- [`../server-py/README.md`](../server-py/README.md) — o código do backend: estrutura, variáveis, imagem Docker e testes.
- [`../scripts/healthcheck.sh`](../scripts/healthcheck.sh) — health check da aplicação em produção (somente leitura): versão, containers, endpoints, TLS, integridade do banco, backups, logs e recursos do host. Uso: `sudo bash scripts/healthcheck.sh`.

O template de importação de comandos (`import-templates/`) fica fora desta pasta, junto ao CSV que ele documenta.
