#!/usr/bin/env python3
"""Decide whether a push to main needs a production deploy.

RFC-020 D2. Every merge to main deployed, and a deploy recreated the whole
default stack (see the D1 change to `make server-update`). Measured over the 19
first-parent commits ending 2026-09-06, **10** touched nothing but text, and the
three most recent deploys in production were text-only merges.

The classifier is deliberately timid. It answers "skip" only when it holds a
non-empty list of changed files and every single one of them is text. Anything
else — no list, an unusable `before`, a git failure, an unexpected exception —
answers "deploy". A false "only text" leaves production running old code with a
green check next to it; a false deploy only costs what today already costs.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import PurePosixPath

# Prefixes whose contents never reach a running container. Everything under
# them is documentation or agent configuration; `config/` is deliberately NOT
# here, because it is bind-mounted into the services at runtime.
TEXT_PREFIXES = ("docs/", "prompts/", ".claude/")

# The all-zero object name GitHub sends in `github.event.before` for the first
# push to a ref, and after a force push that has no merge base.
NULL_SHA = "0" * 40

SKIP_MESSAGE = "deploy pulado: só texto"


def is_text_path(path: str) -> bool:
    """True when `path` cannot change what runs in production.

    Root-level Markdown counts (README.md, and nothing deeper); a Markdown file
    inside a code directory does not get a pass just for its extension, because
    the criterion is the directory, not the suffix.
    """
    if not path:
        return False
    normalized = path.strip()
    if not normalized or normalized.startswith("/") or "\\" in normalized:
        return False
    parts = PurePosixPath(normalized).parts
    if any(part in {"", ".", ".."} for part in parts):
        return False
    if normalized.startswith(TEXT_PREFIXES):
        return True
    return len(parts) == 1 and normalized.endswith(".md")


def classify(paths: list[str]) -> tuple[bool, str]:
    """Return (deploy, reason) for an already-collected list of changed files."""
    cleaned = [path for path in (raw.strip() for raw in paths) if path]
    if not cleaned:
        # No list is not evidence of no change: it is absence of measurement.
        return True, "lista de arquivos vazia — deploy por segurança"
    code = [path for path in cleaned if not is_text_path(path)]
    if code:
        shown = ", ".join(code[:5])
        if len(code) > 5:
            shown = f"{shown}, … (+{len(code) - 5})"
        return True, f"{len(code)} de {len(cleaned)} arquivos fora das listas de texto: {shown}"
    return False, f"{SKIP_MESSAGE} ({len(cleaned)} arquivos)"


def changed_files(before: str, sha: str, *, repository_root: str | None = None) -> list[str]:
    """List files changed between two revisions, or raise."""
    if not before or before == NULL_SHA:
        raise ValueError("`before` ausente ou zerado — sem base de comparação")
    if not sha:
        raise ValueError("`sha` ausente")
    result = subprocess.run(
        ["git", "diff", "--name-only", f"{before}..{sha}"],
        check=False,
        capture_output=True,
        text=True,
        cwd=repository_root,
    )
    if result.returncode != 0:
        raise RuntimeError(f"`git diff` falhou ({result.returncode}): {result.stderr.strip()}")
    return [line for line in result.stdout.splitlines() if line.strip()]


def decide(
    event_name: str, before: str, sha: str, *, repository_root: str | None = None
) -> tuple[bool, str]:
    """The whole decision, exceptions included. Never raises."""
    if event_name != "push":
        # workflow_dispatch (and anything else that reaches the deploy job)
        # is an explicit operator act and is never skipped.
        return True, f"evento {event_name or 'desconhecido'} — nunca é pulado"
    try:
        return classify(changed_files(before, sha, repository_root=repository_root))
    except Exception as error:  # noqa: BLE001 - any failure must deploy
        return (
            True,
            f"classificação falhou ({type(error).__name__}: {error}) — deploy por segurança",
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event-name", default=os.environ.get("GITHUB_EVENT_NAME", ""))
    parser.add_argument("--before", default=os.environ.get("DEPLOY_PATHS_BEFORE", ""))
    parser.add_argument("--sha", default=os.environ.get("GITHUB_SHA", ""))
    parser.add_argument("--output", default=os.environ.get("GITHUB_OUTPUT", ""))
    arguments = parser.parse_args(argv)

    deploy, reason = decide(arguments.event_name, arguments.before, arguments.sha)
    print(f"deploy={'true' if deploy else 'false'}: {reason}")
    if arguments.output:
        with open(arguments.output, "a", encoding="utf-8") as handle:
            handle.write(f"deploy={'true' if deploy else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
