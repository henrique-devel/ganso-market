import { describe, it, expect } from "vitest";
import {
  collectLiveSnapshot,
  livePages,
  parseLiveFill,
  parseLiveFunding,
  parseLivePosition,
  recoverLiveAccount,
} from "../../src/venues/hyperliquid/live-reconcile.js";
import type { createHyperliquidLiveBoundary } from "../../src/venues/hyperliquid/live-auth.js";
import {
  liveIdentity,
  venueFill,
  venueFunding,
  venueState,
} from "./live-fixture.js";
import { executionFixture, fixtureLease } from "./live-execution-fixture.js";
import { liveEntryCommand } from "./live-fixture.js";
const now = Date.parse("2026-10-09T06:00:00.000Z");
function boundary(
  changes: {
    after?: unknown;
    orders?: unknown;
    fills?: unknown;
    funding?: unknown;
    active?: unknown;
  } = {},
) {
  let states = 0;
  return {
    identity: liveIdentity,
    info: async (type: string) => {
      if (type === "clearinghouseState")
        return states++ === 0
          ? venueState(now)
          : (changes.after ?? venueState(now));
      if (type === "frontendOpenOrders") return changes.orders ?? [];
      if (type === "userFillsByTime") return changes.fills ?? [venueFill(now)];
      if (type === "userFunding") return changes.funding ?? [venueFunding(now)];
      if (type === "activeAssetData")
        return (
          changes.active ?? {
            user: liveIdentity.account_address,
            coin: "BTC",
            leverage: { type: "isolated", value: 1 },
          }
        );
      throw new Error("unsupported fixture request");
    },
  } as unknown as ReturnType<typeof createHyperliquidLiveBoundary>;
}
describe("JE13 real-source reconciliation contract", () => {
  it("restart recovers unknown receipts before reading money; foreign sources and outages stay pending", async () => {
    const f = executionFixture();
    expect(
      (
        await recoverLiveAccount({
          boundary: boundary(),
          execution: f.execution,
          from: now - 1000,
          clock: () => now,
        })
      ).pending,
    ).toBe(true);
    expect(await f.store.events("gap")).not.toEqual([]);
    await f.execution.execute(liveEntryCommand(now), fixtureLease);
    const r = await recoverLiveAccount({
      boundary: boundary(),
      execution: f.execution,
      from: now - 1000,
      clock: () => now,
    });
    expect(r.snapshot?.position_raw).toBe("10000");
    expect(r.pending).toBe(false);
    const broken = {
      ...boundary(),
      info: async () => {
        throw new Error("outage");
      },
    };
    expect(
      (
        await recoverLiveAccount({
          boundary: broken,
          execution: f.execution,
          from: now - 1000,
          clock: () => now + 1,
        })
      ).snapshot,
    ).toBeNull();
  });
  it("preserves exact fees, negative funding and BTC inventory without manufacturing settlement", async () => {
    const s = await collectLiveSnapshot(boundary(), now - 1000, () => now);
    expect(s).toMatchObject({
      position_raw: "10000",
      trading_balance_raw: "250000000",
      equity_raw: "250000000",
      history_complete: true,
      consistent: true,
      isolated_1x: true,
      flat: false,
    });
    expect(s.fills[0]?.fee_raw).toBe("10000");
    expect(s.funding[0]?.amount_raw).toBe("-1000");
    expect(parseLiveFill(venueFill(now, { fee: "-0.01" })).fee_raw).toBe(
      "-10000",
    );
    expect(
      parseLiveFunding(
        venueFunding(now, {
          delta: {
            type: "funding",
            coin: "BTC",
            usdc: "0.002",
            szi: "-0.0001",
            fundingRate: "0.000000000001",
            nSamples: 1,
          },
        }),
      ),
    ).toMatchObject({
      amount_raw: "2000",
      position_raw: "-10000",
      rate_raw: "1000000",
    });
  });
  it("uses inclusive pagination, deduplicates overlap and rejects saturated same-ms/gaps", async () => {
    const pages = [
        [
          { key: "a", time: 1 },
          { key: "b", time: 2 },
        ],
        [
          { key: "b", time: 2 },
          { key: "c", time: 3 },
        ],
        [{ key: "c", time: 3 }],
      ],
      cursors: number[] = [];
    const rows = await livePages({
      request: async (start) => {
        cursors.push(start);
        return pages.shift();
      },
      parse: (v) => v as { key: string; time: number },
      start: 0,
      end: 4,
      cap: 2,
    });
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(cursors).toEqual([0, 2, 3]);
    await expect(
      livePages({
        request: async () => [
          { key: "a", time: 0 },
          { key: "b", time: 0 },
        ],
        parse: (v) => v as { key: string; time: number },
        start: 0,
        end: 4,
        cap: 2,
      }),
    ).rejects.toThrow("SATURATED");
  });
  it("does not turn stale, missing, mismatched balances or unknown state into flat/zero", async () => {
    expect(() => parseLivePosition({})).toThrow();
    await expect(
      collectLiveSnapshot(
        boundary({
          after: {
            ...venueState(now),
            marginSummary: { accountValue: "251", totalRawUsd: "250" },
          },
        }),
        now - 1000,
        () => now,
      ),
    ).rejects.toThrow("BALANCE_DIVERGENCE");
    const stale = await collectLiveSnapshot(
      boundary({ after: venueState(now - 5000) }),
      now - 1000,
      () => now,
    );
    expect(stale.consistent).toBe(false);
    expect(stale.flat).toBe(false);
    const gap = await collectLiveSnapshot(
      boundary({ fills: [] }),
      now - 1000,
      () => now,
    );
    expect(gap.history_complete).toBe(false);
    expect(gap.position_raw).toBe("10000");
  });
  it("reorders causal same-ms partial fills and treats cancel-race changes as pending", async () => {
    const fills = [
      venueFill(now, {
        tid: 2,
        time: now - 100,
        startPosition: "0.0001",
        sz: "0.0001",
      }),
      venueFill(now, { tid: 1, time: now - 100 }),
    ];
    const s = await collectLiveSnapshot(
      boundary({ fills, after: venueState(now, "0.0002") }),
      now - 1000,
      () => now,
    );
    expect(s.fills.map((f) => f.start_position_raw)).toEqual(["0", "10000"]);
    expect(s.history_complete).toBe(true);
    expect(s.consistent).toBe(false);
    expect(s.flat).toBe(false);
  });
  it("requires actual-account isolated 1x evidence, also while flat", async () => {
    const s = await collectLiveSnapshot(
      boundary({
        active: {
          user: liveIdentity.account_address,
          coin: "BTC",
          leverage: { type: "cross", value: 10 },
        },
      }),
      now - 1000,
      () => now,
    );
    expect(s.isolated_1x).toBe(false);
    await expect(
      collectLiveSnapshot(
        boundary({
          active: {
            user: liveIdentity.signer_address,
            coin: "BTC",
            leverage: { type: "isolated", value: 1 },
          },
        }),
        now - 1000,
        () => now,
      ),
    ).rejects.toThrow("ACTIVE_ASSET_OWNER");
  });
});
