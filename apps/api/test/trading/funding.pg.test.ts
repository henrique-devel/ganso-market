import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { reconcileFunding } from "../../src/storage/fundingstore.js";
import {
  appendLedgerBatch,
  createLedgerAccount,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import {
  readLedgerValuation,
  replayFinancials,
} from "../../src/storage/valuationstore.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
} from "../../src/storage/btc-retention.js";
import { ledgerScope, replayLedger } from "../../src/trading/ledger.js";
import { dailyFinancialCosts } from "../../src/trading/valuation.js";
import { identity, iso, command, fill, funding } from "./ledger-fixture.js";
import { cut, request, seedPaperOracle } from "./funding-fixture.js";
import { market } from "./valuation-fixture.js";
import { PAPER_FUNDING_MODEL } from "../../src/trading/funding.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof createPgFixture>>;
let fail: string | null;
const pool = {
  async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        async query(sql, params) {
          if (fail && sql.includes(fail)) await client.query("SELECT 1/0");
          const r = await client.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
};
const scope = ledgerScope(identity());
async function fillAt(
  id: string,
  at: number,
  side: "buy" | "sell" = "buy",
  owner = "manual",
  position = "position:1",
) {
  const s = ledgerScope(identity(owner)),
    p = fill(id, side);
  if (p.event_type !== "fill") throw new Error("fixture");
  return appendLedgerBatch(pool, s, {
    transaction_id: id,
    events: [command(id, { ...p, position_id: position }, s, at)],
  });
}
// Independent synthetic oracle, never a claim about public activeAssetCtx.
async function oracle(
  id = "funding-oracle",
  at: number | null = cut,
  price = "64000000000",
) {
  const m = market(cut),
    payload = m.context!.payload;
  if (payload.payload.kind !== "mark_funding") throw new Error("fixture");
  const value = {
    ...payload,
    source_timestamp: at === null ? null : iso(at),
    quality: at === null ? "unknown" : "fresh",
    payload: {
      ...payload.payload,
      oracle_price: { ...payload.payload.oracle_price, raw: price },
    },
  };
  await withBtcRetentionTransaction(pool, async (tx) => {
    await storeRetentionObjectTx(tx, {
      id,
      class: "raw",
      identity: scope,
      recordedAt: new Date(cut),
      payload: value,
      dependencies: [],
    });
    await tx.query(
      "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,'context',$2,$3)",
      [id, at === null ? null : iso(at), iso(cut)],
    );
  });
}
const reconcile = (r = request()) => reconcileFunding(pool, scope, r);
async function snapshot() {
  const out = [];
  for (const table of [
    "btc_ledger_transactions",
    "btc_ledger_events",
    "btc_ledger_projections",
    "btc_funding_results",
    "btc_retention_objects",
    "btc_retention_pins",
    "btc_retention_dependencies",
    "btc_retention_policy",
  ])
    out.push(
      (
        await fixture.pool.query(
          `SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  return out;
}
describe.skipIf(!url)("funding on disposable PostgreSQL", () => {
  beforeEach(async () => {
    fixture = await createPgFixture(url);
    fail = null;
    await createLedgerAccount(pool, identity());
    await oracle();
  });
  afterEach(async () => {
    await fixture?.dispose();
  });
  it.each([
    ["buy", "0.00001234567", "-7902"],
    ["sell", "0.00001234567", "7901"],
    ["buy", "-0.00001234567", "7901"],
    ["sell", "-0.00001234567", "-7902"],
  ] as const)(
    "paper %s rate %s preserves precision, pinned evidence and restart replay",
    async (side, rate, delta) => {
      await fillAt("open", cut - 1, side);
      await seedPaperOracle(pool, scope, "precut", cut - 2000);
      const cmd = {
        ...request("paper", rate),
        model_version: PAPER_FUNDING_MODEL,
        oracle_object_id: "precut",
      };
      const result = await reconcile(cmd);
      expect(result).toMatchObject({
        status: "settled",
        reason: "paper_pre_cut_snapshot",
        model_version: PAPER_FUNDING_MODEL,
        rate: { decimals: 18 },
        price_evidence: {
          source_timestamp: null,
          quality: "unknown",
          receipt_age_ms: 2000,
        },
        positions: [{ delta_usd_raw: delta }],
      });
      expect(await reconcile(cmd)).toEqual(result);
      expect((await reconcile({ ...cmd, operation_id: "retry" })).status).toBe(
        "duplicate",
      );
      const ledger = await readLedgerAccount(pool, scope);
      expect(ledger.projection.cash_usd_raw).toBe(
        (1000000000n + BigInt(delta)).toString(),
      );
      expect(replayLedger(identity(), ledger.events)).toEqual(
        ledger.projection,
      );
      expect(replayFinancials(identity(), ledger.events).funding_usd_raw).toBe(
        delta,
      );
      expect(
        dailyFinancialCosts(ledger.projection, ledger.events, iso(cut + 1000))
          .funding_usd_raw,
      ).toBe(delta);
      expect(
        (
          await fixture.pool.query(
            "SELECT dependency_id FROM btc_retention_dependencies WHERE object_id=$1",
            [result.evidence_id],
          )
        ).rows,
      ).toEqual([{ dependency_id: "precut" }]);
      expect(
        (
          await fixture.pool.query(
            "SELECT 1 FROM btc_retention_pins WHERE object_id=$1",
            [result.evidence_id],
          )
        ).rowCount,
      ).toBe(1);
      await seedPaperOracle(
        pool,
        scope,
        "correction",
        cut - 1000,
        "64000000001",
      );
      expect(
        (
          await reconcile({
            ...cmd,
            operation_id: "correction",
            oracle_object_id: "correction",
          })
        ).status,
      ).toBe("conflict");
      expect((await readLedgerAccount(pool, scope)).projection).toEqual(
        ledger.projection,
      );
    },
  );
  it.each([cut - 5001, cut + 1])(
    "paper refuses out-of-window/future response %s",
    async (at) => {
      await fillAt("open", cut - 1);
      await seedPaperOracle(pool, scope, "invalid", at);
      expect(
        await reconcile({
          ...request(),
          model_version: PAPER_FUNDING_MODEL,
          oracle_object_id: "invalid",
        }),
      ).toMatchObject({
        status: "pending",
        reason: "missing_pre_cut_snapshot",
      });
    },
  );
  it.each([
    { cache_status: "Hit from cloudfront" },
    { requested_at: iso(cut - 10000) },
    { server_date: new Date(cut + 2000).toUTCString() },
  ])("paper refuses invalid HTTP evidence %s", async (patch) => {
    await fillAt("open", cut - 1);
    await seedPaperOracle(
      pool,
      scope,
      "invalid",
      cut - 1000,
      "64000000000",
      patch,
    );
    expect(
      await reconcile({
        ...request(),
        model_version: PAPER_FUNDING_MODEL,
        oracle_object_id: "invalid",
      }),
    ).toMatchObject({ status: "pending", reason: "missing_pre_cut_snapshot" });
  });
  it.each([cut - 1, cut, cut + 1])(
    "paper open/close at %s preserves the economic cutoff",
    async (at) => {
      await seedPaperOracle(pool, scope, "precut", cut - 5000);
      await fillAt("open", cut - 2000);
      await fillAt("close", at, "sell");
      const r = await reconcile({
        ...request(),
        model_version: PAPER_FUNDING_MODEL,
        oracle_object_id: "precut",
      });
      expect(r.status).toBe(at === cut ? "pending" : "settled");
      expect(
        (await readLedgerAccount(pool, scope)).projection.cash_usd_raw,
      ).toBe(at > cut ? "999936000" : "1000000000");
    },
  );
  it("explicit model upgrade resolves legacy precision/oracle pending without rewriting receipts", async () => {
    await fillAt("open", cut - 1);
    const original = await reconcile({
      ...request("legacy", "0.00001234567"),
      oracle_object_id: null,
    });
    expect(original.reason).toBe("inexact_RATE9");
    await seedPaperOracle(pool, scope, "precut", cut - 1);
    expect(
      await reconcile({
        ...request("paper", "0.00001234567"),
        model_version: PAPER_FUNDING_MODEL,
        oracle_object_id: "precut",
      }),
    ).toMatchObject({ status: "settled" });
    expect(
      await reconcile({
        ...request("legacy", "0.00001234567"),
        oracle_object_id: null,
      }),
    ).toEqual(original);
  });
  it("paper precision overflow is pending and never rounds an unrepresentable final rate", async () => {
    await fillAt("open", cut - 1);
    expect(
      await reconcile({
        ...request("paper", "0.0000123456789012345"),
        model_version: PAPER_FUNDING_MODEL,
        oracle_object_id: null,
      }),
    ).toMatchObject({ status: "pending", reason: "inexact_RATE18" });
  });
  it.each([
    ["buy", "0.0001", "999936000"],
    ["sell", "0.0001", "1000064000"],
    ["buy", "-0.0001", "1000064000"],
    ["sell", "-0.0001", "999936000"],
  ] as const)(
    "settles %s rate %s at economic time; replay balance %s",
    async (side, rate, balance) => {
      await fillAt("open", cut - 1, side);
      const result = await reconcile(request("fund", rate));
      expect(result.status).toBe("settled");
      const ledger = await readLedgerAccount(pool, scope);
      expect(ledger.events.at(-1)?.occurred_at).toBe(iso(cut));
      expect(ledger.projection.cash_usd_raw).toBe(balance);
      expect(replayLedger(identity(), [...ledger.events].reverse())).toEqual(
        ledger.projection,
      );
      expect(replayFinancials(identity(), ledger.events).balance_usd_raw).toBe(
        balance,
      );
      expect(
        dailyFinancialCosts(ledger.projection, ledger.events, iso(cut + 1000))
          .funding_usd_raw,
      ).toBe(result.positions[0]!.delta_usd_raw);
    },
  );
  it.each([cut, cut + 1])(
    "never charges a position opened at/after cutoff %s",
    async (at) => {
      await fillAt("open", at);
      const r = await reconcile();
      expect(r.status).toBe(at === cut ? "pending" : "settled");
      expect(r.reason).toBe(
        at === cut ? "ambiguous_cutoff_order" : "no_eligible_position",
      );
      expect(
        (await readLedgerAccount(pool, scope)).projection.cash_usd_raw,
      ).toBe("1000000000");
    },
  );
  it.each([cut - 1, cut, cut + 1])(
    "resolves close near cutoff %s conservatively",
    async (at) => {
      await fillAt("open", cut - 1000);
      await fillAt("close", at, "sell");
      const r = await reconcile();
      expect(r.status).toBe(at === cut ? "pending" : "settled");
      expect(
        (await readLedgerAccount(pool, scope)).projection.cash_usd_raw,
      ).toBe(at > cut ? "999936000" : "1000000000");
    },
  );
  it("late rate charges the old closed position, never a later new position", async () => {
    await fillAt("old-open", cut - 1000);
    await fillAt("old-close", cut + 1, "sell");
    await fillAt("new-open", cut + 2, "buy", "manual", "new-position");
    const r = await reconcile();
    expect(r.positions).toEqual([
      {
        position_id: "position:1",
        quantity_btc_raw: "1000000",
        delta_usd_raw: "-64000",
      },
    ]);
    expect((await readLedgerAccount(pool, scope)).projection.positions).toEqual(
      [
        { position_id: "new-position", quantity_btc_raw: "1000000" },
        { position_id: "position:1", quantity_btc_raw: "0" },
      ],
    );
  });
  it("isolates owners sharing period and position IDs", async () => {
    await createLedgerAccount(pool, identity("other"));
    await fillAt("open", cut - 1);
    await fillAt("open", cut - 1, "sell", "other");
    await Promise.all([
      reconcile(),
      reconcileFunding(pool, ledgerScope(identity("other")), request()),
    ]);
    expect((await readLedgerAccount(pool, scope)).projection.cash_usd_raw).toBe(
      "999936000",
    );
    expect(
      (await readLedgerAccount(pool, ledgerScope(identity("other")))).projection
        .cash_usd_raw,
    ).toBe("1000064000");
    await expect(
      reconcileFunding(
        pool,
        { ...scope, experiment_id: "experiment:other" },
        request(),
      ),
    ).rejects.toThrow("OWNERSHIP");
  });
  it("same operation retries, semantic retries and simultaneous workers charge once across fresh connections", async () => {
    await fillAt("open", cut - 1);
    const [a, b] = await Promise.all([reconcile(), reconcile()]);
    expect(a).toEqual(b);
    const before = await snapshot();
    expect(await reconcile()).toEqual(a);
    expect(await snapshot()).toEqual(before);
    const retried = await reconcile(request("after-restart"));
    expect(retried.status).toBe("duplicate");
    expect(await reconcile(request("after-restart"))).toEqual(retried);
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int n FROM btc_ledger_events WHERE event_type='funding'",
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(reconcile(request("fund", "-0.0001"))).rejects.toThrow(
      "COLLISION",
    );
  });
  it("records missing rate then reconciles after restart without an earlier cash mutation", async () => {
    await fillAt("open", cut - 1);
    const missing = {
      ...request("missing"),
      observation: null,
      oracle_object_id: null,
    };
    expect(await reconcile(missing)).toMatchObject({
      status: "pending",
      reason: "missing_final_rate",
    });
    expect((await readLedgerAccount(pool, scope)).projection.cash_usd_raw).toBe(
      "1000000000",
    );
    expect(await reconcile()).toMatchObject({ status: "settled" });
    expect(
      (
        await fixture.pool.query(
          "SELECT status FROM btc_funding_results ORDER BY sequence",
        )
      ).rows.map((r) => r.status),
    ).toEqual(["pending", "settled"]);
  });
  it.each([null, cut - 1, cut + 1])(
    "does not turn current or nearby context %s into a settlement oracle",
    async (at) => {
      await fillAt("open", cut - 1);
      await oracle("bad", at);
      expect(
        await reconcile({ ...request(), oracle_object_id: "bad" }),
      ).toMatchObject({
        status: "pending",
        reason: "missing_settlement_oracle",
      });
      expect(
        (await readLedgerAccount(pool, scope)).projection.cash_usd_raw,
      ).toBe("1000000000");
    },
  );
  it("inexact rate remains pending, exact zero remains an observed zero", async () => {
    await fillAt("open", cut - 1);
    expect(await reconcile(request("precise", "0.00001234567"))).toMatchObject({
      status: "pending",
      reason: "inexact_RATE9",
    });
    await createLedgerAccount(pool, identity("zero"));
    await fillAt("open", cut - 1, "buy", "zero");
    expect(
      await reconcileFunding(
        pool,
        ledgerScope(identity("zero")),
        request("zero", "0"),
      ),
    ).toMatchObject({ status: "settled", positions: [{ delta_usd_raw: "0" }] });
  });
  it("divergent late rate appends a sticky conflict without rewriting cash or original evidence", async () => {
    await fillAt("open", cut - 1);
    const first = await reconcile();
    expect(await reconcile(request("correction", "-0.0001"))).toMatchObject({
      status: "conflict",
    });
    expect(await reconcile(request("try-original"))).toMatchObject({
      status: "conflict",
    });
    expect((await readLedgerAccount(pool, scope)).projection.cash_usd_raw).toBe(
      "999936000",
    );
    expect(await reconcile()).toEqual(first);
    const value = await readLedgerValuation(
      pool,
      scope,
      new Date().toISOString(),
    );
    expect(value.funding.usable_for_risk).toBe(false);
    expect(value.funding.pending.some((r) => r.reason === "conflict")).toBe(
      true,
    );
  });
  it("oracle correction is a conflict even when USD6 rounding gives the same payment", async () => {
    await fillAt("open", cut - 1);
    await reconcile();
    await oracle("correction", cut, "63999999999");
    expect(
      await reconcile({
        ...request("correction"),
        oracle_object_id: "correction",
      }),
    ).toMatchObject({
      status: "conflict",
      reason: "divergent_settlement_basis",
    });
  });
  it("divergent pending observations cannot be silently selected later", async () => {
    await fillAt("open", cut - 1);
    expect(
      (await reconcile({ ...request(), oracle_object_id: null })).status,
    ).toBe("pending");
    expect((await reconcile(request("changed", "-0.0001"))).status).toBe(
      "conflict",
    );
    expect((await readLedgerAccount(pool, scope)).projection.cash_usd_raw).toBe(
      "1000000000",
    );
  });
  it.each([
    "INSERT INTO btc_ledger_projections",
    "INSERT INTO btc_retention_pins",
    "INSERT INTO btc_funding_results",
  ])(
    "rolls back cash, journal, pins and byte accounting when %s fails",
    async (fault) => {
      await fillAt("open", cut - 1);
      const before = await snapshot();
      fail = fault;
      await expect(reconcile()).rejects.toThrow();
      fail = null;
      expect(await snapshot()).toEqual(before);
      expect((await reconcile()).status).toBe("settled");
    },
  );
  it("refuses direct funding commands and fills that change a committed cut; forward fills and old retries work", async () => {
    await fillAt("open", cut - 1);
    await reconcile();
    await expect(
      appendLedgerBatch(pool, scope, {
        transaction_id: "bypass",
        events: [command("bypass", funding())],
      }),
    ).rejects.toThrow("OBSERVED_FUNDING_REQUIRED");
    await expect(fillAt("late", cut - 2)).rejects.toThrow(
      "SETTLED_FUNDING_CUTOFF",
    );
    await expect(fillAt("tie", cut)).rejects.toThrow("SETTLED_FUNDING_CUTOFF");
    expect((await fillAt("open", cut - 1)).status).toBe("duplicate");
    expect((await fillAt("forward", cut + 1)).status).toBe("appended");
  });
  it("serializes funding against a concurrent historical fill: either included or refused", async () => {
    const results = await Promise.allSettled([
      reconcile(),
      fillAt("racing", cut - 1),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    const ledger = await readLedgerAccount(pool, scope);
    if (results[1]?.status === "fulfilled")
      expect(ledger.projection.cash_usd_raw).toBe("999936000");
    else expect(ledger.projection.cash_usd_raw).toBe("1000000000");
  });
  it("SQL enforces immutable journal, unique period and source preservation", async () => {
    await fillAt("open", cut - 1);
    const r = await reconcile();
    for (const sql of [
      "UPDATE btc_funding_results SET result=result",
      "DELETE FROM btc_funding_results",
      "TRUNCATE btc_funding_results CASCADE",
    ])
      await expect(fixture.pool.query(sql)).rejects.toThrow("APPEND_ONLY");
    await expect(
      fixture.pool.query(
        "INSERT INTO btc_funding_results SELECT account_id,'other',sequence+1,period_hour,cutoff,status,jsonb_set(request,'{operation_id}','\"other\"'),result,evidence_id FROM btc_funding_results",
      ),
    ).rejects.toThrow("btc_funding_one_settlement");
    expect(
      (
        await fixture.pool.query(
          "SELECT payload->'request'->'observation'->'row' row FROM btc_retention_objects WHERE object_id=$1",
          [r.evidence_id],
        )
      ).rows[0].row,
    ).toEqual(request().observation!.row);
    expect(
      (
        await fixture.pool.query(
          "SELECT dependency_id FROM btc_retention_dependencies WHERE object_id=$1",
          [r.evidence_id],
        )
      ).rows,
    ).toEqual([{ dependency_id: "funding-oracle" }]);
  });
  it("read-only valuation exposes missing funding plus daily ledger funding without mutation", async () => {
    await fillAt("open", cut - 1);
    await reconcile();
    const before = await snapshot();
    const v = await readLedgerValuation(pool, scope, new Date().toISOString());
    expect(v.funding_usd_raw).toBe("-64000");
    expect(v.balance_usd_raw).toBe("999936000");
    expect(v.funding.status).toBe("pending");
    expect(v.maintenance.usable_for_risk).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
});
