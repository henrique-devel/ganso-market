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
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

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


# Candidate services are intersected with running containers on the host.
# A profile name or an explicit Compose service must never activate a worker.
LEGACY = {
    f"polymarket-{name}" for name in ("recorder", "estimator", "resolution", "paper", "portfolio")
}
NODE_SERVICES = {"api", "btc-worker", *LEGACY}
CODE_SERVICES = {*NODE_SERVICES, "web", "nginx"}


def affected_services(paths: list[str]) -> set[str]:
    if not paths:
        return CODE_SERVICES | {"migrate"}
    selected: set[str] = set()
    for path in paths:
        if is_text_path(path):
            continue
        if path.startswith(
            ("apps/api/src/btc-worker", "apps/api/src/btc/", "config/btc-worker")
        ) or path in {
            "apps/api/test/btc-worker.test.ts",
            "apps/api/test/btc-worker-runtime.test.ts",
            "apps/api/test/btc-runtime-diagnostics.test.ts",
            "apps/api/test/btc-context-poll.test.ts",
            "apps/api/src/venues/hyperliquid/feed.ts",
            "apps/api/src/venues/hyperliquid/context-snapshot.ts",
            "apps/api/test/venues/hyperliquid-feed.test.ts",
            "apps/api/test/venues/hyperliquid-context.test.ts",
        }:
            selected.add("btc-worker")
        elif any(path == f"apps/api/src/{name}.ts" for name in LEGACY):
            selected.add(Path(path).stem)
        elif path.startswith("apps/api/src/polymarket/"):
            selected.update({"api", *LEGACY})
        elif path in {
            "packages/contracts/src/trading/desk.ts",
            "packages/contracts/src/trading/history.ts",
        }:
            selected.update({"api", "web"})
        elif path in {
            "apps/api/src/challenger-activate-cli.ts",
            "apps/api/src/models/jev-config.ts",
            "apps/api/src/storage/challenger-operations.ts",
            "apps/api/src/server.ts",
            "apps/api/test/trading/challenger-operations.pg.test.ts",
            "apps/api/test/trading/jev-config.test.ts",
            "apps/api/src/models/jev.ts",
            "apps/api/src/models/jev-contract.ts",
            "apps/api/src/models/jev-typesafe.ts",
            "apps/api/src/storage/jevstore.ts",
            "apps/api/src/storage/challenger-runtime.ts",
            "apps/api/test/trading/challenger.pg.test.ts",
            "apps/api/test/trading/jev-fixture.ts",
            "apps/api/test/trading/jev.test.ts",
            "apps/api/test/trading/jev.pg.test.ts",
            "config/trading/baseline.json",
            "apps/api/src/baseline-activate-cli.ts",
            "apps/api/src/storage/baseline-store.ts",
            "apps/api/src/storage/baseline-runtime.ts",
            "apps/api/test/trading/baseline-runtime.pg.test.ts",
            "apps/api/src/storage/baseline-manifest.ts",
            "apps/api/src/trading/strategies/baseline.ts",
            "apps/api/src/storage/baseline-inputs.ts",
            "apps/api/src/storage/baseline-policy.ts",
            "apps/api/src/storage/baseline-exits.ts",
            "apps/api/test/trading/baseline-fixture.ts",
            "apps/api/test/trading/baseline-policy.test.ts",
            "apps/api/test/trading/baseline-exits.test.ts",
            "apps/api/test/trading/baseline-manifest.test.ts",
            "apps/api/src/main.ts",
            "apps/api/src/desk-activate-cli.ts",
            "apps/api/src/trading-readapi.ts",
            "apps/api/src/storage/desk-history.ts",
            "apps/api/test/trading/desk.test.ts",
            "apps/api/test/route-budgets.runtime.test.ts",
            "apps/api/test/trading/desk.pg.test.ts",
            "apps/api/src/storage/desk-commandstore.ts",
            "apps/api/src/storage/desk-consumer.ts",
            "apps/api/src/storage/desk-worker.ts",
            "apps/api/test/trading/desk-consumer.pg.test.ts",
            "apps/api/test/trading/commands.pg.test.ts",
            "apps/api/src/storage/recoverystore.ts",
            "apps/api/src/storage/recovery-audit.ts",
            "apps/api/test/trading/recovery.pg.test.ts",
            "apps/api/test/trading/acceptance.pg.test.ts",
            "apps/api/test/trading/acceptance-fixture.ts",
            "apps/api/src/trading/risk.ts",
            "apps/api/src/storage/riskstore.ts",
            "apps/api/test/trading/risk.test.ts",
            "apps/api/test/trading/risk.pg.test.ts",
            "apps/api/test/trading/risk-fixture.ts",
            "apps/api/src/trading/margin.ts",
            "apps/api/src/storage/marginstore.ts",
            "apps/api/test/trading/margin.test.ts",
            "apps/api/test/trading/margin.pg.test.ts",
            "apps/api/test/trading/margin-fixture.ts",
            "apps/api/src/trading/funding.ts",
            "apps/api/src/storage/fundingstore.ts",
            "apps/api/src/venues/hyperliquid/funding.ts",
            "apps/api/test/trading/funding.test.ts",
            "apps/api/test/trading/funding.pg.test.ts",
            "apps/api/test/trading/funding-fixture.ts",
            "apps/api/src/trading/passive.ts",
            "apps/api/src/storage/passivestore.ts",
            "apps/api/src/storage/passive-contract.ts",
            "apps/api/test/trading/passive.test.ts",
            "apps/api/test/trading/passive.pg.test.ts",
            "apps/api/src/trading/broker.ts",
            "apps/api/src/storage/brokerstore.ts",
            "apps/api/src/storage/broker-contract.ts",
            "apps/api/test/trading/broker.test.ts",
            "apps/api/test/trading/broker.pg.test.ts",
            "apps/api/src/trading/ledger.ts",
            "apps/api/src/storage/ledgerstore.ts",
            "apps/api/src/storage/ledger-contract.ts",
            "apps/api/test/trading/ledger.test.ts",
            "apps/api/test/trading/ledger.pg.test.ts",
            "apps/api/test/trading/ledger-fixture.ts",
            "apps/api/src/trading/reservations.ts",
            "apps/api/src/storage/reservationstore.ts",
            "apps/api/src/storage/reservation-contract.ts",
            "apps/api/test/trading/reservations.test.ts",
            "apps/api/test/trading/reservations.pg.test.ts",
            "apps/api/test/trading/reservation-fixture.ts",
            "apps/api/src/trading/valuation.ts",
            "apps/api/src/storage/valuationstore.ts",
            "apps/api/test/trading/valuation.test.ts",
            "apps/api/test/trading/valuation.pg.test.ts",
            "apps/api/test/trading/valuation-fixture.ts",
        }:
            # Account financial reads have no collector/legacy consumer. Preserve the feed.
            selected.add("api")
        elif path == "apps/api/test/trading/retention.pg.test.ts":
            # SQL guard coverage has no image/runtime consumer. Its additive
            # migration is selected independently; preserve stopped collectors.
            continue
        elif path.startswith("apps/api/"):
            selected.update(NODE_SERVICES)
        elif path.startswith("apps/web/"):
            selected.add("web")
        elif path == "config/runtime.json":
            selected.update(NODE_SERVICES)
        elif path.startswith(("services/market-engine/", "workers/model-worker/")) or path in {
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
        }:
            # G2-03.4: retired artifacts have no remaining image consumers.
            continue
        elif path.startswith(("migrations/", "infra/migrations/")):
            selected.add("migrate")
        elif path.startswith("infra/nginx/"):
            selected.add("nginx")
        elif path == "docker-compose.yml":
            selected.update(CODE_SERVICES | {"migrate"})
        elif path.startswith(("deploy/", "scripts/", ".github/")) or path == "Makefile":
            # Operational scripts are invoked from the synchronized release.
            continue
        else:
            # Shared config, dependencies and unknown paths fail conservative.
            selected.update(CODE_SERVICES | {"migrate"})
    return selected


def changed_runtime_services(previous: Path, release: Path) -> set[str]:
    """Only an API route-budget change can exempt other runtime consumers."""
    try:
        configs = [
            json.loads((root / "config/runtime.json").read_text()) for root in (previous, release)
        ]
        for config in configs:
            routes = config["services"]["api"]["statement_timeout_ms"].pop("routes")
            if not isinstance(routes, dict):
                return NODE_SERVICES
        return {"api"} if configs[0] == configs[1] else NODE_SERVICES
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return NODE_SERVICES


def changed_tree_files(previous: Path, release: Path) -> list[str]:
    """Compare the actual deployed tree, including missed releases/deletions.

    Ignore exactly the local state excluded by the release synchronizer.
    Errors propagate to the caller, which falls back to all running services.
    """

    def inventory(root: Path) -> dict[str, str]:
        files: dict[str, str] = {}
        for directory, dirs, names in os.walk(root):
            relative = Path(directory).relative_to(root)
            dirs[:] = [
                name
                for name in dirs
                if name
                not in {".git", ".deploy", "node_modules", ".venv", "__pycache__", "dist", "target"}
                and (relative / name).as_posix() != "infra/secrets/local"
            ]
            for name in names:
                path = (relative / name).as_posix()
                if path in {".env", "deploy/server.env", "deploy/release-sha"}:
                    continue
                content = (root / path).read_bytes()
                if path == "packages/contracts/src/trading/index.ts":
                    # Named type re-exports are erased by tsc. Their source files
                    # are classified separately; runtime exports stay conservative.
                    content = re.sub(
                        rb'export type \{[A-Za-z0-9_, \r\n]*\} from "\./[a-z-]+\.js";\s*',
                        b"",
                        content,
                    )
                files[path] = hashlib.sha256(content).hexdigest()
        return files

    if not previous.is_dir() or not release.is_dir():
        raise ValueError("deployed tree unavailable")
    before, after = inventory(previous), inventory(release)
    return sorted(
        path for path in before.keys() | after.keys() if before.get(path) != after.get(path)
    )


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
            try:
                paths = changed_files(arguments.before, arguments.sha)
            except Exception:
                paths = []
            services = affected_services(paths) if deploy else set()
            handle.write(f"services={','.join(sorted(services))}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
