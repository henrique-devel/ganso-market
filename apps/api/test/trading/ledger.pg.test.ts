import {
  recoverAccount,
  recoveryTransaction,
} from "../../src/storage/recoverystore.js";
import { ledgerScope, replayLedger } from "../../src/trading/ledger.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import {
  appendLedgerBatch,
  appendLedgerBatchTx,
  createLedgerAccount,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import { type LedgerBatch } from "../../src/storage/ledger-contract.js";
import { createPgFixture } from "../pg-fixture.js";
import { command, fill, funding, identity, usd } from "./ledger-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
let failProjection = false;
const pool: Pick<DatabasePool, "transaction"> = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        async query<R extends Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ) {
          if (
            failProjection &&
            sql.startsWith("INSERT INTO btc_ledger_projections")
          )
            await client.query("SELECT 1/0");
          const r = await client.query<R>(
            sql,
            params ? [...params] : undefined,
          );
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
const scope = ledgerScope(identity());
const batch = (): LedgerBatch => ({
  transaction_id: "open",
  events: [
    command("fill", fill()),
    command("fee", {
      event_type: "fee",
      execution_id: "exec:1",
      delta: usd("-100000"),
    }),
  ],
});
async function counts() {
  return (
    await fixture.pool.query(
      `SELECT (SELECT count(*)::int FROM btc_ledger_accounts) accounts, (SELECT count(*)::int FROM btc_ledger_events) events, (SELECT count(*)::int FROM btc_ledger_transactions) transactions, (SELECT count(*)::int FROM btc_ledger_projections) projections`,
    )
  ).rows[0];
}
describe.skipIf(!url)("account ledger on disposable PostgreSQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
    failProjection = false;
  });
  afterEach(async () => {
    await fixture?.dispose();
  });
  it("migration seeds no identities or capital and keeps accounts disabled", async () => {
    expect(await counts()).toEqual({
      accounts: 0,
      events: 0,
      transactions: 0,
      projections: 0,
    });
    await createLedgerAccount(pool, identity());
    expect(
      (await fixture.pool.query("SELECT mode,status FROM btc_ledger_accounts"))
        .rows,
    ).toEqual([{ mode: "paper", status: "disabled" }]);
    expect((await readLedgerAccount(pool, scope)).projection.cash_usd_raw).toBe(
      "1000000000",
    );
  });
  it("identical genesis and batch retry return the original sequence/time without charging twice", async () => {
    const created = await createLedgerAccount(pool, identity());
    expect(await createLedgerAccount(pool, identity())).toEqual({
      ...created,
      status: "duplicate",
    });
    const appended = await appendLedgerBatch(pool, scope, batch());
    expect(await appendLedgerBatch(pool, scope, batch())).toEqual({
      ...appended,
      status: "duplicate",
    });
    expect(await counts()).toEqual({
      accounts: 1,
      events: 3,
      transactions: 2,
      projections: 1,
    });
    expect((await readLedgerAccount(pool, scope)).projection.cash_usd_raw).toBe(
      "999900000",
    );
  });
  it("refuses changed batch content and identity, including reset under the same experiment", async () => {
    await createLedgerAccount(pool, identity());
    await appendLedgerBatch(pool, scope, batch());
    const before = await readLedgerAccount(pool, scope);
    const changed = batch();
    await expect(
      appendLedgerBatch(pool, scope, {
        ...changed,
        events: [command("fill", fill("exec:1", "sell")), changed.events[1]!],
      }),
    ).rejects.toThrow("COLLISION");
    await expect(
      createLedgerAccount(pool, {
        ...identity(),
        account: { ...identity().account, purpose: "baseline" },
      }),
    ).rejects.toThrow("COLLISION");
    await expect(
      createLedgerAccount(pool, {
        ...identity(),
        account: { ...identity().account, account_id: "replacement" },
      }),
    ).rejects.toThrow();
    expect(await readLedgerAccount(pool, scope)).toEqual(before);
    await createLedgerAccount(pool, identity("new-experiment"));
    expect(
      (await readLedgerAccount(pool, ledgerScope(identity("new-experiment"))))
        .projection.cash_usd_raw,
    ).toBe("1000000000");
  });
  it("isolates two owners with the same logical IDs and opposite positions", async () => {
    const other = identity("challenger"),
      otherScope = ledgerScope(other);
    await createLedgerAccount(pool, identity());
    await createLedgerAccount(pool, other);
    await appendLedgerBatch(pool, scope, batch());
    await appendLedgerBatch(pool, otherScope, {
      transaction_id: "open",
      events: [command("fill", fill("exec:1", "sell"), otherScope)],
    });
    expect(
      (await readLedgerAccount(pool, otherScope)).projection,
    ).toMatchObject({
      cash_usd_raw: "1000000000",
      positions: [{ quantity_btc_raw: "-1000000" }],
    });
    expect((await readLedgerAccount(pool, scope)).projection).toMatchObject({
      cash_usd_raw: "999900000",
      positions: [{ quantity_btc_raw: "1000000" }],
    });
    await expect(
      appendLedgerBatch(pool, scope, {
        transaction_id: "wrong",
        events: [command("cross", fill(), otherScope)],
      }),
    ).rejects.toThrow("OWNERSHIP");
    await expect(
      readLedgerAccount(pool, {
        ...scope,
        experiment_id: otherScope.experiment_id,
      }),
    ).rejects.toThrow("OWNERSHIP");
  });
  it("orders replay by committed sequence, retains funding time and liquidates without duplicate deltas", async () => {
    await createLedgerAccount(pool, identity());
    await appendLedgerBatch(pool, scope, batch());
    // Historical S1 replay fixture; public funding requires S6. Keep even this
    // internal seam inside S9 ownership and atomic checkpointing.
    await recoveryTransaction(pool, scope, (tx) =>
      appendLedgerBatchTx(
        tx,
        identity(),
        {
          transaction_id: "fund",
          events: [command("fund", funding())],
        },
        new Date().toISOString(),
        false,
        true,
      ),
    );
    await appendLedgerBatch(pool, scope, {
      transaction_id: "close",
      events: [
        command("close", fill("exec:2", "sell")),
        command("liquidation", {
          event_type: "liquidation",
          position_id: "position:1",
          execution_id: "exec:2",
        }),
      ],
    });
    const result = await readLedgerAccount(pool, scope);
    expect(result.events.map((e) => e.sequence)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(replayLedger(identity(), [...result.events].reverse())).toEqual(
      result.projection,
    );
    expect(result.projection).toMatchObject({
      cash_usd_raw: "999650000",
      positions: [{ quantity_btc_raw: "0" }],
    });
  });
  it("rolls back a valid fill followed by an invalid fee without partial publication", async () => {
    await createLedgerAccount(pool, identity());
    const before = await readLedgerAccount(pool, scope);
    await expect(
      appendLedgerBatch(pool, scope, {
        transaction_id: "bad",
        events: [
          command("fill", fill()),
          command("fee", {
            event_type: "fee",
            execution_id: "other",
            delta: usd("-1"),
          }),
        ],
      }),
    ).rejects.toThrow("FEE_EXECUTION");
    expect(await readLedgerAccount(pool, scope)).toEqual(before);
    expect(await counts()).toEqual({
      accounts: 1,
      events: 1,
      transactions: 1,
      projections: 1,
    });
  });
  it("SQL failure after event inserts rolls back header, events, projection and genesis identity", async () => {
    failProjection = true;
    await expect(createLedgerAccount(pool, identity())).rejects.toThrow();
    expect(await counts()).toEqual({
      accounts: 0,
      events: 0,
      transactions: 0,
      projections: 0,
    });
    failProjection = false;
    await createLedgerAccount(pool, identity());
    const before = await readLedgerAccount(pool, scope);
    failProjection = true;
    await expect(appendLedgerBatch(pool, scope, batch())).rejects.toThrow();
    expect(await readLedgerAccount(pool, scope)).toEqual(before);
    expect(await counts()).toEqual({
      accounts: 1,
      events: 1,
      transactions: 1,
      projections: 1,
    });
    failProjection = false;
    expect(
      (await appendLedgerBatch(pool, scope, batch())).events.map(
        (e) => e.sequence,
      ),
    ).toEqual(["2", "3"]);
  });
  it("serializes simultaneous genesis/retries and distinct transactions on real connections", async () => {
    const created = await Promise.all([
      createLedgerAccount(pool, identity()),
      createLedgerAccount(pool, identity()),
    ]);
    expect(created.map((r) => r.status).sort()).toEqual([
      "appended",
      "duplicate",
    ]);
    const retried = await Promise.all([
      appendLedgerBatch(pool, scope, batch()),
      appendLedgerBatch(pool, scope, batch()),
    ]);
    expect(retried.map((r) => r.status).sort()).toEqual([
      "appended",
      "duplicate",
    ]);
    await Promise.all(
      [1, 2].map((n) =>
        appendLedgerBatch(pool, scope, {
          transaction_id: `capital:${n}`,
          events: [
            command(`capital:${n}`, {
              event_type: "cash",
              reason: "transfer",
              delta: usd("1"),
            }),
          ],
        }),
      ),
    );
    const result = await readLedgerAccount(pool, scope);
    expect(result.events.map((e) => e.sequence)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(result.projection.cash_usd_raw).toBe("999900002");
  });
  it("refuses reused event IDs under another transaction and duplicate execution IDs", async () => {
    await createLedgerAccount(pool, identity());
    await appendLedgerBatch(pool, scope, batch());
    const before = await readLedgerAccount(pool, scope);
    await expect(
      appendLedgerBatch(pool, scope, {
        ...batch(),
        transaction_id: "repackaged",
      }),
    ).rejects.toThrow();
    await expect(
      appendLedgerBatch(pool, scope, {
        transaction_id: "another",
        events: [command("new-fill-id", fill())],
      }),
    ).rejects.toThrow("EXECUTION_EXISTS");
    expect(await readLedgerAccount(pool, scope)).toEqual(before);
  });
  it("SQL rejects update/delete/truncate of durable identities, transactions and events", async () => {
    await createLedgerAccount(pool, identity());
    for (const [table, field] of [
      ["btc_ledger_accounts", "identity"],
      ["btc_ledger_transactions", "request"],
      ["btc_ledger_events", "event"],
    ]) {
      await expect(
        fixture.pool.query(`UPDATE ${table} SET ${field}=${field}`),
      ).rejects.toThrow("APPEND_ONLY");
      await expect(fixture.pool.query(`DELETE FROM ${table}`)).rejects.toThrow(
        "APPEND_ONLY",
      );
      await expect(
        fixture.pool.query(`TRUNCATE ${table} CASCADE`),
      ).rejects.toThrow("APPEND_ONLY");
    }
    expect(await counts()).toEqual({
      accounts: 1,
      events: 1,
      transactions: 1,
      projections: 1,
    });
  });
  it("reads and an already booted worker detect corruption without silently repairing it", async () => {
    await createLedgerAccount(pool, identity());
    await recoverAccount(pool, scope);
    await fixture.pool.query(
      `UPDATE btc_ledger_projections SET projection=jsonb_set(projection,'{cash_usd_raw}','"0"')`,
    );
    await expect(readLedgerAccount(pool, scope)).rejects.toThrow(
      "PROJECTION_MISMATCH",
    );
    await expect(appendLedgerBatch(pool, scope, batch())).rejects.toThrow(
      "PROJECTION_MISMATCH",
    );
    expect((await counts()).events).toBe(1);
    expect(
      (
        await fixture.pool.query(
          "SELECT projection->>'cash_usd_raw' cash FROM btc_ledger_projections",
        )
      ).rows[0]?.cash,
    ).toBe("0");
  });
});
