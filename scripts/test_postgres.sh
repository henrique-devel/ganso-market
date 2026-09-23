#!/bin/sh
# Only ephemeral Docker resources; never read server.env or local secrets.
set -eu
cd "$(dirname "$0")/.."
# Adapter fixtures use the public workspace exports, which point at built contracts.
# The dedicated PG job starts from a clean checkout and does not run API pretest.
npm run build --workspace @ganso-market/contracts
umask 077
scratch="$(mktemp -d)"
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -fv "$container" >/dev/null; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# Follow the project's exact version/digest without loading its runtime config.
image="$(sed -n 's/^    image: \(postgres:[^ ]*\)$/\1/p' docker-compose.yml | sort -u)"
test "$(printf '%s\n' "$image" | wc -l | tr -d ' ')" = 1
case "$image" in postgres:*@sha256:*) ;; *) echo 'missing pinned PostgreSQL image' >&2; exit 1;; esac
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex") + "\n")' > "$scratch/password"
container_name="ganso-data03-qa01-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
container="$(docker run --detach --rm --name "$container_name" \
  --publish 127.0.0.1::5432 --tmpfs /var/lib/postgresql \
  --env POSTGRES_USER=postgres --env POSTGRES_DB=ganso_test \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/test_password \
  --mount "type=bind,src=$scratch/password,dst=/run/secrets/test_password,readonly" \
  --mount "type=bind,src=$(pwd)/infra/migrations/apply.sh,dst=/migrations/apply.sh,readonly" \
  --mount "type=bind,src=$(pwd)/migrations,dst=/migrations/sql,readonly" \
  "$image" postgres -c timezone=UTC -c max_connections=40)"
attempt=0
# The image briefly starts a socket-only server during initdb. Migrations use
# TCP, so do not mistake that bootstrap server for the final ready instance.
until docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d ganso_test >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then echo 'PostgreSQL readiness failed' >&2; exit 1; fi
  sleep 1
done
docker exec --env PGHOST=127.0.0.1 --env PGPORT=5432 \
  --env PGUSER=postgres --env PGDATABASE=ganso_test \
  --env GANSO_POSTGRES_PASSWORD_FILE=/run/secrets/test_password \
  "$container" sh /migrations/apply.sh > "$scratch/migrations.log" 2>&1 || {
  cat "$scratch/migrations.log"; exit 1;
}
printf 'PostgreSQL image: %s\nMigrations applied: ' "$image"
grep -c '^migration applied:' "$scratch/migrations.log"
port="$(docker port "$container" 5432/tcp | sed 's/127.0.0.1://')"
password="$(cat "$scratch/password")"
export GANSO_TEST_DATABASE_URL="postgresql://postgres:$password@127.0.0.1:$port/ganso_test"
unset password
export GANSO_DATA03_TEST_CONTAINER="$container_name"
node scripts/run_pg_tests.mjs
