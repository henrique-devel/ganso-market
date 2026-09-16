import { describe, expect, it, vi } from "vitest";
import type { SqlExecutor } from "../../../src/database.js";
import { loadEntryEconomics } from "../../../src/polymarket/paper/finalorderstore.js";

function store(rows: Record<string, unknown>[]): SqlExecutor {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

describe("EXEC-02 persisted economic source", () => {
  it("does not ask an EXIT for profitable-entry inputs, even without model/config", async () => {
    expect(
      await loadEntryEconomics(
        store([{ decision_kind: "EXIT" }]),
        1,
        "c",
        "t",
        new Date(),
      ),
    ).toBeNull();
  });
  it("refuses an absent source decision instead of creating an unaudited entry", async () => {
    await expect(
      loadEntryEconomics(store([]), 1, "c", "t", new Date()),
    ).rejects.toThrow("FINAL_ENTRY_DECISION_MISSING");
  });
  it("refuses another owner's entry before consulting economic defaults", async () => {
    await expect(
      loadEntryEconomics(
        store([
          {
            decision_kind: "ENTRY",
            condition_id: "c",
            token_id: "t",
            order_side: "BUY",
            market_side: "YES",
            inputs_json: {
              entry_contract_version: 2,
              account_id: "paper",
              strategy_id: "other",
            },
          },
        ]),
        1,
        "c",
        "t",
        new Date(),
      ),
    ).rejects.toThrow("FINAL_ENTRY_IDENTITY_MISMATCH");
  });
});
