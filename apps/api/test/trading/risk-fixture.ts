import type { SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { identity, iso } from "./ledger-fixture.js";
import { market } from "./valuation-fixture.js";
import { order } from "./reservation-fixture.js";
import {
  storeRetentionObjectTx,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
export const scope = ledgerScope(identity());
export function riskOrder(
  id = "order:1",
  changes: Partial<ReturnType<typeof order>> = {},
) {
  const cap = changes.price_cap_usd_raw ?? "65000000000";
  return order(id, {
    quantity_btc_raw: "100000",
    risk_plan: {
      entry_floor_usd_raw: "64900000000",
      stop_price_usd_raw:
        changes.side === "sell"
          ? (BigInt(cap) + 100000000n).toString()
          : "64800000000",
    },
    ...changes,
  });
}
export async function riskFixture(url: string | undefined) {
  const fixture = await createPgFixture(url);
  let clockOverride: string | null = null;
  let hook: ((sql: string, tx: SqlExecutor) => Promise<void>) | null = null;
  const pool = {
    async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
      const c = await fixture.pool.connect();
      const plain: SqlExecutor = {
        async query(sql, params) {
          const r =
            clockOverride && sql === "SELECT clock_timestamp() AS now"
              ? await c.query("SELECT $1::timestamptz AS now", [clockOverride])
              : await c.query(sql, params ? [...params] : []);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      };
      try {
        await c.query("BEGIN");
        const r = await run({
          async query(sql, params) {
            await hook?.(sql, plain);
            return plain.query(sql, params);
          },
        });
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
  };
  let sequence = 0;
  async function capture(
    options: {
      mark?: string;
      at?: number;
      unknown?: boolean;
      bookStale?: boolean;
      markStale?: boolean;
    } = {},
  ) {
    const at = options.at ?? Date.now(),
      m = market(at);
    if (m.context!.payload.payload.kind !== "mark_funding")
      throw new Error("fixture");
    Object.assign(m.context!.payload.payload.mark_price, {
      raw: options.mark ?? "65000000000",
    });
    if (options.unknown)
      Object.assign(m.context!.payload, { source_timestamp: null });
    if (options.markStale)
      Object.assign(m.context!.payload, { source_timestamp: iso(at - 5100) });
    if (options.bookStale)
      Object.assign(m.book!.payload, { source_timestamp: iso(at - 2001) });
    await withBtcRetentionTransaction(pool, async (tx) => {
      for (const [kind, payload] of [
        ["context", m.context!.payload],
        ["book", m.book!.payload],
        ["capture", m.capture],
      ] as const) {
        const id = `risk-fixture:${kind}:${++sequence}`;
        await tx.query(
          "SELECT pg_sleep(GREATEST(0,LEAST(0.1,extract(epoch FROM $1::timestamptz-clock_timestamp()))))",
          [iso(at)],
        );
        await storeRetentionObjectTx(tx, {
          id,
          class: "raw",
          identity: scope,
          recordedAt: new Date(at),
          payload,
          dependencies: [],
        });
        await tx.query(
          "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$3)",
          [id, kind, iso(at)],
        );
      }
    });
  }
  return {
    ...fixture,
    poolAdapter: pool,
    setClock: (at: string) => {
      clockOverride = at;
    },
    capture,
    setHook: (fn: typeof hook) => {
      hook = fn;
    },
  };
}

/** Synthetic finalized current-hour funding evidence for execution tests. The
 * cutoff predates their fills, so it creates no funding debit or credit. */
export async function seedRiskFunding(
  pool: Pick<import("../../src/database.js").DatabasePool, "transaction">,
  owner = scope,
) {
  const at = Date.now() - 500,
    id = `risk-fixture:oracle:${owner.account_id}:${at}`;
  await withBtcRetentionTransaction(pool, async (tx) => {
    await storeRetentionObjectTx(tx, {
      id,
      class: "raw",
      identity: owner,
      recordedAt: new Date(at),
      payload: market(at).context!.payload,
      dependencies: [],
    });
    await tx.query(
      "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,'context',$2,$2)",
      [id, iso(at)],
    );
  });
  const { reconcileFunding } =
    await import("../../src/storage/fundingstore.js");
  return reconcileFunding(pool, owner, {
    operation_id: "risk-fixture:funding",
    period_hour: iso(Math.floor(at / 3600000) * 3600000),
    oracle_object_id: id,
    observation: {
      source: "hyperliquid:mainnet:fundingHistory",
      received_at: iso(at + 100),
      row: { coin: "BTC", time: at, fundingRate: "0", premium: "0" },
    },
  });
}
