#!/bin/sh
# RFC-029 D2. Install (or refresh) the shadow-replay timer on the server.
#
# Idempotent: running it twice leaves the same two unit files, the same
# directory and the same enabled timer, and says so. `--dry-run` prints every
# command it would run and changes nothing -- no files, no daemon-reload, no
# enable -- so the diff can be read before it is applied.
#
# This script installs a SCHEDULE. It does not run a round: the first round is
# `systemctl start ganso-shadow-replay.service`, on purpose, so whoever installs
# the timer chooses the minute the first as-of hits postgres.
set -eu

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unit_dir="${GANSO_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
data_dir="${GANSO_SHADOW_REPLAY_DIR:-/var/lib/ganso/shadow-replay}"
service=ganso-shadow-replay.service
timer=ganso-shadow-replay.timer

dry_run=no
case "${1:-}" in
  --dry-run) dry_run=yes ;;
  "") ;;
  *)
    echo "uso: $0 [--dry-run]" >&2
    exit 2
    ;;
esac

if [ "$dry_run" = no ] && [ "$(id -u)" -ne 0 ]; then
  echo "execute como root: sudo $0" >&2
  exit 1
fi

run() {
  if [ "$dry_run" = yes ]; then
    echo "+ $*"
    return 0
  fi
  "$@"
}

# Everything the units point at must exist BEFORE the units do, in dry-run too:
# an enabled timer whose ExecStart is missing fails at 03:30 with nobody
# watching.
for required in \
  "$script_dir/systemd/$service" \
  "$script_dir/systemd/$timer" \
  "$script_dir/shadow-replay-run.sh" \
  "$script_dir/shadow_replay_job.py"; do
  [ -f "$required" ] && [ ! -L "$required" ] || {
    echo "arquivo obrigatório ausente: $required" >&2
    exit 1
  }
done

sh -n "$script_dir/shadow-replay-run.sh"
python3 -m py_compile "$script_dir/shadow_replay_job.py"

# Server-only facts. In `--dry-run` these are reported and not enforced: the
# whole point of the flag is that the plan can be read from a laptop, where
# there is no systemd and no /opt/ganso-market. The real run enforces them.
missing() {
  if [ "$dry_run" = yes ]; then
    echo "aviso (SIMULAÇÃO): $1" >&2
    return 0
  fi
  echo "$1" >&2
  exit 1
}

for executable in docker python3 systemctl; do
  command -v "$executable" >/dev/null 2>&1 ||
    missing "dependência ausente no servidor: $executable"
done

[ -d /opt/ganso-market ] && [ ! -L /opt/ganso-market ] ||
  missing "checkout esperado ausente: /opt/ganso-market"

# 0755 root:root, per owner decision P2: root writes the JSONs, and uid `node`
# inside the api container reads them through a :ro bind mount of this path.
run install -d -o root -g root -m 0755 "$data_dir"

# `install` writes to a temporary file and renames, so a unit file is never
# half-written, and re-running with identical content is a no-op the operator
# can repeat safely.
run install -o root -g root -m 0644 "$script_dir/systemd/$service" "$unit_dir/$service"
run install -o root -g root -m 0644 "$script_dir/systemd/$timer" "$unit_dir/$timer"

run systemctl daemon-reload
# The TIMER is enabled; the service is oneshot and is only ever pulled in by the
# timer or started by hand. `enable --now` on an already-enabled timer is a
# no-op, which is what makes this safe to re-run after every deploy.
run systemctl enable --now "$timer"

if [ "$dry_run" = yes ]; then
  echo "SIMULAÇÃO: nada foi instalado, recarregado nem habilitado"
  exit 0
fi

echo "instalado: $unit_dir/$service e $unit_dir/$timer"
echo "diretório de dados: $data_dir"
systemctl list-timers --all "$timer" --no-pager
echo
echo "primeira rodada (manual, quando a máquina estiver quieta):"
echo "  systemctl start $service"
