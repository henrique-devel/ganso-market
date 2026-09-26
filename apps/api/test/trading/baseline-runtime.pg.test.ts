import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { hashToken } from "../../src/auth/tokens.js";
import {
  previewDeskCommand,
  acceptDeskCommand,
} from "../../src/storage/desk-commandstore.js";
import { registerTradingReadRoutes } from "../../src/trading-readapi.js";
import { readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import { acceptanceFixture } from "./acceptance-fixture.js";
import { fixture, tick, T, AT, px } from "./baseline-fixture.js";
import {
  baselineHash,
  baselineIso,
  baselineEnvironment,
  type BaselineRegistration,
} from "../../src/storage/baseline-inputs.js";
import { baselineEnvironmentTx } from "../../src/storage/baseline-store.js";
import { parseHyperliquidBtcMetadata } from "../../src/venues/hyperliquid/metadata.js";
import { activateBaseline } from "../../src/baseline-activate-cli.js";
import { consumeBaselineAccount } from "../../src/storage/baseline-runtime.js";
import { fundDeskAccount } from "../../src/storage/desk-consumer.js";
import {
  storeRetentionObjectTx,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
import {
  readLedgerAccount,
  createLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import { identity, iso } from "./ledger-fixture.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { applyRisk, riskTransaction } from "../../src/storage/riskstore.js";
import { withDeskWorker } from "../../src/storage/desk-worker.js";

const url = process.env.GANSO_TEST_DATABASE_URL;
const manifest = readFileSync(
  new URL("../../../../config/trading/baseline.json", import.meta.url),
  "utf8",
);
const contract = readFileSync(
  new URL(
    "../../../../docs/contracts/btc-baseline-manifest-v1.md",
    import.meta.url,
  ),
  "utf8",
);
let f: Awaited<ReturnType<typeof acceptanceFixture>>, now: number;
let pool: Pick<DatabasePool, "transaction" | "readOnly">,
  r: BaselineRegistration;
let input: ReturnType<typeof fixture>;
let measurements: { sql: string; ms: number }[] | null = null;
async function renewedMetadata(
  mutate = (_m: ReturnType<typeof parseHyperliquidBtcMetadata>) => {},
  received = now,
  recorded = received,
) {
  const payload = parseHyperliquidBtcMetadata(
    {
      universe: [
        { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 40 },
        { name: "ETH", szDecimals: 4, maxLeverage: 20, marginTableId: 20 },
      ],
      marginTables: [],
      collateralToken: 0,
    },
    iso(received),
  );
  mutate(payload);
  const id = `btc-market:metadata:${baselineHash(payload)}`;
  await withBtcRetentionTransaction(pool, async (tx) => {
    await storeRetentionObjectTx(tx, {
      id,
      class: "raw",
      identity: r.scope,
      recordedAt: new Date(recorded),
      payload,
      dependencies: [],
    });
    await tx.query(
      "INSERT INTO btc_market_records(object_id,kind,received_at) VALUES($1,'metadata',$2)",
      [id, iso(received)],
    );
  });
  return id;
}
async function environment() {
  const row = (
    await f.pool.query(
      "SELECT registration,evidence_id,true AS enabled FROM btc_baseline_registrations WHERE account_id='baseline'",
    )
  ).rows[0];
  return withDeskWorker(pool, "baseline", (w) =>
    riskTransaction(w, r.scope, (tx) => baselineEnvironmentTx(tx, row), true),
  );
}
const makeWorker = () => {
  const w = f.worker();
  const transaction = w.pool.transaction.bind(w.pool);
  w.pool.transaction = (run) =>
    transaction((tx) =>
      run({
        query: async (sql, params) => {
          const start = performance.now();
          try {
            return await tx.query(sql, params);
          } finally {
            measurements?.push({
              sql: sql.slice(0, 160),
              ms: performance.now() - start,
            });
          }
        },
      }),
    );
  return Object.assign(w.pool, {
    readOnly: <U>(_ms: number, run: (tx: SqlExecutor) => Promise<U>) =>
      w.pool.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        return run(tx);
      }),
  });
};
async function market(
  depth = "10000000",
  bid?: number,
  kinds = ["book", "context", "capture"],
) {
  tick(input, now);
  const book = input.market.book!.payload.payload;
  if (book.kind !== "book") throw new Error("fixture");
  for (const l of [...book.bids, ...book.asks])
    Object.assign(l.quantity, { raw: depth });
  if (bid !== undefined) {
    Object.assign(book.bids[0]!.price, { raw: px(bid) });
    Object.assign(book.asks[0]!.price, { raw: px(bid + 20) });
  }
  await withBtcRetentionTransaction(pool, async (tx) => {
    for (const [kind, row] of Object.entries(input.market)) {
      if (!row || !kinds.includes(kind)) continue;
      const id = `test:${kind}:${now}`;
      await storeRetentionObjectTx(tx, {
        id,
        class: "raw",
        identity: r.scope,
        recordedAt: new Date(now),
        payload: row.payload,
        dependencies: [],
      });
      await tx.query(
        "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$4)",
        [id, kind, kind === "context" ? null : iso(now), iso(now)],
      );
    }
  });
}
async function seedBars(
  direction: "long" | "short" | "neutral" = "long",
  gap = false,
) {
  const data = fixture(direction);
  await withBtcRetentionTransaction(pool, async (tx) => {
    for (const set of [data.hours, data.quarters])
      for (const row of set.records) {
        if (gap && row === data.hours.records[0])
          row.payload.quality = {
            state: "incomplete",
            reasons: ["capture_gap"],
            continuity: "unproven",
          };
        for (const id of row.payload.input_ids)
          await storeRetentionObjectTx(tx, {
            id,
            class: "raw",
            identity: r.scope,
            recordedAt: new Date(row.recorded_at),
            payload: { synthetic_test_only: true },
            dependencies: [],
          });
        await storeRetentionObjectTx(tx, {
          id: row.object_id,
          class: "bar",
          identity: r.scope,
          recordedAt: new Date(row.recorded_at),
          payload: row.payload,
          dependencies: row.payload.input_ids,
        });
        await tx.query(
          "INSERT INTO btc_market_bars(interval_ms,start_at,end_at,object_id) VALUES($1,$2,$3,$4)",
          [
            row.payload.interval_ms,
            row.payload.start_at,
            row.payload.end_at,
            row.object_id,
          ],
        );
      }
  });
}
const step = async (ms = 1100, depth = "10000000", bid?: number) => {
  now += ms;
  vi.setSystemTime(now);
  await market(depth, bid);
  await consumeBaselineAccount(pool, "baseline");
};
const decisions = async () =>
  (
    await f.pool.query(
      "SELECT decision FROM btc_baseline_decisions ORDER BY bar_end_at",
    )
  ).rows.map((x) => x.decision);
const ledger = () => readLedgerAccount(pool, r.scope);
const orders = async () =>
  (
    await f.pool.query(
      "SELECT reservation FROM btc_desk_orders WHERE account_id='baseline' ORDER BY order_id",
    )
  ).rows.map((x) => x.reservation);
describe.skipIf(!url)(
  "baseline prospective paper runtime on disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      now = T - 1000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      f = await acceptanceFixture(url, () => now, true);
      pool = makeWorker();
      input = fixture();
      await f.pool.query(
        "INSERT INTO auth_accounts(username,password_hash) VALUES('baseline-owner','fixture-only')",
      );
      await withBtcRetentionTransaction(pool, async (tx) => {
        const meta = input.metadata!;
        await storeRetentionObjectTx(tx, {
          id: meta.object_id,
          class: "raw",
          identity: input.registration.scope,
          recordedAt: new Date(meta.recorded_at),
          payload: meta.payload,
          dependencies: [],
        });
        await tx.query(
          "INSERT INTO btc_market_records(object_id,kind,received_at) VALUES($1,'metadata',$2)",
          [meta.object_id, meta.recorded_at],
        );
      });
      r = (
        await activateBaseline(
          pool,
          "baseline-owner",
          "b".repeat(40),
          manifest,
          contract,
        )
      ).registration;
      await createLedgerAccount(pool, identity());
      now = T;
      vi.setSystemTime(now);
      await consumeBaselineAccount(pool, "baseline");
      now = AT;
      vi.setSystemTime(now);
      await market();
      await fundDeskAccount(pool, "baseline", async (hour) => ({
        source: "hyperliquid:mainnet:fundingHistory",
        received_at: iso(now),
        rows: [
          {
            coin: "BTC",
            time: Date.parse(hour),
            fundingRate: "0.0001",
            premium: "0",
          },
        ],
      }));
    });
    afterEach(async () => {
      vi.useRealTimers();
      await f?.dispose();
    });
    it("freezes activation/start/owner/metadata, preserves unique independent genesis and refuses mutations", async () => {
      expect(r.start_at).toBe(baselineIso(T));
      const again = await activateBaseline(
        pool,
        "baseline-owner",
        "c".repeat(40),
        manifest,
        contract,
      );
      expect(again).toEqual({ status: "duplicate", registration: r });
      expect((await ledger()).events).toHaveLength(1);
      expect((await ledger()).projection.cash_usd_raw).toBe("1000000000");
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM btc_ledger_events WHERE account_id='manual'",
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        f.pool.query(
          "UPDATE btc_baseline_registrations SET registration='{}'::jsonb",
        ),
      ).rejects.toThrow();
      await expect(
        f.pool.query("TRUNCATE btc_baseline_events"),
      ).rejects.toThrow();
    });
    it("uses the registered full metadata hash after a real parser refresh and pins both observations without rewriting replay", async () => {
      await seedBars();
      const latest = await renewedMetadata();
      expect(latest).not.toBe(input.metadata!.object_id);
      await consumeBaselineAccount(pool, "baseline");
      const before = await decisions();
      expect(before[0].state).toBe("candidate_long");
      expect(before[0].input_refs).toContainEqual(
        expect.objectContaining({
          object_id: input.metadata!.object_id,
          payload_hash: r.metadata_hash,
        }),
      );
      const source = (
        await f.pool.query(
          "SELECT payload,dependencies FROM btc_retention_objects WHERE object_id LIKE 'baseline-account:%:source' ORDER BY recorded_at LIMIT 1",
        )
      ).rows[0];
      expect(source.payload.metadata_validation).toEqual({
        registered_id: input.metadata!.object_id,
        observed_id: latest,
        compatible: true,
      });
      expect(source.dependencies).toEqual(
        expect.arrayContaining([input.metadata!.object_id, latest]),
      );
      expect(
        (
          await f.pool.query(
            "SELECT registration FROM btc_baseline_registrations",
          )
        ).rows[0].registration,
      ).toEqual(r);
      await f.pool.query(
        "UPDATE btc_recovery_heads SET lease_until=$1 WHERE account_id='baseline'",
        [iso(now - 1000)],
      );
      pool = makeWorker();
      await consumeBaselineAccount(pool, "baseline");
      expect(await decisions()).toEqual(before);
      expect(await orders()).toHaveLength(1);
    });
    it.each(["parser_revision", "version", "fees", "tick", "future_record"])(
      "refuses %s metadata instead of falling back to the frozen snapshot",
      async (kind) => {
        await seedBars();
        await renewedMetadata(
          (m) => {
            if (kind === "parser_revision")
              Object.assign(
                m,
                parseHyperliquidBtcMetadata(
                  {
                    universe: [
                      {
                        name: "BTC",
                        szDecimals: 4,
                        maxLeverage: 40,
                        marginTableId: 40,
                      },
                    ],
                    marginTables: [],
                    collateralToken: 0,
                  },
                  iso(now),
                ),
              );
            if (kind === "version")
              Object.assign(m.instrument, {
                instrument_version: "revised-instrument",
              });
            if (kind === "fees") Object.assign(m.fees.taker, { raw: "500000" });
            if (kind === "tick")
              Object.assign(m.instrument.tick_size, { raw: "100" });
          },
          now,
          kind === "future_record" ? now + 1 : now,
        );
        await consumeBaselineAccount(pool, "baseline");
        expect((await decisions())[0].reasons).toContain(
          "metadata_unavailable",
        );
        expect(await orders()).toHaveLength(0);
      },
    );
    it("ignores metadata received after the decision cutoff", async () => {
      await seedBars();
      await renewedMetadata(
        (m) => Object.assign(m.fees.taker, { raw: "500000" }),
        now + 1,
      );
      await consumeBaselineAccount(pool, "baseline");
      expect((await decisions())[0].state).toBe("candidate_long");
    });
    it("defers a prepared decision when a collector quality revision changes a bar before the writer fence", async () => {
      await seedBars();
      let injected = false;
      const read = pool.readOnly.bind(pool);
      pool.readOnly = async (ms, run) => {
        const value = await read(ms, run);
        if (
          !injected &&
          value &&
          typeof value === "object" &&
          "quarters" in value
        ) {
          injected = true;
          const old = input.quarters.records[0]!,
            id = `revised:${old.object_id}`;
          const payload = {
            ...old.payload,
            input_ids: [old.object_id],
            quality: {
              state: "incomplete",
              reasons: ["capture_gap"],
              continuity: "unproven",
            },
          };
          await withBtcRetentionTransaction(pool, async (tx) => {
            await storeRetentionObjectTx(tx, {
              id,
              class: "bar",
              identity: r.scope,
              recordedAt: new Date(now),
              payload,
              dependencies: [old.object_id],
            });
            await tx.query(
              "UPDATE btc_market_bars SET object_id=$1 WHERE object_id=$2",
              [id, old.object_id],
            );
          });
        }
        return value;
      };
      await consumeBaselineAccount(pool, "baseline");
      expect(injected).toBe(true);
      expect(await decisions()).toHaveLength(0);
      expect(await orders()).toHaveLength(0);
      await consumeBaselineAccount(pool, "baseline");
      expect((await decisions())[0].state).toBe("data_unavailable");
      expect(await orders()).toHaveLength(0);
    });
    it("preserves the observed stale-book/context veto and requires explicit valid rearm even after fresh evidence returns", async () => {
      await seedBars();
      // Exercise the same stale gates recorded by the production decision.
      const selected = (
        await f.pool.query(
          "SELECT kind,object_id FROM btc_market_records WHERE kind IN ('book','context')",
        )
      ).rows;
      // Keep immutable receipts; a later clock makes these observations stale.
      expect(selected).toHaveLength(2);
      now += 5652;
      vi.setSystemTime(now);
      await consumeBaselineAccount(pool, "baseline");
      const first = await decisions();
      expect(first[0].reasons).toEqual(
        expect.arrayContaining([
          "book_unavailable",
          "context_unavailable",
          "risk_pause",
        ]),
      );
      await market();
      const paused = await environment();
      expect(paused.observed.checkpoint.state).toBe("REDUCE_ONLY");
      expect(baselineEnvironment(paused.env, now).causes).toEqual([]);
      expect(paused.observed.bookFresh).toBe(true);
      expect(paused.observed.markFresh).toBe(true);
      await withDeskWorker(pool, "baseline", (w) =>
        applyRisk(w, r.scope, {
          action: "rearm",
          operation_id: "explicit-test-rearm",
          reason: "eligible retained inputs in disposable test",
        }),
      );
      const rearmed = await environment();
      expect(rearmed.observed.checkpoint.state).toBe("NORMAL");
      expect(baselineEnvironment(rearmed.env, now).causes).not.toContain(
        "risk_pause",
      );
      await consumeBaselineAccount(pool, "baseline");
      expect(await decisions()).toEqual(first);
      expect(await orders()).toHaveLength(0);
    });
    it.each([
      ["book", 2000, true],
      ["book", 2001, false],
      ["context", 5000, true],
      ["context", 5001, false],
    ] as const)(
      "keeps the %s freshness boundary at %dms",
      async (kind, age, fresh) => {
        now += age;
        vi.setSystemTime(now);
        if (kind === "context")
          await market("10000000", undefined, ["book", "capture"]);
        const s = await environment();
        expect(
          kind === "book" ? s.observed.bookFresh : s.observed.markFresh,
        ).toBe(fresh);
        expect(
          baselineEnvironment(s.env, now).causes.includes(
            `${kind}_unavailable`,
          ),
        ).toBe(!fresh);
      },
    );
    it("keeps a representative retained-bar decision and owner restart compatible with a concurrent collector capacity probe", async () => {
      const data = fixture("neutral"),
        n = 320;
      // 27 bars x 320 immutable inputs = 8,640 inputs, comparable to the 8,151
      // refs in the first production decision. Real guards/FKs/HOLD remain on.
      await pool.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(741044,4)");
        for (const set of [data.hours, data.quarters])
          for (const row of set.records) {
            row.payload.input_ids = Array.from(
              { length: n },
              (_, i) => `volume:${row.object_id}:${i}`,
            );
            await tx.query(
              `INSERT INTO btc_retention_objects(object_id,dataset_id,policy_version,class,identity,recorded_at,payload,dependencies,charged_bytes)
            SELECT id,'btc-paper-v1','btc-retention-v1','raw',$2::jsonb,$3::timestamptz,$4::jsonb,'{}',1 FROM unnest($1::text[]) id`,
              [
                row.payload.input_ids,
                JSON.stringify(r.scope),
                row.recorded_at,
                JSON.stringify({
                  synthetic_test_only: true,
                  book: input.market.book!.payload,
                  context: input.market.context!.payload,
                  capture: input.market.capture!.payload,
                }),
              ],
            );
            await storeRetentionObjectTx(tx, {
              id: row.object_id,
              class: "bar",
              identity: r.scope,
              recordedAt: new Date(row.recorded_at),
              payload: row.payload,
              dependencies: row.payload.input_ids,
            });
            await tx.query(
              "INSERT INTO btc_market_bars(interval_ms,start_at,end_at,object_id) VALUES($1,$2,$3,$4)",
              [
                row.payload.interval_ms,
                row.payload.start_at,
                row.payload.end_at,
                row.object_id,
              ],
            );
          }
      });
      const collector = makeWorker();
      measurements = [];
      let finished = false,
        probes = 0,
        longestProbeMs = 0;
      let probeError: unknown = null;
      const probe = (async () => {
        while (!finished) {
          const start = performance.now();
          await withBtcRetentionTransaction(collector, (tx) =>
            tx.query(
              "SELECT raw_bytes,total_bytes,hold FROM btc_retention_policy",
            ),
          );
          longestProbeMs = Math.max(longestProbeMs, performance.now() - start);
          probes++;
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      })().catch((e) => {
        probeError = e;
      });
      let decisionMs = 0,
        restartMs = 0;
      try {
        let start = performance.now();
        await consumeBaselineAccount(pool, "baseline");
        decisionMs = performance.now() - start;
        await f.pool.query(
          "UPDATE btc_recovery_heads SET lease_until=$1 WHERE account_id='baseline'",
          [iso(now - 1000)],
        );
        pool = makeWorker();
        start = performance.now();
        await consumeBaselineAccount(pool, "baseline");
        await withDeskWorker(pool, "manual", (worker) =>
          riskTransaction(
            worker,
            ledgerScope(identity()),
            async () => null,
            true,
          ),
        );
        restartMs = performance.now() - start;
      } finally {
        finished = true;
        await probe;
        if (process.env.GANSO_BASELINE_MEASURE)
          console.log(
            JSON.stringify({
              decisionMs,
              restartMs,
              slow: measurements.sort((a, b) => b.ms - a.ms).slice(0, 15),
            }),
          );
        measurements = null;
      }
      expect(probeError).toBe(null);
      expect(probes).toBeGreaterThan(0);
      expect((await decisions())[0].state).toBe("neutral");
      expect(await decisions()).toHaveLength(1);
      expect(await orders()).toHaveLength(0);
      const missing = (
        await f.pool.query(`WITH RECURSIVE protected(object_id) AS (
        SELECT evidence_id FROM btc_baseline_decisions WHERE account_id='baseline'
        UNION SELECT d.dependency_id FROM btc_retention_dependencies d JOIN protected p USING(object_id)
      ) SELECT count(*)::int n FROM (
        SELECT ref->>'object_id' AS object_id FROM btc_baseline_decisions b CROSS JOIN LATERAL jsonb_array_elements(b.decision->'input_refs') ref WHERE account_id='baseline'
        EXCEPT SELECT object_id FROM protected) missing`)
      ).rows[0].n;
      expect(missing).toBe(0);
      if (process.env.GANSO_BASELINE_MEASURE)
        console.log(
          JSON.stringify({
            inputs: 27 * n,
            decisionMs,
            restartMs,
            longestProbeMs,
            probes,
          }),
        );
    }, 30000);
    it.each(["neutral", "gap", "absent"])(
      "persists %s skip without orders and repeated polling returns first result",
      async (kind) => {
        if (kind !== "absent")
          await seedBars(
            kind === "neutral" ? "neutral" : "long",
            kind === "gap",
          );
        await consumeBaselineAccount(pool, "baseline");
        const before = await decisions();
        expect(before).toHaveLength(1);
        expect(before[0].state).toBe(
          kind === "neutral" ? "neutral" : "data_unavailable",
        );
        await Promise.all([
          consumeBaselineAccount(pool, "baseline"),
          consumeBaselineAccount(pool, "baseline"),
        ]);
        expect(await decisions()).toEqual(before);
        expect(await orders()).toHaveLength(0);
      },
    );
    it.each(["long", "short"] as const)(
      "%s candidate reserves once, waits for later book, fills partially, exits while paused and survives restart",
      async (direction) => {
        await seedBars(direction);
        await Promise.all([
          consumeBaselineAccount(pool, "baseline"),
          consumeBaselineAccount(pool, "baseline"),
        ]);
        expect((await decisions())[0].state).toBe(`candidate_${direction}`);
        expect(await orders()).toHaveLength(1);
        await step(500);
        expect(
          (await ledger()).events.filter(
            (e) => e.payload.event_type === "fill",
          ),
        ).toHaveLength(0);
        await step(601, "100000");
        expect((await ledger()).projection.positions[0]!.quantity_btc_raw).toBe(
          direction === "long" ? "100000" : "-100000",
        );
        expect((await orders())[0].status).toBe("cancelled");
        const memory = (
          await f.pool.query(
            "SELECT payload FROM btc_baseline_events WHERE kind='position' ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0].payload;
        expect(memory.position.opened_at).toBe(iso(now));
        await withDeskWorker(pool, "baseline", (worker) =>
          applyRisk(worker, r.scope, {
            action: "reduce_only",
            operation_id: "operator-pause",
            reason: "test operator pause",
          }),
        );
        await step(100, "50000");
        expect(
          (await orders()).filter((x) => x.order.intent === "reduce"),
        ).toHaveLength(1);
        await step(1100, "50000");
        expect((await ledger()).projection.positions[0]!.quantity_btc_raw).toBe(
          direction === "long" ? "50000" : "-50000",
        );
        // Retire the old worker as a process restart would; the new fenced owner
        // reconstructs ledger, consumes old entry and cancels in-flight reduction.
        await f.pool.query(
          "UPDATE btc_recovery_heads SET lease_until=$1 WHERE account_id='baseline'",
          [iso(now - 1000)],
        );
        pool = makeWorker();
        await step(1100, "50000");
        await step(1100, "50000");
        expect((await ledger()).projection.positions[0]!.quantity_btc_raw).toBe(
          "0",
        );
        expect((await decisions())[0].state).toBe(`candidate_${direction}`);
        expect(
          (await orders()).filter((x) => x.order.intent === "open"),
        ).toHaveLength(1);
        const closed = (
          await f.pool.query(
            "SELECT payload FROM btc_baseline_events WHERE kind='position' ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0].payload;
        expect(closed.state).toBe("closed");
        expect(closed.position.deadline).toBe(memory.position.deadline);
        expect(
          (
            await f.pool.query(
              "SELECT checkpoint->>'state' AS state FROM btc_risk_events WHERE account_id='baseline' ORDER BY sequence DESC LIMIT 1",
            )
          ).rows[0].state,
        ).toBe("REDUCE_ONLY");
      },
    );
    it("restart after reservation expires the consumed signal and cannot reopen it", async () => {
      await seedBars();
      await consumeBaselineAccount(pool, "baseline");
      const before = await decisions();
      await f.pool.query(
        "UPDATE btc_recovery_heads SET lease_until=$1 WHERE account_id='baseline'",
        [iso(now - 1000)],
      );
      pool = makeWorker();
      await step(6000);
      expect(await decisions()).toEqual(before);
      expect(await orders()).toHaveLength(1);
      expect((await orders())[0].status).toBe("expired");
      expect((await ledger()).events).toHaveLength(1);
    });
    it("price drift vetoes execution without resizing or replacing the candidate", async () => {
      await seedBars();
      await consumeBaselineAccount(pool, "baseline");
      await step(1100, "10000000", 100200);
      expect((await ledger()).events).toHaveLength(1);
      expect((await orders())[0].status).toBe("cancelled");
      expect(
        (
          await f.pool.query(
            "SELECT payload FROM btc_baseline_events WHERE kind='execution'",
          )
        ).rows[0].payload.validation.reasons,
      ).toContain("price_protection");
      await step();
      expect(await orders()).toHaveLength(1);
    });
    it("records missed windows at the current clock without replaying entries", async () => {
      await seedBars();
      now = T + 2 * 900000 + 70000;
      vi.setSystemTime(now);
      await market();
      await consumeBaselineAccount(pool, "baseline");
      await consumeBaselineAccount(pool, "baseline");
      await consumeBaselineAccount(pool, "baseline");
      expect(await decisions()).toHaveLength(3);
      expect(
        (await decisions()).every(
          (x) =>
            x.state === "missed_decision_window" && x.decision_at === iso(now),
        ),
      ).toBe(true);
      expect(await orders()).toHaveLength(0);
    });
    it("authenticated baseline pause is isolated from manual tickets and the read model explains its decision", async () => {
      await seedBars();
      const session = randomUUID();
      const owner = (
        await f.pool.query(
          "SELECT account_id FROM auth_accounts WHERE username='baseline-owner'",
        )
      ).rows[0].account_id;
      await f.pool.query(
        "INSERT INTO auth_sessions(session_id,account_id) VALUES($1,$2)",
        [session, owner],
      );
      await f.pool.query(
        "INSERT INTO auth_access_tokens(token_hash,session_id,issued_at,expires_at) VALUES($1,$2,$3::timestamptz-interval '1 minute',$3)",
        [hashToken("baseline-token"), session, iso(now + 60000)],
      );
      const cmd = { account_id: "baseline", action: "pause" as const };
      const p = await previewDeskCommand(
        pool,
        "baseline-token",
        cmd,
        "pause-base",
      );
      expect(
        (
          await acceptDeskCommand(
            pool,
            "baseline-token",
            "pause",
            p.intent,
            "pause-base",
          )
        ).status,
      ).toBe("entries_paused");
      await expect(
        previewDeskCommand(
          pool,
          "baseline-token",
          { account_id: "baseline", action: "cancel", order_id: "x" },
          "no-manual-order",
        ),
      ).rejects.toMatchObject({ code: "TRADING_PAPER_MANUAL_REQUIRED" });
      await consumeBaselineAccount(pool, "baseline");
      expect((await decisions())[0].state).toBe("rejected");
      expect((await decisions())[0].reasons).toContain("risk_pause");
      const app = Fastify();
      registerTradingReadRoutes(app, {
        pool,
        authService: { session: async () => ({ status: "ok" }) },
        clock: () => new Date(now),
      });
      try {
        const res = await app.inject({
          url: "/trading/account?account_id=baseline",
          headers: { authorization: "Bearer baseline-token" },
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().baseline).toMatchObject({
          start_at: r.start_at,
          decisions: [
            {
              state: "rejected",
              candidate: { direction: "long" },
              order_id: null,
            },
          ],
        });
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int n FROM btc_desk_commands WHERE account_id='manual'",
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await app.close();
      }
    });
    it.each(["stop", "max_holding"])(
      "persists %s exit without admitting another entry",
      async (reason) => {
        await seedBars();
        await consumeBaselineAccount(pool, "baseline");
        await step(1100, "100000");
        if (reason === "stop") await step(1100, "100000", 98990);
        else {
          now += 21600000;
          vi.setSystemTime(now);
          await consumeBaselineAccount(pool, "baseline");
        }
        let exit = (
          await f.pool.query(
            "SELECT payload FROM btc_baseline_events WHERE kind='position' ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0].payload;
        expect(exit.position.reasons).toContain(reason);
        if (reason === "max_holding") {
          expect(exit.state).toBe("exit_pending");
          await step(1100, "100000");
        }
        await step(1100, "100000");
        expect((await ledger()).projection.positions[0]!.quantity_btc_raw).toBe(
          "0",
        );
        exit = (
          await f.pool.query(
            "SELECT payload FROM btc_baseline_events WHERE kind='position' ORDER BY sequence DESC LIMIT 1",
          )
        ).rows[0].payload;
        expect(exit.state).toBe("closed");
        expect(exit.position.reasons).toContain(reason);
        expect(
          (await orders()).filter((x) => x.order.intent === "open"),
        ).toHaveLength(1);
      },
    );
  },
);
