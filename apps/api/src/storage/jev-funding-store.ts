import {
  assertJevOwnership,
  jevEventKey,
  requireJev,
  type JevScope,
  type JevLedgerEvent,
} from "@ganso-market/contracts/trading";
import type { DatabasePool, SqlExecutor } from "../database.js";
import {
  fundingPositions,
  fundingDelta,
  fundingCoverage,
  PAPER_FUNDING_MODEL,
  type FundingReceipt,
} from "../trading/funding.js";
import {
  fetchFinalBtcFunding,
  parseFinalFunding,
  fundingHour,
  FUNDING_SOURCE,
} from "../venues/hyperliquid/funding.js";
import { paperFundingOracleTx, type FundingCommand } from "./fundingstore.js";
import { withBtcRetentionTransaction } from "./btc-retention.js";
import { loadJevAccountTx, appendJevLedgerTx } from "./jev-store.js";
import { jevScope, type JevLedgerCommand } from "./jev-ledger.js";
import { jevHash } from "./jev-hash.js";
import { makeJevEvidence, storeJevEvidenceTx } from "./jev-evidence.js";
import { observeJevRiskTx, reconcileJevRisk } from "./jev-riskstore.js";
const fills = (events: readonly JevLedgerEvent[]) =>
  events.flatMap((e) =>
    e.payload.event_type === "fill"
      ? [{ occurred_at: e.occurred_at, payload: e.payload }]
      : [],
  );
type Pool = Pick<DatabasePool, "transaction" | "readOnly">;
export const JEV_FUNDING_VERSION = "jev.funding.v1";
export async function readJevFundingReceiptsTx(tx: SqlExecutor, id: string) {
  return (
    await tx.query<{ receipt: FundingReceipt }>(
      "SELECT receipt FROM jev_funding_receipts WHERE account_id=$1 ORDER BY sequence",
      [id],
    )
  ).rows.map((r) => r.receipt);
}
/** One account/hour owns its cash. A shared final observation never shares
 * positions or rounding. Stress doubles trading fees, never the funding rate.
 * Official funding and info contracts rechecked 2026-10-08; paper price fidelity
 * remains PAPER_FUNDING_MODEL, not a claimed live settlement oracle. */
export async function reconcileJevFunding(
  pool: Pick<Pool, "transaction">,
  scope: JevScope,
  input: FundingCommand,
) {
  requireJev(
    input.model_version === undefined ||
      input.model_version === PAPER_FUNDING_MODEL,
    "FUNDING_MODEL",
  );
  requireJev(
    typeof input.operation_id === "string" &&
      /^[A-Za-z0-9:._-]{1,160}$/.test(input.operation_id),
    "FUNDING_OPERATION",
  );
  const request = structuredClone(input),
    hour = fundingHour(request.period_hour);
  requireJev(scope.mode === "paper" || scope.mode === "stress", "FUNDING_MODE");
  requireJev(
    request.observation === null ||
      request.observation.source === FUNDING_SOURCE,
    "FUNDING_SOURCE",
  );
  const final = request.observation
    ? parseFinalFunding(
        request.observation.row,
        request.period_hour,
        request.observation.received_at,
        18,
      )
    : null;
  return withBtcRetentionTransaction(pool, async (tx) => {
    const l = await loadJevAccountTx(
      tx,
      scope.owner_id,
      scope.account_id,
      true,
      100000,
    );
    const binding = l.identity.bindings.find(
      (b) => b.binding.experiment_id === scope.experiment_id,
    );
    requireJev(binding, "FUNDING_BINDING");
    assertJevOwnership(
      scope,
      binding.binding,
      l.identity.account,
      binding.profile,
      jevScope(binding.binding, l.identity.instrument),
    );
    const now = (
      await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    ).rows[0]!.now.toISOString();
    requireJev(
      hour <= Date.parse(now) &&
        (!request.observation || request.observation.received_at <= now),
      "FUNDING_FUTURE",
    );
    const prior = (
      await tx.query<{ receipt: FundingReceipt }>(
        "SELECT receipt FROM jev_funding_receipts WHERE account_id=$1 AND operation_id=$2",
        [scope.account_id, request.operation_id],
      )
    ).rows[0];
    if (prior) {
      const old = (
        await tx.query<{ envelope: { payload: { request: FundingCommand } } }>(
          "SELECT envelope FROM jev_evidence_objects WHERE object_id=$1",
          [prior.receipt.evidence_id],
        )
      ).rows[0]!;
      const key = (v: FundingCommand) =>
        jevHash({
          hour: v.period_hour,
          row: v.observation?.row ?? null,
          oracle: v.oracle_object_id,
        });
      requireJev(
        key(old.envelope.payload.request) === key(request),
        "FUNDING_IDEMPOTENCY_COLLISION",
      );
      return prior.receipt;
    }
    const old = await readJevFundingReceiptsTx(tx, scope.account_id),
      rows = old.filter((r) => r.period_hour === request.period_hour),
      settled = rows.find((r) => r.status === "settled");
    const id = `jev-funding:${jevHash([scope, request.operation_id])}`;
    const result: FundingReceipt = {
      schema_version: "btc.funding.v1",
      model_version: PAPER_FUNDING_MODEL,
      period_hour: request.period_hour,
      cutoff: final?.cutoff ?? null,
      status: "pending",
      reason: "missing_final_rate",
      basis:
        final && request.observation ? jevHash(request.observation.row) : null,
      oracle_usd_raw: null,
      positions: [],
      evidence_id: id,
    };
    let oracle: Awaited<ReturnType<typeof paperFundingOracleTx>> = null;
    if (final) {
      const eligible = fundingPositions(fills(l.events), final.cutoff);
      oracle = await paperFundingOracleTx(
        tx,
        { ...scope, mode: "paper" },
        final.cutoff,
      );
      if (oracle?.object_id !== request.oracle_object_id) oracle = null;
      const payload = oracle?.payload.payload;
      result.oracle_usd_raw =
        payload?.kind === "mark_funding" ? payload.oracle_price.raw : null;
      result.rate =
        final.rate_raw === null
          ? null
          : { unit: "RATE", decimals: 18, raw: final.rate_raw };
      result.price_evidence = oracle
        ? {
            object_id: oracle.object_id,
            received_at: oracle.payload.received_at,
            receipt_age_ms:
              Date.parse(final.cutoff) - Date.parse(oracle.payload.received_at),
            source_timestamp: null,
            quality: "unknown",
            fidelity: "paper_approximation_not_venue_settlement",
          }
        : null;
      if (eligible.ambiguous.length) result.reason = "ambiguous_cutoff_order";
      else if (final.rate_raw === null) result.reason = final.precision;
      else if (eligible.positions.length && !oracle)
        result.reason = "missing_pre_cut_snapshot";
      else {
        result.positions = eligible.positions.map((p) => ({
          ...p,
          delta_usd_raw: fundingDelta(
            p.quantity_btc_raw,
            result.oracle_usd_raw ?? "0",
            final.rate_raw!,
            18,
          ),
        }));
        result.status = "settled";
        result.reason = eligible.positions.length
          ? "paper_pre_cut_snapshot"
          : "no_eligible_position";
        if (settled) {
          const basis = (r: FundingReceipt) =>
            jevHash({
              basis: r.basis,
              cutoff: r.cutoff,
              positions: r.positions,
              price: r.price_evidence,
            });
          result.status =
            basis(settled) === basis(result) ? "duplicate" : "conflict";
          result.reason =
            result.status === "duplicate"
              ? "already_settled"
              : "divergent_settlement_basis";
        }
      }
      if (
        rows.some((r) => r.status === "conflict") ||
        (settled && settled.basis !== result.basis)
      ) {
        result.status = "conflict";
        result.reason = "divergent_final_observation";
      }
    }
    await storeJevEvidenceTx(
      tx,
      makeJevEvidence({
        object_id: id,
        scope,
        kind: "funding",
        recorded_at: now,
        payload: { artifact_id: id, original: result, request },
        dependencies: [],
        sources: oracle ? [oracle.object_id] : [],
      }),
    );
    await observeJevRiskTx(tx, scope.owner_id, scope.account_id);
    if (result.status === "settled" && result.positions.length) {
      const commands: JevLedgerCommand[] = result.positions.map((p) => {
        const event_id = `funding:${jevHash([scope.account_id, request.period_hour, p.position_id])}`;
        return {
          ...scope,
          event_id,
          idempotency_key: jevEventKey(scope, event_id),
          cause_id: id,
          occurred_at: final!.cutoff as JevLedgerCommand["occurred_at"],
          payload: {
            event_type: "funding",
            position_id: p.position_id,
            period_start: new Date(hour - 3600000).toISOString(),
            period_end: final!.cutoff,
            rate: result.rate!,
            delta: { unit: "USD", decimals: 6, raw: p.delta_usd_raw },
            origin: {
              schema_version: "trading.v1",
              instrument_id: scope.instrument_id,
              instrument_version: scope.instrument_version,
              source_id: FUNDING_SOURCE,
              source_event_id: `BTC:${final!.cutoff}`,
              kind: "funding",
              source_timestamp: final!.cutoff,
              received_at: request.observation!.received_at,
              parser_version: PAPER_FUNDING_MODEL,
              payload_hash: jevHash(request.observation!.row),
              quality: "fresh",
            },
          },
        } as JevLedgerCommand;
      });
      await appendJevLedgerTx(tx, l.identity, l.events, {
        transaction_id: `jev-funding:${jevHash([scope.account_id, request.period_hour])}`,
        events: commands,
      });
    }
    await tx.query(
      "INSERT INTO jev_funding_receipts(account_id,operation_id,sequence,period_hour,receipt,evidence_id,recorded_at) SELECT $1,$2,COALESCE(MAX(sequence),0)+1,$3,$4::jsonb,$5,$6 FROM jev_funding_receipts WHERE account_id=$1",
      [
        scope.account_id,
        request.operation_id,
        request.period_hour,
        JSON.stringify(result),
        id,
        now,
      ],
    );
    const current = await loadJevAccountTx(
        tx,
        scope.owner_id,
        scope.account_id,
      ),
      coverage = fundingCoverage(fills(current.events), [...old, result], now);
    if (coverage.usable_for_risk)
      await reconcileJevRisk(
        { transaction: (run) => run(tx) },
        scope.owner_id,
        scope.account_id,
        {
          operation_id: `funding-ready:${jevHash(id)}`,
          ledger_sequence: current.projection.last_sequence,
          observed_at: now,
          funding_through_at: new Date(
            Math.floor(Date.parse(now) / 3600000) * 3600000,
          ).toISOString(),
          evidence: { receipt: id, coverage, version: JEV_FUNDING_VERSION },
        },
      );
    if (result.status === "pending" || result.status === "conflict")
      await tx.query(
        "UPDATE jev_worker_controls SET entries_paused=true WHERE account_id=$1 AND NOT entries_paused",
        [scope.account_id],
      );
    await observeJevRiskTx(tx, scope.owner_id, scope.account_id);
    return result;
  });
}
/** One free public request per >=30s worker cycle, outside every SQL fence.
 * Round-robin selection prevents a historical gap in one account from starving
 * another. Accounts with the same due hour share only the original observation. */
export function createJevFundingLane(
  pool: Pool,
  accounts: () => Promise<{ scope: JevScope }[]>,
  fetchFunding = fetchFinalBtcFunding,
) {
  let cursor = 0;
  const metrics = { requests: 0, account_results: 0, failures: 0, last_ms: 0 };
  return {
    metrics,
    async tick(signal?: AbortSignal) {
      const began = performance.now();
      try {
        const activeAccounts = await accounts();
        const candidates = await pool.readOnly(1500, async (tx) => {
          const rows = [] as { scope: JevScope; hour: string }[];
          for (const a of activeAccounts) {
            const r = (
              await tx.query<{ hour: Date }>(
                `SELECT h AS hour FROM generate_series((SELECT date_trunc('hour',MIN((event->>'occurred_at')::timestamptz)) FROM jev_ledger_events WHERE account_id=$1 AND event->'payload'->>'event_type'='fill'),date_trunc('hour',clock_timestamp()),interval '1 hour') h WHERE NOT EXISTS(SELECT 1 FROM jev_funding_receipts WHERE account_id=$1 AND period_hour=h AND receipt->>'status' IN ('settled','conflict')) ORDER BY h LIMIT 1`,
                [a.scope.account_id],
              )
            ).rows[0];
            if (r) rows.push({ scope: a.scope, hour: r.hour.toISOString() });
          }
          return rows;
        });
        if (!candidates.length) return;
        const hour = candidates[cursor++ % candidates.length]!.hour;
        metrics.requests++;
        const response = await fetchFunding(hour, signal);
        requireJev(response.rows.length <= 1, "FUNDING_AMBIGUOUS");
        const row = response.rows[0] ?? null;
        const outcomes = await Promise.allSettled(
          candidates
            .filter((c) => c.hour === hour)
            .map(async (c) => {
              const oracle = row
                ? await pool.readOnly(
                    1500,
                    async (tx) =>
                      (
                        await paperFundingOracleTx(
                          tx,
                          { ...c.scope, mode: "paper" },
                          new Date(row.time).toISOString(),
                        )
                      )?.object_id ?? null,
                  )
                : null;
              await reconcileJevFunding(pool, c.scope, {
                operation_id: `funding:${jevHash([JEV_FUNDING_VERSION, hour, row, oracle])}`,
                model_version: PAPER_FUNDING_MODEL,
                period_hour: hour,
                oracle_object_id: oracle,
                observation: row
                  ? {
                      source: FUNDING_SOURCE,
                      received_at: response.received_at,
                      row,
                    }
                  : null,
              });
              metrics.account_results++;
            }),
        );
        const failure = outcomes.find((o) => o.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      } catch (e) {
        metrics.failures++;
        throw e;
      } finally {
        metrics.last_ms = performance.now() - began;
      }
    },
  };
}
