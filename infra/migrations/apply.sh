#!/bin/sh
set -eu

secret_file="${GANSO_POSTGRES_PASSWORD_FILE:-/run/secrets/postgres_password}"
if [ ! -f "$secret_file" ]; then
  echo "migration rejected: PostgreSQL secret file is missing" >&2
  exit 2
fi

secret_size="$(wc -c < "$secret_file")"
secret_lines="$(awk 'END { print NR }' "$secret_file")"
if [ "$secret_size" -gt 4096 ]; then
  echo "migration rejected: PostgreSQL secret file exceeds 4096 bytes" >&2
  exit 2
fi
if [ "$secret_lines" -ne 1 ]; then
  echo "migration rejected: PostgreSQL secret file must contain exactly one line" >&2
  exit 2
fi
if ! nul_present="$(od -An -t u1 "$secret_file" | awk '
  { for (field = 1; field <= NF; field += 1) if ($field == 0) found = 1 }
  END { print found ? 1 : 0 }
')"; then
  echo "migration rejected: could not validate PostgreSQL secret file" >&2
  exit 2
fi
if [ "$nul_present" -ne 0 ]; then
  echo "migration rejected: PostgreSQL secret file contains a NUL byte" >&2
  exit 2
fi

password="$(sed 's/\r$//' "$secret_file")"
carriage_return="$(printf '\r')"
if [ -z "$password" ]; then
  echo "migration rejected: PostgreSQL secret file is empty" >&2
  exit 2
fi
case "$password" in
  *'
'* | *"$carriage_return"*)
    echo "migration rejected: PostgreSQL secret file must be a single line" >&2
    exit 2
    ;;
esac

escape_pgpass() {
  sed -e 's/\\/\\\\/g' -e 's/:/\\:/g'
}

umask 077
pgpass_file="$(mktemp)"
cleanup() {
  unset PGPASSFILE password escaped_password carriage_return
  rm -f "$pgpass_file"
}
abort() {
  cleanup
  exit 130
}
trap cleanup EXIT
trap abort HUP INT TERM

escaped_password="$(printf '%s' "$password" | escape_pgpass)"
printf '%s:%s:%s:%s:%s\n' \
  "$(printf '%s' "$PGHOST" | escape_pgpass)" \
  "$(printf '%s' "$PGPORT" | escape_pgpass)" \
  "$(printf '%s' "$PGDATABASE" | escape_pgpass)" \
  "$(printf '%s' "$PGUSER" | escape_pgpass)" \
  "$escaped_password" > "$pgpass_file"
chmod 0600 "$pgpass_file"
unset password escaped_password carriage_return
unset PGPASSWORD
export PGPASSFILE="$pgpass_file"

for migration in /migrations/sql/[0-9][0-9][0-9][0-9]_*.sql; do
  if [ ! -f "$migration" ]; then
    echo "migration rejected: no versioned SQL files found" >&2
    exit 2
  fi
  filename="$(basename "$migration")"
  version="${filename%%_*}"
  checksum="$(sha256sum "$migration" | awk '{print $1}')"

  existing="$(
    psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --command "SELECT checksum_sha256 FROM schema_versions WHERE component = 'foundation' AND version = ${version}::INTEGER" \
      2>/dev/null || true
  )"
  if [ -n "$existing" ]; then
    if [ "$existing" != "$checksum" ]; then
      echo "migration rejected: checksum mismatch for $filename" >&2
      exit 3
    fi
    echo "migration already applied: $filename"
    continue
  fi

  psql --no-psqlrc --set ON_ERROR_STOP=1 --single-transaction \
    --set "migration_version=$version" \
    --set "migration_checksum=$checksum" \
    --file "$migration"
  echo "migration applied: $filename"
done
