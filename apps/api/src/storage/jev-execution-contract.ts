import {
  parseTradingContract,
  type TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import { venueGridPrice } from "../trading/price-grid.js";
import { assertEvidenceJson } from "../trading/retention.js";
import type { PassiveQueue } from "../trading/passive.js";
import type { IocFill } from "../trading/broker.js";
import type { JevEntryPlan } from "./jev-sizing.js";
import type { JevProtection } from "./jev-policy.js";
import { jevTime } from "./jev-context.js";

/** One account owns both trade budgets and depth claims. Alternative accounts
 * remain counterfactual, never a shared inventory or a pooled bank. v1 passive
 * and IOC journals keep their original, disjoint semantics. */
export const JEV_EXECUTION_VERSION = "btc.jev-execution.v1" as const;
export const requireExecution = (ok: unknown, reason: string): void => {
  if (!ok) throw new Error(`JEV_EXECUTION_${reason}`);
};
export type JevExecutionCommand =
  | {
      action: "submit";
      operation_id: string;
      order_id: string;
      plan_hash: string;
    }
  | { action: "cancel" | "advance" | "recover"; operation_id: string }
  | { action: "close"; operation_id: string; limit_price_raw: string };
export interface JevMakerState {
  plan: JevEntryPlan;
  plan_hash: string;
  sent_at: string;
  arrival_at: string;
  ack_at: string | null;
  expires_at: string | null;
  cancel_at: string | null;
  status:
    "sent" | "resting" | "cancel_pending" | "filled" | "cancelled" | "rejected";
  filled_btc_raw: string;
  queue: PassiveQueue | null;
  session: string | null;
  book_epoch: number | null;
  trade_epoch: number | null;
  coverage_at: number | null;
  latest_trade_at: string | null;
}
export interface JevCloseState {
  requested_at: string;
  arrival_at: string;
  limit_price_raw: string;
  causes: string[];
  pending: boolean;
}
export interface JevExecutionState {
  schema_version: typeof JEV_EXECUTION_VERSION;
  observed_at: string;
  maker: JevMakerState | null;
  metadata: TradingInstrumentMetadata | null;
  protection: JevProtection | null;
  close: JevCloseState | null;
  reason: string;
}
export interface JevExecutionFill extends IocFill {
  execution_id: string;
  order_id: string;
  position_id: string;
  side: "buy" | "sell";
  occurred_at: string;
  liquidity_key: string;
  kind: "maker" | "IOC";
}
export interface JevExecutionResult {
  fidelity: "low_observed_queue_not_venue_priority";
  state: JevExecutionState;
  fills: JevExecutionFill[];
  /** A flat ledger with cancellation still in flight is NOT reconciled flat. */
  reconciled_flat: boolean;
}
export const makerTerminal = (s: JevMakerState) =>
  ["filled", "cancelled", "rejected"].includes(s.status);
export function validateExecutionCommand(c: JevExecutionCommand) {
  assertEvidenceJson(c);
  const id = (v: unknown) =>
    typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(v);
  requireExecution(id(c.operation_id), "COMMAND");
  const keys = Object.keys(c).sort().join();
  if (c.action === "submit")
    requireExecution(
      keys === "action,operation_id,order_id,plan_hash" &&
        id(c.order_id) &&
        /^[a-f0-9]{64}$/.test(c.plan_hash),
      "COMMAND",
    );
  else if (c.action === "close")
    requireExecution(
      keys === "action,limit_price_raw,operation_id" &&
        /^[1-9][0-9]{0,37}$/.test(c.limit_price_raw),
      "COMMAND",
    );
  else
    requireExecution(
      ["cancel", "advance", "recover"].includes(c.action) &&
        keys === "action,operation_id",
      "COMMAND",
    );
}
/** Next valid venue price, not a guessed decimal tick. At the minimum spread
 * the quote falls back to the own best. The entry plan must use this price. */
export function quoteJevMaker(
  side: "buy" | "sell",
  bid: string,
  ask: string,
  metadata: TradingInstrumentMetadata,
): string {
  parseTradingContract("instrument", metadata.instrument);
  const b = BigInt(bid),
    a = BigInt(ask);
  requireExecution(
    b > 0n &&
      a > b &&
      venueGridPrice(b, 1n, "down", metadata) === b &&
      venueGridPrice(a, 1n, "down", metadata) === a,
    "QUOTE_BOOK",
  );
  const next = venueGridPrice(
    side === "buy" ? b + 1n : a - 1n,
    1n,
    side === "buy" ? "up" : "down",
    metadata,
  );
  return (
    next !== null && next > b && next < a ? next : side === "buy" ? b : a
  ).toString();
}
export const executionTime = (at: string, delta: number) =>
  new Date(jevTime(at) + delta).toISOString();
