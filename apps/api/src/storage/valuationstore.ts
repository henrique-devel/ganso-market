import type { TradingScope } from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  projectFinancials,
  dailyFinancialCosts,
  valueFinancials,
  type MarketEvidence,
  type ValuationCapture,
} from "../trading/valuation.js";
import {
  replayLedger,
  type LedgerIdentityInput,
  type LedgerReplayEvent,
} from "../trading/ledger.js";

import { readFundingCoverageTx } from "./fundingstore.js";

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
    const market = await readValuationMarketTx(tx, asOf);
    const value = valueFinancials(
      replayFinancials(ledger.identity, ledger.events),
      {
        as_of: asOf,
        ...market,
      },
    );
    const funding = await readFundingCoverageTx(
      tx,
      scope.account_id,
      ledger.events,
      asOf,
    );
    return {
      ...value,
      funding,
      daily: dailyFinancialCosts(ledger.projection, ledger.events, asOf),
      maintenance: {
        ...value.maintenance,
        usable_for_risk:
          value.maintenance.usable_for_risk && funding.usable_for_risk,
      },
    };
  });
}

/** One SQL statement keeps context/book/capture coherent even in S3's READ
 * COMMITTED writer, after its owner lock. No nested transaction or unlocked
 * caller-supplied equity snapshot is accepted by reservation writes. */
export async function readValuationMarketTx(tx: SqlExecutor, asOf: string) {
  const row = (
    await tx.query<{
      context: MarketEvidence | null;
      book: MarketEvidence | null;
      capture: ValuationCapture | null;
    }>(
      `SELECT
    (SELECT jsonb_build_object('object_id',r.object_id,'payload',o.payload)
     FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
     WHERE r.kind='context' AND r.received_at <= $1 ORDER BY r.received_at DESC,r.object_id LIMIT 1) AS context,
    (SELECT jsonb_build_object('object_id',r.object_id,'payload',o.payload)
     FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
     WHERE r.kind='book' AND r.received_at <= $1 ORDER BY r.source_at DESC,r.object_id LIMIT 1) AS book,
    (SELECT o.payload FROM btc_market_records r JOIN btc_retention_objects o USING(object_id)
     WHERE r.kind='capture' AND r.received_at <= $1 ORDER BY r.received_at DESC,r.object_id LIMIT 1) AS capture`,
      [asOf],
    )
  ).rows[0]!;
  return row;
}
