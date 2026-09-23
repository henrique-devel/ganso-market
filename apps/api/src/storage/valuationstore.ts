import type { TradingScope } from "@ganso-market/contracts/trading";
import type { DatabasePool } from "../database.js";
import {
  projectFinancials,
  valueFinancials,
  type MarketEvidence,
  type ValuationCapture,
} from "../trading/valuation.js";
import {
  replayLedger,
  type LedgerIdentityInput,
  type LedgerReplayEvent,
} from "../trading/ledger.js";

import { readLedgerAccountTx } from "./ledgerstore.js";

/** Validation composition shared by storage reads and deterministic replay. */
export function replayFinancials(
  identity: LedgerIdentityInput,
  events: readonly LedgerReplayEvent[],
) {
  return projectFinancials(replayLedger(identity, events), events);
}

/** S2 library read boundary. No HTTP/operator surface until G2-06. One bounded
 * read-only snapshot, no projection repair, cache, pin or account activation.
 * asOf values market freshness, not a historical ledger cutoff: refuse a time
 * before any committed event. SQL uses the existing kind/time indexes. */
export async function readLedgerValuation(
  pool: Pick<DatabasePool, "transaction">,
  scope: TradingScope,
  asOf: string,
) {
  const at = Date.parse(asOf);
  if (
    !Number.isSafeInteger(at) ||
    at < 0 ||
    new Date(at).toISOString() !== asOf
  )
    throw new Error("BTC_VALUATION_INVALID_TIME");
  return pool.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await tx.query("SET LOCAL statement_timeout = '1500ms'");
    const ledger = await readLedgerAccountTx(tx, scope);
    if (ledger.events.some((e) => e.recorded_at > asOf || e.occurred_at > asOf))
      throw new Error("BTC_VALUATION_BEFORE_LEDGER");
    const latest: {
      book: MarketEvidence | null;
      context: MarketEvidence | null;
    } = { book: null, context: null };
    for (const kind of ["book", "context"] as const) {
      latest[kind] =
        (
          await tx.query<MarketEvidence>(
            `SELECT r.object_id,o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
        WHERE r.kind=$1 AND r.received_at <= $2 ORDER BY ${kind === "context" ? "r.received_at DESC" : "r.source_at DESC"},r.object_id LIMIT 1`,
            [kind, asOf],
          )
        ).rows[0] ?? null;
    }
    const capture =
      (
        await tx.query<{ payload: ValuationCapture }>(
          `SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
      WHERE r.kind='capture' AND r.received_at <= $1 ORDER BY r.received_at DESC,r.object_id LIMIT 1`,
          [asOf],
        )
      ).rows[0]?.payload ?? null;
    return valueFinancials(replayFinancials(ledger.identity, ledger.events), {
      as_of: asOf,
      ...latest,
      capture,
    });
  });
}
