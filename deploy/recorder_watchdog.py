#!/usr/bin/env python3
"""OPS-06. Host oneshot supervisor; no shell, compose mutations or raw log archive.

The only mutation of Docker is restart of the revalidated recorder container ID.
State/evidence must live outside Docker and are committed before that request.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import time
import uuid
from pathlib import Path

PROJECT = "ganso-market"
SERVICE = "polymarket-recorder"
HEARTBEAT_STALE = 90
START_GRACE = 180
CONFIRM_SECONDS = 30
PERSISTENCE_STALE = 300
WINDOW = 3600
MAX_RESTARTS = 3
COOLDOWN = 300
MAX_BACKOFF = 1800
KEEP_EVENTS = 32
EVENT_BYTES = 64 * 1024
COMMAND_BYTES = 128 * 1024
MIN_DISK = 64 * 1024 * 1024
MIN_MEMORY = 128 * 1024 * 1024

# Executed by a NEW Node process, never by the recorder's blocked event loop.
# Docker CLI timeout cannot kill a daemon-side exec: this process also has its
# own hard deadline and PostgreSQL server-side budgets, with just one client.
PROBE_JS = r"""
import fs from 'node:fs';
import pg from 'pg';
import { loadConfig } from '/workspace/apps/api/dist/config.js';
const out = {version:1, db:'unavailable', heartbeat:null, sha:null};
const finish = () => { console.log(JSON.stringify(out)); process.exit(0); };
setTimeout(finish, 6500);
try {
  const p = '/tmp/ganso-recorder-heartbeat.json';
  if (fs.lstatSync(p).isFile() && fs.statSync(p).size <= 1024) {
    const hb = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Number.isSafeInteger(hb.pid) && hb.pid > 0) {
      process.kill(hb.pid, 0);
      out.heartbeat = hb;
    }
  }
} catch {}
try {
  const sha = fs.readFileSync('/etc/ganso/release-sha', 'utf8').trim();
  if (/^[0-9a-f]{40}$/.test(sha)) out.sha = sha;
} catch {}
let client;
try {
  const config = await loadConfig();
  client = config.database.password.use(password => new pg.Client({
    host:config.database.host, port:config.database.port,
    database:config.database.name, user:config.database.user, password,
    ssl:config.database.ssl ? {rejectUnauthorized:true} : undefined,
    connectionTimeoutMillis:1000, query_timeout:1500, statement_timeout:1000,
    application_name:'ganso-recorder-watchdog',
    options:'-c default_transaction_read_only=on -c lock_timeout=500 ' +
      '-c idle_in_transaction_session_timeout=2000'
  }));
  client.on('error', () => {});
  await client.connect();
  await client.query('SELECT 1');
  out.db = 'ok';
  try {
    // Global arrival clocks, using migration 0013 received_at indexes. No
    // COUNT/table scan, writes, venue freshness claim or dependency on API.
    const result = await client.query(`SELECT
      (SELECT received_at FROM polymarket_book_snapshots_full
       ORDER BY received_at DESC LIMIT 1) AS clob,
      (SELECT received_at FROM polymarket_rtds_prices
       ORDER BY received_at DESC LIMIT 1) AS rtds`);
    out.persistence = result.rows[0];
  } catch { out.persistence = null; }
} catch { out.db = 'unavailable'; }
finally { if (client) await client.end().catch(() => {}); }
finish();
"""

INSPECT_FORMAT = (
    '{"id":{{json .Id}},"image":{{json .Image}},"state":{{json .State.Status}},'
    '"started":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},'
    '"cmd":{{json .Config.Cmd}},'
    '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
    '"directory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}}'
)


class Refused(Exception):
    """Only static reason codes cross the CLI boundary."""


def utc(epoch: float) -> str:
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat().replace("+00:00", "Z")


def epoch(value: object) -> float:
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone")
    return parsed.timestamp()


def command(
    argv: list[str], timeout: float, limit: int = COMMAND_BYTES, *, stderr: bool = False
) -> tuple[int, bytes]:
    """Bound wall time AND memory; stderr is discarded, never credentials on disk."""
    env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root",
        "LANG": "C.UTF-8",
    }
    with subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT if stderr else subprocess.DEVNULL,
        env=env,
        start_new_session=True,
    ) as child:
        assert child.stdout is not None
        data = bytearray()
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            try:
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise Refused("COMMAND_TIMEOUT")
                    for key, _ in selector.select(min(remaining, 0.1)):
                        chunk = os.read(key.fileobj.fileno(), 8192)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        elif len(data) + len(chunk) > limit:
                            raise Refused("COMMAND_OUTPUT_LIMIT")
                        else:
                            data.extend(chunk)
                return child.wait(timeout=max(0.01, deadline - time.monotonic())), bytes(data)
            except subprocess.TimeoutExpired:
                raise Refused("COMMAND_TIMEOUT") from None
            finally:
                # Covers grandchildren holding the pipe, as well as direct CLI.
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait()


def memory_bytes(value: str) -> float:
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB|TiB)", value)
    if not match:
        raise Refused("CONTAINER_HEADROOM_UNKNOWN")
    scale = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "TiB": 1024**4}
    return float(match[1]) * scale[match[2]]


class Docker:
    def __init__(self, project_dir: Path):
        self.project_dir = project_dir
        self.executable = "/usr/bin/docker"

    def call(self, args: list[str], timeout: float = 3, *, stderr: bool = False) -> bytes:
        code, data = command(
            [self.executable, "--host", "unix:///var/run/docker.sock", *args],
            timeout,
            stderr=stderr,
        )
        if code:
            raise Refused("DOCKER_UNAVAILABLE")
        return data

    def target(self) -> dict:
        ids = self.call(
            [
                "ps",
                "-a",
                "--no-trunc",
                "--filter",
                f"label=com.docker.compose.project={PROJECT}",
                "--filter",
                f"label=com.docker.compose.service={SERVICE}",
                "--format",
                "{{.ID}}",
            ]
        )
        values = ids.decode("ascii").split()
        if len(values) != 1 or not re.fullmatch(r"[0-9a-f]{64}", values[0]):
            raise Refused("TARGET_NOT_UNIQUE")
        obj = json.loads(self.call(["inspect", "--format", INSPECT_FORMAT, values[0]]))
        if (
            obj.get("id") != values[0]
            or obj.get("project") != PROJECT
            or obj.get("service") != SERVICE
            or obj.get("directory") != str(self.project_dir)
            or obj.get("cmd") != ["node", "apps/api/dist/polymarket-recorder.js"]
        ):
            raise Refused("TARGET_MISMATCH")
        # Keep only validated fields; never persist labels, env, command or mounts.
        return {
            "id": values[0],
            "image": obj["image"]
            if re.fullmatch(r"sha256:[0-9a-f]{64}", obj.get("image", ""))
            else None,
            "state": obj["state"]
            if obj.get("state")
            in {"running", "restarting", "exited", "paused", "created", "dead", "removing"}
            else "unknown",
            "started": utc(epoch(obj["started"])),
            "restarts": int(obj["restarts"]),
        }

    def probe(self, target: dict) -> dict:
        # The exec runs in the recorder cgroup. Reserve space BEFORE creating
        # another Node process; CLI memory excludes reclaimable file cache.
        usage = json.loads(
            self.call(["stats", "--no-stream", "--format", "{{json .MemUsage}}", target["id"]])
        )
        parts = usage.split(" / ") if isinstance(usage, str) else []
        if len(parts) != 2 or memory_bytes(parts[1]) - memory_bytes(parts[0]) < 96 * 1024**2:
            raise Refused("CONTAINER_HEADROOM_LOW")
        data = self.call(
            [
                "exec",
                "--user",
                "node",
                target["id"],
                "node",
                "--max-old-space-size=32",
                "--input-type=module",
                "-e",
                PROBE_JS,
            ],
            timeout=8,
        )
        obj = json.loads(data)
        if obj.get("version") != 1 or obj.get("db") not in {"ok", "unavailable"}:
            raise Refused("PROBE_INVALID")
        sha = obj.get("sha")
        result = {
            "db": obj["db"],
            "sha": sha if isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) else None,
            "heartbeat": None,
            "persistence": None,
        }
        hb = obj.get("heartbeat")
        if (
            isinstance(hb, dict)
            and hb.get("version") == 1
            and hb.get("phase") in {"starting", "running", "stopping"}
            and all(type(hb.get(k)) is int and 0 < hb[k] < 2**53 for k in ("pid", "seq"))
            and isinstance(hb.get("uptime_ms"), (int, float))
            and 0 <= hb["uptime_ms"] < 2**53
        ):
            result["heartbeat"] = {
                "pid": hb["pid"],
                "seq": hb["seq"],
                "phase": hb["phase"],
                "timestamp": utc(epoch(hb["timestamp"])),
                "uptime_ms": hb["uptime_ms"],
            }
        persisted = obj.get("persistence")
        if isinstance(persisted, dict):
            result["persistence"] = {
                k: utc(epoch(persisted[k])) if persisted.get(k) else None for k in ("clob", "rtds")
            }
        return result

    def logs(self, target: dict) -> dict:
        try:
            # --until makes the evidence interval finite before restart.
            data = self.call(
                [
                    "logs",
                    "--since",
                    "10m",
                    "--until",
                    utc(time.time()),
                    "--tail",
                    "100",
                    target["id"],
                ],
                timeout=3,
                stderr=True,
            )
            return safe_logs(data)
        except Refused as exc:
            return {"status": str(exc), "rows": []}

    def restart(self, target: dict) -> str:
        try:
            self.call(["restart", "--timeout", "10", target["id"]], timeout=20)
            return "restart_requested"
        except Refused:
            # A client timeout is ambiguous: the daemon may still finish it.
            return "restart_unconfirmed"


def safe_logs(data: bytes) -> dict:
    """Allowlist fixed codes and typed counters. Free text is never evidence."""
    codes = {
        "STATUS",
        "DB_POOL_CLIENT_ERROR",
        "RTDS_PERSIST_FAILED",
        "RTDS_1M_PERSIST_FAILED",
        "RECORDER_FAILED",
        "SIGTERM_RECEIVED",
        "SIGINT_RECEIVED",
        "RECORDER_HEARTBEAT_WRITE_FAILED",
    }
    rows = []
    discarded = 0
    for line in data.splitlines()[:100]:
        try:
            obj = json.loads(line)
            code = obj.get("reason_code")
            if code not in codes:
                discarded += 1
                continue
            row = {"reason_code": code}
            if obj.get("level") in {"info", "warn", "error", "fatal", "debug"}:
                row["level"] = obj["level"]
            for key in ("timestamp", "ts"):
                if key in obj:
                    row["timestamp"] = utc(epoch(obj[key]))
            for key in ("dropped", "universe_markets", "universe_tokens"):
                if type(obj.get(key)) is int and 0 <= obj[key] < 2**53:
                    row[key] = obj[key]
            rows.append(row)
        except (ValueError, TypeError, AttributeError, OverflowError):
            discarded += 1
    return {"status": "filtered", "rows": rows, "discarded": discarded}


def secure_directory(path: Path) -> None:
    if not path.is_absolute() or path.resolve() != path:
        raise Refused("STATE_PATH_UNSAFE")
    path.mkdir(mode=0o700, parents=False, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise Refused("STATE_PERMISSIONS_UNSAFE")


def read_state(path: Path) -> dict:
    if not path.exists() and not path.is_symlink():
        return {"version": 1, "attempts": [], "streak": 0, "next_allowed": 0, "last_now": 0}
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid != os.geteuid()
        or info.st_size > EVENT_BYTES
        or info.st_mode & 0o077
    ):
        raise Refused("STATE_INVALID")
    try:
        obj = json.loads(path.read_text())
        if (
            obj["version"] != 1
            or not isinstance(obj["attempts"], list)
            or len(obj["attempts"]) > MAX_RESTARTS
            or type(obj["streak"]) is not int
            or not 0 <= obj["streak"] <= 20
            or any(
                type(n) not in (int, float) or not 0 <= n < 2**53
                for n in [*obj["attempts"], obj["next_allowed"], obj["last_now"]]
            )
        ):
            raise ValueError("schema")
        return obj
    except (ValueError, KeyError, TypeError):
        raise Refused("STATE_INVALID") from None


def atomic_json(path: Path, value: dict) -> None:
    data = (json.dumps(value, sort_keys=True, allow_nan=False) + "\n").encode()
    if len(data) > EVENT_BYTES:
        raise Refused("EVIDENCE_TOO_LARGE")
    temp = path.parent / ".pending"
    # Only this instance holds flock. A temp left by SIGKILL is safe to unlink,
    # including a symlink (never follow or truncate the target).
    temp.unlink(missing_ok=True)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        temp.unlink(missing_ok=True)


def headroom(path: Path) -> bool:
    if shutil.disk_usage(path).free < MIN_DISK:
        return False
    try:
        match = re.search(r"^MemAvailable:\s+(\d+) kB$", Path("/proc/meminfo").read_text(), re.M)
        return bool(match and int(match[1]) * 1024 >= MIN_MEMORY)
    except OSError:
        return False


def event(path: Path, payload: dict) -> Path:
    files = sorted(
        p
        for p in path.iterdir()
        if re.fullmatch(r"event-\d{20}-[0-9a-f]{32}\.json", p.name)
        and p.is_file()
        and not p.is_symlink()
    )
    while len(files) >= KEEP_EVENTS:
        files.pop(0).unlink()
    output = path / f"event-{int(time.time() * 1_000_000):020d}-{uuid.uuid4().hex}.json"
    atomic_json(output, payload)
    return output


def diagnose(target: dict, probe: dict, now: float, state: dict) -> tuple[str, bool]:
    # DB outage always wins over a stale heartbeat: no recovery storm on a
    # shared dependency failure. Persistence failure alone is observational.
    if probe["db"] != "ok":
        return "db_unavailable", False
    if probe["persistence"] is None:
        return "persistence_unavailable", False
    if now - epoch(target["started"]) < START_GRACE:
        return "starting", False
    hb = probe["heartbeat"]
    stale = hb is None
    if hb:
        age = now - epoch(hb["timestamp"])
        if age < -5:
            return "clock_skew", False
        stale = age > HEARTBEAT_STALE or epoch(hb["timestamp"]) < epoch(target["started"])
        identity = f"{target['id']}:{target['started']}:{hb['pid']}"
        previous = state.get("progress", {})
        if previous.get("identity") == identity and previous.get("seq") == hb["seq"]:
            stale |= now - previous["at"] > HEARTBEAT_STALE
        else:
            state["progress"] = {"identity": identity, "seq": hb["seq"], "at": now}
    if stale:
        return "heartbeat_stalled", True
    if hb and hb["phase"] == "stopping":
        return "stopping", False
    if hb and hb["phase"] == "starting":
        return "startup_stalled", True
    persistence = probe["persistence"]
    if any(
        value is None or now - epoch(value) > PERSISTENCE_STALE for value in persistence.values()
    ):
        return "persistence_stale", False
    return "healthy", False


def supervise(docker: Docker, directory: Path, now: float | None = None) -> dict:
    secure_directory(directory)
    lock = os.open(directory / "instance.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"reason": "instance_locked"}
        return supervise_locked(docker, directory, time.time() if now is None else now)
    finally:
        os.close(lock)


def supervise_locked(docker: Docker, directory: Path, now: float) -> dict:
    if (directory / "maintenance").exists() or (directory / "maintenance").is_symlink():
        return {"reason": "maintenance"}
    state_path = directory / "state.json"
    state = read_state(state_path)
    if now < state["last_now"]:
        raise Refused("CLOCK_ROLLBACK")
    if not headroom(directory):
        raise Refused("HEADROOM_LOW")
    if now - state["last_now"] > 120:
        state.pop("healthy_since", None)
    state["last_now"] = now
    target = docker.target()
    probe = None
    candidate = False
    if target["state"] != "running":
        reason = "recorder_not_running"
    else:
        probe = docker.probe(target)
        reason, candidate = diagnose(target, probe, now, state)
    identity = target["id"] + target["started"]
    suspicion = state.get("suspicion", {})
    if candidate:
        if suspicion.get("identity") != identity or suspicion.get("reason") != reason:
            suspicion = {"identity": identity, "reason": reason, "since": now}
        state["suspicion"] = suspicion
    else:
        state.pop("suspicion", None)
    if reason == "healthy":
        since = state.setdefault("healthy_since", now)
        if now - since >= WINDOW:
            state["streak"] = 0
    else:
        state.pop("healthy_since", None)
    state["attempts"] = [stamp for stamp in state["attempts"] if now - stamp < WINDOW]
    action = "observe"
    if candidate and now - suspicion["since"] >= CONFIRM_SECONDS:
        if probe is None or probe["sha"] is None:
            action = "provenance_unknown"
        elif now < state["next_allowed"]:
            action = "backoff"
        elif len(state["attempts"]) >= MAX_RESTARTS:
            action = "window_exhausted"
        else:
            action = "restart_reserved"
    evidence = {
        "utc": utc(now),
        "target": target,
        "sha": probe["sha"] if probe else None,
        "reason": reason,
        "action": action,
        "probe": probe,
        "attempts_in_window": len(state["attempts"]),
    }
    saved = None
    if reason != "healthy":
        evidence["logs"] = (
            docker.logs(target)
            if target["state"] == "running"
            else {"status": "not_running", "rows": []}
        )
        saved = event(directory, evidence)
    if action == "restart_reserved":
        # Check maintenance and exact container generation again AFTER evidence,
        # so deploy/recreate or an operator pause cannot redirect the mutation.
        current = docker.target()
        if (
            (directory / "maintenance").exists()
            or (directory / "maintenance").is_symlink()
            or current != target
        ):
            evidence["action"] = "target_changed_or_maintenance"
        else:
            # A live recorder may recover (or DB fail) while logs are captured.
            # Reconfirm immediately before reservation; observation is never an
            # atomic guarantee against changes after the Docker request starts.
            confirmation = docker.probe(target)
            confirmed_reason, confirmed = diagnose(target, confirmation, now, state)
            evidence["confirmation"] = {"reason": confirmed_reason, "probe": confirmation}
            if not confirmed or confirmed_reason != reason or confirmation["sha"] != probe["sha"]:
                evidence["action"] = "recovery_changed"
                state.pop("suspicion", None)
            elif (directory / "maintenance").exists() or (directory / "maintenance").is_symlink():
                evidence["action"] = "target_changed_or_maintenance"
            else:
                assert saved is not None
                atomic_json(saved, evidence)
                state["attempts"].append(now)
                state["streak"] = min(20, state["streak"] + 1)
                state["next_allowed"] = now + min(
                    MAX_BACKOFF, COOLDOWN * 2 ** (state["streak"] - 1)
                )
                # A crash or ambiguous timeout consumes the attempt durably.
                atomic_json(state_path, state)
                evidence["action"] = docker.restart(target)
        assert saved is not None
        atomic_json(saved, evidence)
    atomic_json(state_path, state)
    # Bounded latest status, including healthy state, for OPS-04 observation.
    atomic_json(directory / "status.json", evidence)
    return {"reason": reason, "action": evidence["action"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", type=Path, default=Path("/opt/ganso-market"))
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/ganso/recorder-watchdog"))
    parser.add_argument("--check-target", action="store_true")
    args = parser.parse_args()
    try:
        # One canonical production state/lock location even for manual runs.
        # Tests exercise supervise() in isolated directories, not another daemon.
        if args.state_dir != Path("/var/lib/ganso/recorder-watchdog"):
            raise Refused("STATE_PATH_NOT_CANONICAL")
        docker = Docker(args.project_dir)
        if args.check_target:
            target = docker.target()
            if target["state"] != "running":
                raise Refused("TARGET_NOT_RUNNING")
            probe = docker.probe(target)
            if probe["heartbeat"] is None or probe["sha"] is None:
                raise Refused("TARGET_CONTRACT_MISSING")
            result = {"reason": "target_verified", "sha": probe["sha"], "id": target["id"]}
        else:
            result = supervise(docker, args.state_dir)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Refused as exc:
        print(json.dumps({"reason": str(exc), "action": "inhibited"}))
        return 1
    except Exception:
        # No repr/traceback: subprocess errors can contain credentials/log text.
        print('{"reason":"WATCHDOG_FAILED","action":"inhibited"}')
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
