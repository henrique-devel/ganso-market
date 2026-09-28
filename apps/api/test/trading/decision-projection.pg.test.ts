import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { createLedgerAccount } from "../../src/storage/ledgerstore.js";
import {
  storeRetentionObjectTx,
  pinRetentionObjectTx,
} from "../../src/storage/btc-retention.js";
import { baselineHash } from "../../src/storage/baseline-inputs.js";
import { decideBaseline } from "../../src/storage/baseline-policy.js";
import { fixture } from "./baseline-fixture.js";
import { identity } from "./ledger-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
describe.skipIf(!url)("shared decision persistence", () => {
  let f: Awaited<ReturnType<typeof createPgFixture>>;
  const decision = decideBaseline(fixture());
  const transaction = async <T>(run: (tx: SqlExecutor) => Promise<T>) => {
    const c = await f.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(741044,4)");
      const out = await run(c as unknown as SqlExecutor);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  };
  const save = async (
    tx: SqlExecutor,
    d: typeof decision,
    compact: boolean,
  ) => {
    const id = `decision:${d.decision_id}`;
    await storeRetentionObjectTx(tx, {
      id,
      class: "decision",
      identity: d.registration.scope,
      recordedAt: new Date(d.decision_at),
      payload: d,
      dependencies: ["registration"],
    });
    await pinRetentionObjectTx(tx, id, id, "test prospective decision");
    await tx.query(
      "INSERT INTO btc_baseline_decisions(account_id,bar_end_at,decision_id,decision,evidence_id) VALUES('baseline',$1,$2,$3,$4)",
      [
        d.bar_end_at,
        d.decision_id,
        JSON.stringify(
          compact ? { ...d, storage_version: "btc.decision-projection.v1" } : d,
        ),
        id,
      ],
    );
  };
  beforeAll(async () => {
    f = await createPgFixture(url);
    await createLedgerAccount({ transaction }, identity("baseline"));
    await f.pool.query(
      "INSERT INTO auth_accounts(username,password_hash) VALUES('owner','fixture-only')",
    );
    await f.pool.query(
      "INSERT INTO btc_desk_controls(account_id,owner_account_id,broker,signing_key) SELECT 'baseline',account_id,'ioc',repeat('a',64) FROM auth_accounts",
    );
    await transaction(async (tx) => {
      await storeRetentionObjectTx(tx, {
        id: "registration",
        class: "experiment",
        identity: decision.registration.scope,
        recordedAt: new Date(decision.decision_at),
        payload: decision.registration,
        dependencies: [],
      });
      await tx.query(
        "INSERT INTO btc_baseline_registrations VALUES('baseline',$1,'registration')",
        [JSON.stringify(decision.registration)],
      );
    });
  });
  afterAll(async () => {
    await f?.dispose();
  });
  it("keeps legacy/full hashes and ledger, pins and HOLD; refuses corruption and rolls back a crash before commit", async () => {
    const before = (await f.pool.query("SELECT * FROM btc_ledger_events")).rows;
    await transaction((tx) => save(tx, decision, false));
    const next = {
      ...decision,
      decision_id: baselineHash("next"),
      bar_end_at: new Date(
        Date.parse(decision.bar_end_at) + 900000,
      ).toISOString(),
    };
    await transaction((tx) => save(tx, next, true));
    const rows = (
      await f.pool.query(
        "SELECT decision FROM btc_baseline_decisions_full ORDER BY bar_end_at",
      )
    ).rows;
    expect(rows.map((r) => baselineHash(r.decision))).toEqual([
      baselineHash(decision),
      baselineHash(next),
    ]);
    expect(
      (
        await f.pool.query(
          "SELECT decision FROM btc_baseline_decisions WHERE decision_id=$1",
          [next.decision_id],
        )
      ).rows[0].decision.input_refs,
    ).toBeUndefined();
    await expect(transaction((tx) => save(tx, next, true))).rejects.toThrow();
    const failed = {
      ...next,
      decision_id: baselineHash("crash"),
      bar_end_at: new Date(Date.parse(next.bar_end_at) + 900000).toISOString(),
    };
    const charges = (
      await f.pool.query("SELECT total_bytes FROM btc_retention_policy")
    ).rows;
    await expect(
      transaction(async (tx) => {
        await save(tx, failed, true);
        throw new Error("simulated crash before commit");
      }),
    ).rejects.toThrow("simulated crash");
    expect(
      (await f.pool.query("SELECT total_bytes FROM btc_retention_policy")).rows,
    ).toEqual(charges);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM btc_retention_objects WHERE object_id=$1",
          [`decision:${failed.decision_id}`],
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      f.pool.query(
        "INSERT INTO btc_baseline_decisions VALUES('baseline',$1,$2,$3,$4)",
        [
          failed.bar_end_at,
          failed.decision_id,
          JSON.stringify({
            ...failed,
            storage_version: "btc.decision-projection.v1",
          }),
          `decision:${next.decision_id}`,
        ],
      ),
    ).rejects.toThrow("BTC_DECISION_EVIDENCE_MISMATCH");
    expect(
      (await f.pool.query("SELECT * FROM btc_ledger_events")).rows,
    ).toEqual(before);
    expect(
      (await f.pool.query("SELECT hold FROM btc_retention_policy")).rows[0]
        .hold,
    ).toBe(true);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM btc_retention_dependencies WHERE object_id=$1 AND dependency_id='registration'",
          [`decision:${next.decision_id}`],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      f.pool.query(
        "DELETE FROM btc_retention_objects WHERE object_id='registration'",
      ),
    ).rejects.toThrow();
  });
  it("measures future duplicate-copy bytes, WAL and SQL latency on a 65,536-reference corpus", async () => {
    // Synthetic large graph, matching the repeated-hash/timestamp shape of production.
    // Compare only the eliminated second copy: retained evidence remains unchanged.
    const refs = Array.from({ length: 65536 }, (_, i) => ({
      object_id: `btc-market:event:${baselineHash(i)}`,
      payload_hash: baselineHash([i, "payload"]),
      recorded_at: decision.decision_at,
    }));
    const large = {
      ...decision,
      input_refs: refs,
      signal: decision.signal ? { ...decision.signal, input_refs: refs } : null,
    };
    await f.pool.query(
      "CREATE TABLE persistence_before (payload jsonb NOT NULL)",
    );
    await f.pool.query(
      "CREATE TABLE persistence_after (payload jsonb NOT NULL)",
    );
    const oldStarted = performance.now();
    const old = (
      await f.pool.query(
        "EXPLAIN (ANALYZE,WAL,FORMAT JSON) INSERT INTO persistence_before VALUES($1::jsonb)",
        [JSON.stringify(large)],
      )
    ).rows[0]["QUERY PLAN"][0];
    const oldWallMs = performance.now() - oldStarted;
    const freshStarted = performance.now();
    const fresh = (
      await f.pool.query(
        "EXPLAIN (ANALYZE,WAL,FORMAT JSON) INSERT INTO persistence_after VALUES(btc_decision_projection($1::jsonb))",
        [JSON.stringify(large)],
      )
    ).rows[0]["QUERY PLAN"][0];
    const freshWallMs = performance.now() - freshStarted;
    const sizes = (
      await f.pool.query(
        "SELECT pg_total_relation_size('persistence_before')::int AS before,pg_total_relation_size('persistence_after')::int AS after,octet_length($1::text) AS logical_before,octet_length(btc_decision_projection($1::jsonb)::text) AS logical_after",
        [JSON.stringify(large)],
      )
    ).rows[0];
    console.log(
      "G2-12.2 second-copy benchmark",
      JSON.stringify({
        ...sizes,
        wal_before: old.Plan["WAL Bytes"],
        wal_after: fresh.Plan["WAL Bytes"],
        client_ms_before: oldWallMs,
        client_ms_after: freshWallMs,
        planning_ms_before: old["Planning Time"],
        planning_ms_after: fresh["Planning Time"],
        ms_before: old["Execution Time"],
        ms_after: fresh["Execution Time"],
      }),
    );
    expect(sizes.after).toBeLessThan(sizes.before / 10);
    expect(fresh.Plan["WAL Bytes"]).toBeLessThan(old.Plan["WAL Bytes"] / 10);
    // Capacity admission is separate: the 16 KiB plan target is NOT met
    // by the preserved economic projection alone; report it, never truncate it.
    expect(sizes.logical_after).toBeLessThan(sizes.logical_before / 100);
  }, 30000);
});
