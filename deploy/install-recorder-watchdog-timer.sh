#!/bin/sh
# RFC-021 / OPS-06. Installs the external recorder supervisor, never Docker
# health-policy alone. Run --dry-run locally; activation belongs to OPS-04.
set -eu
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=/opt/ganso-market
unit_dir=/etc/systemd/system
state_dir=/var/lib/ganso/recorder-watchdog
service=ganso-recorder-watchdog.service
timer=ganso-recorder-watchdog.timer
dry_run=no
action=install
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=yes ;;
    --uninstall) action=uninstall ;;
    *) echo "uso: $0 [--dry-run] [--uninstall]" >&2; exit 2 ;;
  esac
done

if [ "$dry_run" = no ] && [ "$(id -u)" -ne 0 ]; then
  echo "execute como root: sudo $0" >&2
  exit 1
fi

run() {
  if [ "$dry_run" = yes ]; then
    printf '+ '
    printf '%s ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Compile in memory: py_compile would write __pycache__, violating dry-run.
# A root service must never execute code from a writable/symlinked checkout.
python3 -I - "$dry_run" "$action" "$script_dir" "$project_dir" "$unit_dir" "$state_dir" <<'PY'
import os
from pathlib import Path
import stat
import sys

dry_run, action, source, project, units, state = sys.argv[1:]
required_owner = 0
service = "ganso-recorder-watchdog.service"
timer = "ganso-recorder-watchdog.timer"

def fail(message, *, server=False):
    if dry_run == "yes" and server:
        print("aviso (SIMULAÇÃO): " + message, file=sys.stderr)
        return
    raise SystemExit(message)

def regular(path):
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        fail("arquivo obrigatório ausente: " + str(path))
    if not stat.S_ISREG(mode):
        fail("arquivo deve ser regular, sem symlink: " + str(path))

def trusted(path, *, missing_ok=False):
    for index, part in enumerate((path, *path.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            if missing_ok:
                continue
            fail("caminho obrigatório ausente: " + str(part), server=True)
            return
        if stat.S_ISLNK(info.st_mode):
            fail("symlink recusado: " + str(part), server=True)
            return
        if index and not stat.S_ISDIR(info.st_mode):
            fail("ancestral não é diretório: " + str(part), server=True)
            return
        if info.st_uid != required_owner or info.st_mode & 0o022:
            fail("caminho exige root e ausência de escrita group/other: " + str(part), server=True)
            return

unit_dir = Path(units)
trusted(unit_dir)
if unit_dir.exists() and not unit_dir.is_dir():
    fail("destino systemd deve ser diretório", server=True)
for name in (service, timer):
    destination = unit_dir / name
    if destination.exists() or destination.is_symlink():
        regular(destination)
        trusted(destination)

if action == "install":
    source = Path(source)
    for path in (source / "install-recorder-watchdog-timer.sh",
                 source / "recorder_watchdog.py",
                 source / "systemd" / service, source / "systemd" / timer):
        regular(path)
        if dry_run != "yes":
            trusted(path)
    compile((source / "recorder_watchdog.py").read_bytes(), "recorder_watchdog.py", "exec")
    if str(source) != str(Path(project) / "deploy"):
        fail("execute o instalador do checkout esperado: " + project, server=True)
    trusted(Path(project))
    if Path(project).exists() and not Path(project).is_dir():
        fail("checkout deve ser diretório", server=True)
    target = Path(state)
    trusted(target, missing_ok=True)
    if target.exists():
        if not target.is_dir() or stat.S_IMODE(target.stat().st_mode) != 0o700:
            fail("diretório de estado existente exige modo 0700: " + state, server=True)
PY

if [ "$dry_run" = no ]; then
  command -v systemctl >/dev/null 2>&1 || {
    echo "dependência ausente: systemctl" >&2; exit 1;
  }
fi

if [ "$action" = uninstall ]; then
  # Stop scheduling FIRST, then stop the current cgroup. Failure to stop an
  # existing unit aborts removal. Missing units make repeated uninstall safe.
  if [ "$dry_run" = yes ]; then
    run systemctl disable --now "$timer"
    run systemctl stop "$service"
  else
    if ! systemctl disable --now "$timer"; then
      [ "$(systemctl show --property=LoadState --value "$timer")" = not-found ] || exit 1
    fi
    if ! systemctl stop "$service"; then
      [ "$(systemctl show --property=LoadState --value "$service")" = not-found ] || exit 1
    fi
  fi
  run rm -f -- "$unit_dir/$timer" "$unit_dir/$service"
  run systemctl daemon-reload
  echo "desinstalação: estado, evidência e marker de manutenção preservados em $state_dir"
else
  if [ "$dry_run" = no ]; then
    command -v docker >/dev/null 2>&1 || {
      echo "dependência ausente: docker" >&2; exit 1;
    }
  fi
  # Read-only validation must succeed before files, permissions or timers
  # change. The helper checks one recorder with the exact Compose identity.
  run /usr/bin/python3 -I "$project_dir/deploy/recorder_watchdog.py" \
    --project-dir "$project_dir" --state-dir "$state_dir" --check-target
  run install -d -o root -g root -m 0700 "$state_dir"
  run install -o root -g root -m 0644 "$script_dir/systemd/$service" "$unit_dir/$service"
  run install -o root -g root -m 0644 "$script_dir/systemd/$timer" "$unit_dir/$timer"
  run systemctl daemon-reload
  run systemctl enable --now "$timer"
  echo "estado/evidência: $state_dir (root:root 0700)"
  echo "inibir recuperação: sudo touch $state_dir/maintenance"
  echo "desligar: sudo $project_dir/deploy/install-recorder-watchdog-timer.sh --uninstall"
fi

if [ "$dry_run" = yes ]; then
  echo "SIMULAÇÃO: nenhum comando de instalação, Docker ou systemd foi executado"
fi
