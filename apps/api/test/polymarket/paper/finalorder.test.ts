import { describe, expect, it } from "vitest";
import {
  evaluateFinalEntry,
  type FinalOrderInput,
} from "../../../src/polymarket/paper/finalorder.js";
import { validateOrder } from "../../../src/polymarket/paper/validator.js";

function fixture(): FinalOrderInput {
  return {
    order: {
      tokenId: "yes",
      side: "BUY",
      orderType: "FAK",
      limitPrice: "0.60",
      worstPrice: "0.60",
      size: "100.00",
      amountUsd: "60.0000",
      postOnly: false,
      expirationS: null,
    },
    conditionId: "market",
    accountId: "paper",
    strategyId: "main",
    economics: {
      tokenId: "yes",
      conditionId: "market",
      accountId: "paper",
      strategyId: "main",
      marketSide: "YES",
      sizeMax: "100",
      q: "0.65",
      qLo: "0.65",
      qHi: "0.65",
      expectedLockupS: 0,
      capitalAnnualRate: "0",
      bufferDailyHurdle: "0",
      resolutionBuffer: "0",
      safetyMarginMin: "0.01",
      safetyMarginEdgeFraction: "0",
      edgeLiqMin: "0.02",
      modelRef: "FIN-01/EXEC-01",
      makerFee: "0",
      makerAdverseSelection: "0",
      makerAssumptionRef: "fixture:conditional-fill",
    },
    book: {
      tokenId: "yes",
      bids: [{ price: "0.49", size: "100" }],
      asks: [
        { price: "0.50", size: "50" },
        { price: "0.60", size: "50" },
      ],
      sourceTs: "2026-09-16T10:00:00Z",
      receivedAt: "2026-09-16T10:00:00Z",
    },
    fee: {
      rate: "0",
      paramVersionId: 1,
      sourceTs: null,
      receivedAt: "2026-09-16T09:00:00Z",
      validFrom: "2026-09-16T09:00:00Z",
    },
    evaluatedAt: "2026-09-16T10:00:01Z",
  };
}
const breakdown = (input: FinalOrderInput) =>
  evaluateFinalEntry(input).evidence["breakdown"];

describe("EXEC-02 final-order economics (independent decimal expectations)", () => {
  it("walks 100 shares: .65 payoff - .55 VWAP = .10, diagnostic impact .05", () => {
    const f = fixture();
    expect(evaluateFinalEntry(f).ok).toBe(true);
    expect(breakdown(f)).toMatchObject({
      edgeNetScaled: "0.100000000",
      slippageScaled: "0.050000000",
      costsTotalScaled: "0.000000000",
      priceBasis: "taker-vwap",
    });
    expect(evaluateFinalEntry(f).evidence["fee_age_ms"]).toBe(3601000);
  });
  it("one share passes but final 100 cannot fit the shallow book, including passive", () => {
    const f = fixture();
    const book = { ...f.book!, asks: [{ price: "0.50", size: "1" }] };
    expect(
      evaluateFinalEntry({ ...f, book, order: { ...f.order, size: "1" } }).ok,
    ).toBe(true);
    expect(evaluateFinalEntry({ ...f, book }).reason).toBe(
      "BOOK_WALK_INCOMPLETE",
    );
    expect(
      evaluateFinalEntry({
        ...f,
        book,
        order: {
          ...f.order,
          orderType: "GTC",
          postOnly: true,
          limitPrice: "0.49",
          worstPrice: null,
        },
      }).reason,
    ).toBe("BOOK_WALK_INCOMPLETE");
  });
  it("maker to taker charges .04*.55*.45=.0099 once, and can fail the same margin", () => {
    const f = fixture();
    const fee = { ...f.fee, rate: "0.04" };
    const maker = {
      ...f,
      fee,
      order: {
        ...f.order,
        orderType: "GTC" as const,
        limitPrice: "0.49",
        worstPrice: null,
        postOnly: true,
      },
    };
    expect(breakdown(maker)).toMatchObject({
      edgeNetScaled: "0.160000000",
      feeScaled: "0.000000000",
      priceBasis: "maker-limit",
    });
    expect(breakdown({ ...f, fee })).toMatchObject({
      edgeNetScaled: "0.090100000",
      feeScaled: "0.009900000",
    });
    const economics = { ...f.economics, safetyMarginMin: "0.095" };
    expect(evaluateFinalEntry({ ...maker, economics }).ok).toBe(true);
    expect(evaluateFinalEntry({ ...f, fee, economics }).reason).toBe(
      "FINAL_ENTRY_EV_BELOW_MARGIN",
    );
  });
  it("NO uses its own token/book and 1-qHi=.65; opposite book is rejected", () => {
    const f = fixture();
    const no = {
      ...f,
      order: { ...f.order, tokenId: "no" },
      book: { ...f.book!, tokenId: "no" },
      economics: {
        ...f.economics,
        tokenId: "no",
        marketSide: "NO" as const,
        q: "0.3",
        qLo: "0.25",
        qHi: "0.35",
      },
    };
    expect(breakdown(no)).toMatchObject({
      probLowerScaled: "0.650000000",
      edgeNetScaled: "0.100000000",
    });
    expect(evaluateFinalEntry({ ...no, book: f.book }).ok).toBe(false);
  });
  it.each([null, "-0.01", "invalid"])(
    "rejects unknown/invalid taker fee %s",
    (rate) => {
      const f = fixture();
      expect(evaluateFinalEntry({ ...f, fee: { ...f.fee, rate } }).ok).toBe(
        false,
      );
    },
  );
  it("requires recorded fee provenance even for zero", () => {
    const f = fixture();
    expect(
      evaluateFinalEntry({ ...f, fee: { ...f.fee, paramVersionId: null } })
        .reason,
    ).toBe("TAKER_FEE_UNVERIFIED");
  });
  it("normalizes before walking and refuses depth beyond the actual limit", () => {
    const f = fixture();
    const normalized = validateOrder(
      {
        tokenId: "yes",
        side: "BUY",
        orderType: "FAK",
        size: "1.9999",
        limitPrice: "0.509",
        worstPrice: "0.509",
      },
      { tickSize: "0.01", minOrderSize: "1", negRisk: false },
      0,
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error();
    expect(normalized.value.size).toBe("1.99");
    expect(
      evaluateFinalEntry({
        ...f,
        order: normalized.value,
        book: { ...f.book!, asks: [{ price: "0.5", size: "1.99" }] },
      }).ok,
    ).toBe(true);
    expect(
      evaluateFinalEntry({ ...f, order: { ...f.order, worstPrice: "0.50" } })
        .reason,
    ).toBe("FINAL_ENTRY_PRICE_BOUND");
  });
  it("changed economic inputs produce distinct evaluation identities and actual loss", () => {
    const f = fixture();
    const before = evaluateFinalEntry(f);
    const after = evaluateFinalEntry({
      ...f,
      economics: { ...f.economics, resolutionBuffer: "0.2" },
    });
    expect(after.reason).toBe("FINAL_ENTRY_EV_BELOW_MARGIN");
    expect(after.evidence["breakdown"]).toMatchObject({
      edgeNetScaled: "-0.100000000",
    });
    expect(after.evidence["evaluation_id"]).not.toBe(
      before.evidence["evaluation_id"],
    );
    expect(evaluateFinalEntry({ ...f, strategyId: "other" }).reason).toBe(
      "FINAL_ENTRY_IDENTITY_MISMATCH",
    );
  });
});
