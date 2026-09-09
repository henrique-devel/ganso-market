#!/usr/bin/env python3
"""Helpers the shadow-replay job shells out to, kept in Python on purpose.

Two jobs that POSIX ``sh`` does badly, and that the RFC-029 D2 requires be done
exactly right:

``error-json``
    Build ``latest-{mode}.error.json`` out of a failed run. The CLI's stderr is
    operator-supplied text with quotes, braces and newlines in it; pasting it
    into a JSON document with string concatenation produces a file the screen
    cannot parse, on the one day the screen most needs to say something. It also
    lifts ``reason_code`` out of the CLI's own error line, which is the field
    that VARIES (``USAGE``, ``SweepError``/``ConfigError`` codes, or the
    ``SHADOW_REPLAY_FAILED`` fallback -- ``shadow-replay-cli.ts:809-815``). The
    exit status, not the text, is what marks the run as failed.

``window-start``
    Print the ISO instant the mode B window opens at. ``date -d '-72 hours'`` is
    GNU-only, and the job's test suite runs on the developers' machines too,
    where ``date`` is BSD and would fail on that flag rather than on anything
    real.

``retention-plan``
    Name the files retention may delete. The RFC forbids deleting by glob or by
    parent directory: every removal has to name one file. This prints those
    names, one per line, oldest first, and refuses to print anything that is not
    a regular file whose name matches ``YYYY-MM-DD-{mode}.json`` exactly. A
    ``latest-B.json``, a symlink, a subdirectory or a stray ``.tmp`` can
    therefore never reach the ``rm`` in the shell, whatever ends up in the
    directory.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

MODES = ("A", "B")
RUN_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FALLBACK_REASON = "SHADOW_REPLAY_FAILED"
MAX_STDERR_BYTES = 64 * 1024


def run_file_pattern(mode: str) -> re.Pattern[str]:
    return re.compile(rf"^(\d{{4}}-\d{{2}}-\d{{2}})-{mode}\.json$")


def reason_code(stderr_text: str) -> str:
    """Lift ``reason_code`` from the CLI's last well-formed error line.

    Last, not first: a crash can print warnings before the structured line, and
    the structured line is written by the ``run().catch`` at the very end
    (``shadow-replay-cli.ts:807``). Anything unparseable leaves the fallback,
    which is the same string the CLI itself falls back to.
    """
    for line in reversed(stderr_text.splitlines()):
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            parsed = json.loads(stripped)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            code = parsed.get("reason_code")
            if isinstance(code, str) and code:
                return code
    return FALLBACK_REASON


def error_document(
    *,
    mode: str,
    run_date: str,
    status: int,
    generated_at: str,
    stderr_text: str,
) -> dict[str, object]:
    truncated = stderr_text.encode("utf-8")[:MAX_STDERR_BYTES].decode("utf-8", errors="replace")
    return {
        "status": "error",
        "mode": mode,
        "run_date": run_date,
        "generated_at": generated_at,
        "exit_status": status,
        "reason_code": reason_code(stderr_text),
        "message": "shadow_replay_failed",
        "stderr": truncated,
        "stderr_truncated": len(truncated) < len(stderr_text),
    }


def window_start(hours: float, now: datetime.datetime | None = None) -> str:
    """The ``--from`` instant for a window of ``hours`` ending now, in UTC."""
    if not hours > 0:
        raise SystemExit("window-start: --hours must be positive")
    moment = now if now is not None else datetime.datetime.now(datetime.timezone.utc)
    opened = moment - datetime.timedelta(hours=hours)
    return opened.strftime("%Y-%m-%dT%H:%M:%SZ")


def retention_plan(directory: Path, mode: str, keep: int) -> list[str]:
    """Filenames to delete so at most ``keep`` dated runs of ``mode`` remain."""
    if keep < 1:
        raise SystemExit("retention-plan: --keep must be at least 1")
    pattern = run_file_pattern(mode)
    dated: list[str] = []
    for entry in sorted(directory.iterdir()):
        if entry.is_symlink() or not entry.is_file():
            continue
        if pattern.match(entry.name) is None:
            continue
        dated.append(entry.name)
    # Names sort in date order because the date is a fixed-width ISO prefix, so
    # there is no clock and no mtime in this decision -- a `touch` cannot make
    # retention drop a different file than the one its name says is oldest.
    dated.sort()
    if len(dated) <= keep:
        return []
    return dated[: len(dated) - keep]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    error = subparsers.add_parser("error-json")
    error.add_argument("--mode", required=True, choices=MODES)
    error.add_argument("--run-date", required=True)
    error.add_argument("--status", required=True, type=int)
    error.add_argument("--generated-at", required=True)
    error.add_argument("--stderr-file", required=True)

    window = subparsers.add_parser("window-start")
    window.add_argument("--hours", required=True, type=float)

    retention = subparsers.add_parser("retention-plan")
    retention.add_argument("--dir", required=True)
    retention.add_argument("--mode", required=True, choices=MODES)
    retention.add_argument("--keep", required=True, type=int)

    args = parser.parse_args(argv)

    if args.command == "error-json":
        if RUN_DATE.match(args.run_date) is None:
            raise SystemExit(f"error-json: bad --run-date {args.run_date!r}")
        stderr_text = Path(args.stderr_file).read_text(encoding="utf-8", errors="replace")
        json.dump(
            error_document(
                mode=args.mode,
                run_date=args.run_date,
                status=args.status,
                generated_at=args.generated_at,
                stderr_text=stderr_text,
            ),
            sys.stdout,
            ensure_ascii=False,
            indent=2,
        )
        sys.stdout.write("\n")
        return 0

    if args.command == "window-start":
        print(window_start(args.hours))
        return 0

    for name in retention_plan(Path(args.dir), args.mode, args.keep):
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
