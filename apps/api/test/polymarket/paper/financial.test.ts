import { describe, expect, it } from "vitest";
import {
  FINANCIAL_VERSION,
  applyFinancialMarks,
  financialOwnerKey,
  replayFinancialLedger,
  type FinancialCapital,
  type FinancialLedgerState,
  type FinancialMark,
} from "../../../src/polymarket/paper/financial.js";
import {
  OWNERSHIP_VERSION,
  type AttributedLedgerEvent,
  type FinancialOwner,
} from "../../../src/polymarket/paper/ownership.js";

const A: FinancialOwner = {
  accountId: "fixture",
  strategyId: "A",
  ownershipVersion: OWNERSHIP_VERSION,
  attributionStatus: "verified",
  evidenceRef: "fixture:FIN01",
};
const B: FinancialOwner = { ...A, strategyId: "B" };
let eventId = 0;
function event(
  key: string,
  eventType: AttributedLedgerEvent["eventType"],
  payload: Record<string, unknown>,
  at: string,
  owner = A,
  tokenId = "T",
): AttributedLedgerEvent {
  return {
    eventId: String(++eventId),
    idempotencyKey: key,
    eventType,
    orderId: null,
    tokenId,
    conditionId: `condition:${tokenId}`,
    payload,
    eventTs: new Date(at),
    receivedAt: new Date(at),
    owner,
  };
}
function fill(
  key: string,
  side: "BUY" | "SELL",
  size: string,
  price: string,
  at = "2026-09-12T10:00:00Z",
  fee = "0",
  owner = A,
  tokenId = "T",
): AttributedLedgerEvent {
  return event(key, "fill", { side, size, price, fee }, at, owner, tokenId);
}
function resolution(
  key: string,
  payout = "1",
  at = "2026-09-12T11:00:00Z",
  owner = A,
  tokenId = "T",
  fee = "0",
): AttributedLedgerEvent {
  return event(
    key,
    "resolution",
    { outcome_price: payout, fee },
    at,
    owner,
    tokenId,
  );
}
function capital(initialCashUsd = "1000", owner = A): FinancialCapital {
  return {
    ...owner,
    initialCashUsd,
    capitalSourceRef: "fixture:declared-allocation",
  };
}
function mark(
  shares: string,
  markValueSignedUsd: string,
  owner = A,
  tokenId = "T",
): FinancialMark {
  return {
    ...owner,
    tokenId,
    shares,
    markValueSignedUsd,
    stale: false,
    sourceTs: new Date("2026-09-12T10:00:00Z"),
    receivedAt: new Date("2026-09-12T10:00:00Z"),
  };
}
function owned(state: FinancialLedgerState, owner = A) {
  const value = state.owners.get(
    financialOwnerKey(owner.accountId, owner.strategyId),
  );
  if (value === undefined) throw new Error("missing fixture owner");
  return value;
}

describe("financial-v2 independent FIN-01 economic oracles", () => {
  it("F1 measures a legacy short, partial buyback and only the remaining settlement", () => {
    const sell = fill("s1", "SELL", "10", "0.40", "2026-09-12T10:01:00Z");
    const buy = fill("s2", "BUY", "4", "0.50", "2026-09-12T10:03:00Z");
    let owner = owned(
      replayFinancialLedger([sell], [capital()], [mark("-10", "-5")]),
    );
    expect(owner).toMatchObject({
      cashUsd: "1004.000000000",
      realizedPnlUsd: "0.000000000",
      unrealizedPnlUsd: "-1.000000000",
      equityUsd: "999.000000000",
    });
    owner = owned(
      replayFinancialLedger([sell, buy], [capital()], [mark("-6", "-3")]),
    );
    expect(owner).toMatchObject({
      cashUsd: "1002.000000000",
      realizedPnlUsd: "-0.400000000",
      unrealizedPnlUsd: "-0.600000000",
      equityUsd: "999.000000000",
    });
    expect(owner.positions.get("T")).toMatchObject({
      shares: "-6.000000000",
      costBasisUsd: "2.400000000",
    });
    owner = owned(
      replayFinancialLedger([sell, buy, resolution("s3")], [capital()]),
    );
    expect(owner).toMatchObject({
      cashUsd: "996.000000000",
      realizedPnlUsd: "-4.000000000",
      unrealizedPnlUsd: "0.000000000",
      equityUsd: "996.000000000",
    });
    expect(owner.positions.get("T")).toMatchObject({
      shares: "0.000000000",
      costBasisUsd: "0.000000000",
    });
  });

  it("F2 values the actual NO token and never creates a YES position", () => {
    const buy = fill("n1", "BUY", "10", "0.60", undefined, "0", A, "NO");
    const open = owned(
      replayFinancialLedger([buy], [capital()], [mark("10", "5", A, "NO")]),
    );
    expect([...open.positions.keys()]).toEqual(["NO"]);
    expect(open).toMatchObject({
      cashUsd: "994.000000000",
      unrealizedPnlUsd: "-1.000000000",
      equityUsd: "999.000000000",
    });
    const settled = owned(
      replayFinancialLedger(
        [buy, resolution("n2", "0", undefined, A, "NO")],
        [capital()],
      ),
    );
    expect(settled).toMatchObject({
      cashUsd: "994.000000000",
      realizedPnlUsd: "-6.000000000",
      equityUsd: "994.000000000",
    });
  });

  it("F3 realizes independent tokens independently, totaling the exact loss of 70", () => {
    const buys = [
      fill("x", "BUY", "100", "0.30", undefined, "0", A, "X"),
      fill("y", "BUY", "100", "0.40", undefined, "0", A, "Y"),
    ];
    const xResolved = resolution("rx", "0", "2026-09-12T15:00:00Z", A, "X");
    const partial = owned(
      replayFinancialLedger(
        [...buys, xResolved],
        [capital()],
        [mark("100", "40", A, "Y")],
      ),
    );
    expect(partial).toMatchObject({
      cashUsd: "930.000000000",
      realizedPnlUsd: "-30.000000000",
      equityUsd: "970.000000000",
    });
    const final = replayFinancialLedger(
      [
        ...buys,
        xResolved,
        resolution("ry", "0", "2026-09-12T15:01:00Z", A, "Y"),
      ],
      [capital()],
    );
    expect(final.realizedPnlUsd).toBe("-70.000000000");
    expect(owned(final).equityUsd).toBe("930.000000000");
  });

  it("F4 keeps owner bases, fees and economic UTC days separate through late retry/restart", () => {
    const a1 = fill("a1", "BUY", "10", "0.40", "2026-09-12T23:58:00Z", "0.10");
    const b1 = fill(
      "b1",
      "BUY",
      "5",
      "0.60",
      "2026-09-12T23:58:30Z",
      "0.05",
      B,
    );
    const a2 = fill(
      "a2",
      "SELL",
      "4",
      "0.70",
      "2026-09-12T23:59:59.900Z",
      "0.04",
    );
    const r1 = resolution("r1", "1", "2026-09-13T00:05:00Z");
    const caps = [capital("500"), capital("500", B)];
    const before = replayFinancialLedger([a1, b1, a2], caps, [
      mark("6", "3"),
      mark("5", "2.5", B),
    ]);
    expect(owned(before)).toMatchObject({
      cashUsd: "498.660000000",
      realizedPnlUsd: "1.060000000",
      feesPaidUsd: "0.140000000",
      equityUsd: "501.660000000",
    });
    expect(owned(before, B)).toMatchObject({
      cashUsd: "496.950000000",
      realizedPnlUsd: "-0.050000000",
      feesPaidUsd: "0.050000000",
      equityUsd: "499.450000000",
    });
    const events = [a1, b1, a2, r1, { ...r1, owner: B }];
    const expected = replayFinancialLedger(events, caps);
    const late = { ...a2, receivedAt: new Date("2026-09-13T00:06:00Z") };
    const restart = replayFinancialLedger(
      [events[4]!, r1, late, b1, a1, late, r1],
      caps,
    );
    expect(restart).toEqual(expected);
    expect(expected).toMatchObject({
      realizedPnlUsd: "6.610000000",
      feesPaidUsd: "0.190000000",
      cashflowUsd: "6.610000000",
      eventCount: 5,
    });
    const a = owned(expected);
    const b = owned(expected, B);
    expect(a).toMatchObject({
      cashUsd: "504.660000000",
      equityUsd: "504.660000000",
      realizedPnlUsd: "4.660000000",
    });
    expect(b).toMatchObject({
      cashUsd: "501.950000000",
      equityUsd: "501.950000000",
      realizedPnlUsd: "1.950000000",
    });
    expect([...a.dailyRealizedPnlUsd]).toEqual([
      ["2026-09-12", "1.060000000"],
      ["2026-09-13", "3.600000000"],
    ]);
    expect([...b.dailyRealizedPnlUsd]).toEqual([
      ["2026-09-12", "-0.050000000"],
      ["2026-09-13", "2.000000000"],
    ]);
    expect([...a.weeklyRealizedPnlUsd]).toEqual([
      ["2026-09-07", "4.660000000"],
    ]);
  });

  it("F6 removes remaining basis with half-away rounding and clears the final nano residue", () => {
    const events = [
      fill("b1", "BUY", "1", "0.30"),
      fill("b2", "BUY", "2", "0.35"),
    ];
    const expected = [
      {
        shares: "3.000000000",
        basis: "1.000000000",
        realized: "0.000000000",
        cash: "9.000000000",
        value: "1.2",
      },
      {
        shares: "2.000000000",
        basis: "0.666666667",
        realized: "0.066666667",
        cash: "9.400000000",
        value: "0.8",
      },
      {
        shares: "1.000000000",
        basis: "0.333333333",
        realized: "0.133333333",
        cash: "9.800000000",
        value: "0.4",
      },
      {
        shares: "0.000000000",
        basis: "0.000000000",
        realized: "0.200000000",
        cash: "10.200000000",
        value: "0",
      },
    ];
    for (const [index, oracle] of expected.entries()) {
      if (index > 0)
        events.push(
          fill(`s${index}`, "SELL", "1", "0.40", `2026-09-12T17:0${index}:00Z`),
        );
      const owner = owned(
        replayFinancialLedger(
          events,
          [capital("10")],
          [mark(oracle.shares, oracle.value)],
        ),
      );
      expect(owner.positions.get("T")).toMatchObject({
        shares: oracle.shares,
        costBasisUsd: oracle.basis,
      });
      expect(owner).toMatchObject({
        cashUsd: oracle.cash,
        realizedPnlUsd: oracle.realized,
        equityUsd: "10.200000000",
      });
    }
  });
});

describe("financial-v2 boundaries and failure contracts", () => {
  it("F5 acceptance, cancel request/effectiveness and expiry never change cash or PnL", () => {
    const events = [
      event("o1", "order_accepted", {}, "2026-09-12T16:00:00Z"),
      fill("f1", "BUY", "400", "0.50", "2026-09-12T16:01:00Z"),
      event("c1", "cancel_requested", {}, "2026-09-12T16:02:00Z"),
      event("c2", "cancel_effective", {}, "2026-09-12T16:02:01Z"),
      event("o3", "order_accepted", {}, "2026-09-12T16:03:00Z"),
      event("x3", "expired", {}, "2026-09-12T16:04:00Z"),
    ];
    const owner = owned(
      replayFinancialLedger(
        [...events, events[1]!, events[3]!],
        [capital()],
        [mark("400", "200")],
      ),
    );
    expect(owner).toMatchObject({
      cashUsd: "800.000000000",
      realizedPnlUsd: "0.000000000",
      feesPaidUsd: "0.000000000",
      equityUsd: "1000.000000000",
    });
    expect(owner.positions.get("T")).toMatchObject({
      shares: "400.000000000",
      costBasisUsd: "200.000000000",
    });
  });

  it("keeps known identity with unknown capital nullable and never seeds an empty owner", () => {
    const owners = replayFinancialLedger(
      [fill("f", "BUY", "10", "0.4")],
      [
        { ...capital(), initialCashUsd: null },
        { ...capital("50", B), initialCashUsd: null },
      ],
      [mark("10", "5")],
    );
    expect(owned(owners)).toMatchObject({
      cashflowUsd: "-4.000000000",
      cashUsd: null,
      initialCashUsd: null,
      equityUsd: null,
      unrealizedPnlUsd: "1.000000000",
      marksFresh: true,
    });
    expect(owned(owners, B)).toMatchObject({
      cashflowUsd: "0.000000000",
      cashUsd: null,
      equityUsd: null,
      unrealizedPnlUsd: "0.000000000",
      marksFresh: true,
    });
    expect(owned(replayFinancialLedger([], [capital("50")])).equityUsd).toBe(
      "50.000000000",
    );
  });

  it("does not charge a resolution fee twice on retry", () => {
    const buy = fill("b", "BUY", "10", "0.4", undefined, "0.10");
    const settle = resolution("r", "1", undefined, A, "T", "0.05");
    const state = replayFinancialLedger([buy, settle, settle], [capital()]);
    expect(owned(state)).toMatchObject({
      cashUsd: "1005.850000000",
      realizedPnlUsd: "5.850000000",
      feesPaidUsd: "0.150000000",
    });
  });

  it("settles opposing owners even when the token-wide net is zero", () => {
    const buy = fill("long", "BUY", "10", "0.4");
    const sell = fill("short", "SELL", "10", "0.6", undefined, "0", B);
    const settle = resolution("r");
    const state = replayFinancialLedger([
      buy,
      sell,
      settle,
      { ...settle, owner: B },
    ]);
    expect(owned(state).realizedPnlUsd).toBe("6.000000000");
    expect(owned(state, B).realizedPnlUsd).toBe("-4.000000000");
    expect(state.realizedPnlUsd).toBe("2.000000000");
  });

  it.each(["BUY", "SELL"] as const)(
    "retains exact cash/basis identity crossing zero from %s at a half nano",
    (side) => {
      const opposite = side === "BUY" ? "SELL" : "BUY";
      const state = replayFinancialLedger(
        [
          fill("1", side, "0.000000001", "0.5"),
          fill("2", opposite, "0.000000003", "0.5", "2026-09-12T10:01:00Z"),
        ],
        [capital("10")],
      );
      expect(owned(state).positions.get("T")).toMatchObject({
        shares: side === "BUY" ? "-0.000000002" : "0.000000002",
        costBasisUsd: "0.000000001",
        realizedPnlUsd: "0.000000000",
      });
      expect(owned(state).cashUsd).toBe(
        side === "BUY" ? "10.000000001" : "9.999999999",
      );
    },
  );

  it("ignores ledger-v1 global marks and diagnostic events for money", () => {
    const buy = fill("b", "BUY", "10", "0.4", undefined, "0.1");
    const diagnostic = event(
      "m",
      "mark",
      { mark_value_usd: "999" },
      "2026-09-12T10:01:00Z",
    );
    const cancel = event(
      "cancel",
      "cancel_requested",
      {},
      "2026-09-12T10:02:00Z",
    );
    const owner = owned(
      replayFinancialLedger([buy, diagnostic, cancel], [capital()]),
    );
    expect(owner).toMatchObject({
      cashUsd: "995.900000000",
      realizedPnlUsd: "-0.100000000",
      equityUsd: null,
      marksFresh: false,
    });
    expect(owner.positions.get("T")).toMatchObject({
      shares: "10.000000000",
      costBasisUsd: "4.000000000",
      markValueSignedUsd: null,
    });
    expect([...owner.dailyRealizedPnlUsd]).toEqual([
      ["2026-09-12", "-0.100000000"],
    ]);
  });

  it("retains a stale last mark without asserting fresh U or equity", () => {
    const state = replayFinancialLedger(
      [fill("b", "BUY", "3", "0.4")],
      [capital()],
      [mark("3", "1.5")],
    );
    const stale = applyFinancialMarks(state, []);
    expect(owned(stale)).toMatchObject({
      cashUsd: "998.800000000",
      unrealizedPnlUsd: null,
      equityUsd: null,
      marksFresh: false,
    });
    expect(owned(stale).positions.get("T")).toMatchObject({
      shares: "3.000000000",
      costBasisUsd: "1.200000000",
      markValueSignedUsd: "1.500000000",
      markStale: true,
    });
    expect(owned(state).equityUsd).toBe("1000.300000000");
  });

  it.each([
    { stale: true },
    { sourceTs: null },
    { receivedAt: null },
    { sourceTs: new Date("2026-09-13T00:00:00Z") },
    { receivedAt: new Date("2026-09-13T00:00:00Z") },
    { shares: "20" },
    { shares: "-20", markValueSignedUsd: "-10" },
    { markValueSignedUsd: null },
  ])(
    "does not infer equity from an incomplete/future/other-quantity mark %j",
    (delta) => {
      const state = replayFinancialLedger(
        [fill("b", "BUY", "10", "0.4")],
        [capital()],
        [{ ...mark("10", "5"), ...delta }],
        new Date("2026-09-12T10:01:00Z"),
      );
      expect(owned(state)).toMatchObject({
        cashUsd: "996.000000000",
        equityUsd: null,
        marksFresh: false,
      });
    },
  );

  it("uses the economic cutoff and Monday UTC weeks, regardless of local offset/arrival", () => {
    const sunday = fill(
      "sun",
      "BUY",
      "1",
      "0.4",
      "2026-09-13T23:59:59.999Z",
      "0.01",
    );
    const monday = fill(
      "mon",
      "SELL",
      "1",
      "0.5",
      "2026-09-13T21:00:00-03:00",
      "0.02",
    );
    const before = owned(
      replayFinancialLedger(
        [monday, sunday],
        [capital()],
        [],
        new Date("2026-09-13T23:59:59.999Z"),
      ),
    );
    expect(before.realizedPnlUsd).toBe("-0.010000000");
    expect([...before.weeklyRealizedPnlUsd]).toEqual([
      ["2026-09-07", "-0.010000000"],
    ]);
    const after = owned(replayFinancialLedger([monday, sunday], [capital()]));
    expect([...after.weeklyRealizedPnlUsd]).toEqual([
      ["2026-09-07", "-0.010000000"],
      ["2026-09-14", "0.080000000"],
    ]);
    expect(after.equityUsd).toBe("1000.070000000");
  });

  it("compares duplicate payloads structurally and refuses conflicting money, owner or version", () => {
    const original = fill("a", "BUY", "10", "0.4");
    const reordered = {
      ...original,
      payload: { fee: "0", price: "0.4", size: "10", side: "BUY" },
    };
    expect(replayFinancialLedger([original, reordered]).eventCount).toBe(1);
    expect(() =>
      replayFinancialLedger([
        original,
        { ...original, payload: { ...original.payload, size: "11" } },
      ]),
    ).toThrow("CONTENT_CONFLICT");
    expect(() =>
      replayFinancialLedger([original, { ...original, owner: B }]),
    ).toThrow("OWNER_CONFLICT");
    expect(() =>
      replayFinancialLedger([
        {
          ...original,
          owner: { ...A, ownershipVersion: 2 as typeof OWNERSHIP_VERSION },
        },
      ]),
    ).toThrow("OWNERSHIP_VERSION");
    expect(() =>
      replayFinancialLedger([
        original,
        { ...original, owner: { ...A, evidenceRef: "other" } },
      ]),
    ).toThrow("ATTRIBUTION_CONFLICT");
  });

  it("refuses a common nonzero settlement fee without proved allocation", () => {
    const settle = resolution("r", "1", undefined, A, "T", "0.1");
    expect(() =>
      replayFinancialLedger([settle, { ...settle, owner: B }]),
    ).toThrow("OWNER_CONFLICT");
  });

  it.each([
    { size: "0" },
    { size: "-1" },
    { size: "0.0000000001" },
    { price: "1.1" },
    { price: "-0.1" },
    { price: 0.4 },
    { fee: "-0.01" },
    { fee: "NaN" },
    { fee: null },
    { side: "NO" },
  ])("fails explicitly on invalid monetary payload %j", (payload) => {
    const source = fill("bad", "BUY", "1", "0.4");
    expect(() =>
      replayFinancialLedger([
        { ...source, payload: { ...source.payload, ...payload } },
      ]),
    ).toThrow("FIN03_");
  });

  it("validates causal order and stable token/condition identity", () => {
    const buy = { ...fill("b", "BUY", "1", "0.4"), orderId: "order" };
    const accepted = {
      ...event("a", "order_accepted", {}, "2026-09-12T10:01:00Z"),
      orderId: "order",
    };
    expect(() => replayFinancialLedger([buy, accepted])).toThrow(
      "FILL_BEFORE_ACCEPTANCE",
    );
    const settled = resolution("r", "1", "2026-09-12T09:00:00Z");
    expect(() => replayFinancialLedger([buy, settled])).toThrow(
      "FILL_AFTER_RESOLUTION",
    );
    expect(() =>
      replayFinancialLedger([
        buy,
        { ...resolution("r"), conditionId: "wrong" },
      ]),
    ).toThrow("CONDITION_CONFLICT");
    expect(() =>
      replayFinancialLedger([
        buy,
        resolution("r"),
        resolution("r2", "1", "2026-09-12T12:00:00Z"),
      ]),
    ).toThrow("DUPLICATE_RESOLUTION");
  });

  it("reports version and keeps owner keys collision-free", () => {
    expect(replayFinancialLedger([])).toMatchObject({
      accountingVersion: FINANCIAL_VERSION,
      ownershipVersion: OWNERSHIP_VERSION,
    });
    expect(financialOwnerKey("a:b", "c")).not.toBe(
      financialOwnerKey("a", "b:c"),
    );
    expect(() => replayFinancialLedger([], [capital(), capital()])).toThrow(
      "DUPLICATE_CAPITAL",
    );
    expect(() =>
      replayFinancialLedger([], [{ ...capital(), capitalSourceRef: "" }]),
    ).toThrow("UNPROVEN_CAPITAL");
    expect(() =>
      replayFinancialLedger(
        [fill("b", "BUY", "1", "0.4")],
        [],
        [mark("1", "-0.5")],
      ),
    ).toThrow("MARK_SIGN");
  });
});
