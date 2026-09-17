// Persisted, immutable inputs of the selected portfolio decision. Missing
// evidence fails closed; never substitute today's default configuration.
import type { SqlExecutor } from "../../database.js";
import {
  parsePortfolioConfig,
  portfolioConfigHash,
} from "../portfolio/config.js";
import type { EntryEconomics } from "./finalorder.js";

export async function loadEntryEconomics(
  tx: SqlExecutor,
  decisionId: number,
  conditionId: string,
  tokenId: string,
  at: Date,
): Promise<EntryEconomics | null> {
  const rows = await tx.query(
    `SELECT d.decision_kind, d.condition_id, d.token_id, d.market_side, d.order_side,
      d.size_shares, d.q, d.q_lo, d.q_hi, d.inputs_json, d.config_hash, c.content_json
     FROM portfolio_decisions d LEFT JOIN portfolio_config_versions c
      ON c.version=d.config_version AND c.config_hash=d.config_hash
     WHERE d.decision_id=$1`,
    [decisionId],
  );
  const row = rows.rows[0];
  if (!row) throw new Error("FINAL_ENTRY_DECISION_MISSING");
  // Mandatory reductions are governed by their exit contract, never this gate.
  if (row["decision_kind"] === "EXIT") return null;
  if (
    row["decision_kind"] !== "ENTRY" ||
    row["condition_id"] !== conditionId ||
    row["token_id"] !== tokenId ||
    row["order_side"] !== "BUY"
  )
    throw new Error("FINAL_ENTRY_IDENTITY_MISMATCH");
  const side = row["market_side"];
  const inputs = row["inputs_json"] as Record<string, unknown> | null;
  if (
    !inputs ||
    inputs["account_id"] !== "paper" ||
    inputs["strategy_id"] !== "main" ||
    inputs["entry_contract_version"] !== 2 ||
    (side !== "YES" && side !== "NO")
  )
    throw new Error("FINAL_ENTRY_IDENTITY_MISMATCH");
  const metadata = await tx.query(
    `SELECT affirmative_token_id, clob_token_ids FROM polymarket_market_metadata_versions
     WHERE condition_id=$1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)`,
    [conditionId, at],
  );
  const meta = metadata.rows[0];
  const tokens = meta?.["clob_token_ids"];
  const yes = meta?.["affirmative_token_id"];
  if (
    metadata.rows.length !== 1 ||
    !Array.isArray(tokens) ||
    tokens.length !== 2 ||
    new Set(tokens).size !== 2 ||
    typeof yes !== "string" ||
    !tokens.includes(yes) ||
    (side === "YES" ? yes : tokens.find((id) => id !== yes)) !== tokenId
  )
    throw new Error("FINAL_ENTRY_TOKEN_MAPPING_INVALID");
  let config;
  try {
    config = parsePortfolioConfig(row["content_json"]);
    if (portfolioConfigHash(config) !== row["config_hash"]) throw new Error();
  } catch {
    throw new Error("FINAL_ENTRY_CONFIG_MISSING");
  }
  const replay = inputs["replay"] as Record<string, unknown> | null;
  const str = (value: unknown): string => {
    if (typeof value !== "string") throw new Error("FINAL_ENTRY_INPUT_MISSING");
    return value;
  };
  const number = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("FINAL_ENTRY_INPUT_MISSING");
    return value;
  };
  return {
    accountId: "paper",
    strategyId: "main",
    conditionId,
    tokenId,
    marketSide: side,
    sizeMax: str(row["size_shares"]),
    q: str(row["q"]),
    qLo: str(row["q_lo"]),
    qHi: str(row["q_hi"]),
    expectedLockupS: number(replay?.["expected_lockup_s"]),
    bufferDailyHurdle: String(number(replay?.["buffer_daily_hurdle"])),
    resolutionBuffer: str(replay?.["resolution_buffer"]),
    capitalAnnualRate: String(config.costs.capitalCostAnnual),
    safetyMarginMin: String(config.costs.safetyMarginMin),
    safetyMarginEdgeFraction: String(config.costs.safetyMarginEdgeFraction),
    edgeLiqMin: String(config.costs.edgeLiqMin),
    modelRef: `portfolio:${String(decisionId)}:${String(row["config_hash"])}`,
    makerFee: "0",
    makerAdverseSelection: "0",
    makerAssumptionRef:
      "paper-passive-v1:zero-fee;conditional-fill;selection-unmodelled",
  };
}
