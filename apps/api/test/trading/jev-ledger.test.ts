import { describe, expect, it } from "vitest";
import {
  jevGenesis,
  materializeJevBatch,
  replayJevLedger,
} from "../../src/storage/jev-ledger.js";
import {
  jevIdentity,
  jevCommand,
  iso,
  start,
  usd,
  fill,
} from "./jev-v2-fixture.js";
const at = iso(start + 10000);
const genesis = (i = jevIdentity()) =>
  materializeJevBatch(jevGenesis(i), "0", at);
describe("JEV capital/lifetime replay", () => {
  it.each(["paper", "stress"] as const)(
    "allocates independent 250 USD to %s",
    (mode) => {
      const i = jevIdentity(mode);
      expect(replayJevLedger(i, genesis(i))).toMatchObject({
        mode,
        cash_usd_raw: "250000000",
        last_sequence: "1",
        positions: [],
      });
    },
  );
  it("preserves fees and lifetime across a reporting cut", () => {
    const i = jevIdentity();
    const events = [
      ...genesis(),
      ...materializeJevBatch(
        {
          transaction_id: "trade",
          events: [
            jevCommand(i, "fill"),
            jevCommand(i, "fee", {
              event_type: "fee",
              execution_id: "exec:1",
              delta: usd("-123456"),
            }),
          ],
        },
        "1",
        at,
      ),
    ];
    const p = replayJevLedger(i, events, {
      start_at: iso(start + 1000),
      end_at: at,
    });
    expect(p.cash_usd_raw).toBe("249876544");
    expect(p.window_event_ids).toEqual(["fill", "fee"]);
    expect(() => replayJevLedger(i, events.slice(1))).toThrow(
      /GENESIS|SEQUENCE/,
    );
  });
  it("rejects another genesis, transfers and profile/mode/owner contamination", () => {
    const i = jevIdentity();
    for (const payload of [
      {
        event_type: "cash" as const,
        reason: "initial_allocation" as const,
        delta: usd("250000000"),
      },
      {
        event_type: "cash" as const,
        reason: "transfer" as const,
        delta: usd("250000000"),
      },
    ]) {
      const e = materializeJevBatch(
        { transaction_id: "reset", events: [jevCommand(i, "reset", payload)] },
        "1",
        at,
      );
      expect(() => replayJevLedger(i, [...genesis(), ...e])).toThrow(/RESET/);
    }
    for (const field of [
      "owner_id",
      "profile_version",
      "experiment_id",
      "mode",
      "instrument_version",
    ] as const)
      expect(() =>
        replayJevLedger(
          i,
          genesis().map((e) => ({ ...e, [field]: "other" })),
        ),
      ).toThrow();
  });
  it("does not fund live from a contract or a successor", () => {
    const i = jevIdentity("live");
    expect(replayJevLedger(i, []).cash_usd_raw).toBe("0");
    expect(() => jevGenesis(i)).toThrow(/VENUE_EVIDENCE/);
    const initial = i.bindings[0]!;
    i.bindings.push({
      profile: { ...initial.profile, profile_version: "v2" },
      binding: {
        ...initial.binding,
        profile_version: "v2",
        experiment_id: "successor",
        started_at: iso(start + 1000),
      },
    });
    expect(replayJevLedger(i, [])).toMatchObject({
      cash_usd_raw: "0",
      last_sequence: "0",
    });
  });
  it("does not allow fees or funding to change their opening owner", () => {
    const i = jevIdentity();
    const original = i.bindings[0]!;
    i.bindings.push({
      profile: { ...original.profile, profile_version: "v2" },
      binding: {
        ...original.binding,
        profile_version: "v2",
        experiment_id: "successor",
        started_at: iso(start + 500),
      },
    });
    const changed = { ...i, bindings: [i.bindings[1]!] };
    const events = [
      ...genesis(i),
      ...materializeJevBatch(
        {
          transaction_id: "fills",
          events: [
            jevCommand(i, "fill", fill()),
            jevCommand(changed, "fee", {
              event_type: "fee",
              execution_id: "exec:1",
              delta: usd("-1"),
            }),
          ],
        },
        "1",
        at,
      ),
    ];
    expect(() => replayJevLedger(i, events)).toThrow(/PARENT_OWNERSHIP/);
  });
});
