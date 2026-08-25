import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import {
  gateBufferAtPrice,
  resolutionGate,
} from "../../../src/polymarket/resolution/enforcement.js";

type Row = Record<string, unknown>;

function pool(states: Row[], vetoes: Row[] = []): SqlExecutor {
  return {
    query<R extends Row>(text: string): Promise<QueryResult<R>> {
      if (text.includes("FROM resolution_market_state")) {
        return Promise.resolve({
          rows: states as R[],
          rowCount: states.length,
        });
      }
      if (text.includes("FROM graph_sanity_vetoes")) {
        return Promise.resolve({
          rows: vetoes as R[],
          rowCount: vetoes.length,
        });
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

function stateRow(overrides: Row = {}): Row {
  return {
    score: "0.750000",
    score_version: "1.0.0",
    action: "VETO",
    effective_action: "VETO",
    resolution_buffer: "0.030000",
    p_5050: "0.050000",
    justification: "R=0.750 >= r_veto=0.7",
    ...overrides,
  };
}

describe("resolution gate (task 17)", () => {
  it("refuses an intent under VETO with the justification", async () => {
    const gate = await resolutionGate(pool([stateRow()]), {
      conditionId: "0xmkt",
      tokenId: "tok",
      source: "intent",
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("RESOLUTION_VETO");
    expect(gate.justification).toContain("r_veto");
  });

  it("refuses an intent under CIRCUIT_BREAKER (market or group)", async () => {
    const gate = await resolutionGate(
      pool([stateRow({ action: "NONE", effective_action: "CIRCUIT_BREAKER" })]),
      { conditionId: "0xmkt", source: "intent" },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("RESOLUTION_CIRCUIT_BREAKER");
  });

  it("refuses a manual order under CIRCUIT_BREAKER even with override", async () => {
    const gate = await resolutionGate(
      pool([stateRow({ effective_action: "CIRCUIT_BREAKER" })]),
      { conditionId: "0xmkt", source: "manual", overrideVeto: true },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("RESOLUTION_CIRCUIT_BREAKER");
    expect(gate.overrideApplied).toBe(false);
  });

  it("refuses a manual order under VETO without override, allows with it", async () => {
    const without = await resolutionGate(pool([stateRow()]), {
      conditionId: "0xmkt",
      source: "manual",
    });
    expect(without.allowed).toBe(false);
    expect(without.reason).toBe("RESOLUTION_VETO");

    const withOverride = await resolutionGate(pool([stateRow()]), {
      conditionId: "0xmkt",
      source: "manual",
      overrideVeto: true,
    });
    expect(withOverride.allowed).toBe(true);
    expect(withOverride.overrideApplied).toBe(true);
    expect(withOverride.score).toBe("0.750000");
  });

  it("blocks the model-dependent intent under an active sanity veto", async () => {
    const gate = await resolutionGate(
      pool(
        [stateRow({ action: "NONE", effective_action: "NONE" })],
        [{ veto_id: 1 }],
      ),
      { conditionId: "0xmkt", tokenId: "tok", source: "intent" },
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("SANITY_VETO_ACTIVE");
    expect(gate.sanityVetoActive).toBe(true);
  });

  it("does not block a MANUAL order for a sanity veto (model-only block)", async () => {
    const gate = await resolutionGate(
      pool(
        [stateRow({ action: "NONE", effective_action: "NONE" })],
        [{ veto_id: 1 }],
      ),
      { conditionId: "0xmkt", tokenId: "tok", source: "manual" },
    );
    expect(gate.allowed).toBe(true);
  });

  it("fails closed for intents when no state exists; manual proceeds", async () => {
    const intent = await resolutionGate(pool([]), {
      conditionId: "0xmkt",
      source: "intent",
    });
    expect(intent.allowed).toBe(false);
    expect(intent.reason).toBe("RESOLUTION_STATE_MISSING");

    const manual = await resolutionGate(pool([]), {
      conditionId: "0xmkt",
      source: "manual",
    });
    expect(manual.allowed).toBe(true);
  });

  it("returns the buffer for the EV discount in the middle band", async () => {
    const gate = await resolutionGate(
      pool([stateRow({ action: "BUFFER", effective_action: "BUFFER" })]),
      { conditionId: "0xmkt", source: "intent" },
    );
    expect(gate.allowed).toBe(true);
    expect(gate.resolutionBuffer).toBe("0.030000");
    // At 80¢ the 50/50 tail adds p5050 x 30¢: 0.03 + 0.05*0.3 = 0.045.
    expect(gateBufferAtPrice(gate, "0.800000")).toBe("0.045000");
    // At 40¢ a P3 is not a loss: base only.
    expect(gateBufferAtPrice(gate, "0.400000")).toBe("0.030000");
  });
});
