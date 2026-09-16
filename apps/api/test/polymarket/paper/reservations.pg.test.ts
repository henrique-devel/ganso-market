// Real transactions and full production migrations. Fixtures keep all guards.
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../../../src/database.js";
import {
  reserveOrder,
  reconcileReservations,
} from "../../../src/polymarket/paper/reservations.js";
import {
  appendLedgerEvent,
  type LedgerEventInput,
} from "../../../src/polymarket/paper/ledger.js";
import { loadAttributedLedgerEvents } from "../../../src/polymarket/paper/ownership.js";
import {
  replayFinancialLedger,
  financialOwnerKey,
} from "../../../src/polymarket/paper/financial.js";
import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import {
  DEFAULT_PORTFOLIO_CONFIG,
  type CapConfig,
} from "../../../src/polymarket/portfolio/config.js";
import {
  acceptPaperOrder,
  requestCancel,
  type PaperPool,
} from "../../../src/polymarket/paper/brokerstore.js";

import { bridgeTick } from "../../../src/polymarket/paper/bridge.js";

const url = process.env.GANSO_TEST_DATABASE_URL;
const schema = `fin05_${randomUUID().replaceAll("-", "")}`;
const at = new Date("2026-09-16T01:00:00Z");
const later = new Date("2026-09-16T01:00:10Z");
// Explicit synthetic caps, not production defaults or a new runtime limit.
const caps: CapConfig = {
  entrada: 1,
  mercado: 1,
  grupoCorrelacionado: 1,
  categoria: 1,
  fonteResolucao: 1,
  catalisadorJanela: 1,
  capitalBloqueado: 1,
};
let raw: pg.Pool;
function wrap(client: pg.Pool | pg.PoolClient): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) {
      const r = await client.query<R>(text, [...params]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  };
}
async function tx<T>(run: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const client = await raw.connect();
  try {
    await client.query("BEGIN");
    const value = await run(wrap(client));
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function owner(
  strategy: string,
  capital: string | null = "1000.000000000",
) {
  await raw.query(
    "INSERT INTO paper_financial_owners(account_id,strategy_id,initial_cash_usd,capital_source_ref) VALUES ('paper',$1,$2,'FIN05:synthetic')",
    [strategy, capital],
  );
}
async function insert(
  db: SqlExecutor,
  strategy: string,
  id: string,
  token: string,
  size: string,
  side = "BUY",
  price = "0.500000",
) {
  await db.query(
    `INSERT INTO paper_orders(order_id,token_id,condition_id,side,order_type,limit_price,size,source,strategy_id,status,decided_at,accepted_at)
    VALUES ($1,$2,$3,$4,'GTC',$5,$6,'fast',$7,'open',$8,$8)`,
    [id, token, `c-${token}`, side, price, size, strategy, at],
  );
}
async function accept(
  db: SqlExecutor,
  strategy: string,
  id: string,
  token: string,
  size: string,
  side = "BUY",
  useCaps = caps,
) {
  await insert(db, strategy, id, token, size, side);
  const reservation = await reserveOrder(db, id, later, useCaps);
  const event: LedgerEventInput = {
    idempotencyKey: `${id}:accepted`,
    eventType: "order_accepted",
    orderId: id,
    tokenId: token,
    conditionId: `c-${token}`,
    payload: { side, reservation },
    eventTs: at,
  };
  await appendLedgerEvent(db, event);
  return event;
}
function fill(
  id: string,
  token: string,
  size: string,
  side = "BUY",
  price = "0.500000",
  fee = "0",
): LedgerEventInput {
  return {
    idempotencyKey: `${id}:fill`,
    eventType: "fill",
    orderId: id,
    tokenId: token,
    conditionId: `c-${token}`,
    payload: { side, price, size, fee },
    eventTs: later,
  };
}
function terminal(
  id: string,
  token: string,
  eventType: "cancel_requested" | "cancel_effective" | "expired",
): LedgerEventInput {
  return {
    idempotencyKey: `${id}:${eventType}`,
    eventType,
    orderId: id,
    tokenId: token,
    conditionId: `c-${token}`,
    payload: {},
    eventTs: later,
  };
}
async function row(id: string) {
  return (
    await raw.query(
      "SELECT * FROM paper_order_reservations WHERE order_id=$1",
      [id],
    )
  ).rows[0]!;
}
async function totals(strategy: string) {
  const selected = { accountId: "paper", strategyId: strategy };
  const state = replayFinancialLedger(
    await loadAttributedLedgerEvents(wrap(raw), selected),
    [
      {
        ...selected,
        initialCashUsd: "1000.000000000",
        capitalSourceRef: "FIN05:synthetic",
      },
    ],
    [],
    later,
  ).owners.get(financialOwnerKey("paper", strategy))!;
  const rows = await raw.query(
    "SELECT COALESCE(sum(cash_remaining_usd),0)::text AS cash, COALESCE(sum(risk_remaining_usd),0)::text AS risk FROM paper_order_reservations WHERE account_id='paper' AND strategy_id=$1",
    [strategy],
  );
  const reserved = parseScaled(rows.rows[0].cash)!;
  const committed = [...state.positions.values()].reduce(
    (sum, p) => sum + parseScaled(p.costBasisUsd)!,
    0n,
  );
  return {
    state,
    reserved,
    committed,
    available: parseScaled(state.cashUsd!)! - reserved,
    risk: parseScaled(rows.rows[0].risk)!,
  };
}
describe.skipIf(url === undefined)(
  "FIN-05 PostgreSQL atomic reservations",
  () => {
    beforeAll(async () => {
      const admin = new pg.Pool({ connectionString: url });
      try {
        const identity = await admin.query("SELECT current_database() AS name");
        if (!String(identity.rows[0].name).includes("test"))
          throw new Error("Disposable test database required");
        await admin.query(`CREATE SCHEMA ${schema}`);
      } finally {
        await admin.end();
      }
      raw = new pg.Pool({
        connectionString: url,
        max: 8,
        options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`,
        application_name: schema,
      });
      const dir = new URL("../../../../../migrations/", import.meta.url);
      for (const name of (await readdir(dir))
        .filter((n) => /^\d{4}_.+\.sql$/.test(n))
        .sort()) {
        const source = await readFile(new URL(name, dir), "utf8");
        await tx((db) =>
          db.query(
            source
              .replaceAll(":'migration_version'", `'${name.slice(0, 4)}'`)
              .replaceAll(
                ":'migration_checksum'",
                `'${createHash("sha256").update(source).digest("hex")}'`,
              ),
          ),
        );
      }
    }, 60000);
    afterAll(async () => {
      await raw?.end();
    });

    it.each([false, true])(
      "serializes competing $600/$500 accepts, reversed=%s",
      async (reverse) => {
        const strategy = `cash-${reverse}`;
        await owner(strategy);
        const orders = [
          { id: `a-${strategy}`, token: `a-${strategy}`, size: "1200" },
          { id: `b-${strategy}`, token: `b-${strategy}`, size: "1000" },
        ];
        if (reverse) orders.reverse();
        // Hold the winner AFTER reserve/accept but before commit; the other backend
        // must wait on the owner. An unprotected check-then-insert accepts both.
        let unlock!: () => void;
        const held = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        let reached!: () => void;
        const ready = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const first = tx(async (db) => {
          const o = orders[0]!;
          await accept(db, strategy, o.id, o.token, o.size);
          reached();
          await held;
        });
        await ready;
        const second = tx(async (db) => {
          const o = orders[1]!;
          return accept(db, strategy, o.id, o.token, o.size);
        });
        // Observe a real blocked backend, rather than depending on a sleep.
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          const q = await raw.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
            [schema],
          );
          blocked = q.rowCount! > 0;
        }
        unlock();
        await first;
        await expect(second).rejects.toThrow("FIN05_CASH_UNAVAILABLE");
        expect(blocked).toBe(true);
        const t = await totals(strategy);
        expect(t.reserved).toBe(parseScaled(reverse ? "500" : "600"));
        expect(t.available + t.reserved + t.committed).toBe(
          parseScaled("1000"),
        );
        expect(
          (
            await raw.query("SELECT 1 FROM paper_orders WHERE order_id=$1", [
              orders[1]!.id,
            ])
          ).rowCount,
        ).toBe(0);
      },
    );

    it("reserves risk even when cash is sufficient; dimensions remain separate", async () => {
      await owner("risk");
      const limited = { ...caps, capitalBloqueado: 0.1 };
      const results = await Promise.allSettled([
        tx((db) => accept(db, "risk", "risk1", "risk1", "120", "BUY", limited)),
        tx((db) => accept(db, "risk", "risk2", "risk2", "100", "BUY", limited)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: expect.objectContaining({ message: "FIN05_RISK_UNAVAILABLE" }),
      });
    });

    it("transfers partial fill, retains requested cancellation, releases effectively and retries exactly", async () => {
      await owner("partial");
      const event = await tx((db) =>
        accept(db, "partial", "partial", "partial", "1200"),
      );
      await expect(appendLedgerEvent(wrap(raw), event)).resolves.toBe(false);
      await appendLedgerEvent(wrap(raw), fill("partial", "partial", "400"));
      await appendLedgerEvent(
        wrap(raw),
        terminal("partial", "partial", "cancel_requested"),
      );
      let t = await totals("partial");
      expect([t.available, t.reserved, t.committed, t.risk]).toEqual(
        [400n, 400n, 200n, 400n].map((n) => n * 1_000_000_000n),
      );
      expect(t.available + t.reserved + t.committed).toBe(parseScaled("1000"));
      await appendLedgerEvent(
        wrap(raw),
        terminal("partial", "partial", "cancel_effective"),
      );
      await expect(
        appendLedgerEvent(
          wrap(raw),
          terminal("partial", "partial", "cancel_effective"),
        ),
      ).resolves.toBe(false);
      t = await totals("partial");
      expect(t.available).toBe(parseScaled("800"));
      expect(t.reserved).toBe(0n);
      await expect(
        appendLedgerEvent(wrap(raw), {
          ...fill("partial", "partial", "1"),
          idempotencyKey: "partial:late",
        }),
      ).rejects.toThrow("FIN05_FILL_OUTSIDE_RESERVATION");
      await expect(
        appendLedgerEvent(wrap(raw), fill("partial", "partial", "400")),
      ).resolves.toBe(false);
      await expect(
        appendLedgerEvent(wrap(raw), fill("partial", "partial", "401")),
      ).rejects.toThrow("FIN02_IDEMPOTENCY_CONFLICT");
    });

    it("prevents two exits from spending the same owner's inventory", async () => {
      await owner("exit");
      await tx((db) => accept(db, "exit", "entry", "exit-token", "400"));
      await appendLedgerEvent(wrap(raw), fill("entry", "exit-token", "400"));
      const results = await Promise.allSettled([
        tx((db) => accept(db, "exit", "exit1", "exit-token", "300", "SELL")),
        tx((db) => accept(db, "exit", "exit2", "exit-token", "200", "SELL")),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: expect.objectContaining({
          message: "FIN05_INVENTORY_UNAVAILABLE",
        }),
      });
      await owner("other-exit");
      await expect(
        tx((db) =>
          accept(db, "other-exit", "exit3", "exit-token", "1", "SELL"),
        ),
      ).rejects.toThrow("FIN05_INVENTORY_UNAVAILABLE");
    });

    it("isolates strategies on the same token and records unknown capital as a refusal", async () => {
      await owner("one");
      await owner("two");
      await owner("unknown", null);
      await Promise.all([
        tx((db) => accept(db, "one", "one", "shared", "1200")),
        tx((db) => accept(db, "two", "two", "shared", "1200")),
      ]);
      expect((await totals("one")).reserved).toBe(parseScaled("600"));
      expect((await totals("two")).reserved).toBe(parseScaled("600"));
      await expect(
        tx((db) => accept(db, "unknown", "unknown", "shared", "1")),
      ).rejects.toThrow("FIN05_CAPITAL_UNKNOWN");
    });

    it("FIN-06 fills real NO into separate owners and refuses SELL across owners or zero", async () => {
      await owner("fin06-one");
      await owner("fin06-two");
      await owner("fin06-empty");
      await tx((db) => accept(db, "fin06-one", "fin06-buy1", "no-real", "10"));
      await tx((db) => accept(db, "fin06-two", "fin06-buy2", "no-real", "20"));
      await appendLedgerEvent(
        wrap(raw),
        fill("fin06-buy1", "no-real", "10", "BUY", "0.4"),
      );
      await appendLedgerEvent(
        wrap(raw),
        fill("fin06-buy2", "no-real", "20", "BUY", "0.4"),
      );
      const one = await totals("fin06-one");
      const two = await totals("fin06-two");
      expect(one.state.positions.get("no-real")?.shares).toBe("10.000000000");
      expect(two.state.positions.get("no-real")?.shares).toBe("20.000000000");
      expect(one.state.cashUsd).toBe("996.000000000");
      expect(two.state.cashUsd).toBe("992.000000000");
      await expect(
        tx((db) =>
          accept(db, "fin06-empty", "fin06-sell-empty", "no-real", "1", "SELL"),
        ),
      ).rejects.toThrow("FIN05_INVENTORY_UNAVAILABLE");
      await expect(
        tx((db) =>
          accept(
            db,
            "fin06-one",
            "fin06-sell-cross-zero",
            "no-real",
            "11",
            "SELL",
          ),
        ),
      ).rejects.toThrow("FIN05_INVENTORY_UNAVAILABLE");
      await tx((db) =>
        accept(db, "fin06-one", "fin06-sell-own", "no-real", "10", "SELL"),
      );
      await appendLedgerEvent(
        wrap(raw),
        fill("fin06-sell-own", "no-real", "10", "SELL", "0.5"),
      );
      expect(
        (await totals("fin06-one")).state.positions.get("no-real")?.shares,
      ).toBe("0.000000000");
      expect(
        (await totals("fin06-two")).state.positions.get("no-real")?.shares,
      ).toBe("20.000000000");
    });

    it("rolls back order, audit and reserve together; retries after rollback", async () => {
      await owner("rollback");
      await expect(
        tx(async (db) => {
          await accept(db, "rollback", "rollback", "rollback", "1200");
          throw new Error("injected rollback");
        }),
      ).rejects.toThrow("injected rollback");
      expect(await row("rollback")).toBeUndefined();
      expect(
        (
          await raw.query(
            "SELECT 1 FROM paper_ledger_events WHERE order_id='rollback'",
          )
        ).rowCount,
      ).toBe(0);
      await tx((db) => accept(db, "rollback", "rollback", "rollback", "1200"));
      await expect(
        tx(async (db) => {
          await appendLedgerEvent(db, fill("rollback", "rollback", "400"));
          throw new Error("fill rollback");
        }),
      ).rejects.toThrow("fill rollback");
      expect(parseScaled((await row("rollback")).cash_remaining_usd)).toBe(
        parseScaled("600"),
      );
    });

    it("reconstructs corrupted projection after restart, expires and resolves idempotently", async () => {
      await owner("restart");
      await tx((db) => accept(db, "restart", "restart", "restart", "1200"));
      await appendLedgerEvent(wrap(raw), fill("restart", "restart", "400"));
      const before = await row("restart");
      await raw.query(
        "UPDATE paper_order_reservations SET cash_remaining_usd=0,risk_remaining_usd=0 WHERE order_id='restart'",
      );
      await tx((db) =>
        reconcileReservations(db, {
          accountId: "paper",
          strategyId: "restart",
        }),
      );
      expect(await row("restart")).toEqual(before);
      await tx((db) =>
        reconcileReservations(db, {
          accountId: "paper",
          strategyId: "restart",
        }),
      );
      expect(await row("restart")).toEqual(before);
      await appendLedgerEvent(
        wrap(raw),
        terminal("restart", "restart", "expired"),
      );
      expect((await row("restart")).state).toBe("released");
      const resolution: LedgerEventInput = {
        idempotencyKey: "restart:resolution",
        eventType: "resolution",
        tokenId: "restart",
        conditionId: "c-restart",
        payload: { outcome_price: "1", fee: "0" },
        eventTs: later,
      };
      await appendLedgerEvent(wrap(raw), resolution);
      await expect(appendLedgerEvent(wrap(raw), resolution)).resolves.toBe(
        false,
      );
      const t = await totals("restart");
      expect(t.available).toBe(parseScaled("1200"));
      expect(t.committed + t.reserved).toBe(0n);
    });

    it("rejects fees, prices and quantities outside the immutable reservation", async () => {
      await owner("bounds");
      await tx((db) => accept(db, "bounds", "bounds", "bounds", "10"));
      for (const bad of [
        fill("bounds", "bounds", "11"),
        fill("bounds", "bounds", "1", "BUY", "0.6"),
        fill("bounds", "bounds", "1", "BUY", "0.5", "0.01"),
      ]) {
        await expect(appendLedgerEvent(wrap(raw), bad)).rejects.toThrow(
          "FIN05_FILL_OUTSIDE_RESERVATION",
        );
      }
      expect(parseScaled((await row("bounds")).cash_remaining_usd)).toBe(
        parseScaled("5"),
      );
    });

    it("uses current default caps without introducing a runtime limit", async () => {
      await owner("default");
      await expect(
        tx((db) =>
          accept(
            db,
            "default",
            "default",
            "default",
            "1200",
            "BUY",
            DEFAULT_PORTFOLIO_CONFIG.caps,
          ),
        ),
      ).rejects.toThrow("FIN05_RISK_UNAVAILABLE");
    });

    it.each([false, true])(
      "orders a concurrent fill and effective cancellation, cancelFirst=%s",
      async (cancelFirst) => {
        const id = `race-${cancelFirst}`;
        await owner(id);
        await tx((db) => accept(db, id, id, id, "100"));
        let unlock!: () => void;
        const held = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        let reached!: () => void;
        const ready = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const first = tx(async (db) => {
          await appendLedgerEvent(
            db,
            cancelFirst
              ? terminal(id, id, "cancel_effective")
              : fill(id, id, "40"),
          );
          reached();
          await held;
        });
        await ready;
        const second = tx((db) =>
          appendLedgerEvent(
            db,
            cancelFirst
              ? fill(id, id, "40")
              : terminal(id, id, "cancel_effective"),
          ),
        );
        const outcome = second.then(
          () => "ok",
          (error) => String(error),
        );
        unlock();
        await first;
        expect(await outcome).toContain(
          cancelFirst ? "FIN05_FILL_OUTSIDE_RESERVATION" : "ok",
        );
        expect((await row(id)).state).toBe("released");
        expect((await totals(id)).committed).toBe(
          parseScaled(cancelFirst ? "0" : "20"),
        );
      },
    );

    it("resolution releases an active reservation without waiting for a broker restart", async () => {
      await owner("resolve-active");
      await tx((db) =>
        accept(db, "resolve-active", "resolve-active", "resolve-active", "100"),
      );
      await appendLedgerEvent(
        wrap(raw),
        fill("resolve-active", "resolve-active", "40"),
      );
      const resolution: LedgerEventInput = {
        idempotencyKey: "resolve-active:resolution",
        eventType: "resolution",
        tokenId: "resolve-active",
        conditionId: "c-resolve-active",
        payload: { outcome_price: "1" },
        eventTs: later,
      };
      await appendLedgerEvent(wrap(raw), resolution);
      expect((await row("resolve-active")).state).toBe("released");
      expect((await totals("resolve-active")).available).toBe(
        parseScaled("1020"),
      );
    });

    it("reserves an explicit taker fee bound and debits actual fees only once", async () => {
      await owner("fees");
      await raw.query(
        `INSERT INTO polymarket_param_versions(condition_id,version,content_hash,taker_fee_bps,valid_from) VALUES ('c-fees',1,'synthetic','700',$1)`,
        [at],
      );
      await tx(async (db) => {
        // This is a fresh synthetic order, before the identity becomes immutable.
        await db.query(
          `INSERT INTO paper_orders(order_id,token_id,condition_id,side,order_type,limit_price,worst_price,size,source,strategy_id,status,decided_at,accepted_at)
        VALUES ('fees','fees','c-fees','BUY','FAK','0.500000','0.600000','100.000000','fast','fees','open',$1,$1)`,
          [at],
        );
        const reservation = await reserveOrder(db, "fees", later, caps);
        expect(reservation.fee_per_share).toBe("0.017500000");
        await appendLedgerEvent(db, {
          idempotencyKey: "fees:accepted",
          eventType: "order_accepted",
          orderId: "fees",
          tokenId: "fees",
          conditionId: "c-fees",
          payload: { reservation },
          eventTs: at,
        });
      });
      expect(parseScaled((await row("fees")).cash_remaining_usd)).toBe(
        parseScaled("61.75"),
      );
      await appendLedgerEvent(
        wrap(raw),
        fill("fees", "fees", "40", "BUY", "0.5", "0.7"),
      );
      const t = await totals("fees");
      expect(t.reserved).toBe(parseScaled("37.05"));
      expect(t.available + t.reserved + t.committed).toBe(parseScaled("999.3"));
      expect(t.state.feesPaidUsd).toBe("0.700000000");
      expect(t.risk).toBe(parseScaled("37.05"));
    });

    it("does not double risk already transferred into a position", async () => {
      await owner("transfer");
      const limited = { ...caps, capitalBloqueado: 0.1 };
      await tx((db) =>
        accept(db, "transfer", "transfer1", "transfer1", "120", "BUY", limited),
      );
      await appendLedgerEvent(wrap(raw), fill("transfer1", "transfer1", "40"));
      // Position 20 + remaining reserve 40 + new reserve 40 = cap 100.
      await tx((db) =>
        accept(db, "transfer", "transfer2", "transfer2", "80", "BUY", limited),
      );
      await expect(
        tx((db) =>
          accept(db, "transfer", "transfer3", "transfer3", "1", "BUY", limited),
        ),
      ).rejects.toThrow("FIN05_RISK_UNAVAILABLE");
      const t = await totals("transfer");
      expect(t.committed + t.risk).toBe(parseScaled("100"));
    });

    it("keeps rounding exact when splitting a fractional-nano obligation", async () => {
      await owner("rounding", "0.000000001");
      await tx((db) =>
        accept(db, "rounding", "rounding", "rounding", "0.000000002"),
      );
      // Each half-nano fill rounds to a nano in financial-v2. Consuming one
      // would leave no cash for the remaining nano reservation: rollback.
      await expect(
        appendLedgerEvent(
          wrap(raw),
          fill("rounding", "rounding", "0.000000001"),
        ),
      ).rejects.toThrow("FIN05_CASH_UNAVAILABLE");
      expect(
        (
          await raw.query(
            "SELECT 1 FROM paper_ledger_events WHERE idempotency_key='rounding:fill'",
          )
        ).rowCount,
      ).toBe(0);
      expect(parseScaled((await row("rounding")).cash_remaining_usd)).toBe(1n);
      await appendLedgerEvent(
        wrap(raw),
        fill("rounding", "rounding", "0.000000002"),
      );
      expect((await row("rounding")).state).toBe("consumed");
    });

    it("reserves BUY reductions of legacy shorts and rejects cross-owner projection writes", async () => {
      await owner("short");
      await insert(
        wrap(raw),
        "short",
        "old-short",
        "short",
        "10",
        "SELL",
        "0.400000",
      );
      await appendLedgerEvent(
        wrap(raw),
        fill("old-short", "short", "10", "SELL", "0.4"),
      );
      await raw.query(
        "UPDATE paper_orders SET status='filled' WHERE order_id='old-short'",
      );
      await tx((db) => accept(db, "short", "cover1", "short", "6"));
      expect((await row("cover1")).inventory_side).toBe("BUY");
      await expect(
        tx((db) => accept(db, "short", "cover2", "short", "5")),
      ).rejects.toThrow("FIN05_INVENTORY_UNAVAILABLE");
      await raw.query(
        "INSERT INTO paper_financial_owners(account_id,strategy_id,initial_cash_usd,capital_source_ref) VALUES ('other-account','short','1000.000000000','synthetic')",
      );
      await expect(
        raw.query(
          "UPDATE paper_order_reservations SET account_id='other-account' WHERE order_id='cover1'",
        ),
      ).rejects.toThrow("FIN05_OWNER_CONFLICT");
      await appendLedgerEvent(wrap(raw), fill("cover1", "short", "6"));
      expect((await row("cover1")).state).toBe("consumed");
    });

    it("does not release a past GTD deadline without the effective expiry event", async () => {
      await owner("deadline");
      await tx(async (db) => {
        await db.query(
          `INSERT INTO paper_orders(order_id,token_id,condition_id,side,order_type,limit_price,size,source,strategy_id,status,decided_at,accepted_at,expiration_s)
          VALUES ('deadline','deadline','c-deadline','BUY','GTD','0.500000','10','fast','deadline','open',$1,$1,$2)`,
          [at, Math.floor(at.getTime() / 1000) + 180],
        );
        const reservation = await reserveOrder(db, "deadline", later, caps);
        await appendLedgerEvent(db, {
          idempotencyKey: "deadline:accepted",
          eventType: "order_accepted",
          orderId: "deadline",
          tokenId: "deadline",
          conditionId: "c-deadline",
          payload: { reservation },
          eventTs: at,
        });
      });
      await tx((db) =>
        reconcileReservations(db, {
          accountId: "paper",
          strategyId: "deadline",
        }),
      );
      expect(parseScaled((await row("deadline")).cash_remaining_usd)).toBe(
        parseScaled("5"),
      );
      await appendLedgerEvent(
        wrap(raw),
        terminal("deadline", "deadline", "expired"),
      );
      expect((await row("deadline")).state).toBe("released");
    });

    it("runs the actual broker acceptance, persisted retry and requested cancellation", async () => {
      await owner("main");
      const now = new Date();
      await raw.query(
        `INSERT INTO polymarket_param_versions(condition_id,version,content_hash,tick_size,min_order_size,taker_fee_bps,valid_from)
      VALUES ('c-broker',1,'synthetic','0.01','1','0',$1)`,
        [at],
      );
      await raw.query(
        `INSERT INTO resolution_market_state(condition_id,action,effective_action,computed_at) VALUES ('c-broker','NONE','NONE',$1)`,
        [now],
      );
      await raw.query(
        `INSERT INTO resolution_runtime_state(runtime_id,generation,score_version,ready,started_at,ready_at,heartbeat_at,lease_expires_at,last_success_at,graph_evaluated_at,graph_valid_until,processed_resolution_event_id,processed_rule_version_id,processed_input_change_id)
      VALUES (1,$1,'fixture',true,$2,$2,$2,$2::timestamptz+interval '1 hour',$2,$2,$2::timestamptz+interval '1 hour',
        (SELECT COALESCE(max(resolution_event_id),0) FROM polymarket_resolution_events),
        (SELECT COALESCE(max(rule_version_id),0) FROM polymarket_rule_versions),
        (SELECT COALESCE(max(input_change_id),0) FROM polymarket_resolution_input_changes))`,
        [randomUUID(), now],
      );
      const pool: PaperPool = { ...wrap(raw), transaction: tx };
      const input = {
        orderId: "broker",
        conditionId: "c-broker",
        source: "manual" as const,
        draft: {
          tokenId: "broker",
          side: "BUY" as const,
          orderType: "GTC" as const,
          limitPrice: "0.50",
          size: "10",
        },
      };
      const accepted = await acceptPaperOrder(pool, input, {
        clock: () => now,
      });
      expect(accepted.status).toBe("accepted");
      expect(parseScaled((await row("broker")).cash_remaining_usd)).toBe(
        parseScaled("5"),
      );
      expect(
        await acceptPaperOrder(pool, input, {
          clock: () => new Date(now.getTime() + 2000),
        }),
      ).toEqual(accepted);
      expect(
        await acceptPaperOrder(
          pool,
          { ...input, draft: { ...input.draft, size: "11" } },
          { clock: () => now },
        ),
      ).toMatchObject({
        status: "rejected",
        reason: "FIN05_ACCEPTANCE_CONFLICT",
      });
      expect(
        await requestCancel(pool, "broker", {
          clock: () => new Date(now.getTime() + 2000),
        }),
      ).toEqual({ status: "requested" });
      expect(parseScaled((await row("broker")).cash_remaining_usd)).toBe(
        parseScaled("5"),
      );
      const concurrentInput = { ...input, orderId: "broker-concurrent" };
      const retries = await Promise.all([
        acceptPaperOrder(pool, concurrentInput, { clock: () => now }),
        acceptPaperOrder(pool, concurrentInput, { clock: () => now }),
      ]);
      expect(retries).toEqual([accepted, accepted]);
      expect(
        (
          await raw.query(
            "SELECT 1 FROM paper_ledger_events WHERE order_id='broker-concurrent' AND event_type='order_accepted'",
          )
        ).rowCount,
      ).toBe(1);
      await raw.query("UPDATE paper_kill_switch SET engaged=true");
      expect(await acceptPaperOrder(pool, input, { clock: () => now })).toEqual(
        accepted,
      );
      await raw.query("UPDATE paper_kill_switch SET engaged=false");

      // FIN-06: full bridge -> broker -> reservation -> attributed fill.
      await raw.query(
        `INSERT INTO polymarket_market_metadata_versions(condition_id,version,question,clob_token_ids,affirmative_token_id,valid_from)
        VALUES ('c-broker',1,'Synthetic binary fixture','["broker-yes","broker-no"]','broker-yes',$1)`,
        [at],
      );
      await raw.query(
        `INSERT INTO polymarket_book_snapshots(token_id,condition_id,received_at,source_ts,bids_json,asks_json)
        VALUES ('broker-yes','c-broker',$1,$1,'[{"price":"0.8","size":"500"}]','[{"price":"0.81","size":"500"}]'),
               ('broker-no','c-broker',$1,$1,'[{"price":"0.39","size":"10"}]','[{"price":"0.4","size":"10"}]')`,
        [now],
      );
      await raw.query(
        `UPDATE resolution_runtime_state SET processed_input_change_id=(SELECT COALESCE(max(input_change_id),0) FROM polymarket_resolution_input_changes)`,
      );
      const decision = await raw.query(
        `INSERT INTO portfolio_decisions(decision_kind,condition_id,token_id,market_side,order_side,decision_ts,q_lo,q_hi,exec_price,size_shares,binding_constraint,limiters_json,config_version,config_hash,factor_map_version,oldest_input_ts,newest_input_ts,book_json,inputs_json,outcome,portfolio_state)
        VALUES ('ENTRY','c-broker','broker-no','NO','BUY',$1,'0.250000','0.350000','0.400000','10.000000','DEPTH_TAKE_PCT','[]','fixture',$2,'fixture',$1,$1,'{}','{"entry_contract_version":2,"account_id":"paper","strategy_id":"main"}','ACCEPTED','NORMAL') RETURNING decision_id`,
        [now, "0".repeat(64)],
      );
      const logs: string[] = [];
      const bridged = await bridgeTick(pool, {
        clock: () => now,
        logSink: (line) => logs.push(line),
      });
      expect(bridged, logs.join("\n")).toMatchObject({
        accepted: 1,
        skipped: 0,
      });
      const id = `portfolio:${decision.rows[0].decision_id}`;
      const order = (
        await raw.query("SELECT * FROM paper_orders WHERE order_id=$1", [id])
      ).rows[0];
      expect(order).toMatchObject({
        token_id: "broker-no",
        side: "BUY",
        size: "10.00",
        limit_price: "0.40",
      });
      expect(parseScaled((await row(id)).cash_remaining_usd)).toBe(
        parseScaled("4"),
      );
      await appendLedgerEvent(pool, {
        idempotencyKey: `${id}:fill`,
        eventType: "fill",
        orderId: id,
        tokenId: "broker-no",
        conditionId: "c-broker",
        payload: { side: "BUY", size: "10", price: "0.4", fee: "0" },
        eventTs: now,
      });
      const attributed = await loadAttributedLedgerEvents(pool, {
        accountId: "paper",
        strategyId: "main",
        tokenId: "broker-no",
      });
      expect(attributed.filter((e) => e.eventType === "fill")).toHaveLength(1);
      expect(
        attributed.find((e) => e.eventType === "fill")?.owner,
      ).toMatchObject({ accountId: "paper", strategyId: "main" });
      expect((await row(id)).state).toBe("consumed");
    });
  },
);
