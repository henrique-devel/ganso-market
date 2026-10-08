import {
  requireJev,
  type JevScope,
  type JevLedgerEvent,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { jevCosts, type JevCostRequest } from "./jev-costs.js";
import { money, ratio, utc, requireMetric } from "../trading/metrics.js";
import {
  projectFinancials,
  valueFinancials,
  type ValuationMarket,
} from "../trading/valuation.js";
import {
  replayJevLedger,
  jevScope,
  type JevLedgerIdentity,
} from "./jev-ledger.js";
import { loadJevAccountTx } from "./jev-store.js";
import { readValuationMarketTx } from "./valuationstore.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { makeJevEvidence, storeJevEvidenceTx } from "./jev-evidence.js";
import { jevHash } from "./jev-hash.js";
import { indexJevResultTx } from "./jev-benchmarkstore.js";
import { currentBudgetMs } from "../budgets.js";

export const JEV_METRICS_VERSION = "jev.metrics.v1" as const;
export const JEV_METRICS_LIMIT = 20000;
type Costs = ReturnType<typeof jevCosts>;
/** Same valuation/remainder arithmetic as risk. Only trading equity is used
 * for risk; JEV is deducted exclusively in economic results. */
export function jevAccountMetrics(
  identity: JevLedgerIdentity,
  events: readonly JevLedgerEvent[],
  market: ValuationMarket,
  costs: Costs,
  funding_complete: boolean,
  cost_origin: "real" | "mock" = "real",
) {
  utc(market.as_of);
  requireMetric(identity.account.mode !== "live", "JEV_LIVE_UNFUNDED");
  requireMetric(
    events.length <= JEV_METRICS_LIMIT &&
      events.every(
        (e) => e.recorded_at <= market.as_of && e.occurred_at <= market.as_of,
      ),
    "JEV_CUT",
  );
  const projection = replayJevLedger(identity, events);
  const scope = jevScope(identity.bindings[0]!.binding, identity.instrument);
  requireMetric(
    costs.window.end_at === market.as_of &&
      costs.schema_version === "jev.evaluation-costs.v1" &&
      ["owner_id", "account_id", "profile_id", "profile_version"].every(
        (k) =>
          costs.scope[k as keyof typeof costs.scope] ===
          scope[k as keyof typeof costs.scope],
      ),
    "JEV_COST_CUT",
  );
  const financialEvents = events.map((e) => {
    const p = e.payload;
    switch (p.event_type) {
      case "cash":
      case "fill":
      case "fee":
      case "funding":
      case "liquidation":
        return { sequence: e.sequence, payload: p };
      default:
        throw new Error("BTC_METRICS_JEV_EVENT");
    }
  });
  const finance = valueFinancials(
    projectFinancials(
      { ...projection, scope: { ...scope, mode: "paper" } },
      financialEvents,
    ),
    market,
  );
  const realized = money(finance.realized_pnl_usd_raw),
    feeDelta = money(finance.fees_usd_raw),
    funding = money(finance.funding_usd_raw);
  const open = finance.maintenance.unrealized_pnl_usd_raw;
  const trading =
    open !== null && funding_complete
      ? realized + feeDelta + funding + money(open)
      : null;
  const jev = costs.evaluation.jev_usd6;
  const after = trading !== null && jev !== null ? trading - money(jev) : null;
  const conservative =
    open !== null && funding_complete && jev !== null
      ? realized +
        feeDelta +
        funding +
        (money(open) < 0n ? money(open) : 0n) -
        money(jev)
      : null;
  return {
    schema_version: JEV_METRICS_VERSION,
    scope,
    as_of: market.as_of,
    ledger_sequence: projection.last_sequence,
    capital_usd6: identity.account.initial_allocation.raw,
    capital_origin: identity.account.capital_origin,
    units: finance.units,
    convention:
      "lifetime_weighted_cost_signed_funding_fill_slippage_already_in_price",
    trading: {
      realized_usd6: realized.toString(),
      open_usd6: open,
      fees_usd6: (-feeDelta).toString(),
      funding_usd6: funding.toString(),
      pnl_usd6: trading?.toString() ?? null,
      funding_complete,
    },
    risk_equity_usd6: funding_complete
      ? finance.maintenance.equity_usd_raw
      : null,
    costs,
    cost_origin,
    strategy_after_jev_usd6: after?.toString() ?? null,
    conservative_result_usd6: conservative?.toString() ?? null,
    return_ppm:
      after === null
        ? null
        : ratio(after, money(identity.account.initial_allocation.raw)),
    positions: finance.positions,
    valuation: finance.maintenance,
    economic_status: conservative === null ? "unavailable" : "available",
    operational_admission: false,
  };
}
export type JevMetrics = ReturnType<typeof jevAccountMetrics>;
/** Window PnL carries the opening marked position/cost basis. Subtract its
 * full opening PnL; exclude only positive END PnL from conservative results. */
export function jevMetricsWindow(opening: JevMetrics, closing: JevMetrics) {
  requireMetric(
    jevHash(opening.scope) === jevHash(closing.scope) &&
      opening.as_of < closing.as_of &&
      BigInt(opening.ledger_sequence) <= BigInt(closing.ledger_sequence) &&
      opening.capital_usd6 === closing.capital_usd6 &&
      opening.cost_origin === closing.cost_origin &&
      opening.costs.schema_version === closing.costs.schema_version,
    "JEV_WINDOW_IDENTITY",
  );
  const ready =
    opening.economic_status === "available" &&
    closing.economic_status === "available";
  const r =
      money(closing.trading.realized_usd6) -
      money(opening.trading.realized_usd6),
    fees = money(closing.trading.fees_usd6) - money(opening.trading.fees_usd6),
    funding =
      money(closing.trading.funding_usd6) - money(opening.trading.funding_usd6);
  const cost = ready
    ? money(closing.costs.evaluation.jev_usd6!) -
      money(opening.costs.evaluation.jev_usd6!)
    : null;
  const conservative = ready
    ? r -
      fees +
      funding +
      (money(closing.trading.open_usd6!) < 0n
        ? money(closing.trading.open_usd6!)
        : 0n) -
      money(opening.trading.open_usd6!) -
      cost!
    : null;
  return {
    schema_version: "jev.metrics-window.v1",
    scope: closing.scope,
    window: { start_at: opening.as_of, end_at: closing.as_of },
    capital_usd6: closing.capital_usd6,
    trading_pnl_usd6: ready
      ? (
          money(closing.trading.pnl_usd6!) - money(opening.trading.pnl_usd6!)
        ).toString()
      : null,
    strategy_after_jev_usd6: ready
      ? (
          money(closing.strategy_after_jev_usd6!) -
          money(opening.strategy_after_jev_usd6!)
        ).toString()
      : null,
    conservative_result_usd6: conservative?.toString() ?? null,
    jev_usd6: cost?.toString() ?? null,
    convention:
      "carry_opening_mark_and_lifetime_basis_exclude_positive_end_open_pnl",
    summable_across_accounts: false,
  };
}
export async function readJevCostsTx(
  tx: SqlExecutor,
  scope: JevScope,
  origin: "real" | "mock",
  end: string,
) {
  // One row per request; participants aggregated before the outer join. A
  // missing result stays unknown even when a reservation was never sent.
  const rows = (
    await tx.query<JevCostRequest>(
      `
    SELECT r.request_id,r.purpose,r.started_at,s.cost_usd6::text,r.batch->>'proposal_id' AS proposal_id,
      (SELECT jsonb_agg(jsonb_build_object('owner_id',p.owner_id,'account_id',p.account_id,'profile_id',p.profile_id,'profile_version',p.profile_version) ORDER BY p.account_id)
       FROM jev_decision_participants p WHERE p.origin=r.origin AND p.request_id=r.request_id) AS participants
    FROM jev_decision_requests r LEFT JOIN jev_decision_results s USING(origin,request_id)
    WHERE r.origin=$1 AND r.started_at<$2 AND EXISTS(SELECT 1 FROM jev_decision_participants p WHERE p.origin=r.origin AND p.request_id=r.request_id AND p.owner_id=$3)
    ORDER BY r.started_at,r.request_id LIMIT 20001`,
      [origin, end, scope.owner_id],
    )
  ).rows;
  requireMetric(rows.length <= JEV_METRICS_LIMIT, "JEV_COST_LIMIT");
  return jevCosts(
    rows.map((r) => ({
      ...r,
      started_at: new Date(r.started_at).toISOString(),
    })),
    scope,
    { start_at: "1970-01-01T00:00:00.000Z", end_at: end },
  );
}
async function evaluateJevMetricsTx(
  tx: SqlExecutor,
  owner: string,
  account: string,
  origin: "real" | "mock",
) {
  const ledger = await loadJevAccountTx(
    tx,
    owner,
    account,
    false,
    JEV_METRICS_LIMIT,
  );
  const at = (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
  const s = jevScope(
    ledger.identity.bindings[0]!.binding,
    ledger.identity.instrument,
  );
  const reconciliation = (
    await tx.query<{ ledger_sequence: string; funding_through_at: Date }>(
      "SELECT ledger_sequence::text,funding_through_at FROM jev_risk_reconciliations WHERE account_id=$1 ORDER BY recorded_at DESC,operation_id DESC LIMIT 1",
      [account],
    )
  ).rows[0];
  const fundingComplete =
    !ledger.events.some((e) => e.payload.event_type === "fill") ||
    (!!reconciliation &&
      reconciliation.ledger_sequence === ledger.projection.last_sequence &&
      reconciliation.funding_through_at.getTime() >=
        Math.floor(utc(at) / 3600000) * 3600000);
  const market = { as_of: at, ...(await readValuationMarketTx(tx, at)) };
  return {
    market,
    result: jevAccountMetrics(
      ledger.identity,
      ledger.events,
      market,
      await readJevCostsTx(tx, s, origin, at),
      fundingComplete,
      origin,
    ),
  };
}
export async function readJevMetricsTx(
  tx: SqlExecutor,
  owner: string,
  account: string,
  origin: "real" | "mock",
) {
  return (await evaluateJevMetricsTx(tx, owner, account, origin)).result;
}
export async function readJevMetrics(
  pool: Pick<DatabasePool, "readOnly">,
  owner: string,
  account: string,
  origin: "real" | "mock" = "real",
) {
  return pool.readOnly(currentBudgetMs() ?? 4000, async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return readJevMetricsTx(tx, owner, account, origin);
  });
}
/** Explicit library writer, never invoked by GET. Permanent result envelope
 * protects the valuation sources. Charts and cards consume this same cut. */
export async function captureJevMetrics(
  pool: Pick<DatabasePool, "transaction">,
  owner: string,
  account: string,
  operation: string,
  origin: "real" | "mock" = "real",
) {
  requireMetric(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(operation),
    "JEV_RESULT_ID",
  );
  return withBtcRetentionTransaction(pool, async (tx) => {
    const id = `jev-metrics:${account}:${operation}`;
    const old = (
      await tx.query<{
        envelope: { scope: JevScope; payload: { original: JevMetrics } };
      }>("SELECT envelope FROM jev_evidence_objects WHERE object_id=$1", [id])
    ).rows[0];
    if (old) {
      requireJev(
        old.envelope.scope.owner_id === owner &&
          old.envelope.scope.account_id === account &&
          old.envelope.payload.original.cost_origin === origin,
        "METRICS_OWNER",
      );
      return old.envelope.payload.original;
    }
    const { result, market } = await evaluateJevMetricsTx(
      tx,
      owner,
      account,
      origin,
    );
    await storeJevEvidenceTx(
      tx,
      makeJevEvidence({
        object_id: id,
        scope: result.scope,
        kind: "result",
        recorded_at: result.as_of,
        payload: { artifact_id: id, original: result, inputs: { market } },
        dependencies: [],
        sources: [market.context?.object_id, market.book?.object_id].filter(
          (v): v is string => !!v,
        ),
      }),
    );
    await indexJevResultTx(
      tx,
      result.scope,
      "metrics",
      id,
      operation,
      jevHash({ owner, account, operation, origin }),
      result.as_of,
    );
    return result;
  });
}
