import { describe, it, expect } from "vitest";
import { metadata } from "./bars-fixture.js";
import {
  quoteJevMaker,
  validateExecutionCommand,
} from "../../src/storage/jev-execution-contract.js";
import {
  consumePassiveTrade,
  passiveQueue,
} from "../../src/trading/passive.js";
import { initialJevManifest } from "../../src/storage/jev-manifest.js";
import {
  initialJevProtection,
  jevMandatoryExit,
} from "../../src/storage/jev-protection.js";
import { sizingInput } from "./jev-risk-fixture.js";
const m = initialJevManifest(1);
describe("JE06 versioned execution arithmetic", () => {
  it("quotes the next valid price and the own side at one-step spread", () => {
    expect(quoteJevMaker("buy", "64900000000", "65100000000", metadata)).toBe(
      "64901000000",
    );
    expect(quoteJevMaker("sell", "64900000000", "65100000000", metadata)).toBe(
      "65099000000",
    );
    expect(quoteJevMaker("buy", "65000000000", "65001000000", metadata)).toBe(
      "65000000000",
    );
    expect(quoteJevMaker("sell", "65000000000", "65001000000", metadata)).toBe(
      "65001000000",
    );
    expect(() =>
      quoteJevMaker("buy", "65000000000", "64900000000", metadata),
    ).toThrow(/QUOTE/);
  });
  it("book touches never fill; queue burn and cumulative fees conserve integer units", () => {
    const level = { price: { raw: "65000000000" }, quantity: { raw: "3000" } };
    let q = passiveQueue({
      side: "buy",
      limit: level.price.raw,
      bids: [level],
      asks: [{ ...level, price: { raw: "65100000000" } }],
    });
    let filled = 0n,
      fees = 0n;
    for (const available of ["2000", "2000", "1000"]) {
      const r = consumePassiveTrade({
        queue: q,
        side: "buy",
        limit: level.price.raw,
        remaining: (5000n - filled).toString(),
        step: "1000",
        feeRate: "150000",
        trade: { side: "sell", price: level.price.raw, available },
      });
      q = r.queue;
      filled += BigInt(r.quantity);
      fees += BigInt(r.fee);
    }
    expect(filled).toBe(2000n);
    expect(fees).toBe(195n); // 0.00002 BTC × $65,000 × 0.00015 = $0.000195
    expect(q.ahead_btc_raw).toBe("0");
  });
  it.each(["long", "short"] as const)(
    "protects %s by mark from first partial with a fixed six-hour clock",
    (direction) => {
      const first = "2026-10-07T00:00:01.000Z";
      const p = initialJevProtection(
        m,
        {
          scope: sizingInput.scope,
          position_id: "entry",
          direction,
          first_fill_at: first,
          first_fill_price_raw: "65000000000",
          quantity_btc_raw: "1000",
          atr14_raw: "200000000",
          atr_captured_at: "2026-10-07T00:00:00.000Z",
          decision_at: "2026-10-07T00:00:00.000Z",
        },
        metadata,
      );
      const out = jevMandatoryExit(m, p, {
        now_at: first,
        mark_price_raw: p.stop_price_raw,
        mark_at: first,
        protection_confirmed: true,
        risk_blocked: false,
      });
      expect(out.reasons).toEqual(["FIXED_STOP"]);
      expect(p.maximum_exit_at).toBe("2026-10-07T06:00:01.000Z");
      expect(
        jevMandatoryExit(m, p, {
          now_at: p.maximum_exit_at,
          mark_price_raw: null,
          mark_at: null,
          protection_confirmed: false,
          risk_blocked: true,
        }).reasons,
      ).toEqual([
        "MAXIMUM_HOLDING_TIME",
        "RISK_BLOCKED",
        "PROTECTION_UNCONFIRMED",
        "PROTECTION_MARK_UNKNOWN",
      ]);
    },
  );
  it("rejects caller overrides of reduce-only, quantity or latency", () => {
    expect(() =>
      validateExecutionCommand({
        action: "advance",
        operation_id: "a",
        quantity_btc_raw: "1",
      } as never),
    ).toThrow(/COMMAND/);
  });
});
