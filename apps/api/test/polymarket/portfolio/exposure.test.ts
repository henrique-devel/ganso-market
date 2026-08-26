import { describe, expect, it } from "vitest";

import { parseScaled } from "../../../src/polymarket/fundamental/fixed.js";
import { DEFAULT_PORTFOLIO_CONFIG } from "../../../src/polymarket/portfolio/config.js";
import { money } from "../../../src/polymarket/portfolio/ev.js";
import {
  capHeadroomFor,
  computeExposures,
  unwindAlarm,
  type OpenPosition,
} from "../../../src/polymarket/portfolio/exposure.js";

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
    tokenId: "t1",
    conditionId: "0xa",
    sharesScaled: s("100"),
    costScaled: s("40"),
    category: "crypto",
    eventId: null,
    resolutionSource: "binance",
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

  it("takes the LARGEST leg for a negRisk group, not the sum", () => {
    // The adapter reverts a [1, 1] report, so at most one leg pays. Summing
    // would overstate the group's worst case by the number of legs.
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
    expect(money(group!.worstCaseScaled)).toBe("40.000000");
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
    resolutionSource: "binance",
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
