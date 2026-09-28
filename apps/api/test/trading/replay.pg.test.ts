import { windowFixture } from "./replay-pages-fixture.js";
import { replayPages } from "../../src/storage/replay-pages.js";
import { canonicalFingerprint } from "../../src/trading/replay.js";
import type { QueryResultRow } from "pg";
import { usd } from "./ledger-fixture.js";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { identity, command, fill, iso, start } from "./ledger-fixture.js";
import {
  createLedgerAccount,
  appendLedgerBatchTx,
} from "../../src/storage/ledgerstore.js";
import { decideBaseline } from "../../src/storage/baseline-policy.js";
import { fixture as baselineFixture, AT, T } from "./baseline-fixture.js";
import { ledgerScope, replayLedger } from "../../src/trading/ledger.js";
import {
  loadReplayWindowEvidence,
  captureReplayWindow,
  loadReplayManifest,
  loadReplayPage,
  captureReplayDataset,
  loadReplayDataset,
  loadReplayEvidence,
} from "../../src/storage/replaystore.js";
import { replayDataset } from "../../src/storage/replay-dataset.js";
import {
  storeRetentionObject,
  pinRetentionObject,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof createPgFixture>>;
const pool: Pick<DatabasePool, "transaction" | "readOnly"> = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const c = await f.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await run({
        async query(sql, params) {
          const r = await c.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
  async readOnly<T>(_ms: number, run: (tx: SqlExecutor) => Promise<T>) {
    return this.transaction(run);
  },
};
describe.skipIf(!url)("replay dataset on disposable PostgreSQL", () => {
  beforeEach(async () => {
    f = await createPgFixture(url);
    await createLedgerAccount(pool, identity());
  });
  afterEach(async () => {
    await f.dispose();
  });
  it("captures 30 days above old limits atomically, exports by stable page after restart and concurrent writes", async () => {
    const d = windowFixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    try {
      await createLedgerAccount(pool, d.identity);
    } finally {
      vi.useRealTimers();
    }
    await f.pool.query(
      "INSERT INTO auth_accounts(username,password_hash) VALUES('owner','fixture-only')",
    );
    await f.pool.query(
      "INSERT INTO btc_desk_controls(account_id,owner_account_id,broker,signing_key) SELECT 'baseline',account_id,'ioc',repeat('a',64) FROM auth_accounts",
    );
    await storeRetentionObject(pool, {
      id: "registration",
      class: "experiment",
      identity: ledgerScope(d.identity),
      recordedAt: new Date(iso(start)),
      payload: d.decisions[0]!.decision.registration,
      dependencies: [],
    });
    await f.pool.query(
      "INSERT INTO btc_baseline_registrations(account_id,registration,evidence_id) VALUES('baseline',$1,'registration')",
      [JSON.stringify(d.decisions[0]!.decision.registration)],
    );
    await pool.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(741044,4)");
      for (let i = 0; i < d.evidence.length; i += 128) {
        await tx.query(
          `INSERT INTO btc_retention_objects(object_id,dataset_id,policy_version,class,identity,recorded_at,payload,dependencies,charged_bytes)
          SELECT x->>'object_id','btc-paper-v1','btc-retention-v1',x->>'class',x->'identity',(x->>'recorded_at')::timestamptz,x->'payload','{}',1 FROM jsonb_array_elements($1::jsonb) x`,
          [JSON.stringify(d.evidence.slice(i, i + 128))],
        );
      }
      await tx.query(
        `INSERT INTO btc_retention_pins(pin_id,object_id,reason) SELECT evidence_id,evidence_id,'fixture' FROM jsonb_to_recordset($1::jsonb) AS x(evidence_id text)`,
        [JSON.stringify(d.decisions)],
      );
      await tx.query(
        `INSERT INTO btc_baseline_decisions(account_id,bar_end_at,decision_id,decision,evidence_id) SELECT 'baseline',(decision->>'bar_end_at')::timestamptz,decision->>'decision_id',decision,evidence_id FROM jsonb_to_recordset($1::jsonb) AS x(decision jsonb,evidence_id text)`,
        [JSON.stringify(d.decisions)],
      );
      await tx.query(
        `INSERT INTO btc_equity_observations(account_id,slot,observed_at,evidence_id) SELECT 'baseline',(payload->>'slot')::timestamptz,(payload->>'observed_at')::timestamptz,object_id FROM btc_retention_objects WHERE object_id LIKE 'observation:%'`,
      );
      const events = d.ledger.slice(1);
      await tx.query(
        `INSERT INTO btc_ledger_transactions(account_id,transaction_id,request) SELECT 'baseline',x->>'transaction_id',jsonb_build_object('transaction_id',x->>'transaction_id') FROM jsonb_array_elements($1::jsonb) x`,
        [JSON.stringify(events)],
      );
      await tx.query(
        `INSERT INTO btc_ledger_events(account_id,experiment_id,instrument_id,instrument_version,sequence,event_id,idempotency_key,transaction_id,event_type,event)
        SELECT x->>'account_id',x->>'experiment_id',x->>'instrument_id',x->>'instrument_version',(x->>'sequence')::bigint,x->>'event_id',x->>'idempotency_key',x->>'transaction_id',x->'payload'->>'event_type',x FROM jsonb_array_elements($1::jsonb) x`,
        [JSON.stringify(events)],
      );
    });
    await f.pool.query(
      "UPDATE btc_ledger_projections SET projection=$1 WHERE account_id='baseline'",
      [JSON.stringify(replayLedger(d.identity, d.ledger))],
    );
    // A real writer queues behind the captured account/retention boundary.
    let writer: Promise<unknown> | undefined,
      queries = 0,
      maxSqlMs = 0;
    const measured: Pick<DatabasePool, "transaction"> = {
      transaction: (run) =>
        pool.transaction((tx) =>
          run({
            query: async <R extends QueryResultRow>(
              sql: string,
              params?: readonly unknown[],
            ) => {
              const t = performance.now(),
                result = await tx.query<R>(sql, params);
              queries++;
              maxSqlMs = Math.max(maxSqlMs, performance.now() - t);
              if (
                !writer &&
                sql.includes("DECLARE replay_batch") &&
                sql.includes("btc_ledger_events")
              )
                writer = pool
                  .transaction(async (locked) => {
                    await locked.query(
                      "SELECT pg_advisory_xact_lock(741044,4)",
                    );
                    return appendLedgerBatchTx(
                      locked,
                      d.identity,
                      {
                        transaction_id: "after-snapshot",
                        events: [
                          command(
                            "after-snapshot",
                            {
                              event_type: "cash",
                              reason: "transfer",
                              delta: usd("1000000"),
                            },
                            ledgerScope(d.identity),
                            start + 31 * 86400000,
                          ),
                        ],
                      },
                      new Date().toISOString(),
                    );
                  })
                  .catch((error) => ({ error }));
              return result;
            },
          }),
        ),
    };
    const t = performance.now();
    const a = await captureReplayWindow(
      measured,
      "baseline",
      "a".repeat(40),
      d.window!,
    );
    const captureMs = performance.now() - t;
    expect(await writer).not.toHaveProperty("error");
    expect(await loadReplayManifest(pool, a.dataset_id)).toEqual(a);
    const first = await loadReplayPage(pool, a.dataset_id, 0);
    expect(await loadReplayPage(pool, a.dataset_id, 0)).toEqual(first);
    async function* exported() {
      for (let i = 0; i < a.manifest.pages.length; i++)
        yield await loadReplayPage(pool, a.dataset_id, i);
    }
    const report = await replayPages(a, exported());
    expect(report.financials.balance_usd_raw).toBe("6909900000");
    expect(report.window).toMatchObject({
      complete: true,
      expected_fifteen_minute_windows: 2880,
      drawdown: { max_usd_raw: "100000000", max_ppm: "99019" },
    });
    expect(report.financials.ledger.last_sequence).toBe(
      String(d.ledger.length),
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM btc_ledger_events WHERE account_id='baseline'",
        )
      ).rows[0].n,
    ).toBe(d.ledger.length + 1);
    await expect(
      f.pool.query("DELETE FROM btc_retention_objects WHERE object_id=$1", [
        a.manifest.pages[0]!.id,
      ]),
    ).rejects.toThrow();
    expect(
      (await f.pool.query("SELECT hold FROM btc_retention_policy")).rows[0]
        .hold,
    ).toBe(true);
    const protectedRows = await f.pool.query(
      `WITH RECURSIVE protected(id) AS (SELECT object_id FROM btc_retention_pins WHERE pin_id=$1 UNION SELECT dependency_id FROM btc_retention_dependencies d JOIN protected p ON d.object_id=p.id) SELECT count(*)::int n FROM protected WHERE id LIKE 'observation:%'`,
      [a.dataset_id],
    );
    expect(protectedRows.rows[0].n).toBe(8641);
    const refIndex = a.manifest.pages.findIndex(
      (p) => p.stream === "retained_refs",
    );
    const refPage = await loadReplayPage(pool, a.dataset_id, refIndex);
    const oid = (refPage.rows[0] as { object_id: string }).object_id;
    expect(
      (await loadReplayWindowEvidence(pool, a.dataset_id, refIndex, oid))
        .object_id,
    ).toBe(oid);
    await expect(
      loadReplayWindowEvidence(pool, a.dataset_id, refIndex, "undeclared"),
    ).rejects.toThrow("EVIDENCE_NOT_DECLARED");
    console.log(
      JSON.stringify({
        fixture: "paged-postgres-30d",
        capture_ms: Math.round(captureMs),
        queries,
        max_sql_ms: Math.round(maxSqlMs),
        bytes: a.manifest.bytes,
        max_page_bytes: Math.max(...a.manifest.pages.map((p) => p.bytes)),
        max_rss_kib: process.resourceUsage().maxRSS,
      }),
    );
    expect(Buffer.byteLength(canonicalFingerprint(a))).toBeLessThan(
      1024 * 1024,
    );
  }, 120000);
  it("rolls back an interrupted export including already written pages", async () => {
    let writes = 0;
    const failing: Pick<DatabasePool, "transaction"> = {
      transaction: (run) =>
        pool.transaction((tx) =>
          run({
            query: async <R extends QueryResultRow>(
              sql: string,
              params?: readonly unknown[],
            ) => {
              if (
                sql.includes("INSERT INTO btc_retention_objects") &&
                ++writes === 2
              )
                throw new Error("fixture_interrupt");
              return tx.query<R>(sql, params);
            },
          }),
        ),
    };
    await expect(
      captureReplayWindow(failing, "manual", "a".repeat(40), {
        start_at: iso(start),
        end_at: iso(start + 900000),
      }),
    ).rejects.toThrow("fixture_interrupt");
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM btc_retention_objects WHERE object_id LIKE 'btc-replay-%'",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("rolls back paged capture at capacity without partial pages or pin", async () => {
    await f.pool.query(
      "UPDATE btc_retention_policy SET total_bytes=6442450944",
    );
    await expect(
      captureReplayWindow(pool, "manual", "a".repeat(40), {
        start_at: iso(start),
        end_at: iso(start + 900000),
      }),
    ).rejects.toThrow("CAPACITY");
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM btc_retention_objects WHERE object_id LIKE 'btc-replay-%' ",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("records exact selected decision IDs without truncating financial history", async () => {
    await createLedgerAccount(pool, identity("baseline"));
    await f.pool.query(
      "INSERT INTO auth_accounts(username,password_hash) VALUES('owner','fixture-only')",
    );
    await f.pool.query(
      "INSERT INTO btc_desk_controls(account_id,owner_account_id,broker,signing_key) SELECT 'baseline',account_id,'ioc',repeat('a',64) FROM auth_accounts",
    );
    const input = baselineFixture();
    const decisions = [
      decideBaseline(input),
      decideBaseline({
        ...input,
        bar_end_at: iso(T + 900000),
        decision_at: iso(AT + 900000),
      }),
    ];
    await storeRetentionObject(pool, {
      id: "registration",
      class: "experiment",
      identity: decisions[0]!.registration.scope,
      recordedAt: new Date(iso(start)),
      payload: decisions[0]!.registration,
      dependencies: [],
    });
    await f.pool.query(
      "INSERT INTO btc_baseline_registrations(account_id,registration,evidence_id) VALUES('baseline',$1,'registration')",
      [JSON.stringify(decisions[0]!.registration)],
    );
    for (const d of decisions) {
      const id = `decision:${d.decision_id}`;
      await storeRetentionObject(pool, {
        id,
        class: "decision",
        identity: d.registration.scope,
        recordedAt: new Date(d.decision_at),
        payload: d,
        dependencies: [],
      });
      await pinRetentionObject(pool, id, id, "replay fixture");
      await f.pool.query(
        "INSERT INTO btc_baseline_decisions(account_id,bar_end_at,decision_id,decision,evidence_id) VALUES('baseline',$1,$2,$3,$4)",
        [
          d.bar_end_at,
          d.decision_id,
          JSON.stringify(
            d === decisions[0]
              ? { ...d, storage_version: "btc.decision-projection.v1" }
              : d,
          ),
          id,
        ],
      );
    }
    await storeRetentionObject(pool, {
      id: input.account.object_id,
      class: "financial",
      identity: decisions[0]!.registration.scope,
      recordedAt: new Date(input.account.recorded_at),
      payload: input.account.payload,
      dependencies: [],
    });
    const paged = await captureReplayWindow(pool, "baseline", "a".repeat(40), {
      start_at: iso(T),
      end_at: iso(T + 900000),
    });
    expect(paged.manifest.counts.decisions).toBe(1);
    const decisionPage = await loadReplayPage(
      pool,
      paged.dataset_id,
      paged.manifest.pages.findIndex((p) => p.stream === "decisions"),
    );
    expect(
      (decisionPage.rows[0] as { decision: { decision_id: string } }).decision
        .decision_id,
    ).toBe(decisions[1]!.decision_id);
    const selected = [decisions[0]!.decision_id];
    const a = await captureReplayDataset(
      pool,
      "baseline",
      "a".repeat(40),
      selected,
    );
    expect(a.dataset.decisions.map((x) => x.decision.decision_id)).toEqual(
      selected,
    );
    expect(replayDataset(a)).toMatchObject({
      decision_selection: { mode: "ids", ids: selected },
      financials: {
        ledger: { last_sequence: "1" },
        balance_usd_raw: "1000000000",
      },
    });
    expect(await loadReplayDataset(pool, a.dataset_id)).toEqual(a);
    const reference = await captureReplayDataset(
      pool,
      "baseline",
      "a".repeat(40),
      selected,
      "references",
    );
    const output = replayDataset(reference);
    expect(output.evidence_mode).toBe("references");
    expect(output.fidelity[0]!.retained_inputs_not_embedded).toBe(1);
    expect(
      reference.dataset.evidence.some(
        (o) => o.object_id === input.account.object_id,
      ),
    ).toBe(false);
    const resolved = await loadReplayEvidence(
      pool,
      reference.dataset_id,
      input.account.object_id,
    );
    expect(resolved.payload).toEqual(input.account.payload);
    expect(resolved.producer_hash_verified).toBe(true);
    await expect(
      loadReplayEvidence(pool, reference.dataset_id, "undeclared"),
    ).rejects.toThrow("EVIDENCE_NOT_DECLARED");
    await expect(
      captureReplayDataset(pool, "baseline", "a".repeat(40), ["f".repeat(64)]),
    ).rejects.toThrow("DECISION_SELECTION_MISSING");
    await expect(
      captureReplayDataset(pool, "baseline", "a".repeat(40), [
        ...selected,
        ...selected,
      ]),
    ).rejects.toThrow("DECISION_SELECTION");
  });
  it("captures, pins, exports and replays a snapshot without rewriting account or activating anything", async () => {
    const a = await captureReplayDataset(pool, "manual", "a".repeat(40));
    expect(replayDataset(a).financials.balance_usd_raw).toBe("1000000000");
    expect(await loadReplayDataset(pool, a.dataset_id)).toEqual(a);
    expect(
      (
        await f.pool.query(
          "SELECT object_id FROM btc_retention_pins WHERE pin_id=$1",
          [a.dataset_id],
        )
      ).rows[0]!.object_id,
    ).toBe(a.dataset_id);
    await withBtcRetentionTransaction(pool, (tx) =>
      appendLedgerBatchTx(
        tx,
        identity(),
        { transaction_id: "later", events: [command("fill", fill())] },
        new Date().toISOString(),
      ),
    );
    expect(
      replayDataset(await loadReplayDataset(pool, a.dataset_id)).financials
        .ledger.last_sequence,
    ).toBe("1");
    expect(
      (await captureReplayDataset(pool, "manual", "a".repeat(40))).dataset
        .ledger,
    ).toHaveLength(2);
    await expect(
      f.pool.query("DELETE FROM btc_retention_objects WHERE object_id=$1", [
        a.dataset_id,
      ]),
    ).rejects.toThrow();
    expect(
      (await f.pool.query("SELECT hold FROM btc_retention_policy")).rows[0]!
        .hold,
    ).toBe(true);
  });
  it("retains complete transitive evidence including old raw and gaps", async () => {
    const scope = ledgerScope(identity());
    for (const [id, deps, payload] of [
      ["raw", [], { gap_epoch: 3, quality: "gap", captured_probability: 0.7 }],
      ["intent", ["raw"], { schema_version: "btc.ioc.v1" }],
    ] as const)
      await storeRetentionObject(pool, {
        id,
        class: "raw",
        identity: scope,
        recordedAt: new Date(iso(start)),
        payload,
        dependencies: deps,
      });
    await f.pool.query(
      'INSERT INTO btc_order_acceptances(account_id,order_id,request,accepted_at) VALUES(\'manual\',\'order\', \'{"order_id":"order","schema_version":"btc.reservations.v1"}\',now())',
    );
    await f.pool.query(
      "INSERT INTO btc_ioc_intents(account_id,order_id,intent,evidence_id) VALUES('manual','order','{\"schema_version\":\"btc.ioc.v1\"}','intent')",
    );
    const a = await captureReplayDataset(pool, "manual", "a".repeat(40));
    expect(a.dataset.evidence.map((x) => x.object_id)).toEqual([
      "intent",
      "raw",
    ]);
    expect(
      a.dataset.evidence.find((x) => x.object_id === "raw")!.payload,
    ).toEqual({ gap_epoch: 3, quality: "gap", captured_probability: 0.7 });
    expect(
      (
        await f.pool.query(
          "WITH RECURSIVE protected(id) AS (SELECT object_id FROM btc_retention_pins WHERE pin_id=$1 UNION SELECT dependency_id FROM btc_retention_dependencies d JOIN protected p ON d.object_id=p.id) SELECT id FROM protected",
          [a.dataset_id],
        )
      ).rows.map((x) => x.id),
    ).toContain("raw");
  });
  it("rolls back oversized/capacity exports and never silently truncates", async () => {
    await f.pool.query(
      "UPDATE btc_retention_policy SET total_bytes=6442450944",
    );
    await expect(
      captureReplayDataset(pool, "manual", "a".repeat(40)),
    ).rejects.toThrow("CAPACITY");
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM btc_retention_objects WHERE object_id LIKE 'btc-replay:%'",
        )
      ).rows[0]!.n,
    ).toBe(0);
    await expect(
      captureReplayDataset(pool, "absent", "a".repeat(40)),
    ).rejects.toThrow("ACCOUNT_MISSING");
  });
});
