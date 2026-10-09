import { describe, it, expect, vi } from "vitest";
import { LiveProtectionCoordinator } from "../../src/venues/hyperliquid/live-protection.js";
import { liveEntryCommand, liveSnapshot, venueFill } from "./live-fixture.js";
import { executionFixture, fixtureLease } from "./live-execution-fixture.js";
import {
  parseLiveFill,
  parseLiveOrders,
} from "../../src/venues/hyperliquid/live-reconcile.js";
function setup() {
  const f = executionFixture(),
    c = liveEntryCommand(f.clock());
  let quantity = "10000";
  const fills = [parseLiveFill(venueFill(f.clock() + 200))];
  const snapshot = () =>
    liveSnapshot(f.clock(), { position_raw: quantity, fills: [...fills] });
  const refresh = vi.fn(async () => {
    const stops = f.store.requests.filter((r) => r.kind === "stop");
    const latest = stops.at(-1)!;
    const order = (latest.action.orders as Array<Record<string, unknown>>)[0]!;
    return liveSnapshot(f.clock(), {
      position_raw: quantity,
      fills: [...fills],
      orders: parseLiveOrders([
        {
          coin: "BTC",
          side: "A",
          sz: order.s,
          limitPx: order.p,
          oid: 2,
          cloid: latest.cloid,
          reduceOnly: true,
          isPositionTpsl: true,
          isTrigger: true,
          orderType: "Stop Market",
          triggerPx: (order.t as { trigger: { triggerPx: string } }).trigger
            .triggerPx,
        },
      ]),
    });
  });
  const coordinator = new LiveProtectionCoordinator(f.execution, refresh);
  const input = () => ({
    entry: f.store.requests[0]!,
    snapshot: snapshot(),
    manifest: c.manifest,
    metadata: c.metadata,
    metadata_at: c.metadata_at,
    lease: fixtureLease,
    mark_price_raw: "64000000000",
    mark_at: f.clock(),
    risk_blocked: false,
  });
  const begin = async () => {
    await f.execution.execute(c, fixtureLease);
    f.advance(200);
  };
  return {
    ...f,
    c,
    fills,
    snapshot,
    refresh,
    coordinator,
    input,
    begin,
    setQuantity: (q: string) => {
      quantity = q;
    },
  };
}
describe("JE13 first-partial native protection (simulated venue)", () => {
  it("installs a separate position mark-trigger market stop on the FIRST partial, then confirms its presence", async () => {
    const f = setup();
    await f.begin();
    const result = await f.coordinator.reconcile(f.input());
    expect(result.state).toBe("confirmed");
    expect(result.protection!.quantity_btc_raw).toBe("10000");
    expect(result.protection!.first_fill_at).toBe(
      new Date(f.fills[0]!.time).toISOString(),
    );
    expect(f.submit.mock.calls[1]![0].action).toMatchObject({
      grouping: "positionTpsl",
      orders: [
        {
          s: "0.0001",
          r: true,
          b: false,
          t: { trigger: { isMarket: true, tpsl: "sl", triggerPx: "63800" } },
          p: "57420",
        },
      ],
    });
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.store.requests.map((r) => r.kind)).toEqual(["entry", "stop"]);
    // No ACK is credited as a financial fill.
    expect(await f.store.events("fill")).toEqual([]);
  });
  it("cash proof pending preserves the native stop attempt and independently requests reduction without claiming flat", async () => {
    const f = setup();
    await f.begin();
    vi.spyOn(f.store, "latest").mockImplementation(async () => ({
      snapshot: f.store.snapshot,
      pending: true,
    }));
    const result = await f.coordinator.reconcile(f.input());
    expect(result.state).toBe("pending");
    expect(result.reasons).toContain("FINANCIAL_RECONCILIATION_PENDING");
    expect(result.urgent_close_requested).toBe(true);
    expect(f.store.requests.map((r) => r.kind)).toEqual([
      "entry",
      "stop",
      "cancel",
      "close",
    ]);
    expect(f.store.requests.filter((r) => r.kind === "stop")).toHaveLength(1);
    expect(f.store.requests.at(-1)!.action).toMatchObject({
      orders: [{ r: true, t: { limit: { tif: "Ioc" } } }],
    });
  });
  it("additional partials and restart preserve first price/ATR/time, increasing only protected size", async () => {
    const f = setup();
    await f.begin();
    const first = await f.coordinator.reconcile(f.input());
    f.advance(100);
    f.setQuantity("20000");
    f.fills.push(
      parseLiveFill(
        venueFill(f.clock() + 100, {
          tid: 2,
          startPosition: "0.0001",
          hash: `0x${"c".repeat(64)}`,
        }),
      ),
    );
    const restarted = new LiveProtectionCoordinator(f.execution, f.refresh);
    const second = await restarted.reconcile(f.input());
    expect(second.state).toBe("confirmed");
    expect(second.protection).toEqual({
      ...first.protection,
      quantity_btc_raw: "20000",
    });
    expect(f.store.requests.filter((r) => r.kind === "stop")).toHaveLength(2);
  });
  it("a rejected/uncertain stop blocks entries and requests IOC even when parent cancellation fails", async () => {
    const f = setup();
    await f.begin();
    f.submit.mockImplementation(async (r) => {
      if (r.kind === "cancel") throw new Error("cancel offline");
      return r.kind === "stop"
        ? {
            status: "ok",
            response: {
              type: "order",
              data: { statuses: [{ error: "native unavailable" }] },
            },
          }
        : {
            status: "ok",
            response: {
              type: "order",
              data: {
                statuses: [
                  { filled: { oid: 3, totalSz: "0.0001", avgPx: "64000" } },
                ],
              },
            },
          };
    });
    const r = await f.coordinator.reconcile(f.input());
    expect(r.state).toBe("pending");
    expect(r.urgent_close_requested).toBe(true);
    expect(f.store.requests.map((r) => r.kind)).toEqual([
      "entry",
      "stop",
      "cancel",
      "close",
    ]);
    expect(f.store.requests.at(-1)!.action).toMatchObject({
      orders: [{ s: "0.0001", r: true, t: { limit: { tif: "Ioc" } } }],
    });
    expect(r.reasons).toContain("PROTECTION_UNCONFIRMED");
    expect(await f.store.events("gap")).not.toEqual([]);
  });
  it("ACK followed by confirmation outage is not protected and never causes blind re-signing on restart", async () => {
    const f = setup();
    await f.begin();
    f.refresh.mockRejectedValue(new Error("info unavailable"));
    const first = await f.coordinator.reconcile(f.input());
    expect(first.state).toBe("pending");
    expect(first.reasons).toContain("STOP_CONFIRMATION_UNAVAILABLE");
    const sent = f.submit.mock.calls.length;
    const second = await new LiveProtectionCoordinator(
      f.execution,
      f.refresh,
    ).reconcile(f.input());
    expect(second.state).toBe("pending");
    expect(f.submit).toHaveBeenCalledTimes(sent);
    expect(f.info).toHaveBeenCalled();
  });
  it("triggered is not filled: simultaneous stop and IOC stay reduce-only and a partial residual remains pending", async () => {
    const f = setup();
    await f.begin();
    await f.coordinator.reconcile(f.input());
    f.advance(100);
    f.setQuantity("4000");
    // The native trigger is no longer present as a resting protection.
    f.refresh.mockImplementation(async () => f.snapshot());
    f.info.mockResolvedValue({
      status: "order",
      order: {
        status: "triggered",
        order: { coin: "BTC", oid: 2, cloid: f.store.requests[1]!.cloid },
      },
    });
    const r = await f.coordinator.reconcile({
      ...f.input(),
      mark_price_raw: "63800000000",
    });
    expect(r.state).toBe("pending");
    expect(r.reasons).toContain("STOP_TRIGGERED");
    const exits = f.store.requests.filter(
      (r) => r.kind === "stop" || r.kind === "close",
    );
    expect(
      exits.every((r) => (r.action.orders as Array<{ r: boolean }>)[0]!.r),
    ).toBe(true);
    expect(exits.at(-1)!.action).toMatchObject({
      orders: [{ s: "0.00004", b: false }],
    });
    expect(r.protection!.quantity_btc_raw).toBe("4000");
  });
  it("unknown ownership/history/position never becomes flat, while a proved flat snapshot can finish recovery", async () => {
    const f = setup();
    await f.begin();
    const unknown = await f.coordinator.reconcile({
      ...f.input(),
      snapshot: liveSnapshot(f.clock(), { fills: [], history_complete: false }),
    });
    expect(unknown.state).toBe("pending");
    expect(unknown.urgent_close_requested).toBe(true);
    expect(unknown.protection).toBeNull();
    const stale = await f.coordinator.reconcile({
      ...f.input(),
      snapshot: liveSnapshot(f.clock() - 2001),
    });
    expect(stale.state).toBe("pending");
    expect(
      (
        await f.coordinator.reconcile({
          ...f.input(),
          snapshot: liveSnapshot(f.clock(), {
            position_raw: "0",
            flat: true,
            fills: [],
            funding: [],
          }),
        })
      ).state,
    ).toBe("flat");
  });
});
