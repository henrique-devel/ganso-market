import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  DeskAccountView,
  DeskPage,
  DeskPosition,
  DeskOrder,
} from "@ganso-market/contracts/trading";
import type { SqlExecutor } from "../../src/database.js";
import { registerTradingReadRoutes } from "../../src/trading-readapi.js";
import {
  createLedgerAccount,
  appendLedgerBatch,
} from "../../src/storage/ledgerstore.js";
import { readLedgerValuation } from "../../src/storage/valuationstore.js";
import { applyReservation } from "../../src/storage/reservationstore.js";
import { ledgerScope } from "../../src/trading/ledger.js";
import { identity, command, iso, fill } from "./ledger-fixture.js";
import { riskFixture, riskOrder, seedRiskFunding } from "./risk-fixture.js";
import { seedMarginMetadata } from "./margin-fixture.js";
import { recoverAccount } from "../../src/storage/recoverystore.js";

const url = process.env.GANSO_TEST_DATABASE_URL;
let fixture: Awaited<ReturnType<typeof riskFixture>>;
let app: FastifyInstance;
let now: number;
const statements: string[] = [];
const auth = { authorization: "Bearer owner-session" };
const request = (path: string) =>
  app.inject({ url: `/trading/${path}`, headers: auth });
const scope = ledgerScope(identity());
async function open(
  owner = "manual",
  side: "buy" | "sell" = "buy",
  positions = 1,
) {
  const id = identity(owner),
    own = ledgerScope(id);
  await createLedgerAccount(fixture.poolAdapter, id);
  const payload = fill("fixture", side, "100000");
  if (payload.event_type !== "fill") throw new Error("fixture");
  await appendLedgerBatch(fixture.poolAdapter, own, {
    transaction_id: "open",
    events: Array.from({ length: positions }, (_, i) =>
      command(
        `fill:${i}`,
        { ...payload, execution_id: `fill:${i}`, position_id: `p:${i}` },
        own,
      ),
    ),
  });
}
async function snapshot() {
  const rows = await fixture.pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'btc_%' ORDER BY tablename",
  );
  const result = [];
  for (const { tablename } of rows.rows)
    result.push(
      (
        await fixture.pool.query(
          `SELECT to_jsonb(t) FROM "${tablename}" t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  return result;
}
describe.skipIf(!url)("desk projections on disposable PostgreSQL", () => {
  beforeEach(async () => {
    fixture = await riskFixture(url);
    now = Date.now();
    statements.length = 0;
    app = Fastify();
    registerTradingReadRoutes(app, {
      authService: { session: async () => ({ status: "ok" }) },
      clock: () => new Date(now),
      pool: {
        readOnly: async <T>(ms: number, run: (tx: SqlExecutor) => Promise<T>) =>
          fixture.poolAdapter.transaction(async (tx) => {
            await tx.query("SET TRANSACTION READ ONLY");
            await tx.query(`SET LOCAL statement_timeout=${ms}`);
            return run({
              async query<R extends Record<string, unknown>>(
                sql: string,
                params?: readonly unknown[],
              ) {
                statements.push(sql);
                const result = await tx.query<R>(sql, params);
                if (sql.startsWith("SELECT")) {
                  expect(
                    (await tx.query("SHOW transaction_read_only")).rows[0]
                      ?.transaction_read_only,
                  ).toBe("on");
                  expect(
                    (await tx.query("SHOW transaction_isolation")).rows[0]
                      ?.transaction_isolation,
                  ).toBe("repeatable read");
                  expect(
                    (await tx.query("SHOW statement_timeout")).rows[0]
                      ?.statement_timeout,
                  ).toBe("1500ms");
                }
                return result;
              },
            });
          }),
      },
    });
  });
  afterEach(async () => {
    await app?.close();
    await fixture?.dispose();
  });

  it("returns an empty list and 404 for nonexistent owners without initializing accounts", async () => {
    const before = await snapshot();
    expect((await request("accounts")).json()).toMatchObject({
      simulation: "SIMULAÇÃO",
      items: [],
      next_cursor: null,
    });
    for (const route of ["account", "positions", "orders"]) {
      const response = await request(`${route}?account_id=absent`);
      expect(response.statusCode).toBe(404);
      expect(response.json().reason_code).toBe("TRADING_ACCOUNT_NOT_FOUND");
    }
    expect(await snapshot()).toEqual(before);
  });
  it("keeps missing mark/equity unavailable, while retaining known cash and signed positions", async () => {
    await open();
    now = Date.now() + 1;
    const before = await snapshot();
    const response = await request("account?account_id=manual");
    expect(response.statusCode).toBe(200);
    const view = response.json<DeskAccountView>();
    expect(view).toMatchObject({
      status: "unavailable",
      balances: {
        balance_usd_raw: "1000000000",
        equity_usd_raw: null,
        unrealized_pnl_usd_raw: null,
      },
      mark: { quality: "missing", mark_price_usd_raw: null },
    });
    expect(view.reason_codes).toContainEqual({
      component: "mark",
      code: "BTC_MARK_MISSING",
    });
    const positions = (await request("positions?account_id=manual")).json<
      DeskPage<DeskPosition>
    >();
    expect(positions.items[0]).toMatchObject({
      quantity_btc_raw: "100000",
      liquidatable: null,
      maintenance_usd_raw: null,
    });
    expect(await snapshot()).toEqual(before);
    expect(statements.some((sql) => sql.includes("SELECT event FROM"))).toBe(
      false,
    );
  });
  it("matches financial replay for separate opposite accounts and uses no ledger history scan on refresh", async () => {
    await open();
    await open("other", "sell");
    await seedMarginMetadata(fixture.poolAdapter);
    await fixture.capture();
    now = Date.now() + 1;
    const before = await snapshot();
    for (const owner of ["manual", "other"]) {
      const replay = await readLedgerValuation(
        fixture.poolAdapter,
        ledgerScope(identity(owner)),
        iso(now),
      );
      const response = await request(`account?account_id=${owner}`);
      expect(response.statusCode, response.body).toBe(200);
      const view = response.json<DeskAccountView>();
      expect(view.balances?.equity_usd_raw).toBe(
        replay.maintenance.equity_usd_raw,
      );
      expect(view.margin?.free_cash_usd_raw).toBe(
        replay.isolation.free_cash_usd_raw,
      );
      expect(view.account.scope.account_id).toBe(owner);
      expect(view.status).toBe("available");
    }
    expect(await snapshot()).toEqual(before);
    expect(
      statements
        .filter((sql) => sql.includes("btc_ledger_events"))
        .every((sql) => sql.includes("ORDER BY sequence DESC LIMIT 1")),
    ).toBe(true);
  });
  it("exposes source time absence and staleness without refreshing evidence timestamps", async () => {
    await open();
    await seedMarginMetadata(fixture.poolAdapter);
    await fixture.capture({ unknown: true });
    now = Date.now() + 1;
    const first = (
      await request("account?account_id=manual")
    ).json<DeskAccountView>();
    expect(first.mark?.quality).toBe("source_time_unproven");
    expect(first.mark?.source_timestamp).toBeNull();
    now += 20_000;
    const stale = (
      await request("account?account_id=manual")
    ).json<DeskAccountView>();
    expect(stale.mark?.quality).toBe("stale");
    expect(stale.mark?.received_at).toBe(first.mark?.received_at);
    expect(stale.balances?.equity_usd_raw).toBeNull();
  });
  it("paginates accounts and positions with scoped cursors and bounded responses", async () => {
    for (const owner of ["a", "b", "c"]) await open(owner, "buy", 3);
    now = Date.now() + 1;
    const a = (await request("accounts?limit=2")).json();
    const b = (
      await request(`accounts?limit=2&cursor=${a.next_cursor}`)
    ).json();
    expect(
      a.items.map(
        (x: { account: { account_id: string } }) => x.account.account_id,
      ),
    ).toEqual(["a", "b"]);
    expect(
      b.items.map(
        (x: { account: { account_id: string } }) => x.account.account_id,
      ),
    ).toEqual(["c"]);
    expect(b.next_cursor).toBeNull();
    const p = (await request("positions?account_id=a&limit=2")).json<
      DeskPage<DeskPosition>
    >();
    const last = (
      await request(`positions?account_id=a&limit=2&cursor=${p.next_cursor}`)
    ).json<DeskPage<DeskPosition>>();
    expect(p.items.map((x) => x.position_id)).toEqual(["p:0", "p:1"]);
    expect(last.items.map((x) => x.position_id)).toEqual(["p:2"]);
    expect(
      (await request(`positions?account_id=b&cursor=${p.next_cursor}`))
        .statusCode,
    ).toBe(400);
    expect(
      (await request(`orders?account_id=a&cursor=${p.next_cursor}`)).statusCode,
    ).toBe(400);
  });
  it("keeps missing or mismatched projections unavailable, and audited recovery rebuilds the derived view", async () => {
    await createLedgerAccount(fixture.poolAdapter, identity());
    now = Date.now() + 1;
    await fixture.pool.query(
      "UPDATE btc_ledger_projections SET desk_projection=NULL",
    );
    const before = await snapshot();
    expect((await request("account?account_id=manual")).json()).toMatchObject({
      balances: null,
      margin: null,
      status: "unavailable",
    });
    expect((await request("positions?account_id=manual")).json()).toMatchObject(
      { status: "unavailable", items: [] },
    );
    expect(await snapshot()).toEqual(before);
    await recoverAccount(fixture.poolAdapter, scope);
    now = Date.now() + 1;
    expect(
      (await request("account?account_id=manual")).json().balances
        .balance_usd_raw,
    ).toBe("1000000000");
    await fixture.pool.query(
      `UPDATE btc_ledger_projections SET projection=jsonb_set(projection,'{cash_usd_raw}','"0"')`,
    );
    expect(
      (await request("account?account_id=manual")).json().balances,
    ).toBeNull();
  });
  it("projects partial fills/cancellation once, pages orders and never releases holds on GET", async () => {
    await createLedgerAccount(fixture.poolAdapter, identity());
    await seedMarginMetadata(fixture.poolAdapter);
    await fixture.capture();
    await seedRiskFunding(fixture.poolAdapter);
    for (const id of ["b", "a"]) {
      await applyReservation(fixture.poolAdapter, scope, {
        action: "reserve",
        operation_id: `reserve:${id}`,
        order: riskOrder(id, { position_id: `position:${id}` }),
      });
      if (id === "b")
        await applyReservation(fixture.poolAdapter, scope, {
          action: "release",
          operation_id: "cancel:b",
          order_id: id,
          reason: "cancelled",
        });
    }
    const consume = {
      action: "consume" as const,
      operation_id: "partial",
      order_id: "a",
      quantity_btc_raw: "40000",
      price_usd_raw: "65000000000",
      fee_usd_raw: "26000",
    };
    await applyReservation(fixture.poolAdapter, scope, consume);
    await applyReservation(fixture.poolAdapter, scope, consume);
    await applyReservation(fixture.poolAdapter, scope, {
      action: "release",
      operation_id: "cancel",
      order_id: "a",
      reason: "cancelled",
    });
    await applyReservation(fixture.poolAdapter, scope, {
      action: "reserve",
      operation_id: "reserve:c",
      order: riskOrder("c", {
        position_id: "position:a",
        intent: "reduce",
        side: "sell",
        quantity_btc_raw: "40000",
      }),
    });
    now = Date.now() + 120_000;
    const before = await snapshot();
    const orders = (await request("orders?account_id=manual&limit=2")).json<
      DeskPage<DeskOrder>
    >();
    expect(orders.items.map((x) => x.order_id)).toEqual(["a", "b"]);
    expect(orders.items[0]).toMatchObject({
      status: "cancelled",
      filled_btc_raw: "40000",
      remaining_btc_raw: "0",
      reserved_margin_usd_raw: "0",
    });
    expect(orders.items[1]).toMatchObject({
      status: "cancelled",
      filled_btc_raw: "0",
    });
    const last = (
      await request(
        `orders?account_id=manual&limit=2&cursor=${orders.next_cursor}`,
      )
    ).json<DeskPage<DeskOrder>>();
    expect(last.items.map((x) => x.order_id)).toEqual(["c"]);
    expect(last.next_cursor).toBeNull();
    expect(last.items[0]?.status).toBe("active");
    const view = (
      await request("account?account_id=manual")
    ).json<DeskAccountView>();
    expect(view.margin).toMatchObject({
      reserved_margin_usd_raw: "0",
      reserved_fees_usd_raw: "26000",
    });
    expect(await snapshot()).toEqual(before);
  });
});
