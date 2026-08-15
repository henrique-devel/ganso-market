#!/bin/sh
set -eu

server_env="${SERVER_ENV:-deploy/server.env}"
if [ ! -f "$server_env" ]; then
  echo "healthcheck: arquivo de configuração ausente: $server_env" >&2
  exit 2
fi

set -a
# O arquivo contém somente pares CHAVE=VALOR controlados pelo operador.
# shellcheck disable=SC1090
. "$server_env"
set +a

gateway_port="${GANSO_HTTP_PORT:-80}"
gateway="http://127.0.0.1:${gateway_port}"

check_url() {
  url="$1"
  attempts=30
  while [ "$attempts" -gt 0 ]; do
    if curl --noproxy '*' --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 1
  done
  echo "healthcheck: sem resposta válida em $url" >&2
  return 1
}

check_engine() {
  attempts=30
  while [ "$attempts" -gt 0 ]; do
    if docker compose --env-file "$server_env" exec -T api node -e \
      "fetch('http://market-engine:8081/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 1
  done
  echo "healthcheck: market-engine não está pronto" >&2
  return 1
}

check_url "$gateway/"
check_url "$gateway/api/health/live"
check_url "$gateway/api/health/ready"
check_engine
echo "Ganso Market disponível em $gateway"
