import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeBtcContextSnapshot,
  fetchBtcContextSnapshot,
  fetchBtcBookSnapshot,
  fetchBtcMetadataSnapshot,
} from "../../src/venues/hyperliquid/context-snapshot.js";
import { parseHyperliquidBtcMetadata } from "../../src/venues/hyperliquid/metadata.js";
import { contextSnapshotTime } from "../../src/trading/valuation.js";
import { financial, market } from "../trading/valuation-fixture.js";
import { valueFinancials } from "../../src/trading/valuation.js";
import { metadata, iso, start } from "../trading/bars-fixture.js";
import { SnapshotTransportError } from "../../src/venues/hyperliquid/recovery.js";
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("BTC current-state response provenance", () => {
  it("refreshes the same public metadata identity with its existing eight-second deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify(snapshotBody[0])),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await fetchBtcMetadataSnapshot();
    expect(result.instrument.instrument_version).toBe(
      metadata.instrument.instrument_version,
    );
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      type: "meta",
      dex: "",
    });
  });
  it.each([408, 429, 500, 502, 503, 504])(
    "classifies HTTP %s without retrying the request internally",
    async (status) => {
      const fetch = vi.fn(
        async () =>
          new Response("private response", {
            status,
            headers: { "Retry-After": "90" },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(fetchBtcContextSnapshot(metadata)).rejects.toMatchObject({
        kind: status === 429 ? "rate_limited" : "http_unavailable",
        retryAfterMs: 90_000,
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([400, 401, 403, 404])("keeps HTTP %s terminal", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private", { status })),
    );
    await expect(fetchBtcBookSnapshot(metadata)).rejects.toThrow(
      "BTC_CONTEXT_RESPONSE_REFUSED",
    );
  });
  it("preserves Retry-After dates and classifies named network loss only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("rate", {
            status: 429,
            headers: { "Retry-After": new Date(start + 120_000).toUTCString() },
          }),
      ),
    );
    await expect(fetchBtcBookSnapshot(metadata)).rejects.toMatchObject({
      retryAfterMs: 120_000,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("private", { cause: { code: "ECONNRESET" } });
      }),
    );
    await expect(fetchBtcBookSnapshot(metadata)).rejects.toBeInstanceOf(
      SnapshotTransportError,
    );
  });
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
  it("rejects late headers before accepting or normalizing a response, even before the abort timer fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        vi.setSystemTime(start + 1501);
        return new Response(new ReadableStream({ cancel }), {
          headers: {
            Date: new Date(start).toUTCString(),
            "X-Cache": "Miss from cloudfront",
          },
        });
      }),
    );
    await expect(fetchBtcContextSnapshot(metadata)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("keeps the deadline reason if a stalled body and its cleanup report AbortError", async () => {
    const controller = new AbortController();
    const deadline = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    const read = vi.fn(async () => {
      controller.abort(new DOMException("deadline", "TimeoutError"));
      throw new DOMException("body aborted", "AbortError");
    });
    const cancel = vi.fn(async () => {
      throw new DOMException("cleanup", "AbortError");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body: { getReader: () => ({ read, cancel }) },
      })),
    );
    await expect(fetchBtcContextSnapshot(metadata)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(deadline).toHaveBeenCalledWith(1500);
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects a late body and disposes it without manufacturing a received timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const cancel = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              vi.setSystemTime(start + 1501);
              return {
                done: false,
                value: Buffer.from(JSON.stringify(snapshotBody)),
              };
            },
            cancel,
          }),
        },
      })),
    );
    await expect(fetchBtcContextSnapshot(metadata)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("forwards operator cancellation to the active request with the unchanged deadline", async () => {
    const stop = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        stop.abort();
        options.signal.throwIfAborted();
      }),
    );
    await expect(
      fetchBtcContextSnapshot(metadata, stop.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
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
