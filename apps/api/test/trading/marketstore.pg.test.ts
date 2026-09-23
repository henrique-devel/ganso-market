import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import {
  captureBtcMarketBatch,
  closeBtcMarketBars,
  pinBtcMarketInputs,
  readBtcMarketView,
  type BtcMarketBatch,
} from "../../src/storage/btc-marketstore.js";
import {
  retainBtcBatch,
  retentionCapacity,
} from "../../src/storage/btc-retention.js";
import { BTC_RETENTION_POLICY } from "../../src/trading/retention.js";
import { iso, health, metadata, start, trade } from "./bars-fixture.js";
import { normalizeHyperliquidFeed } from "../../src/venues/hyperliquid/feed-normalizer.js";

const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        async query(text, params) {
          const r = await client.query(text, params ? [...params] : []);
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
  async readOnly<T>(budget: number, run: (tx: SqlExecutor) => Promise<T>) {
    return this.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      await tx.query(`SET LOCAL statement_timeout = '${budget}ms'`);
      return run(tx);
    });
  },
};
function batch(
  at = start + 1000,
  events = [trade()],
  sessionId = "session-a",
): BtcMarketBatch {
  return {
    sessionId,
    capturedAt: iso(at),
    metadata,
    events,
    health: health(at),
  };
}
const capture = (input: BtcMarketBatch) =>
  captureBtcMarketBatch(pool, input, true);
const close = (at: number) => closeBtcMarketBars(pool, iso(at), true);
const view = (at = start + 910_000) =>
  readBtcMarketView(pool, {
    interval: 900_000,
    limit: 10,
    requiredBars: 1,
    asOf: iso(at),
  });
const prune = () =>
  retainBtcBatch(pool, {
    datasetId: BTC_RETENTION_POLICY.datasetId,
    policyVersion: BTC_RETENTION_POLICY.version,
    limit: 500,
    execute: true,
  });
async function counts() {
  return (
    await fixture.pool
      .query(`SELECT (SELECT count(*)::int FROM btc_retention_objects) objects,
    (SELECT count(*)::int FROM btc_market_records) records, (SELECT count(*)::int FROM btc_market_bars) bars,
    (SELECT raw_bytes::text FROM btc_retention_policy) raw, (SELECT total_bytes::text FROM btc_retention_policy) total`)
  ).rows[0];
}
async function observedWindow() {
  // Real writer across a complete interval. A startup bucket remains incomplete.
  await capture(batch(start - 1000, []));
  for (let at = start; at <= start + 910_000; at += 10_000) {
    await capture(batch(at, at === start + 10_000 ? [trade(at)] : []));
  }
  await close(start + 910_000);
  return view();
}

it("writers are disabled by default without opening a database connection", async () => {
  const never = {
    transaction: async () => {
      throw new Error("must not connect");
    },
  };
  expect(await captureBtcMarketBatch(never, batch())).toMatchObject({
    status: "disabled",
  });
  expect(await closeBtcMarketBars(never, iso(start))).toMatchObject({
    status: "disabled",
  });
});

describe.skipIf(!url)("BTC market persistence on disposable PostgreSQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
  });
  afterEach(async () => {
    await fixture?.dispose();
  });
  it("persists metadata/raw once, and replays a committed batch idempotently", async () => {
    expect(await capture(batch())).toMatchObject({ stored: 1, duplicates: 0 });
    const before = await counts();
    expect(await capture(batch())).toMatchObject({ status: "duplicate" });
    expect(await counts()).toEqual(before);
    const rows = await fixture.pool.query(
      "SELECT class,payload,charged_bytes::int,expires_at,recorded_at FROM btc_retention_objects WHERE payload->>'channel'='trades'",
    );
    expect(rows.rows[0].payload).toEqual(trade());
    expect(rows.rows[0].charged_bytes).toBeGreaterThan(3000);
    expect(
      rows.rows[0].expires_at.getTime() - rows.rows[0].recorded_at.getTime(),
    ).toBe(7 * 86400000);
  });
  it("deduplicates a venue trade across session and receipt/metadata observation changes", async () => {
    await capture(batch());
    const retry = batch(
      start + 2000,
      [{ ...trade(), received_at: iso(start + 2000) }],
      "session-b",
    );
    expect(await capture(retry)).toMatchObject({ stored: 0, duplicates: 1 });
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM btc_market_records WHERE kind='trades'",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("rolls back every row, cursor and byte charge on a conflicting trade", async () => {
    await capture(batch());
    const before = await counts();
    await expect(
      capture(
        batch(start + 2000, [
          trade(start + 2000, 2),
          trade(start + 1000, 1, "65000"),
        ]),
      ),
    ).rejects.toThrow("EVENT_CONFLICT");
    expect(await counts()).toEqual(before);
    expect(
      (
        await fixture.pool.query("SELECT last_capture_at FROM btc_market_head")
      ).rows[0].last_capture_at.toISOString(),
    ).toBe(iso(start + 1000));
  });
  it("atomically refuses quota overflow without dropping evidence or bypassing financial guards", async () => {
    await capture(batch());
    await fixture.pool.query(
      "UPDATE btc_retention_policy SET total_quota_bytes=total_bytes+6000",
    );
    const before = await counts();
    await expect(
      capture(
        batch(start + 2000, [trade(start + 2000, 2), trade(start + 2000, 3)]),
      ),
    ).rejects.toThrow("CAPACITY_REFUSED");
    expect(await counts()).toEqual(before);
    expect((await retentionCapacity(pool)).hold).toBe(true);
  });
  it("serializes competing writers, allowing exactly one event and charge", async () => {
    const results = await Promise.all([capture(batch()), capture(batch())]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "duplicate",
      "stored",
    ]);
    const state = await counts();
    expect(state.objects).toBe(3);
    expect(state.records).toBe(3);
  });
  it("forms observed UTC bars, resumes closing idempotently and reads projections", async () => {
    const result = await observedWindow();
    expect(result.bars[0]!.payload).toMatchObject({
      start_at: iso(start),
      end_at: iso(start + 900_000),
      trade_count: 1,
      quality: { state: "observed_no_known_gap", continuity: "unproven" },
    });
    expect(result.warmup.ready).toBe(true);
    expect(result.metadata?.payload).toEqual(metadata);
    const before = await counts();
    expect((await close(start + 910_000)).closed).toBe(0);
    expect(await counts()).toEqual(before);
    const statements: string[] = [];
    await readBtcMarketView(
      {
        readOnly: (budget, run) =>
          pool.readOnly(budget, (tx) =>
            run({
              async query(text, args) {
                statements.push(text);
                return tx.query(text, args);
              },
            }),
          ),
      },
      {
        interval: 900_000,
        limit: 5,
        requiredBars: 1,
        asOf: iso(start + 910_000),
      },
    );
    expect(
      statements.every(
        (sql) =>
          sql.includes("LIMIT") &&
          !sql.includes("SUM(") &&
          !sql.includes("count("),
      ),
    ).toBe(true);
  }, 20_000);
  it("publishes late-input quality revisions, preserving OHLC and pinned prior versions", async () => {
    const result = await observedWindow();
    const original = result.bars[0]!;
    await pinBtcMarketInputs(
      pool,
      "decision-1",
      [original.object_id],
      "decision inputs",
    );
    await capture(
      batch(start + 920_000, [
        trade(start + 1000, 9, "99999", "0.01", start + 920_000),
      ]),
    );
    const revised = (await view(start + 920_000)).bars[0]!;
    expect(revised.object_id).not.toBe(original.object_id);
    expect(revised.payload.ohlc).toEqual(original.payload.ohlc);
    expect(revised.payload.quality.reasons).toContain("late_input");
    expect((await view(start + 920_000)).warmup.ready).toBe(false);
    expect(
      (
        await fixture.pool.query(
          "SELECT payload FROM btc_retention_objects WHERE object_id=$1",
          [original.object_id],
        )
      ).rows[0].payload.quality.state,
    ).toBe("observed_no_known_gap");
    // The late trade does not regress the current trade projection's source time.
    expect(
      (await view(start + 920_000)).latest.find(
        (r) => r.payload.channel === "trades",
      )!.payload.source_timestamp,
    ).toBe(iso(start + 10_000));
  }, 20_000);
  it("revises a previously observed bar when a delayed health report reveals a gap", async () => {
    await observedWindow();
    const input = batch(start + 920_000, []);
    input.health.gaps.push({
      epoch: 1,
      channel: "trades",
      reason: "out_of_order",
      detected_at: start + 920_000,
      after_source_at: start + 1000,
      resumed_at: null,
      recovery: "pending",
    });
    input.health.counters.gaps = 1;
    await capture(input);
    expect(
      (await view(start + 920_000)).bars[0]!.payload.quality.reasons,
    ).toContain("late_gap");
  }, 20_000);
  it("pins the actual input closure and does not pin every ordinary bar forever", async () => {
    await capture(batch());
    await capture(batch(start + 3_610_000, [], "restart"));
    await close(start + 3_610_000);
    const bar = (await view(start + 3_610_000)).bars.find(
      (r) => r.payload.trade_count === 1,
    )!;
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM btc_retention_pins",
        )
      ).rows[0].n,
    ).toBe(0);
    await pinBtcMarketInputs(pool, "replay", [bar.object_id], "replay inputs");
    await pinBtcMarketInputs(pool, "replay", [bar.object_id], "replay inputs");
    await fixture.pool.query("UPDATE btc_retention_policy SET hold=false");
    for (let i = 0; i < 4; i++) await prune();
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM btc_retention_pins",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM btc_market_records WHERE kind='trades'",
        )
      ).rows[0].n,
    ).toBe(1);
    const closure = await fixture.pool.query(
      `WITH RECURSIVE refs(id) AS (SELECT $1::text UNION SELECT d.dependency_id FROM btc_retention_dependencies d JOIN refs r ON r.id=d.object_id) SELECT count(*)::int n FROM refs`,
      [bar.object_id],
    );
    expect(closure.rows[0].n).toBeGreaterThanOrEqual(4);
    await expect(
      fixture.pool.query(
        "DELETE FROM btc_retention_objects WHERE object_id=$1",
        [bar.object_id],
      ),
    ).rejects.toThrow("PROTECTED");
  });
  it("prunes only unpinned expired BTC evidence/projections and keeps a restart cursor", async () => {
    await capture(batch());
    await capture(batch(start + 3_610_000, [], "restart"));
    await close(start + 3_610_000);
    await fixture.pool.query("UPDATE btc_retention_policy SET hold=false");
    for (let i = 0; i < 5; i++) await prune();
    expect(await counts()).toMatchObject({
      objects: 0,
      records: 0,
      bars: 0,
      raw: "0",
      total: "0",
    });
    expect(
      (await fixture.pool.query("SELECT metadata_id FROM btc_market_head"))
        .rows[0].metadata_id,
    ).toBeNull();
    await capture(batch(start + 3_620_000, [], "new-process"));
    expect((await counts()).objects).toBe(2);
  });
  it("persists context without fabricating a source timestamp or zero funding", async () => {
    const event = {
      ...normalizeHyperliquidFeed(
        "context",
        {
          coin: "BTC",
          ctx: {
            markPx: "64000.1",
            oraclePx: "63999.2",
            funding: "-0.00000123456789",
          },
        },
        iso(start + 1000),
        metadata.instrument.instrument_version,
        "context-1",
      )[0]!,
      quality: "unknown" as const,
      gap_epoch: 1,
      revalidation: "current_state_only" as const,
      continuity: "unproven" as const,
    };
    await capture(batch(start + 1000, [event]));
    const stored = (await view()).latest[0]!.payload;
    expect(stored.source_timestamp).toBeNull();
    expect(stored.quality).toBe("unknown");
    expect(stored.payload).toEqual(event.payload);
  });
  it("cannot claim warmup after a restart or long capture silence", async () => {
    await capture(batch());
    await capture(batch(start + 910_000, [], "restart"));
    await close(start + 910_000);
    const result = await view();
    expect(result.warmup.ready).toBe(false);
    expect(result.bars[0]!.payload.quality.reasons).toEqual(
      expect.arrayContaining([
        "restart",
        "capture_silence",
        "warmup_incomplete",
      ]),
    );
  });
  it("assigns boundary trades once in SQL and forms the independent 1h projection", async () => {
    await capture(batch(start, [trade(start)]));
    await capture(batch(start + 900_000, [trade(start + 900_000, 2)]));
    await capture(batch(start + 3_610_000, []));
    await close(start + 3_610_000);
    const bars = (
      await fixture.pool.query(
        "SELECT b.interval_ms,b.start_at,o.payload FROM btc_market_bars b JOIN btc_retention_objects o USING(object_id) ORDER BY b.interval_ms,b.start_at",
      )
    ).rows;
    expect(
      bars
        .filter((b) => b.interval_ms === 900_000)
        .map((b) => b.payload.trade_count),
    ).toEqual([1, 1, 0, 0]);
    expect(
      bars.find((b) => b.interval_ms === 3_600_000).payload.trade_count,
    ).toBe(2);
    expect(bars[0].start_at.toISOString()).toBe(iso(start));
  });
  it("uses indexes for bounded interface lookups", async () => {
    await capture(batch());
    await pool.transaction(async (tx) => {
      await tx.query("SET LOCAL enable_seqscan=off");
      const bars = await tx.query(
        "EXPLAIN (FORMAT JSON) SELECT object_id FROM btc_market_bars WHERE interval_ms=900000 ORDER BY start_at DESC LIMIT 20",
      );
      const latest = await tx.query(
        "EXPLAIN (FORMAT JSON) SELECT object_id FROM btc_market_records WHERE kind='trades' ORDER BY source_at DESC LIMIT 1",
      );
      expect(JSON.stringify(bars.rows)).toContain("btc_market_bars_pkey");
      expect(JSON.stringify(latest.rows)).toContain("btc_market_source");
    });
  });
  it("validates admission and batch conflicts before changing committed evidence", async () => {
    await capture(batch());
    const before = await counts();
    await expect(
      capture({ ...batch(), sessionId: "x".repeat(129) }),
    ).rejects.toThrow("INVALID_BATCH");
    await expect(
      capture({
        ...batch(),
        events: Array.from({ length: 513 }, () => trade()),
      }),
    ).rejects.toThrow("INVALID_BATCH");
    await expect(capture(batch(start + 1000, []))).rejects.toThrow(
      "CAPTURE_CONFLICT",
    );
    await expect(capture(batch(start + 999, []))).rejects.toThrow(
      "CAPTURE_ORDER",
    );
    await expect(
      capture(batch(start + 2000, [{ ...trade(), payload_hash: "bad" }])),
    ).rejects.toThrow("INVALID_EVENT");
    expect(await counts()).toEqual(before);
  });
});
