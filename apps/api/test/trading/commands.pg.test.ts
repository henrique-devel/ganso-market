import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { DeskCommand } from "@ganso-market/contracts/trading";
import type { SqlExecutor } from "../../src/database.js";
import { registerTradingCommandRoutes } from "../../src/trading-commandapi.js";
import { hashToken } from "../../src/auth/tokens.js";
import { createLedgerAccount } from "../../src/storage/ledgerstore.js";
import { applyReservation } from "../../src/storage/reservationstore.js";
import { identity, iso } from "./ledger-fixture.js";
import {
  riskFixture,
  riskOrder,
  seedRiskFunding,
  scope,
} from "./risk-fixture.js";
import { health } from "./bars-fixture.js";
import { market } from "./valuation-fixture.js";
import {
  storeRetentionObjectTx,
  withBtcRetentionTransaction,
} from "../../src/storage/btc-retention.js";
import { seedMarginMetadata } from "./margin-fixture.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof riskFixture>>, app: FastifyInstance;
const headers = {
  authorization: "Bearer token",
  host: "localhost:8080",
  origin: "http://localhost:8080",
  cookie: "ganso_csrf=csrf",
  "x-csrf-token": "csrf",
};
const submit = (): DeskCommand => ({
  account_id: "manual",
  action: "submit",
  side: "buy",
  quantity_btc_raw: "100000",
  limit_price_usd_raw: "65000000000",
  price_cap_usd_raw: "65000000000",
  valid_until: iso(Date.now() + 60000),
  risk_plan: {
    stop_price_usd_raw: "64800000000",
    entry_floor_usd_raw: "64900000000",
  },
});
const send = (action: string, payload: unknown, key = "one", token = "token") =>
  app.inject({
    method: "POST",
    url: `/trading/${action}`,
    headers: {
      ...headers,
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
    },
    payload: payload as object,
  });
async function preview(command = submit(), key = "one") {
  const r = await send("preview", command, key);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function counts() {
  const rows = [];
  for (const table of [
    "btc_ledger_events",
    "btc_reservation_events",
    "btc_order_acceptances",
    "btc_ioc_results",
    "btc_passive_results",
    "btc_risk_events",
    "btc_recovery_heads",
    "btc_desk_commands",
    "btc_retention_pins",
  ])
    rows.push(
      (await f.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
    );
  return rows;
}
describe.skipIf(!url)(
  "authenticated desk commands on disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      f = await riskFixture(url);
      await createLedgerAccount(f.poolAdapter, identity());
      await seedMarginMetadata(f.poolAdapter);
      await seedRiskFunding(f.poolAdapter);
      await f.capture();
      const owner = (
        await f.pool.query(
          "INSERT INTO auth_accounts(username,password_hash) VALUES('owner','fixture-only') RETURNING account_id",
        )
      ).rows[0].account_id;
      for (const token of ["token", "other-session"]) {
        const session = randomUUID();
        await f.pool.query(
          "INSERT INTO auth_sessions(session_id,account_id) VALUES($1,$2)",
          [session, owner],
        );
        await f.pool.query(
          "INSERT INTO auth_access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '15 minutes')",
          [hashToken(token), session],
        );
      }
      await f.pool.query(
        "INSERT INTO btc_desk_controls(account_id,owner_account_id,enabled,broker,signing_key) VALUES('manual',$1,true,'ioc',$2)",
        [owner, "a".repeat(64)],
      );
      const pool = Object.assign(f.poolAdapter, {
        readOnly: <T>(ms: number, run: (tx: SqlExecutor) => Promise<T>) =>
          f.poolAdapter.transaction(async (tx) => {
            await tx.query("SET TRANSACTION READ ONLY");
            await tx.query(`SET LOCAL statement_timeout=${ms}`);
            return run(tx);
          }),
      });
      app = Fastify();
      registerTradingCommandRoutes(app, {
        pool,
        authService: {
          session: async (token) =>
            ["token", "rotated", "other-session"].includes(token)
              ? {
                  status: "ok",
                  username: "owner",
                  expiresAt: new Date(Date.now() + 60000),
                }
              : { status: "unauthenticated" },
        },
      });
    });
    afterEach(async () => {
      await app?.close();
      await f?.dispose();
    });
    it("quotes fixed-point holds with no writes, signs session intent and concurrently deduplicates acceptance", async () => {
      const before = await counts(),
        request = submit(),
        p = await preview(request);
      expect(await counts()).toEqual(before);
      expect(p).toMatchObject({
        schema_version: "trading.commands.v1",
        guarantees_fill: false,
        revalidation_required: true,
        estimate: {
          reserved_margin_usd_raw: "65000000",
          reserved_fees_usd_raw: "32500",
          quantity_btc_raw: "100000",
        },
      });
      const [a, b] = await Promise.all([
        send("submit", { intent: p.intent }),
        send("submit", { intent: p.intent }),
      ]);
      expect(a.statusCode, a.body).toBe(200);
      expect(b.json()).toEqual(a.json());
      expect(a.json()).toMatchObject({
        status: "accepted",
        execution: { fills: [] },
      });
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM btc_order_acceptances",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await f.pool.query("SELECT count(*)::int n FROM btc_desk_commands"))
          .rows[0].n,
      ).toBe(1);
      // Retry survives the advisory expiry and a rotated access token in the SAME logical session.
      await f.pool.query(
        "INSERT INTO auth_access_tokens(token_hash,session_id,expires_at) SELECT $1,session_id,expires_at FROM auth_access_tokens WHERE token_hash=$2",
        [hashToken("rotated"), hashToken("token")],
      );
      f.setClock(iso(Date.now() + 61000));
      expect(
        (await send("submit", { intent: p.intent }, "one", "rotated")).json(),
      ).toEqual(a.json());
      await f.pool.query("UPDATE btc_desk_controls SET enabled=false");
      const replay = await send("preview", request, "one", "other-session");
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({ replay: true, estimate: null });
      expect(
        (
          await send(
            "submit",
            { intent: replay.json().intent },
            "one",
            "other-session",
          )
        ).json(),
      ).toEqual(a.json());
    });
    it("refuses altered signed payload, wrong session, action/key mismatch and revoked auth without financial writes", async () => {
      const p = await preview(),
        before = await counts();
      const [body, sig] = p.intent.split("."),
        parsed = JSON.parse(Buffer.from(body, "base64url").toString());
      parsed.command.side = "sell";
      const changed =
        Buffer.from(JSON.stringify(parsed)).toString("base64url") + "." + sig;
      expect(
        (await send("submit", { intent: changed })).json().reason_code,
      ).toBe("TRADING_INTENT_SIGNATURE");
      expect(
        (await send("submit", { intent: p.intent }, "one", "other-session"))
          .statusCode,
      ).toBe(403);
      expect((await send("cancel", { intent: p.intent })).statusCode).toBe(400);
      expect(
        (await send("submit", { intent: p.intent }, "another-key")).statusCode,
      ).toBe(400);
      await f.pool.query(
        "UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE session_id=(SELECT session_id FROM auth_access_tokens WHERE token_hash=$1)",
        [hashToken("token")],
      );
      expect((await send("submit", { intent: p.intent })).statusCode).toBe(401);
      expect(await counts()).toEqual(before);
    });
    it("revalidates activation, stale book and expiry after a previously valid quote", async () => {
      const p = await preview();
      await f.pool.query("UPDATE btc_desk_controls SET enabled=false");
      expect(
        (await send("submit", { intent: p.intent })).json().reason_code,
      ).toBe("TRADING_COMMANDS_DISABLED");
      await f.pool.query("UPDATE btc_desk_controls SET enabled=true");
      f.setClock(iso(Date.now() + 2500));
      expect(
        (await send("submit", { intent: p.intent })).json().reason_code,
      ).toBe("BTC_RISK_BOOK_UNAVAILABLE");
      f.setClock(iso(Date.now() + 61000));
      expect(
        (await send("submit", { intent: p.intent })).json().reason_code,
      ).toBe("TRADING_PREVIEW_EXPIRED");
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM btc_order_acceptances",
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("refuses foreign account/mode and insufficient funds; fresh preview does not bypass acceptance risk", async () => {
      expect(
        (await send("preview", { ...submit(), account_id: "missing" })).json()
          .reason_code,
      ).toBe("TRADING_ACCOUNT_UNAVAILABLE");
      expect(
        (
          await send("preview", { ...submit(), quantity_btc_raw: "200000000" })
        ).json().reason_code,
      ).toBe("BTC_RESERVATION_MARGIN_UNAVAILABLE");
      const request = submit(),
        p = await preview(request),
        changed = await preview({
          ...request,
          quantity_btc_raw: "110000",
        } as DeskCommand);
      expect((await send("submit", { intent: p.intent })).statusCode).toBe(200);
      expect(
        (await send("submit", { intent: changed.intent })).json().reason_code,
      ).toBe("TRADING_IDEMPOTENCY_CONFLICT");
      const pause = await preview(
        { account_id: "manual", action: "pause" },
        "pause",
      );
      expect(
        (await send("pause", { intent: pause.intent }, "pause")).statusCode,
      ).toBe(200);
      const p2 = await preview(submit(), "next");
      expect(
        (await send("submit", { intent: p2.intent }, "next")).json()
          .reason_code,
      ).toBe("BTC_RISK_REDUCE_ONLY");
    });
    it.each(["ioc", "passive"] as const)(
      "cancels %s and pauses entries idempotently without creating fills",
      async (broker) => {
        await f.pool.query("UPDATE btc_desk_controls SET broker=$1", [broker]);
        if (broker === "passive") {
          const at = new Date(
              (await f.pool.query("SELECT clock_timestamp() AS now")).rows[0]
                .now,
            ).getTime(),
            m = market(at),
            h = health(at);
          Object.assign(h.channels, m.capture!.health.channels);
          const payload = {
            ...m.capture!,
            session: "desk-test",
            id: "desk-test",
            from: at - 100,
            history_truncated: false,
            restarted: false,
            health: h,
          };
          await withBtcRetentionTransaction(f.poolAdapter, async (tx) => {
            await storeRetentionObjectTx(tx, {
              id: "desk-capture",
              class: "raw",
              identity: scope,
              recordedAt: new Date(at),
              payload,
              dependencies: [],
            });
            await tx.query(
              "INSERT INTO btc_market_records(object_id,kind,source_at,received_at) VALUES('desk-capture','capture',$1,$1)",
              [iso(at)],
            );
          });
        }
        const request = {
          ...submit(),
          limit_price_usd_raw: "64900000000",
        } as DeskCommand;
        const p = await preview(request),
          accepted = await send("submit", { intent: p.intent });
        expect(accepted.statusCode, accepted.body).toBe(200);
        const cancel = await preview(
          {
            account_id: "manual",
            action: "cancel",
            order_id: accepted.json().order_id,
          },
          "cancel",
        );
        const results = await Promise.all([
          send("cancel", { intent: cancel.intent }, "cancel"),
          send("cancel", { intent: cancel.intent }, "cancel"),
        ]);
        expect(results[0]!.statusCode, results[0]!.body).toBe(200);
        expect(results[1]!.json()).toEqual(results[0]!.json());
        expect(results[0]!.json().status).toBe("cancelled");
        const pause = await preview(
          { account_id: "manual", action: "pause" },
          "pause",
        );
        const a = await send("pause", { intent: pause.intent }, "pause"),
          b = await send("pause", { intent: pause.intent }, "pause");
        expect(a.statusCode, a.body).toBe(200);
        expect(b.json()).toEqual(a.json());
        expect(a.json().execution.state).toBe("REDUCE_ONLY");
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int n FROM btc_ledger_events WHERE event_type='fill'",
            )
          ).rows[0].n,
        ).toBe(0);
      },
    );
    it.each(["buy", "sell"] as const)(
      "serializes two full close requests for a %s position without duplicate inventory",
      async (side) => {
        await applyReservation(f.poolAdapter, scope, {
          action: "reserve",
          operation_id: "fixture-open",
          order: riskOrder("fixture", { side }),
        });
        await applyReservation(f.poolAdapter, scope, {
          action: "consume",
          operation_id: "fixture-fill",
          order_id: "fixture",
          quantity_btc_raw: "100000",
          price_usd_raw: "65000000000",
          fee_usd_raw: "32500",
        });
        const request: DeskCommand = {
          account_id: "manual",
          action: "close",
          position_id: "position:1",
          limit_price_usd_raw: "64900000000",
          price_cap_usd_raw: "66000000000",
          valid_until: iso(Date.now() + 60000),
        };
        const a = await preview(request, "close-a"),
          b = await preview(request, "close-b");
        const results = await Promise.all([
          send("close", { intent: a.intent }, "close-a"),
          send("close", { intent: b.intent }, "close-b"),
        ]);
        expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        expect(
          results.find((r) => r.statusCode === 409)?.json().reason_code,
        ).toBe("BTC_RESERVATION_INVENTORY_UNAVAILABLE");
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int n FROM btc_order_acceptances WHERE request->>'intent'='reduce'",
            )
          ).rows[0].n,
        ).toBe(1);
      },
    );
    it("starts a new audited generation after an idle HTTP worker lease expires", async () => {
      const p = await preview(),
        accepted = await send("submit", { intent: p.intent });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const before = (
        await f.pool.query("SELECT generation FROM btc_recovery_heads")
      ).rows[0].generation;
      await f.pool.query(
        "UPDATE btc_recovery_heads SET lease_until=clock_timestamp()-interval '1 second'",
      );
      const results = await Promise.all([
        send("submit", { intent: p.intent }),
        send("submit", { intent: p.intent }),
      ]);
      for (const r of results) expect(r.json()).toEqual(accepted.json());
      expect(
        BigInt(
          (await f.pool.query("SELECT generation FROM btc_recovery_heads"))
            .rows[0].generation,
        ),
      ).toBe(BigInt(before) + 1n);
    });
    it("revalidates metadata and returns caller quantum errors as 400", async () => {
      expect(
        (await send("preview", { ...submit(), quantity_btc_raw: "100001" }))
          .statusCode,
      ).toBe(400);
      const p = await preview();
      await seedMarginMetadata(f.poolAdapter);
      expect(
        (await send("submit", { intent: p.intent })).json().reason_code,
      ).toBe("TRADING_PREVIEW_OUTDATED");
    });
    it("rolls back the reservation if the durable HTTP receipt cannot be written", async () => {
      const p = await preview();
      f.setHook(async (sql) => {
        if (sql.startsWith("INSERT INTO btc_desk_commands"))
          throw new Error("fixture lost connection");
      });
      expect((await send("submit", { intent: p.intent })).statusCode).toBe(503);
      f.setHook(null);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM btc_order_acceptances",
          )
        ).rows[0].n,
      ).toBe(0);
      expect((await send("submit", { intent: p.intent })).statusCode).toBe(200);
    });
  },
);
