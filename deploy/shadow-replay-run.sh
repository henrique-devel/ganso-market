#!/bin/sh
# RFC-029 D1/D2. One shadow-replay round, written to disk, detached from any SSH
# session because systemd -- not a terminal -- owns the process.
#
# Two things this script is careful about, both measured rather than assumed:
#
#   * A round of mode B took 710 s in production on 2026-09-03, and the same
#     round run through `ssh ... docker compose exec -T` without a keepalive
#     died at 1.646 s and 1.268 s with exit 255 and no diagnosis. The fix is not
#     a longer timeout; it is not being attached to a socket that can close.
#
#   * The reader must never see half a file. Every JSON lands as a temporary
#     file in the SAME directory and is then renamed over its final name, so a
#     `latest-B.json` that exists is a `latest-B.json` that is complete. A
#     reader that opens it mid-write is impossible, not unlikely.
#
# Failure is read off the EXIT STATUS, never off the text: `message` is fixed at
# "shadow_replay_failed" but `reason_code` varies (shadow-replay-cli.ts:809-815).
# A failed mode writes `latest-{mode}.error.json` and LEAVES the last good
# `latest-{mode}.json` alone, so the screen can say "today's round failed"
# instead of showing yesterday's numbers as if they were today's.
#
# Nothing here writes to the database. The CLI it calls is read-only by two
# independent locks (sweepstore.ts:61-75) and this script only ever redirects
# its stdout into a file.
set -eu

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
helper="$script_dir/shadow_replay_job.py"

# Where the JSONs land. The api container bind-mounts this same path :ro and
# reads it through GANSO_SHADOW_REPLAY_DIR, which is why the name is shared.
SHADOW_REPLAY_DIR="${GANSO_SHADOW_REPLAY_DIR:-/var/lib/ganso/shadow-replay}"
# P4, approved as proposed: a 72 h window for mode B.
WINDOW_HOURS="${GANSO_SHADOW_REPLAY_WINDOW_HOURS:-72}"
SWEEP_KEY="${GANSO_SHADOW_REPLAY_SWEEP_KEY:-costs.edgeLiqMin}"
SWEEP_VALUES="${GANSO_SHADOW_REPLAY_SWEEP_VALUES:-0.01,0.015,0.02,0.03}"
# 30 dated files per mode, so ~60 small JSONs at steady state.
KEEP="${GANSO_SHADOW_REPLAY_KEEP:-30}"
SERVER_ENV="${GANSO_SERVER_ENV:-deploy/server.env}"

dry_run=no
case "${1:-}" in
  --dry-run) dry_run=yes ;;
  "") ;;
  *)
    echo "uso: $0 [--dry-run]" >&2
    exit 2
    ;;
esac

[ -f "$helper" ] || {
  echo "auxiliar ausente: $helper" >&2
  exit 1
}

# The one seam the test uses: a fake CLI in place of the container. Everything
# else about the run -- the paths, the atomic rename, the retention, the error
# file -- is the same code the server executes.
run_cli() {
  if [ -n "${GANSO_SHADOW_REPLAY_CLI:-}" ]; then
    "$GANSO_SHADOW_REPLAY_CLI" "$@"
  else
    docker compose --env-file "$SERVER_ENV" exec -T api \
      node apps/api/dist/shadow-replay-cli.js "$@"
  fi
}

describe_cli() {
  if [ -n "${GANSO_SHADOW_REPLAY_CLI:-}" ]; then
    printf '%s' "$GANSO_SHADOW_REPLAY_CLI"
  else
    printf 'docker compose --env-file %s exec -T api node apps/api/dist/shadow-replay-cli.js' \
      "$SERVER_ENV"
  fi
}

log() {
  # Journal-friendly and grep-friendly: one line, the reason code last so the
  # acceptance check `journalctl -u ganso-shadow-replay | grep shadow_replay_failed`
  # finds exactly the failures and nothing else.
  echo "ganso-shadow-replay: $*"
}

run_date=$(date -u +%Y-%m-%d)
now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
window_from=$(python3 "$helper" window-start --hours "$WINDOW_HOURS")

# Mode B first: it is the long one (710 s measured), and the 118 s sweep after
# it still lands inside the quiet window.
run_mode() {
  mode=$1
  shift

  final="$SHADOW_REPLAY_DIR/$run_date-$mode.json"
  latest="$SHADOW_REPLAY_DIR/latest-$mode.json"
  failure="$SHADOW_REPLAY_DIR/latest-$mode.error.json"

  if [ "$dry_run" = yes ]; then
    log "modo $mode: $(describe_cli) $*"
    log "modo $mode: gravaria $final e $latest"
    log "modo $mode: apagaria em excesso de $KEEP arquivos, um por nome exato"
    return 0
  fi

  tmp_out="$SHADOW_REPLAY_DIR/.tmp-$mode-$$.json"
  tmp_err="$SHADOW_REPLAY_DIR/.tmp-$mode-$$.stderr"
  tmp_latest="$SHADOW_REPLAY_DIR/.tmp-latest-$mode-$$.json"
  tmp_failure="$SHADOW_REPLAY_DIR/.tmp-error-$mode-$$.json"
  rm -f -- "$tmp_out" "$tmp_err" "$tmp_latest" "$tmp_failure"

  status=0
  run_cli "$@" >"$tmp_out" 2>"$tmp_err" || status=$?

  if [ "$status" -ne 0 ]; then
    python3 "$helper" error-json \
      --mode "$mode" \
      --run-date "$run_date" \
      --status "$status" \
      --generated-at "$now_iso" \
      --stderr-file "$tmp_err" \
      >"$tmp_failure"
    mv -- "$tmp_failure" "$failure"
    rm -f -- "$tmp_out" "$tmp_err"
    # The good latest-{mode}.json is untouched on purpose; the error file next
    # to it is what tells the screen not to trust it as today's.
    log "modo $mode falhou com status $status: shadow_replay_failed"
    return 1
  fi

  # Atomic in three renames, never a partial file under a name a reader knows.
  mv -- "$tmp_out" "$final"
  cp -- "$final" "$tmp_latest"
  mv -- "$tmp_latest" "$latest"
  rm -f -- "$tmp_err"
  # A good round clears the previous failure, by exact name.
  rm -f -- "$failure"
  log "modo $mode ok: $final ($(wc -c <"$final" | tr -d ' ') bytes)"
  return 0
}

prune_mode() {
  mode=$1
  if [ "$dry_run" = yes ]; then
    return 0
  fi
  # Never a glob, never the parent directory: the helper hands back names that
  # matched YYYY-MM-DD-{mode}.json and were regular files, and each one is
  # removed on its own line.
  #
  # The plan is captured into a variable rather than piped, so that a helper
  # that fails stops the script here instead of being swallowed by a pipeline
  # whose last stage succeeds on no input.
  plan=$(python3 "$helper" retention-plan \
    --dir "$SHADOW_REPLAY_DIR" \
    --mode "$mode" \
    --keep "$KEEP")
  printf '%s\n' "$plan" | while IFS= read -r name; do
    [ -n "$name" ] || continue
    rm -f -- "$SHADOW_REPLAY_DIR/$name"
    log "retenção: apagado $name"
  done
}

if [ "$dry_run" = yes ]; then
  log "SIMULAÇÃO de rodada; nada é gravado, nada é apagado"
  log "diretório: $SHADOW_REPLAY_DIR (data $run_date)"
else
  # 0755 and root-owned, per owner decision P2: root writes, uid `node` reads
  # the same path through a :ro bind mount.
  umask 022
  mkdir -p -- "$SHADOW_REPLAY_DIR"
fi

failures=0
run_mode B source-replay --format json --from "$window_from" || failures=$((failures + 1))
run_mode A sweep "$SWEEP_KEY" --values "$SWEEP_VALUES" --format json ||
  failures=$((failures + 1))
prune_mode B
prune_mode A

if [ "$failures" -ne 0 ]; then
  log "$failures de 2 modos falharam"
  exit 1
fi
log "rodada completa"
