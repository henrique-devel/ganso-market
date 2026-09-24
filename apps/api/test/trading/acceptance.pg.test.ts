import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptanceFixture } from "./acceptance-fixture.js";
import { identity, iso } from "./ledger-fixture.js";
import { riskOrder, seedRiskFunding } from "./risk-fixture.js";
import { seedMarginMetadata } from "./margin-fixture.js";
import { ledgerScope, replayLedger } from "../../src/trading/ledger.js";
import {
  createLedgerAccount,
  readLedgerAccount,
} from "../../src/storage/ledgerstore.js";
import {
  readLedgerValuation,
  replayFinancials,
} from "../../src/storage/valuationstore.js";
import { readReservationsTx } from "../../src/storage/reservationstore.js";
import { applyIoc } from "../../src/storage/brokerstore.js";
import { applyPassive } from "../../src/storage/passivestore.js";
import {
  reconcileFunding,
  type FundingCommand,
} from "../../src/storage/fundingstore.js";
import { applyRisk, readRiskTx } from "../../src/storage/riskstore.js";
import { recoverAccount } from "../../src/storage/recoverystore.js";
import { recoverySnapshotTx } from "../../src/storage/recovery-audit.js";

const url = process.env.GANSO_TEST_DATABASE_URL;
type Mode = "ioc" | "passive";
const owners = [ledgerScope(identity("long")), ledgerScope(identity("short"))];
const idle = ledgerScope(identity("idle"));
let f: Awaited<ReturnType<typeof acceptanceFixture>>;
let w: ReturnType<typeof f.worker>;
let now: number, metadataId: string;
const tick = (ms = 100) => {
  now += ms;
  vi.setSystemTime(now);
};
const capture = (options: Parameters<typeof f.capture>[1] = {}) => {
  tick();
  return f.capture(w.pool, options);
};
const orders = (owner: typeof idle) =>
  w.pool.transaction((tx) => readReservationsTx(tx, owner.account_id));
const risk = (owner: typeof idle) =>
  w.pool.transaction((tx) => readRiskTx(tx, owner.account_id));
const snapshot = (owner: typeof idle) =>
  w.pool.transaction((tx) => recoverySnapshotTx(tx, owner.account_id));
const observe = (owner: typeof idle, id: string) =>
  applyRisk(w.pool, owner, {
    action: "observe",
    operation_id: id,
    reason: "S10 integrated risk cycle",
  });

async function submit(
  mode: Mode,
  owner: typeof idle,
  id: string,
  quantity = "200000",
  reduce = false,
) {
  const side = (owner.account_id === "long") !== reduce ? "buy" : "sell";
  const price =
    mode === "ioc"
      ? side === "buy"
        ? "65100000000"
        : "64900000000"
      : side === "buy"
        ? "64900000000"
        : "65100000000";
  const order = riskOrder(id, {
    side,
    intent: reduce ? "reduce" : "open",
    quantity_btc_raw: quantity,
    price_cap_usd_raw: "65100000000",
    valid_until: iso(now + 7200000),
    risk_plan: {
      entry_floor_usd_raw: "64900000000",
      stop_price_usd_raw: side === "buy" ? "64800000000" : "65200000000",
    },
  });
  return mode === "ioc"
    ? applyIoc(w.pool, owner, {
        action: "submit",
        operation_id: `submit:${id}`,
        order,
        intent: {
          schema_version: "btc.ioc.v1",
          decision_at: iso(now),
          latency_ms: 0,
          limit_price_usd_raw: price,
          fee_metadata_id: metadataId,
        },
      })
    : applyPassive(w.pool, owner, {
        action: "submit",
        operation_id: `submit:${id}`,
        order,
        intent: {
          schema_version: "btc.passive.v1",
          limit_price_usd_raw: price,
          fee_metadata_id: metadataId,
        },
      });
}
const execute = (
  mode: Mode,
  owner: typeof idle,
  id: string,
  operation = `execute:${id}`,
) =>
  mode === "ioc"
    ? applyIoc(w.pool, owner, {
        action: "execute",
        operation_id: operation,
        order_id: id,
      })
    : applyPassive(w.pool, owner, {
        action: "advance",
        operation_id: operation,
      });
const cancel = (mode: Mode, owner: typeof idle, id: string) =>
  mode === "ioc"
    ? applyIoc(w.pool, owner, {
        action: "cancel",
        operation_id: `cancel:${id}`,
        order_id: id,
      })
    : applyPassive(w.pool, owner, {
        action: "cancel",
        operation_id: `cancel:${id}`,
        order_id: id,
      });
async function fillBook(
  mode: Mode,
  owner: typeof idle,
  quantity: string,
  reduce = false,
) {
  const buy = (owner.account_id === "long") !== reduce;
  if (mode === "ioc") return capture({ depth: quantity });
  // Entire displayed queue (0.001 BTC) precedes us. The posterior opposing
  // trade must burn it before the requested fill; touching the book is no fill.
  return capture({
    trade: {
      side: buy ? "sell" : "buy",
      price: buy ? "64900" : "65100",
      quantity:
        quantity === "100000"
          ? "0.002"
          : quantity === "40000"
            ? "0.0014"
            : "0.0016",
    },
  });
}
async function restart(rebuild = true) {
  await w.stop(); // Close every actual worker connection; next pool has a new lifetime.
  if (rebuild)
    await f.pool.query(
      "DELETE FROM btc_ledger_projections WHERE account_id IN ('long','short')",
    );
  // Only disposable lease clock is expired, never authority or evidence.
  await f.pool.query(
    "UPDATE btc_recovery_heads SET lease_until=clock_timestamp()-interval '1 second'",
  );
  w = f.worker();
  for (const owner of owners)
    expect(await recoverAccount(w.pool, owner)).toMatchObject({
      status: "ready",
    });
}

// Hand-derived oracle, USD6/BTC8. Entry 0.001 BTC, close 0.0004 + 0.0006.
// IOC: 65100 -> 64900 long / 64900 -> 65100 short, PnL -0.20;
// taker 0.00045 costs 0.058500. Passive reverses these prices, PnL +0.20;
// maker 0.00015 costs 0.019500. Funding: 0.001 * 64990 * 0.0001 = 0.006499.
// These literals never call valuation/funding/fee code to calculate expectations.
const expected = {
  ioc: {
    long: "999735001",
    short: "999747999",
    fees: "-58500",
    pnl: "-200000",
  },
  passive: {
    long: "1000174001",
    short: "1000186999",
    fees: "-19500",
    pnl: "200000",
  },
};

describe.skipIf(!url)(
  "S10 integrated financial acceptance on disposable PostgreSQL",
  () => {
    beforeEach(async () => {
      now = Date.parse("2026-09-22T12:10:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      f = await acceptanceFixture(url, () => now);
      w = f.worker();
      for (const id of ["long", "short", "idle"])
        await createLedgerAccount(w.pool, identity(id));
      metadataId = await seedMarginMetadata(w.pool);
      for (const owner of owners) await seedRiskFunding(w.pool, owner);
      await capture();
    });
    afterEach(async () => {
      vi.useRealTimers();
      await f?.dispose();
    });

    it.each(["ioc", "passive"] as const)(
      "%s: isolated LONG + SHORT, partials, cancellation, funding, paused exits and rebuilt restart",
      async (mode) => {
        const untouched = await readLedgerAccount(w.pool, idle);
        const opening: Awaited<ReturnType<typeof readLedgerAccount>>[] = [];
        for (const [i, owner] of owners.entries()) {
          const other = await snapshot(owners[1 - i]!);
          expect((await observe(owner, "initial-risk")).state).toBe("NORMAL");
          await submit(mode, owner, "withdrawn-entry");
          await cancel(mode, owner, "withdrawn-entry");
          await submit(mode, owner, "entry");
          expect(
            (await orders(owner)).find((r) => r.order.order_id === "entry"),
          ).toMatchObject({
            status: "active",
            remaining_btc_raw: "200000",
            margin_usd_raw: "130200000",
            fee_usd_raw: "130200",
          });
          expect(
            (await readLedgerValuation(w.pool, owner, iso(now)))
              .balance_usd_raw,
          ).toBe("1000000000");
          if (mode === "passive") {
            await capture();
            expect(
              (await execute(mode, owner, "entry", "touch")).fills,
            ).toEqual([]);
          }
          await fillBook(mode, owner, "100000");
          const fill = await execute(mode, owner, "entry");
          expect(fill.fills).toMatchObject([
            {
              quantity_btc_raw: "100000",
              fee_usd_raw:
                mode === "ioc"
                  ? i === 0
                    ? "29295"
                    : "29205"
                  : i === 0
                    ? "9735"
                    : "9765",
            },
          ]);
          const committed = await snapshot(owner);
          expect(await execute(mode, owner, "entry")).toEqual(fill);
          expect(await snapshot(owner)).toEqual(committed);
          const ledger = await readLedgerAccount(w.pool, owner);
          expect(ledger.projection.positions).toMatchObject([
            {
              position_id: "position:1",
              quantity_btc_raw: i === 0 ? "100000" : "-100000",
            },
          ]);
          expect(
            (await readLedgerValuation(w.pool, owner, iso(now))).isolation,
          ).toMatchObject({ metadata_valid: true, compatible: true });
          opening.push(ledger);
          expect(await snapshot(owners[1 - i]!)).toEqual(other);
        }
        const anchors = await Promise.all(owners.map(risk));
        await restart();
        for (const [i, owner] of owners.entries()) {
          expect(await readLedgerAccount(w.pool, owner)).toEqual(opening[i]);
          expect(await risk(owner)).toEqual(anchors[i]);
          expect(
            (await orders(owner)).find((r) => r.order.order_id === "entry"),
          ).toMatchObject({
            status: "cancelled",
            margin_usd_raw: "0",
            fee_usd_raw: "0",
            remaining_btc_raw: "0",
          });
          expect((await cancel(mode, owner, "entry")).fills).toEqual([]);
        }
        // The next economic hour has no final funding evidence yet. It must pause
        // risk; the same historical position later settles once per owner.
        tick(Date.parse("2026-09-22T13:00:00.000Z") - now);
        const oracle = await f.capture(w.pool);
        const funding: FundingCommand = {
          operation_id: "funding:settle",
          period_hour: "2026-09-22T13:00:00.000Z",
          oracle_object_id: oracle,
          observation: {
            source: "hyperliquid:mainnet:fundingHistory",
            received_at: iso(now),
            row: {
              coin: "BTC",
              time: now,
              fundingRate: "0.0001",
              premium: "0",
            },
          },
        };
        for (const [i, owner] of owners.entries()) {
          expect(
            (
              await reconcileFunding(w.pool, owner, {
                ...funding,
                operation_id: "funding:pending",
                observation: null,
                oracle_object_id: null,
              })
            ).status,
          ).toBe("pending");
          expect((await observe(owner, "pending-risk")).state).toBe(
            "REDUCE_ONLY",
          );
          const result = await reconcileFunding(w.pool, owner, funding);
          expect(result).toMatchObject({
            status: "settled",
            positions: [
              {
                quantity_btc_raw: i === 0 ? "100000" : "-100000",
                delta_usd_raw: i === 0 ? "-6499" : "6499",
              },
            ],
          });
          expect(await reconcileFunding(w.pool, owner, funding)).toEqual(
            result,
          );
          expect((await risk(owner))!.state).toBe("REDUCE_ONLY");
          await expect(submit(mode, owner, "paused-entry")).rejects.toThrow(
            "BTC_RISK_REDUCE_ONLY",
          );
        }
        const paused = await Promise.all(owners.map(risk));
        const funded = await Promise.all(
          owners.map((owner) => readLedgerAccount(w.pool, owner)),
        );
        await restart();
        for (const [i, owner] of owners.entries()) {
          expect(await risk(owner)).toEqual(paused[i]);
          expect(await readLedgerAccount(w.pool, owner)).toEqual(funded[i]);
          await reconcileFunding(w.pool, owner, funding);
          for (const [id, qty] of [
            ["close-part", "40000"],
            ["close-rest", "60000"],
          ] as const) {
            await capture();
            await submit(
              mode,
              owner,
              id,
              id === "close-part" ? "100000" : "60000",
              true,
            );
            await fillBook(mode, owner, qty, true);
            expect((await execute(mode, owner, id)).fills).toMatchObject([
              { quantity_btc_raw: qty },
            ]);
            await cancel(mode, owner, id);
          }
          const ledger = await readLedgerAccount(w.pool, owner);
          const oracleValues = {
            balance_usd_raw:
              expected[mode][owner.account_id as "long" | "short"],
            fees_usd_raw: expected[mode].fees,
            funding_usd_raw: i === 0 ? "-6499" : "6499",
            realized_pnl_usd_raw: expected[mode].pnl,
            positions: [
              {
                position_id: "position:1",
                quantity_btc_raw: "0",
                cost_usd14_raw: "0",
              },
            ],
          };
          expect(replayLedger(ledger.identity, ledger.events)).toEqual(
            ledger.projection,
          );
          expect(
            replayFinancials(ledger.identity, ledger.events),
          ).toMatchObject(oracleValues);
          const value = await readLedgerValuation(w.pool, owner, iso(now));
          expect(value).toMatchObject(oracleValues);
          expect(value.maintenance.equity_usd_raw).toBe(
            oracleValues.balance_usd_raw,
          );
          expect(value.funding.usable_for_risk).toBe(true);
          expect(
            ledger.events.filter((e) => e.payload.event_type === "fill"),
          ).toHaveLength(3);
          expect(
            ledger.events.filter((e) => e.payload.event_type === "fee"),
          ).toHaveLength(3);
          expect(
            ledger.events.filter((e) => e.payload.event_type === "funding"),
          ).toHaveLength(1);
          expect(
            (await orders(owner)).every(
              (r) =>
                r.margin_usd_raw === "0" &&
                r.fee_usd_raw === "0" &&
                r.remaining_btc_raw === "0",
            ),
          ).toBe(true);
          expect(
            ledger.events.every(
              (e) =>
                e.account_id === owner.account_id &&
                e.experiment_id === owner.experiment_id,
            ),
          ).toBe(true);
        }
        const final = await Promise.all(
          owners.map((owner) => readLedgerAccount(w.pool, owner)),
        );
        const history = await Promise.all(owners.map(snapshot));
        const finalRisk = await Promise.all(owners.map(risk));
        await restart();
        for (const [i, owner] of owners.entries()) {
          expect(await readLedgerAccount(w.pool, owner)).toEqual(final[i]);
          expect(await snapshot(owner)).toEqual(history[i]);
          expect(history[i]!.cursors.btc_risk_events).toBeGreaterThan(9);
          expect(history[i]!.cursors.btc_reservation_events).toBeGreaterThan(9);
          expect(await risk(owner)).toEqual(finalRisk[i]);
          const value = await readLedgerValuation(w.pool, owner, iso(now));
          expect(value.balance_usd_raw).toBe(
            expected[mode][owner.account_id as "long" | "short"],
          );
          const before = await snapshot(owner);
          await execute(mode, owner, "close-rest");
          await cancel(mode, owner, "close-rest");
          await reconcileFunding(w.pool, owner, funding);
          expect(await snapshot(owner)).toEqual(before);
        }
        expect(await readLedgerAccount(w.pool, idle)).toEqual(untouched);
      },
      20000,
    );

    it.each(["ioc", "passive"] as const)(
      "%s: recovery readiness cannot promote missing or stale evidence into admission",
      async (mode) => {
        await restart();
        await capture({ unknownMark: true });
        await expect(submit(mode, owners[0]!, "unknown")).rejects.toThrow(
          "BTC_RISK_REDUCE_ONLY",
        );
        await capture();
        tick(5101);
        await expect(submit(mode, owners[1]!, "stale")).rejects.toThrow(
          "BTC_RISK_REDUCE_ONLY",
        );
        for (const owner of owners) {
          expect(await orders(owner)).toEqual([]);
          expect((await readLedgerAccount(w.pool, owner)).events).toHaveLength(
            1,
          );
          expect((await risk(owner))!.state).toBe("REDUCE_ONLY");
        }
      },
    );
  },
);
