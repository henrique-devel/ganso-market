import pg from "pg";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import { createPgFixture } from "../pg-fixture.js";
import { market } from "./valuation-fixture.js";
import { health, trade } from "./bars-fixture.js";
import { identity, iso } from "./ledger-fixture.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import {
  withBtcRetentionTransaction,
  storeRetentionObjectTx,
} from "../../src/storage/btc-retention.js";

/** Synthetic evidence only in a disposable database. Every observation has its
 * own source time; advancing the clock never refreshes old books/marks. Real
 * connections, transactions, triggers, recovery leases and fences remain in use. */
export async function acceptanceFixture(
  url: string | undefined,
  now: () => number,
  statementClock = false,
) {
  const f = await createPgFixture(url);
  const clients = new Set<pg.Pool>();
  function worker() {
    const client = new pg.Pool({
      connectionString: f.pool.options.connectionString,
      max: 2,
    });
    clients.add(client);
    const pool: Pick<DatabasePool, "transaction"> = {
      async transaction<T>(run: (tx: SqlExecutor) => Promise<T>) {
        const c = await client.connect();
        try {
          await c.query("BEGIN");
          const result = await run({
            async query(sql, params) {
              // Opt-in for consumers with clocks embedded in hour/lease queries.
              // The timestamp is generated here, never supplied as SQL by callers.
              if (statementClock)
                sql = sql.replaceAll(
                  "clock_timestamp()",
                  `TIMESTAMPTZ '${iso(now())}'`,
                );
              const r =
                sql === "SELECT clock_timestamp() AS now"
                  ? await c.query("SELECT $1::timestamptz AS now", [iso(now())])
                  : await c.query(sql, params ? [...params] : []);
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
    };
    return {
      pool,
      async stop() {
        await client.end();
        clients.delete(client);
      },
    };
  }
  let sequence = 0,
    lastCapture = now() - 100;
  async function capture(
    pool: Pick<DatabasePool, "transaction">,
    options: {
      depth?: string;
      trade?: { side: "buy" | "sell"; price: string; quantity: string };
      unknownMark?: boolean;
    } = {},
  ) {
    const at = now(),
      m = market(at),
      id = ++sequence;
    if (m.book!.payload.payload.kind !== "book") throw new Error("fixture");
    const b = m.book!.payload.payload;
    // One visible level per side, shared by all counterfactual owners.
    Object.assign(b, { bids: b.bids.slice(0, 1), asks: b.asks.slice(0, 1) });
    for (const l of [...b.bids, ...b.asks])
      Object.assign(l.quantity, { raw: options.depth ?? "100000" });
    if (options.unknownMark)
      Object.assign(m.context!.payload, {
        source_timestamp: null,
        quality: "unknown",
      });
    const h = health(at);
    Object.assign(h.channels, m.capture!.health.channels);
    const capture = {
      ...m.capture!,
      health: h,
      id: `s10:${id}`,
      session: "s10-synthetic",
      from: lastCapture,
      history_truncated: false,
      restarted: false,
    };
    const rows: Array<[string, unknown, string | null]> = [
      ["context", m.context!.payload, options.unknownMark ? null : iso(at)],
      ["book", m.book!.payload, iso(at)],
      ["capture", capture, iso(lastCapture)],
    ];
    if (options.trade) {
      const t = trade(at, id, options.trade.price, options.trade.quantity);
      if (t.payload.kind !== "trade") throw new Error("fixture");
      Object.assign(t.payload, { side: options.trade.side });
      rows.push(["trades", t, iso(at)]);
    }
    await withBtcRetentionTransaction(pool, async (tx) => {
      for (const [kind, payload, source] of rows) {
        const key = `s10:${kind}:${id}`;
        await storeRetentionObjectTx(tx, {
          id: key,
          class: "raw",
          identity: ledgerScope(identity()),
          recordedAt: new Date(at),
          payload,
          dependencies: [],
        });
        await tx.query(
          "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES($1,$2,$3,$4)",
          [key, kind, source, iso(at)],
        );
      }
    });
    lastCapture = at;
    return `s10:context:${id}`;
  }
  return {
    ...f,
    worker,
    capture,
    async dispose() {
      for (const c of clients) await c.end();
      await f.dispose();
    },
  };
}
