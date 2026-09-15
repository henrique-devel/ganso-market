// FIN-02: real PostgreSQL only, with every production guard enabled.
// Each run owns a schema in the explicitly configured disposable database.
// Fixtures are retained: the caller disposes of the test database/container.
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SqlExecutor } from "../../../src/database.js";
import {
  settlementTick,
  type PaperPool,
} from "../../../src/polymarket/paper/brokerstore.js";
import {
  appendLedgerEvent,
  loadLedgerEvents,
  replayLedger,
  type LedgerEventInput,
} from "../../../src/polymarket/paper/ledger.js";
import {
  loadAttributedLedgerEvents,
  loadOpenOwnerTokens,
  OWNERSHIP_VERSION,
} from "../../../src/polymarket/paper/ownership.js";

const DATABASE_URL = process.env.GANSO_TEST_DATABASE_URL;
const RUN = randomUUID().replaceAll("-", "");
const SCHEMA = `fin02_${RUN}`;
const AT = new Date("2026-09-12T23:58:00.000Z");
const OLD_TOKEN = `old-${RUN}`;
const OLD_ORDER = `old-order-${RUN}`;
const FAIL_KEY = `association-failure-${RUN}`;

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

async function order(
  client: pg.Pool | pg.PoolClient,
  id: string,
  token: string,
  strategy: string | null,
  side: "BUY" | "SELL" = "BUY",
): Promise<void> {
  await client.query(
    `INSERT INTO paper_orders
       (order_id, token_id, condition_id, side, order_type, limit_price,
        size, source, strategy_id, status, decided_at, accepted_at)
     VALUES ($1, $2, $3, $4, 'GTC', '0.400000', '20.000000',
             $5, $6, 'open', $7, $7)`,
    [
      id,
      token,
      `condition-${token}`,
      side,
      strategy === null ? "manual" : "fast",
      strategy,
      new Date(AT.getTime() - 1_000),
    ],
  );
}

function fill(
  key: string,
  orderId: string,
  tokenId: string,
  payload: LedgerEventInput["payload"] = {
    side: "BUY",
    price: "0.400000",
    size: "10.000000",
    fee: "0.100000",
  },
  eventTs: Date = AT,
): LedgerEventInput {
  return {
    idempotencyKey: key,
    eventType: "fill",
    orderId,
    tokenId,
    conditionId: `condition-${tokenId}`,
    payload,
    eventTs,
  };
}

function resolution(tokenId: string, key: string): LedgerEventInput {
  return {
    idempotencyKey: key,
    eventType: "resolution",
    tokenId,
    conditionId: `condition-${tokenId}`,
    payload: { outcome_price: "1.000000", fee: "0" },
    eventTs: new Date("2026-09-13T00:05:00.000Z"),
  };
}

// Compare exact decimal values without depending on PostgreSQL's display scale.
function decimal(value: string): string {
  return value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
}

describe.skipIf(DATABASE_URL === undefined)(
  "FIN-02 ownership (disposable PostgreSQL)",
  () => {
    let admin: pg.Pool | undefined;
    let raw: pg.Pool;
    let legacyBytes: Record<string, unknown>[];

    const historicalRows = async (client: pg.Pool | pg.PoolClient) =>
      (
        await client.query(
          `SELECT row_to_json(e)::text AS bytes FROM paper_ledger_events e
           WHERE token_id = $1 ORDER BY event_id`,
          [OLD_TOKEN],
        )
      ).rows;

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
      const identity = await admin.query<{ database: string }>(
        "SELECT current_database() AS database",
      );
      if (!identity.rows[0]?.database.includes("test")) {
        throw new Error(
          "FIN-02 requires an explicitly disposable *test* database",
        );
      }
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      raw = new pg.Pool(poolOptions());
      const directory = new URL("../../../../../migrations/", import.meta.url);
      const names = (await readdir(directory))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort();
      const ownershipName = names.find((name) =>
        name.includes("paper_financial_ownership"),
      );
      expect(ownershipName).toBeDefined();
      for (const name of names) {
        if (name === ownershipName) {
          // This order predates ownership. A NULL strategy must never imply main.
          await order(raw, OLD_ORDER, OLD_TOKEN, null);
          await raw.query(
            `INSERT INTO paper_ledger_events
               (idempotency_key, event_type, order_id, token_id, condition_id,
                payload_json, event_ts)
             VALUES ($1, 'fill', $2, $3, $4,
                     '{"side":"BUY","price":"0.4","size":"2","fee":"0.01"}', $5),
                    ($6, 'fill', NULL, $3, $4,
                     '{"side":"SELL","price":"0.6","size":"1","fee":"0","source":null}', $5),
                    ($7, 'resolution', NULL, $3, $4,
                     '{"outcome_price":"not-a-price"}', $8)`,
            [
              `historic-order-${RUN}`,
              OLD_ORDER,
              OLD_TOKEN,
              `condition-${OLD_TOKEN}`,
              AT,
              `historic-no-order-${RUN}`,
              `historic-invalid-resolution-${RUN}`,
              new Date(AT.getTime() + 1_000),
            ],
          );
          legacyBytes = await historicalRows(raw);
        }
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

    it("matches unfiltered membership across tokens with default cutoffs and net-zero owners", async () => {
      const token = `filtered-${RUN}`;
      const other = `other-filtered-${RUN}`;
      const long = `filtered-long-${RUN}`;
      const short = `filtered-short-${RUN}`;
      const otherOrder = `filtered-other-${RUN}`;
      await order(raw, long, token, long);
      await order(raw, short, token, short, "SELL");
      await order(raw, otherOrder, other, null);
      for (const [id, tokenId, side, size] of [
        [long, token, "BUY", "5"],
        [short, token, "SELL", "5"],
        [otherOrder, other, "BUY", "3"],
      ] as const) {
        await appendLedgerEvent(
          wrap(raw),
          fill(`${id}:fill`, id, tokenId, {
            side,
            price: "0.4",
            size,
            fee: "0",
          }),
        );
      }
      const original = async () =>
        (
          await raw.query(
            `SELECT account_id AS "accountId", strategy_id AS "strategyId",
                  token_id AS "tokenId", condition_id AS "conditionId", shares::text
             FROM paper_open_owner_tokens()
            ORDER BY token_id, account_id, strategy_id`,
          )
        ).rows;
      const all = await original();
      expect(await loadOpenOwnerTokens(wrap(raw))).toEqual(all);
      for (const tokenId of [token, other, `missing-${RUN}`]) {
        expect(await loadOpenOwnerTokens(wrap(raw), tokenId)).toEqual(
          all.filter((row) => row["tokenId"] === tokenId),
        );
      }
      expect(
        all
          .filter((row) => row["tokenId"] === token)
          .map((row) => [row["strategyId"], decimal(row["shares"] as string)]),
      ).toEqual([
        [long, "5"],
        [short, "-5"],
      ]);
      expect(
        all
          .filter((row) => row["tokenId"] === other)
          .map((row) => decimal(row["shares"] as string)),
      ).toEqual(["3"]);
      await appendLedgerEvent(
        wrap(raw),
        resolution(token, `filtered-resolution-${RUN}`),
      );
      expect(await loadOpenOwnerTokens(wrap(raw), token)).toEqual([]);
      expect(await loadOpenOwnerTokens(wrap(raw))).toEqual(await original());
      expect(await loadOpenOwnerTokens(wrap(raw), other)).toEqual(
        all.filter((row) => row["tokenId"] === other),
      );
    });

    it("assigns new manual and fast orders explicitly, without creating capital", async () => {
      const token = `identity-${RUN}`;
      const strategy = `identity-${RUN}`;
      const mainOrder = `manual-${RUN}`;
      const fastOrder = `fast-${RUN}`;
      await order(raw, mainOrder, token, null);
      await order(raw, fastOrder, token, strategy);
      const owners = await raw.query(
        `SELECT order_id, account_id, strategy_id, ownership_version
         FROM paper_order_owners WHERE order_id = ANY($1) ORDER BY order_id`,
        [[mainOrder, fastOrder]],
      );
      expect(OWNERSHIP_VERSION).toBe(1);
      expect(owners.rows).toEqual([
        {
          order_id: fastOrder,
          account_id: "paper",
          strategy_id: strategy,
          ownership_version: 1,
        },
        {
          order_id: mainOrder,
          account_id: "paper",
          strategy_id: "main",
          ownership_version: 1,
        },
      ]);
      const capital = await raw.query(
        `SELECT initial_cash_usd FROM paper_financial_owners
         WHERE account_id = 'paper' AND strategy_id = ANY($1)`,
        [["main", strategy]],
      );
      expect(capital.rows).toHaveLength(2);
      expect(
        capital.rows.every((row) => row["initial_cash_usd"] === null),
      ).toBe(true);
      expect(
        (
          await raw.query(
            "SELECT strategy_id FROM fast_wallet_state WHERE strategy_id = $1",
            [strategy],
          )
        ).rows,
      ).toEqual([]);
    });

    it("preserves F4 fill/fee ownership, partial-exit retry and one resolution for two owners", async () => {
      const token = `f4-${RUN}`;
      const strategyA = `f4a-${RUN}`;
      const strategyB = `f4b-${RUN}`;
      const a1 = `f4-a1-${RUN}`;
      const a2 = `f4-a2-${RUN}`;
      const b1 = `f4-b1-${RUN}`;
      await order(raw, a1, token, strategyA);
      await order(raw, a2, token, strategyA, "SELL");
      await order(raw, b1, token, strategyB);
      const buyA = fill(`${a1}:fill`, a1, token);
      const buyB = fill(
        `${b1}:fill`,
        b1,
        token,
        { side: "BUY", price: "0.600000", size: "5.000000", fee: "0.050000" },
        new Date("2026-09-12T23:58:30.000Z"),
      );
      const sellA = fill(
        `${a2}:fill`,
        a2,
        token,
        { side: "SELL", price: "0.700000", size: "4.000000", fee: "0.040000" },
        new Date("2026-09-12T23:59:59.900Z"),
      );
      for (const event of [buyA, buyB, sellA]) {
        expect(await appendLedgerEvent(wrap(raw), event)).toBe(true);
      }
      const beforeRetry = await loadAttributedLedgerEvents(wrap(raw), {
        tokenId: token,
      });
      expect(await appendLedgerEvent(wrap(raw), sellA)).toBe(false);
      expect(
        await loadAttributedLedgerEvents(wrap(raw), { tokenId: token }),
      ).toEqual(beforeRetry);
      const open = await loadOpenOwnerTokens(wrap(raw), token);
      expect(
        open
          .map((row) => [row.accountId, row.strategyId, decimal(row.shares)])
          .sort(),
      ).toEqual([
        ["paper", strategyA, "6"],
        ["paper", strategyB, "5"],
      ]);
      expect(beforeRetry).toHaveLength(3);
      expect(
        beforeRetry.map((event) => [
          event.owner.strategyId,
          event.payload["fee"],
        ]),
      ).toEqual([
        [strategyA, "0.100000"],
        [strategyB, "0.050000"],
        [strategyA, "0.040000"],
      ]);
      for (const event of beforeRetry) {
        expect(event.owner.accountId).toBe("paper");
        expect(event.owner.ownershipVersion).toBe(1);
        expect(event.owner.attributionStatus).toBe("verified");
        expect(event.owner.evidenceRef).toEqual(expect.any(String));
        expect(event.eventId).toMatch(/^\d+$/);
        expect(event.receivedAt).toBeInstanceOf(Date);
      }
      expect(beforeRetry[2]?.eventTs.toISOString()).toBe(
        "2026-09-12T23:59:59.900Z",
      );
      const resolved = resolution(token, `f4-resolution-${RUN}`);
      expect(await appendLedgerEvent(wrap(raw), resolved)).toBe(true);
      const attributed = await loadAttributedLedgerEvents(wrap(raw), {
        tokenId: token,
      });
      const settlements = attributed.filter(
        (event) => event.eventType === "resolution",
      );
      expect(settlements.map((event) => event.owner.strategyId).sort()).toEqual(
        [strategyA, strategyB],
      );
      expect(new Set(settlements.map((event) => event.eventId)).size).toBe(1);
      expect(
        (await loadLedgerEvents(wrap(raw))).filter(
          (event) => event.tokenId === token,
        ),
      ).toHaveLength(4);
      expect(await loadOpenOwnerTokens(wrap(raw), token)).toEqual([]);
      expect(await appendLedgerEvent(wrap(raw), resolved)).toBe(false);
      const restarted = new pg.Pool(poolOptions());
      try {
        expect(
          await loadAttributedLedgerEvents(wrap(restarted), { tokenId: token }),
        ).toEqual(attributed);
        expect(await loadOpenOwnerTokens(wrap(restarted), token)).toEqual([]);
        expect(
          await loadAttributedLedgerEvents(wrap(restarted), {
            accountId: "paper",
            strategyId: strategyB,
            tokenId: token,
          }),
        ).toHaveLength(2);
      } finally {
        await restarted.end();
      }
    });

    it("keeps opposing owners open when the token aggregate is zero and resolves both", async () => {
      const token = `offset-${RUN}`;
      const long = `long-${RUN}`;
      const short = `short-${RUN}`;
      await order(raw, long, token, long);
      await order(raw, short, token, short, "SELL");
      await appendLedgerEvent(
        wrap(raw),
        fill(`${long}:fill`, long, token, {
          side: "BUY",
          price: "0.4",
          size: "5",
          fee: "0",
        }),
      );
      await appendLedgerEvent(
        wrap(raw),
        fill(`${short}:fill`, short, token, {
          side: "SELL",
          price: "0.6",
          size: "5",
          fee: "0",
        }),
      );
      const open = await loadOpenOwnerTokens(wrap(raw), token);
      expect(
        open.map((row) => [row.strategyId, decimal(row.shares)]).sort(),
      ).toEqual([
        [long, "5"],
        [short, "-5"],
      ]);
      await raw.query(
        `INSERT INTO polymarket_markets
           (condition_id, question, clob_token_ids, closed)
         VALUES ($1, 'FIN-02 opposing owners fixture', $2::jsonb, TRUE)`,
        [`condition-${token}`, JSON.stringify([token, `${token}-no`])],
      );
      await raw.query(
        `INSERT INTO polymarket_resolution_events
           (condition_id, event_type, payload_json, source_ts, received_at)
         VALUES ($1, 'resolved', '{"raw":{"outcomePrices":["1","0"]}}', $2, $2)`,
        [`condition-${token}`, new Date("2026-09-13T00:04:00Z")],
      );
      // The old token cache deliberately says zero. Discovery must use owners.
      await raw.query(
        `INSERT INTO paper_positions (token_id, condition_id, shares, cost_usd)
         VALUES ($1, $2, '0.000000', '0.000000')`,
        [token, `condition-${token}`],
      );
      const store: PaperPool = {
        ...wrap(raw),
        transaction: (run) => transaction(raw, (client) => run(wrap(client))),
      };
      const logs: string[] = [];
      await settlementTick(store, {
        clock: () => new Date("2026-09-13T00:05:00Z"),
        logSink: (line) => logs.push(line),
      });
      expect(
        logs.some((line) => line.includes("PAPER_SETTLEMENT_FAILED")),
      ).toBe(false);
      const owners = (
        await loadAttributedLedgerEvents(wrap(raw), { tokenId: token })
      )
        .filter((event) => event.eventType === "resolution")
        .map((event) => event.owner.strategyId)
        .sort();
      expect(owners).toEqual([long, short]);
      expect(await loadOpenOwnerTokens(wrap(raw), token)).toEqual([]);
      await settlementTick(store, {
        clock: () => new Date("2026-09-13T00:06:00Z"),
        logSink: (line) => logs.push(line),
      });
      const legacyResolutions = (await loadLedgerEvents(wrap(raw))).filter(
        (event) => event.tokenId === token && event.eventType === "resolution",
      );
      expect(legacyResolutions).toHaveLength(1);
    });

    it("refuses divergent retry content or owner and retains the original event", async () => {
      const token = `retry-${RUN}`;
      const first = `retry-a-${RUN}`;
      const other = `retry-b-${RUN}`;
      await order(raw, first, token, first);
      await order(raw, other, token, other);
      const original = fill(`retry-key-${RUN}`, first, token);
      expect(await appendLedgerEvent(wrap(raw), original)).toBe(true);
      const snapshot = await loadAttributedLedgerEvents(wrap(raw), {
        tokenId: token,
      });
      for (const conflicting of [
        { ...original, orderId: other },
        { ...original, payload: { ...original.payload, fee: "0.200000" } },
        { ...original, eventTs: new Date(AT.getTime() + 1) },
      ]) {
        await expect(appendLedgerEvent(wrap(raw), conflicting)).rejects.toThrow(
          /FIN02_IDEMPOTENCY_CONFLICT/,
        );
      }
      expect(await appendLedgerEvent(wrap(raw), original)).toBe(false);
      await expect(
        raw.query(
          `INSERT INTO paper_ledger_owners
             (event_id, account_id, strategy_id, attribution_status, evidence_ref)
           VALUES ($1, 'paper', $2, 'verified', 'FIN-02:test:spoof-order-owner')`,
          [snapshot[0]?.eventId, other],
        ),
      ).rejects.toThrow(/FIN02_OWNERSHIP_CONFLICT/);
      expect(
        await loadAttributedLedgerEvents(wrap(raw), { tokenId: token }),
      ).toEqual(snapshot);
    });

    it("arbitrates concurrent same-key writes from different owners without reassignment", async () => {
      const token = `race-${RUN}`;
      const first = `race-a-${RUN}`;
      const second = `race-b-${RUN}`;
      await order(raw, first, token, first);
      await order(raw, second, token, second);
      let arrivals = 0;
      let release: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const events = [first, second].map((id) =>
        fill(`race-key-${RUN}`, id, token),
      );
      const results = await Promise.allSettled(
        events.map((event) =>
          transaction(raw, async (client) => {
            arrivals += 1;
            if (arrivals === 2) release?.();
            await barrier;
            return appendLedgerEvent(wrap(client), event);
          }),
        ),
      );
      const won = results.filter((result) => result.status === "fulfilled");
      const lost = results.filter((result) => result.status === "rejected");
      expect(won).toEqual([{ status: "fulfilled", value: true }]);
      expect(lost).toHaveLength(1);
      expect(String(lost[0]?.reason)).toMatch(/FIN02_IDEMPOTENCY_CONFLICT/);
      const persisted = await loadAttributedLedgerEvents(wrap(raw), {
        tokenId: token,
      });
      expect(persisted).toHaveLength(1);
      expect([first, second]).toContain(persisted[0]?.owner.strategyId);
      expect(persisted[0]?.owner.strategyId).toBe(persisted[0]?.orderId);
    });

    it("rolls back the order and ledger when an ownership insert fails", async () => {
      const id = `rollback-${RUN}`;
      const token = `rollback-token-${RUN}`;
      await raw.query(`CREATE FUNCTION fin02_test_reject_association() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF EXISTS (SELECT 1 FROM paper_ledger_events
                     WHERE event_id = NEW.event_id AND idempotency_key = '${FAIL_KEY}') THEN
            RAISE EXCEPTION 'FIN02_TEST_ASSOCIATION_FAILURE';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fin02_test_reject_association_trg
          BEFORE INSERT ON paper_ledger_owners FOR EACH ROW
          EXECUTE FUNCTION fin02_test_reject_association();`);
      await expect(
        transaction(raw, async (client) => {
          await order(client, id, token, id);
          await appendLedgerEvent(wrap(client), {
            ...fill(`accepted-${RUN}`, id, token),
            eventType: "order_accepted",
            payload: {},
          });
          await appendLedgerEvent(wrap(client), fill(FAIL_KEY, id, token));
        }),
      ).rejects.toThrow("FIN02_TEST_ASSOCIATION_FAILURE");
      expect(
        (
          await raw.query(
            "SELECT order_id FROM paper_orders WHERE order_id = $1",
            [id],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await raw.query(
            "SELECT order_id FROM paper_order_owners WHERE order_id = $1",
            [id],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await raw.query(
            "SELECT event_id FROM paper_ledger_events WHERE token_id = $1",
            [token],
          )
        ).rows,
      ).toEqual([]);
    });

    it("checks order token, condition and side before persisting attribution", async () => {
      const token = `mismatch-${RUN}`;
      const id = `mismatch-order-${RUN}`;
      await order(raw, id, token, id);
      const event = fill(`mismatch-event-${RUN}`, id, token);
      for (const invalid of [
        { ...event, tokenId: `${token}-other` },
        { ...event, conditionId: "wrong-condition" },
        { ...event, payload: { ...event.payload, side: "SELL" } },
      ]) {
        await expect(appendLedgerEvent(wrap(raw), invalid)).rejects.toThrow(
          /FIN02_OWNERSHIP_CONFLICT/,
        );
      }
      expect(
        (
          await raw.query(
            "SELECT event_id FROM paper_ledger_events WHERE idempotency_key = $1",
            [event.idempotencyKey],
          )
        ).rows,
      ).toEqual([]);
    });

    it("rejects a reserved fast main identity instead of merging financial owners", async () => {
      const id = `reserved-main-${RUN}`;
      await expect(order(raw, id, `reserved-${RUN}`, "main")).rejects.toThrow(
        /FIN02_/,
      );
      expect(
        (
          await raw.query(
            "SELECT order_id FROM paper_orders WHERE order_id = $1",
            [id],
          )
        ).rows,
      ).toEqual([]);
    });

    it("rolls back new invalid financial payloads instead of recording unparseable ownership", async () => {
      const invalidFills: Record<string, unknown>[] = [
        { size: "0" },
        { size: "-1" },
        { size: "NaN" },
        { size: "1e2" },
        { size: "1.0000000001" },
        { price: "-0.01" },
        { price: "1.01" },
        { price: "Infinity" },
        { price: 0.4 },
        { fee: "-0.01" },
        { fee: "invalid" },
      ];
      for (const [index, invalid] of invalidFills.entries()) {
        const id = `bad-fill-${index}-${RUN}`;
        await expect(
          transaction(raw, async (client) => {
            await order(client, id, id, id);
            const event = fill(`${id}:fill`, id, id);
            await appendLedgerEvent(wrap(client), {
              ...event,
              payload: { ...event.payload, ...invalid },
            });
          }),
        ).rejects.toThrow(/FIN02_FINANCIAL_PAYLOAD_INVALID/);
        expect(
          (
            await raw.query(
              "SELECT order_id FROM paper_orders WHERE order_id = $1",
              [id],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await raw.query(
              "SELECT event_id FROM paper_ledger_events WHERE token_id = $1",
              [id],
            )
          ).rows,
        ).toEqual([]);
      }
      for (const [index, price] of [
        "bad",
        "NaN",
        "-0.1",
        "1.1",
        "0.0000000001",
        1,
      ].entries()) {
        const id = `bad-res-${index}-${RUN}`;
        await expect(
          transaction(raw, async (client) => {
            await order(client, id, id, id);
            await appendLedgerEvent(wrap(client), fill(`${id}:fill`, id, id));
            const event = resolution(id, `${id}:resolution`);
            await appendLedgerEvent(wrap(client), {
              ...event,
              payload: { ...event.payload, outcome_price: price },
            });
          }),
        ).rejects.toThrow(/FIN02_FINANCIAL_PAYLOAD_INVALID/);
        expect(
          (
            await raw.query(
              "SELECT order_id FROM paper_orders WHERE order_id = $1",
              [id],
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await raw.query(
              "SELECT event_id FROM paper_ledger_events WHERE token_id = $1",
              [id],
            )
          ).rows,
        ).toEqual([]);
      }
    });

    it("validates global condition and owner membership and refuses an ambiguous shared fee", async () => {
      const token = `global-${RUN}`;
      const a = `global-a-${RUN}`;
      const b = `global-b-${RUN}`;
      const outsider = `global-other-${RUN}`;
      await order(raw, a, token, a);
      await order(raw, b, token, b);
      await order(raw, outsider, `other-token-${RUN}`, outsider);
      await appendLedgerEvent(wrap(raw), fill(`${a}:fill`, a, token));
      await appendLedgerEvent(wrap(raw), fill(`${b}:fill`, b, token));
      const resolved = resolution(token, `global-resolution-${RUN}`);
      await expect(
        appendLedgerEvent(wrap(raw), {
          ...resolved,
          conditionId: "different-condition",
        }),
      ).rejects.toThrow(/FIN02_OWNERSHIP_CONFLICT/);
      await expect(
        appendLedgerEvent(wrap(raw), {
          ...resolved,
          payload: { ...resolved.payload, fee: "0.01" },
        }),
      ).rejects.toThrow(/FIN02_GLOBAL_FEE_UNATTRIBUTED/);
      expect(await appendLedgerEvent(wrap(raw), resolved)).toBe(true);
      const settlements = (
        await loadAttributedLedgerEvents(wrap(raw), { tokenId: token })
      ).filter((event) => event.eventType === "resolution");
      expect(settlements).toHaveLength(2);
      await expect(
        raw.query(
          `INSERT INTO paper_ledger_owners
           (event_id, account_id, strategy_id, attribution_status, evidence_ref)
         VALUES ($1, 'paper', $2, 'verified', 'FIN-02:test:spoof-global-owner')`,
          [settlements[0]?.eventId, outsider],
        ),
      ).rejects.toThrow(/FIN02_OWNERSHIP_CONFLICT/);
      expect(
        (
          await loadAttributedLedgerEvents(wrap(raw), { tokenId: token })
        ).filter((event) => event.eventType === "resolution"),
      ).toHaveLength(2);
    });

    it("rejects a late first-owner fill whose prior resolution lacks that owner", async () => {
      const token = `late-${RUN}`;
      const first = `late-a-${RUN}`;
      const late = `late-b-${RUN}`;
      await order(raw, first, token, first);
      await order(raw, late, token, late);
      await appendLedgerEvent(wrap(raw), fill(`${first}:fill`, first, token));
      await appendLedgerEvent(
        wrap(raw),
        resolution(token, `late-resolution-${RUN}`),
      );
      await expect(
        transaction(raw, async (client) => {
          await appendLedgerEvent(
            wrap(client),
            fill(`${late}:fill`, late, token),
          );
        }),
      ).rejects.toThrow(/FIN02_/);
      expect(
        (
          await raw.query(
            "SELECT event_id FROM paper_ledger_events WHERE idempotency_key = $1",
            [`${late}:fill`],
          )
        ).rows,
      ).toEqual([]);
      expect(await loadOpenOwnerTokens(wrap(raw), token)).toEqual([]);
    });

    it("attributes fills and resolution inserted in one statement to both owners", async () => {
      const token = `multirow-${RUN}`;
      const a = `multirow-a-${RUN}`;
      const b = `multirow-b-${RUN}`;
      await order(raw, a, token, a);
      await order(raw, b, token, b);
      const events = [
        fill(`${a}:fill`, a, token),
        fill(`${b}:fill`, b, token),
        resolution(token, `multirow-resolution-${RUN}`),
      ];
      const values = events.flatMap((event) => [
        event.idempotencyKey,
        event.eventType,
        event.orderId ?? null,
        event.tokenId,
        event.conditionId,
        JSON.stringify(event.payload),
        event.eventTs,
      ]);
      await raw.query(
        `INSERT INTO paper_ledger_events
           (idempotency_key, event_type, order_id, token_id, condition_id, payload_json, event_ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7),
                ($8,$9,$10,$11,$12,$13,$14),
                ($15,$16,$17,$18,$19,$20,$21)`,
        values,
      );
      const attributed = await loadAttributedLedgerEvents(wrap(raw), {
        tokenId: token,
      });
      expect(attributed).toHaveLength(4);
      expect(
        attributed
          .filter((event) => event.eventType === "resolution")
          .map((event) => event.owner.strategyId)
          .sort(),
      ).toEqual([a, b]);
      expect(await loadOpenOwnerTokens(wrap(raw), token)).toEqual([]);
    });

    it("freezes order identity but allows broker status progress", async () => {
      const token = `immutable-${RUN}`;
      const id = `immutable-order-${RUN}`;
      await order(raw, id, token, id);
      for (const [column, value] of [
        ["token_id", "other-token"],
        ["condition_id", "other-condition"],
        ["side", "SELL"],
        ["size", "21.000000"],
        ["strategy_id", "another-strategy"],
      ]) {
        await expect(
          raw.query(
            `UPDATE paper_orders SET ${column} = $1 WHERE order_id = $2`,
            [value, id],
          ),
        ).rejects.toThrow();
      }
      await expect(
        raw.query(
          "UPDATE paper_orders SET status = 'filled', filled_size = '20.000000' WHERE order_id = $1",
          [id],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    it("keeps evidence immutable and the existing HOLD guards enabled", async () => {
      for (const table of [
        "paper_financial_owners",
        "paper_order_owners",
        "paper_ledger_owners",
      ]) {
        for (const statement of [
          `UPDATE ${table} SET ownership_version = ownership_version WHERE FALSE`,
          `DELETE FROM ${table} WHERE FALSE`,
          `TRUNCATE ${table} CASCADE`,
        ]) {
          await expect(raw.query(statement)).rejects.toThrow();
        }
      }
      for (const table of [
        "paper_orders",
        "paper_ledger_events",
        "paper_owner_positions",
      ]) {
        await expect(
          raw.query(`DELETE FROM ${table} WHERE FALSE`),
        ).rejects.toThrow(/HOLD|immutable|append-only/);
        await expect(raw.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(
          /HOLD|immutable|append-only/,
        );
      }
      await expect(
        raw.query(
          "UPDATE paper_ledger_events SET payload_json = '{}' WHERE token_id = $1",
          [OLD_TOKEN],
        ),
      ).rejects.toThrow(/immutable|append-only/);
    });

    it("retains historical bytes and makes unknown ownership explicit outside paper/main", async () => {
      expect(await historicalRows(raw)).toEqual(legacyBytes);
      const historical = await loadAttributedLedgerEvents(wrap(raw), {
        tokenId: OLD_TOKEN,
      });
      expect(historical).toHaveLength(3);
      for (const event of historical) {
        expect(event.owner.accountId).toBe("legacy_unattributed");
        expect(event.owner.strategyId).toBe("unknown");
        expect(event.owner.attributionStatus).toBe("unknown");
      }
      expect(
        await loadAttributedLedgerEvents(wrap(raw), {
          accountId: "paper",
          strategyId: "main",
          tokenId: OLD_TOKEN,
        }),
      ).toEqual([]);
      // ledger-v1 ignores a non-decimal historical payout. Ownership discovery
      // must preserve that same one-share balance, without rewriting the row.
      const legacy = (await loadLedgerEvents(wrap(raw))).filter(
        (event) => event.tokenId === OLD_TOKEN,
      );
      expect(replayLedger(legacy).positions.get(OLD_TOKEN)?.shares).toBe(
        "1.000000",
      );
      const openLegacy = await loadOpenOwnerTokens(wrap(raw), OLD_TOKEN);
      expect(
        openLegacy.map((row) => [
          row.accountId,
          row.strategyId,
          decimal(row.shares),
        ]),
      ).toEqual([["legacy_unattributed", "unknown", "1"]]);
      // A post-migration event for the historical order cannot invent main ownership.
      await appendLedgerEvent(wrap(raw), {
        ...fill(`old-cancel-${RUN}`, OLD_ORDER, OLD_TOKEN),
        eventType: "cancel_requested",
        payload: {},
      });
      const oldOrderEvents = await loadAttributedLedgerEvents(wrap(raw), {
        tokenId: OLD_TOKEN,
      });
      expect(
        oldOrderEvents.every(
          (event) => event.owner.accountId === "legacy_unattributed",
        ),
      ).toBe(true);
      expect((await historicalRows(raw)).slice(0, legacyBytes.length)).toEqual(
        legacyBytes,
      );
    });

    it("classifies missing-order rejection as unknown and omits global kill diagnostics", async () => {
      const token = `rejection-${RUN}`;
      const id = `missing-${RUN}`;
      const rejection: LedgerEventInput = {
        ...fill(`rejection-key-${RUN}`, id, token),
        eventType: "order_rejected",
        payload: { reason: "PAPER_ORDER_INVALID" },
      };
      expect(await appendLedgerEvent(wrap(raw), rejection)).toBe(true);
      const attributed = await loadAttributedLedgerEvents(wrap(raw), {
        tokenId: token,
      });
      expect(attributed).toHaveLength(1);
      expect(attributed[0]?.owner.accountId).toBe("legacy_unattributed");
      expect(attributed[0]?.owner.strategyId).toBe("unknown");
      await expect(
        appendLedgerEvent(wrap(raw), fill(`missing-fill-${RUN}`, id, token)),
      ).rejects.toThrow(/FIN02_OWNERSHIP_CONFLICT/);
      const key = `kill-${RUN}`;
      await appendLedgerEvent(wrap(raw), {
        idempotencyKey: key,
        eventType: "kill_switch_engaged",
        payload: { reason: "MANUAL" },
        eventTs: AT,
      });
      expect(
        (await loadAttributedLedgerEvents(wrap(raw), {})).some(
          (event) => event.idempotencyKey === key,
        ),
      ).toBe(false);
      expect(
        (await loadLedgerEvents(wrap(raw))).some(
          (event) => event.idempotencyKey === key,
        ),
      ).toBe(true);
    });
  },
);
