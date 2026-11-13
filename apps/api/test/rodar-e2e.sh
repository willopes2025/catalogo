#!/usr/bin/env bash
# Recria o banco de teste, sobe a API na porta 3100 e roda o teste de ponta a ponta.
set -euo pipefail
cd "$(dirname "$0")/.."
PGHOST_ADMIN=${PGHOST_ADMIN:-/tmp}
psql -h "$PGHOST_ADMIN" -U postgres -qc "drop database if exists aritana_teste" -c "create database aritana_teste owner aritana"
export DATABASE_URL=postgres://aritana:aritana@localhost:5432/aritana_teste ADMIN_EMAIL=teste@aritana.local ADMIN_SENHA=SenhaTeste123 SEED_EXEMPLOS=1
# Integrações apontando para os simuladores locais
export ASAAS_API_KEY=chave-teste ASAAS_URL=http://localhost:3199/asaas ASAAS_WEBHOOK_TOKEN=token-webhook-teste
export FOCUS_NFE_TOKEN=token-teste FOCUS_NFE_URL=http://localhost:3199/focus
pnpm -s build
pnpm -s db:migrate >/dev/null
pnpm -s db:seed >/dev/null
node test/simuladores.mjs > /tmp/aritana-simuladores.log 2>&1 &
SIM=$!
PORT=3100 node dist/main.js > /tmp/aritana-api-teste.log 2>&1 &
PID=$!
trap 'kill $PID $SIM' EXIT
for i in $(seq 1 30); do curl -sf localhost:3100/api/saude >/dev/null && break; sleep 0.5; done
API_URL=http://localhost:3100/api node --test test/e2e.test.mjs
