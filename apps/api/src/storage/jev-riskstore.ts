import { jevFundingEvidenceReadyTx } from "./jev-funding-status.js";
import { randomUUID } from "node:crypto";
import {
  assertJevOwnership,
  type TradingInstrumentMetadata,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import { projectFinancials, valueFinancials } from "../trading/valuation.js";
import {
  jevRiskCheckpoint,
  jevRiskCheck,
  riskTime,
  type JevRiskCheckpoint,
} from "../trading/jev-risk.js";
import { assertEvidenceJson } from "../trading/retention.js";
import { loadJevAccountTx } from "./jev-store.js";
import { replayJevLedger, jevScope } from "./jev-ledger.js";
import { readValuationMarketTx } from "./valuationstore.js";
import { jevHash } from "./jev-hash.js";
import {
  sizeJevEntry,
  jevSizedOrder,
  type JevEntryPlan,
  type JevSizingInput,
} from "./jev-sizing.js";
import { readJevPilotTx } from "./jev-pilotstore.js";
import type { JevManifest } from "./jev-manifest.js";
type Store = Pick<DatabasePool, "transaction">;
export const jevRiskClock = async (tx: SqlExecutor) =>
  (
    await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
  ).rows[0]!.now.toISOString();
export async function readJevRiskTx(
  tx: SqlExecutor,
  id: string,
): Promise<JevRiskCheckpoint | null> {
  return (
    (
      await tx.query<{ checkpoint: JevRiskCheckpoint }>(
        "SELECT checkpoint FROM jev_risk_events WHERE account_id=$1 ORDER BY sequence DESC LIMIT 1",
        [id],
      )
    ).rows[0]?.checkpoint ?? null
  );
}
export async function readJevEntriesTx(tx: SqlExecutor, id: string) {
  return (
    await tx.query<{
      plan: JevEntryPlan;
      plan_hash: string;
      status: "reserved" | "cancel_requested" | "released";
      order_id: string;
    }>(
      "SELECT DISTINCT ON(order_id) plan,plan_hash,status,order_id FROM jev_entry_events WHERE account_id=$1 ORDER BY order_id,sequence DESC",
      [id],
    )
  ).rows;
}
export async function jevEntryEventTx(
  tx: SqlExecutor,
  plan: JevEntryPlan,
  status: string,
  operation: string,
) {
  const s = plan.input.scope;
  await tx.query(
    `INSERT INTO jev_entry_events(account_id,owner_id,mode,profile_id,profile_version,experiment_id,sequence,operation_id,order_id,status,plan_hash,plan)
    SELECT $1,$2,$3,$4,$5,$6,COALESCE(MAX(sequence),0)+1,$7,$8,$9,$10,$11::jsonb FROM jev_entry_events WHERE account_id=$1`,
    [
      s.account_id,
      s.owner_id,
      s.mode,
      s.profile_id,
      s.profile_version,
      s.experiment_id,
      operation,
      plan.input.order_id,
      status,
      jevHash(plan),
      JSON.stringify(plan),
    ],
  );
}
/** Same jev_accounts row lock as fills/fees/funding and pilot commands. A pause
 * requests cancellation without pretending the venue has acknowledged it. */
export async function cancelJevEntriesTx(tx: SqlExecutor, id: string) {
  for (const entry of await readJevEntriesTx(tx, id))
    if (entry.status === "reserved")
      await jevEntryEventTx(
        tx,
        entry.plan,
        "cancel_requested",
        `risk-cancel:${randomUUID()}`,
      );
}
function financial(ledger: Awaited<ReturnType<typeof loadJevAccountTx>>) {
  const s = jevScope(
    ledger.identity.bindings[0]!.binding,
    ledger.identity.instrument,
  );
  const events = ledger.events.map((e) => {
    const p = e.payload;
    switch (p.event_type) {
      case "cash":
      case "fill":
      case "fee":
      case "funding":
      case "liquidation":
        return { sequence: e.sequence, payload: p };
      default:
        throw new Error("JEV_RISK_UNSUPPORTED_FINANCIAL_EVENT");
    }
  });
  return projectFinancials(
    { ...ledger.projection, scope: { ...s, mode: "paper" } },
    events,
  );
}
/** Caller must hold the financial account row; no caller-supplied equity/caps.
 * Raw market originals are copied into the permanent risk journal. */
export async function observeJevRiskTx(
  tx: SqlExecutor,
  owner: string,
  id: string,
) {
  const ledger = await loadJevAccountTx(tx, owner, id, true),
    now = await jevRiskClock(tx),
    previous = await readJevRiskTx(tx, id);
  jevRiskCheck(
    ledger.identity.account.mode !== "live",
    "LIVE_REQUIRES_VENUE_RECONCILIATION",
  );
  jevRiskCheck(
    ledger.events.every((e) => e.occurred_at <= now && e.recorded_at <= now),
    "FUTURE_LEDGER",
  );
  const market = { as_of: now, ...(await readValuationMarketTx(tx, now)) },
    finance = valueFinancials(financial(ledger), market);
  const flat = finance.positions.every((p) => p.quantity_btc_raw === "0"),
    boundary = now.slice(0, 10) + "T00:00:00.000Z";
  let anchor: string | null =
    previous?.day === now.slice(0, 10) ? previous.daily_anchor_usd_raw : null;
  if (previous?.day !== now.slice(0, 10)) {
    const history = ledger.events.filter(
      (e) => e.recorded_at < boundary && e.occurred_at < boundary,
    );
    if (!history.length)
      anchor =
        ledger.events.every((e) => e.payload.event_type === "cash") ||
        ledger.identity.account.started_at >= boundary
          ? ledger.identity.account.initial_allocation.raw
          : null;
    else {
      const projection = replayJevLedger(ledger.identity, history),
        atBoundary = { ...ledger, events: history, projection };
      const value = valueFinancials(financial(atBoundary), {
        as_of: boundary,
        ...(await readValuationMarketTx(tx, boundary)),
      });
      anchor =
        value.positions.every((p) => p.quantity_btc_raw === "0") ||
        value.maintenance.usable_for_risk
          ? value.maintenance.equity_usd_raw
          : null;
    }
  }
  const reconciliations = (
    await tx.query<{
      ledger_sequence: string;
      observed_at: Date;
      funding_through_at: Date;
    }>(
      "SELECT ledger_sequence::text,observed_at,funding_through_at FROM jev_risk_reconciliations WHERE account_id=$1 ORDER BY recorded_at DESC,operation_id DESC LIMIT 1",
      [id],
    )
  ).rows[0];
  const reconciled =
    (await jevFundingEvidenceReadyTx(tx, id, ledger.events, now)) &&
    !!reconciliations &&
    reconciliations.ledger_sequence === ledger.projection.last_sequence &&
    riskTime(now) - reconciliations.observed_at.getTime() <= 2000 &&
    (flat ||
      reconciliations.funding_through_at.getTime() >=
        Math.floor(riskTime(now) / 3600000) * 3600000);
  const checkpoint = jevRiskCheckpoint({
    previous,
    now_at: now,
    ledger_sequence: ledger.projection.last_sequence,
    equity_usd_raw:
      flat || finance.maintenance.usable_for_risk
        ? finance.maintenance.equity_usd_raw
        : null,
    daily_anchor_usd_raw: anchor,
    initial_equity_usd_raw: ledger.identity.account.initial_allocation.raw,
    history_complete:
      previous?.history_complete ??
      ledger.events.every((e) => e.payload.event_type === "cash"),
    fresh:
      finance.maintenance.usable_for_risk &&
      finance.closing.quality === "fresh",
    reconciled,
    flat,
    global_blocked: false,
  });
  await tx.query(
    `INSERT INTO jev_risk_events(account_id,sequence,operation_id,checkpoint,evidence) SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3::jsonb,$4::jsonb FROM jev_risk_events WHERE account_id=$1`,
    [
      id,
      `observe:${randomUUID()}`,
      JSON.stringify(checkpoint),
      JSON.stringify({
        market,
        finance,
        reconciliations: reconciliations ?? null,
      }),
    ],
  );
  if (checkpoint.cancel_entries) await cancelJevEntriesTx(tx, id);
  return { checkpoint, ledger, finance };
}
export async function observeJevRisk(pool: Store, owner: string, id: string) {
  return pool.transaction((tx) => observeJevRiskTx(tx, owner, id));
}
/** Reconciliation is a separate evidence boundary for the future runtime. It
 * cannot change money or HWM and is invalidated by every financial sequence. */
export async function reconcileJevRisk(
  pool: Store,
  owner: string,
  id: string,
  input: {
    operation_id: string;
    ledger_sequence: string;
    observed_at: string;
    funding_through_at: string;
    evidence: unknown;
  },
) {
  assertEvidenceJson(input);
  const request = structuredClone(input);
  return pool.transaction(async (tx) => {
    const ledger = await loadJevAccountTx(tx, owner, id, true),
      now = await jevRiskClock(tx);
    jevRiskCheck(
      request.ledger_sequence === ledger.projection.last_sequence &&
        riskTime(request.observed_at) <= riskTime(now) &&
        riskTime(now) - riskTime(request.observed_at) <= 2000 &&
        riskTime(request.funding_through_at) <= riskTime(request.observed_at),
      "RECONCILIATION_STALE",
    );
    await tx.query(
      "INSERT INTO jev_risk_reconciliations(account_id,operation_id,ledger_sequence,observed_at,funding_through_at,request) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING",
      [
        id,
        request.operation_id,
        request.ledger_sequence,
        request.observed_at,
        request.funding_through_at,
        JSON.stringify(request),
      ],
    );
    const old = (
      await tx.query(
        "SELECT request FROM jev_risk_reconciliations WHERE account_id=$1 AND operation_id=$2",
        [id, request.operation_id],
      )
    ).rows[0];
    jevRiskCheck(
      jevHash(old?.request) === jevHash(request),
      "IDEMPOTENCY_COLLISION",
    );
    return observeJevRiskTx(tx, owner, id);
  });
}
/** Persistent reservation only, no execution/admission. Runtime JE06 consumes
 * the immutable order generated here and must reconcile cancellation first. */
export type JevReservationResult =
  | {
      status: "refused";
      checkpoint: JevRiskCheckpoint;
      reason?: string;
      plan?: never;
      order?: never;
    }
  | {
      status: "reserved" | "cancel_requested" | "released";
      plan: JevEntryPlan;
      order?: ReturnType<typeof jevSizedOrder>;
    };
export async function reserveJevEntry(
  pool: Store,
  m: JevManifest,
  metadata: TradingInstrumentMetadata,
  input: JevSizingInput,
): Promise<JevReservationResult> {
  assertEvidenceJson({ m, metadata, input });
  const request = structuredClone(input),
    manifest = structuredClone(m),
    meta = structuredClone(metadata);
  return pool.transaction(async (tx) => {
    const { scope: s } = request,
      ledger = await loadJevAccountTx(tx, s.owner_id, s.account_id, true),
      pair = ledger.identity.bindings.find(
        (b) => b.binding.experiment_id === s.experiment_id,
      );
    jevRiskCheck(pair, "BINDING");
    assertJevOwnership(
      s,
      pair.binding,
      ledger.identity.account,
      pair.profile,
      jevScope(pair.binding, ledger.identity.instrument),
    );
    jevRiskCheck(pair.profile.manifest_hash === jevHash(manifest), "MANIFEST");
    const existing = await readJevEntriesTx(tx, s.account_id),
      old = existing.find((e) => e.order_id === request.order_id);
    if (old) {
      jevRiskCheck(
        jevHash(old.plan.input) === jevHash(request),
        "IDEMPOTENCY_COLLISION",
      );
      if (s.mode !== "live")
        await observeJevRiskTx(tx, s.owner_id, s.account_id);
      const current = (await readJevEntriesTx(tx, s.account_id)).find(
        (e) => e.order_id === request.order_id,
      )!;
      return {
        plan: current.plan,
        status: current.status,
        ...(current.status === "reserved"
          ? { order: jevSizedOrder(current.plan, current.plan_hash) }
          : {}),
      };
    }
    // Live valuation is intentionally not synthesized from the unfunded v2 ledger.
    if (s.mode === "live") {
      const pilot = await readJevPilotTx(tx, s.account_id);
      jevRiskCheck(pilot && !pilot.checkpoint.global_blocked, "GLOBAL_BLOCK");
      throw new Error("JEV_RISK_LIVE_EXECUTION_NOT_ADMITTED");
    }
    const observed = await observeJevRiskTx(tx, s.owner_id, s.account_id);
    // Return refusals, so observed pauses/cancel requests commit instead of rolling back.
    if (observed.checkpoint.entries_paused)
      return { status: "refused" as const, checkpoint: observed.checkpoint };
    if (
      !observed.finance.positions.every((p) => p.quantity_btc_raw === "0") ||
      existing.some((e) => e.status !== "released")
    )
      return {
        status: "refused" as const,
        checkpoint: observed.checkpoint,
        reason: "NO_PYRAMID_OR_REVERSE",
      };
    const now = observed.checkpoint.observed_at;
    if (
      riskTime(now) < riskTime(request.decision_at) ||
      riskTime(now) - riskTime(request.decision_at) >
        manifest.freshness.decision_ttl_ms
    )
      return {
        status: "refused" as const,
        checkpoint: observed.checkpoint,
        reason: "DECISION_STALE",
      };
    let plan: JevEntryPlan;
    try {
      plan = sizeJevEntry(
        manifest,
        meta,
        request,
        observed.checkpoint.equity_usd_raw!,
      );
    } catch (error) {
      return {
        status: "refused" as const,
        checkpoint: observed.checkpoint,
        reason: error instanceof Error ? error.message : "SIZING_REFUSED",
      };
    }
    await jevEntryEventTx(tx, plan, "reserved", `reserve:${request.order_id}`);
    return {
      status: "reserved" as const,
      plan,
      order: jevSizedOrder(plan, jevHash(plan)),
    };
  });
}
/** Reduce-only paths always remain available, even when fresh valuation or JEV
 * is unavailable. Actual liquidity/fill confirmation belongs to JE06. */
export async function requestJevReduction(
  pool: Store,
  owner: string,
  id: string,
) {
  return pool.transaction(async (tx) => {
    const result = await observeJevRiskTx(tx, owner, id);
    await cancelJevEntriesTx(tx, id);
    return {
      reduce_only: true as const,
      time_in_force: "IOC" as const,
      positions: result.finance.positions.filter(
        (p) => p.quantity_btc_raw !== "0",
      ),
      checkpoint: result.checkpoint,
    };
  });
}
