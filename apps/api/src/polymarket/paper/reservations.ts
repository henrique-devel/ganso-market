// FIN-05 / reservation-v1. Call only inside the acceptance transaction, after
// the order INSERT, in the broker's order -> token -> financial owner lock order.
// The immutable acceptance carries the reconstruction contract; migration 0025
// projects reserve/consume/release atomically with each ledger INSERT.
import type { SqlExecutor } from "../../database.js";
import { formatScaled, parseScaled, SCALE } from "../fundamental/fixed.js";
import {
  loadPortfolioConfig,
  portfolioConfigHash,
  type CapConfig,
} from "../portfolio/config.js";
import { loadOpenPositions } from "../portfolio/exitstore.js";
import {
  capHeadroomFor,
  computeExposures,
  type OpenPosition,
} from "../portfolio/exposure.js";
import {
  assignFactor,
  catalystWindow,
  factorMapHash,
  loadFactorMap,
} from "../portfolio/factors.js";
import {
  loadResolutionLexicon,
  lexiconHash,
  ruleClauseFamily,
} from "../resolution/lexicon.js";
import { financialOwnerKey, replayFinancialLedger } from "./financial.js";
import { loadAttributedLedgerEvents } from "./ownership.js";

export class ReservationRejected extends Error {}
const fail = (reason: string): never => {
  throw new ReservationRejected(reason);
};
const n = (value: unknown): bigint => {
  const result = typeof value === "string" ? parseScaled(value) : null;
  return result ?? fail("FIN05_INVALID_DECIMAL");
};
const ceil = (product: bigint, divisor = SCALE): bigint =>
  (product + divisor - 1n) / divisor;

export interface ReservationContract {
  readonly version: "reservation-v1";
  readonly account_id: string;
  readonly strategy_id: string;
  readonly ownership_version: 1;
  readonly accounting_version: "financial-v2";
  readonly risk_version: "payoff-v1";
  readonly cash_per_share: string;
  readonly risk_per_share: string;
  readonly fee_per_share: string;
  readonly price_bound: string;
  readonly inventory_side: "BUY" | "SELL" | null;
  readonly config_hash: string;
  readonly factor_map_hash: string;
  readonly lexicon_hash: string;
}

/** Rebuild under the owner lock, including after restart; no wall-clock expiry. */
export async function reconcileReservations(
  tx: SqlExecutor,
  owner: { accountId: string; strategyId: string },
): Promise<void> {
  await tx.query("SELECT paper_reconcile_reservations($1,$2)", [
    owner.accountId,
    owner.strategyId,
  ]);
}

/** The supplied caps seam is for synthetic PG fixtures; runtime loads existing configuration. */
export async function reserveOrder(
  tx: SqlExecutor,
  orderId: string,
  now: Date,
  capsOverride?: CapConfig,
): Promise<ReservationContract> {
  const rows = await tx.query(
    `SELECT o.*, a.account_id, a.strategy_id AS owner_strategy, a.attribution_status
    FROM paper_orders o JOIN paper_order_owners a USING (order_id)
    WHERE o.order_id=$1 AND a.ownership_version=1`,
    [orderId],
  );
  const order = rows.rows[0];
  if (!order || order["attribution_status"] !== "verified")
    fail("FIN05_OWNER_UNKNOWN");
  const owner = {
    accountId: String(order!["account_id"]),
    strategyId: String(order!["owner_strategy"]),
  };
  const tokenId = String(order!["token_id"]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    tokenId,
  ]);
  const capitalRows = await tx.query(
    `SELECT initial_cash_usd, capital_source_ref FROM paper_financial_owners
    WHERE account_id=$1 AND strategy_id=$2 FOR NO KEY UPDATE`,
    [owner.accountId, owner.strategyId],
  );
  const capital = capitalRows.rows[0];
  if (!capital || capital["initial_cash_usd"] === null)
    fail("FIN05_CAPITAL_UNKNOWN");
  await reconcileReservations(tx, owner);
  // An outstanding pre-contract order cannot silently compete for this cash.
  const legacy = await tx.query(
    `SELECT 1 FROM paper_orders o JOIN paper_order_owners a USING(order_id)
    WHERE a.account_id=$1 AND a.strategy_id=$2 AND a.ownership_version=1
      AND o.status='open' AND o.order_id<>$3
      AND NOT EXISTS (SELECT 1 FROM paper_order_reservations r WHERE r.order_id=o.order_id) LIMIT 1`,
    [owner.accountId, owner.strategyId, orderId],
  );
  if (legacy.rowCount) fail("FIN05_UNRESERVED_OPEN_ORDER");
  const events = await loadAttributedLedgerEvents(tx, owner);
  if (
    events.some(
      (e) =>
        (e.eventType === "fill" || e.eventType === "resolution") &&
        e.eventTs > now,
    )
  )
    fail("FIN05_FUTURE_EVENT");
  const state = replayFinancialLedger(
    events,
    [
      {
        ...owner,
        initialCashUsd: String(capital!["initial_cash_usd"]),
        capitalSourceRef: String(capital!["capital_source_ref"]),
      },
    ],
    [],
    now,
  ).owners.get(financialOwnerKey(owner.accountId, owner.strategyId))!;
  const pending = await tx.query(
    `SELECT r.*, o.token_id, o.condition_id FROM paper_order_reservations r
    JOIN paper_orders o USING(order_id) WHERE r.account_id=$1 AND r.strategy_id=$2 AND r.state='active'`,
    [owner.accountId, owner.strategyId],
  );
  const size = n(order!["size"]);
  const side = order!["side"] as "BUY" | "SELL";
  const shares = n(state.positions.get(tokenId)?.shares ?? "0");
  if (state.positions.get(tokenId)?.resolvedAt != null)
    fail("FIN05_MARKET_RESOLVED");
  const inventorySide = side === "SELL" ? "SELL" : shares < 0n ? "BUY" : null;
  if (inventorySide !== null) {
    const used = pending.rows
      .filter(
        (r) =>
          r["token_id"] === tokenId && r["inventory_side"] === inventorySide,
      )
      .reduce((sum, r) => sum + n(r["shares_remaining"]), 0n);
    const available = inventorySide === "SELL" ? shares : -shares;
    if (size + used > available) fail("FIN05_INVENTORY_UNAVAILABLE");
  }
  const price = n(order!["worst_price"] ?? order!["limit_price"]);
  const marketable =
    order!["order_type"] === "FAK" || order!["order_type"] === "FOK";
  let fee = 0n; // Existing passive paper contract: explicit zero maker fee.
  if (marketable) {
    const params = await tx.query(
      `SELECT taker_fee_bps FROM polymarket_param_versions WHERE condition_id=$1
      AND valid_from <= $2 ORDER BY valid_from DESC LIMIT 1`,
      [order!["condition_id"], now],
    );
    if (params.rows[0]?.["taker_fee_bps"] == null) fail("FIN05_FEE_UNKNOWN");
    const rateBps = n(params.rows[0]!["taker_fee_bps"]);
    if (rateBps < 0n) fail("FIN05_FEE_UNKNOWN");
    // p(1-p) <= 1/4 over every executable price. Includes rounding upward.
    fee = ceil(rateBps, 40_000n);
  }
  const cashPerShare = (side === "BUY" ? price : 0n) + fee;
  // Reductions retain the position's risk until filled; only unpaid fee is new.
  const riskPerShare = (inventorySide === null ? price : 0n) + fee;
  const cash = ceil(size * cashPerShare);
  const reserved = pending.rows.reduce(
    (sum, r) => sum + n(r["cash_remaining_usd"]),
    0n,
  );
  if (cash + reserved > n(state.cashUsd)) fail("FIN05_CASH_UNAVAILABLE");

  const [config, factorMap, lexicon] = await Promise.all([
    loadPortfolioConfig(),
    loadFactorMap(),
    loadResolutionLexicon(),
  ]);
  const caps = capsOverride ?? config.caps;
  // Join the exact same metadata as FIN-04, also for tokens with only reservations.
  const metadataPositions = new Map(state.positions);
  for (const r of [...pending.rows, order!]) {
    const token = String(r["token_id"]);
    if (n(metadataPositions.get(token)?.shares ?? "0") !== 0n) continue;
    metadataPositions.set(token, {
      tokenId: token,
      conditionId: String(r["condition_id"]),
      shares: "1",
      costBasisUsd: "0",
      feesPaidUsd: "0",
      realizedPnlUsd: "0",
      openedAt: now,
      resolvedAt: null,
      cashflowUsd: "0",
      lastEventId: "0",
      lastEventTs: now,
      markValueSignedUsd: null,
      markStale: true,
      markSourceTs: null,
      markReceivedAt: null,
      unrealizedPnlUsd: null,
    });
  }
  const metadata = await loadOpenPositions(tx, {
    ...state,
    positions: metadataPositions,
  });
  const templates = new Map(
    metadata.map((row) => [
      row.tokenId,
      {
        ...row,
        remainingFeesScaled: 0n,
        unwindCostScaled: null,
        factor: assignFactor(factorMap, row).factor,
        catalystWindow: catalystWindow(row.endDate),
        clauseFamily: ruleClauseFamily(
          {
            description: row.ruleDescription,
            resolutionSource: row.resolutionSource,
          },
          lexicon,
        ).key,
      } satisfies OpenPosition,
    ]),
  );
  const positions: OpenPosition[] = [...state.positions.values()]
    .filter((p) => n(p.shares) !== 0n)
    .map((p) => ({
      ...templates.get(p.tokenId)!,
      sharesScaled: n(p.shares),
      costScaled: n(p.costBasisUsd),
    }));
  for (const r of pending.rows)
    positions.push({
      ...templates.get(String(r["token_id"]))!,
      sharesScaled: n(r["shares_remaining"]),
      costScaled: n(r["risk_remaining_usd"]),
      feesPaidScaled: 0n,
      realizedPnlScaled: 0n,
    });
  // Same denominator as FIN-04/state: allocated C0 plus net realized PnL.
  const capitalAfterRealization =
    n(state.initialCashUsd) + n(state.realizedPnlUsd);
  const bankroll = capitalAfterRealization > 0n ? capitalAfterRealization : 0n;
  const candidate =
    templates.get(tokenId) ?? fail("FIN05_METADATA_UNAVAILABLE");
  const headroom = capHeadroomFor(
    computeExposures({ positions, bankrollScaled: bankroll, caps }),
    candidate,
    bankroll,
    caps,
  );
  const risk = ceil(size * riskPerShare);
  if (Object.values(headroom).some((value) => risk > value))
    fail("FIN05_RISK_UNAVAILABLE");
  return {
    version: "reservation-v1",
    account_id: owner.accountId,
    strategy_id: owner.strategyId,
    ownership_version: 1,
    accounting_version: "financial-v2",
    risk_version: "payoff-v1",
    cash_per_share: formatScaled(cashPerShare, 9),
    risk_per_share: formatScaled(riskPerShare, 9),
    fee_per_share: formatScaled(fee, 9),
    price_bound: formatScaled(price, 9),
    inventory_side: inventorySide,
    config_hash: portfolioConfigHash({ ...config, caps }),
    factor_map_hash: factorMapHash(factorMap),
    lexicon_hash: lexiconHash(lexicon),
  };
}
