import {
  storeRetentionObjectTx,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
import { health } from "./bars-fixture.js";
import { scope as retentionScope } from "./risk-fixture.js";
import { jevRiskCheckpoint } from "../../src/trading/jev-risk.js";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { createJevFundingLane } from "../../src/storage/jev-funding-store.js";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createPgFixture } from "../pg-fixture.js";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import {
  claimExecutionWorker,
  executionFencedPool,
} from "../../src/storage/execution-worker-lease.js";
import {
  createJevWorkerStore,
  jevWorkerAccountTokenTx,
} from "../../src/storage/jev-worker-store.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevIdentity } from "./jev-v2-fixture.js";
import { jevHash } from "../../src/storage/jev-hash.js";
import { seedDispatchCapacityTx } from "./jev-dispatch-fixture.js";
import { decisionFixture } from "./jev-decision-fixture.js";
import {
  registerJevPair,
  appendJevLedgerBatch,
} from "../../src/storage/jev-store.js";
import { jevCommand } from "./jev-v2-fixture.js";
import type { JevBatchResult } from "../../src/models/jev-decision-contract.js";
import { deriveJevResult } from "../../src/models/jev-decision-replay.js";
import { decisionResponse } from "./jev-decision-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof createPgFixture>>;
const pool: Pick<DatabasePool, "transaction" | "readOnly"> = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const c = await f.pool.connect();
    try {
      await c.query("BEGIN");
      const v = await run({
        async query(sql, params) {
          const r = await c.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await c.query("COMMIT");
      return v;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
  readOnly(_ms, run) {
    return this.transaction(run);
  },
};
async function scheduled() {
  const fixture = decisionFixture(Date.now()),
    lease = await claimExecutionWorker(pool, "a".repeat(40));
  await registerJevPair(
    pool,
    1,
    fixture.identity,
    fixture.stress,
    fixture.manifest,
  );
  const s = fixture.batch.participants[0]!.context.scope;
  await f.pool.query(
    "INSERT INTO jev_worker_controls(account_id,admitted,entries_paused,admission_reference) VALUES($1,true,false,'fixture-only')",
    [s.account_id],
  );
  const token = await pool.transaction(
    async (tx) => (await jevWorkerAccountTokenTx(tx, s)).hash,
  );
  await f.pool.query(
    "INSERT INTO jev_worker_cadences(account_id,generation,state,pending_request_id,pending_cut_at) VALUES($1,$2,'{}',$3,$4)",
    [
      s.account_id,
      lease.generation,
      fixture.batch.request_id,
      fixture.batch.cut_at,
    ],
  );
  const result = deriveJevResult({
    schema_version: "jev.principal-decision.v1",
    origin: "mock",
    batch: fixture.batch,
    batch_hash: "",
    reason: "ok",
    attempted: true,
    started_at: fixture.batch.cut_at,
    finished_at: fixture.batch.cut_at,
    response_received_at: fixture.batch.cut_at,
    http_status: 200,
    original_response: JSON.stringify(decisionResponse(fixture.batch)),
    response_hash: null,
    tariff: null,
    reserved_usd6: "0",
    cost_usd6: "0",
    usage: null,
  } as JevBatchResult);
  result.decisions = result.decisions.slice(0, 1);
  result.decisions[0]!.action = "hold";
  result.decisions[0]!.reason = "ok";
  result.cost_usd6 = "0";
  const store = createJevWorkerStore(
    executionFencedPool(pool, lease),
    lease,
    fixture.batch.model,
  );
  return { fixture, lease, s, token, result, store };
}
describe.skipIf(!url)("JE07 durable cadence/state fencing", () => {
  beforeEach(async () => {
    f = await createPgFixture(url);
  });
  afterEach(async () => {
    await f.dispose();
  });
  it("prepares a real protected context, persists cadence, and creates no backlog", async () => {
    const initial = decisionFixture(Date.now());
    await registerJevPair(
      pool,
      1,
      initial.identity,
      initial.stress,
      initial.manifest,
    );
    for (const [slot, h] of [3, 5].entries()) {
      const manifest = initialJevManifest(h as 3 | 5),
        p = jevIdentity("paper", `h${h}`),
        s = jevIdentity("stress", `h${h}`);
      for (const i of [p, s]) {
        i.bindings[0]!.profile.horizon_minutes = h as 3 | 5;
        i.bindings[0]!.profile.manifest_hash = jevHash(manifest);
      }
      await registerJevPair(pool, slot + 2, p, s, manifest);
    }
    const lease = await claimExecutionWorker(pool, "a".repeat(40));
    const fixture = decisionFixture(Date.now()),
      cut = fixture.input.cut_at,
      at = Date.parse(cut),
      scope = fixture.batch.participants[0]!.context.scope;
    const checkpoint = jevRiskCheckpoint({
      previous: null,
      now_at: cut,
      ledger_sequence: "1",
      equity_usd_raw: "250000000",
      daily_anchor_usd_raw: "250000000",
      initial_equity_usd_raw: "250000000",
      history_complete: true,
      fresh: true,
      reconciled: true,
      flat: true,
      global_blocked: false,
    });
    for (const account of (
      await f.pool.query("SELECT account_id FROM jev_accounts")
    ).rows) {
      await f.pool.query(
        "INSERT INTO jev_risk_events(account_id,sequence,operation_id,checkpoint,evidence) VALUES($1,1,'fixture',$2,'{}')",
        [account.account_id, checkpoint],
      );
      await f.pool.query(
        "INSERT INTO jev_worker_controls(account_id,admitted,entries_paused,admission_reference,funding_debit_rate9_raw,cost_evidence_id) VALUES($1,true,false,'fixture-only',0,'fixture:capacity')",
        [account.account_id],
      );
    }
    await withBtcRetentionTransaction(pool, async (tx) => {
      const save = async (
        r: { object_id: string; payload: unknown; recorded_at: string },
        kind: string | null = null,
        bar = false,
      ) => {
        await storeRetentionObjectTx(tx, {
          id: r.object_id,
          class: "raw",
          identity: retentionScope,
          recordedAt: new Date(r.recorded_at),
          payload: r.payload,
          dependencies: [],
        });
        if (kind)
          await tx.query(
            "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$3)",
            [r.object_id, kind, r.recorded_at],
          );
        if (bar) {
          const b = r.payload as { start_at: string; end_at: string };
          await tx.query(
            "INSERT INTO btc_market_bars(interval_ms,start_at,end_at,object_id) VALUES(900000,$1,$2,$3)",
            [b.start_at, b.end_at, r.object_id],
          );
        }
      };
      for (const r of fixture.input.bars) await save(r, null, true);
      for (const d of fixture.input.dependencies)
        await save({ ...d, payload: { fixture: d.object_id } });
      // Use the real originals/hashes in the preserved bar dependency graph.
      for (const r of [
        fixture.input.book!,
        fixture.input.mark_funding!,
        ...fixture.input.trades,
      ])
        await save(
          r,
          r.payload.payload.kind === "book"
            ? "book"
            : r.payload.payload.kind === "trade"
              ? "trades"
              : "context",
        );
      const capacityId = await seedDispatchCapacityTx(tx, at);
      await tx.query("UPDATE jev_worker_controls SET capacity_evidence_id=$1", [
        capacityId,
      ]);
      for (let n = 0; n <= 60; n++) {
        const t = at - 60000 + n * 1000;
        const h = health(t);
        for (const k of ["book", "context", "trades"] as const)
          h.channels[k] = {
            status: "healthy",
            last_received_at: t,
            last_source_at: t,
            source_quality: "fresh",
            gap_epoch: 0,
            needs_revalidation: false,
          };
        await save(
          {
            object_id: `fixture-capture:${n}`,
            recorded_at: new Date(t).toISOString(),
            payload: { from: t - 1000, at: t, session: "fixture", health: h },
          },
          "capture",
        );
      }
    });
    const store = createJevWorkerStore(
      executionFencedPool(pool, lease),
      lease,
      fixture.batch.model,
    );
    const accounts = await store.accounts();
    expect(accounts).toHaveLength(6);
    let publicCalls = 0;
    const funding = createJevFundingLane(
      { ...pool, readOnly: pool.readOnly.bind(pool) },
      store.accounts,
      async () => {
        publicCalls++;
        throw Error("unexpected");
      },
    );
    await funding.tick();
    expect(publicCalls).toBe(0);

    const groups = [1, 3, 5].map((h) =>
      accounts.filter((a) => a.scope.profile_id === `h${h}`),
    );
    await f.pool.query(
      "UPDATE jev_worker_controls SET capacity_evidence_id=NULL WHERE account_id=$1",
      [scope.account_id],
    );
    const missing = await store.prepare(
      [accounts.find((a) => a.scope.account_id === scope.account_id)!],
      at + 100,
    );
    expect(missing).toBeNull();
    expect(store.metrics.capacity_skips).toBe(1);
    await f.pool.query(
      "UPDATE jev_worker_controls SET capacity_evidence_id='fixture:capacity' WHERE account_id=$1",
      [scope.account_id],
    );
    const started = performance.now(),
      cpu = process.cpuUsage();
    const walBefore = (
      await f.pool.query(
        "SELECT pg_current_wal_lsn() AS lsn,pg_database_size(current_database())::text AS bytes",
      )
    ).rows[0];
    const prepared = await Promise.all(
      groups.map((g) => store.prepare(g, at + 100)),
    );
    for (const [i, p] of prepared.entries()) {
      expect(p?.batch.participants).toHaveLength(2);
      expect(p?.batch.manifest.horizon_minutes).toBe([1, 3, 5][i]);
      expect(
        p?.batch.participants.every(
          (p) => p.context.quality.state === "observed_no_known_gap",
        ),
      ).toBe(true);
      expect(
        p?.batch.participants.map((p) => p.context.scope.mode).sort(),
      ).toEqual(["paper", "stress"]);
    }
    for (const g of groups) expect(await store.prepare(g, at + 101)).toBeNull();
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM jev_worker_cycles WHERE phase='scheduled'",
        )
      ).rows[0].n,
    ).toBe(6);
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM jev_evidence_objects"))
        .rows[0].n,
    ).toBe(12);
    const walAfter = (
      await f.pool.query(
        "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),$1)::text AS wal_bytes,pg_database_size(current_database())::text AS bytes",
        [walBefore.lsn],
      )
    ).rows[0];
    const report = {
      profiles: 3,
      accounts: 6,
      elapsed_ms: performance.now() - started,
      cpu_us: process.cpuUsage(cpu),
      logical_bytes: (
        await f.pool.query(
          "SELECT total_bytes::text n FROM btc_retention_policy",
        )
      ).rows[0].n,
      physical_growth_bytes: (
        BigInt(walAfter.bytes) - BigInt(walBefore.bytes)
      ).toString(),
      wal_bytes: walAfter.wal_bytes,
      pins: (
        await f.pool.query("SELECT count(*)::int n FROM btc_retention_pins")
      ).rows[0].n,
      protected_sources: (
        await f.pool.query("SELECT count(*)::int n FROM jev_evidence_sources")
      ).rows[0].n,
      pending_cycles: 6,
      duplicate_cycles: 0,
      origin: "disposable_postgres_fixture_not_admission",
    };
    if (process.env.GANSO_JE10_LOAD_PATH)
      writeFileSync(
        process.env.GANSO_JE10_LOAD_PATH,
        JSON.stringify(report, null, 2),
      );
  });
  it("consumes one current response and clears its exact pending cutoff", async () => {
    const x = await scheduled();
    await x.store.complete(x.result, { [x.s.account_id]: x.token });
    expect(
      (await f.pool.query("SELECT phase FROM jev_worker_cycles")).rows,
    ).toEqual([{ phase: "completed" }]);
    expect(
      (await f.pool.query("SELECT pending_request_id FROM jev_worker_cadences"))
        .rows[0].pending_request_id,
    ).toBeNull();
    await x.store.complete(x.result, { [x.s.account_id]: x.token });
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM jev_entry_events"))
        .rows[0].n,
    ).toBe(0);
  });
  it("discards a reply when account control revision changes during inference", async () => {
    const x = await scheduled();
    await f.pool.query(
      "UPDATE jev_worker_controls SET entries_paused=true WHERE account_id=$1",
      [x.s.account_id],
    );
    await x.store.complete(x.result, { [x.s.account_id]: x.token });
    expect(
      (await f.pool.query("SELECT phase FROM jev_worker_cycles")).rows[0].phase,
    ).toBe("discarded");
  });
  it("discards a reply when the position/financial sequence changes", async () => {
    const x = await scheduled();
    await appendJevLedgerBatch(pool, x.s.owner_id, x.s.account_id, {
      transaction_id: `fixture:${randomUUID()}`,
      events: [jevCommand(x.fixture.identity, "filled-during-inference")],
    } as Parameters<typeof appendJevLedgerBatch>[3]);
    await x.store.complete(x.result, { [x.s.account_id]: x.token });
    expect(
      (await f.pool.query("SELECT phase FROM jev_worker_cycles")).rows[0].phase,
    ).toBe("discarded");
  });
  it("never executes a late response and pauses entries after provider/budget failure", async () => {
    const x = await scheduled();
    x.result.batch.deadline_at = new Date(Date.now() - 1).toISOString();
    x.result.decisions[0]!.reason = "budget_exhausted";
    await x.store.complete(x.result, { [x.s.account_id]: x.token });
    expect(
      (await f.pool.query("SELECT entries_paused FROM jev_worker_controls"))
        .rows[0].entries_paused,
    ).toBe(true);
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM jev_entry_events"))
        .rows[0].n,
    ).toBe(0);
  });
  it("reconciles restart, retains cadence, and never resends pending inference", async () => {
    const x = await scheduled();
    await x.store.protect({ scope: x.s, manifest: x.fixture.manifest }, true);
    const h = (
      await f.pool.query(
        "SELECT state,pending_request_id FROM jev_worker_cadences",
      )
    ).rows[0];
    expect(h.state).toEqual({});
    expect(h.pending_request_id).toBeNull();
    expect(
      (await f.pool.query("SELECT phase FROM jev_worker_cycles")).rows[0].phase,
    ).toBe("recovered");
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM jev_decision_requests"))
        .rows[0].n,
    ).toBe(0);
  });
});
