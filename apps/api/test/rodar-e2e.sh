#!/usr/bin/env bash
# Recria o banco de teste, sobe a API na porta 3100 e roda o teste de ponta a ponta.
set -euo pipefail
cd "$(dirname "$0")/.."
PGHOST_ADMIN=${PGHOST_ADMIN:-/tmp}
psql -h "$PGHOST_ADMIN" -U postgres -qc "drop database if exists aritana_teste" -c "create database aritana_teste owner aritana"
export DATABASE_URL=postgres://aritana:aritana@localhost:5432/aritana_teste ADMIN_EMAIL=teste@aritana.local ADMIN_SENHA=SenhaTeste123 SEED_EXEMPLOS=1
# Integrações apontando para os simuladores locais
export ASAAS_API_KEY=chave-teste ASAAS_URL=http://localhost:3199/asaas ASAAS_WEBHOOK_TOKEN=token-webhook-teste
export IA_CLAUDE_URL=http://localhost:3199/claude IA_OPENAI_URL=http://localhost:3199/openai IA_AGENTE_ESPERA_MS=60 WEBHOOKS_AO_INICIAR=0 EVOLUTION_EXTERNA_HTTP=1 FOCUS_NFE_TOKEN=token-teste FOCUS_NFE_URL=http://localhost:3199/focus META_ADS_URL=http://localhost:3199/meta JUERI_URL=http://localhost:3199/jueri META_WHATSAPP_URL=http://localhost:3199/meta-wa ZAPI_URL=http://localhost:3199/zapi EVOLUTION_URL=http://localhost:3199/evo VIACEP_URL=http://localhost:3199/viacep BRASILAPI_URL=http://localhost:3199/brasilapi CNPJWS_URL=http://localhost:3199/cnpjws FCM_URL=http://localhost:3199/fcm APNS_URL=http://localhost:3198 GOOGLE_OAUTH_URL=http://localhost:3199/google/auth GOOGLE_TOKEN_URL=http://localhost:3199/google/token GOOGLE_CALENDAR_URL=http://localhost:3199/google/calendar/v3 EVOLUTION_API_KEY=chave-evo-teste EVOLUTION_WEBHOOK_URL=http://localhost:3100 PAINEL_URL=http://localhost:3100 CRM_AUTOMATICO=0 COBRANCA_AUTOMATICA=0 CRA_URL=http://localhost:3199/cra/xml/protestos.php CRA_USUARIO=cra-usuario CRA_SENHA=cra-senha CRA_CODIGO=123 ARQUIVOS_DIR=$(mktemp -d)
pnpm -s build
pnpm -s db:migrate >/dev/null
pnpm -s db:seed >/dev/null
node test/simuladores.mjs > /tmp/aritana-simuladores.log 2>&1 &
SIM=$!
AVISOS_AUTOMATICOS=0 PORT=3100 node dist/main.js > /tmp/aritana-api-teste.log 2>&1 &
PID=$!
trap 'kill $PID $SIM' EXIT
for i in $(seq 1 30); do curl -sf localhost:3100/api/saude >/dev/null && break; sleep 0.5; done
API_URL=http://localhost:3100/api node --test test/e2e.test.mjs
