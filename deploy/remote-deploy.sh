#!/bin/sh
set -eu

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

project_dir=/opt/ganso-market
deploy_root="$project_dir/.deploy"
incoming_root="$deploy_root/incoming"
backups_root="$deploy_root/backups"
validator=/usr/local/lib/ganso-market/validate_release.py
secret_scanner=/usr/local/lib/ganso-market/scan_secrets.py
max_receive_mebibytes=51
stage_dir=
backup_dir=
deployment_started=0
deployment_succeeded=0

fail() {
  echo "deploy recusado: $1" >&2
  exit 1
}

original_command="${SSH_ORIGINAL_COMMAND:-}"
case "$original_command" in
  "deploy "*) release_sha=${original_command#deploy } ;;
  *) fail "comando SSH inválido" ;;
esac
case "$release_sha" in
  "" | *[!0-9a-f]*) fail "revisão inválida" ;;
esac
[ "${#release_sha}" -eq 40 ] || fail "revisão inválida"

for executable in docker flock gzip make mktemp python3 rsync; do
  command -v "$executable" >/dev/null 2>&1 || fail "dependência ausente: $executable"
done
[ -f "$validator" ] && [ ! -L "$validator" ] || fail "validador confiável ausente"
[ -f "$secret_scanner" ] && [ ! -L "$secret_scanner" ] || fail "scanner confiável ausente"
[ -d "$project_dir" ] && [ ! -L "$project_dir" ] || fail "diretório do projeto inválido"
[ "$(stat -c %u "$project_dir")" -eq 0 ] || fail "diretório do projeto não pertence ao root"

server_env="$project_dir/deploy/server.env"
secret_dir="$project_dir/infra/secrets/local"
secret_file="$secret_dir/postgres_password"
[ -f "$server_env" ] && [ ! -L "$server_env" ] || fail "deploy/server.env inválido"
[ -d "$secret_dir" ] && [ ! -L "$secret_dir" ] || fail "diretório de secrets inválido"
[ -f "$secret_file" ] && [ ! -L "$secret_file" ] || fail "secret PostgreSQL inválido"

sync_code() {
  source_dir=$1
  destination_dir=$2
  rsync \
    --archive \
    --delete \
    --exclude '/.deploy/' \
    --exclude '/.git/' \
    --exclude '/.env' \
    --exclude '/deploy/server.env' \
    --exclude '/infra/secrets/local/' \
    "$source_dir/" \
    "$destination_dir/"
}

rollback_release() {
  sync_code "$backup_dir" "$project_dir" && (cd "$project_dir" && make server-up)
}

prune_backups() {
  kept=0
  find "$backups_root" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -name '????????T??????Z.??????' \
    -print \
    | sort -r \
    | while IFS= read -r candidate; do
      kept=$((kept + 1))
      [ "$kept" -le 5 ] && continue
      [ ! -L "$candidate" ] || continue
      [ "$(stat -c %u "$candidate")" -eq 0 ] || continue
      case "$candidate" in
        "$backups_root"/*) rm -rf -- "$candidate" ;;
      esac
    done
}

finalize() {
  status=$?
  trap - EXIT HUP INT TERM PIPE
  if [ "$deployment_started" -eq 1 ] && [ "$deployment_succeeded" -eq 0 ]; then
    echo "deploy interrompido ou inválido; restaurando o código anterior" >&2
    if rollback_release; then
      echo "rollback do código concluído; a migration, se aplicada, não foi revertida" >&2
    else
      echo "rollback automático falhou; intervenção manual necessária" >&2
    fi
  fi
  if [ "$deployment_started" -eq 0 ] && [ -n "$backup_dir" ]; then
    case "$backup_dir" in
      "$backups_root"/*) rm -rf -- "$backup_dir" ;;
    esac
  fi
  if [ -n "$stage_dir" ]; then
    case "$stage_dir" in
      "$incoming_root"/*) rm -rf -- "$stage_dir" ;;
    esac
  fi
  exit "$status"
}

trap finalize EXIT
trap 'exit 130' HUP INT TERM PIPE

umask 077
[ ! -L "$deploy_root" ] || fail ".deploy não pode ser symlink"
[ ! -e "$deploy_root" ] || [ -d "$deploy_root" ] || {
  fail ".deploy deve ser um diretório real"
}
for deploy_directory in "$incoming_root" "$backups_root"; do
  [ ! -L "$deploy_directory" ] || fail "subdiretório de deploy não pode ser symlink"
  [ ! -e "$deploy_directory" ] || [ -d "$deploy_directory" ] || {
    fail "subdiretório de deploy inválido"
  }
done
install -d -m 0700 "$incoming_root" "$backups_root"
chmod 0700 "$deploy_root" "$incoming_root" "$backups_root"
[ "$(stat -c %u "$deploy_root")" -eq 0 ] || fail ".deploy não pertence ao root"
lock_file="$deploy_root/deploy.lock"
if [ -e "$lock_file" ] || [ -L "$lock_file" ]; then
  [ -f "$lock_file" ] && [ ! -L "$lock_file" ] || fail "lock de deploy inválido"
  [ "$(stat -c %u "$lock_file")" -eq 0 ] || fail "lock de deploy não pertence ao root"
else
  install -m 0600 /dev/null "$lock_file"
fi
chmod 0600 "$lock_file"
exec 9<>"$lock_file"
flock -x 9

stage_dir=$(mktemp -d "$incoming_root/${release_sha}.XXXXXX")
archive="$stage_dir/release.tar.gz"

dd iflag=fullblock bs=1048576 count="$max_receive_mebibytes" of="$archive" 2>/dev/null
archive_bytes=$(wc -c < "$archive" | tr -d ' ')
[ "$archive_bytes" -le 52428800 ] || fail "arquivo recebido excede 50 MiB"
gzip -t "$archive" || fail "arquivo recebido não é gzip válido"

release_dir="$stage_dir/release"
python3 "$validator" "$archive" "$release_dir"
python3 "$secret_scanner" \
  --root "$release_dir" \
  --secret-dir "$secret_dir"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=$(mktemp -d "$backups_root/${timestamp}.XXXXXX")

sync_code "$project_dir" "$backup_dir" || fail "não foi possível criar o backup do código"

apply_release() {
  sync_code "$release_dir" "$project_dir" || return 1
  (cd "$project_dir" && make server-update)
}

deployment_started=1
if apply_release; then
  current_sha_tmp=$(mktemp "$deploy_root/current-sha.XXXXXX")
  printf '%s\n' "$release_sha" > "$current_sha_tmp"
  chmod 0600 "$current_sha_tmp"
  mv "$current_sha_tmp" "$deploy_root/current-sha"
  deployment_succeeded=1
  prune_backups || echo "aviso: não foi possível limitar os backups antigos" >&2
  echo "deploy concluído: $release_sha"
  exit 0
fi

echo "deploy falhou" >&2
exit 1
