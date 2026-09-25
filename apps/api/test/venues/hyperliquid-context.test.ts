import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeBtcContextSnapshot,
  fetchBtcContextSnapshot,
  fetchBtcBookSnapshot,
} from "../../src/venues/hyperliquid/context-snapshot.js";
import { parseHyperliquidBtcMetadata } from "../../src/venues/hyperliquid/metadata.js";
import { contextSnapshotTime } from "../../src/trading/valuation.js";
import { financial, market } from "../trading/valuation-fixture.js";
import { valueFinancials } from "../../src/trading/valuation.js";
import { metadata, iso, start } from "../trading/bars-fixture.js";
const snapshotBody = [
  {
    universe: [
      { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 40 },
    ],
    marginTables: [],
    collateralToken: 0,
  },
  [
    {
      markPx: "65000",
      oraclePx: "64990",
      funding: "0.0001",
      openInterest: "25",
    },
  ],
] as const;
function snapshot(at = start + 100_000) {
  return normalizeBtcContextSnapshot(
    snapshotBody,
    {
      requestedAt: iso(at),
      receivedAt: iso(at + 200),
      serverDate: new Date(at).toUTCString(),
      cacheStatus: "Miss from cloudfront",
      age: null,
    },
    metadata,
    "http-test",
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("BTC current-state response provenance", () => {
  it("preserves raw current state and HTTP timing without fabricating venue event time", () => {
    const e = snapshot();
    expect(e).toMatchObject({
      source_id: "hyperliquid:mainnet:info",
      source_timestamp: null,
      parser_version: "hyperliquid.context-snapshot.v1",
      payload: {
        kind: "mark_funding",
        snapshot: { raw_context: snapshotBody[1]![0] },
      },
    });
    if (e.payload.kind !== "mark_funding") throw Error("fixture");
    expect(contextSnapshotTime(e.payload.snapshot, e.received_at)).toBe(
      iso(start + 100_000),
    );
  });
  it.each([
    { serverDate: null },
    { serverDate: "invalid" },
    { cacheStatus: "Hit from cloudfront" },
    { age: "1" },
    { age: "bad" },
    { receivedAt: iso(start + 102_000) },
    { serverDate: new Date(start + 99_000 - 1000).toUTCString() },
    { serverDate: new Date(start + 101_000).toUTCString() },
    { requestedAt: iso(start + 101_000) },
  ])("refuses uncertain, stale, cached or future response %j", (delta) => {
    expect(() =>
      normalizeBtcContextSnapshot(
        snapshotBody,
        {
          requestedAt: iso(start + 100_000),
          receivedAt: iso(start + 100_200),
          serverDate: new Date(start + 100_000).toUTCString(),
          cacheStatus: "Miss from cloudfront",
          age: null,
          ...delta,
        },
        metadata,
        "test",
      ),
    ).toThrow("TIME_UNPROVEN");
  });
  it("validates BTC mapping and metadata version in the same response", () => {
    const body = structuredClone(snapshotBody) as any;
    body[0].universe[0].szDecimals = 4;
    expect(() =>
      normalizeBtcContextSnapshot(
        body,
        {
          requestedAt: iso(start),
          receivedAt: iso(start + 200),
          serverDate: new Date(start).toUTCString(),
          cacheStatus: "Miss from cloudfront",
          age: null,
        },
        metadata,
        "test",
      ),
    ).toThrow("METADATA_CHANGED");
  });
  it("financial consumers expose the response clock while source time remains unknown", () => {
    const m = market();
    m.as_of = iso(start + 100_200);
    m.capture!.at = start + 100_200;
    m.context!.payload = {
      ...snapshot(),
      quality: "unknown",
      gap_epoch: 0,
      revalidation: "current_state_only",
      continuity: "unproven",
    };
    expect(valueFinancials(financial([]), m).maintenance).toMatchObject({
      quality: "fresh",
      source_timestamp: null,
      timestamp_basis: "http_response_date",
      freshness_timestamp: iso(start + 100_000),
      usable_for_risk: true,
    });
    m.as_of = iso(start + 105_001);
    expect(valueFinancials(financial([]), m).maintenance).toMatchObject({
      quality: "stale",
      usable_for_risk: false,
    });
    m.as_of = iso(start + 100_200);
    m.capture!.health.channels.context.needs_revalidation = true;
    expect(valueFinancials(financial([]), m).maintenance.usable_for_risk).toBe(
      false,
    );
  });
  it("books expire after 2 seconds and WS context never receives inferred source time", () => {
    const m = market();
    m.as_of = iso(start + 102_001);
    m.context!.payload = {
      ...m.context!.payload,
      source_timestamp: null,
      quality: "unknown",
    };
    expect(valueFinancials(financial([]), m)).toMatchObject({
      closing: { quality: "stale" },
      maintenance: {
        quality: "source_time_unproven",
        usable_for_risk: false,
        freshness_timestamp: null,
      },
    });
  });
  it("REST L2 retains the venue time, finite full depth and honest source identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              coin: "BTC",
              time: start,
              levels: [
                [{ px: "64000", sz: "1", n: 1 }],
                [{ px: "64001", sz: "2", n: 1 }],
              ],
            }),
          ),
      ),
    );
    const e = await fetchBtcBookSnapshot(metadata);
    expect(e).toMatchObject({
      source_id: "hyperliquid:mainnet:info",
      parser_version: "hyperliquid.book-snapshot.v1",
      source_timestamp: iso(start),
      payload: { semantics: "full_snapshot_top_20" },
    });
    const m = market();
    m.book!.payload = {
      ...e,
      quality: "fresh",
      gap_epoch: 0,
      revalidation: "none",
      continuity: "unproven",
      received_at: m.as_of,
    };
    expect(valueFinancials(financial([]), m).closing.quality).toBe("stale");
  });
  it.each([
    new Response("unavailable", { status: 503 }),
    new Response("x".repeat(262145)),
  ])(
    "refuses failed or oversized HTTP responses without retries",
    async (response) => {
      const mock = vi.fn(async () => response);
      vi.stubGlobal("fetch", mock);
      await expect(fetchBtcContextSnapshot(metadata)).rejects.toThrow(
        /BTC_CONTEXT_RESPONSE/,
      );
      expect(mock).toHaveBeenCalledOnce();
    },
  );
  it("public fetch has a deadline, no redirect/retry/credentials and keeps response evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start + 100_000);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(snapshotBody), {
          headers: {
            Date: new Date(start + 100_000).toUTCString(),
            "X-Cache": "Miss from cloudfront",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const m = parseHyperliquidBtcMetadata(snapshotBody[0], iso(start));
    expect((await fetchBtcContextSnapshot(m)).source_timestamp).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://api.hyperliquid.xyz/info",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    ]);
  });
});
