import { describe, expect, it } from "vitest";
import { executionFixture, fixtureLease } from "./live-execution-fixture.js";
import {
  LiveExecution,
  LIVE_COMMAND_VERSION,
  buildLiveAction,
  parseLiveBatchReceipt,
  type LiveCommand,
} from "../../src/venues/hyperliquid/live-execution.js";
import {
  liveIdentity,
  liveEntryCommand,
  liveSnapshot,
} from "./live-fixture.js";
import { liveCloid } from "../../src/venues/hyperliquid/live-contract.js";
describe("JE13 live submission and authoritative receipts (simulated transport)", () => {
  it("builds maker-only entries and refuses stale/mutated plans, wrong metadata, nonflat or unknown accounts", () => {
    const f = executionFixture(),
      c = liveEntryCommand(f.clock()),
      id = liveCloid(liveIdentity, c.scope, c.operation_id);
    expect(buildLiveAction(liveIdentity, c, id, f.clock())).toMatchObject({
      grouping: "na",
      orders: [{ b: true, r: false, t: { limit: { tif: "Alo" } } }],
    });
    for (const delta of [
      { metadata_at: f.clock() - 2001 },
      { snapshot: liveSnapshot(f.clock()) },
      {
        snapshot: liveSnapshot(f.clock(), {
          position_raw: "0",
          flat: true,
          consistent: false,
        }),
      },
      { plan: { ...c.plan, quantity_btc_raw: "999999" } },
      { book: { ...c.book, bid_raw: "63998000000" } },
    ])
      expect(() =>
        buildLiveAction(liveIdentity, { ...c, ...delta }, id, f.clock()),
      ).toThrow();
  });
  it("handles a global rejection, per-order mixed errors and malformed/truncated receipt vectors", () => {
    expect(
      parseLiveBatchReceipt({ status: "err", response: "bad batch" }, 2).map(
        (r) => r.state,
      ),
    ).toEqual(["rejected", "rejected"]);
    expect(
      parseLiveBatchReceipt(
        {
          status: "ok",
          response: {
            type: "order",
            data: {
              statuses: [
                { resting: { oid: 42 } },
                { error: "minimum" },
                { filled: { oid: 43, totalSz: "0.0001", avgPx: "64000" } },
              ],
            },
          },
        },
        3,
      ).map((r) => [r.state, r.oid]),
    ).toEqual([
      ["acknowledged", 42],
      ["rejected", null],
      ["acknowledged", 43],
    ]);
    expect(() =>
      parseLiveBatchReceipt(
        { status: "ok", response: { type: "order", data: { statuses: [] } } },
        1,
      ),
    ).toThrow("RECEIPT_VECTOR");
  });
  it("burns an uncertain request and queries it after restart instead of resubmission or fabricated cash", async () => {
    const f = executionFixture(),
      c = liveEntryCommand(f.clock());
    f.submit.mockRejectedValueOnce(
      new Error("transport timeout containing a secret"),
    );
    expect((await f.execution.execute(c, fixtureLease)).state).toBe(
      "uncertain",
    );
    const restarted = new LiveExecution(
      f.store,
      { submit: f.submit, info: f.info },
      f.clock,
    );
    f.advance(6000);
    expect((await restarted.execute(c, fixtureLease)).state).toBe("uncertain");
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.store.journal)).not.toContain("secret");
    const r = f.store.requests[0]!;
    f.info.mockResolvedValue({
      status: "order",
      order: {
        status: "triggered",
        order: { coin: "BTC", oid: 1, cloid: r.cloid },
      },
    });
    expect((await restarted.recover(r)).state).toBe("triggered");
    expect(await f.store.events("fill")).toEqual([]);
    await expect(
      restarted.execute(
        { ...c, plan: { ...c.plan, quantity_btc_raw: "9999" } },
        fixtureLease,
      ),
    ).rejects.toThrow("IDEMPOTENCY_COLLISION");
  });
  it("concurrent duplicate intents submit once, ACK starts the maker deadline, and cancelling never closes a partial", async () => {
    const f = executionFixture(),
      c = liveEntryCommand(f.clock());
    await Promise.all([
      f.execution.execute(c, fixtureLease),
      f.execution.execute(c, fixtureLease),
    ]);
    expect(f.submit).toHaveBeenCalledTimes(1);
    const r = f.store.requests[0]!,
      receipts =
        await f.store.events<Awaited<ReturnType<LiveExecution["execute"]>>>(
          "receipt",
        );
    f.advance(1999);
    expect(
      await f.execution.cancelExpired(
        r,
        receipts,
        fixtureLease,
        c.metadata,
        c.metadata_at,
      ),
    ).toBeNull();
    f.advance(1);
    await f.execution.cancelExpired(
      r,
      receipts,
      fixtureLease,
      c.metadata,
      c.metadata_at,
    );
    expect(f.submit.mock.calls[1]![0].action).toEqual({
      type: "cancelByCloid",
      cancels: [{ asset: 0, cloid: r.cloid }],
    });
    expect(await f.store.events("fill")).toEqual([]);
  });
  it("only cancels its own maker and uses the observed residual in reduce-only IOC, including below-minimum residuals", async () => {
    const f = executionFixture(),
      c = liveEntryCommand(f.clock());
    const close: LiveCommand = {
      version: LIVE_COMMAND_VERSION,
      kind: "close",
      scope: c.scope,
      operation_id: "close:1",
      metadata: c.metadata,
      metadata_at: f.clock(),
      snapshot: liveSnapshot(f.clock()),
      limit_price_raw: "60000000000",
      cause: "protection_unconfirmed",
    };
    await f.execution.execute(close, fixtureLease);
    expect(f.submit.mock.calls[0]![0].action).toMatchObject({
      orders: [
        { s: "0.0001", b: false, r: true, t: { limit: { tif: "Ioc" } } },
      ],
    });
    await expect(
      f.execution.execute(
        {
          version: LIVE_COMMAND_VERSION,
          kind: "cancel",
          scope: c.scope,
          operation_id: "cancel:foreign",
          metadata: c.metadata,
          metadata_at: f.clock(),
          target_operation_id: "close:1",
          target_cloid: f.store.requests[0]!.cloid,
        },
        fixtureLease,
      ),
    ).rejects.toThrow("CANCEL_OWNER");
    const residual = {
      ...close,
      operation_id: "close:residual",
      snapshot: liveSnapshot(f.clock(), { position_raw: "1000" }),
    };
    await f.execution.execute(residual, fixtureLease);
    expect(f.submit.mock.calls[1]![0].action).toMatchObject({
      orders: [{ s: "0.00001", r: true }],
    });
  });
});
