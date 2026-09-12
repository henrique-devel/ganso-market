#!/usr/bin/env python3
"""DATA-01: eight bounded daily observations, driven by the existing watchdog.

No runtime/database mutations. The only writes are this observer's fixed, small
state and sample files. Reservation precedes collection; failures consume a slot.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import selectors
import signal
import socket
import stat
import subprocess
import time
from pathlib import Path, PurePosixPath

STATE_DIR = Path("/var/lib/ganso/recorder-watchdog/capacity-series")
PROJECT_DIR = Path("/opt/ganso-market")
DAY = 86400
SLOTS = 8
GRACE = 3600
SAMPLE_BYTES = 16 * 1024
STATE_BYTES = 4096
COMMAND_BYTES = 64 * 1024
PROBE_SECONDS = 10
DATADIR = "/var/lib/postgresql/18/docker"
VOLUME = "ganso-market_postgres_data"
PATHS = {
    "pgdata": DATADIR,
    "wal": DATADIR + "/pg_wal",
    "pg_default": DATADIR + "/base",
    "pg_global": DATADIR + "/global",
}
INSPECT = (
    '{"id":{{json .Id}},"pid":{{json .State.Pid}},'
    '"image":{{json .Image}},"started":{{json .State.StartedAt}},'
    '"running":{{json .State.Running}},"mounts":{{json .Mounts}},'
    '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
    '"directory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}}'
)
SQL = """SELECT json_build_object(
 'utc',clock_timestamp(), 'data_directory',current_setting('data_directory'),
 'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),
 'postmaster_start',pg_postmaster_start_time(), 'database',current_database(),
 'database_bytes',pg_database_size(current_database()),
 'tablespaces',(SELECT json_agg(row_to_json(t)) FROM
   (SELECT oid,spcname,pg_tablespace_location(oid) location FROM pg_tablespace
    ORDER BY oid LIMIT 4)t),
 'wal',(SELECT row_to_json(w) FROM
   (SELECT wal_bytes::text,wal_records,stats_reset FROM pg_stat_wal)w),
 'db_stats',(SELECT row_to_json(d) FROM
   (SELECT temp_bytes,stats_reset FROM pg_stat_database WHERE datname=current_database())d),
 'budgets',json_build_object('read_only',current_setting('default_transaction_read_only'),
   'statement_timeout',current_setting('statement_timeout'),
   'lock_timeout',current_setting('lock_timeout')))
"""


class Refused(Exception):
    """Only constant reason codes are persisted; never raw subprocess errors."""


def utc(now):
    return dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat()


def stamp(value):
    return dt.datetime.fromisoformat(value).timestamp()


def secure_directory(path):
    if not path.is_absolute() or path.resolve() != path:
        raise Refused("DIRECTORY_UNSAFE")
    for part in (path, *path.parents):
        if part.exists() and (part.is_symlink() or not part.is_dir()):
            raise Refused("DIRECTORY_UNSAFE")
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise Refused("DIRECTORY_UNSAFE")


def read_json(path, limit):
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.geteuid()
        or info.st_nlink != 1
        or info.st_mode & 0o077
        or info.st_size > limit
    ):
        raise Refused("FILE_UNSAFE")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd) as stream:
            value = json.loads(stream.read(limit + 1))
        if not isinstance(value, dict):
            raise ValueError("object")
        return value
    except (ValueError, UnicodeError):
        raise Refused("STATE_INVALID") from None


def write_json(path, value, limit):
    data = (json.dumps(value, sort_keys=True, allow_nan=False) + "\n").encode()
    if len(data) > limit:
        raise Refused("OUTPUT_LIMIT")
    if path.exists() or path.is_symlink():
        read_json(path, limit)
    pending = path.parent / ".pending"
    # Fixed temp belongs exclusively to the held series flock, not watchdog's.
    if pending.exists() or pending.is_symlink():
        raise Refused("PENDING_REQUIRES_REVIEW")
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(pending, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def load_series(directory):
    value = read_json(directory / "series.json", STATE_BYTES)
    if (
        value.get("version") != 1
        or value.get("slots") != SLOTS
        or value.get("period_seconds") != DAY
        or value.get("grace_seconds") != GRACE
        or type(value.get("start_epoch")) not in (int, float)
        or not 0 < value["start_epoch"] < 2**53
    ):
        raise Refused("STATE_INVALID")
    return value


def start_series(directory, now):
    secure_directory(directory)
    if (directory / "series.json").exists() or (directory / "series.json").is_symlink():
        return load_series(directory)  # Never silently extend/restart a series.
    value = {
        "version": 1,
        "slots": SLOTS,
        "period_seconds": DAY,
        "grace_seconds": GRACE,
        "start_epoch": now,
        "start_utc": utc(now),
        "last_slot_due_utc": utc(now + (SLOTS - 1) * DAY),
        "window_end_utc": utc(now + (SLOTS - 1) * DAY + GRACE),
        "collector_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    write_json(directory / "series.json", value, STATE_BYTES)
    return value


def delta(previous, current):
    out = {"valid": False, "reason": "PREVIOUS_UNAVAILABLE"}
    if not previous or previous.get("status") != "ok" or current.get("status") != "ok":
        return out
    if current["slot"] != previous["slot"] + 1:
        return {"valid": False, "reason": "WINDOW_GAP"}
    a, b = previous["observation"], current["observation"]
    identity = ["host_id", "system_identifier", "database", "storage_identity", "collector_sha256"]
    if any(a.get(key) != b.get(key) for key in identity):
        return {"valid": False, "reason": "IDENTITY_CHANGED"}
    elapsed = stamp(b["utc"]) - stamp(a["utc"])
    if elapsed <= 0:
        return {"valid": False, "reason": "CLOCK_ROLLBACK"}
    out = {
        "valid": True,
        "elapsed_seconds": elapsed,
        "database_bytes_change": b["sql"]["database_bytes"] - a["sql"]["database_bytes"],
        "filesystem_available_bytes_change": {
            key: b["filesystems"][key]["available_bytes"] - value["available_bytes"]
            for key, value in a["filesystems"].items()
        },
        "wal_segments_bytes_change": b["wal_segments"]["bytes"] - a["wal_segments"]["bytes"],
    }
    wa, wb = a["sql"]["wal"], b["sql"]["wal"]
    comparable = wa["stats_reset"] == wb["stats_reset"] and int(wb["wal_bytes"]) >= int(
        wa["wal_bytes"]
    )
    out["wal_generated_bytes"] = int(wb["wal_bytes"]) - int(wa["wal_bytes"]) if comparable else None
    out["wal_status"] = "comparable" if comparable else "reset_or_counter_rollback"
    return out


def run_due(directory, now, collector):
    if not directory.exists() and not directory.is_symlink():
        return {"reason": "disabled"}
    secure_directory(directory)
    lock_path = directory / "series.lock"
    lock = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(lock)
        if info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise Refused("LOCK_UNSAFE")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"reason": "locked"}
        series = load_series(directory)
        start = series["start_epoch"]
        if now < start:
            raise Refused("CLOCK_ROLLBACK")
        slot = min(int((now - start) // DAY), SLOTS)
        # Reserved/incomplete sample files are permanent attempts, not retry cues.
        for number in range(min(slot + 1, SLOTS)):
            path = directory / f"sample-{number:02d}.json"
            if path.exists() or path.is_symlink():
                saved = read_json(path, SAMPLE_BYTES)
                if saved.get("slot") != number or stamp(saved["attempt_utc"]) > now:
                    raise Refused("STATE_INVALID_OR_CLOCK_ROLLBACK")
                continue
            missed = number < slot or now >= start + number * DAY + GRACE
            sample = {
                "version": 1,
                "slot": number,
                "attempt_utc": utc(now),
                "due_utc": utc(start + number * DAY),
                "status": "missed" if missed else "reserved",
            }
            write_json(path, sample, SAMPLE_BYTES)
            if missed:
                continue
            previous = None
            if number:
                previous = read_json(directory / f"sample-{number - 1:02d}.json", SAMPLE_BYTES)
            began = time.monotonic()
            try:
                sample["observation"] = collector()
                sample["status"] = "ok" if sample["observation"].get("complete") else "partial"
                sample["delta"] = delta(previous, sample)
                sample["elapsed_seconds"] = round(time.monotonic() - began, 6)
                write_json(path, sample, SAMPLE_BYTES)
            except Exception as exc:
                # A process kill leaves reserved; all handled failures keep only
                # static codes and any partial observation explicitly marked.
                code = str(exc) if isinstance(exc, Refused) else "COLLECT_FAILED"
                sample = {
                    k: v
                    for k, v in sample.items()
                    if k in ("version", "slot", "attempt_utc", "due_utc")
                }
                sample.update(
                    status="error", reason=code, elapsed_seconds=round(time.monotonic() - began, 6)
                )
                write_json(path, sample, SAMPLE_BYTES)
            return {"reason": "captured", "slot": number, "status": sample["status"]}
        finished = now >= start + (SLOTS - 1) * DAY + GRACE
        return {"reason": "window_closed" if finished else "not_due"}
    finally:
        os.close(lock)


class Budget:
    def __init__(self):
        self.deadline = time.monotonic() + PROBE_SECONDS

    def run(self, argv, timeout=2):
        remaining = min(timeout, self.deadline - time.monotonic())
        if remaining <= 0:
            raise Refused("PROBE_DEADLINE")
        with subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        ) as child:
            data = bytearray()
            assert child.stdout is not None
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + remaining
                try:
                    while selector.get_map():
                        if time.monotonic() >= deadline:
                            raise Refused("COMMAND_TIMEOUT")
                        for key, _ in selector.select(max(0, deadline - time.monotonic())):
                            chunk = os.read(key.fd, 8192)
                            if not chunk:
                                selector.unregister(key.fileobj)
                            data.extend(chunk)
                            if len(data) > COMMAND_BYTES:
                                raise Refused("COMMAND_OUTPUT_LIMIT")
                    child.wait(timeout=max(0.01, deadline - time.monotonic()))
                except BaseException:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    raise
            if child.returncode:
                raise Refused("COMMAND_FAILED")
        return data.decode("utf-8").strip()

    def docker(self, *args, timeout=2):
        return self.run(
            ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", *args], timeout
        )


def mounts(text):
    result = []
    for line in text.splitlines():
        left, right = line.split(" - ", 1)
        p, r = left.split(), right.split()

        def decode(value):
            return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), value)

        result.append(
            {
                "device": p[2],
                "root": decode(p[3]),
                "mountpoint": decode(p[4]),
                "fstype": r[0],
                "source": decode(r[1]),
            }
        )
    return result


def match(path, values, key):
    candidates = [
        v
        for v in values
        if PurePosixPath(v[key]) == PurePosixPath(path)
        or PurePosixPath(v[key]) in PurePosixPath(path).parents
    ]
    if not candidates:
        raise Refused("MOUNT_MISSING")
    length = max(len(v[key]) for v in candidates)
    selected = [v for v in candidates if len(v[key]) == length]
    if len(selected) != 1:
        raise Refused("MOUNT_AMBIGUOUS")
    return selected[0]


def storage(pg, resolved, host_mounts, namespace_mounts):
    filesystems, targets = {}, {}
    for (kind, path), real in zip(PATHS.items(), resolved):
        dm = match(real, pg["mounts"], "Destination")
        if dm.get("Name") != VOLUME or dm["Type"] != "volume":
            raise Refused("STORAGE_DRIFT")
        host_path = Path(dm["Source"]) / PurePosixPath(real).relative_to(dm["Destination"])
        host_real = host_path.resolve(strict=True)
        hm = match(str(host_real), host_mounts, "mountpoint")
        cm = match(real, namespace_mounts, "mountpoint")
        device = os.stat(host_real).st_dev
        if hm["device"] != f"{os.major(device)}:{os.minor(device)}" or hm["device"] != cm["device"]:
            raise Refused("DEVICE_MISMATCH")
        host_internal = PurePosixPath(hm["root"]) / host_real.relative_to(hm["mountpoint"])
        container_internal = PurePosixPath(cm["root"]) / PurePosixPath(real).relative_to(
            cm["mountpoint"]
        )
        if host_internal != container_internal:
            raise Refused("MOUNT_ROOT_MISMATCH")
        key = hm["device"] + ":" + hm["fstype"] + ":" + hm["source"]
        targets[kind] = {
            "container_path": path,
            "container_realpath": real,
            "host_realpath": str(host_real),
            "filesystem": key,
            "volume": dm["Name"],
            "container_mount_root": cm["root"],
        }
        if key not in filesystems:
            fs = os.statvfs(host_real)
            filesystems[key] = {
                **hm,
                "total_bytes": fs.f_blocks * fs.f_frsize,
                "available_bytes": fs.f_bavail * fs.f_frsize,
                "free_bytes": fs.f_bfree * fs.f_frsize,
            }
    return {"targets": targets, "filesystems": filesystems}


def wal_segments(path):
    count, total, allocated, entries = 0, 0, 0, 0
    with os.scandir(path) as iterator:
        for entry in iterator:
            entries += 1
            if entries > 256:
                raise Refused("WAL_DIRECTORY_LIMIT")
            if re.fullmatch(r"[0-9A-F]{24}(?:\.partial)?", entry.name):
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise Refused("WAL_ENTRY_UNSAFE")
                count += 1
                total += info.st_size
                allocated += info.st_blocks * 512
    return {
        "count": count,
        "bytes": total,
        "allocated_bytes": allocated,
        "scope": "segment files only; excludes archive_status and other entries",
        "entries_seen": entries,
    }


def validate_sql_storage(result):
    """PostgreSQL JSON serializes OID as text; accept only the known topology."""
    if any(
        type(row["oid"]) not in (int, str) or not re.fullmatch(r"[0-9]+", str(row["oid"]))
        for row in result["tablespaces"]
    ):
        return False
    spaces = [dict(row, oid=int(row["oid"])) for row in result["tablespaces"]]
    return (
        result["data_directory"] == DATADIR
        and result["budgets"]["read_only"] == "on"
        and spaces
        == [
            {"oid": 1663, "spcname": "pg_default", "location": ""},
            {"oid": 1664, "spcname": "pg_global", "location": ""},
        ]
    )


def collect():
    budget = Budget()
    out = {
        "utc": utc(time.time()),
        "complete": False,
        "host_id": hashlib.sha256(Path("/etc/machine-id").read_bytes()).hexdigest(),
        "hostname": socket.gethostname(),
        "collector_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    ids = budget.docker(
        "ps",
        "-q",
        "--no-trunc",
        "--filter",
        "label=com.docker.compose.project=ganso-market",
        "--filter",
        "label=com.docker.compose.service=postgres",
    ).split()
    if len(ids) != 1 or not re.fullmatch(r"[0-9a-f]{64}", ids[0]):
        raise Refused("PG_NOT_UNIQUE")
    pg = json.loads(budget.docker("inspect", "--format", INSPECT, ids[0]))
    if (
        not pg["running"]
        or pg["id"] != ids[0]
        or pg["project"] != "ganso-market"
        or pg["service"] != "postgres"
        or pg["directory"] != str(PROJECT_DIR)
        or len(pg["mounts"]) > 16
    ):
        raise Refused("PG_IDENTITY_MISMATCH")
    out["container"] = {key: pg[key] for key in ("id", "pid", "image", "started")}
    resolved = budget.docker(
        "exec", pg["id"], "timeout", "2", "readlink", "-f", "--", *PATHS.values()
    ).splitlines()
    if len(resolved) != len(PATHS) or any(not p.startswith("/") for p in resolved):
        raise Refused("PATH_RESOLUTION_FAILED")
    mapped = storage(
        pg,
        resolved,
        mounts(Path("/proc/self/mountinfo").read_text()),
        mounts(Path(f"/proc/{pg['pid']}/mountinfo").read_text()),
    )
    out.update(mapped)
    out["storage_identity"] = {
        "targets": mapped["targets"],
        "filesystems": {
            k: {
                p: f[p] for p in ("device", "root", "mountpoint", "fstype", "source", "total_bytes")
            }
            for k, f in mapped["filesystems"].items()
        },
    }
    out["floor_25_percent_passed"] = all(
        f["available_bytes"] * 4 >= f["total_bytes"] for f in mapped["filesystems"].values()
    )
    try:
        out["wal_segments"] = wal_segments(mapped["targets"]["wal"]["host_realpath"])
        if not out["floor_25_percent_passed"]:
            raise Refused("FILESYSTEM_FLOOR")
        result = json.loads(
            budget.docker(
                "exec",
                "-e",
                "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=1500 "
                "-c lock_timeout=250 -c max_parallel_workers_per_gather=0 "
                "-c idle_in_transaction_session_timeout=1500 -c application_name=data01-daily",
                "-e",
                "PGCONNECT_TIMEOUT=1",
                pg["id"],
                "timeout",
                "--kill-after=1",
                "4",
                "psql",
                "-XAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "ganso_market",
                "-d",
                "ganso_market",
                "-c",
                SQL,
                timeout=5,
            )
        )
        out["sql"] = result
        if not validate_sql_storage(result):
            raise Refused("SQL_STORAGE_DRIFT")
        after = json.loads(budget.docker("inspect", "--format", INSPECT, pg["id"]))
        if after != pg:
            raise Refused("CONTAINER_CHANGED")
        out["system_identifier"] = result["system_identifier"]
        out["database"] = result["database"]
        out["complete"] = True
    except Exception as exc:
        out["error"] = str(exc) if isinstance(exc, Refused) else "SQL_OR_STORAGE_FAILED"
        out["mapping_note"] = "fixed DB-04 paths measured; current SQL mapping not fully verified"
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", action="store_true")
    parser.add_argument("--due", action="store_true")
    parser.add_argument("--skip-probe", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    try:
        if args.start:
            print(json.dumps(start_series(STATE_DIR, time.time()), sort_keys=True))
        elif args.status:
            series = load_series(STATE_DIR)
            samples = [
                read_json(STATE_DIR / f"sample-{n:02d}.json", SAMPLE_BYTES)
                for n in range(SLOTS)
                if (STATE_DIR / f"sample-{n:02d}.json").exists()
            ]
            print(json.dumps({"series": series, "samples": samples}, sort_keys=True))
        elif args.due:

            def capture():
                if args.skip_probe:
                    raise Refused("WATCHDOG_BUDGET_OR_INHIBITED")
                return collect()

            print(json.dumps(run_due(STATE_DIR, time.time(), capture), sort_keys=True))
        else:
            parser.error("choose --start, --due or --status")
        return 0
    except Exception as exc:
        code = str(exc) if isinstance(exc, Refused) else "SERIES_FAILED"
        print(json.dumps({"reason": code}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
