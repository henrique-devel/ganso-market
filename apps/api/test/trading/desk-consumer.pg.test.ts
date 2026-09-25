import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { DatabasePool, SqlExecutor } from "../../src/database.js";
import type { DeskCommand } from "@ganso-market/contracts/trading";
import { acceptanceFixture } from "./acceptance-fixture.js";
import { identity, iso } from "./ledger-fixture.js";
import { seedMarginMetadata } from "./margin-fixture.js";
import {
  createLedgerAccount,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import { ledgerScope, replayLedger } from "../../src/trading/ledger.js";
import {
  consumeDeskAccount,
  fundDeskAccount,
} from "../../src/storage/desk-consumer.js";
import {
  acceptDeskCommand,
  previewDeskCommand,
} from "../../src/storage/desk-commandstore.js";
import { activateManualDesk } from "../../src/desk-activate-cli.js";
import { hashToken } from "../../src/auth/tokens.js";
import { readReservationsTx } from "../../src/storage/reservationstore.js";
const url = process.env.GANSO_TEST_DATABASE_URL;
let f: Awaited<ReturnType<typeof acceptanceFixture>>, now: number;
let pool: Pick<DatabasePool, "transaction" | "readOnly">;
const scope = ledgerScope(identity());
const tick = () => {
  now += 400;
  vi.setSystemTime(now);
};
const open = (side: "buy" | "sell" = "buy"): DeskCommand => ({
  account_id: "manual",
  action: "submit",
  side,
  quantity_btc_raw: "200000",
  limit_price_usd_raw: side === "buy" ? "65100000000" : "64900000000",
  price_cap_usd_raw: "65100000000",
  valid_until: iso(now + 60000),
  risk_plan: {
    stop_price_usd_raw: side === "buy" ? "64800000000" : "65300000000",
    entry_floor_usd_raw: "64900000000",
  },
});
const command = async (c: DeskCommand, key: string = randomUUID()) => {
  const p = await previewDeskCommand(pool, "token", c, key);
  return acceptDeskCommand(pool, "token", c.action, p.intent, key);
};
const reservations = () =>
  pool.transaction((tx) => readReservationsTx(tx, "manual"));
describe.skipIf(!url)(
  "manual desk consumer on disposable PostgreSQL only",
  () => {
    beforeEach(async () => {
      now = Date.now() - 60000;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      f = await acceptanceFixture(url, () => now);
      const w = f.worker();
      pool = Object.assign(w.pool, {
        readOnly: <T>(_ms: number, run: (tx: SqlExecutor) => Promise<T>) =>
          w.pool.transaction(async (tx) => {
            await tx.query("SET TRANSACTION READ ONLY");
            return run(tx);
          }),
      });
      await createLedgerAccount(pool, identity());
      await seedMarginMetadata(pool);
      const owner = (
        await f.pool.query(
          "INSERT INTO auth_accounts(username,password_hash) VALUES('fixture-owner','fixture-only') RETURNING account_id",
        )
      ).rows[0].account_id;
      const session = randomUUID();
      await f.pool.query(
        "INSERT INTO auth_sessions(session_id,account_id) VALUES($1,$2)",
        [session, owner],
      );
      await f.pool.query(
        "INSERT INTO auth_access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",
        [hashToken("token"), session],
      );
      await f.pool.query(
        "INSERT INTO btc_desk_controls(account_id,owner_account_id,enabled,broker,signing_key) VALUES('manual',$1,true,'ioc',$2)",
        [owner, "a".repeat(64)],
      );
      await fundDeskAccount(pool, "manual", async (hour) => ({
        source: "hyperliquid:mainnet:fundingHistory",
        received_at: iso(now),
        rows: [
          {
            coin: "BTC",
            time: Date.parse(hour),
            fundingRate: "0.00001",
            premium: "0",
          },
        ],
      }));
      tick();
      await f.capture(pool);
      await consumeDeskAccount(pool, "manual");
    });
    afterEach(async () => {
      vi.useRealTimers();
      await f?.dispose();
    });
    it.each(["buy", "sell"] as const)(
      "%s partial IOC, effective cancel, close and exact ledger survive retry/race/recovery",
      async (side) => {
        const request = open(side),
          p = await previewDeskCommand(pool, "token", request, "entry");
        const results = await Promise.all([
          acceptDeskCommand(pool, "token", "submit", p.intent, "entry"),
          acceptDeskCommand(pool, "token", "submit", p.intent, "entry"),
        ]);
        expect(results[0]).toEqual(results[1]);
        await consumeDeskAccount(pool, "manual");
        expect((await reservations())[0]!.status).toBe("active");
        tick();
        await f.capture(pool, { depth: "100000" });
        await consumeDeskAccount(pool, "manual");
        const order = (await reservations())[0]!;
        expect(order.status).toBe("cancelled");
        const partial = await readLedgerAccount(pool, scope);
        expect(partial.projection.positions[0]!.quantity_btc_raw).toBe(
          side === "buy" ? "100000" : "-100000",
        );
        const cancel = await command({
          account_id: "manual",
          action: "cancel",
          order_id: order.order.order_id,
        });
        expect(cancel.status).toBe("already_terminal");
        tick();
        await f.capture(pool);
        await consumeDeskAccount(pool, "manual");
        const close: DeskCommand = {
          account_id: "manual",
          action: "close",
          position_id: order.order.position_id,
          limit_price_usd_raw: side === "buy" ? "64900000000" : "65100000000",
          price_cap_usd_raw: "65100000000",
          valid_until: iso(now + 60000),
        };
        await command(close, "close");
        tick();
        await f.capture(pool);
        await consumeDeskAccount(pool, "manual");
        const final = await readLedgerAccount(pool, scope);
        expect(final.projection.positions[0]!.quantity_btc_raw).toBe("0");
        expect(final.projection).toEqual(
          replayLedger(final.identity, final.events),
        );
        expect(BigInt(final.projection.cash_usd_raw)).toBeLessThan(1000000000n);
        expect((await reservations()).every((r) => r.status !== "active")).toBe(
          true,
        );
        await f.pool.query(
          "UPDATE btc_recovery_heads SET lease_until=clock_timestamp()-interval '1 second'",
        );
        await consumeDeskAccount(pool, "manual");
        expect((await readLedgerAccount(pool, scope)).projection).toEqual(
          final.projection,
        );
      },
    );
    it("refuses missing consumer heartbeat; cancel remains available; restart does not allocate again", async () => {
      await f.pool.query("UPDATE btc_desk_runtime SET ready=false");
      await expect(
        previewDeskCommand(pool, "token", open(), "blocked"),
      ).rejects.toThrow("TRADING_CONSUMER_UNAVAILABLE");
      await consumeDeskAccount(pool, "manual");
      const first = await activateManualDesk(pool, "fixture-owner", "ioc"),
        second = await activateManualDesk(pool, "fixture-owner", "ioc");
      expect(first.genesis).toBe(second.genesis);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM btc_ledger_events WHERE event_type='cash'",
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        activateManualDesk(pool, "fixture-owner", "passive"),
      ).rejects.toThrow("BTC_DESK_ACTIVATION_CONFLICT");
    });
    it("observed stop persists and retries only real subsequent depth, including after recovery", async () => {
      // Fixture stop at the observed bid: its order risk is still within the mandatory cap.
      const c = {
        ...open(),
        risk_plan: {
          stop_price_usd_raw: "64900000000",
          entry_floor_usd_raw: "65000000000",
        },
      } as DeskCommand;
      await command(c);
      tick();
      await f.capture(pool, { depth: "200000" });
      await consumeDeskAccount(pool, "manual");
      tick();
      await f.capture(pool, { depth: "100000" });
      await consumeDeskAccount(pool, "manual");
      expect(
        (await f.pool.query("SELECT reason FROM btc_desk_exits")).rows[0]
          .reason,
      ).toBe("stop_price");
      tick();
      await f.capture(pool, { depth: "100000" });
      await consumeDeskAccount(pool, "manual");
      expect(
        (await readLedgerAccount(pool, scope)).projection.positions[0]!
          .quantity_btc_raw,
      ).toBe("100000");
      await f.pool.query(
        "UPDATE btc_recovery_heads SET lease_until=clock_timestamp()-interval '1 second'",
      );
      tick();
      await f.capture(pool);
      await consumeDeskAccount(pool, "manual");
      tick();
      await f.capture(pool);
      await consumeDeskAccount(pool, "manual");
      expect(
        (await readLedgerAccount(pool, scope)).projection.positions[0]!
          .quantity_btc_raw,
      ).toBe("0");
    });
    it("advances a passive partial and serializes cancellation against a concurrent poll", async () => {
      await f.pool.query("UPDATE btc_desk_controls SET broker='passive'");
      const opening = {
        ...open(),
        limit_price_usd_raw: "64900000000",
      } as DeskCommand;
      const accepted = await command(opening);
      tick();
      await f.capture(pool, {
        trade: { side: "sell", price: "64900", quantity: "0.0015" },
      });
      await consumeDeskAccount(pool, "manual");
      expect(
        (await readLedgerAccount(pool, scope)).projection.positions[0]!
          .quantity_btc_raw,
      ).toBe("50000");
      const cancellation: DeskCommand = {
        account_id: "manual",
        action: "cancel",
        order_id: accepted.order_id!,
      };
      const p = await previewDeskCommand(
        pool,
        "token",
        cancellation,
        "cancel-race",
      );
      await Promise.all([
        consumeDeskAccount(pool, "manual"),
        acceptDeskCommand(pool, "token", "cancel", p.intent, "cancel-race"),
      ]);
      const current = (await reservations())[0]!;
      expect(current.status).toBe("cancelled");
      expect(current.remaining_btc_raw).toBe("0");
      expect(
        (await readLedgerAccount(pool, scope)).projection.positions[0]!
          .quantity_btc_raw,
      ).toBe("50000");
    });
    it("creates the first real CLI identity atomically and repeats without reallocating genesis", async () => {
      const fresh = await acceptanceFixture(url, () => now);
      try {
        const worker = fresh.worker();
        await seedMarginMetadata(worker.pool);
        await fresh.pool.query(
          "INSERT INTO auth_accounts(username,password_hash) VALUES('activation-owner','fixture-only')",
        );
        const a = await activateManualDesk(
          worker.pool,
          "activation-owner",
          "ioc",
        );
        const b = await activateManualDesk(
          worker.pool,
          "activation-owner",
          "ioc",
        );
        expect(a.account_id).toBe("manual");
        expect(b.genesis).toBe("duplicate");
        const rows = await fresh.pool.query(
          "SELECT identity FROM btc_ledger_accounts",
        );
        expect(rows.rows).toHaveLength(1);
        const ledger = await readLedgerAccount(
          worker.pool,
          ledgerScope(rows.rows[0].identity),
        );
        expect(ledger.projection.cash_usd_raw).toBe("1000000000");
        expect(ledger.events).toHaveLength(1);
        expect(
          (
            await fresh.pool.query(
              "SELECT enabled,broker FROM btc_desk_controls",
            )
          ).rows,
        ).toEqual([{ enabled: true, broker: "ioc" }]);
      } finally {
        await fresh.dispose();
      }
    });
    it("funding poll skips settled hours and does not fabricate a settlement oracle", async () => {
      const fetch = vi.fn();
      await fundDeskAccount(pool, "manual", fetch);
      expect(fetch).not.toHaveBeenCalled();
    });
  },
);
