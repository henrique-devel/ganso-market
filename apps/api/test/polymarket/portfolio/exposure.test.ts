import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
import { money } from "../../../src/polymarket/portfolio/ev.js";
import {
  capHeadroomFor,
  computeExposures,
  unwindAlarm,
  type OpenPosition,
  type PayoffProof,
} from "../../../src/polymarket/portfolio/exposure.js";
import {
  DEFAULT_RESOLUTION_LEXICON,
  ruleClauseFamily,
} from "../../../src/polymarket/resolution/lexicon.js";

function s(value: string): bigint {
  const parsed = parseScaled(value);
  if (parsed === null) {
    throw new Error(`unparseable fixture value: ${value}`);
  }
  return parsed;
}

const CAPS = DEFAULT_PORTFOLIO_CONFIG.caps;
const BANKROLL = s("1000");

function position(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    accountId: "paper",
    strategyId: "main",
    feesPaidScaled: 0n,
    realizedPnlScaled: 0n,
    remainingFeesScaled: 0n,
    tokenId: "t1",
    conditionId: "0xa",
    sharesScaled: s("100"),
    costScaled: s("40"),
    category: "crypto",
    eventId: null,
    clauseFamily: "OBJETIVA_UNICA:binance",
    factor: "btc_price",
    catalystWindow: "2026-08-28",
    unresolved: true,
    unwindCostScaled: null,
    negRisk: false,
    ...overrides,
  };
}

function find(
  rows: ReturnType<typeof computeExposures>,
  dimension: string,
  key: string,
) {
  return rows.find((row) => row.dimension === dimension && row.key === key);
}

describe("exposure aggregation", () => {
  it("consumes every cap at TOTAL LOSS, never at mark-to-market", () => {
    const rows = computeExposures({
      positions: [position()],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    // $40 of cost against a 5% market cap ($50) is 80% utilization.
    const market = find(rows, "market", "0xa");
    expect(money(market!.worstCaseScaled)).toBe("40.000000");
    expect(money(market!.capScaled)).toBe("50.000000");
    expect(money(market!.utilizationScaled)).toBe("0.800000");
  });

  it("aggregates across every dimension the RFC names", () => {
    const rows = computeExposures({
      positions: [
        position(),
        position({
          tokenId: "t2",
          conditionId: "0xb",
          costScaled: s("30"),
          factor: "btc_price",
        }),
      ],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    for (const dimension of [
      "market",
      "event",
      "category",
      "resolution_source",
      "factor",
      "catalyst_window",
      "locked_capital",
      "total",
    ]) {
      expect(
        rows.some((row) => row.dimension === dimension),
        dimension,
      ).toBe(true);
    }
    // Both markets share the factor: one bet of $70, not two of $40 and $30.
    expect(money(find(rows, "factor", "btc_price")!.worstCaseScaled)).toBe(
      "70.000000",
    );
    expect(find(rows, "factor", "btc_price")!.positionCount).toBe(2);
  });

  it("counts only unresolved positions as locked capital", () => {
    const rows = computeExposures({
      positions: [position(), position({ tokenId: "t2", unresolved: false })],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    expect(money(find(rows, "locked_capital", "all")!.worstCaseScaled)).toBe(
      "40.000000",
    );
    expect(money(find(rows, "total", "all")!.worstCaseScaled)).toBe(
      "80.000000",
    );
  });

  it("sums an incomplete negRisk event, including an uncovered winning outcome", () => {
    // An unheld outcome may win: all three held tokens then pay zero.
    const rows = computeExposures({
      positions: [
        position({
          conditionId: "0xa",
          eventId: "evt",
          negRisk: true,
          costScaled: s("40"),
        }),
        position({
          tokenId: "t2",
          conditionId: "0xb",
          eventId: "evt",
          negRisk: true,
          costScaled: s("25"),
        }),
        position({
          tokenId: "t3",
          conditionId: "0xc",
          eventId: "evt",
          negRisk: true,
          costScaled: s("15"),
        }),
      ],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    const group = find(rows, "event", "evt");
    expect(money(group!.worstCaseScaled)).toBe("80.000000");
    expect(group!.positionCount).toBe(3);
  });

  it("still SUMS a non-negRisk event, where every leg can lose", () => {
    const rows = computeExposures({
      positions: [
        position({ conditionId: "0xa", eventId: "evt", costScaled: s("40") }),
        position({
          tokenId: "t2",
          conditionId: "0xb",
          eventId: "evt",
          costScaled: s("25"),
        }),
      ],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    expect(money(find(rows, "event", "evt")!.worstCaseScaled)).toBe(
      "65.000000",
    );
  });

  it("sums the unwind cost only where it is known", () => {
    const rows = computeExposures({
      positions: [
        position({ unwindCostScaled: s("2.5") }),
        position({ tokenId: "t2", unwindCostScaled: null }),
      ],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    expect(money(find(rows, "total", "all")!.unwindCostScaled!)).toBe(
      "2.500000",
    );
  });
});

describe("cap headroom for a candidate", () => {
  const candidate = {
    conditionId: "0xnew",
    eventId: "evt",
    category: "crypto",
    clauseFamily: "OBJETIVA_UNICA:binance",
    factor: "btc_price",
    catalystWindow: "2026-08-28",
  };

  it("returns every cap, so the sizing min() cannot skip one", () => {
    const headroom = capHeadroomFor([], candidate, BANKROLL, CAPS);
    for (const key of [
      "entrada",
      "mercado",
      "grupoCorrelacionado",
      "categoria",
      "fonteResolucao",
      "catalisadorJanela",
      "capitalBloqueado",
    ]) {
      expect(headroom[key], key).toBeDefined();
    }
  });

  it("gives full headroom on an empty book", () => {
    const headroom = capHeadroomFor([], candidate, BANKROLL, CAPS);
    expect(money(headroom.mercado!)).toBe("50.000000");
    expect(money(headroom.categoria!)).toBe("350.000000");
    expect(money(headroom.entrada!)).toBe("20.000000");
  });

  it("subtracts what the book already used", () => {
    const rows = computeExposures({
      positions: [position({ conditionId: "0xnew", costScaled: s("30") })],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    const headroom = capHeadroomFor(rows, candidate, BANKROLL, CAPS);
    expect(money(headroom.mercado!)).toBe("20.000000");
  });

  it("takes the TIGHTER of the negRisk event and the economic factor", () => {
    // They are two groupings of the same idea. A candidate inside one but
    // outside the other is outside.
    const rows = computeExposures({
      positions: [
        // The factor is heavily used through a DIFFERENT event.
        position({
          conditionId: "0xother",
          eventId: "other-evt",
          factor: "btc_price",
          costScaled: s("180"),
        }),
      ],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    const headroom = capHeadroomFor(rows, candidate, BANKROLL, CAPS);
    // Event "evt" is untouched (200 free) but the factor has only 20 left.
    expect(money(headroom.grupoCorrelacionado!)).toBe("20.000000");
  });

  it("never returns negative headroom once a cap is blown", () => {
    const rows = computeExposures({
      positions: [position({ conditionId: "0xnew", costScaled: s("500") })],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    const headroom = capHeadroomFor(rows, candidate, BANKROLL, CAPS);
    expect(headroom.mercado).toBe(0n);
  });
});

describe("the fonteResolucao cap buckets by clause family (RFC-018 D2)", () => {
  // The owner kept the number at 0.25 and changed the KEY: `resolved_by` is
  // the UMA adapter for 460 of 570 live rule versions, so the cap had stopped
  // being a diversification rule and become a ceiling on the whole book.
  const lexicon = DEFAULT_RESOLUTION_LEXICON;
  const familyOf = (description: string): string =>
    ruleClauseFamily({ description, resolutionSource: null }, lexicon).key;

  it("stops two DIFFERENT clauses from sharing a bucket", () => {
    const binance = familyOf("Resolves to the Binance 1 minute candle close.");
    const fed = familyOf(
      "Resolves per the federal reserve target announcement.",
    );
    expect(binance).not.toBe(fed);
    const rows = computeExposures({
      positions: [
        position({
          conditionId: "0x1",
          clauseFamily: binance,
          costScaled: s("40"),
        }),
        position({
          conditionId: "0x2",
          clauseFamily: fed,
          costScaled: s("40"),
        }),
      ],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    expect(find(rows, "resolution_source", binance)?.positionCount).toBe(1);
    expect(find(rows, "resolution_source", fed)?.positionCount).toBe(1);
  });

  it("keeps two markets on the SAME feed in one bucket — they are one bet", () => {
    const a = familyOf("Resolves to the Binance 1 minute candle for BTCUSDT.");
    const b = familyOf("Settled against the Binance close for ETHUSDT.");
    expect(a).toBe(b);
    const rows = computeExposures({
      positions: [
        position({ conditionId: "0x1", clauseFamily: a, costScaled: s("40") }),
        position({ conditionId: "0x2", clauseFamily: b, costScaled: s("60") }),
      ],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    const bucket = find(rows, "resolution_source", a);
    expect(bucket?.positionCount).toBe(2);
    expect(money(bucket?.worstCaseScaled ?? 0n)).toBe("100.000000");
  });

  it("puts an unclassifiable clause in a NAMED bucket that consumes the cap", () => {
    // Measured on the live universe 2026-09-02: 5 of 92 markets land here, and
    // they are real distinct sources the vocabulary does not name yet (ECB,
    // EIA, Bank of Japan, IMF Portwatch). Sharing one bucket over-concentrates
    // them, which is the safe direction — but the bucket must be VISIBLE, or
    // it is the oversized bucket back under a new name.
    const family = familyOf(
      "Resolves per official information from the European Central Bank.",
    );
    expect(family).toBe("CLAUSULA_NAO_CLASSIFICADA");
    const rows = computeExposures({
      positions: [position({ clauseFamily: family, costScaled: s("60") })],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    const bucket = find(rows, "resolution_source", family);
    expect(money(bucket?.worstCaseScaled ?? 0n)).toBe("60.000000");
    expect(money(bucket?.capScaled ?? 0n)).toBe("250.000000");
    const headroom = capHeadroomFor(
      rows,
      { ...candidateFor(family) },
      BANKROLL,
      CAPS,
    );
    expect(money(headroom.fonteResolucao!)).toBe("190.000000");
  });

  it("keeps the cap NUMBER at 0.25 — only the key moved", () => {
    expect(CAPS.fonteResolucao).toBe(0.25);
  });
});

function candidateFor(clauseFamily: string): {
  conditionId: string;
  eventId: string | null;
  category: string | null;
  clauseFamily: string;
  factor: string;
  catalystWindow: string;
} {
  return {
    conditionId: "0xcandidate",
    eventId: "evt",
    category: "crypto",
    clauseFamily,
    factor: "btc_price",
    catalystWindow: "2026-08-28",
  };
}

describe("unwind alarm", () => {
  const rows = computeExposures({
    positions: [position({ unwindCostScaled: s("6") })],
    bankrollScaled: BANKROLL,
    caps: CAPS,
  });

  it("fires when getting out costs more than the threshold share of open PnL", () => {
    const alarm = unwindAlarm(rows, s("10"), s("0.5"));
    expect(alarm.triggered).toBe(true);
    expect(money(alarm.ratioScaled!)).toBe("0.600000");
  });

  it("stays quiet below the threshold", () => {
    expect(unwindAlarm(rows, s("20"), s("0.5")).triggered).toBe(false);
  });

  it("does not fire on a book that is not up", () => {
    // Dividing by a non-positive PnL would produce a meaningless ratio.
    expect(unwindAlarm(rows, 0n, s("0.5")).triggered).toBe(false);
    expect(unwindAlarm(rows, -s("5"), s("0.5")).ratioScaled).toBeNull();
  });

  it("stays quiet when no unwind cost is known, rather than assuming zero", () => {
    const noBook = computeExposures({
      positions: [position({ unwindCostScaled: null })],
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
    expect(unwindAlarm(noBook, s("10"), s("0.5")).ratioScaled).toBeNull();
  });
});

describe("FIN-04 independent payoff oracles", () => {
  const run = (positions: OpenPosition[], payoffProofs: PayoffProof[] = []) =>
    computeExposures({
      positions,
      payoffProofs,
      bankrollScaled: BANKROLL,
      caps: CAPS,
    });
  const eventProof = (scenarios: PayoffProof["scenarios"]): PayoffProof => ({
    version: "payoff-scenarios-v1",
    evidenceRef: "fixture:exhaustive-contract-v1",
    complete: true,
    scope: { kind: "event", id: "exclusive" },
    tokens: [
      { tokenId: "x", conditionId: "cx" },
      { tokenId: "y", conditionId: "cy" },
    ],
    scenarios,
  });
  const legs = () => [
    position({
      tokenId: "x",
      conditionId: "cx",
      eventId: "exclusive",
      sharesScaled: s("10"),
      costScaled: s("6"),
      negRisk: true,
    }),
    position({
      tokenId: "y",
      conditionId: "cy",
      eventId: "exclusive",
      sharesScaled: s("10"),
      costScaled: s("6"),
      negRisk: true,
    }),
  ];

  it.each([false, true])(
    "F3 consumes 70 in every shared dimension even with one negRisk=%s",
    (negRisk) => {
      // Enumerated (X,Y) = (0,0),(1,0),(0,1),(1,1): PnL -70,30,30,130.
      const terminal = [-70n, 30n, 30n, 130n];
      const expected = -terminal.reduce((a, b) => (a < b ? a : b)) * s("1");
      const rows = run([
        position({
          tokenId: "x",
          conditionId: "cx",
          eventId: "ex",
          costScaled: s("30"),
          negRisk,
        }),
        position({
          tokenId: "y",
          conditionId: "cy",
          eventId: "ey",
          costScaled: s("40"),
        }),
      ]);
      for (const dimension of [
        "category",
        "factor",
        "resolution_source",
        "catalyst_window",
        "locked_capital",
        "total",
      ]) {
        expect(rows.find((row) => row.dimension === dimension)).toMatchObject({
          worstCaseScaled: expected,
          aggregation: "conservative_sum",
        });
      }
      expect(find(rows, "event", "ex")!.worstCaseScaled).toBe(s("30"));
      expect(find(rows, "event", "ey")!.worstCaseScaled).toBe(s("40"));
      expect(find(rows, "market", "cx")!.capScaled).toBe(s("50"));
    },
  );

  it("F1 separates short proceeds, residual loss, paid and unpaid fees", () => {
    // Q=-10, B=4. Terminal gross PnL at payout 0/1: +4,-6.
    const short = position({
      sharesScaled: -s("10"),
      costScaled: s("4"),
      feesPaidScaled: s("0.1"),
      realizedPnlScaled: -s("0.1"),
    });
    const total = find(run([short]), "total", "all")!;
    expect(total.worstCaseScaled).toBe(s("6"));
    expect(total.feesPaidScaled).toBe(s("0.1"));
    expect(total.realizedPnlScaled).toBe(-s("0.1"));
    // Since C0 the loss is 6.1; paid fee is in R once, not added to residual risk.
    expect(total.worstCaseScaled - total.realizedPnlScaled).toBe(s("6.1"));
    expect(
      find(run([{ ...short, remainingFeesScaled: s("0.2") }]), "total", "all")!
        .worstCaseScaled,
    ).toBe(s("6.2"));
    // Partial buyback from F1: Q=-6, B=2.4 => residual 3.6.
    expect(
      find(
        run([{ ...short, sharesScaled: -s("6"), costScaled: s("2.4") }]),
        "total",
        "all",
      )!.worstCaseScaled,
    ).toBe(s("3.6"));
  });

  it("F2 real NO has the same six-dollar gross loss without being a short", () => {
    // NO=0/1 yields -6/+4, with an unpaid 0.2 bound yields -6.2/+3.8.
    expect(
      find(
        run([
          position({
            sharesScaled: s("10"),
            costScaled: s("6"),
            remainingFeesScaled: s("0.2"),
          }),
        ]),
        "total",
        "all",
      )!.worstCaseScaled,
    ).toBe(s("6.2"));
  });

  it("reduces only with complete proven scenarios, preserving each dimension's subset", () => {
    // Exclusive complete X/Y: payoffs (1,0),(0,1) => PnL -2,-2.
    const rows = run(legs(), [
      eventProof([
        { x: s("1"), y: 0n },
        { x: 0n, y: s("1") },
      ]),
    ]);
    expect(find(rows, "event", "exclusive")).toMatchObject({
      worstCaseScaled: s("2"),
      aggregation: "proven_scenarios",
      proofRefs: ["fixture:exhaustive-contract-v1"],
    });
    expect(find(rows, "total", "all")!.worstCaseScaled).toBe(s("2"));
    // Each condition contains only its own leg: either one can lose all six.
    expect(find(rows, "market", "cx")!.worstCaseScaled).toBe(s("6"));
    expect(find(rows, "market", "cy")!.worstCaseScaled).toBe(s("6"));
    const split = legs();
    split[1] = { ...split[1]!, category: "other", unresolved: false };
    const subsets = run(split, [
      eventProof([
        { x: s("1"), y: 0n },
        { x: 0n, y: s("1") },
      ]),
    ]);
    expect(find(subsets, "category", "crypto")!.worstCaseScaled).toBe(s("6"));
    expect(find(subsets, "category", "other")!.worstCaseScaled).toBe(s("6"));
    expect(find(subsets, "locked_capital", "all")!.worstCaseScaled).toBe(
      s("6"),
    );
  });

  it("floors a guaranteed profit at zero and includes future fees in proven scenarios", () => {
    const positions = legs().map((p) => ({ ...p, costScaled: s("4") }));
    const proof = eventProof([
      { x: s("1"), y: 0n },
      { x: 0n, y: s("1") },
    ]);
    // Both scenarios pay 10 against cost 8 => profit 2; no negative risk credit.
    expect(find(run(positions, [proof]), "total", "all")!.worstCaseScaled).toBe(
      0n,
    );
    // Future fees 1.5 per leg: both scenarios now lose 1.
    expect(
      find(
        run(
          positions.map((p) => ({ ...p, remainingFeesScaled: s("1.5") })),
          [proof],
        ),
        "total",
        "all",
      )!.worstCaseScaled,
    ).toBe(s("1"));
  });

  it("refuses malformed owner/basis rather than inventing zero risk", () => {
    expect(() => run([position({ accountId: "" })])).toThrow(
      "FIN04_INVALID_POSITION",
    );
    expect(() => run([position({ costScaled: -1n })])).toThrow(
      "FIN04_INVALID_POSITION",
    );
    expect(() => run([position({ sharesScaled: 0n })])).toThrow(
      "FIN04_INVALID_POSITION",
    );
  });

  it("retains the uncovered outcome even in a proven event", () => {
    // (1,0),(0,1),(0,0) => PnL -2,-2,-12. Complete evidence includes OTHER.
    const proof = eventProof([
      { x: s("1"), y: 0n },
      { x: 0n, y: s("1") },
      { x: 0n, y: 0n },
    ]);
    expect(find(run(legs(), [proof]), "total", "all")!.worstCaseScaled).toBe(
      s("12"),
    );
  });

  it.each([
    "incomplete",
    "missing-token",
    "out-of-range",
    "no-evidence",
    "wrong-scope",
    "duplicate-proof",
  ])("falls back conservatively for %s proof", (kind) => {
    let proof = eventProof([
      { x: s("1"), y: 0n },
      { x: 0n, y: s("1") },
    ]);
    if (kind === "incomplete") proof = { ...proof, complete: false };
    if (kind === "missing-token")
      proof = { ...proof, scenarios: [{ x: s("1") }] };
    if (kind === "out-of-range")
      proof = { ...proof, scenarios: [{ x: s("2"), y: 0n }] };
    if (kind === "no-evidence") proof = { ...proof, evidenceRef: "" };
    if (kind === "wrong-scope")
      proof = { ...proof, scope: { kind: "condition", id: "cx" } };
    expect(
      find(
        run(legs(), kind === "duplicate-proof" ? [proof, proof] : [proof]),
        "total",
        "all",
      ),
    ).toMatchObject({
      worstCaseScaled: s("12"),
      aggregation: "conservative_sum",
    });
  });

  it.each(["strategyId", "accountId"] as const)(
    "never offsets distinct %s even under a valid proof",
    (field) => {
      const positions = legs();
      positions[1] = { ...positions[1]!, [field]: "second" };
      // Owner X can lose 6; owner Y can lose 6. Capital is not shared: sum = 12.
      const proof = eventProof([
        { x: s("1"), y: 0n },
        { x: 0n, y: s("1") },
      ]);
      expect(
        find(run(positions, [proof]), "total", "all")!.worstCaseScaled,
      ).toBe(s("12"));
    },
  );

  it("keeps opposite positions on the same token visible for two strategies", () => {
    const positions = [
      position({ sharesScaled: s("10"), costScaled: s("4") }),
      position({
        strategyId: "legacy",
        sharesScaled: -s("10"),
        costScaled: s("4"),
      }),
    ];
    // Long PnL -4/+6; short +4/-6. Their separate risks sum to 10, not zero.
    const proof: PayoffProof = {
      version: "payoff-scenarios-v1",
      evidenceRef: "fixture:binary",
      complete: true,
      scope: { kind: "condition", id: "0xa" },
      tokens: [{ tokenId: "t1", conditionId: "0xa" }],
      scenarios: [{ t1: 0n }, { t1: s("1") }],
    };
    expect(
      find(run(positions, [proof]), "market", "0xa")!.worstCaseScaled,
    ).toBe(s("10"));
  });

  it("sums an independent event alongside a proven group", () => {
    const positions = [
      ...legs(),
      position({ tokenId: "z", conditionId: "cz", costScaled: s("30") }),
    ];
    const proof = eventProof([
      { x: s("1"), y: 0n },
      { x: 0n, y: s("1") },
    ]);
    expect(find(run(positions, [proof]), "total", "all")).toMatchObject({
      worstCaseScaled: s("32"),
      aggregation: "mixed",
    });
  });

  it("handles zero quantity, zero bankroll, and empty inventory without reviving fees", () => {
    expect(find(run([]), "total", "all")!.worstCaseScaled).toBe(0n);
    expect(
      find(
        run([
          position({
            sharesScaled: 0n,
            costScaled: 0n,
            feesPaidScaled: s("1"),
            realizedPnlScaled: -s("1"),
          }),
        ]),
        "total",
        "all",
      )!.worstCaseScaled,
    ).toBe(0n);
    const rows = computeExposures({
      positions: [position()],
      bankrollScaled: 0n,
      caps: CAPS,
    });
    expect(find(rows, "total", "all")!.worstCaseScaled).toBe(s("40"));
    expect(
      capHeadroomFor(rows, candidateFor("OBJETIVA_UNICA:binance"), 0n, CAPS)
        .mercado,
    ).toBe(0n);
  });

  it("rounds fractional short liabilities upwards to the nano-dollar", () => {
    const proof: PayoffProof = {
      version: "payoff-scenarios-v1",
      evidenceRef: "fixture:void-half",
      complete: true,
      scope: { kind: "condition", id: "0xa" },
      tokens: [{ tokenId: "t1", conditionId: "0xa" }],
      scenarios: [{ t1: s("0.5") }],
    };
    expect(
      find(
        run([position({ sharesScaled: -1n, costScaled: 0n })], [proof]),
        "total",
        "all",
      )!.worstCaseScaled,
    ).toBe(1n);
  });
});
