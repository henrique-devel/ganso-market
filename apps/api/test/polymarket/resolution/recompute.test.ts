import { describe, expect, it } from "vitest";

import type { QueryResult } from "../../../src/database.js";
import { groupCouplingPass } from "../../../src/polymarket/resolution/recompute.js";
import type { ResolutionPool } from "../../../src/polymarket/resolution/types.js";

type Row = Record<string, unknown>;

const AS_OF = new Date("2026-08-24T12:00:00.000Z");

function couplingPool(options: {
  readonly negRisk: boolean;
  readonly failUpdate?: boolean;
  readonly members?: readonly string[];
  readonly states?: readonly Row[];
  readonly updates: unknown[][];
  readonly statements: string[];
}): ResolutionPool {
  return {
    query<R extends Row>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<R>> {
      options.statements.push(text);
      if (text.includes("WITH touched AS")) {
        return Promise.resolve({
          rows: [
            {
              condition_id: "0xa",
              event_id: "event-1",
              neg_risk: options.negRisk,
              members: options.members ?? ["0xa", "0xb"],
            },
          ] as unknown as R[],
          rowCount: 1,
        });
      }
      if (text.includes("FROM resolution_market_state")) {
        const states = options.states ?? [
          {
            condition_id: "0xa",
            action: "CIRCUIT_BREAKER",
            score: "0.900000",
            event_ids_json: [],
          },
          {
            condition_id: "0xb",
            action: "NONE",
            score: "0.100000",
            event_ids_json: [],
          },
        ];
        return Promise.resolve({
          rows: states as unknown as R[],
          rowCount: states.length,
        });
      }
      if (text.startsWith("UPDATE resolution_market_state")) {
        if (options.failUpdate === true) {
          return Promise.reject(new Error("coupling update failed"));
        }
        options.updates.push([...params]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

describe("groupCouplingPass", () => {
  it("couples only a negRisk group using membership valid at the instant", async () => {
    const updates: unknown[][] = [];
    const statements: string[] = [];

    await groupCouplingPass(
      couplingPool({ negRisk: true, updates, statements }),
      ["0xa"],
      AS_OF,
    );

    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual([
      "0xb",
      "CIRCUIT_BREAKER",
      "0.900000",
      JSON.stringify(["event-1"]),
    ]);
    expect(statements[0]).toContain("em.received_at <= $2");
    expect(statements[0]).toContain("pv.valid_from <= $2");
    expect(statements[0]).toContain("bool_and(neg_risk_as_of IS TRUE)");
  });

  it("does not couple siblings of a regular event", async () => {
    const updates: unknown[][] = [];
    const statements: string[] = [];

    await groupCouplingPass(
      couplingPool({ negRisk: false, updates, statements }),
      ["0xa"],
      AS_OF,
    );

    expect(updates).toEqual([]);
    expect(
      statements.some((text) => text.includes("resolution_market_state")),
    ).toBe(false);
  });

  it("propagates a coupling write failure to the caller", async () => {
    const updates: unknown[][] = [];
    const statements: string[] = [];

    await expect(
      groupCouplingPass(
        couplingPool({
          negRisk: true,
          failUpdate: true,
          updates,
          statements,
        }),
        ["0xa"],
        AS_OF,
      ),
    ).rejects.toThrow("coupling update failed");
  });

  it("fails before updates when a group member has no market state", async () => {
    const updates: unknown[][] = [];
    const statements: string[] = [];

    await expect(
      groupCouplingPass(
        couplingPool({
          negRisk: true,
          states: [
            {
              condition_id: "0xa",
              action: "NONE",
              score: "0.100000",
              event_ids_json: [],
            },
          ],
          updates,
          statements,
        }),
        ["0xa"],
        AS_OF,
      ),
    ).rejects.toThrow("GROUP_COUPLING_STATE_SET_MISMATCH:event-1");
    expect(updates).toEqual([]);
  });

  it("fails before updates when returned states contain an unexpected member", async () => {
    const updates: unknown[][] = [];
    const statements: string[] = [];

    await expect(
      groupCouplingPass(
        couplingPool({
          negRisk: true,
          states: [
            { condition_id: "0xa", action: "NONE", score: "0.1" },
            { condition_id: "0xc", action: "NONE", score: "0.1" },
          ],
          updates,
          statements,
        }),
        ["0xa"],
        AS_OF,
      ),
    ).rejects.toThrow("GROUP_COUPLING_STATE_SET_MISMATCH:event-1");
    expect(updates).toEqual([]);
  });

  it("fails before updates when returned states duplicate a member", async () => {
    const updates: unknown[][] = [];
    const statements: string[] = [];

    await expect(
      groupCouplingPass(
        couplingPool({
          negRisk: true,
          states: [
            { condition_id: "0xa", action: "NONE", score: "0.1" },
            { condition_id: "0xa", action: "NONE", score: "0.1" },
          ],
          updates,
          statements,
        }),
        ["0xa"],
        AS_OF,
      ),
    ).rejects.toThrow("GROUP_COUPLING_STATE_SET_MISMATCH:event-1");
    expect(updates).toEqual([]);
  });

  it("fails before reading states when expected membership has duplicates", async () => {
    const updates: unknown[][] = [];
    const statements: string[] = [];

    await expect(
      groupCouplingPass(
        couplingPool({
          negRisk: true,
          members: ["0xa", "0xa"],
          updates,
          statements,
        }),
        ["0xa"],
        AS_OF,
      ),
    ).rejects.toThrow("GROUP_COUPLING_MEMBERS_DUPLICATE:event-1");
    expect(updates).toEqual([]);
    expect(
      statements.some((text) => text.includes("resolution_market_state")),
    ).toBe(false);
  });
});
