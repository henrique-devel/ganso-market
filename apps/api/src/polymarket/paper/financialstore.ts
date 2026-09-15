// FIN-03: rebuildable owner projection. The ledger remains the authority;
// cache watermarks are ingestion IDs, never an incremental economic cursor.
import type { DatabasePool, SqlExecutor } from "../../database.js";
import {
  divRound,
  formatScaled,
  parseScaled,
  SCALE,
} from "../fundamental/fixed.js";
import {
  applyFinancialMarks,
  replayFinancialLedger,
  type FinancialCapital,
  type FinancialLedgerState,
  type FinancialMark,
} from "./financial.js";
import { loadAttributedLedgerEvents } from "./ownership.js";

export interface OwnerSelection {
  readonly accountId: string;
  readonly strategyId: string;
}
export type FinancialPool = SqlExecutor &
  Partial<Pick<DatabasePool, "transaction">>;

// Same existing paper mark freshness ceiling. Source time and receive time are
// both checked; a future or unproven source timestamp cannot refresh a mark.
const MAX_MARK_AGE_MS = 30_000;

function executableValue(raw: unknown, signedShares: bigint): string | null {
  if (!Array.isArray(raw)) return null;
  let remaining = signedShares < 0n ? -signedShares : signedShares;
  let products = 0n;
  let previous: bigint | null = null;
  for (const item of raw) {
    if (remaining === 0n) break;
    if (typeof item !== "object" || item === null) return null;
    const level = item as Record<string, unknown>;
    const price = parseScaled(level["price"] as string);
    const size = parseScaled(level["size"] as string);
    if (
      price === null ||
      size === null ||
      price < 0n ||
      price > SCALE ||
      size < 0n
    )
      return null;
    if (
      previous !== null &&
      (signedShares > 0n ? price > previous : price < previous)
    )
      return null;
    previous = price;
    const take = size < remaining ? size : remaining;
    products += price * take;
    remaining -= take;
  }
  if (remaining !== 0n) return null;
  const value = divRound(products, SCALE);
  return formatScaled(signedShares > 0n ? value : -value, 9);
}

/**
 * One selected owner, one consistent snapshot and atomic cache rebuild. A late
 * fill always replays its economic bucket. Concurrent cache writers serialize;
 * a conflicting repeatable-read snapshot aborts every cache row together.
 */
export async function loadOwnerFinancialState(
  pool: FinancialPool,
  owner: OwnerSelection,
  now: Date,
): Promise<FinancialLedgerState> {
  if (pool.transaction === undefined)
    throw new Error("FIN03_TRANSACTION_REQUIRED");
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    // The owner row is immutable; cache writers are serialized with an advisory
    // xact lock. If a prior concurrent snapshot won, PostgreSQL refuses the
    // conflicting UPDATE instead of replacing it with an older projection.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 3))", [
      JSON.stringify([owner.accountId, owner.strategyId]),
    ]);
    const capitalRows = await tx.query(
      `SELECT initial_cash_usd, capital_source_ref FROM paper_financial_owners
        WHERE account_id=$1 AND strategy_id=$2 AND ownership_version=1`,
      [owner.accountId, owner.strategyId],
    );
    const capital: FinancialCapital = {
      ...owner,
      initialCashUsd:
        (capitalRows.rows[0]?.["initial_cash_usd"] as string | null) ?? null,
      capitalSourceRef:
        (capitalRows.rows[0]?.["capital_source_ref"] as string) ??
        "unestablished:FIN-03",
    };
    const events = await loadAttributedLedgerEvents(tx, owner);
    if (
      events.some(
        (event) =>
          (event.eventType === "fill" || event.eventType === "resolution") &&
          event.eventTs > now,
      )
    ) {
      throw new Error("FIN03_FUTURE_EVENT");
    }
    const replay = replayFinancialLedger(events, [capital], [], now);
    const cached = await tx.query(
      `SELECT token_id, shares, mark_value_signed_usd, mark_source_ts, mark_received_at
         FROM paper_owner_positions WHERE account_id=$1 AND strategy_id=$2
          AND ownership_version=1 AND accounting_version='financial-v2'`,
      [owner.accountId, owner.strategyId],
    );
    if (
      cached.rows.some(
        (row) =>
          row["mark_received_at"] instanceof Date &&
          row["mark_received_at"] > now,
      )
    ) {
      throw new Error("FIN03_PAST_PROJECTION");
    }
    const previous = new Map(
      cached.rows.map((row) => [String(row["token_id"]), row]),
    );
    const tokens = [
      ...new Set(
        [...replay.owners.values()].flatMap((value) =>
          [...value.positions]
            .filter(([, position]) => parseScaled(position.shares) !== 0n)
            .map(([token]) => token),
        ),
      ),
    ];
    const books =
      tokens.length === 0
        ? { rows: [] }
        : await tx.query(
            `SELECT t.token_id, b.bids_json, b.asks_json, b.source_ts, b.received_at
         FROM unnest($1::text[]) AS t(token_id)
         LEFT JOIN LATERAL (
           SELECT bids_json, asks_json, source_ts, received_at
             FROM polymarket_book_snapshots
            WHERE token_id=t.token_id AND received_at <= $2
            ORDER BY received_at DESC LIMIT 1
         ) b ON TRUE`,
            [tokens, now],
          );
    const byToken = new Map(
      books.rows.map((row) => [String(row["token_id"]), row]),
    );
    const marks: FinancialMark[] = [];
    for (const state of replay.owners.values()) {
      for (const [tokenId, position] of state.positions) {
        const shares = parseScaled(position.shares)!;
        if (shares === 0n) continue;
        const book = byToken.get(tokenId);
        const source =
          book?.["source_ts"] instanceof Date ? book["source_ts"] : null;
        const received =
          book?.["received_at"] instanceof Date ? book["received_at"] : null;
        const fresh =
          source !== null &&
          received !== null &&
          source <= now &&
          received <= now &&
          source <= received &&
          now.getTime() - source.getTime() <= MAX_MARK_AGE_MS &&
          now.getTime() - received.getTime() <= MAX_MARK_AGE_MS;
        const value = fresh
          ? executableValue(
              book?.[shares > 0n ? "bids_json" : "asks_json"],
              shares,
            )
          : null;
        const old = previous.get(tokenId);
        const reusable = old?.["shares"] === position.shares;
        marks.push({
          ...owner,
          tokenId,
          shares: position.shares,
          markValueSignedUsd:
            value ??
            (reusable ? (old["mark_value_signed_usd"] as string | null) : null),
          stale: value === null,
          sourceTs:
            value !== null
              ? source
              : reusable
                ? (old["mark_source_ts"] as Date | null)
                : null,
          receivedAt:
            value !== null
              ? received
              : reusable
                ? (old["mark_received_at"] as Date | null)
                : null,
        });
      }
    }
    const result = applyFinancialMarks(replay, marks, now);
    for (const state of result.owners.values()) {
      for (const [tokenId, p] of state.positions) {
        await tx.query(
          `INSERT INTO paper_owner_positions
            (account_id,strategy_id,token_id,condition_id,shares,cost_basis_usd,
             realized_pnl_usd,fees_paid_usd,opened_at,resolved_at,
             mark_value_signed_usd,mark_stale,mark_source_ts,mark_received_at,last_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (account_id,strategy_id,token_id,ownership_version,accounting_version)
           DO UPDATE SET condition_id=EXCLUDED.condition_id, shares=EXCLUDED.shares,
             cost_basis_usd=EXCLUDED.cost_basis_usd,realized_pnl_usd=EXCLUDED.realized_pnl_usd,
             fees_paid_usd=EXCLUDED.fees_paid_usd,opened_at=EXCLUDED.opened_at,resolved_at=EXCLUDED.resolved_at,
             mark_value_signed_usd=EXCLUDED.mark_value_signed_usd,mark_stale=EXCLUDED.mark_stale,
             mark_source_ts=EXCLUDED.mark_source_ts,mark_received_at=EXCLUDED.mark_received_at,
             last_event_id=EXCLUDED.last_event_id,updated_at=CURRENT_TIMESTAMP`,
          [
            owner.accountId,
            owner.strategyId,
            tokenId,
            p.conditionId,
            p.shares,
            p.costBasisUsd,
            p.realizedPnlUsd,
            p.feesPaidUsd,
            p.openedAt,
            p.resolvedAt,
            p.markValueSignedUsd,
            p.markStale,
            p.markSourceTs,
            p.markReceivedAt,
            p.lastEventId,
          ],
        );
      }
    }
    return result;
  });
}
