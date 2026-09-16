import { computeExposures } from "../../../src/polymarket/portfolio/exposure.js";
import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
// FIN-03: independent FIN-01 monetary oracles through real PostgreSQL.
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
const SCHEMA = `fin03_${RUN}`;
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

describe.skipIf(DATABASE_URL === undefined)(
  "FIN-03 financial loader (disposable PostgreSQL)",
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

    const pnlFor = (strategyId: string, now = DAY12, pool = raw) =>
      loadPaperPnl(store(pool), {
        accountId: "paper",
        strategyId,
        now,
      });
    const cacheFor = async (strategy: string) =>
      (
        await raw.query(
          `SELECT shares, cost_basis_usd, realized_pnl_usd, fees_paid_usd,
            mark_value_signed_usd, mark_stale, resolved_at
       FROM paper_owner_positions
      WHERE account_id = 'paper' AND strategy_id = $1
        AND ownership_version = 1 AND accounting_version = 'financial-v2'
      ORDER BY token_id`,
          [strategy],
        )
      ).rows;

    it("FIN-04 loads owner quantities, fees and zero filtering without token-netting", async () => {
      const token = `fin04-${RUN}`;
      const a = `fin04a-${RUN}`;
      const b = `fin04b-${RUN}`;
      await owner(raw, a, "500.000000000");
      await owner(raw, b, "500.000000000");
      await order(raw, `${a}-buy`, token, a);
      await order(raw, `${b}-sell`, token, b, "SELL");
      await appendLedgerEvent(
        wrap(raw),
        fill(`${a}-buy`, token, "BUY", "0.4", "10", "0.1"),
      );
      await appendLedgerEvent(
        wrap(raw),
        fill(`${b}-sell`, token, "SELL", "0.4", "10", "0.2"),
      );
      const pnlA = await pnlFor(a);
      const pnlB = await pnlFor(b);
      // Legacy compatibility still parses on the same migrated database; the
      // attributed replay has no dependency on this empty token-net cache.
      expect(await loadOpenPositions(store(raw))).toEqual([]);
      const positionsA = await loadOpenPositions(store(raw), pnlA.ownerState!);
      const positionsB = await loadOpenPositions(store(raw), pnlB.ownerState!);
      expect(positionsA).toHaveLength(1);
      expect(positionsB).toHaveLength(1);
      expect(positionsA[0]).toMatchObject({
        accountId: "paper",
        strategyId: a,
        tokenId: token,
        sharesScaled: s("10"),
        costScaled: s("4"),
        feesPaidScaled: s("0.1"),
        realizedPnlScaled: -s("0.1"),
      });
      expect(positionsB[0]).toMatchObject({
        accountId: "paper",
        strategyId: b,
        sharesScaled: -s("10"),
        costScaled: s("4"),
        feesPaidScaled: s("0.2"),
        realizedPnlScaled: -s("0.2"),
      });
      const rows = computeExposures({
        positions: [...positionsA, ...positionsB].map((p) => ({
          ...p,
          clauseFamily: "unknown",
          factor: "shared",
          catalystWindow: "shared",
          unwindCostScaled: null,
          remainingFeesScaled: 0n,
        })),
        caps: DEFAULT_PORTFOLIO_CONFIG.caps,
        bankrollScaled: s("1000"),
      });
      // Separate loss maxima: long 4, short 6; paid fees 0.3 already in R.
      expect(rows.find((row) => row.dimension === "total")).toMatchObject({
        worstCaseScaled: s("10"),
        feesPaidScaled: s("0.3"),
        realizedPnlScaled: -s("0.3"),
      });
      await appendLedgerEvent(wrap(raw), resolution(token));
      const closed = await pnlFor(a, DAY13);
      expect(await loadOpenPositions(store(raw), closed.ownerState!)).toEqual(
        [],
      );
      // A zero canonical string such as 0.000000000 must not create a position.
      expect(
        await loadOpenPositions(
          store(raw),
          (await pnlFor(b, DAY13)).ownerState!,
        ),
      ).toEqual([]);
    });

    it("F4 keeps each owner's basis, fees and equity, then realizes separate UTC days", async () => {
      const token = `f4-${RUN}`;
      const a = `f4a-${RUN}`;
      const b = `f4b-${RUN}`;
      await owner(raw, a, "500.000000000");
      await owner(raw, b, "500.000000000");
      await order(raw, `${a}-buy`, token, a);
      await order(raw, `${a}-sell`, token, a, "SELL");
      await order(raw, `${b}-buy`, token, b);
      const sale = fill(
        `${a}-sell`,
        token,
        "SELL",
        "0.7",
        "4",
        "0.04",
        "2026-09-12T23:59:59.900Z",
      );
      for (const event of [
        fill(`${a}-buy`, token, "BUY", "0.4", "10", "0.1"),
        fill(
          `${b}-buy`,
          token,
          "BUY",
          "0.6",
          "5",
          "0.05",
          "2026-09-12T23:58:30Z",
        ),
        sale,
      ])
        expect(await appendLedgerEvent(wrap(raw), event)).toBe(true);
      await book(
        raw,
        token,
        [{ price: "0.5", size: "20" }],
        [{ price: "0.6", size: "20" }],
      );
      const a12 = await pnlFor(a);
      const b12 = await pnlFor(b);
      expect(a12).toMatchObject({
        realizedTotalScaled: s("1.06"),
        realizedDayScaled: s("1.06"),
        realizedWeekScaled: s("1.06"),
        openCostScaled: s("2.4"),
        openMarkScaled: s("3"),
        positionsWithStaleMark: 0,
      });
      expect(b12).toMatchObject({
        realizedTotalScaled: s("-0.05"),
        realizedDayScaled: s("-0.05"),
        openCostScaled: s("3"),
        openMarkScaled: s("2.5"),
      });
      expect(a12.financial).toMatchObject({
        initialCashScaled: s("500"),
        equityScaled: s("501.66"),
        unrealizedScaled: s("0.6"),
      });
      expect(b12.financial).toMatchObject({
        initialCashScaled: s("500"),
        equityScaled: s("499.45"),
        unrealizedScaled: s("-0.5"),
      });
      expect(evaluate(a12, DAY12, "500").next.equityScaled).toBe(s("501.66"));
      expect(evaluate(b12, DAY12, "500").next.equityScaled).toBe(s("499.45"));
      expect(await cacheFor(a)).toEqual([
        expect.objectContaining({
          shares: "6.000000000",
          cost_basis_usd: "2.400000000",
          realized_pnl_usd: "1.060000000",
          fees_paid_usd: "0.140000000",
          mark_value_signed_usd: "3.000000000",
          mark_stale: false,
          resolved_at: null,
        }),
      ]);
      expect(await appendLedgerEvent(wrap(raw), sale)).toBe(false);
      expect(await pnlFor(a)).toEqual(a12);
      expect(await appendLedgerEvent(wrap(raw), resolution(token))).toBe(true);
      const a13 = await pnlFor(a, DAY13);
      const b13 = await pnlFor(b, DAY13);
      expect(a13).toMatchObject({
        realizedTotalScaled: s("4.66"),
        realizedDayScaled: s("3.6"),
        realizedWeekScaled: s("4.66"),
        openCostScaled: 0n,
        openMarkScaled: 0n,
      });
      expect(b13).toMatchObject({
        realizedTotalScaled: s("1.95"),
        realizedDayScaled: s("2"),
        realizedWeekScaled: s("1.95"),
      });
      expect(a13.financial?.equityScaled).toBe(s("504.66"));
      expect(b13.financial?.equityScaled).toBe(s("501.95"));
      expect(a13.realizedTotalScaled + b13.realizedTotalScaled).toBe(s("6.61"));
      expect(
        (a13.financial?.equityScaled ?? 0n) +
          (b13.financial?.equityScaled ?? 0n),
      ).toBe(s("1006.61"));
      expect(await appendLedgerEvent(wrap(raw), resolution(token))).toBe(false);
      const restarted = new pg.Pool(poolOptions());
      try {
        expect(await pnlFor(a, DAY13, restarted)).toEqual(a13);
      } finally {
        await restarted.end();
      }
      const currentCache = await cacheFor(a);
      await expect(pnlFor(a, DAY12)).rejects.toThrow("FIN03_FUTURE_EVENT");
      expect(await cacheFor(a)).toEqual(currentCache);
    });

    it("rebuilds a late F4 partial sale into day 12 after resolution was already cached", async () => {
      const strategy = `late-${RUN}`;
      const token = `late-token-${RUN}`;
      await owner(raw, strategy, "500.000000000");
      await order(raw, `${strategy}-buy`, token, strategy);
      await order(raw, `${strategy}-sell`, token, strategy, "SELL");
      await appendLedgerEvent(
        wrap(raw),
        fill(`${strategy}-buy`, token, "BUY", "0.4", "10", "0.1"),
      );
      await appendLedgerEvent(wrap(raw), resolution(token));
      expect((await pnlFor(strategy, DAY13)).realizedTotalScaled).toBe(
        s("5.9"),
      );
      await appendLedgerEvent(
        wrap(raw),
        fill(
          `${strategy}-sell`,
          token,
          "SELL",
          "0.7",
          "4",
          "0.04",
          "2026-09-12T23:59:59.900Z",
        ),
      );
      const rebuilt = await loadOwnerFinancialState(
        store(raw),
        { accountId: "paper", strategyId: strategy },
        DAY13,
      );
      const financial = rebuilt.owners.get(
        financialOwnerKey("paper", strategy),
      );
      expect(financial).toMatchObject({
        cashUsd: "504.660000000",
        equityUsd: "504.660000000",
        realizedPnlUsd: "4.660000000",
        feesPaidUsd: "0.140000000",
      });
      expect(financial?.dailyRealizedPnlUsd).toEqual(
        new Map([
          ["2026-09-12", "1.060000000"],
          ["2026-09-13", "3.600000000"],
        ]),
      );
      expect(await cacheFor(strategy)).toEqual([
        expect.objectContaining({
          shares: "0.000000000",
          cost_basis_usd: "0.000000000",
          realized_pnl_usd: "4.660000000",
          fees_paid_usd: "0.140000000",
        }),
      ]);
      const pnl = await pnlFor(strategy, DAY13);
      expect(
        evaluate(pnl, DAY13, "500", { dayBucket: "2026-09-12" }).next
          .realizedPnlDayScaled,
      ).toBe(s("3.6"));
      // A cache mutation cannot become a second monetary source on restart.
      await raw.query(
        "UPDATE paper_owner_positions SET realized_pnl_usd='99.000000000', cost_basis_usd='20.000000000' WHERE strategy_id=$1",
        [strategy],
      );
      const restarted = new pg.Pool(poolOptions());
      try {
        expect(
          await loadOwnerFinancialState(
            store(restarted),
            { accountId: "paper", strategyId: strategy },
            DAY13,
          ),
        ).toEqual(rebuilt);
      } finally {
        await restarted.end();
      }
    });

    it("F1 values a legacy short against asks and carries its loss into portfolio state", async () => {
      const strategy = `short-${RUN}`;
      const token = `short-token-${RUN}`;
      await owner(raw, strategy, "1000.000000000");
      await order(raw, strategy, token, strategy, "SELL");
      await appendLedgerEvent(
        wrap(raw),
        fill(strategy, token, "SELL", "0.4", "10"),
      );
      await book(
        raw,
        token,
        [{ price: "0.3", size: "20" }],
        [{ price: "0.5", size: "20" }],
      );
      const pnl = await pnlFor(strategy);
      expect(pnl).toMatchObject({
        openCostScaled: s("-4"),
        openMarkScaled: s("-5"),
        realizedTotalScaled: 0n,
        positionsWithStaleMark: 0,
      });
      expect(pnl.financial).toMatchObject({
        equityScaled: s("999"),
        unrealizedScaled: s("-1"),
      });
      expect(evaluate(pnl, DAY12, "1000").next).toMatchObject({
        equityScaled: s("999"),
        highWaterMarkScaled: s("1000"),
        drawdownScaled: s("0.001"),
      });
      const state = await loadOwnerFinancialState(
        store(raw),
        { accountId: "paper", strategyId: strategy },
        DAY12,
      );
      expect(
        state.owners.get(financialOwnerKey("paper", strategy))?.cashUsd,
      ).toBe("1004.000000000");
      await appendLedgerEvent(wrap(raw), resolution(token));
      expect(await pnlFor(strategy, DAY13)).toMatchObject({
        realizedTotalScaled: s("-6"),
        financial: { equityScaled: s("994") },
      });
    });

    it("never nets opposing owners or reuses a token-wide legacy mark as their valuation", async () => {
      const token = `opposing-${RUN}`;
      const long = `long-${RUN}`;
      const short = `offset-${RUN}`;
      for (const strategy of [long, short])
        await owner(raw, strategy, "500.000000000");
      await order(raw, long, token, long);
      await order(raw, short, token, short, "SELL");
      await appendLedgerEvent(wrap(raw), fill(long, token, "BUY", "0.4", "5"));
      await appendLedgerEvent(
        wrap(raw),
        fill(short, token, "SELL", "0.6", "5"),
      );
      await appendLedgerEvent(wrap(raw), {
        idempotencyKey: `${token}:mark`,
        eventType: "mark",
        tokenId: token,
        conditionId: `condition-${token}`,
        payload: { mark_value_usd: "99", stale: false },
        eventTs: DAY12,
      });
      for (const strategy of [long, short]) {
        const noBook = await pnlFor(strategy);
        expect(noBook).toMatchObject({
          positionsWithStaleMark: 1,
          financial: { equityScaled: null, unrealizedScaled: null },
        });
        expect(
          (await cacheFor(strategy))[0]?.["mark_value_signed_usd"],
        ).toBeNull();
        expect(evaluate(noBook, DAY12, "500").next).toMatchObject({
          state: "REDUCE_ONLY",
          reason: "financial_data_unavailable",
          highWaterMarkScaled: s("500"),
        });
      }
      await book(
        raw,
        token,
        [{ price: "0.5", size: "5" }],
        [{ price: "0.7", size: "5" }],
      );
      expect((await pnlFor(long)).financial).toMatchObject({
        equityScaled: s("500.5"),
        unrealizedScaled: s("0.5"),
      });
      expect((await pnlFor(short)).financial).toMatchObject({
        equityScaled: s("499.5"),
        unrealizedScaled: s("-0.5"),
      });
      expect((await cacheFor(long))[0]?.["shares"]).toBe("5.000000000");
      expect((await cacheFor(short))[0]?.["shares"]).toBe("-5.000000000");
      await appendLedgerEvent(wrap(raw), resolution(token));
      expect(await pnlFor(long, DAY13)).toMatchObject({
        realizedTotalScaled: s("3"),
        financial: { equityScaled: s("503") },
      });
      expect(await pnlFor(short, DAY13)).toMatchObject({
        realizedTotalScaled: s("-2"),
        financial: { equityScaled: s("498") },
      });
    });

    it("keeps unestablished capital NULL even with a verified prospective owner and fresh mark", async () => {
      const strategy = `unknown-${RUN}`;
      const token = `unknown-token-${RUN}`;
      await order(raw, strategy, token, strategy);
      await appendLedgerEvent(
        wrap(raw),
        fill(strategy, token, "BUY", "0.4", "10", "0.1"),
      );
      await book(
        raw,
        token,
        [{ price: "0.5", size: "10" }],
        [{ price: "0.6", size: "10" }],
      );
      const pnl = await pnlFor(strategy);
      expect(pnl).toMatchObject({
        realizedTotalScaled: s("-0.1"),
        positionsWithStaleMark: 0,
        financial: {
          initialCashScaled: null,
          equityScaled: null,
          unrealizedScaled: s("1"),
        },
      });
      expect(evaluate(pnl, DAY12, "1000").next).toMatchObject({
        state: "REDUCE_ONLY",
        reason: "financial_data_unavailable",
        highWaterMarkScaled: s("1000"),
        equityScaled: s("1000"),
      });
      const result = await loadOwnerFinancialState(
        store(raw),
        { accountId: "paper", strategyId: strategy },
        DAY12,
      );
      expect(
        result.owners.get(financialOwnerKey("paper", strategy)),
      ).toMatchObject({
        initialCashUsd: null,
        cashUsd: null,
        cashflowUsd: "-4.100000000",
        equityUsd: null,
      });
      expect(
        (
          await raw.query(
            "SELECT initial_cash_usd FROM paper_financial_owners WHERE strategy_id=$1",
            [strategy],
          )
        ).rows,
      ).toEqual([{ initial_cash_usd: null }]);
    });

    it("requires enough executable bid depth and fresh proven source time without erasing the last mark", async () => {
      const strategy = `depth-${RUN}`;
      const token = `depth-token-${RUN}`;
      await owner(raw, strategy, "1000.000000000");
      await order(raw, strategy, token, strategy);
      await appendLedgerEvent(
        wrap(raw),
        fill(strategy, token, "BUY", "0.4", "10"),
      );
      await book(
        raw,
        token,
        [{ price: "0.8", size: "2" }],
        [{ price: "0.9", size: "20" }],
      );
      expect((await pnlFor(strategy)).financial?.equityScaled).toBeNull();
      const fullAt = new Date(DAY12.getTime() + 1);
      await book(
        raw,
        token,
        [
          { price: "0.6", size: "2" },
          { price: "0.5", size: "8" },
        ],
        [{ price: "0.9", size: "20" }],
        fullAt,
        fullAt,
      );
      const full = await pnlFor(strategy, fullAt);
      expect(full).toMatchObject({
        openMarkScaled: s("5.2"),
        positionsWithStaleMark: 0,
        financial: { equityScaled: s("1001.2"), unrealizedScaled: s("1.2") },
      });
      const latestCache = await cacheFor(strategy);
      await expect(pnlFor(strategy, DAY12)).rejects.toThrow(
        "FIN03_PAST_PROJECTION",
      );
      expect(await cacheFor(strategy)).toEqual(latestCache);
      const staleAt = new Date(fullAt.getTime() + 31_000);
      await book(
        raw,
        token,
        [{ price: "0.99", size: "20" }],
        [],
        fullAt,
        staleAt,
      );
      const stale = await pnlFor(strategy, staleAt);
      expect(stale).toMatchObject({
        positionsWithStaleMark: 1,
        financial: { equityScaled: null, unrealizedScaled: null },
      });
      expect((await cacheFor(strategy))[0]).toMatchObject({
        mark_value_signed_usd: "5.200000000",
        mark_stale: true,
      });
      expect(
        evaluate(stale, staleAt, "1000", {
          highWaterMarkScaled: s("1001.2"),
          equityScaled: s("1001.2"),
        }).next,
      ).toMatchObject({
        state: "REDUCE_ONLY",
        highWaterMarkScaled: s("1001.2"),
        equityScaled: s("1001.2"),
      });
      const unknownAt = new Date(staleAt.getTime() + 1);
      await book(
        raw,
        token,
        [{ price: "0.99", size: "20" }],
        [],
        null,
        unknownAt,
      );
      expect(
        (await pnlFor(strategy, unknownAt)).financial?.equityScaled,
      ).toBeNull();
      const futureAt = new Date(unknownAt.getTime() + 1);
      await book(
        raw,
        token,
        [{ price: "0.99", size: "20" }],
        [],
        new Date(futureAt.getTime() + 1_000),
        futureAt,
      );
      expect(
        (await pnlFor(strategy, futureAt)).financial?.equityScaled,
      ).toBeNull();
    });

    it("rolls back a multi-token rebuild atomically while every production guard stays enabled", async () => {
      const strategy = `rollback-${RUN}`;
      const first = `rollback-a-${RUN}`;
      const second = `rollback-b-${RUN}`;
      await owner(raw, strategy, "1000.000000000");
      for (const token of [first, second]) {
        await order(raw, token, token, strategy);
        await appendLedgerEvent(
          wrap(raw),
          fill(token, token, "BUY", "0.4", "1"),
        );
      }
      await raw.query(`CREATE FUNCTION fin03_cache_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.token_id = '${second}' THEN RAISE EXCEPTION 'FIN03_FIXTURE_CACHE_FAILURE'; END IF;
        RETURN NEW;
      END $$`);
      await raw.query(
        "CREATE TRIGGER fin03_cache_failure_trg BEFORE INSERT OR UPDATE ON paper_owner_positions FOR EACH ROW EXECUTE FUNCTION fin03_cache_failure()",
      );
      await expect(pnlFor(strategy)).rejects.toThrow(
        "FIN03_FIXTURE_CACHE_FAILURE",
      );
      expect(await cacheFor(strategy)).toEqual([]);
      expect(
        (
          await raw.query(
            "SELECT count(*)::integer AS count FROM paper_ledger_events WHERE token_id=ANY($1)",
            [[first, second]],
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
      const guards = await raw.query(
        "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid IN ('paper_ledger_events'::regclass, 'paper_financial_owners'::regclass, 'polymarket_book_snapshots'::regclass) AND NOT tgisinternal",
      );
      expect(guards.rows.length).toBeGreaterThan(4);
      expect(guards.rows.every((row) => row["tgenabled"] === "O")).toBe(true);
    });

    it("concurrent owner rebuilds converge after any PostgreSQL snapshot retry", async () => {
      const strategy = `concurrent-${RUN}`;
      const token = `concurrent-token-${RUN}`;
      await owner(raw, strategy, "1000.000000000");
      await order(raw, strategy, token, strategy);
      await appendLedgerEvent(
        wrap(raw),
        fill(strategy, token, "BUY", "0.4", "10", "0.1"),
      );
      await book(
        raw,
        token,
        [{ price: "0.5", size: "10" }],
        [{ price: "0.6", size: "10" }],
      );
      const attempts = await Promise.allSettled([
        pnlFor(strategy),
        pnlFor(strategy),
      ]);
      for (const attempt of attempts) {
        if (attempt.status === "rejected") {
          expect(attempt.reason).toMatchObject({ code: "40001" });
          expect((await pnlFor(strategy)).financial?.equityScaled).toBe(
            s("1000.9"),
          );
        } else {
          expect(attempt.value.financial?.equityScaled).toBe(s("1000.9"));
        }
      }
      expect(await cacheFor(strategy)).toEqual([
        expect.objectContaining({
          shares: "10.000000000",
          cost_basis_usd: "4.000000000",
          realized_pnl_usd: "-0.100000000",
          fees_paid_usd: "0.100000000",
          mark_value_signed_usd: "5.000000000",
        }),
      ]);
    });
  },
);
