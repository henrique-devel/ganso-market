import { randomUUID } from "node:crypto";
import type { TradingScope } from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { canonicalFingerprint } from "../trading/replay.js";
import { assertEvidenceJson } from "../trading/retention.js";
import { replayLedger } from "../trading/ledger.js";
import { projectFinancials, valueFinancials } from "../trading/valuation.js";
import {
  release,
  type Reservation,
  type ReservationOrder,
} from "../trading/reservations.js";
import {
  RISK_POLICY,
  RiskRefusal,
  requireRisk,
  riskCheckpoint,
  grossExposure,
  plannedRisk,
  requireRiskCaps,
  type RiskCheckpoint,
} from "../trading/risk.js";
import { lockableLedgerAccountTx, readLedgerAccountTx } from "./ledgerstore.js";
import {
  readValuationMarketTx,
  readIsolatedMarginTx,
} from "./valuationstore.js";
import { readFundingCoverageTx } from "./fundingstore.js";
import { recoveryTransaction } from "./recoverystore.js";

const clock = async (tx: SqlExecutor) =>
  (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
export async function readRiskTx(tx: SqlExecutor, accountId: string) {
  return (
    (
      await tx.query<{ checkpoint: RiskCheckpoint }>(
        "SELECT checkpoint FROM btc_risk_events WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1",
        [accountId],
      )
    ).rows[0]?.checkpoint ?? null
  );
}
async function ordersTx(tx: SqlExecutor, id: string): Promise<Reservation[]> {
  return (
    await tx.query<{ reservation: Reservation }>(
      "SELECT DISTINCT ON (order_id) reservation FROM btc_reservation_events WHERE account_id=$1 ORDER BY order_id,sequence DESC",
      [id],
    )
  ).rows.map((r) => r.reservation);
}
async function journal(
  tx: SqlExecutor,
  id: string,
  checkpoint: RiskCheckpoint,
  evidence: unknown,
  request = {
    operation_id: `observe:${randomUUID()}`,
    action: "observe",
    reason: "effective_boundary",
  },
) {
  await tx.query(
    `INSERT INTO btc_risk_events(account_id,sequence,operation_id,request,checkpoint,evidence)
    SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3::jsonb,$4::jsonb,$5::jsonb FROM btc_risk_events WHERE account_id=$1`,
    [
      id,
      request.operation_id,
      JSON.stringify(request),
      JSON.stringify(checkpoint),
      JSON.stringify(evidence),
    ],
  );
}
async function cancelIncreases(tx: SqlExecutor, id: string, now: string) {
  for (const r of await ordersTx(tx, id)) {
    if (r.status !== "active" || r.order.intent !== "open") continue;
    const request = {
      action: "release",
      operation_id: `risk:${randomUUID()}`,
      order_id: r.order.order_id,
      reason: "cancelled",
    };
    await tx.query(
      `INSERT INTO btc_reservation_events(account_id,sequence,operation_id,order_id,action,request,reservation,ledger_transaction_id,recorded_at)
      SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3,'release',$4::jsonb,$5::jsonb,NULL,$6 FROM btc_reservation_events WHERE account_id=$1`,
      [
        id,
        request.operation_id,
        r.order.order_id,
        JSON.stringify(request),
        JSON.stringify(release(r, "cancelled")),
        now,
      ],
    );
  }
}
const fresh = (
  now: string,
  source: string | null,
  received: string | null,
  age: number,
) =>
  source !== null &&
  received !== null &&
  Date.parse(now) - Date.parse(source) >= 0 &&
  Date.parse(now) - Date.parse(source) <= age &&
  Date.parse(now) - Date.parse(received) >= 0 &&
  Date.parse(now) - Date.parse(received) <= age;

/** Called only after the account lock. UTC midnight uses the ledger known at
 * that boundary and actual retained mark evidence. A missing open-position
 * midnight mark blocks entries; a later mark is never relabelled as midnight.
 * HWM is the maximum observed by this deterministic risk library, not a claim
 * of continuous monitoring. S10 must call observe on the risk cycle. */
export async function observeRiskTx(tx: SqlExecutor, scope: TradingScope) {
  const now = await clock(tx),
    previous = await readRiskTx(tx, scope.account_id);
  const ledger = await readLedgerAccountTx(tx, scope);
  requireRisk(
    !ledger.events.some((e) => e.occurred_at > now || e.recorded_at > now),
    "FUTURE_LEDGER",
  );
  const market = { as_of: now, ...(await readValuationMarketTx(tx, now)) };
  const finance = valueFinancials(
    projectFinancials(ledger.projection, ledger.events),
    market,
  );
  const funding = await readFundingCoverageTx(
    tx,
    scope.account_id,
    ledger.events,
    now,
  );
  const markFresh =
    finance.maintenance.usable_for_risk &&
    fresh(
      now,
      finance.maintenance.source_timestamp,
      finance.maintenance.received_at,
      RISK_POLICY.mark_age_ms,
    );
  const bookFresh =
    finance.closing.quality === "fresh" &&
    fresh(
      now,
      finance.closing.source_timestamp,
      finance.closing.received_at,
      RISK_POLICY.book_age_ms,
    );
  const external = ledger.events.reduce(
    (n, e) =>
      n +
      (e.payload.event_type === "cash" &&
      e.payload.reason !== "initial_allocation"
        ? BigInt(e.payload.delta.raw)
        : 0n),
    0n,
  );
  const boundary = now.slice(0, 10) + "T00:00:00.000Z";
  let daily =
    previous?.day === now.slice(0, 10) ? previous.daily_anchor_usd_raw : null;
  if (previous?.day !== now.slice(0, 10)) {
    const history = ledger.events.filter(
      (e) => e.occurred_at < boundary && e.recorded_at < boundary,
    );
    // Genesis may have an old economic date but be created today. Its initial
    // allocation is the first-day anchor; other late events remain today's PnL.
    if (!history.length) daily = "1000000000";
    else {
      const projection = replayLedger(ledger.identity, history);
      const value = valueFinancials(projectFinancials(projection, history), {
        as_of: boundary,
        ...(await readValuationMarketTx(tx, boundary)),
      });
      daily =
        value.positions.every((p) => p.quantity_btc_raw === "0") ||
        (value.maintenance.usable_for_risk &&
          fresh(
            boundary,
            value.maintenance.source_timestamp,
            value.maintenance.received_at,
            RISK_POLICY.mark_age_ms,
          ))
          ? value.maintenance.equity_usd_raw
          : null;
    }
  }
  const checkpoint = riskCheckpoint({
    previous,
    now,
    equity:
      markFresh || finance.positions.every((p) => p.quantity_btc_raw === "0")
        ? finance.maintenance.equity_usd_raw
        : null,
    external: external.toString(),
    initial_anchor: (1000000000n + external).toString(),
    daily_anchor:
      previous === null &&
      ledger.events.every((e) => e.payload.event_type === "cash")
        ? (1000000000n + external).toString()
        : daily,
    sequence: ledger.projection.last_sequence,
    usable: markFresh && bookFresh && funding.usable_for_risk,
    accounting: true,
    history_complete: ledger.events.every(
      (e) => e.payload.event_type === "cash",
    ),
  });
  if (checkpoint.equity_usd_raw !== null && markFresh) {
    const exposure = grossExposure(
      finance.positions,
      finance.maintenance.mark_price!.raw,
      await ordersTx(tx, scope.account_id),
    );
    if (
      exposure * 10000n >
      BigInt(checkpoint.equity_usd_raw) * BigInt(RISK_POLICY.exposure_bps)
    ) {
      checkpoint.reasons.push("exposure_limit");
      if (checkpoint.state === "NORMAL") checkpoint.state = "REDUCE_ONLY";
    }
  }
  const evidence = { policy: RISK_POLICY, finance, funding, market };
  await journal(tx, scope.account_id, checkpoint, evidence);
  if (checkpoint.state !== "NORMAL")
    await cancelIncreases(tx, scope.account_id, now);
  return { checkpoint, finance, funding, market, markFresh, bookFresh, ledger };
}

/** No caller-supplied equity, freshness, caps, source exemption or enable flag.
 * A partial fill replaces its remaining hold in post-fill checking. */
export async function guardRiskOrderTx(
  tx: SqlExecutor,
  scope: TradingScope,
  order: ReservationOrder,
  accepting: boolean,
  consuming = false,
) {
  const observed = await observeRiskTx(tx, scope),
    { checkpoint, finance, bookFresh, ledger, market } = observed;
  if (order.intent === "reduce") {
    requireRisk(checkpoint.state !== "HALTED", "HALTED");
    if (consuming) requireRisk(bookFresh, "EXIT_BOOK_UNAVAILABLE");
    // A reduction must not be followed by the unfilled tail of an old entry.
    if (accepting)
      await cancelIncreases(tx, scope.account_id, checkpoint.observed_at);
    return observed;
  }
  requireRisk(checkpoint.state === "NORMAL", checkpoint.state);
  const pending = await ordersTx(tx, scope.account_id);
  if (accepting) {
    requireRisk(
      finance.positions.every((p) => p.quantity_btc_raw === "0") &&
        !pending.some(
          (r) => r.status === "active" && r.order.intent === "open",
        ),
      "NO_PYRAMIDING",
    );
  } else {
    requireRisk(
      finance.positions.every(
        (p) =>
          p.quantity_btc_raw === "0" || p.position_id === order.position_id,
      ),
      "SINGLE_POSITION",
    );
    requireRisk(
      pending.some(
        (r) => r.status === "active" && r.order.order_id === order.order_id,
      ),
      "ORDER_CANCELLED",
    );
  }
  const { metadata } = await readIsolatedMarginTx(tx, ledger, market);
  requireRisk(!!metadata, "FEE_METADATA_UNAVAILABLE");
  const rate = metadata.payload.fees.taker;
  requireRisk(
    rate.unit === "RATE" &&
      rate.decimals === 9 &&
      /^(0|[1-9][0-9]{0,8})$/.test(rate.raw),
    "FEE_METADATA_UNAVAILABLE",
  );
  const minimumBps = Number((BigInt(rate.raw) + 99999n) / 100000n);
  const risk = plannedRisk(order, minimumBps);
  const candidates = accepting
    ? [
        ...pending,
        {
          order,
          status: "active" as const,
          remaining_btc_raw: order.quantity_btc_raw,
          margin_usd_raw: "0",
          fee_usd_raw: "0",
        },
      ]
    : pending;
  requireRiskCaps(
    finance.maintenance.equity_usd_raw!,
    grossExposure(
      finance.positions,
      finance.maintenance.mark_price!.raw,
      candidates,
    ),
    risk,
  );
  return observed;
}

/** Preserve real pauses/cancellations when a speculative command is refused.
 * Only RiskRefusal is committed; SQL/ledger failures roll back the whole unit.
 * Retention precedes the single owner lock for broker adapters. */
export async function riskTransaction<T>(
  pool: Pick<DatabasePool, "transaction">,
  scope: TradingScope,
  run: (tx: SqlExecutor) => Promise<T>,
  retention = false,
): Promise<T> {
  const execute = async (tx: SqlExecutor) => {
    await lockableLedgerAccountTx(tx, scope, true);
    await tx.query("SAVEPOINT risk_command");
    try {
      return { value: await run(tx) };
    } catch (error) {
      const inconsistent =
        error instanceof Error &&
        error.message === "BTC_LEDGER_PROJECTION_MISMATCH";
      if (!(error instanceof RiskRefusal) && !inconsistent) throw error;
      await tx.query("ROLLBACK TO SAVEPOINT risk_command");
      if (inconsistent) {
        const now = await clock(tx),
          prior = await readRiskTx(tx, scope.account_id);
        const checkpoint: RiskCheckpoint = {
          ...(prior ?? {
            version: RISK_POLICY.version,
            history_complete: false,
            day: now.slice(0, 10),
            daily_anchor_usd_raw: null,
            high_water_usd_raw: "1000000000",
            external_cash_usd_raw: "0",
            equity_usd_raw: null,
            ledger_sequence: "0",
            observed_at: now,
            state: "HALTED",
            reasons: [],
          }),
          state: "HALTED",
          reasons: ["accounting_inconsistent"],
          observed_at: now,
        };
        await journal(tx, scope.account_id, checkpoint, {
          policy: RISK_POLICY,
          error: "BTC_LEDGER_PROJECTION_MISMATCH",
        });
        await cancelIncreases(tx, scope.account_id, now);
      } else await observeRiskTx(tx, scope);
      return { error };
    }
  };
  const result = await recoveryTransaction(pool, scope, execute, retention);
  if (result.error) throw result.error;
  return result.value as T;
}
export interface RiskCommand {
  operation_id: string;
  action: "observe" | "reduce_only" | "halt" | "rearm";
  reason: string;
}
/** Explicit internal operator action; no HTTP surface or poller in S8. A retry
 * never re-evaluates/rearms under a reused operation ID. No anchor reset API. */
export async function applyRisk(
  pool: Pick<DatabasePool, "transaction">,
  scopeInput: TradingScope,
  input: RiskCommand,
) {
  assertEvidenceJson(input);
  requireRisk(
    Object.keys(input).sort().join() === "action,operation_id,reason" &&
      /^[a-zA-Z0-9:._-]{1,160}$/.test(input.operation_id) &&
      ["observe", "reduce_only", "halt", "rearm"].includes(input.action) &&
      typeof input.reason === "string" &&
      input.reason.trim().length > 0 &&
      input.reason.length <= 500,
    "COMMAND",
  );
  const request = { ...input },
    scope = { ...scopeInput };
  return riskTransaction(pool, scope, (tx) => applyRiskTx(tx, scope, request));
}
/** Caller owns the risk/recovery transaction and account lock. */
export async function applyRiskTx(
  tx: SqlExecutor,
  scope: TradingScope,
  request: RiskCommand,
) {
  const prior = (
    await tx.query<{ request: RiskCommand; checkpoint: RiskCheckpoint }>(
      "SELECT request,checkpoint FROM btc_risk_events WHERE account_id=$1 AND operation_id=$2",
      [scope.account_id, request.operation_id],
    )
  ).rows[0];
  if (prior) {
    requireRisk(
      canonicalFingerprint(prior.request) === canonicalFingerprint(request),
      "IDEMPOTENCY_COLLISION",
    );
    return prior.checkpoint;
  }
  const observed = await observeRiskTx(tx, scope),
    checkpoint = { ...observed.checkpoint };
  if (request.action === "rearm") {
    requireRisk(checkpoint.reasons.length === 0, "REARM_CONDITIONS");
    const pending = await ordersTx(tx, scope.account_id);
    requireRiskCaps(
      checkpoint.equity_usd_raw!,
      grossExposure(
        observed.finance.positions,
        observed.finance.maintenance.mark_price!.raw,
        pending,
      ),
    );
    const { isolation } = await readIsolatedMarginTx(
      tx,
      observed.ledger,
      observed.market,
    );
    requireRisk(
      isolation.metadata_valid &&
        isolation.compatible &&
        !isolation.positions.some(
          (p) => p.liquidatable || p.deficit_usd_raw !== "0",
        ),
      "REARM_MARGIN",
    );
    requireRisk(
      observed.finance.positions.filter((p) => p.quantity_btc_raw !== "0")
        .length <= 1,
      "SINGLE_POSITION",
    );
    checkpoint.state = "NORMAL";
  } else if (request.action === "halt") checkpoint.state = "HALTED";
  else if (request.action === "reduce_only" && checkpoint.state !== "HALTED")
    checkpoint.state = "REDUCE_ONLY";
  await journal(
    tx,
    scope.account_id,
    checkpoint,
    { policy: RISK_POLICY },
    request,
  );
  if (checkpoint.state !== "NORMAL")
    await cancelIncreases(tx, scope.account_id, checkpoint.observed_at);
  return checkpoint;
}

export const withRisk =
  (
    pool: Pick<DatabasePool, "transaction">,
    scope: TradingScope,
    retention = false,
  ) =>
  <T>(run: (tx: SqlExecutor) => Promise<T>) =>
    riskTransaction(pool, scope, run, retention);
