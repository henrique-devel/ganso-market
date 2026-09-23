import { replayFinancials } from "../../src/storage/valuationstore.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import {
  createLedgerAccount,
  appendLedgerBatch,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import { readLedgerValuation } from "../../src/storage/valuationstore.js";
import { captureBtcMarketBatch } from "../../src/storage/btc-marketstore.js";
import { valueFinancials } from "../../src/trading/valuation.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { command, identity, iso, usd } from "./ledger-fixture.js";
import { metadata, health } from "./bars-fixture.js";
import { market, pricedFill } from "./valuation-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        async query(sql, params) {
          const r = await client.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
async function snapshot() {
  const result = [];
  for (const table of [
    "btc_ledger_accounts",
    "btc_ledger_transactions",
    "btc_ledger_events",
    "btc_ledger_projections",
    "btc_market_head",
    "btc_market_records",
    "btc_retention_objects",
    "btc_retention_policy",
  ])
    result.push(
      (
        await fixture.pool.query(
          `SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  return result;
}
async function capture(at: number) {
  const m = market(at),
    h = health(at);
  Object.assign(h.channels, m.capture!.health.channels);
  // Real venue context has no source timestamp. Never upgrade receipt time.
  const context = {
    ...m.context!.payload,
    source_timestamp: null,
    quality: "unknown" as const,
  };
  await captureBtcMarketBatch(
    pool,
    {
      sessionId: "valuation",
      capturedAt: iso(at),
      metadata,
      events: [m.book!.payload, context],
      health: h,
    },
    true,
  );
  for (const kind of ["book", "context"] as const) {
    m[kind]!.object_id = (
      await fixture.pool.query(
        "SELECT object_id FROM btc_market_records WHERE kind=$1 AND received_at=$2",
        [kind, iso(at)],
      )
    ).rows[0].object_id;
  }
  return { ...m, context: { ...m.context!, payload: context } };
}
describe.skipIf(!url)("financial reads on disposable PostgreSQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
  });
  afterEach(async () => {
    await fixture?.dispose();
  });
  it("reads two opposite owners from durable events and book, never mutating storage or sharing capital", async () => {
    for (const owner of ["manual", "other"]) {
      const id = identity(owner),
        scope = ledgerScope(id);
      await createLedgerAccount(pool, id);
      await appendLedgerBatch(pool, scope, {
        transaction_id: "open",
        events: [
          command(
            "open",
            pricedFill("a", owner === "manual" ? "buy" : "sell"),
            scope,
          ),
        ],
      });
    }
    const at = Date.now();
    await capture(at);
    const before = await snapshot();
    const long = await readLedgerValuation(
      pool,
      ledgerScope(identity()),
      iso(at),
    );
    const short = await readLedgerValuation(
      pool,
      ledgerScope(identity("other")),
      iso(at),
    );
    expect(long.closing.gross_equity_usd_raw).toBe("1008600000");
    expect(short.closing.gross_equity_usd_raw).toBe("988600000");
    expect(long.maintenance).toMatchObject({
      status: "degraded",
      quality: "source_time_unproven",
      equity_usd_raw: null,
      usable_for_risk: false,
    });
    expect(
      await readLedgerValuation(pool, ledgerScope(identity()), iso(at)),
    ).toEqual(long);
    expect(await snapshot()).toEqual(before);
    await expect(
      readLedgerValuation(
        pool,
        { ...ledgerScope(identity()), experiment_id: "experiment:other" },
        iso(at),
      ),
    ).rejects.toThrow("OWNERSHIP");
  });
  it("partial close, fees, retries and out-of-order replay agree to the USD micro-unit without altering S1 projection", async () => {
    const id = identity(),
      scope = ledgerScope(id);
    await createLedgerAccount(pool, id);
    await appendLedgerBatch(pool, scope, {
      transaction_id: "open",
      events: [command("a", pricedFill("a", "buy"))],
    });
    const close = {
      transaction_id: "partial",
      events: [
        command("b", pricedFill("b", "sell", "500000", "65000000000")),
        command("fee", {
          event_type: "fee" as const,
          execution_id: "b",
          delta: usd("-123456"),
        }),
      ],
    };
    await appendLedgerBatch(pool, scope, close);
    expect((await appendLedgerBatch(pool, scope, close)).status).toBe(
      "duplicate",
    );
    const at = Date.now(),
      m = await capture(at);
    const before = await snapshot(),
      stored = await readLedgerAccount(pool, scope);
    const read = await readLedgerValuation(pool, scope, iso(at));
    expect(read).toEqual(
      valueFinancials(replayFinancials(id, [...stored.events].reverse()), m),
    );
    expect(read).toMatchObject({
      realized_pnl_usd_raw: "5000000",
      balance_usd_raw: "1004876544",
      ledger: { cash_usd_raw: "999876544" },
      closing: { gross_equity_usd_raw: "1009376544" },
    });
    expect(await snapshot()).toEqual(before);
    await expect(
      readLedgerValuation(pool, scope, id.experiment.started_at),
    ).rejects.toThrow("BEFORE_LEDGER");
  });
  it("missing and expired market yield unavailable values without manufacturing zeros or rebuilding projections", async () => {
    const scope = ledgerScope(identity());
    await createLedgerAccount(pool, identity());
    await appendLedgerBatch(pool, scope, {
      transaction_id: "open",
      events: [command("a", pricedFill("a", "buy"))],
    });
    const at = Date.now();
    const missing = await readLedgerValuation(pool, scope, iso(at));
    expect(missing.maintenance.equity_usd_raw).toBeNull();
    expect(missing.closing.gross_equity_usd_raw).toBeNull();
    await capture(at);
    const stale = await readLedgerValuation(pool, scope, iso(at + 10_001));
    expect(stale.maintenance).toMatchObject({
      quality: "stale",
      equity_usd_raw: null,
    });
    expect(stale.closing).toMatchObject({
      quality: "stale",
      gross_equity_usd_raw: null,
    });
    await fixture.pool.query(
      `UPDATE btc_ledger_projections SET projection=jsonb_set(projection,'{cash_usd_raw}','"0"')`,
    );
    const corrupted = await snapshot();
    await expect(readLedgerValuation(pool, scope, iso(at))).rejects.toThrow(
      "PROJECTION_MISMATCH",
    );
    expect(await snapshot()).toEqual(corrupted);
  });
  it("future captures cannot leak into a valuation, and the snapshot enforces SQL read-only", async () => {
    const scope = ledgerScope(identity());
    await createLedgerAccount(pool, identity());
    await appendLedgerBatch(pool, scope, {
      transaction_id: "open",
      events: [command("a", pricedFill("a", "buy"))],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const at = Date.now();
    await capture(at);
    const v = await readLedgerValuation(pool, scope, iso(at - 1));
    expect(v.closing.quality).toBe("missing");
    let checked = false;
    const checkingPool = {
      transaction: <T>(run: (tx: SqlExecutor) => Promise<T>) =>
        pool.transaction((tx) =>
          run({
            async query(sql, params) {
              if (sql.startsWith("SELECT identity")) {
                expect(
                  (await tx.query("SHOW transaction_read_only")).rows[0]
                    ?.transaction_read_only,
                ).toBe("on");
                expect(
                  (await tx.query("SHOW transaction_isolation")).rows[0]
                    ?.transaction_isolation,
                ).toBe("repeatable read");
                checked = true;
              }
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await readLedgerValuation(checkingPool, scope, iso(at + 1000));
    expect(checked).toBe(true);
  });
});
