import { describe, expect, it } from "vitest";

import type { QueryResult, SqlExecutor } from "../../../src/database.js";
import { divergenceCheck } from "../../../src/polymarket/resolution/divergence.js";

type Row = Record<string, unknown>;

const ASOF = new Date("2026-08-24T12:00:00.000Z");

interface DivergenceRow {
  divergence_id: number;
  condition_id: string;
  direction: string;
  ended_at: Date | null;
}

interface DivergenceWorld {
  pool: SqlExecutor;
  calls: Array<{ text: string; params: readonly unknown[] }>;
  state: {
    circuitBreakers: string[];
    frozen: string[];
    positions: Row[];
    divergences: DivergenceRow[];
  };
}

/**
 * Fake pool over the three read queries plus a tiny in-memory
 * resolution_layer_divergences table, so the open/refresh/close lifecycle is
 * exercised for real across cycles.
 */
function createWorld(): DivergenceWorld {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const state: DivergenceWorld["state"] = {
    circuitBreakers: [],
    frozen: [],
    positions: [],
    divergences: [],
  };
  let nextId = 1;
  const pool: SqlExecutor = {
    query<R extends Row>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const captured = [...(params ?? [])];
      calls.push({ text, params: captured });
      const respond = (rows: Row[]): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: rows as R[], rowCount: rows.length });

      if (text.includes("FROM resolution_market_state")) {
        return respond(
          state.circuitBreakers.map((conditionId) => ({
            condition_id: conditionId,
            effective_action: "CIRCUIT_BREAKER",
          })),
        );
      }
      if (text.includes("FROM paper_kill_switch")) {
        return respond([{ frozen_markets_json: [...state.frozen] }]);
      }
      if (text.includes("FROM paper_positions")) {
        return respond(state.positions);
      }
      if (
        text.includes("UPDATE resolution_layer_divergences") &&
        text.includes("SET last_seen_at")
      ) {
        const conditionId = String(captured[0]);
        const direction = String(captured[1]);
        const row = state.divergences.find(
          (item) =>
            item.condition_id === conditionId &&
            item.direction === direction &&
            item.ended_at === null,
        );
        return respond(row === undefined ? [] : [{}]);
      }
      if (text.includes("INSERT INTO resolution_layer_divergences")) {
        state.divergences.push({
          divergence_id: nextId,
          condition_id: String(captured[0]),
          direction: String(captured[1]),
          ended_at: null,
        });
        nextId += 1;
        return respond([]);
      }
      if (text.includes("SELECT divergence_id")) {
        return respond(
          state.divergences
            .filter((item) => item.ended_at === null)
            .map((item) => ({
              divergence_id: item.divergence_id,
              condition_id: item.condition_id,
              direction: item.direction,
            })),
        );
      }
      if (
        text.includes("UPDATE resolution_layer_divergences") &&
        text.includes("SET ended_at")
      ) {
        const divergenceId = Number(captured[0]);
        const row = state.divergences.find(
          (item) => item.divergence_id === divergenceId,
        );
        if (row !== undefined) {
          row.ended_at = captured[1] as Date;
        }
        return respond([{}]);
      }
      throw new Error(`unrouted query: ${text}`);
    },
  };
  return { pool, calls, state };
}

/** RFC-012 CB on 0xa/0xb; RFC-011 froze 0xb/0xc; only 0xc is actually held. */
function seedDisagreement(world: DivergenceWorld): void {
  world.state.circuitBreakers = ["0xa", "0xb"];
  world.state.frozen = ["0xb", "0xc"];
  world.state.positions = [
    { condition_id: "0xc", shares: "10.000000" },
    { condition_id: "0xa", shares: "0.000000000" },
  ];
}

describe("divergenceCheck", () => {
  it("records every disagreement in both directions and leaves agreement alone", async () => {
    const world = createWorld();
    seedDisagreement(world);

    const summary = await divergenceCheck(world.pool, ASOF);
    expect(summary).toEqual({
      rfc012Only: 1,
      rfc011Only: 1,
      opened: 2,
      closed: 0,
    });

    const inserts = world.calls.filter((call) =>
      call.text.includes("INSERT INTO resolution_layer_divergences"),
    );
    expect(inserts).toHaveLength(2);
    // 0xa: RFC-012 broke the circuit alone; the position is flat.
    expect(inserts[0]?.params[0]).toBe("0xa");
    expect(inserts[0]?.params[1]).toBe("rfc012_only");
    expect(inserts[0]?.params[2]).toBe("CIRCUIT_BREAKER");
    expect(inserts[0]?.params[3]).toBe(false); // rfc011_frozen
    expect(inserts[0]?.params[4]).toBe(false); // position_held
    // 0xc: RFC-011 froze alone; a real position is held there.
    expect(inserts[1]?.params[0]).toBe("0xc");
    expect(inserts[1]?.params[1]).toBe("rfc011_only");
    expect(inserts[1]?.params[2]).toBe("NONE");
    expect(inserts[1]?.params[3]).toBe(true); // rfc011_frozen
    expect(inserts[1]?.params[4]).toBe(true); // position_held
    // 0xb agrees in both layers: no divergence row for it in either direction.
    const conditions = inserts.map((call) => call.params[0]);
    expect(conditions).not.toContain("0xb");
  });

  it("refreshes open rows on the next cycle instead of reopening", async () => {
    const world = createWorld();
    seedDisagreement(world);
    await divergenceCheck(world.pool, ASOF);

    const second = await divergenceCheck(world.pool, ASOF);
    expect(second).toEqual({
      rfc012Only: 1,
      rfc011Only: 1,
      opened: 0,
      closed: 0,
    });
    expect(world.state.divergences).toHaveLength(2);
    expect(world.state.divergences.every((row) => row.ended_at === null)).toBe(
      true,
    );
  });

  it("closes every open row once the layers agree again", async () => {
    const world = createWorld();
    seedDisagreement(world);
    await divergenceCheck(world.pool, ASOF);

    world.state.circuitBreakers = [];
    world.state.frozen = [];
    const third = await divergenceCheck(world.pool, ASOF);
    expect(third).toEqual({
      rfc012Only: 0,
      rfc011Only: 0,
      opened: 0,
      closed: 2,
    });

    const closes = world.calls.filter(
      (call) =>
        call.text.includes("UPDATE resolution_layer_divergences") &&
        call.text.includes("SET ended_at"),
    );
    expect(closes).toHaveLength(2);
    expect(closes.map((call) => call.params[0]).sort()).toEqual([1, 2]);
    expect(
      world.state.divergences.every(
        (row) => row.ended_at?.getTime() === ASOF.getTime(),
      ),
    ).toBe(true);
  });
});
