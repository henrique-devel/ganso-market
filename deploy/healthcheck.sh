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

check_url "$gateway/"
check_url "$gateway/api/health/live"
check_url "$gateway/api/health/ready"
echo "Ganso Market disponível em $gateway"
