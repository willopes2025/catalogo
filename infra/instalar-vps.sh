#!/usr/bin/env bash
# Instala ou atualiza a Plataforma Aritana numa VPS que já tem um Caddy servindo outros sistemas.
#
# Primeira vez (no terminal da VPS, como root):
#   curl -fsSL https://raw.githubusercontent.com/willopes2025/catalogo/main/infra/instalar-vps.sh | DOMINIO=aritana.wideic.com bash
# Atualizar depois:
#   bash /opt/aritana/infra/instalar-vps.sh
#
# O script:
#  - baixa o código em /opt/aritana (atualiza com git pull nas próximas vezes);
#  - cria o .env com senhas aleatórias (só na primeira vez; nunca sobrescreve);
#  - sobe banco, API e painel em Docker, ouvindo só em 127.0.0.1 (portas 3310 e 3311);
#  - roda as migrações e, na primeira vez, cria o usuário administrador e dados de exemplo;
#  - ACRESCENTA um bloco para o domínio no Caddyfile existente (com cópia de segurança),
#    valida a configuração e recarrega o Caddy sem derrubar os outros sites.
set -euo pipefail

DOMINIO="${DOMINIO:-aritana.wideic.com}"
DIR=/opt/aritana
REPO=https://github.com/willopes2025/catalogo.git
PORTA_API=3310
PORTA_PAINEL=3311

passo() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
erro() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || erro "Rode como root (no terminal do hPanel já é root)."

passo "Conferindo Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || erro "Docker Compose não encontrado. Instale o plugin docker-compose-plugin."

for p in $PORTA_API $PORTA_PAINEL; do
  if ss -ltn "sport = :$p" | grep -q LISTEN && ! docker ps --format '{{.Names}}' | grep -q '^aritana-'; then
    erro "A porta $p já está em uso por outro sistema. Troque PORTA_API/PORTA_PAINEL neste script."
  fi
done

passo "Baixando o código em $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

PRIMEIRA_VEZ=0
if [ ! -f .env ]; then
  PRIMEIRA_VEZ=1
  passo "Criando o .env com senhas aleatórias"
  cat > .env <<EOF
DOMINIO=$DOMINIO
DB_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 48)
CORS_ORIGIN=https://$DOMINIO
PORTA_API=$PORTA_API
PORTA_PAINEL=$PORTA_PAINEL

# Integrações: preencher quando a Aritana enviar os acessos e rodar este script de novo.
SMTP_URL=
EMAIL_REMETENTE="Aritana Semijoias <naoresponda@aritanaonline.com.br>"
EMAIL_SUPORTE=contato@wideic.com
ASAAS_API_KEY=
ASAAS_URL=https://api-sandbox.asaas.com/v3
ASAAS_WEBHOOK_TOKEN=$(openssl rand -hex 20)
FOCUS_NFE_TOKEN=
FOCUS_NFE_URL=https://homologacao.focusnfe.com.br
ASSERTIVA_CLIENT_ID=
ASSERTIVA_CLIENT_SECRET=
EOF
  chmod 600 .env
fi

# Chave que cifra as credenciais salvas pela tela (Configurações › Integrações). Criada uma vez; nunca troque.
if ! grep -q '^CHAVE_CRIPTOGRAFIA=' .env; then
  echo "CHAVE_CRIPTOGRAFIA=$(openssl rand -hex 32)" >> .env
  echo "Chave de criptografia criada no .env (guarde uma cópia do .env junto com o backup)."
fi

passo "Montando e subindo os containers (a primeira vez demora alguns minutos)"
docker compose -f docker-compose.vps.yml --env-file .env up -d --build

passo "Esperando a API responder"
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORTA_API/api/saude" >/dev/null && break
  sleep 2
  [ "$i" = 60 ] && { docker logs --tail 60 aritana-api; erro "A API não subiu. Veja o log acima."; }
done
echo "API no ar."

passo "Conferindo o painel"
for i in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORTA_PAINEL/" >/dev/null && curl -sf "http://127.0.0.1:$PORTA_PAINEL/portal" >/dev/null && break
  sleep 2
  [ "$i" = 20 ] && { docker logs --tail 40 aritana-painel; erro "O painel não respondeu. Veja o log acima."; }
done
echo "Painel no ar."

if [ "$PRIMEIRA_VEZ" = 1 ]; then
  passo "Criando o administrador e os dados de exemplo (fictícios)"
  docker exec -e SEED_EXEMPLOS=1 -e ADMIN_EMAIL=admin@aritana.wideic.com aritana-api node dist/db/seed.js | tee /root/aritana-acesso-inicial.txt
  chmod 600 /root/aritana-acesso-inicial.txt
fi

passo "Configurando o Caddy para https://$DOMINIO"
BLOCO="$DOMINIO {
	encode gzip
	handle /api/* {
		reverse_proxy 127.0.0.1:$PORTA_API
	}
	handle {
		reverse_proxy 127.0.0.1:$PORTA_PAINEL
	}
}"

CADDY_CONTAINER="$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /caddy/ {print $1; exit}')"
if systemctl is-active --quiet caddy 2>/dev/null; then
  CADDYFILE=/etc/caddy/Caddyfile
  if grep -q "^$DOMINIO" "$CADDYFILE"; then
    echo "O Caddyfile já tem o bloco de $DOMINIO; nada a fazer."
  else
    cp "$CADDYFILE" "$CADDYFILE.antes-aritana-$(date +%Y%m%d%H%M%S)"
    printf '\n%s\n' "$BLOCO" >> "$CADDYFILE"
    if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
      systemctl reload caddy
      echo "Bloco acrescentado e Caddy recarregado (os outros sites continuam como estavam)."
    else
      cp "$(ls -t "$CADDYFILE".antes-aritana-* | head -1)" "$CADDYFILE"
      erro "A configuração do Caddy não validou; voltei o Caddyfile anterior. Nada foi alterado."
    fi
  fi
elif [ -n "$CADDY_CONTAINER" ]; then
  # Caddy em container: liga os containers da Aritana à rede dele e usa os nomes dos containers.
  REDE="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CADDY_CONTAINER" | awk '{print $1}')"
  HOSTMODE="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CADDY_CONTAINER")"
  CADDYFILE="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY_CONTAINER")"
  [ -n "$CADDYFILE" ] || erro "Não achei o Caddyfile do container $CADDY_CONTAINER. Acrescente o bloco abaixo à mão:\n$BLOCO"
  if [ "$HOSTMODE" != "host" ]; then
    docker network connect "$REDE" aritana-api 2>/dev/null || true
    docker network connect "$REDE" aritana-painel 2>/dev/null || true
    BLOCO="$(printf '%s' "$BLOCO" | sed "s#127.0.0.1:$PORTA_API#aritana-api:3000#; s#127.0.0.1:$PORTA_PAINEL#aritana-painel:80#")"
  fi
  if grep -q "^$DOMINIO" "$CADDYFILE"; then
    echo "O Caddyfile já tem o bloco de $DOMINIO; nada a fazer."
  else
    cp "$CADDYFILE" "$CADDYFILE.antes-aritana-$(date +%Y%m%d%H%M%S)"
    printf '\n%s\n' "$BLOCO" >> "$CADDYFILE"
    if docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
      docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
      echo "Bloco acrescentado ao Caddy do container $CADDY_CONTAINER e recarregado."
    else
      cp "$(ls -t "$CADDYFILE".antes-aritana-* | head -1)" "$CADDYFILE"
      erro "A configuração do Caddy não validou; voltei o Caddyfile anterior. Nada foi alterado."
    fi
  fi
else
  echo "Não encontrei Caddy rodando. Acrescente este bloco ao seu servidor web:"
  echo "$BLOCO"
fi

passo "Cópia de segurança diária do banco"
mkdir -p /opt/aritana-backups && chmod 700 /opt/aritana-backups
cat > /etc/cron.d/aritana-backup <<EOF
# Todo dia às 03:17: cópia do banco da Aritana, guardando 30 dias
17 3 * * * root docker exec aritana-db pg_dump -U aritana aritana | gzip > /opt/aritana-backups/aritana-\$(date +\%F).sql.gz && find /opt/aritana-backups -name '*.sql.gz' -mtime +30 -delete
# Cópia do .env (tem a chave que abre as credenciais salvas no banco)
20 3 * * * root install -m 600 /opt/aritana/.env /opt/aritana-backups/env-copia
EOF

passo "Pronto"
echo "Endereço: https://$DOMINIO"
[ "$PRIMEIRA_VEZ" = 1 ] && echo "Usuário e senha iniciais estão acima e guardados em /root/aritana-acesso-inicial.txt (só root lê)."
echo "Se o endereço ainda não abrir, confira o registro A de ${DOMINIO%%.*} no DNS da Hostinger."
