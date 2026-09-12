// FIN-02: version-selected attribution reads. This is membership evidence,
// not the financial-v2 fold, capital allocation or an active position cache.
import type { SqlExecutor } from "../../database.js";
import type { LedgerEventRecord, LedgerEventType } from "./ledger.js";

export const OWNERSHIP_VERSION = 1 as const;
export const LEGACY_OWNER = {
  accountId: "legacy_unattributed",
  strategyId: "unknown",
} as const;

export interface FinancialOwner {
  readonly accountId: string;
  readonly strategyId: string;
  readonly ownershipVersion: typeof OWNERSHIP_VERSION;
  readonly attributionStatus: "verified" | "unknown";
  readonly evidenceRef: string;
}

export interface AttributedLedgerEvent extends LedgerEventRecord {
  readonly eventId: string;
  readonly receivedAt: Date;
  readonly owner: FinancialOwner;
}

export interface OwnershipFilter {
  readonly accountId?: string;
  readonly strategyId?: string;
  readonly tokenId?: string;
}

/**
 * One row per event/owner in ownership v1, ordered economically. Global
 * resolution membership does not duplicate its fee: only zero-fee global
 * settlements can span owners. Marks retain ledger-v1 token-wide valuation;
 * a consumer must not reuse that value as each owner's executable mark.
 * Unproven history is explicit legacy, never a fallback to paper/main.
 */
export async function loadAttributedLedgerEvents(
  pool: SqlExecutor,
  filter: OwnershipFilter = {},
): Promise<AttributedLedgerEvent[]> {
  const result = await pool.query(
    `SELECT event_id::text, idempotency_key, event_type, order_id, token_id,
            condition_id, payload_json, event_ts, received_at,
            account_id, strategy_id, attribution_status, evidence_ref
       FROM paper_attributed_ledger_v1
      WHERE ($1::text IS NULL OR account_id = $1)
        AND ($2::text IS NULL OR strategy_id = $2)
        AND ($3::text IS NULL OR token_id = $3)
        AND event_type NOT IN ('kill_switch_engaged', 'kill_switch_rearmed')
      ORDER BY event_ts, idempotency_key, account_id, strategy_id`,
    [
      filter.accountId ?? null,
      filter.strategyId ?? null,
      filter.tokenId ?? null,
    ],
  );
  return result.rows.map((row) => ({
    eventId: String(row["event_id"]),
    idempotencyKey: row["idempotency_key"] as string,
    eventType: row["event_type"] as LedgerEventType,
    orderId: row["order_id"] as string | null,
    tokenId: row["token_id"] as string | null,
    conditionId: row["condition_id"] as string | null,
    payload: row["payload_json"] as Record<string, unknown>,
    eventTs: new Date(row["event_ts"] as Date),
    receivedAt: new Date(row["received_at"] as Date),
    owner: {
      accountId: row["account_id"] as string,
      strategyId: row["strategy_id"] as string,
      ownershipVersion: OWNERSHIP_VERSION,
      attributionStatus: row["attribution_status"] as "verified" | "unknown",
      evidenceRef: row["evidence_ref"] as string,
    },
  }));
}

export interface OpenOwnerToken {
  readonly accountId: string;
  readonly strategyId: string;
  readonly tokenId: string;
  readonly conditionId: string | null;
  /** Exact PostgreSQL numeric text; only membership, never sizing/equity. */
  readonly shares: string;
}

/** Settlement discovery must include opposing owners with a net-zero token. */
export async function loadOpenOwnerTokens(
  pool: SqlExecutor,
  tokenId?: string,
): Promise<OpenOwnerToken[]> {
  const result = await pool.query(
    `SELECT account_id, strategy_id, token_id, condition_id, shares::text
       FROM paper_open_owner_tokens()
      WHERE ($1::text IS NULL OR token_id = $1)
      ORDER BY token_id, account_id, strategy_id`,
    [tokenId ?? null],
  );
  return result.rows.map((row) => ({
    accountId: row["account_id"] as string,
    strategyId: row["strategy_id"] as string,
    tokenId: row["token_id"] as string,
    conditionId: row["condition_id"] as string | null,
    shares: row["shares"] as string,
  }));
}
