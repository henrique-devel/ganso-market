#!/bin/sh
set -eu

gateway_port="${GANSO_HTTP_PORT:-8080}"
gateway="http://127.0.0.1:${gateway_port}"

cleanup() {
  docker compose --profile model down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

wait_for_code() {
  expected="$1"
  url="$2"
  attempts=40
  while [ "$attempts" -gt 0 ]; do
    actual="$(curl --silent --output /dev/null --write-out '%{http_code}' "$url" || true)"
    if [ "$actual" = "$expected" ]; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 1
  done
  echo "compose smoke failed: expected HTTP $expected from $url" >&2
  return 1
}

docker compose --profile model up --build --detach
wait_for_code 200 "$gateway/api/health/live"
wait_for_code 200 "$gateway/api/health/ready"
curl --fail --silent --show-error "$gateway/" >/dev/null

log_marker="synthetic-query-value-must-not-be-logged"
curl --fail --silent --show-error "$gateway/api/health/live?token=$log_marker" >/dev/null
curl --fail --silent --show-error "$gateway/?token=$log_marker" >/dev/null
if docker compose logs --no-color nginx api web | grep --fixed-strings "$log_marker" >/dev/null; then
  echo "compose smoke failed: a query-string value reached structured logs" >&2
  exit 1
fi

for service in nginx api web; do
  if ! docker compose logs --no-color --no-log-prefix "$service" | python3 -c '
import json
import sys

records = []
for line in sys.stdin:
    if not line.strip():
        continue
    if not line.lstrip().startswith("{"):
        continue
    try:
        records.append(json.loads(line))
    except json.JSONDecodeError:
        raise SystemExit("compose smoke failed: non-JSON application/access log") from None
if not records or not any(record.get("correlation_id") for record in records):
    raise SystemExit("structured logs lack correlation ID")
'; then
    echo "compose smoke failed: invalid structured logs for $service" >&2
    exit 1
  fi
done

metrics_code="$(curl --silent --output /dev/null --write-out '%{http_code}' "$gateway/api/metrics")"
if [ "$metrics_code" != "404" ]; then
  echo "compose smoke failed: gateway exposed internal metrics" >&2
  exit 1
fi

postgres_container="$(docker compose ps --quiet postgres)"
postgres_bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$postgres_container")"
if [ "$postgres_bindings" != "{}" ] && [ "$postgres_bindings" != "null" ]; then
  echo "compose smoke failed: PostgreSQL has a published port" >&2
  exit 1
fi

docker compose exec -T api node -e \
  "Promise.all(['http://market-engine:8081/health/live','http://market-engine:8081/health/ready'].map(async u=>{const r=await fetch(u);if(!r.ok)throw new Error('engine health failed')})).catch(()=>process.exit(1))"
docker compose exec -T model-worker python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health/ready', timeout=2)"

docker compose run --rm migrate
python3 scripts/check_runtime_memory.py

docker compose stop postgres
wait_for_code 503 "$gateway/api/health/ready"
wait_for_code 200 "$gateway/api/health/live"
docker compose exec -T api node -e \
  "Promise.all([['http://market-engine:8081/health/live',200],['http://market-engine:8081/health/ready',503]].map(async ([u,s])=>{const r=await fetch(u);if(r.status!==s)throw new Error('engine degraded health mismatch')})).catch(()=>process.exit(1))"

docker compose start postgres
wait_for_code 200 "$gateway/api/health/ready"
docker compose exec -T api node -e \
  "fetch('http://market-engine:8081/health/ready').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"

docker compose --profile model down --remove-orphans
remaining="$(docker compose --profile model ps --quiet)"
if [ -n "$remaining" ]; then
  echo "compose smoke failed: shutdown left running containers" >&2
  exit 1
fi
trap - EXIT HUP INT TERM
echo "compose smoke passed; volumes were preserved"
