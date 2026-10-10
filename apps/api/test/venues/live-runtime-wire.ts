import { vi } from "vitest";
import { liveIdentity, venueState } from "./live-fixture.js";
import type { LiveWire } from "../../src/venues/hyperliquid/live-auth.js";
import { liveDecimal } from "../../src/venues/hyperliquid/live-contract.js";
/** Synthetic wire only. Never configured by the production entrypoint. */
export function runtimeVenue() {
  // Synthetic venue clock trails receipt slightly, as a real remote source does.
  const venueClock = () => Date.now() - 50;
  let position = 0n,
    balance = 250000000n,
    oid = 0,
    tid = 0;
  const fills: Record<string, unknown>[] = [],
    funding: Record<string, unknown>[] = [],
    orders: Record<string, unknown>[] = [];
  const statuses = new Map<string, { oid: number; status: string }>();
  const exchanges: Record<string, unknown>[] = [];
  let partialOnEntry = false,
    fillOnCancel = false,
    loseAck = false,
    loseCancel = false,
    rejectStop = false,
    reducedOnce = false;
  let stale = false;
  function fill(order: Record<string, unknown>, q: bigint, close = false) {
    const buy = order.b === true,
      start = position;

    // The venue enforces reduce-only; concurrent exits can never reverse.
    if (
      close &&
      (position === 0n || (buy && position > 0n) || (!buy && position < 0n))
    )
      return;
    const actual =
      close && q > (position < 0n ? -position : position)
        ? position < 0n
          ? -position
          : position
        : q;
    position += buy ? actual : -actual;
    const fee = 1000n;
    balance -= fee;
    tid++;
    fills.push({
      coin: "BTC",
      px: order.p,
      sz: liveDecimal(actual.toString(), 8),
      side: buy ? "B" : "A",
      time: venueClock(),
      startPosition:
        (start < 0n ? "-" : "") +
        liveDecimal((start < 0n ? -start : start).toString(), 8),
      closedPnl: "0",
      hash: `0x${tid.toString(16).padStart(64, "0")}`,
      oid: order.oid,
      cloid: order.c,
      crossed: close,
      fee: "0.001",
      feeToken: "USDC",
      tid,
    });
  }
  const request = vi.fn(
    async (
      endpoint: "info" | "exchange",
      payload: unknown,
    ): Promise<unknown> => {
      const p = payload as Record<string, unknown>;
      if (endpoint === "exchange") {
        const action = p.action as Record<string, unknown>;
        exchanges.push(action);
        if (action.type === "cancelByCloid") {
          if (loseCancel) {
            loseCancel = false;
            throw new Error("synthetic disconnect before cancellation");
          }
          for (const c of action.cancels as { cloid: string }[]) {
            const parent = orders.find((o) => o.cloid === c.cloid);
            if (parent && fillOnCancel) {
              fillOnCancel = false;
              fill(
                parent._order as Record<string, unknown>,
                BigInt(parent._remaining as string),
              );
            }
            const index = orders.findIndex((o) => o.cloid === c.cloid);
            if (index >= 0) orders.splice(index, 1);
            const old = statuses.get(c.cloid);
            if (old) old.status = "canceled";
          }
          return {
            status: "ok",
            response: { type: "cancel", data: { statuses: ["success"] } },
          };
        }
        const order = (action.orders as Record<string, unknown>[])[0]!;
        order.oid = ++oid;
        const trigger = (order.t as { trigger?: { triggerPx: string } })
          .trigger;
        if (trigger && rejectStop)
          return {
            status: "ok",
            response: {
              type: "order",
              data: { statuses: [{ error: "synthetic stop rejection" }] },
            },
          };
        const q = BigInt(Math.round(Number(order.s) * 1e8));
        statuses.set(order.c as string, { oid, status: "open" });
        if (order.r === true && !trigger) {
          const residual = reducedOnce ? q : (q / 2n / 1000n) * 1000n || q;
          reducedOnce = true;
          fill(order, residual, true);
          statuses.get(order.c as string)!.status = "filled";
          if (position === 0n)
            for (let i = orders.length - 1; i >= 0; i--)
              if (orders[i]!.reduceOnly) {
                const o = statuses.get(orders[i]!.cloid as string);
                if (o) o.status = "canceled";
                orders.splice(i, 1);
              }
        } else {
          const part =
            partialOnEntry && !trigger ? (q / 2n / 1000n) * 1000n : 0n;
          if (part > 0n) fill(order, part);
          orders.push({
            coin: "BTC",
            oid,
            cloid: order.c,
            side: order.b ? "B" : "A",
            sz: liveDecimal((q - part).toString(), 8),
            limitPx: order.p,
            reduceOnly: order.r,
            isTrigger: !!trigger,
            isPositionTpsl: !!trigger,
            triggerPx: trigger?.triggerPx ?? "0",
            orderType: trigger ? "Stop Market" : "Limit",
            _order: order,
            _remaining: (q - part).toString(),
          });
        }
        if (loseAck && !trigger && order.r !== true) {
          loseAck = false;
          throw new Error("synthetic response loss");
        }
        return {
          status: "ok",
          response: {
            type: "order",
            data: { statuses: [{ resting: { oid } }] },
          },
        };
      }
      switch (p.type) {
        case "meta":
          return {
            universe: [
              {
                name: "BTC",
                szDecimals: 5,
                maxLeverage: 40,
                marginTableId: 40,
              },
            ],
            marginTables: [],
            collateralToken: 0,
          };
        case "clearinghouseState": {
          const s = venueState(
            venueClock() - (stale ? 5000 : 0),
            (position < 0n ? "-" : "") +
              liveDecimal((position < 0n ? -position : position).toString(), 8),
          );
          s.marginSummary = {
            accountValue: liveDecimal(balance.toString(), 6),
            totalRawUsd: liveDecimal(balance.toString(), 6),
          };
          return s;
        }
        case "frontendOpenOrders":
          return orders.map(({ _order: _a, _remaining: _b, ...o }) => o);
        case "activeAssetData":
          return {
            user: liveIdentity.account_address,
            coin: "BTC",
            leverage: { type: "isolated", value: 1 },
          };
        case "userFillsByTime":
          return fills.filter(
            (f) =>
              Number(f.time) >= Number(p.startTime) &&
              Number(f.time) <= Number(p.endTime),
          );
        case "userFunding":
          return funding.filter(
            (f) =>
              Number(f.time) >= Number(p.startTime) &&
              Number(f.time) <= Number(p.endTime),
          );
        case "orderStatus": {
          const o = statuses.get(p.oid as string);
          return o
            ? {
                status: "order",
                order: {
                  status: o.status,
                  order: { coin: "BTC", cloid: p.oid, oid: o.oid },
                },
              }
            : { status: "unknownOid" };
        }
        default:
          throw new Error("unhandled artificial venue query");
      }
    },
  );
  const wire: LiveWire = {
    isTestnet: false,
    request: <T>(endpoint: "info" | "exchange", payload: unknown) =>
      request(endpoint, payload) as Promise<T>,
  };
  return {
    wire,
    request,
    exchanges,
    fills,
    funding,
    orders,
    statuses,
    position: () => position,
    addFunding: (amount: bigint) => {
      balance += amount;
      const row = {
        time: venueClock(),
        hash: `0x${(1000 + funding.length).toString(16).padStart(64, "0")}`,
        delta: {
          type: "funding",
          coin: "BTC",
          usdc:
            (amount < 0n ? "-" : "") +
            liveDecimal((amount < 0n ? -amount : amount).toString(), 6),
          szi:
            (position < 0n ? "-" : "") +
            liveDecimal((position < 0n ? -position : position).toString(), 8),
          fundingRate: "-0.0001",
        },
      };
      funding.push(row, structuredClone(row)); // Same original twice, one cash movement.
    },
    configure: (c: {
      partial?: boolean;
      late_fill?: boolean;
      lost_ack?: boolean;
      lost_cancel?: boolean;
      reject_stop?: boolean;
      stale?: boolean;
    }) => {
      partialOnEntry = c.partial ?? false;
      fillOnCancel = c.late_fill ?? false;
      loseAck = c.lost_ack ?? false;
      loseCancel = c.lost_cancel ?? false;
      rejectStop = c.reject_stop ?? false;
      stale = c.stale ?? false;
    },
  };
}
