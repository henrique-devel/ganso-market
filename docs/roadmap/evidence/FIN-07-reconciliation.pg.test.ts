import { computeExposures } from "../../../src/polymarket/portfolio/exposure.js";
import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
// FIN-07: independent FIN-01 monetary oracles through real PostgreSQL.
// The caller owns the disposable database; schemas and guards are retained.
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SqlExecutor } from "../../../src/database.js";
import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import type { PaperPool } from "../../../src/polymarket/paper/brokerstore.js";
import { financialOwnerKey } from "../../../src/polymarket/paper/financial.js";
import { loadOwnerFinancialState } from "../../../src/polymarket/paper/financialstore.js";
import {
  appendLedgerEvent,
  loadLedgerEvents,
  replayLedger,
  type LedgerEventInput,
} from "../../../src/polymarket/paper/ledger.js";
import {
  loadPaperPnl,
  loadOpenPositions,
  type PaperPnl,
} from "../../../src/polymarket/portfolio/exitstore.js";
import {
  evaluateState,
  utcDayBucket,
  utcWeekStart,
  type PortfolioStateSnapshot,
} from "../../../src/polymarket/portfolio/state.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const RUN = randomUUID().replaceAll("-", "");
const SCHEMA = `fin07_${RUN}`;
const DAY12 = new Date("2026-09-12T23:59:59.950Z");
const DAY13 = new Date("2026-09-13T00:06:00.000Z");

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) throw new Error(`invalid fixture decimal: ${value}`);
  return parsed;
}

function wrap(client: pg.Pool | pg.PoolClient): SqlExecutor {
  return {
    async query<R extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) {
      const result = await client.query<R>(text, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

function poolOptions(): pg.PoolConfig {
  return {
    connectionString: DATABASE_URL,
    max: 4,
    options: `-c search_path=${SCHEMA} -c statement_timeout=10000 -c lock_timeout=5000`,
    application_name: SCHEMA,
  };
}

async function transaction<T>(
  raw: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await raw.connect();
  try {
    await client.query("BEGIN");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function store(raw: pg.Pool): PaperPool {
  return {
    ...wrap(raw),
    transaction: (run) => transaction(raw, (client) => run(wrap(client))),
  };
}

async function owner(
  raw: pg.Pool,
  strategy: string,
  capital: string,
): Promise<void> {
  // Capital belongs to the synthetic fixture, never an inferred runtime seed.
  // Insert BEFORE the prospective order trigger creates an unknown-capital row.
  await raw.query(
    `INSERT INTO paper_financial_owners
       (account_id, strategy_id, initial_cash_usd, capital_source_ref)
     VALUES ('paper', $1, $2, 'FIN-01:synthetic-fixture')`,
    [strategy, capital],
  );
}

async function order(
  raw: pg.Pool,
  id: string,
  token: string,
  strategy: string,
  side: "BUY" | "SELL" = "BUY",
): Promise<void> {
  await raw.query(
    `INSERT INTO paper_orders
       (order_id, token_id, condition_id, side, order_type, limit_price,
        size, source, strategy_id, status, decided_at, accepted_at)
     VALUES ($1, $2, $3, $4, 'GTC', '0.400000', '20.000000',
             'fast', $5, 'open', $6, $6)`,
    [
      id,
      token,
      `condition-${token}`,
      side,
      strategy,
      new Date("2026-09-12T00:00:00Z"),
    ],
  );
}

function fill(
  id: string,
  token: string,
  side: "BUY" | "SELL",
  price: string,
  size: string,
  fee = "0",
  at = "2026-09-12T23:58:00Z",
): LedgerEventInput {
  return {
    idempotencyKey: `${id}:fill`,
    eventType: "fill",
    orderId: id,
    tokenId: token,
    conditionId: `condition-${token}`,
    payload: { side, price, size, fee },
    eventTs: new Date(at),
  };
}

function resolution(token: string): LedgerEventInput {
  return {
    idempotencyKey: `${token}:resolution`,
    eventType: "resolution",
    tokenId: token,
    conditionId: `condition-${token}`,
    payload: { outcome_price: "1", fee: "0" },
    eventTs: new Date("2026-09-13T00:05:00Z"),
  };
}

async function book(
  raw: pg.Pool,
  token: string,
  bids: { price: string; size: string }[],
  asks: { price: string; size: string }[],
  source: Date | null = DAY12,
  received: Date = DAY12,
): Promise<void> {
  await raw.query(
    `INSERT INTO polymarket_book_snapshots
       (token_id, condition_id, bids_json, asks_json, source_ts, received_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)`,
    [
      token,
      `condition-${token}`,
      JSON.stringify(bids),
      JSON.stringify(asks),
      source,
      received,
    ],
  );
}

function evaluate(
  pnl: PaperPnl,
  now: Date,
  capital: string,
  current?: Partial<PortfolioStateSnapshot>,
) {
  return evaluateState({
    now,
    current: {
      state: "NORMAL",
      reason: null,
      bankrollScaled: s(capital),
      highWaterMarkScaled: s(capital),
      equityScaled: s(capital),
      drawdownScaled: 0n,
      realizedPnlDayScaled: 0n,
      realizedPnlWeekScaled: 0n,
      dayBucket: utcDayBucket(now),
      weekStart: utcWeekStart(now),
      reduceOnlyUntil: null,
      haltedAt: null,
      manualHalt: false,
      ...current,
    },
    limits: {
      perdaDiariaMaxScaled: s("0.03"),
      perdaSemanalMaxScaled: s("0.06"),
      drawdownMaxScaled: s("0.10"),
      reduceOnlyWeekDays: 7,
    },
    bankrollBaseScaled: s(capital),
    realizedPnlTotalScaled: pnl.realizedTotalScaled,
    realizedPnlDayScaled: pnl.realizedDayScaled,
    realizedPnlWeekScaled: pnl.realizedWeekScaled,
    openMarkScaled: pnl.openMarkScaled,
    openCostScaled: pnl.openCostScaled,
    financial: pnl.financial,
  });
}

import {
  reserveOrder,
  reconcileReservations,
} from "../../../src/polymarket/paper/reservations.js";
import { formatScaled } from "../../../src/polymarket/fundamental/fixed.js";
describe.skipIf(DATABASE_URL === undefined)(
  "FIN-07 exact reconciliation",
  () => {
    let admin: pg.Pool | undefined;
    let raw: pg.Pool;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
      const identity = await admin.query<{ database: string }>(
        "SELECT current_database() AS database",
      );
      if (!identity.rows[0]?.database.includes("test")) {
        throw new Error(
          "FIN-03 requires an explicitly disposable *test* database",
        );
      }
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      raw = new pg.Pool(poolOptions());
      const directory = new URL("../../../../../migrations/", import.meta.url);
      const names = (await readdir(directory))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort();
      for (const name of names) {
        const source = await readFile(new URL(name, directory), "utf8");
        const sql = source
          .replaceAll(":'migration_version'", `'${name.slice(0, 4)}'`)
          .replaceAll(
            ":'migration_checksum'",
            `'${createHash("sha256").update(source).digest("hex")}'`,
          );
        await transaction(raw, async (client) => {
          await client.query(sql);
        });
      }
    }, 60_000);

    afterAll(async () => {
      await raw?.end();
      await admin?.end();
    });

    const caps = {
      entrada: 1,
      mercado: 1,
      grupoCorrelacionado: 1,
      categoria: 1,
      fonteResolucao: 1,
      catalisadorJanela: 1,
      capitalBloqueado: 1,
    };
    const dec = (v: string) => formatScaled(s(v), 9);
    async function checkpoint(
      strategy: string,
      capital: string,
      now: Date,
      expected: {
        cash: string;
        realized: string;
        fees: string;
        equity: string | null;
        day: string;
        week: string;
        risk: string;
        positions: [string, string, string, string, string, string | null][];
      },
      pool = raw,
    ) {
      const selected = { accountId: "paper", strategyId: strategy, now };
      const pnl = await loadPaperPnl(store(pool), selected);
      const state = pnl.ownerState!;
      expect(state.cashUsd).toBe(dec(expected.cash));
      expect(state.realizedPnlUsd).toBe(dec(expected.realized));
      expect(state.feesPaidUsd).toBe(dec(expected.fees));
      expect(state.equityUsd).toBe(
        expected.equity === null ? null : dec(expected.equity),
      );
      expect(pnl.realizedDayScaled).toBe(s(expected.day));
      expect(pnl.realizedWeekScaled).toBe(s(expected.week));
      if (expected.equity !== null)
        expect(evaluate(pnl, now, capital).next.equityScaled).toBe(
          s(expected.equity),
        );
      else
        expect(evaluate(pnl, now, capital).next.reason).toBe(
          "financial_data_unavailable",
        );
      for (const [token, q, b, r, f, m] of expected.positions) {
        const p = state.positions.get(token)!;
        expect([
          p.shares,
          p.costBasisUsd,
          p.realizedPnlUsd,
          p.feesPaidUsd,
        ]).toEqual([q, b, r, f].map(dec));
        if (s(q) !== 0n)
          expect(p.markValueSignedUsd).toBe(m === null ? null : dec(m));
        const cache = await pool.query(
          "SELECT shares,cost_basis_usd,realized_pnl_usd,fees_paid_usd,mark_value_signed_usd,mark_stale FROM paper_owner_positions WHERE strategy_id=$1 AND token_id=$2 AND accounting_version='financial-v2'",
          [strategy, token],
        );
        expect(cache.rows).toEqual([
          {
            shares: p.shares,
            cost_basis_usd: p.costBasisUsd,
            realized_pnl_usd: p.realizedPnlUsd,
            fees_paid_usd: p.feesPaidUsd,
            mark_value_signed_usd: p.markValueSignedUsd,
            mark_stale: p.markStale,
          },
        ]);
      }
      const positions = await loadOpenPositions(store(pool), state);
      const risks = computeExposures({
        positions: positions.map((p) => ({
          ...p,
          clauseFamily: "unknown",
          factor: "shared",
          catalystWindow: "shared",
          unwindCostScaled: null,
          remainingFeesScaled: 0n,
        })),
        caps: DEFAULT_PORTFOLIO_CONFIG.caps,
        bankrollScaled: s(capital),
      });
      expect(
        risks.find((r) => r.dimension === "total")?.worstCaseScaled ?? 0n,
      ).toBe(s(expected.risk));
      return pnl;
    }
    async function mark(token: string, price: string, now = DAY12) {
      await book(
        raw,
        token,
        [{ price, size: "10000" }],
        [{ price, size: "10000" }],
        now,
        now,
      );
    }
    let economicIndex = 0;
    async function economic(
      strategy: string,
      token: string,
      id: string,
      side: "BUY" | "SELL",
      price: string,
      size: string,
    ) {
      await order(raw, id, token, strategy, side);
      const event = fill(
        id,
        token,
        side,
        price,
        size,
        "0",
        new Date(
          Date.parse("2026-09-12T23:58:00Z") + economicIndex++ * 1000,
        ).toISOString(),
      );
      await appendLedgerEvent(wrap(raw), event);
      return event;
    }
    it("F1 short partial reduction and settlement, exact cash/basis/risk", async () => {
      const a = "f1",
        t = "YES-L";
      await owner(raw, a, "1000.000000000");
      await economic(a, t, "f1-open", "SELL", "0.4", "10");
      await mark(t, "0.5");
      await checkpoint(a, "1000", DAY12, {
        cash: "1004",
        realized: "0",
        fees: "0",
        equity: "999",
        day: "0",
        week: "0",
        risk: "6",
        positions: [[t, "-10", "4", "0", "0", "-5"]],
      });
      const event = await economic(a, t, "f1-close", "BUY", "0.5", "4");
      await checkpoint(a, "1000", DAY12, {
        cash: "1002",
        realized: "-0.4",
        fees: "0",
        equity: "999",
        day: "-0.4",
        week: "-0.4",
        risk: "3.6",
        positions: [[t, "-6", "2.4", "-0.4", "0", "-3"]],
      });
      expect(await appendLedgerEvent(wrap(raw), event)).toBe(false);
      await appendLedgerEvent(wrap(raw), resolution(t));
      await checkpoint(a, "1000", DAY13, {
        cash: "996",
        realized: "-4",
        fees: "0",
        equity: "996",
        day: "-3.6",
        week: "-4",
        risk: "0",
        positions: [[t, "0", "0", "-4", "0", null]],
      });
    });
    it("F2 real NO and F3 independent losses sum to 70", async () => {
      await owner(raw, "f2", "1000.000000000");
      await economic("f2", "NO-real", "f2-buy", "BUY", "0.6", "10");
      await mark("NO-real", "0.5");
      await checkpoint("f2", "1000", DAY12, {
        cash: "994",
        realized: "0",
        fees: "0",
        equity: "999",
        day: "0",
        week: "0",
        risk: "6",
        positions: [["NO-real", "10", "6", "0", "0", "5"]],
      });
      await appendLedgerEvent(wrap(raw), {
        ...resolution("NO-real"),
        payload: { outcome_price: "0", fee: "0" },
      });
      await checkpoint("f2", "1000", DAY13, {
        cash: "994",
        realized: "-6",
        fees: "0",
        equity: "994",
        day: "-6",
        week: "-6",
        risk: "0",
        positions: [["NO-real", "0", "0", "-6", "0", null]],
      });
      await owner(raw, "f3", "1000.000000000");
      for (const [t, p] of [
        ["X", "0.3"],
        ["Y", "0.4"],
      ] as const) {
        await economic("f3", t, `f3-${t}`, "BUY", p, "100");
        await mark(t, p);
      }
      await checkpoint("f3", "1000", DAY12, {
        cash: "930",
        realized: "0",
        fees: "0",
        equity: "1000",
        day: "0",
        week: "0",
        risk: "70",
        positions: [
          ["X", "100", "30", "0", "0", "30"],
          ["Y", "100", "40", "0", "0", "40"],
        ],
      });
      for (const t of ["X", "Y"])
        await appendLedgerEvent(wrap(raw), {
          ...resolution(t),
          payload: { outcome_price: "0", fee: "0" },
        });
      await checkpoint("f3", "1000", DAY13, {
        cash: "930",
        realized: "-70",
        fees: "0",
        equity: "930",
        day: "-70",
        week: "-70",
        risk: "0",
        positions: [
          ["X", "0", "0", "-30", "0", null],
          ["Y", "0", "0", "-40", "0", null],
        ],
      });
    });
    it("F6 nano basis residue and unavailable mark", async () => {
      const a = "f6",
        t = "rounding";
      await owner(raw, a, "10.000000000");
      await economic(a, t, "f6-a", "BUY", "0.3", "1");
      await economic(a, t, "f6-b", "BUY", "0.35", "2");
      await checkpoint(a, "10", DAY12, {
        cash: "9",
        realized: "0",
        fees: "0",
        equity: null,
        day: "0",
        week: "0",
        risk: "1",
        positions: [[t, "3", "1", "0", "0", null]],
      });
      await mark(t, "0.4");
      const rows = [
        ["9.4", "2", "0.666666667", "0.066666667", "0.8"],
        ["9.8", "1", "0.333333333", "0.133333333", "0.4"],
        ["10.2", "0", "0", "0.2", null],
      ] as const;
      for (const [i, [cash, q, b, r, m]] of rows.entries()) {
        await economic(a, t, `f6-s${i}`, "SELL", "0.4", "1");
        await checkpoint(a, "10", DAY12, {
          cash,
          realized: r,
          fees: "0",
          equity: "10.2",
          day: r,
          week: r,
          risk: b,
          positions: [[t, q, b, r, "0", m]],
        });
      }
    });
    async function accept(
      strategy: string,
      id: string,
      token: string,
      size: string,
      price: string,
      side = "BUY",
      now = new Date("2026-09-12T23:57:00Z"),
    ) {
      return transaction(raw, async (client) => {
        const db = wrap(client);
        await db.query(
          `INSERT INTO paper_orders(order_id,token_id,condition_id,side,order_type,limit_price,worst_price,size,source,strategy_id,status,decided_at,accepted_at) VALUES($1,$2,$3,$4,'FAK',$5,$5,$6,'fast',$7,'open',$8,$8)`,
          [id, token, `condition-${token}`, side, price, size, strategy, now],
        );
        const reservation = await reserveOrder(db, id, now, caps);
        const event: LedgerEventInput = {
          idempotencyKey: `${id}:accepted`,
          eventType: "order_accepted",
          orderId: id,
          tokenId: token,
          conditionId: `condition-${token}`,
          payload: { side, reservation },
          eventTs: now,
        };
        await appendLedgerEvent(db, event);
        return event;
      });
    }
    async function reserves(
      strategy: string,
      cash: string,
      risk: string,
      inventory: string,
    ) {
      const r = await raw.query(
        `SELECT coalesce(sum(cash_remaining_usd),0)::text AS cash,coalesce(sum(risk_remaining_usd),0)::text AS risk,coalesce(sum(CASE WHEN inventory_side IS NOT NULL THEN shares_remaining ELSE 0 END),0)::text AS inventory FROM paper_order_reservations WHERE strategy_id=$1`,
        [strategy],
      );
      expect([
        s(r.rows[0].cash),
        s(r.rows[0].risk),
        s(r.rows[0].inventory),
      ]).toEqual([cash, risk, inventory].map(s));
    }
    it("F4 simultaneous owners finite partition, reservations, UTC PnL, cache rebuild and restart", async () => {
      const a = "f4a",
        b = "f4b",
        t = "shared-T";
      await owner(raw, a, "500.000000000");
      await owner(raw, b, "500.000000000");
      await raw.query(
        `INSERT INTO polymarket_param_versions(condition_id,version,content_hash,taker_fee_bps,valid_from) VALUES($1,1,'FIN07-synthetic','400','2026-09-12T00:00:00Z')`,
        [`condition-${t}`],
      );
      const accepted = await Promise.all([
        accept(a, "a1", t, "10", "0.4"),
        accept(b, "b1", t, "5", "0.6"),
      ]);
      await reserves(a, "4.1", "4.1", "0");
      await reserves(b, "3.05", "3.05", "0");
      // A cannot borrow B's unspent cash.
      await expect(accept(a, "overspend", t, "1000", "0.5")).rejects.toThrow(
        "FIN05_CASH_UNAVAILABLE",
      );
      const events = [
        fill("a1", t, "BUY", "0.4", "10", "0.1"),
        fill("b1", t, "BUY", "0.6", "5", "0.05", "2026-09-12T23:58:30Z"),
      ];
      await Promise.all(events.map((e) => appendLedgerEvent(wrap(raw), e)));
      await reserves(a, "0", "0", "0");
      await reserves(b, "0", "0", "0");
      await expect(
        accept(b, "oversell", t, "6", "0.7", "SELL", DAY12),
      ).rejects.toThrow("FIN05_INVENTORY_UNAVAILABLE");
      await accept(
        a,
        "a2",
        t,
        "4",
        "0.7",
        "SELL",
        new Date("2026-09-12T23:59:00Z"),
      );
      await reserves(a, "0.04", "0.04", "4");
      const sale = fill(
        "a2",
        t,
        "SELL",
        "0.7",
        "4",
        "0.04",
        "2026-09-12T23:59:59.900Z",
      );
      await appendLedgerEvent(wrap(raw), sale);
      await mark(t, "0.5");
      const ea = {
        cash: "498.66",
        realized: "1.06",
        fees: "0.14",
        equity: "501.66",
        day: "1.06",
        week: "1.06",
        risk: "2.4",
        positions: [[t, "6", "2.4", "1.06", "0.14", "3"]] as [
          string,
          string,
          string,
          string,
          string,
          string | null,
        ][],
      };
      const eb = {
        cash: "496.95",
        realized: "-0.05",
        fees: "0.05",
        equity: "499.45",
        day: "-0.05",
        week: "-0.05",
        risk: "3",
        positions: [[t, "5", "3", "-0.05", "0.05", "2.5"]] as [
          string,
          string,
          string,
          string,
          string,
          string | null,
        ][],
      };
      const pa = await checkpoint(a, "500", DAY12, ea),
        pb = await checkpoint(b, "500", DAY12, eb);
      expect(s(pa.ownerState!.cashUsd!) + s(pb.ownerState!.cashUsd!)).toBe(
        s("995.61"),
      );
      expect(pa.financial!.equityScaled! + pb.financial!.equityScaled!).toBe(
        s("1001.11"),
      );
      expect(pa.realizedDayScaled + pb.realizedDayScaled).toBe(s("1.01"));
      await reserves(a, "0", "0", "0");
      await reserves(b, "0", "0", "0");
      // Versioned legacy discrepancy: token-only basis mixes A and B at a2.
      // This is explained evidence, NOT a financial-v2 reconciliation tolerance.
      const legacy = replayLedger(
        (await loadLedgerEvents(wrap(raw))).filter((e) => e.tokenId === t),
      );
      expect(legacy.positions.get(t)).toMatchObject({
        shares: "11.000000",
        costUsd: "5.133333",
        realizedPnlUsd: "0.743333",
        feesPaidUsd: "0.190000",
      });
      expect(
        pa.realizedTotalScaled +
          pb.realizedTotalScaled -
          s(legacy.realizedPnlUsd),
      ).toBe(s("0.266667"));
      // Keep both cash and inventory reservations active through reconstruction.
      await accept(a, "a-pending", t, "2", "0.4", "BUY", DAY12);
      await accept(b, "b-pending", t, "3", "0.7", "SELL", DAY12);
      await reserves(a, "0.82", "0.82", "0");
      await reserves(b, "0.03", "0.03", "3");
      const caches = () =>
        raw.query(
          `SELECT to_jsonb(p)-'updated_at' AS value FROM paper_owner_positions p WHERE strategy_id=ANY($1) ORDER BY strategy_id,token_id`,
          [[a, b]],
        );
      const reservationRows = () =>
        raw.query(
          `SELECT to_jsonb(r)-'updated_at' AS value FROM paper_order_reservations r WHERE strategy_id=ANY($1) ORDER BY order_id`,
          [[a, b]],
        );
      const ledger = () =>
        raw.query(
          `SELECT * FROM paper_ledger_events WHERE token_id=$1 ORDER BY event_id`,
          [t],
        );
      const before = await caches(),
        reservedBefore = await reservationRows(),
        ledgerBefore = await ledger();
      await raw.query(
        "UPDATE paper_owner_positions SET shares='0.000000000',cost_basis_usd='0.000000000',realized_pnl_usd='99.000000000' WHERE strategy_id=ANY($1)",
        [[a, b]],
      );
      await raw.query(
        "UPDATE paper_order_reservations SET cash_remaining_usd=0,risk_remaining_usd=0,shares_remaining=0 WHERE strategy_id=ANY($1)",
        [[a, b]],
      );
      await raw.end();
      raw = new pg.Pool(poolOptions());
      for (const strategyId of [a, b])
        await transaction(raw, (c) =>
          reconcileReservations(wrap(c), { accountId: "paper", strategyId }),
        );
      expect(await checkpoint(a, "500", DAY12, ea)).toEqual(pa);
      expect(await checkpoint(b, "500", DAY12, eb)).toEqual(pb);
      expect((await caches()).rows).toEqual(before.rows);
      expect((await reservationRows()).rows).toEqual(reservedBefore.rows);
      for (const e of [...accepted, ...events, sale])
        expect(await appendLedgerEvent(wrap(raw), e)).toBe(false);
      expect((await ledger()).rows).toEqual(ledgerBefore.rows);
      expect((await reservationRows()).rows).toEqual(reservedBefore.rows);
      await appendLedgerEvent(wrap(raw), resolution(t));
      await checkpoint(a, "500", DAY13, {
        cash: "504.66",
        realized: "4.66",
        fees: "0.14",
        equity: "504.66",
        day: "3.6",
        week: "4.66",
        risk: "0",
        positions: [[t, "0", "0", "4.66", "0.14", null]],
      });
      await checkpoint(b, "500", DAY13, {
        cash: "501.95",
        realized: "1.95",
        fees: "0.05",
        equity: "501.95",
        day: "2",
        week: "1.95",
        risk: "0",
        positions: [[t, "0", "0", "1.95", "0.05", null]],
      });
      await reserves(a, "0", "0", "0");
      await reserves(b, "0", "0", "0");
      expect(await appendLedgerEvent(wrap(raw), resolution(t))).toBe(false);
      const monday = new Date("2026-09-14T00:00:00Z");
      const next = await loadPaperPnl(store(raw), {
        accountId: "paper",
        strategyId: a,
        now: monday,
      });
      expect([
        next.realizedDayScaled,
        next.realizedWeekScaled,
        next.realizedTotalScaled,
      ]).toEqual([0n, 0n, s("4.66")]);
      const replay = await loadOwnerFinancialState(
        store(raw),
        { accountId: "paper", strategyId: a },
        monday,
      );
      expect(replay.owners.get(financialOwnerKey("paper", a))!.cashUsd).toBe(
        "504.660000000",
      );
    });
  },
);
