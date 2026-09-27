import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { identity, command, fill, iso, start } from "./ledger-fixture.js";
import {
  createLedgerAccount,
  appendLedgerBatchTx,
} from "../../src/storage/ledgerstore.js";
import { decideBaseline } from "../../src/storage/baseline-policy.js";
import { fixture as baselineFixture, AT, T } from "./baseline-fixture.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import {
  captureReplayDataset,
  loadReplayDataset,
  loadReplayEvidence,
} from "../../src/storage/replaystore.js";
import { replayDataset } from "../../src/storage/replay-dataset.js";
import {
  storeRetentionObject,
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
      await f.pool.query(
        "INSERT INTO btc_baseline_decisions(account_id,bar_end_at,decision_id,decision,evidence_id) VALUES('baseline',$1,$2,$3,$4)",
        [d.bar_end_at, d.decision_id, JSON.stringify(d), id],
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
