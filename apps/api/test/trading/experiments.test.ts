import { pair } from "./comparison-fixture.js";
import { sealReplayPages } from "../../src/storage/replay-pages.js";
import { windowFixture } from "./replay-pages-fixture.js";
import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { registerExperimentRoutes } from "../../src/experiments-api.js";
import {
  sealReplayDataset,
  REPLAY_CONTRACTS,
  REPLAY_VERSION,
  type ReplayDataset,
} from "../../src/storage/replay-dataset.js";
import {
  materializeLedgerBatch,
  genesisBatch,
} from "../../src/storage/ledger-contract.js";
import { identity, iso, start } from "./ledger-fixture.js";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";

function artifact(account = "manual", sha = "a", end = start + 5000) {
  const id = identity(account);
  const d: ReplayDataset = {
    schema_version: REPLAY_VERSION,
    contracts: REPLAY_CONTRACTS,
    code_sha: sha.repeat(40),
    cut: {
      captured_at: iso(end),
      ledger_sequence: "1",
      reservation_sequence: "0",
      semantics: "locked_account_snapshot",
    },
    identity: id,
    ledger: materializeLedgerBatch(genesisBatch(id), "0", iso(start)),
    reservations: [],
    decisions: [],
    jev: [],
    roots: [],
    evidence: [],
  };
  return sealReplayDataset(d);
}
const a = artifact(),
  b = artifact("challenger", "b");
const headers = { authorization: "Bearer valid" };
function setup(ok = true) {
  const query = vi.fn(async (_sql: string, args?: readonly unknown[]) => ({
    rows: [{ payload: args?.[0] === a.dataset_id ? a : b }],
    rowCount: 1,
  }));
  const readOnly = vi.fn(
    async (_ms: number, run: (tx: SqlExecutor) => Promise<unknown>) =>
      run({ query } as SqlExecutor),
  );
  const app = Fastify();
  registerExperimentRoutes(app, {
    pool: { readOnly } as Pick<DatabasePool, "readOnly">,
    authService: { session: async () => ({ status: ok ? "ok" : "expired" }) },
    clock: () => new Date(iso(start + 100000)),
  });
  return { app, query, readOnly };
}
function url(comparison?: unknown, challenger = b.dataset_id) {
  const q = new URLSearchParams({
    account_id: "manual",
    dataset_id: a.dataset_id,
    challenger_id: challenger,
  });
  if (comparison) q.set("comparison", JSON.stringify(comparison));
  return `/trading/experiments?${q}`;
}
describe("authenticated, bounded immutable experiment reads", () => {
  it("authenticates every route before SQL, disables caching and has no writes", async () => {
    const s = setup(false);
    for (const path of [
      "experiments",
      "experiment-datasets",
      "experiment-system",
    ]) {
      const r = await s.app.inject({ url: `/trading/${path}`, headers });
      expect(r.statusCode).toBe(401);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(
        (
          await s.app.inject({
            method: "POST",
            url: `/trading/${path}`,
            headers,
          })
        ).statusCode,
      ).toBe(path === "experiments" ? 401 : 404);
    }
    expect(s.readOnly).not.toHaveBeenCalled();
    await s.app.close();
  });
  it("rejects unbounded, duplicate, invalid and unexpected inputs before SQL", async () => {
    const s = setup();
    for (const path of [
      "experiments",
      "experiments?account_id=x&dataset_id=x",
      "experiment-datasets?after=a&after=b",
      "experiment-system?after=x&mode=live",
      "experiments?comparison=" + "a".repeat(2049),
    ]) {
      expect(
        (await s.app.inject({ url: `/trading/${path}`, headers })).statusCode,
      ).toBe(400);
    }
    expect(s.readOnly).not.toHaveBeenCalled();
    await s.app.close();
  });
  it("keeps no-trade account zero legitimate, costs unknown, a single equity observation and read idempotence", async () => {
    const s = setup();
    const before = JSON.stringify(a);
    const path = `/trading/experiments?account_id=manual&dataset_id=${a.dataset_id}`;
    const first = await s.app.inject({ url: path, headers }),
      second = await s.app.inject({ url: path, headers });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const r = first.json();
    expect(r.status).toBe("challenger_absent");
    expect(r.baseline.drawdown.max_usd_raw).toBe("0");
    expect(r.baseline.operational_costs.total_usd_raw).toBeNull();
    expect(r.baseline.equity_curve.points).toHaveLength(1);
    expect(JSON.stringify(a)).toBe(before);
    expect(
      s.query.mock.calls.every(([sql]) => /^SELECT payload/.test(sql)),
    ).toBe(true);
    await s.app.close();
  });
  it("keeps version changes and missing manifest side by side without fictional delta", async () => {
    const s = setup();
    const missing = (await s.app.inject({ url: url(), headers })).json();
    expect(missing.status).toBe("not_comparable");
    expect(missing.delta).toBeNull();
    const c = {
      schema_version: "btc.economic-comparison.v1",
      baseline_dataset_id: a.dataset_id,
      challenger_dataset_id: b.dataset_id,
      market_dataset_hash: "sha256:" + "a".repeat(64),
      baseline_risk_hash: "sha256:" + "b".repeat(64),
      challenger_risk_hash: "sha256:" + "b".repeat(64),
      declared_version_differences: [],
    };
    const changed = (await s.app.inject({ url: url(c), headers })).json();
    // Fixture identities have the same strategy/manifest; code change needs declaration.
    expect(changed.reason).toBe("BTC_METRICS_COMPARISON_VERSION_DECLARATION");
    expect(changed.delta).toBeNull();
    const declared = (
      await s.app.inject({
        url: url({ ...c, declared_version_differences: ["code_sha"] }),
        headers,
      })
    ).json();
    expect(declared.status).toBe("observational_comparison");
    expect(declared.delta.trading_usd_raw).toBe("0");
    const risk = (
      await s.app.inject({
        url: url({
          ...c,
          declared_version_differences: ["code_sha"],
          challenger_risk_hash: "sha256:" + "c".repeat(64),
        }),
        headers,
      })
    ).json();
    expect(risk.status).toBe("risk_or_capital_differs");
    expect(risk.delta).toBeNull();
    await s.app.close();
  });
  it("refuses mixed account selection and incompatible windows without rewriting snapshots", async () => {
    const s = setup();
    expect(
      (
        await s.app.inject({
          url: `/trading/experiments?account_id=other&dataset_id=${a.dataset_id}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const later = artifact("challenger", "a", start + 6000);
    s.query.mockImplementation(async (_sql, args) => ({
      rows: [{ payload: args?.[0] === a.dataset_id ? a : later }],
      rowCount: 1,
    }));
    const c = {
      schema_version: "btc.economic-comparison.v1",
      baseline_dataset_id: a.dataset_id,
      challenger_dataset_id: later.dataset_id,
      market_dataset_hash: "sha256:" + "a".repeat(64),
      baseline_risk_hash: "sha256:" + "b".repeat(64),
      challenger_risk_hash: "sha256:" + "b".repeat(64),
      declared_version_differences: [],
    };
    const r = (
      await s.app.inject({ url: url(c, later.dataset_id), headers })
    ).json();
    expect(r.reason).toBe("BTC_METRICS_COMPARISON_WINDOW_OR_CONTRACT");
    expect(r.delta).toBeNull();
    await s.app.close();
  });
  it("compares different starts through the persisted v2 registration without writes", async () => {
    const s = setup(),
      { x, y, c } = pair().seal();
    s.query.mockImplementation(async (_sql, args) => ({
      rows: [{ payload: args?.[0] === x.dataset_id ? x : y }],
      rowCount: 1,
    }));
    const q = new URLSearchParams({
      account_id: "baseline",
      dataset_id: x.dataset_id,
      challenger_id: y.dataset_id,
      comparison: JSON.stringify(c),
    });
    const r = await s.app.inject({ url: `/trading/experiments?${q}`, headers });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("observational_comparison");
    expect(r.json().baseline.scope.financial_start_at).not.toBe(
      r.json().challenger.scope.financial_start_at,
    );
    expect(
      s.query.mock.calls.every(([sql]) => /^SELECT payload/.test(sql)),
    ).toBe(true);
    await s.app.close();
  });
  it("bounds catalog range and never fetches replay payloads while listing", async () => {
    const s = setup();
    s.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const r = await s.app.inject({
      url: "/trading/experiment-datasets",
      headers,
    });
    expect(r.json()).toEqual({ items: [], next_cursor: null });
    expect(s.query.mock.calls[0]![0]).toContain("LIMIT 51");
    expect(s.query.mock.calls[0]![0]).not.toContain("payload");
    await s.app.close();
  });
  it("accepts bounded private billing bodies read-only; invalid or oversize input is rejected", async () => {
    const s = setup();
    const payload = {
      schema_version: "btc.evaluation-input.v1",
      allocation: {
        schema_version: "btc.cost-allocation.v1",
        window: { start: iso(start), end: iso(start + 5000) },
        complete: true,
        basis: "synthetic invoice",
        bills: [
          {
            id: "opaque",
            kind: "infrastructure",
            total_usd_raw: "1000000",
            shares: [{ account_id: "manual", usd_raw: "1000000" }],
          },
        ],
      },
    };
    const u = `/trading/experiments?account_id=manual&dataset_id=${a.dataset_id}`;
    for (let i = 0; i < 2; i++) {
      const r = await s.app.inject({
        method: "POST",
        url: u,
        headers,
        payload,
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().baseline.after_operational_costs.net_pnl_usd_raw).toBe(
        "-1000000",
      );
      expect(r.json().evaluation.references[1].net_pnl_usd_raw).toBeNull();
    }
    expect(
      s.query.mock.calls.every(([sql]) => /^SELECT payload/.test(sql)),
    ).toBe(true);
    s.query.mockClear();
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: u,
          headers,
          payload: { ...payload, invoice: "private" },
        })
      ).statusCode,
    ).toBe(400);
    expect(s.query).not.toHaveBeenCalled();
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: u,
          headers,
          payload: { data: "x".repeat(32769) },
        })
      ).statusCode,
    ).toBe(413);
    await s.app.close();
  });
  it("reads one paginated page without running large replay or claiming financial coverage", async () => {
    const s = setup(),
      b = sealReplayPages(windowFixture(6));
    s.query.mockImplementation(async (_sql, args) => ({
      rows: [
        {
          payload: (args?.[0] === b.artifact.dataset_id
            ? b.artifact
            : b.pages[0]) as never,
        },
      ],
      rowCount: 1,
    }));
    const u = `/trading/experiments?account_id=${b.artifact.manifest.header.identity.account.account_id}&dataset_id=${b.artifact.dataset_id}`;
    const manifest = await s.app.inject({ url: u, headers });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().financial_metrics).toBeNull();
    expect(manifest.json().verified_page).toBeNull();
    const page = await s.app.inject({ url: u + "&page=0", headers });
    expect(page.statusCode).toBe(200);
    expect(page.json().verified_page.index).toBe(0);
    expect(
      (await s.app.inject({ url: u + "&page=9999", headers })).statusCode,
    ).toBe(400);
    expect(
      s.query.mock.calls.every(([sql]) => /^SELECT payload/.test(sql)),
    ).toBe(true);
    await s.app.close();
  });
});
