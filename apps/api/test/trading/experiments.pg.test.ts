import Fastify from "fastify";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { createPgFixture } from "../pg-fixture.js";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import { identity } from "./ledger-fixture.js";
import { createLedgerAccount } from "../../src/storage/ledgerstore.js";
import { captureReplayDataset } from "../../src/storage/replaystore.js";
import { registerExperimentRoutes } from "../../src/experiments-api.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof createPgFixture>>;
async function transaction<T>(
  read: boolean,
  run: (tx: SqlExecutor) => Promise<T>,
) {
  const c = await f.pool.connect();
  try {
    await c.query(read ? "BEGIN READ ONLY" : "BEGIN");
    if (read) await c.query("SET LOCAL statement_timeout='1500ms'");
    const value = await run({
      async query(sql, args) {
        const r = await c.query(sql, args ? [...args] : []);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
    });
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const pool: Pick<DatabasePool, "readOnly" | "transaction"> = {
  transaction: (run) => transaction(false, run),
  readOnly: (_ms, run) => transaction(true, run),
};
describe.skipIf(!url)("experiment reads on disposable PostgreSQL", () => {
  beforeEach(async () => {
    f = await createPgFixture(url);
    await createLedgerAccount(pool, identity());
  });
  afterEach(async () => {
    await f.dispose();
  });
  it("lists explicit cuts and reads metrics/system twice without modifying ledger, pins or statistics", async () => {
    const a = await captureReplayDataset(pool, "manual", "a".repeat(40));
    async function counts() {
      return (
        await f.pool.query(
          `SELECT (SELECT count(*)::int FROM btc_ledger_events) ledger,(SELECT count(*)::int FROM btc_retention_pins) pins,(SELECT count(*)::int FROM btc_retention_objects) objects,(SELECT row_to_json(p) FROM btc_retention_policy p) policy,(SELECT md5(projection::text) FROM btc_ledger_projections WHERE account_id='manual') projection`,
        )
      ).rows[0];
    }
    const before = await counts();
    const app = Fastify();
    registerExperimentRoutes(app, {
      pool,
      authService: { session: async () => ({ status: "ok" }) },
      clock: () => new Date(),
    });
    try {
      for (let i = 0; i < 2; i++) {
        const headers = { authorization: "Bearer owner" };
        const catalog = await app.inject({
          url: "/trading/experiment-datasets",
          headers,
        });
        expect(catalog.statusCode).toBe(200);
        expect(catalog.json().items[0].dataset_id).toBe(a.dataset_id);
        const report = await app.inject({
          url: `/trading/experiments?account_id=manual&dataset_id=${a.dataset_id}`,
          headers,
        });
        expect(report.statusCode).toBe(200);
        expect(report.json().baseline.trading.equity_usd_raw).toBe(
          "1000000000",
        );
        const billing = await app.inject({
          method: "POST",
          url: `/trading/experiments?account_id=manual&dataset_id=${a.dataset_id}`,
          headers,
          payload: {
            schema_version: "btc.evaluation-input.v1",
            allocation: {
              schema_version: "btc.cost-allocation.v1",
              complete: true,
              window: report.json().baseline.scope.window,
              basis: "synthetic settled invoice",
              bills: [
                {
                  id: "opaque-disposable-only",
                  kind: "infrastructure",
                  total_usd_raw: "1230000",
                  shares: [{ account_id: "manual", usd_raw: "1230000" }],
                },
              ],
            },
          },
        });
        expect(billing.statusCode).toBe(200);
        expect(
          billing.json().baseline.after_operational_costs.net_pnl_usd_raw,
        ).toBe("-1230000");
        const system = await app.inject({
          url: "/trading/experiment-system",
          headers,
        });
        expect(system.statusCode).toBe(200);
        expect(system.json().container_restarts).toBeNull();
        expect(system.json().feed.status).toBe("unknown");
        expect(system.json().capacity.hold).toBe(true);
      }
      expect(await counts()).toEqual(before);
    } finally {
      await app.close();
    }
  });
  it("reports stopped collection as stale without claiming container state or reconciled readiness", async () => {
    await f.pool.query(
      `INSERT INTO btc_market_head(singleton,session_id,last_capture_at,next_15m,next_1h) VALUES(true,'old','2026-01-01Z','2026-01-01Z','2026-01-01Z')`,
    );
    const app = Fastify();
    registerExperimentRoutes(app, {
      pool,
      authService: { session: async () => ({ status: "ok" }) },
      clock: () => new Date("2026-09-27T00:00:00Z"),
    });
    try {
      const r = await app.inject({
        url: "/trading/experiment-system",
        headers: { authorization: "Bearer owner" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().feed.status).toBe("stale");
      expect(r.json().container_status).toBe("unavailable");
      expect(r.json().recovery[0].readiness.reasons).toContain(
        "consumer_not_enabled",
      );
      expect(r.json().operational.status).toBe("not_ready");
      expect(r.json().operational.history.unavailable).toBe(672);
    } finally {
      await app.close();
    }
  });
});
