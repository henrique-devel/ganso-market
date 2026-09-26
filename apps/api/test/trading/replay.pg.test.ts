import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { identity, command, fill, iso, start } from "./ledger-fixture.js";
import {
  createLedgerAccount,
  appendLedgerBatchTx,
} from "../../src/storage/ledgerstore.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import {
  captureReplayDataset,
  loadReplayDataset,
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
      ["raw", [], { gap_epoch: 3, quality: "gap" }],
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
    ).toEqual({ gap_epoch: 3, quality: "gap" });
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
