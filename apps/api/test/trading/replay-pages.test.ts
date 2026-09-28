import { order } from "./reservation-fixture.js";
import { reservationHold, release } from "../../src/trading/reservations.js";
import { describe, it, expect } from "vitest";
import { iso, start } from "./ledger-fixture.js";
import {
  sealReplayPages,
  replayPages,
  PAGE_LIMITS,
  type ReplayPage,
} from "../../src/storage/replay-pages.js";

import { windowFixture } from "./replay-pages-fixture.js";
async function* pages(input: ReplayPage[]) {
  for (const page of input) yield page;
}
describe("bounded complete replay pages", () => {
  it("reconciles 2880 windows, 8641 observations, 6005 events and global drawdown without summing chunks", async () => {
    const t = performance.now(),
      bundle = sealReplayPages(windowFixture());
    const result = await replayPages(bundle.artifact, pages(bundle.pages));
    expect(result.window).toMatchObject({
      complete: true,
      expected_fifteen_minute_windows: 2880,
      observed_equity_slots: 8641,
      drawdown: {
        max_usd_raw: "100000000",
        max_ppm: "99019",
        intrabar_extreme: null,
      },
    });
    expect(result.financials).toMatchObject({
      balance_usd_raw: "6909900000",
      realized_pnl_usd_raw: "10000000",
      fees_usd_raw: "-100000",
      funding_usd_raw: "-100000000",
    });
    expect(result.late_funding_event_ids).toHaveLength(1);
    expect(result.decisions).toHaveLength(2880);
    expect(bundle.artifact.manifest.bytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(
      Math.max(...bundle.artifact.manifest.pages.map((p) => p.bytes)),
    ).toBeLessThanOrEqual(PAGE_LIMITS.bytes);
    console.log(
      JSON.stringify({
        fixture: "30d",
        bytes: bundle.artifact.manifest.bytes,
        pages: bundle.pages.length,
        max_page_bytes: Math.max(
          ...bundle.artifact.manifest.pages.map((p) => p.bytes),
        ),
        elapsed_ms: Math.round(performance.now() - t),
        max_rss_kib: process.resourceUsage().maxRSS,
      }),
    );
  }, 30000);
  it("carries preexisting capital and reserves, excludes the opening event and includes the closing event exactly once", async () => {
    const d = windowFixture(12);
    d.window!.start_at = iso(start + 900000);
    let b = sealReplayPages(d),
      r = await replayPages(b.artifact, pages(b.pages));
    expect(r.window.net_pnl_usd_raw).toBe("-100000000");
    expect(r.window.external_flows_usd_raw).toBe("9000000");
    expect(r.window.prior_obligation_event_ids).toHaveLength(1);
    expect(r.window.late_funding_event_ids).toEqual(
      r.window.prior_obligation_event_ids,
    );
    expect(r.window.ledger_incidence_event_ids).toHaveLength(10);
    expect(r.window.ledger_incidence_event_ids).not.toContain(
      d.ledger.find((e) => e.recorded_at === d.window!.start_at)!.event_id,
    );
    expect(r.window.ledger_incidence_event_ids).toContain(
      d.ledger.at(-1)!.event_id,
    );
    const q = order("held", { valid_until: iso(start + 7200000) }),
      hold = reservationHold(q, BigInt(q.quantity_btc_raw));
    d.reservations = [
      {
        sequence: "1",
        recorded_at: iso(start + 1000),
        request: { action: "reserve", operation_id: "reserve", order: q },
        reservation: hold,
        ledger_transaction_id: null,
      },
      {
        sequence: "2",
        recorded_at: d.window!.end_at,
        request: {
          action: "release",
          operation_id: "release",
          order_id: q.order_id,
          reason: "cancelled",
        },
        reservation: release(hold, "cancelled"),
        ledger_transaction_id: null,
      },
    ];
    d.cut.reservation_sequence = "2";
    d.equity_history!.observation_ids = []; // Missing observation history is explicitly unknown.
    b = sealReplayPages(d);
    r = await replayPages(b.artifact, pages(b.pages));
    expect(r.window.opening.active_reserved_usd_raw).toBe(
      (BigInt(hold.margin_usd_raw) + BigInt(hold.fee_usd_raw)).toString(),
    );
    expect(r.window.closing.active_reserved_usd_raw).toBe("0");
    expect(r.window.net_pnl_usd_raw).toBeNull();
    expect(r.window.drawdown.max_usd_raw).toBeNull();
  });
  it("does not invent a financial prefix before genesis was actually recorded", async () => {
    const d = windowFixture(6);
    d.equity_history!.observation_ids = [];
    d.ledger[0] = { ...d.ledger[0]!, recorded_at: iso(start + 1) };
    const b = sealReplayPages(d),
      r = await replayPages(b.artifact, pages(b.pages));
    expect(r.window.opening.financials).toBeNull();
    expect(r.window.net_pnl_usd_raw).toBeNull();
  });
  it("rejects missing, repeated, reordered, mixed and altered pages; allows restart from same immutable export", async () => {
    const b = sealReplayPages(windowFixture(6));
    const good = await replayPages(b.artifact, pages(b.pages));
    expect(
      await replayPages(
        JSON.parse(JSON.stringify(b.artifact)),
        pages(structuredClone(b.pages)),
      ),
    ).toEqual(good);
    for (const bad of [
      b.pages.slice(1),
      [...b.pages, b.pages[0]!],
      [b.pages[1]!, b.pages[0]!, ...b.pages.slice(2)],
      b.pages.map((p, i) => (i ? p : { ...p, snapshot_id: "other" })),
    ])
      await expect(replayPages(b.artifact, pages(bad))).rejects.toThrow(
        "BTC_REPLAY_PAGE",
      );
    const tamper = structuredClone(b.pages);
    tamper[0]!.rows.pop();
    await expect(replayPages(b.artifact, pages(tamper))).rejects.toThrow(
      "PAGE_SEQUENCE_OR_HASH",
    );
  });
  it("two endpoints do not establish coverage, missing marks stay unknown, bytes and window are bounded", async () => {
    const d = windowFixture(6);
    d.equity_history!.observation_ids =
      d.equity_history!.observation_ids.filter((_, i) => i === 0 || i === 6);
    const b = sealReplayPages(d);
    const r = await replayPages(b.artifact, pages(b.pages));
    expect(r.window.complete).toBe(false);
    expect(r.window.drawdown.max_usd_raw).toBeNull();
    expect(r.window.drawdown.observed_max_usd_raw).toBe("90100000");
    d.window!.end_at = iso(start + 31 * 86400000);
    const bad = sealReplayPages(d);
    await expect(replayPages(bad.artifact, pages(bad.pages))).rejects.toThrow(
      "WINDOW",
    );
    d.evidence[0]!.payload = "x".repeat(PAGE_LIMITS.bytes);
    expect(() => sealReplayPages(d)).toThrow("PAGE_ROW_BYTES");
  });
});
