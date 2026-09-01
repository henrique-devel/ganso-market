// RFC-017 mode A: the config sweep.
//
// The decision fixture lives in `../fixtures/portfolio-decision.ts`, together
// with the note on why its lockup is 180 days and production's is hours.

import { describe, expect, it } from "vitest";

import { portfolioConfigHash } from "../../../src/polymarket/portfolio/config.js";
import type { PersistedDecision } from "../../../src/polymarket/portfolio/replay.js";
import {
  acceptSlack,
  breakevenValue,
  configValueAt,
  configWithKey,
  parseValues,
  rederive,
  SweepAccumulator,
  SweepError,
  sweepDecision,
  type DecisionSweep,
} from "../../../src/polymarket/portfolio/sweep.js";
import {
  ReadOnlyViolation,
  readOnlyPool,
} from "../../../src/polymarket/portfolio/sweepstore.js";
import {
  CONFIG,
  CONFIG_HASH,
  entryDecision,
} from "../fixtures/portfolio-decision.js";

function sweep(
  decision: PersistedDecision,
  path: string,
  values: readonly number[],
): DecisionSweep {
  const result = sweepDecision({ decision, config: CONFIG, path, values });
  if (typeof result === "string") {
    throw new Error(`expected a sweep, got exclusion ${result}`);
  }
  return result;
}

describe("the fixture itself", () => {
  it("is ACCEPTED under the recorded config, with the margin the tests assume", () => {
    const decision = entryDecision();
    expect(decision.outcome).toBe("ACCEPTED");
    expect(decision.edgeNet).toBe("0.030000");
    expect(decision.safetyMargin).toBe("0.010000");
    expect(decision.capitalCost).toBe("0.000000");
    expect(decision.bindingConstraint).toBe("KELLY_CAP");
  });
});

describe("configWithKey", () => {
  it("replaces one key and leaves every other one alone", () => {
    const swapped = configWithKey(CONFIG, "costs.capitalCostAnnual", 0.4);
    expect(swapped.costs.capitalCostAnnual).toBe(0.4);
    expect(swapped.costs.edgeLiqMin).toBe(CONFIG.costs.edgeLiqMin);
    expect(swapped.kelly).toEqual(CONFIG.kelly);
    expect(swapped.caps).toEqual(CONFIG.caps);
  });

  it("changes the hash, which is exactly why the sweep is not the audit", () => {
    const swapped = configWithKey(CONFIG, "costs.capitalCostAnnual", 0.4);
    expect(portfolioConfigHash(swapped)).not.toBe(CONFIG_HASH);
  });

  it("refuses a key whose effect is upstream of the persisted inputs", () => {
    for (const path of [
      "caps.mercado",
      "breakers.jumpThreshold",
      "lossLimits.perdaDiariaMax",
      "bankrollUsd",
      "kelly.maxLambda",
    ]) {
      expect(() => configWithKey(CONFIG, path, 0.5)).toThrowError(SweepError);
      try {
        configWithKey(CONFIG, path, 0.5);
      } catch (error) {
        expect((error as SweepError).reasonCode).toBe("KEY_NOT_REPLAYABLE");
        // The refusal has to say WHY, or an operator reads it as a bug.
        expect((error as SweepError).message).toMatch(
          /reaches the replay|gates/,
        );
      }
    }
  });

  it("refuses a key nobody has heard of", () => {
    expect(() => configWithKey(CONFIG, "costs.notAKey", 1)).toThrowError(
      /not a known portfolio config key/,
    );
  });

  it("refuses an out-of-range value, through the parser", () => {
    expect(() => configWithKey(CONFIG, "costs.edgeLiqMin", 5)).toThrowError(
      /out of|within/i,
    );
  });

  it("refuses a lambda above maxLambda — the cross-field invariant", () => {
    // A hand-patched object would have accepted this silently.
    expect(() => configWithKey(CONFIG, "kelly.lambda", 0.9)).toThrowError(
      /maxLambda/,
    );
  });

  it("reads the recorded value back", () => {
    expect(configValueAt(CONFIG, "costs.capitalCostAnnual")).toBe(0.12);
  });
});

describe("sweepDecision", () => {
  it("changes nothing at the recorded value — the control line", () => {
    const result = sweep(entryDecision(), "costs.capitalCostAnnual", [0.12]);
    const control = result.candidates[0];
    expect(control?.verdictChanged).toBe(false);
    expect(control?.bindingChanged).toBe(false);
    expect(control?.deltaEdgeNet).toBe(0);
    expect(control?.deltaCapitalCost).toBe(0);
    expect(control?.slackConsumed).toBe(0);
  });

  it("flips ACCEPTED -> EDGE_BELOW_MIN above the crossing, and again below the margin", () => {
    const result = sweep(
      entryDecision(),
      "costs.capitalCostAnnual",
      [0.12, 0.4, 0.43, 0.6],
    );
    expect(result.baselineOutcome).toBe("ACCEPTED");

    const [control, near, over, far] = result.candidates;
    expect(control?.verdictChanged).toBe(false);
    // 0.40 is above the sign crossing (r > 0.1825/p) but still under the
    // magnitude that matters: positive is not binding.
    expect(near?.verdictChanged).toBe(false);
    expect(near?.deltaCapitalCost).toBeGreaterThan(0);
    expect(near?.capitalCostBecamePositive).toBe(true);

    // The two rejections arrive in order as the charge grows: first the net
    // edge falls under `edgeLiqMin` (0.01 < edge_net < 0.02), then under the
    // safety margin itself.
    expect(over?.verdictChanged).toBe(true);
    expect(over?.outcome).toBe("REJECTED");
    expect(over?.reasonCode).toBe("EDGE_BELOW_MIN");
    expect(over?.bindingChanged).toBe(true);
    expect(over?.bindingConstraint).toBe("NOT_SIZED");

    expect(far?.reasonCode).toBe("LOWER_BOUND_BELOW_COSTS");
  });

  it("moves the binding constraint without moving the verdict", () => {
    // Kelly at 0.25 allows ~28.6 shares and the entrada cap allows 40; at 0.5
    // Kelly allows ~57 and the cap becomes what binds.
    const result = sweep(entryDecision(), "kelly.lambda", [0.25, 0.5]);
    expect(result.baselineBinding).toBe("KELLY_CAP");
    const raised = result.candidates[1];
    expect(raised?.verdictChanged).toBe(false);
    expect(raised?.outcome).toBe("ACCEPTED");
    expect(raised?.bindingChanged).toBe(true);
    expect(raised?.bindingConstraint).toBe("CAP_ENTRADA");
    expect(raised?.deltaSizeShares).toBeGreaterThan(0);
  });

  it("excludes a decision whose recorded config no longer reproduces it", () => {
    const tampered: PersistedDecision = {
      ...entryDecision(),
      configHash: "0".repeat(64),
    };
    const result = sweepDecision({
      decision: tampered,
      config: CONFIG,
      path: "costs.capitalCostAnnual",
      values: [0.4],
    });
    expect(result).toBe("BASELINE_MISMATCH");
  });

  it("excludes a decision whose engine output drifted, rather than sweeping it", () => {
    // Same recorded config, but a persisted output that the engine no longer
    // produces. The difference the sweep would report could be the drift.
    const drifted: PersistedDecision = {
      ...entryDecision(),
      edgeNet: "0.099999",
    };
    const result = sweepDecision({
      decision: drifted,
      config: CONFIG,
      path: "costs.capitalCostAnnual",
      values: [0.4],
    });
    expect(result).toBe("BASELINE_MISMATCH");
  });

  it("is byte-for-byte deterministic across two runs", () => {
    const values = [0.12, 0.15, 0.183, 0.2, 0.25, 0.3, 0.365, 0.4, 0.5];
    const first = sweep(entryDecision(), "costs.capitalCostAnnual", values);
    const second = sweep(entryDecision(), "costs.capitalCostAnnual", values);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("acceptSlack — the margin metric", () => {
  it("is the signed distance to the boundary that actually decides", () => {
    const row = rederive({ decision: entryDecision(), config: CONFIG });
    // edge_net 0.03 against max(safety_margin 0.01, edgeLiqMin 0.02).
    expect(acceptSlack(row!, CONFIG)).toBeCloseTo(0.01, 9);
  });

  it("is null for a row that never reached the arithmetic", () => {
    const vetoed = entryDecision({ breakerOpen: true });
    expect(vetoed.reasonCode).toBe("PORTFOLIO_CIRCUIT_BREAKER");
    const row = rederive({ decision: vetoed, config: CONFIG });
    expect(acceptSlack(row!, CONFIG)).toBeNull();
  });

  it("reports how much of the slack a candidate consumed", () => {
    const result = sweep(entryDecision(), "costs.capitalCostAnnual", [0.4]);
    const candidate = result.candidates[0];
    // 0.40 charges 0.008630/share against 0.01 of slack: 86%, and still no flip.
    // This is the number that separates "cannot bite" from "did not bite".
    expect(candidate?.slackConsumed).toBeGreaterThan(0.8);
    expect(candidate?.slackConsumed).toBeLessThan(0.9);
    expect(candidate?.verdictChanged).toBe(false);
  });
});

describe("breakevenValue", () => {
  it("finds the rate at which the verdict changes, and confirms it there", () => {
    const found = breakevenValue({
      decision: entryDecision(),
      config: CONFIG,
      path: "costs.capitalCostAnnual",
      bracketLow: 0.12,
      bracketHigh: 10,
    });
    expect(found).not.toBeNull();
    // Solved by hand: excess = r x (180/365) x 0.5 - 0.0005 x 180 > 0.01
    // gives r > 0.4056.
    expect(found?.value).toBeGreaterThan(0.4);
    expect(found?.value).toBeLessThan(0.42);
    expect(found?.fromOutcome).toBe("ACCEPTED:-");
    expect(found?.toOutcome).toBe("REJECTED:EDGE_BELOW_MIN");
  });

  it("returns null when nothing in the bracket changes the verdict", () => {
    // The production lockup. No rate up to 1000%/yr moves this decision, which
    // is the finding, not a failure of the search.
    const short = entryDecision({ expectedLockupS: 13_198 });
    const found = breakevenValue({
      decision: short,
      config: CONFIG,
      path: "costs.capitalCostAnnual",
      bracketLow: 0.12,
      bracketHigh: 10,
    });
    expect(found).toBeNull();
  });
});

describe("SweepAccumulator", () => {
  const values = [0.12, 0.43];

  it("counts lines and distinct markets separately", () => {
    const accumulator = new SweepAccumulator({
      path: "costs.capitalCostAnnual",
      recordedValue: 0.12,
      values,
    });
    // One long-lived market contributing three lines, one short-lived market
    // contributing one. A per-line percentage would call this 75/25; the truth
    // about markets is 50/50.
    for (const id of [1, 2, 3]) {
      accumulator.add(
        sweep(
          entryDecision({}, id, "0xlong"),
          "costs.capitalCostAnnual",
          values,
        ),
      );
    }
    accumulator.add(
      sweep(entryDecision({}, 4, "0xshort"), "costs.capitalCostAnnual", values),
    );

    const totals = accumulator.totals();
    expect(totals.decisionsAdmitted).toBe(4);
    expect(totals.marketsAdmitted).toBe(2);
    const flipped = totals.candidates[1];
    expect(flipped?.linesChanged).toBe(4);
    expect(flipped?.marketsChanged).toBe(2);
    expect(flipped?.verdictTransitions).toEqual({
      "ACCEPTED:- -> REJECTED:EDGE_BELOW_MIN": 4,
    });
  });

  it("weights lines and markets differently when only the long market flips", () => {
    const accumulator = new SweepAccumulator({
      path: "costs.capitalCostAnnual",
      recordedValue: 0.12,
      values,
    });
    for (const id of [1, 2, 3]) {
      accumulator.add(
        sweep(
          entryDecision({}, id, "0xlong"),
          "costs.capitalCostAnnual",
          values,
        ),
      );
    }
    // A market whose lockup is the production one: nothing moves it.
    accumulator.add(
      sweep(
        entryDecision({ expectedLockupS: 13_198 }, 4, "0xshort"),
        "costs.capitalCostAnnual",
        values,
      ),
    );

    const flipped = accumulator.totals().candidates[1];
    expect(flipped?.linesChanged).toBe(3);
    expect(flipped?.marketsChanged).toBe(1);
    // 3/4 of the lines but 1/2 of the markets: the two readings disagree, which
    // is the whole reason both are printed.
    expect(flipped?.linesChanged).not.toBe(flipped?.marketsChanged);
  });

  it("counts every exclusion, so the denominator can be audited", () => {
    const accumulator = new SweepAccumulator({
      path: "costs.capitalCostAnnual",
      recordedValue: 0.12,
      values,
    });
    accumulator.excluded("0xa", "BASELINE_MISMATCH");
    accumulator.excluded("0xb", "CONFIG_UNAVAILABLE");
    accumulator.add(
      sweep(entryDecision({}, 1, "0xc"), "costs.capitalCostAnnual", values),
    );

    const totals = accumulator.totals();
    expect(totals.decisionsSeen).toBe(3);
    expect(totals.decisionsAdmitted).toBe(1);
    expect(totals.exclusions.BASELINE_MISMATCH).toBe(1);
    expect(totals.exclusions.CONFIG_UNAVAILABLE).toBe(1);
    expect(totals.marketsSeen).toBe(3);
  });

  it("separates the rows that reached the arithmetic from the rest", () => {
    const accumulator = new SweepAccumulator({
      path: "costs.capitalCostAnnual",
      recordedValue: 0.12,
      values,
    });
    accumulator.add(
      sweep(entryDecision({}, 1, "0xa"), "costs.capitalCostAnnual", values),
    );
    accumulator.add(
      sweep(
        entryDecision({ breakerOpen: true }, 2, "0xb"),
        "costs.capitalCostAnnual",
        values,
      ),
    );

    const totals = accumulator.totals();
    expect(totals.decisionsAdmitted).toBe(2);
    // The breaker row is admitted (it replays) but it never reached the EV math,
    // so no cost key could ever move it. Counting it in the denominator would
    // make every percentage smaller for a reason that has nothing to do with
    // the parameter.
    expect(totals.decisionsReachingArithmetic).toBe(1);
    expect(totals.marketsReachingArithmetic).toBe(1);
  });
});

describe("parseValues", () => {
  it("parses a candidate list", () => {
    expect(parseValues("0.12,0.15, 0.4")).toEqual([0.12, 0.15, 0.4]);
  });

  it("refuses anything that is not a finite number", () => {
    expect(() => parseValues("0.12,abc")).toThrowError(SweepError);
    expect(() => parseValues("")).toThrowError(/at least one/);
  });
});

describe("readOnlyPool", () => {
  function spyPool(): {
    statements: string[];
    pool: Parameters<typeof readOnlyPool>[0];
  } {
    const statements: string[] = [];
    const executor = {
      query: (text: string) => {
        statements.push(text);
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    return {
      statements,
      pool: {
        query: executor.query,
        transaction: <T>(run: (tx: typeof executor) => Promise<T>) =>
          run(executor),
        end: () => Promise.resolve(),
      } as unknown as Parameters<typeof readOnlyPool>[0],
    };
  }

  it("lets a SELECT through, inside a read-only transaction", async () => {
    const { statements, pool } = spyPool();
    await readOnlyPool(pool).query("SELECT 1");
    // The server-side lock is issued before the statement it guards.
    expect(statements[0]).toBe("SET TRANSACTION READ ONLY");
    expect(statements[1]).toBe("SELECT 1");
  });

  it("refuses every statement that could write", async () => {
    const { statements, pool } = spyPool();
    const guarded = readOnlyPool(pool);
    for (const statement of [
      "INSERT INTO portfolio_decisions VALUES (1)",
      "UPDATE portfolio_config_versions SET content_json = '{}'",
      "DELETE FROM portfolio_decisions",
      "TRUNCATE portfolio_decisions",
      "DROP TABLE portfolio_decisions",
      "  update portfolio_state set state = 'HALTED'",
      "WITH x AS (INSERT INTO portfolio_decisions VALUES (1) RETURNING 1) SELECT * FROM x",
      "SELECT 1; DROP TABLE portfolio_decisions",
    ]) {
      await expect(guarded.query(statement)).rejects.toThrowError(
        ReadOnlyViolation,
      );
    }
    // Nothing reached the executor at all.
    expect(statements).toEqual([]);
  });
});
