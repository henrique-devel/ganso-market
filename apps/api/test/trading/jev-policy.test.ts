import { describe, expect, it } from "vitest";
import {
  advanceJevCadence,
  initialJevCadence,
  initialJevProtection,
  jevDeadlineStatus,
  jevMandatoryExit,
  recordJevDecision,
  updateJevPartialProtection,
} from "../../src/storage/jev-policy.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import { jevScope } from "../../src/storage/jev-ledger.js";
import type { JevAccountContext } from "../../src/storage/jev-context.js";
import { metadata } from "./bars-fixture.js";
import { jevIdentity, iso, start } from "./jev-v2-fixture.js";
const manifest = initialJevManifest(1),
  identity = jevIdentity(),
  scope = jevScope(identity.bindings[0]!.binding, identity.instrument);
const account: JevAccountContext = {
  scope,
  observed_at: iso(start),
  cash_usd_raw: "250000000",
  equity_usd_raw: "250000000",
  position: {
    position_id: "position",
    direction: "long",
    quantity_btc_raw: "100000",
    entry_price_raw: "64000000000",
    stop_price_raw: "62000000000",
    first_fill_at: iso(start),
  },
  entries_paused: false,
  risk_blocked: false,
  recovery_ready: true,
};
const tick = (
  now: number,
  mark = "64000000000",
  a: JevAccountContext | null = account,
  atr = "1000000000",
  fresh = true,
) => ({
  now_at: iso(now),
  account: a,
  mark_price_raw: mark,
  atr14_raw: atr,
  context_fresh: fresh,
});
const seeded = () =>
  recordJevDecision(
    initialJevCadence(manifest, scope, iso(start)),
    iso(start),
    "64000000000",
  );
const protection = (direction: "long" | "short" = "long") =>
  initialJevProtection(
    manifest,
    {
      scope,
      position_id: "position",
      direction,
      first_fill_at: iso(start + 1000),
      first_fill_price_raw: "64000000000",
      quantity_btc_raw: "100000",
      atr14_raw: "1000000000",
      atr_captured_at: iso(start),
      decision_at: iso(start),
    },
    metadata,
  );
describe("frozen JEV cadence/deadlines/protection", () => {
  it("stays at 60s while flat even on a large price movement", () => {
    const out = advanceJevCadence(
      manifest,
      seeded(),
      tick(start + 59999, "70000000000", { ...account, position: null }),
    );
    expect(out).toMatchObject({ interval_ms: 60000, triggers: [], due: false });
    expect(
      advanceJevCadence(
        manifest,
        out.state,
        tick(start + 60000, "70000000000", { ...account, position: null }),
      ).due,
    ).toBe(true);
  });
  it.each(["64500000000", "63500000000"])(
    "enters fast on favorable/adverse half ATR at %s",
    (mark) => {
      const below = BigInt(mark) > 64000000000n ? "64499999999" : "63500000001";
      expect(
        advanceJevCadence(manifest, seeded(), tick(start + 2000, below))
          .interval_ms,
      ).toBe(60000);
      expect(
        advanceJevCadence(manifest, seeded(), tick(start + 2000, mark)),
      ).toMatchObject({
        interval_ms: 2000,
        triggers: ["price_atr"],
        due: true,
      });
    },
  );
  it("enters fast near the stop, honors minimum/maximum time and cooldown", () => {
    const first = advanceJevCadence(
      manifest,
      seeded(),
      tick(start + 2000, "62500000000"),
    );
    expect(first.triggers).toContain("stop_proximity");
    const early = advanceJevCadence(manifest, first.state, tick(start + 11999));
    expect(early.interval_ms).toBe(2000);
    const end = advanceJevCadence(manifest, early.state, tick(start + 12000));
    expect(end.interval_ms).toBe(60000);
    expect(
      advanceJevCadence(manifest, end.state, tick(start + 71999, "64500000000"))
        .interval_ms,
    ).toBe(60000);
    const again = advanceJevCadence(
      manifest,
      end.state,
      tick(start + 72000, "64500000000"),
    );
    expect(again.interval_ms).toBe(2000);
    expect(
      advanceJevCadence(
        manifest,
        again.state,
        tick(start + 102000, "64500000000"),
      ).interval_ms,
    ).toBe(60000);
  });
  it("stale/unknown account, zero ATR or risk blocks never admit fast decisions", () => {
    expect(
      advanceJevCadence(
        manifest,
        seeded(),
        tick(start + 2000, "64500000000", null),
      ).due,
    ).toBe(false);
    expect(
      advanceJevCadence(
        manifest,
        seeded(),
        tick(start + 2000, "64500000000", account, "1000000000", false),
      ).due,
    ).toBe(false);
    expect(
      advanceJevCadence(
        manifest,
        seeded(),
        tick(start + 2000, "64500000000", account, "0"),
      ).interval_ms,
    ).toBe(60000);
    expect(
      advanceJevCadence(
        manifest,
        seeded(),
        tick(start + 2000, "64500000000", { ...account, risk_blocked: true }),
      ).due,
    ).toBe(false);
    expect(() =>
      advanceJevCadence(manifest, seeded(), tick(start - 1)),
    ).toThrow(/CLOCK/);
    expect(() =>
      advanceJevCadence(initialJevManifest(3), seeded(), tick(start + 2000)),
    ).toThrow(/VERSION/);
  });
  it("cannot activate fast from flow or liquidity changes at unchanged prices", () => {
    expect(
      advanceJevCadence(manifest, seeded(), tick(start + 2000)),
    ).toMatchObject({ interval_ms: 60000, triggers: [] });
  });
  it("rejects stale decisions and late responses at precise boundaries", () => {
    const t = {
      context_cut_at: iso(start),
      asked_at: iso(start),
      response_at: iso(start + 1500),
      action_at: iso(start + 2000),
    };
    expect(jevDeadlineStatus(manifest, t).usable).toBe(true);
    expect(
      jevDeadlineStatus(manifest, { ...t, response_at: iso(start + 1501) })
        .reason,
    ).toBe("RESPONSE_DEADLINE");
    expect(
      jevDeadlineStatus(manifest, { ...t, action_at: iso(start + 2001) })
        .reason,
    ).toBe("DECISION_STALE");
    expect(() =>
      jevDeadlineStatus(manifest, { ...t, action_at: iso(start - 1) }),
    ).toThrow(/CLOCK/);
  });
  it.each(["long", "short"] as const)(
    "anchors %s stop/time on the first partial and never trails",
    (direction) => {
      const p = protection(direction);
      expect(p.stop_price_raw).toBe(
        direction === "long" ? "62000000000" : "66000000000",
      );
      const updated = updateJevPartialProtection(
        p,
        {
          scope,
          position_id: "position",
          occurred_at: iso(start + 2000),
          quantity_btc_raw: "200000",
        },
        metadata,
      );
      expect(updated).toEqual({ ...p, quantity_btc_raw: "300000" });
      expect(p.maximum_exit_at).toBe(iso(start + 1000 + 21600000));
      expect(() =>
        updateJevPartialProtection(
          p,
          {
            scope: { ...scope, profile_version: "other" },
            position_id: "position",
            occurred_at: iso(start + 2000),
            quantity_btc_raw: "200000",
          },
          metadata,
        ),
      ).toThrow(/OWNER/);
    },
  );
  it("rounds a stop toward entry on the full venue price grid", () => {
    const args = {
      scope,
      position_id: "p",
      direction: "long" as const,
      first_fill_at: iso(start + 1000),
      first_fill_price_raw: "64000000000",
      quantity_btc_raw: "100000",
      atr14_raw: "1000000001",
      atr_captured_at: iso(start),
      decision_at: iso(start),
    };
    const p = initialJevProtection(manifest, args, metadata);
    expect(BigInt(p.stop_price_raw)).toBeGreaterThanOrEqual(61999999998n);
    expect(BigInt(p.stop_price_raw)).toBeLessThan(64000000000n);
  });
  it("requests stop/risk/deadline/protection exits independently of any JEV response", () => {
    const p = protection(),
      input = {
        now_at: iso(start + 2000),
        mark_price_raw: "62000000000",
        mark_at: iso(start + 2000),
        protection_confirmed: true,
        risk_blocked: false,
      };
    expect(jevMandatoryExit(manifest, p, input)).toMatchObject({
      request_close: true,
      reasons: ["FIXED_STOP"],
      reduce_only: true,
      time_in_force: "IOC",
    });
    expect(
      jevMandatoryExit(manifest, p, {
        ...input,
        now_at: p.maximum_exit_at,
        mark_price_raw: null,
        mark_at: null,
        risk_blocked: true,
        protection_confirmed: false,
      }).reasons,
    ).toEqual([
      "MAXIMUM_HOLDING_TIME",
      "RISK_BLOCKED",
      "PROTECTION_UNCONFIRMED",
      "PROTECTION_MARK_UNKNOWN",
    ]);
  });
});
