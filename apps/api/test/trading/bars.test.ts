import { describe, expect, it } from "vitest";
import {
  BAR_LIMITS,
  barStart,
  buildClosedBar,
  barWarmup,
} from "../../src/trading/bars.js";
import { captures, iso, metadata, start, trade } from "./bars-fixture.js";
const input = () => ({
  start,
  interval: 900_000 as const,
  asOf: start + 910_000,
  instrumentVersion: metadata.instrument.instrument_version,
  metadataId: "metadata",
  trades: [{ id: "t1", event: trade() }],
  captures: captures(),
});

describe("closed observed BTC bars", () => {
  it("uses UTC half-open 15m/1h buckets across midnight and UTC offsets", () => {
    expect(barStart(Date.parse("2024-01-01T02:59:59.999+03:00"), 900_000)).toBe(
      Date.parse("2023-12-31T23:45:00.000Z"),
    );
    expect(barStart(start, 3_600_000)).toBe(start);
    expect(barStart(start + 900_000, 900_000)).toBe(start + 900_000);
    expect(() =>
      buildClosedBar({
        ...input(),
        trades: [{ id: "boundary", event: trade(start + 900_000) }],
      }),
    ).toThrow("OUTSIDE_WINDOW");
  });
  it("sorts economic time and stable IDs, deduplicates, keeps fixed-point exact", () => {
    const events = [
      trade(start + 2000, 2, "64001.2", "0.00002"),
      trade(start + 1000, 1, "64000.1"),
      trade(start + 3000, 3, "63999.9"),
    ];
    const bar = buildClosedBar({
      ...input(),
      trades: [...events, events[0]!].map((event, i) => ({
        id: `t${i}`,
        event,
      })),
    });
    expect(bar.ohlc).toEqual({
      open: "64000100000",
      high: "64001200000",
      low: "63999900000",
      close: "63999900000",
      decimals: 6,
      unit: "USD_PER_BTC",
    });
    expect(bar.volume.raw).toBe("4000");
    expect(bar.trade_count).toBe(3);
    expect(bar.quality).toEqual({
      state: "observed_no_known_gap",
      reasons: [],
      continuity: "unproven",
    });
    expect(
      buildClosedBar({
        ...input(),
        trades: events.reverse().map((event, i) => ({ id: `r${i}`, event })),
      }).ohlc,
    ).toEqual(bar.ohlc);
  });
  it("forms a 1h bar without rescaling or manufacturing trades", () => {
    const bar = buildClosedBar({
      ...input(),
      interval: 3_600_000,
      asOf: start + 3_610_000,
      captures: captures(start, start + 3_610_000),
    });
    expect(bar.end_at).toBe(iso(start + 3_600_000));
    expect(bar.trade_count).toBe(1);
    expect(bar.quality.state).toBe("observed_no_known_gap");
  });
  it("does not publish until the lateness window closes", () => {
    expect(() => buildClosedBar({ ...input(), asOf: start + 909_999 })).toThrow(
      "NOT_CLOSED",
    );
    expect(() => barStart(NaN, 900_000)).toThrow("INVALID_TIME");
  });
  it("keeps empty/missing windows explicit and blocks warmup", () => {
    const bar = buildClosedBar({ ...input(), trades: [], captures: [] });
    expect(bar).toMatchObject({
      ohlc: null,
      trade_count: 0,
      volume: { raw: "0" },
    });
    expect(bar.quality.reasons).toEqual(["no_trades", "warmup_incomplete"]);
    expect(barWarmup([bar], 1, start + 910_000, 900_000).ready).toBe(false);
  });
  it("retains recovered trade gaps without claiming continuity", () => {
    const args = input();
    args.captures[2]!.health.gaps.push({
      epoch: 1,
      channel: "trades",
      reason: "disconnect",
      after_source_at: start + 5000,
      detected_at: start + 6000,
      resumed_at: start + 10_000,
      recovery: "delivery_resumed_only",
    });
    expect(buildClosedBar(args).quality.reasons).toContain("feed_gap");
  });
  it.each(["restarted", "history_truncated"] as const)(
    "rejects incomplete %s coverage",
    (field) => {
      const args = input();
      args.captures[0]![field] = true;
      expect(buildClosedBar(args).quality.state).toBe("incomplete");
    },
  );
  it("marks capture silence even with apparently healthy sockets", () => {
    const args = input();
    args.captures.splice(2, 1);
    args.captures[2]!.from -= 10_000;
    expect(buildClosedBar(args).quality.reasons).toContain("capture_silence");
  });
  it("marks stale, late and mixed-version trades explicitly", () => {
    const args = input();
    args.trades[0]!.event = {
      ...trade(start + 1000, 1, "64000", "0.1", start + 920_000),
      quality: "stale",
      instrument_version: "changed",
    };
    expect(buildClosedBar(args).quality.reasons).toEqual([
      "input_not_fresh",
      "late_input",
      "metadata_changed",
    ]);
  });
  it("rejects conflicting duplicate payloads and over-limit input without truncation", () => {
    const args = input();
    args.trades.push({
      id: "other",
      event: { ...trade(), payload_hash: "different" },
    });
    expect(() => buildClosedBar(args)).toThrow("TRADE_CONFLICT");
    expect(() =>
      buildClosedBar({
        ...input(),
        trades: Array.from(
          { length: BAR_LIMITS.trades + 1 },
          () => input().trades[0]!,
        ),
      }),
    ).toThrow("INPUT_LIMIT");
  });
  it("requires enough consecutive, current, same-version bars for warmup", () => {
    const bar = buildClosedBar(input());
    expect(barWarmup([bar], 1, start + 910_000, 900_000).ready).toBe(true);
    expect(barWarmup([bar], 2, start + 910_000, 900_000).ready).toBe(false);
    expect(barWarmup([bar], 1, start + 1_810_000, 900_000).ready).toBe(false);
    expect(() => barWarmup([], 0, start, 900_000)).toThrow("INVALID_WARMUP");
  });
});
