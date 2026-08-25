import { describe, expect, it } from "vitest";

import type { SqlExecutor } from "../../src/database.js";
import {
  applyParamFields,
  applyParamObservation,
  applyRuleObservation,
  applyTickSizeChange,
  paramsAt,
  ruleAt,
  type ParamObservation,
  type RuleObservation,
} from "../../src/polymarket/versioning.js";
import { FakeDb } from "./fixtures/registry-fake-db.js";

const T0 = new Date("2026-08-19T10:00:00.000Z");
const T1 = new Date("2026-08-19T11:00:00.000Z");
const T2 = new Date("2026-08-19T12:00:00.000Z");

function ruleObs(overrides: Partial<RuleObservation> = {}): RuleObservation {
  return {
    conditionId: "0xcond",
    description: "Resolves YES if BTC closes above $70,000 on Friday.",
    resolutionSource: "Coinbase BTC-USD close",
    resolvedBy: "UMA",
    endDate: new Date("2026-08-22T00:00:00.000Z"),
    umaEndDate: null,
    umaBond: "750",
    umaReward: "5",
    customLiveness: null,
    automaticallyResolved: false,
    sourceTs: new Date("2026-08-19T09:59:00.000Z"),
    ...overrides,
  };
}

function paramObs(overrides: Partial<ParamObservation> = {}): ParamObservation {
  return {
    conditionId: "0xcond",
    feeBaseBps: "0",
    makerFeeBps: null,
    takerFeeBps: null,
    feeCurveJson: null,
    tickSize: "0.001",
    minOrderSize: "5",
    negRisk: false,
    sourceTs: null,
    ...overrides,
  };
}

class AtomicParamFakeDb extends FakeDb {
  public transactionCalls = 0;
  public failParamInsert = false;

  public override async transaction<T>(
    run: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    this.transactionCalls += 1;
    const before = this.paramVersions.map((row) => ({ ...row }));
    const tx: SqlExecutor = {
      query: <R extends Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ) => {
        if (
          this.failParamInsert &&
          text.includes("INSERT INTO polymarket_param_versions")
        ) {
          return Promise.reject(new Error("simulated param insert failure"));
        }
        return this.query<R>(text, params);
      },
    };
    try {
      return await run(tx);
    } catch (error: unknown) {
      this.paramVersions.splice(0, this.paramVersions.length, ...before);
      throw error;
    }
  }
}

describe("rule versioning", () => {
  it("inserts version 1 on first observation without a rule_change event", async () => {
    const db = new FakeDb();
    const result = await applyRuleObservation(db, ruleObs(), T0);

    expect(result).toMatchObject({ version: 1, changed: true });
    expect(db.ruleVersions).toHaveLength(1);
    expect(db.ruleVersions[0]).toMatchObject({
      condition_id: "0xcond",
      version: 1,
      valid_from: T0,
      valid_to: null,
    });
    expect(db.resolutionEvents).toHaveLength(0);
  });

  it("does nothing when the content is unchanged", async () => {
    const db = new FakeDb();
    await applyRuleObservation(db, ruleObs(), T0);
    const result = await applyRuleObservation(db, ruleObs(), T1);

    expect(result).toMatchObject({ version: 1, changed: false });
    expect(db.ruleVersions).toHaveLength(1);
    expect(db.resolutionEvents).toHaveLength(0);
  });

  it("a description change produces exactly one new version and one rule_change", async () => {
    const db = new FakeDb();
    await applyRuleObservation(db, ruleObs(), T0);
    const result = await applyRuleObservation(
      db,
      ruleObs({ description: "Clarified: uses the 5pm ET Coinbase close." }),
      T1,
    );

    expect(result.version).toBe(2);
    expect(result.changedFields).toEqual(["description"]);
    expect(db.ruleVersions).toHaveLength(2);
    // Old version closed exactly at the new version's valid_from.
    expect(db.ruleVersions[0]).toMatchObject({ version: 1, valid_to: T1 });
    expect(db.ruleVersions[1]).toMatchObject({
      version: 2,
      valid_from: T1,
      valid_to: null,
    });
    expect(db.resolutionEvents).toHaveLength(1);
    const payload = db.resolutionEvents[0]?.payload_json as Record<
      string,
      unknown
    >;
    expect(payload.changed_fields).toEqual(["description"]);
    expect(payload.previous_version).toBe(1);
    expect(payload.new_version).toBe(2);
    expect(payload.previous_hash).not.toBe(payload.new_hash);
  });

  it("rejects a changed complete rule observation older than the head", async () => {
    const db = new FakeDb();
    await applyRuleObservation(db, ruleObs(), T0);
    await applyRuleObservation(
      db,
      ruleObs({ description: "Newest rule text." }),
      T2,
    );

    for (const delayedAt of [T1, T2]) {
      await expect(
        applyRuleObservation(
          db,
          ruleObs({ description: "Delayed obsolete rule text." }),
          delayedAt,
        ),
      ).rejects.toThrow("RULE_OBSERVATION_TIME_NOT_MONOTONIC");
    }

    expect(db.ruleVersions).toHaveLength(2);
    expect(db.ruleVersions[1]).toMatchObject({
      description: "Newest rule text.",
      valid_from: T2,
      valid_to: null,
    });
    expect(db.resolutionEvents).toHaveLength(1);
  });

  it("ruleAt returns the version in force at the boundaries", async () => {
    const db = new FakeDb();
    await applyRuleObservation(db, ruleObs(), T0);
    await applyRuleObservation(
      db,
      ruleObs({ description: "Version two rules text." }),
      T1,
    );

    // Before any version exists.
    expect(await ruleAt(db, "0xcond", new Date(T0.getTime() - 1))).toBeNull();
    // Exactly at valid_from of v1.
    expect((await ruleAt(db, "0xcond", T0))?.version).toBe(1);
    // Just before the changeover: still v1 (valid_to is exclusive).
    expect(
      (await ruleAt(db, "0xcond", new Date(T1.getTime() - 1)))?.version,
    ).toBe(1);
    // Exactly at the changeover: v2 (valid_from is inclusive).
    expect((await ruleAt(db, "0xcond", T1))?.version).toBe(2);
    expect((await ruleAt(db, "0xcond", T2))?.version).toBe(2);
    // Unknown market.
    expect(await ruleAt(db, "0xother", T2)).toBeNull();
  });
});

describe("param versioning", () => {
  it("rolls back the close when inserting the replacement version fails", async () => {
    const db = new AtomicParamFakeDb();
    await applyParamObservation(db, paramObs(), T0);
    db.transactionCalls = 0;
    db.failParamInsert = true;

    await expect(
      applyParamObservation(db, paramObs({ feeBaseBps: "25" }), T1),
    ).rejects.toThrow("simulated param insert failure");

    expect(db.transactionCalls).toBe(1);
    expect(db.paramVersions).toHaveLength(1);
    expect(db.paramVersions[0]).toMatchObject({
      version: 1,
      valid_to: null,
    });
  });

  it("versions parameter changes and answers as-of queries", async () => {
    const db = new FakeDb();
    await applyParamObservation(db, paramObs(), T0);
    const unchanged = await applyParamObservation(db, paramObs(), T1);
    expect(unchanged.changed).toBe(false);
    expect(db.paramVersions).toHaveLength(1);

    const changed = await applyParamObservation(
      db,
      paramObs({ feeBaseBps: "25" }),
      T1,
    );
    expect(changed.version).toBe(2);
    expect(changed.changedFields).toEqual(["fee_base_bps"]);
    expect(db.paramVersions).toHaveLength(2);
    // Param changes do not emit rule_change events.
    expect(db.resolutionEvents).toHaveLength(0);

    expect(
      (await paramsAt(db, "0xcond", new Date(T1.getTime() - 1)))?.feeBaseBps,
    ).toBe("0");
    expect((await paramsAt(db, "0xcond", T1))?.feeBaseBps).toBe("25");
  });

  it("rejects a changed complete parameter observation older than the head", async () => {
    const db = new FakeDb();
    await applyParamObservation(db, paramObs(), T0);
    await applyParamObservation(db, paramObs({ feeBaseBps: "25" }), T2);

    for (const delayedAt of [T1, T2]) {
      await expect(
        applyParamObservation(db, paramObs({ feeBaseBps: "10" }), delayedAt),
      ).rejects.toThrow("PARAM_OBSERVATION_TIME_NOT_MONOTONIC");
    }

    expect(db.paramVersions).toHaveLength(2);
    expect(db.paramVersions[1]).toMatchObject({
      fee_base_bps: "25",
      valid_from: T2,
      valid_to: null,
    });
  });

  it("does not version a semantically identical fee curve with reordered keys", async () => {
    const db = new FakeDb();
    await applyParamObservation(
      db,
      paramObs({ feeCurveJson: { z: 3, nested: { b: 2, a: 1 } } }),
      T0,
    );

    const reordered = await applyParamObservation(
      db,
      paramObs({ feeCurveJson: { nested: { a: 1, b: 2 }, z: 3 } }),
      T1,
    );

    expect(reordered).toMatchObject({ version: 1, changed: false });
    expect(db.paramVersions).toHaveLength(1);
  });

  it("tick_size_change opens a new version carrying the other fields", async () => {
    const db = new FakeDb();
    await applyParamObservation(db, paramObs(), T0);

    const result = await applyTickSizeChange(
      db,
      {
        market: "0xcond",
        asset_id: "111",
        new_tick_size: "0.01",
        timestamp: "1787098643398",
      },
      T1,
    );

    expect(result.version).toBe(2);
    expect(result.changedFields).toEqual(["tick_size"]);
    expect(db.paramVersions).toHaveLength(2);
    const next = db.paramVersions[1];
    expect(next).toMatchObject({
      tick_size: "0.01",
      // Carried over from the open version, not blanked.
      min_order_size: "5",
      fee_base_bps: "0",
      neg_risk: false,
      valid_from: T1,
      valid_to: null,
    });
    // WS epoch-ms timestamp converted to a Date (crash-loop regression).
    expect(next?.source_ts).toBeInstanceOf(Date);
    expect((next?.source_ts as Date).getTime()).toBe(1_787_098_643_398);
  });

  it("tick_size_change on an unseen market creates version 1", async () => {
    const db = new FakeDb();
    const result = await applyTickSizeChange(
      db,
      {
        market: "0xnew",
        asset_id: "222",
        new_tick_size: "0.001",
        timestamp: null,
      },
      T0,
    );
    expect(result.version).toBe(1);
    expect(db.paramVersions[0]).toMatchObject({
      condition_id: "0xnew",
      tick_size: "0.001",
      min_order_size: null,
    });
  });

  it("a partial fee patch keeps the tick size from the open version", async () => {
    const db = new FakeDb();
    await applyParamObservation(db, paramObs(), T0);
    const result = await applyParamFields(
      db,
      "0xcond",
      { feeBaseBps: "40", makerFeeBps: "0", takerFeeBps: "40" },
      T1,
    );
    expect(result.changed).toBe(true);
    expect(db.paramVersions[1]).toMatchObject({
      fee_base_bps: "40",
      taker_fee_bps: "40",
      tick_size: "0.001",
      min_order_size: "5",
    });
    // Re-applying the same patch is a no-op (no version flapping).
    const again = await applyParamFields(
      db,
      "0xcond",
      { feeBaseBps: "40", makerFeeBps: "0", takerFeeBps: "40" },
      T2,
    );
    expect(again.changed).toBe(false);
    expect(db.paramVersions).toHaveLength(2);
  });

  it("merges a delayed disjoint patch but rejects a delayed same-field revert", async () => {
    const db = new FakeDb();
    await applyParamObservation(db, paramObs(), T0);
    await applyParamFields(db, "0xcond", { tickSize: "0.01" }, T2);

    const delayedFee = await applyParamFields(
      db,
      "0xcond",
      { feeBaseBps: "40", takerFeeBps: "40" },
      T1,
    );
    expect(delayedFee).toMatchObject({
      version: 3,
      changed: true,
      changedFields: ["fee_base_bps", "taker_fee_bps"],
    });
    expect(db.paramVersions[2]).toMatchObject({
      fee_base_bps: "40",
      taker_fee_bps: "40",
      tick_size: "0.01",
      valid_from: new Date(T2.getTime() + 1),
      received_at: T1,
      valid_to: null,
    });

    const between = new Date(T1.getTime() + 30 * 60_000);
    await expect(
      applyParamFields(db, "0xcond", { tickSize: "0.005" }, between),
    ).rejects.toThrow("PARAM_PATCH_CAUSAL_CONFLICT:tick_size");
    expect(db.paramVersions).toHaveLength(3);
    expect(db.paramVersions[2]).toMatchObject({
      tick_size: "0.01",
      valid_to: null,
    });
  });

  it("uses serialization order to break a partial-patch timestamp tie", async () => {
    const db = new FakeDb();
    await applyParamFields(db, "0xnew", { tickSize: "0.01" }, T0);

    const tied = await applyParamFields(db, "0xnew", { tickSize: "0.005" }, T0);
    expect(tied).toMatchObject({ version: 2, changed: true });
    expect(db.paramVersions).toHaveLength(2);
    expect(db.paramVersions[1]).toMatchObject({
      tick_size: "0.005",
      valid_from: new Date(T0.getTime() + 1),
      received_at: T0,
      valid_to: null,
    });
  });
});
